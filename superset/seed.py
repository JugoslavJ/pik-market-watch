"""Provision repeatable Superset datasets, charts, filters, and dashboards."""

import json
import os
import sys
import time
import urllib.error
import urllib.parse
from pathlib import Path

from client import SupersetAPI
from parity import install as install_dashboard_sources, push_cross_filters
from provisioning import (
    ensure_dataset, install_dashboard, metric_count, raw_table, summary_chart,
    map_chart, query_context, select_filter, select_filter_targets,
    range_filter, range_filter_targets, stable_uuid, verify_chart,
)


DATABASE_NAME = "OLX market reporting"
DATASET_NAME = "active_listings"
DASHBOARD_TITLE = "Market explorer"
DATASETS = [
    ("active_listings", "../active-listings.sql", 600),
    ("active_listing_categories", "active-listing-categories.sql", 600),
    ("best_value_sales", "best-value-sales.sql", 600),
    ("price_history", "price-history.sql", 600),
    ("price_drops", "price-drops.sql", 600),
    ("daily_market_summary", "daily-market-summary.sql", 600),
    ("home_summary", "home-summary.sql", 600),
    ("daily_inventory_flow", "daily-inventory-flow.sql", 600),
    ("lifecycle_events", "lifecycle-events.sql", 600),
    ("recent_exit_points", "recent-exit-points.sql", 600),
    ("recent_exits_30d", "recent-exits-30d.sql", 600),
    ("recent_exits_90d", "recent-exits-90d.sql", 600),
    ("saved_searches", "saved-searches.sql", -1),
    ("scrape_runs", "scrape-runs.sql", -1),
    ("scrape_run_summary", "scrape-run-summary.sql", -1),
    ("scrape_pages", "scrape-pages.sql", -1),
    ("listing_quality", "listing-quality.sql", -1),
    ("listing_quality_summary", "listing-quality-summary.sql", -1),
    ("alert_status", "alert-status.sql", -1),
]


def charts(dataset_id):
    source = f"{dataset_id}__table"
    common = {"datasource": source, "time_range": "No filter", "row_limit": 100}
    return [
        (
            "Listings by property type",
            "pie",
            {**common, "viz_type": "pie", "groupby": ["property_type"],
             "metric": metric_count(), "show_legend": True, "show_labels": True},
        ),
        (
            "Sale or rent",
            "pie",
            {**common, "viz_type": "pie", "groupby": ["deal"],
             "metric": metric_count(), "show_legend": True, "show_labels": True},
        ),
        (
            "Listings by neighborhood",
            "table",
            {**common, "viz_type": "table", "query_mode": "aggregate",
             "groupby": ["neighborhood"], "metrics": [metric_count()],
             "row_limit": 50, "order_desc": True},
        ),
        (
            "Active listing count",
            "big_number_total",
            {**common, "viz_type": "big_number_total", "metric": metric_count(),
             "y_axis_format": ",d"},
        ),
        (
            "Matching listings",
            "table",
            {**common, "viz_type": "table", "query_mode": "raw",
             "all_columns": ["title", "deal", "property_type", "neighborhood",
                             "rooms", "sqm", "price_bam", "ppm2_bam", "ad_link"],
             "row_limit": 100, "allow_render_html": True},
        ),
    ]


