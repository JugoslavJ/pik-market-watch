"""Read dashboard definitions and push chart selections into their source scans."""

import re
from pathlib import Path

from listing_filters import EXPRESSIONS, EVENT_EXPRESSIONS


SOURCE_DIR = Path(__file__).resolve().parent / "dashboards"
FILTER_MACRO = re.compile(r"\$\{(\w+)\}")
TIME_FILTER_MACRO = re.compile(r"\$\{time_filter:([^}]+)\}")
TIME_MACROS = {"time_from", "time_to"}

# Chart selections and property filters apply to these source columns before aggregation.
LISTING_DIMENSIONS = {
    "rooms": "coalesce(cf.rooms::text, 'unknown')",
    "neighborhood": "coalesce(cf.neighborhood::text, 'unknown')",
    "deal": "cf.deal::text", "property_type": "cf.property_type::text",
    "segment": "cf.property_type::text",
    "article_id": "cf.article_id", "title": "cf.title", "url": "cf.url",
    "sqm": "cf.sqm",
}
TABLE_DIMENSIONS = {
    "listings": {**LISTING_DIMENSIONS,
                 "seller_type": "coalesce(cf.seller_type::text, 'unknown')",
                 "floor": "coalesce(cf.floor_num::text, 'unknown')",
                 "floor_num": "cf.floor_num", **EXPRESSIONS},
    "listing_lifecycle_events": {**LISTING_DIMENSIONS, **EVENT_EXPRESSIONS},
    "scrape_runs": {"status": "cf.status::text", "search_key": "cf.search_key::text"},
    "saved_searches": {"search_key": "cf.search_key::text"},
}
# A scan marked `/* unfiltered */` (e.g. the price-check subject lookup) keeps
# every row: chart selections and property filters never reach it.
TABLE_SCAN = re.compile(
    r"\b(FROM|JOIN)\s+lean\.(listings|listing_lifecycle_events|scrape_runs|saved_searches)"
    r"(?!\s*/\*\s*unfiltered\s*\*/)"
    r"(?:\s+(?:AS\s+)?(?!(?:WHERE|JOIN|LEFT|RIGHT|INNER|FULL|CROSS|GROUP|ORDER|LIMIT|"
    r"UNION|ON|USING|HAVING|OFFSET|WINDOW)\b)([A-Za-z_]\w*))?", re.I)


def cross_filter_columns(sql):
    tables = {match[2].lower() for match in TABLE_SCAN.finditer(sql)}
    # Do not apply a floor filter only to the active denominator of an exit ratio.
    facts = tables & {"listings", "listing_lifecycle_events"}
    if facts:
        return set.intersection(*(set(TABLE_DIMENSIONS[t]) for t in facts))
    return set().union(*(set(TABLE_DIMENSIONS[t]) for t in tables))


def push_cross_filters(sql, columns=None):
    allowed = cross_filter_columns(sql)

    def replace_scan(match):
        table = match[2].lower()
        clauses = []
        for column, expression in TABLE_DIMENSIONS[table].items():
            if columns is not None and column not in columns:
                continue
            if table in {"listings", "listing_lifecycle_events"} and column not in allowed:
                continue
            # Each incoming IN clause stays separate (AND); string conversion
            # handles numeric chart labels, and where_in quotes hostile values.
            clauses.append("{% for f in get_filters('" + column + "', remove_filter=True) %}"
                           "{% if f.op == 'IN' and f.val %} AND (FALSE"
                           "{% if f.val | reject('none') | list %} OR " + expression +
                           " IN {{ f.val | reject('none') | map('string') | list | where_in }}{% endif %}"
                           "{% if none in f.val %} OR " + expression + " IS NULL{% endif %})"
                           "{% elif f.op == 'NOT IN' and f.val %} AND " + expression
                           + " NOT IN {{ f.val | map('string') | list | where_in }}"
                           "{% elif f.op in ['=', '==', '!=', '<>', '>', '>=', '<', '<='] and f.val is not none %} AND "
                           + expression + " {{ '=' if f.op == '==' else f.op }} "
                           "{{ [f.val | string] | where_in }}"
                           "{% elif f.op == 'IS NULL' %} AND " + expression + " IS NULL"
                           "{% elif f.op == 'IS NOT NULL' %} AND " + expression + " IS NOT NULL"
                           "{% endif %}{% endfor %}")
        if not clauses:
            return match[0]
        return (match[1] + " (SELECT cf.* FROM lean." + table + " cf WHERE 1=1 "
                + " ".join(clauses) + ") " + (match[3] or table))

    return TABLE_SCAN.sub(replace_scan, sql)


