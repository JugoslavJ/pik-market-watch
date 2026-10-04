"""Batch native chart queries and cache their serialized, authorized responses.

Superset's dataframe cache still renders/parses the virtual SQL on a cache hit.
This cache sits after the same schema, query, datasource, dashboard and RLS
checks as the standard chart endpoint. It never caches operational datasets.
"""

import hashlib
import logging
import re
from time import perf_counter

from cachelib import SimpleCache
from flask import g, make_response, request, Response, stream_with_context
from flask_appbuilder.api import expose, protect
from marshmallow import ValidationError
from sqlalchemy.orm import joinedload, selectinload

from superset import security_manager
from superset.charts.data.api import ChartDataRestApi
from superset.charts.schemas import ChartDataQueryContextSchema
from superset.common.query_context_factory import QueryContextFactory
from superset.common.query_context import QueryContext
from superset.commands.chart.data.get_data_command import ChartDataCommand
from superset.commands.chart.exceptions import ChartDataQueryFailedError
from superset.common.chart_data import ChartDataResultFormat, ChartDataResultType
from superset.daos.exceptions import DatasourceNotFound
from superset.exceptions import QueryObjectValidationError, SupersetSecurityException
from superset.utils import json
from superset.extensions import event_logger

logger = logging.getLogger(__name__)
response_cache = SimpleCache(threshold=500, default_timeout=600)


def simple_projection(body, datasource):
    """Only allow cached projections that cannot embed another SQL query.

    An identical previously validated request can skip rebuilding its date and
    post-processing objects. Datasource/dashboard access is checked again.
    Ad-hoc SQL expressions and guest requests keep the full validation path.
    """
    if body.get("result_format") != "json" or body.get("result_type") != "full":
        return False
    names = {column.column_name for column in datasource.columns}

    def column_valid(column):
        if isinstance(column, str):
            return column in names
        return isinstance(column, dict) and column.get("sqlExpression") in names

    def metric_valid(metric):
        if not isinstance(metric, dict):
            return False
        if metric.get("expressionType") == "SIMPLE":
            return (metric.get("column") or {}).get("column_name") in names
        expression = metric.get("sqlExpression") or ""
        if not isinstance(expression, str):
            return False
        if expression in ("COUNT(*)", "1"):
            return True
        match = re.fullmatch(r'(?:MAX|MIN|SUM|AVG|COUNT)\("((?:[^"]|"")+)"\)', expression)
        return bool(match and match[1].replace('""', '"') in names)

    queries = body.get("queries")
    return isinstance(queries, list) and bool(queries) and all(
        isinstance(query, dict)
        and not any((query.get("extras") or {}).get(key) for key in ("where", "having"))
        and all(column_valid(column) for column in query.get("columns") or [])
        and all(metric_valid(metric) for metric in query.get("metrics") or [])
        for query in queries
    )


class BatchQueryContextFactory(QueryContextFactory):
    """Resolve each source/chart once, retaining the normal QueryContext logic."""
    def __init__(self, bodies):
        super().__init__()
        from superset import db
        from superset.connectors.sqla.models import SqlaTable
        from superset.models.slice import Slice
        source_ids, chart_ids = set(), set()
        for body in bodies:
            if not isinstance(body, dict):
                continue
            source = body.get("datasource") or {}
            if isinstance(source, dict) and source.get("type") == "table":
                try:
                    source_ids.add(int(source.get("id")))
                except (TypeError, ValueError):
                    pass
            form = body.get("form_data") or {}
            if isinstance(form, dict):
                try:
                    chart_ids.add(int(form.get("slice_id")))
                except (TypeError, ValueError):
                    pass
        self.sources = {source.id: source for source in db.session.query(SqlaTable).filter(
            SqlaTable.id.in_(source_ids)).options(
                selectinload(SqlaTable.columns), selectinload(SqlaTable.metrics),
                selectinload(SqlaTable.owners), joinedload(SqlaTable.database)).all()}
        self.charts = {chart.id: chart for chart in db.session.query(Slice).filter(
            Slice.id.in_(chart_ids)).all()}

    def _convert_to_model(self, datasource):
        if datasource["type"] == "table":
            source = self.sources.get(int(datasource["id"]))
            if source is None:
                raise DatasourceNotFound()
            return source
        return super()._convert_to_model(datasource)

    def _get_slice(self, slice_id):
        return self.charts.get(int(slice_id))


def cache_key(body, context, rls):
    """Include SQL revision, principal and row rules; access is checked first."""
    datasource = context.datasource
    form = {key: value for key, value in (body.get("form_data") or {}).items() if key != "force"}
    return hashlib.sha256(json.dumps({
        "body": {**body, "force": False, "form_data": form},
        "user": g.user.get_id(), "roles": sorted(role.id for role in security_manager.get_user_roles()),
        "rls": rls,
        "dataset_changed": datasource.changed_on,
        "dataset_sql": datasource.sql,
        "columns": sorted((column.column_name, column.expression, column.type)
                          for column in datasource.columns),
        "chart_changed": context.slice_.changed_on if context.slice_ else None,
    }, sort_keys=True, default=json.json_int_dttm_ser).encode()).hexdigest()


