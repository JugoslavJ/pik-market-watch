"""Compare every lightweight chart with its original source dashboard SQL."""
import json
import math
import os
import re
import sys
import time
import urllib.parse
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal

import psycopg2
from psycopg2.extras import RealDictCursor
from jinja2 import Environment

from client import SupersetAPI
from definitions import dataset_name, expand_filters, expand_time, filters, panels, push_cross_filters, source_sql
from viewer_queries import BOARDS
from viewer_queries import compile_dashboard
from listing_filters import PREFIX, viewer_variables
from sqlalchemy import text
from sqlalchemy.dialects import postgresql


def quote(value):
    return "'" + str(value).replace("'", "''") + "'"


def reference_sql(board, panel, selection, since, until):
    """The panel's own definition SQL with literal values, independent of the batching compiler."""
    values = {variable["name"]: [variable.get("default", "All")] for variable in filters(board)}
    values.update(selection)
    sql = expand_filters(source_sql(board, panel), lambda name: ",".join(quote(v) for v in values[name]))
    start, end = quote(since.isoformat()) + "::timestamptz", quote(until.isoformat()) + "::timestamptz"
    return expand_time(sql, start, end).strip().rstrip(";")


def normalize(value):
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, datetime):
        return value.replace(tzinfo=value.tzinfo or timezone.utc).timestamp()
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, str) and len(value) > 10 and value[4:5] == '-' and value[10:11] in ('T', ' '):
        try:
            padded = re.sub(r'\.(\d{1,6})(?=[Z+-]|$)', lambda m: '.' + m[1].ljust(6, '0'), value)
            parsed = datetime.fromisoformat(padded.replace('Z', '+00:00'))
            return parsed.replace(tzinfo=parsed.tzinfo or timezone.utc).timestamp()
        except ValueError:
            pass
    return value


def compare(expected, actual, title, elapsed):
    if len(expected) != len(actual):
        raise RuntimeError(f'{title}: row count {len(expected)} != {len(actual)}')
    columns = list(expected[0]) if expected else []
    clean = lambda rows: [{key: normalize(row[key]) for key in columns} for row in rows]
    clocks = {'seconds_since_success': 1, 'age_min': 60, 'minutes_since_success': 60}
    sort_key = lambda row: json.dumps({k:v for k,v in row.items() if k not in clocks}, sort_keys=True, default=str)
    for left, right in zip(sorted(clean(expected), key=sort_key), sorted(clean(actual), key=sort_key)):
        for column in columns:
            a, b = left[column], right[column]
            if a == b:
                continue
            if isinstance(a, (int, float)) and isinstance(b, (int, float)):
                tolerance = math.ceil(elapsed / clocks[column]) + 1 if column in clocks else .01
                if math.isclose(a, b, rel_tol=0, abs_tol=tolerance):
                    continue
            raise RuntimeError(f'{title}: mismatched {column}: {a!r} != {b!r}')


def main():
    api = SupersetAPI(); api.authenticate(); api.authenticate_browser()
    connection = psycopg2.connect(host='db', dbname=os.environ['POSTGRES_DB'],
        user=os.environ['POSTGRES_REPORTING_USER'], password=os.environ['POSTGRES_REPORTING_PASSWORD'])
    connection.set_session(readonly=True, isolation_level='REPEATABLE READ')
    env = Environment()
    env.filters['where_in'] = lambda values: '(' + ','.join(quote(v) for v in values) + ')'
    checked = 0
    with connection.cursor(cursor_factory=RealDictCursor) as cursor:
        cursor.execute("SET statement_timeout='20s'")
        cursor.execute("SET LOCAL jit=off")
        cursor.execute('SELECT now() AS as_of')
        as_of = cursor.fetchone()['as_of']
        for uid, board in BOARDS.items():
            states = [({}, {})]
            states += [({PREFIX + 'elevator': ['Yes']}, {}),
                       ({PREFIX + 'heating': ['Unknown'], PREFIX + 'condition': ['Unknown']}, {}),
                       ({PREFIX + 'price_bam_min': ['100000'], PREFIX + 'price_bam_max': ['300000']}, {'rooms': ['2']})]
            if uid in ('olx-overview', 'olx-exits'):
                states += [({'deal':['sell']}, {}), ({'deal':['rent']}, {}),
                           ({'deal':['sell'], 'min_sqm':['40'], 'max_sqm':['100']}, {}),
                           ({}, {'rooms':['2']}), ({'deal':['sell']}, {'rooms':['2']})]
            for selected, cross in states:
                started = time.monotonic()
                params = urllib.parse.urlencode({'s':json.dumps(selected), 'c':json.dumps(cross), 'force':'true'})
                packet = api.call('GET', f'/olx/api/dashboard/{uid}?{params}')
                # Compare in one read-only snapshot so scraper updates cannot change the reference.
                until = as_of
                sql, bindings, _ = compile_dashboard(board, selected, cross, packet['days'], until)
                query = text(sql)
                statement = query.bindparams(**{k:v for k,v in bindings.items() if k in query._bindparams}).compile(dialect=postgresql.dialect())
                cursor.execute(str(statement), statement.params)
                packet['rows'] = cursor.fetchone()['jsonb_build_object']['rows']
                since = until - timedelta(days=packet['days'])
                for panel in panels(board):
                    sql = reference_sql(board, panel, selected, since, until)
                    predicates = {name: [{'op': 'IN', 'val': values}] for name, values in cross.items()}
                    for variable in viewer_variables(board):
                        if variable['name'] in selected:
                            value = selected[variable['name']]
                            predicates.setdefault(variable['column'], []).append({
                                'op': variable['op'], 'val': value if variable['op'] == 'IN' else float(value[0])})
                    if predicates:
                        sql = env.from_string(push_cross_filters(sql, columns=set(predicates))).render(
                            get_filters=lambda name, **_: predicates.get(name, []))
                    cursor.execute(sql)
                    expected = cursor.fetchall()
                    compare(expected, packet['rows'][dataset_name(board, panel)],
                            f'{uid}/{panel["id"]}', time.monotonic() - started)
                    checked += 1
                print(f'Compared {uid}: {len(list(panels(board)))} panels, selection={selected}, cross={cross}')
    connection.close()
    print(f'Passed {checked} viewer/source comparisons across 63 panels.')


if __name__ == '__main__':
    try:
        main()
    except (RuntimeError, KeyError) as error:
        print(f'Viewer comparison failed: {error}', file=sys.stderr)
        sys.exit(1)
