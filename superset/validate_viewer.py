"""Compare every lightweight chart with its original Grafana SQL."""
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
from parity import panels, push_cross_filters, dataset_name
from validate_parity import reference_sql, quote
from viewer_queries import BOARDS
from viewer_queries import compile_dashboard
from sqlalchemy import text
from sqlalchemy.dialects import postgresql


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
            if uid in ('olx-overview', 'olx-exits'):
                states += [({'deal':['sell']}, {}), ({'deal':['rent']}, {}),
                           ({'deal':['sell'], 'min_sqm':['40'], 'max_sqm':['100']}, {}),
                           ({}, {'rooms':['2']}), ({'deal':['sell']}, {'rooms':['2']})]
            for selected, cross in states:
                started = time.monotonic()
                params = urllib.parse.urlencode({'s':json.dumps(selected), 'c':json.dumps(cross), 'force':'true'})
                packet = api.call('GET', f'/olx/api/dashboard/{uid}?{params}')
                # Compare both SQL paths inside one read-only snapshot. Scrape
                # jobs can otherwise finish between the HTTP and reference
                # requests, changing status and completion timestamps.
                until = as_of
                sql, bindings, _ = compile_dashboard(board, selected, cross, packet['days'], until)
                query = text(sql)
                statement = query.bindparams(**{k:v for k,v in bindings.items() if k in query._bindparams}).compile(dialect=postgresql.dialect())
                cursor.execute(str(statement), statement.params)
                packet['rows'] = cursor.fetchone()['jsonb_build_object']['rows']
                since = until - timedelta(days=packet['days'])
                for panel in panels(board):
                    sql = reference_sql(board, panel, selected, since, until)
                    if cross:
                        sql = env.from_string(push_cross_filters(sql)).render(
                            get_filters=lambda name, **_: [{'op':'IN', 'val':cross[name]}] if name in cross else [])
                    cursor.execute(sql)
                    expected = cursor.fetchall()
                    compare(expected, packet['rows'][dataset_name(board, panel)],
                            f'{uid}/{panel["id"]}', time.monotonic() - started)
                    checked += 1
                print(f'Compared {uid}: {len(list(panels(board)))} panels, selection={selected}, cross={cross}')
    connection.close()
    print(f'Passed {checked} viewer/source comparisons across 71 panels.')


if __name__ == '__main__':
    try:
        main()
    except (RuntimeError, KeyError) as error:
        print(f'Viewer comparison failed: {error}', file=sys.stderr)
        sys.exit(1)