def panels(dashboard):
    return dashboard["panels"]


def filters(dashboard):
    return dashboard.get("filters", [])


def expand_time(sql, start, end, predicate="({column} BETWEEN {start} AND {end})"):
    sql = TIME_FILTER_MACRO.sub(lambda m: predicate.format(column=m[1], start=start, end=end), sql)
    return sql.replace("${time_from}", start).replace("${time_to}", end)


def expand_filters(sql, replacement):
    return FILTER_MACRO.sub(lambda m: m[0] if m[1] in TIME_MACROS else replacement(m[1]), sql)


def source_sql(dashboard, panel):
    if "sql" in panel:
        return panel["sql"]
    source = next(p for p in panels(dashboard) if p["id"] == panel["source_panel"])
    return source_sql(dashboard, source)


def dataset_name(dashboard, panel):
    # Big numbers that reuse a panel share its summary query and result rows.
    source_id = panel.get("source_panel", panel["id"])
    if dashboard["uid"] == "olx-exits" and panel["id"] in (1, 2, 3, 4):
        source_id = 1
    return f"source_{dashboard['uid'].replace('-', '_')}_{source_id}"


def shared_source_sql(dashboard, panel):
    """Fold the four exit cards into one aggregate over their identical base."""
    source_id = panel.get("source_panel", panel["id"])
    if dashboard["uid"] == "olx-home" and source_id == 9:
        # The newest complete run via its index, not an aggregate over every run.
        return """SELECT round(EXTRACT(EPOCH FROM (now() - max(finished_at))) / 60)::int
          AS minutes_since_success FROM (
          SELECT finished_at FROM lean.scrape_runs
          WHERE status = 'ok' AND is_complete AND finished_at IS NOT NULL
          ORDER BY finished_at DESC LIMIT 1) last_success"""
    if dashboard["uid"] == "olx-health" and source_id == 2:
        summary = """WITH recent AS (
          SELECT count(*) FILTER (WHERE status = 'error') AS failed_24h,
            count(*) FILTER (WHERE status = 'ok') AS ok_24h,
            count(*) FILTER (WHERE status IN ('ok', 'error')) AS finished_24h,
            coalesce(sum(cards) FILTER (WHERE status = 'ok'), 0) AS cards_24h,
            count(*) FILTER (WHERE NOT is_complete AND status IN ('ok', 'error')
              AND finished_at IS NOT NULL) AS incomplete
          FROM lean.scrape_runs WHERE started_at > now() - INTERVAL '24 hours'
        ), last_success AS (
          SELECT finished_at FROM lean.scrape_runs
          WHERE status = 'ok' AND is_complete AND finished_at IS NOT NULL
          ORDER BY finished_at DESC LIMIT 1
        ) SELECT failed_24h, round(100.0 * ok_24h / NULLIF(finished_24h, 0), 0)
              AS success_rate, round(EXTRACT(EPOCH FROM (now() - finished_at)))::bigint
              AS seconds_since_success, cards_24h, incomplete"""
        return summary + " FROM recent LEFT JOIN last_success ON true"
    if dashboard["uid"] != "olx-exits" or panel["id"] not in (1, 2, 3, 4):
        return source_sql(dashboard, panel)
    source = next(p for p in panels(dashboard) if p["id"] == 1)
    marker = " SELECT count(*) AS closed_30d FROM base WHERE "
    prefix, separator, predicate = source_sql(dashboard, source).partition(marker)
    if not separator:
        raise ValueError("Exit summary source changed; review the shared aggregation")
    return prefix + """, summary AS (
      SELECT count(*) AS closed_30d,
        round(percentile_cont(0.5) WITHIN GROUP (ORDER BY closing_ppm2)
          FILTER (WHERE closing_ppm2 > 0)::numeric, 0) AS median_exit_ppm2,
        round(percentile_cont(0.5) WITHIN GROUP (ORDER BY days_listed)::numeric, 1)
          AS median_days_on_market
      FROM base WHERE """ + predicate + """
    ) SELECT summary.*,
      round(100.0 * closed_30d /
        NULLIF(closed_30d + (SELECT count(*) FROM active), 0), 1) AS exit_ratio
    FROM summary"""


def default_days(dashboard):
    amount, unit = re.fullmatch(r"(\d+)([dhm])", dashboard.get("time_range", "90d")).groups()
    return int(amount) * {"d": 1, "h": 1 / 24, "m": 1 / 1440}[unit]