class DashboardDataRestApi(ChartDataRestApi):
    resource_name = "dashboard_data"
    include_route_methods = {"data"}

    @expose("/data", methods=("POST",))
    @protect()
    @event_logger.log_this_with_context(action="DashboardDataRestApi.data", log_to_statsd=False)
    def data(self):
        started = perf_counter()
        bodies = request.json.get("contexts") if request.is_json and isinstance(request.json, dict) else None
        if not isinstance(bodies, list) or not 1 <= len(bodies) <= 100:
            return self.response_400(message="Expected 1..100 chart query contexts")
        schema = ChartDataQueryContextSchema()
        schema.query_context_factory = BatchQueryContextFactory(bodies)
        # Virtual datasets inherit rules from their underlying physical tables.
        # Include every rule and its associations so editing/deleting a rule or
        # changing a role/table assignment invalidates serialized responses too.
        from superset import db
        from superset.connectors.sqla.models import RowLevelSecurityFilter
        rules = db.session.query(RowLevelSecurityFilter).options(
            joinedload(RowLevelSecurityFilter.roles), joinedload(RowLevelSecurityFilter.tables)
        ).all()
        rls_revision = sorted((rule.id, rule.clause, str(rule.filter_type), rule.group_key,
                               sorted(role.id for role in rule.roles),
                               sorted(table.id for table in rule.tables)) for rule in rules)
        contexts = []

        def execute():
            for body in bodies:
                try:
                    if not isinstance(body, dict):
                        raise ValidationError("Expected a query context object")
                    g.form_data = body.get("form_data") or {}
                    source_info = body.get("datasource") or {}
                    if not isinstance(source_info, dict) or not isinstance(g.form_data, dict):
                        raise ValidationError("Expected datasource and form_data objects")
                    source = schema.query_context_factory.sources.get(source_info.get("id"))
                    if (source and not body.get("force") and not security_manager.is_guest_user()
                            and source_info.get("type") == "table" and simple_projection(body, source)):
                        lightweight = QueryContext(
                            datasource=source, queries=[],
                            slice_=schema.query_context_factory.charts.get(g.form_data.get("slice_id")),
                            form_data=g.form_data, result_type=ChartDataResultType.FULL,
                            result_format=ChartDataResultFormat.JSON, cache_values={})
                        key = cache_key(body, lightweight, rls_revision)
                        cached = response_cache.get(key)
                        if cached is not None:
                            lightweight.raise_for_access()
                            yield ({"status": 200, "body": cached, "cached": True})
                            continue
                    context = schema.load(body)
                    if (context.result_format != ChartDataResultFormat.JSON
                            or context.result_type != ChartDataResultType.FULL):
                        raise ValidationError("Only full JSON chart results can be batched")
                    command = ChartDataCommand(context)
                    command.validate()
                    # Retain ORM references through the batch so repeated sources use
                    # SQLAlchemy's identity map rather than being loaded again.
                    contexts.append(context)
                    timeout = context.get_cache_timeout()
                    timeout = 600 if timeout is None else timeout
                    key = None
                    # Guest row predicates come from the embedding token and
                    # can differ between otherwise identical guest principals.
                    if timeout > 0 and not security_manager.is_guest_user():
                        key = cache_key(body, context, rls_revision)
                    cached = response_cache.get(key) if key and not context.force else None
                    if cached is not None:
                        yield ({"status": 200, "body": cached, "cached": True})
                        continue
                    response = self._send_chart_response(command.run(), form_data=context.form_data,
                                                        datasource=context.datasource)
                    content = response.get_data(as_text=True)
                    if key and response.status_code == 200:
                        cached_payload = json.loads(content)
                        for result in cached_payload["result"]:
                            result["is_cached"] = True
                        response_cache.set(key, json.dumps(cached_payload), timeout=timeout)
                    yield ({"status": response.status_code, "body": content, "cached": False})
                except DatasourceNotFound:
                    yield ({"status": 404, "body": '{"message":"Datasource not found"}'})
                except SupersetSecurityException:
                    yield ({"status": 403, "body": '{"message":"Access denied"}'})
                except (ValidationError, QueryObjectValidationError, ChartDataQueryFailedError) as error:
                    yield ({"status": 400, "body": json.dumps({"message": str(error)})})
                except Exception:
                    logger.exception("Dashboard chart request failed")
                    yield ({"status": 500, "body": '{"message":"Chart query failed"}'})

        if request.headers.get("X-Dashboard-Stream") == "1":
            def stream():
                for index, result in enumerate(execute()):
                    yield json.dumps({"index": index, "result": result}) + "\n"
            response = Response(stream_with_context(stream()), mimetype="application/x-ndjson")
            response.headers["Cache-Control"] = "no-store"
            response.headers["X-Accel-Buffering"] = "no"
            return response
        results = list(execute())
        response = make_response(json.dumps({"result": results}), 200)
        response.headers["Content-Type"] = "application/json; charset=utf-8"
        response.headers["Cache-Control"] = "no-store"
        response.headers["Server-Timing"] = f"dashboard;dur={(perf_counter() - started) * 1000:.1f}"
        return response


def init_dashboard_data(app):
    app.appbuilder.add_api(DashboardDataRestApi)