def main():
    api = SupersetAPI()
    api.authenticate()

    user = urllib.parse.quote(os.environ["POSTGRES_REPORTING_USER"], safe="")
    password = urllib.parse.quote(os.environ["POSTGRES_REPORTING_PASSWORD"], safe="")
    database = urllib.parse.quote(os.environ["POSTGRES_DB"], safe="")
    uri = f"postgresql+psycopg2://{user}:{password}@db:5432/{database}"
    database_payload = {
        "database_name": DATABASE_NAME, "sqlalchemy_uri": uri,
        "allow_dml": False, "allow_ctas": False, "allow_cvas": False,
        "allow_file_upload": False, "expose_in_sqllab": False,
        "uuid": stable_uuid("database", DATABASE_NAME),
    }
    db = api.ensure("database", "database_name", DATABASE_NAME, database_payload)
    database_id = db["id"]

    install_dashboard_sources(api, database_id)
    if "--parity-only" in sys.argv:
        return

    dataset_ids = {}
    for table_name, sql_file, cache_timeout in DATASETS:
        dataset = ensure_dataset(api, database_id, table_name,
                                 push_cross_filters(Path(f"/app/datasets/{sql_file}").read_text(encoding="utf-8-sig"),
                                                    unknown_label="Unknown"),
                                 cache_timeout)
        dataset_ids[table_name] = dataset["id"]
    dataset_id = dataset_ids[DATASET_NAME]
    specs = [(name, kind, form, dataset_id) for name, kind, form in charts(dataset_id)]
    dashboard, created_charts = install_dashboard(
        api, DASHBOARD_TITLE, "market-explorer", specs, [
            select_filter(dataset_id, "Deal", "deal"),
            select_filter(dataset_id, "Neighborhood", "neighborhood"),
            select_filter(dataset_id, "Property type", "property_type"),
            select_filter(dataset_id, "Rooms", "rooms"),
            select_filter(dataset_id, "Seller type", "seller_type"),
            range_filter(dataset_id, "Asking price (BAM)", "price_bam"),
            range_filter(dataset_id, "Area (m²)", "sqm"),
        ], verify=False,
    )
    dashboard_id = dashboard["id"]

    install_dashboard(
        api, "Home", "home", [
            raw_table("Home market indicators", dataset_ids["home_summary"],
                      ["active", "median_sale_ppm2", "median_monthly_rent_bam",
                       "gross_yield_pct", "observed_exit_ratio_pct",
                       "new_sale_ppm2_change_pct"], cache_timeout=600),
            raw_table("Home scraper freshness and 24-hour activity",
                      dataset_ids["scrape_run_summary"],
                      ["minutes_since_last_complete_success", "failed_24h", "cards_24h",
                       "success_rate_pct"], cache_timeout=-1),
            ("Home active listings", "big_number_total",
             {"datasource": f"{dataset_id}__table", "time_range": "No filter",
              "viz_type": "big_number_total", "metric": metric_count(),
              "cache_timeout": 600}, dataset_id),
            raw_table("Home recent listings", dataset_id,
                      ["title", "deal", "property_type", "neighborhood", "price_bam", "ad_link"],
                      cache_timeout=600, render_html=True),
            raw_table("Home inventory flow — last 90 days", dataset_ids["daily_inventory_flow"],
                      ["day", "new_n", "closed_n", "estimated_active_n",
                       "closed_per_active_pct"], cache_timeout=600),
            raw_table("Home inventory movements — last 90 days", dataset_ids["daily_inventory_flow"],
                      ["day", "new_n", "closed_n"], cache_timeout=600),
        ], [select_filter(dataset_id, "Home deal", "deal"),
            select_filter(dataset_id, "Home neighborhood", "neighborhood"),
            select_filter(dataset_id, "Home property type", "property_type")],
    )

    price_dataset = dataset_ids["price_history"]
    drops_dataset = dataset_ids["price_drops"]
    daily_dataset = dataset_ids["daily_market_summary"]
    install_dashboard(
        api, "Price history", "price-history", [
            summary_chart("Price observations by date", price_dataset, "price_date"),
            raw_table("Sale market trend (BAM per m², 90 days)", daily_dataset,
                      ["day", "p25_bam_per_sqm", "median_bam_per_sqm",
                       "p75_bam_per_sqm", "observed_listings"], cache_timeout=600),
            raw_table("Recent asking price observations", price_dataset,
                      ["price_date", "article_id", "deal", "neighborhood", "price_bam",
                       "price_kind", "source", "title", "ad_link"],
                      cache_timeout=600, render_html=True),
            raw_table("Recent price drops", drops_dataset,
                      ["price_date", "article_id", "deal", "neighborhood",
                       "previous_price_bam", "price_bam", "reduction_bam",
                       "price_kind", "title", "ad_link"],
                      cache_timeout=600, render_html=True),
            summary_chart("Price reductions by neighborhood", drops_dataset, "neighborhood"),
        ], [select_filter_targets("History deal", [(price_dataset, "deal"),
                                                     (drops_dataset, "deal")]),
            select_filter_targets("History neighborhood", [(price_dataset, "neighborhood"),
                                                            (drops_dataset, "neighborhood")])],
    )

    # A focused companion to Market explorer for the inventory breakdowns and
    # rankings that otherwise make that landing page too dense.
    segments_specs = [
            summary_chart("Active listings by rooms", dataset_id, "rooms"),
            summary_chart("Active listings by floor", dataset_id, "floor_num"),
            summary_chart("Active listings by seller type", dataset_id, "seller_type"),
            summary_chart("Active listings by neighborhood", dataset_id, "neighborhood"),
            raw_table("Lowest BAM sale price per m²", dataset_ids["best_value_sales"],
                      ["title", "property_type", "neighborhood", "rooms", "sqm",
                       "price_bam", "ppm2_bam", "seller_type", "ad_link"],
                      cache_timeout=600, render_html=True,
                      order_by_cols=[("ppm2_bam", False)]),
            raw_table("Most viewed active listings", dataset_id,
                      ["title", "deal", "property_type", "neighborhood", "views",
                       "price_bam", "ad_link"], cache_timeout=600, render_html=True,
                      order_by_cols=[("views", True)]),
            raw_table("Active listings with map coordinates", dataset_id,
                      ["title", "deal", "property_type", "neighborhood", "rooms",
                       "latitude", "longitude", "price_bam", "sqm", "ad_link"],
                      cache_timeout=600, render_html=True),
        ]
    segments_specs.append(map_chart(
        "Active listing map", dataset_id,
        ["article_id", "latitude", "longitude", "title", "deal",
         "property_type", "neighborhood", "rooms", "sqm", "price_bam", "ppm2_bam"],
    ))
    category_dataset = dataset_ids["active_listing_categories"]
    best_value_dataset = dataset_ids["best_value_sales"]
    segments_specs.extend([
        summary_chart("Listings by saved-search category", category_dataset, "category"),
        raw_table("Listing to saved-search category membership", category_dataset,
                  ["category", "article_id", "title", "deal", "property_type",
                   "neighborhood", "rooms", "seller_type", "sqm", "price_bam",
                   "ppm2_bam", "ad_link"],
                  cache_timeout=600, render_html=True),
    ])
    install_dashboard(
        api, "Segments & rankings", "segments-rankings", segments_specs,
        [select_filter_targets("Segment deal", [(dataset_id, "deal"),
                                                  (category_dataset, "deal")]),
            select_filter_targets("Segment neighborhood", [(dataset_id, "neighborhood"),
                                                            (best_value_dataset, "neighborhood"),
                                                            (category_dataset, "neighborhood")]),
            select_filter_targets("Segment property type", [(dataset_id, "property_type"),
                                                             (best_value_dataset, "property_type"),
                                                             (category_dataset, "property_type")]),
            select_filter_targets("Segment rooms", [(dataset_id, "rooms"),
                                                     (best_value_dataset, "rooms"),
                                                     (category_dataset, "rooms")]),
            select_filter_targets("Segment seller type", [(dataset_id, "seller_type"),
                                                           (best_value_dataset, "seller_type"),
                                                           (category_dataset, "seller_type")]),
            select_filter(
                category_dataset, "Saved-search category", "category",
                scope_to_chart_names={"Listings by saved-search category",
                                      "Listing to saved-search category membership"},
            ),
            range_filter_targets("Segment price (BAM)", [(dataset_id, "price_bam"),
                                                          (best_value_dataset, "price_bam"),
                                                          (category_dataset, "price_bam")]),
            range_filter_targets("Segment area (m²)", [(dataset_id, "sqm"),
                                                        (best_value_dataset, "sqm"),
                                                        (category_dataset, "sqm")])],
    )

    exit_points_dataset = dataset_ids["recent_exit_points"]
    exit_30d_dataset = dataset_ids["recent_exits_30d"]
    exit_90d_dataset = dataset_ids["recent_exits_90d"]
    exit_specs = [
            summary_chart("Observed exits by deal (30 days)", exit_30d_dataset, "deal"),
            summary_chart("Observed exits by neighborhood (30 days)", exit_30d_dataset, "neighborhood"),
            summary_chart("Observed exits by rooms (30 days)", exit_30d_dataset, "rooms"),
            raw_table("Exit duration and price facts (30 days)", exit_30d_dataset,
                      ["exit_date", "deal", "property_type", "neighborhood", "rooms",
                       "sqm", "days_listed", "last_asking_price_bam", "exit_ppm2_bam",
                       "price_kind", "title"], cache_timeout=600),
            raw_table("Recently closed details (90 days)", exit_90d_dataset,
                      ["exit_date", "deal", "property_type", "neighborhood",
                       "rooms", "sqm", "days_listed", "last_asking_price_bam", "exit_ppm2_bam", "price_kind",
                       "latitude", "longitude", "title", "ad_link"],
                      cache_timeout=600, render_html=True),
            raw_table("Observed exit pins and links", exit_points_dataset,
                      ["exit_date", "article_id", "deal", "neighborhood", "rooms",
                       "latitude", "longitude", "last_asking_price_bam", "days_listed",
                       "ad_link"], cache_timeout=600, render_html=True),
        ]
    exit_specs.append(map_chart(
        "Observed exit map", exit_points_dataset,
        ["event_id", "article_id", "latitude", "longitude", "title", "deal",
         "property_type", "neighborhood", "rooms", "sqm",
         "last_asking_price_bam", "days_listed"],
    ))
    install_dashboard(
        api, "Observed exits", "observed-exits", exit_specs,
        [select_filter_targets("Exit deal", [(exit_30d_dataset, "deal"),
                                              (exit_90d_dataset, "deal"),
                                              (exit_points_dataset, "deal")]),
            select_filter_targets("Exit neighborhood", [(exit_30d_dataset, "neighborhood"),
                                                         (exit_90d_dataset, "neighborhood"),
                                                         (exit_points_dataset, "neighborhood")]),
            select_filter_targets("Exit property type", [(exit_30d_dataset, "property_type"),
                                                          (exit_90d_dataset, "property_type"),
                                                          (exit_points_dataset, "property_type")]),
            select_filter_targets("Exit rooms", [(exit_30d_dataset, "rooms"),
                                                  (exit_90d_dataset, "rooms"),
                                                  (exit_points_dataset, "rooms")]),
            range_filter_targets("Exit area (m²)", [(exit_30d_dataset, "sqm"),
                                                    (exit_90d_dataset, "sqm"),
                                                    (exit_points_dataset, "sqm")])],
    )
    run_dataset = dataset_ids["scrape_runs"]
    search_dataset = dataset_ids["saved_searches"]
    page_dataset = dataset_ids["scrape_pages"]
    quality_dataset = dataset_ids["listing_quality"]
    run_summary_dataset = dataset_ids["scrape_run_summary"]
    quality_summary_dataset = dataset_ids["listing_quality_summary"]
    alert_dataset = dataset_ids["alert_status"]
    install_dashboard(
        api, "Scraper health", "scraper-health", [
            raw_table("Current alert status", alert_dataset,
                      ["alert_name", "failing_now", "supporting_count", "supporting_measure"]),
            raw_table("Scraper run summary — last 24 hours", run_summary_dataset,
                      ["runs_24h", "successful_24h", "failed_24h", "incomplete_24h",
                       "success_rate_pct", "cards_24h", "minutes_since_last_complete_success"]),
            raw_table("Active listing quality summary", quality_summary_dataset,
                      ["active_listings", "geo_pins_pct", "details_fetched_pct",
                       "price_per_sqm_known_pct", "olx_status_known_pct",
                       "detail_backlog", "invalid_latest_price_30d"]),
            raw_table("Recent scrape runs", run_dataset,
                      ["started_at", "finished_at", "search_name", "category",
                       "status", "is_complete", "pages", "cards", "error"]),
            raw_table("Incomplete and failed runs", run_dataset,
                      ["started_at", "finished_at", "search_name", "category",
                       "status", "is_complete", "failure_reason", "truncation_reason",
                       "pages", "cards", "error"]),
            raw_table("Per-search freshness", search_dataset,
                      ["name", "category", "last_success_at", "hours_since_success",
                       "last_attempt_at", "last_attempt_status", "current_phase",
                       "last_attempt_error", "listing_count", "last_scraped_at"]),
            raw_table("Page errors and parse quality", page_dataset,
                      ["fetched_at", "search_name", "page_number", "response_state",
                       "raw_item_count", "parsed_item_count", "parse_rejection_count",
                       "error", "is_authoritative"]),
            raw_table("Listing coverage and detail backlog", quality_dataset,
                      ["article_id", "deal", "neighborhood", "last_seen",
                       "has_coordinates", "has_price_per_sqm", "has_api_status",
                       "details_fetched_at", "detail_backlog", "latest_price_state",
                       "url"]),
            raw_table("Current OLX status and closure state", quality_dataset,
                      ["article_id", "deal", "neighborhood", "api_status",
                       "marked_closed", "last_seen", "url"]),
        ], [select_filter(run_dataset, "Run status", "status"),
            select_filter(page_dataset, "Page response state", "response_state"),
            select_filter(search_dataset, "Search category", "category"),
            select_filter(quality_dataset, "Listing deal", "deal"),
            select_filter(quality_dataset, "Listing neighborhood", "neighborhood")],
    )
    for chart in created_charts:
        started = time.perf_counter()
        rows = verify_chart(api, chart)
        elapsed = time.perf_counter() - started
        print(f"Checked chart: {chart['slice_name']} ({rows} rows, {elapsed:.2f}s)")
        if chart["slice_name"] == "Active listing count":
            count_form = next(form for name, _, form in charts(dataset_id)
                              if name == chart["slice_name"])
            filtered_context = json.loads(query_context(
                dataset_id, chart["id"], count_form
            ))
            filtered_context["queries"][0]["filters"] = [
                {"col": "deal", "op": "==", "val": "sale"}
            ]
            filtered_started = time.perf_counter()
            filtered = api.call("POST", "/api/v1/chart/data", filtered_context)
            filtered_elapsed = time.perf_counter() - filtered_started
            filtered_results = filtered.get("result", [])
            if not filtered_results or any(result.get("error") for result in filtered_results):
                raise RuntimeError("filtered count query failed")
            print(f"Checked fresh filtered count ({filtered_elapsed:.2f}s, "
                  f"TTL {filtered_results[0].get('cache_timeout')}s)")
            repeat_started = time.perf_counter()
            repeated = api.call("POST", "/api/v1/chart/data", filtered_context)
            repeat_elapsed = time.perf_counter() - repeat_started
            repeat_results = repeated.get("result", [])
            if not repeat_results or not all(result.get("is_cached") for result in repeat_results):
                raise RuntimeError("chart query cache did not serve the repeated count")
            print(f"Checked repeat query cache ({repeat_elapsed:.2f}s)")
    print(f"Provisioned market dashboard: {os.environ.get('SUPERSET_ROOT_URL', 'http://127.0.0.1:8088/')}superset/dashboard/{dashboard_id}/?expand_filters=0")


if __name__ == "__main__":
    try:
        main()
    except (KeyError, RuntimeError, urllib.error.URLError) as error:
        print(f"Superset seed failed: {error}", file=sys.stderr)
        sys.exit(1)
