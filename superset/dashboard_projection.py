"""Pure eligibility checks for cached dashboard projections."""

import re


def simple_projection(body, datasource):
    """Allow cached projections without ad-hoc SQL; access is rechecked separately."""
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
