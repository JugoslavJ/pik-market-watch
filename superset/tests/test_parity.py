import json
import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

from jinja2.sandbox import SandboxedEnvironment
from sqlalchemy import literal
from sqlalchemy.dialects import postgresql

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import parity
from provisioning import cross_filter_metadata, query_context


def render(sql, selections=None, time=None):
    selections = selections or {}
    env = SandboxedEnvironment()
    env.filters["where_in"] = lambda values: "(" + ", ".join(
        str(literal(v).compile(dialect=postgresql.dialect(),
                               compile_kwargs={"literal_binds": True}))
        for v in values) + ")"
    return env.from_string(sql).render(
        filter_values=lambda name, **kw: selections.get(name, []),
        get_filters=lambda name, **kw: selections.get(name, []),
        get_time_filter=lambda **kw: time or SimpleNamespace(from_expr=None, to_expr=None),
    )


class ParityContracts(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.boards = [json.loads(p.read_text(encoding="utf-8-sig"))
                      for p in sorted(parity.SOURCE_DIR.glob("*.json"))]
        if not cls.boards:
            raise RuntimeError("Grafana source dashboards must be mounted for parity tests")

    def test_every_source_panel_has_a_visual_counterpart(self):
        expected = {"olx-home": 11, "olx-overview": 25,
                    "olx-exits": 14, "olx-health": 21}
        for board in self.boards:
            source = list(parity.panels(board))
            self.assertEqual(len(source), expected[board["uid"]])
            names = set()
            for panel in source:
                names.add(parity.chart_name(board, panel))
                viz = parity.viz_type(panel)
                self.assertEqual(viz == "table", panel["type"] == "table")
                if panel["type"] == "xychart":
                    self.assertEqual(viz, "bubble_v2")
                sql = parity.compile_sql(board, panel)
                self.assertNotRegex(sql, r"\$\{|\$__")
                self.assertIn("lean.", render(sql))
            self.assertEqual(len(names), len(source))

    def test_shared_dashboard_kpis_keep_their_source_query(self):
        for board in self.boards:
            for panel in parity.panels(board):
                source_id = panel["targets"][0].get("panelId")
                if source_id:
                    source = next(p for p in parity.panels(board) if p["id"] == source_id)
                    self.assertEqual(parity.dataset_name(board, panel),
                                     parity.dataset_name(board, source))
                    self.assertEqual(parity.source_sql(board, panel),
                                     parity.source_sql(board, source))

    def test_exit_summary_cards_share_one_scan_and_all_metrics(self):
        board = next(b for b in self.boards if b['uid'] == 'olx-exits')
        cards = [p for p in parity.panels(board) if p['id'] in (1, 2, 3, 4)]
        self.assertEqual(len({parity.dataset_name(board, p) for p in cards}), 1)
        self.assertEqual(len({parity.compile_sql(board, p) for p in cards}), 1)
        sql = parity.shared_source_sql(board, cards[0])
        self.assertEqual(sql.count('FROM lean.listing_lifecycle_events'), 1)
        for card in cards:
            form = parity.chart_form(board, card, 7, [])
            self.assertEqual(len(form['dashboard_shared_metrics']), 4)
            self.assertIn(card['options']['reduceOptions']['fields'], sql)

    def test_native_values_are_sql_quoted_inside_source_aggregates(self):
        board = next(b for b in self.boards if b["uid"] == "olx-overview")
        panel = next(p for p in parity.panels(board) if p["id"] == 1)
        sql = render(parity.compile_sql(board, panel), {
            "__gf_deal": ["sell"], "__gf_rooms": ["3"],
            "__gf_neighborhood": ["O'Brien", "Centar"],
            "__gf_category": ["apartment'); SELECT 1; --"],
            "__gf_sqm": [{"op": ">=", "val": 40}, {"op": "<=", "val": 100}],
        })
        self.assertIn("ARRAY['O''Brien', 'Centar']", sql)
        self.assertIn("('apartment''); SELECT 1; --')", sql)
        self.assertIn("NULLIF(('40'), '')::numeric", sql)
        self.assertIn("NULLIF(('100'), '')::numeric", sql)
        self.assertIn("ss.search_key = ANY(l.search_keys)", sql)
        self.assertIn("FROM base", sql)

    def test_time_macros_preserve_health_window_and_include_today(self):
        for board in self.boards:
            for panel in parity.panels(board):
                if "$__time" not in parity.source_sql(board, panel):
                    continue
                window = parity.time_range(board, panel)
                self.assertTrue(window.endswith(": now"))
                self.assertIn("-48, hour" if board["uid"] == "olx-health" else "-90, day", window)
                sql = render(parity.compile_sql(board, panel),
                             time=SimpleNamespace(from_expr="'2026-09-01'::timestamp",
                                                  to_expr="'2026-10-02'::timestamp"))
                self.assertIn("'2026-09-01'::timestamp", sql)
                self.assertIn("'2026-10-02'::timestamp", sql)
                self.assertNotIn("None", sql)
                default = render(parity.compile_sql(board, panel))
                self.assertIn("now()", default)
                self.assertNotIn("None", default)

    def test_maps_are_present_without_keys_and_keep_links_and_coordinates(self):
        count = 0
        for board in self.boards:
            for panel in parity.panels(board):
                if panel["type"] != "geomap":
                    continue
                count += 1
                form = parity.chart_form(board, panel, 7,
                                         [{"column_name": n} for n in
                                          ["latitude", "longitude", "title", "url", "price"]])
                self.assertEqual(form["mapbox_style"], parity.MAP_STYLE)
                self.assertIn("/dark-matter-gl-style/", form["mapbox_style"])
                self.assertTrue(form["mapbox_style"].endswith("/style.json"))
                self.assertNotIn("{z}", form["mapbox_style"])
                self.assertTrue(form["autozoom"])
                self.assertIn("url", form["js_columns"])
                self.assertIn("AS map_point_id", parity.compile_sql(board, panel))
                self.assertIn("olx", form["js_onclick_href"])
                self.assertNotIn("document", form["js_tooltip"])
                query = json.loads(query_context(7, 9, form))["queries"][0]
                self.assertIn("latitude", query["columns"])
                self.assertIn("longitude", query["columns"])
                self.assertFalse(query["metrics"])
        self.assertEqual(count, 2)

    def test_layout_keeps_source_widths_and_kpis_compact(self):
        for board in self.boards:
            ids = {p["id"]: p["id"] for p in parity.panels(board)}
            layout = parity.dashboard_layout(board, ids, lambda *args: "test")
            for panel in parity.panels(board):
                meta = layout[f"CHART-{panel['id']}"]["meta"]
                self.assertEqual(meta["width"] * 2, panel["gridPos"]["w"])
                self.assertEqual(meta["height"], parity.panel_height(panel))
                if panel["type"] == "stat":
                    self.assertEqual(meta["height"], 24)
                elif panel["type"] in ("timeseries", "bargauge"):
                    self.assertGreaterEqual(meta["height"], 52)

    def test_cards_and_categorical_bars_use_readable_presentation_controls(self):
        for board in self.boards:
            for panel in parity.panels(board):
                if panel["type"] not in ("stat", "bargauge"):
                    continue
                form = parity.chart_form(board, panel, 7, [])
                if panel["type"] == "stat":
                    self.assertEqual(form["subheader"], "")
                    self.assertLess(form["subtitle_font_size"], form["header_font_size"])
                    self.assertLessEqual(form["subtitle_font_size"], 0.15)
                else:
                    self.assertFalse(form["zoomable"])
                    self.assertEqual(form["x_axis_label_interval"], 0)

    def test_raw_table_queries_do_not_group_repeated_events(self):
        board = next(b for b in self.boards if b["uid"] == "olx-exits")
        panel = next(p for p in parity.panels(board) if p["id"] == 13)
        form = parity.chart_form(board, panel, 7,
                                 [{"column_name": n} for n in
                                  ["title", "url", "closed_at", "ad_link"]])
        query = json.loads(query_context(7, 9, form))["queries"][0]
        self.assertIsNone(query["metrics"])
        self.assertIn("ad_link", query["columns"])

    def test_click_filters_intersect_native_filters_before_aggregation(self):
        board = next(b for b in self.boards if b["uid"] == "olx-overview")
        panel = next(p for p in parity.panels(board) if p["id"] == 1)
        sql = render(parity.compile_sql(board, panel), {
            "__gf_rooms": ["3"], "rooms": [{"op": "IN", "val": [2]}],
            "neighborhood": [{"op": "IN", "val": ["O'Brien"]},
                             {"op": "IN", "val": ["Centar"]}],
        })
        self.assertIn("coalesce(cf.rooms::text, 'unknown') IN ('2')", sql)
        self.assertIn("COALESCE(l.rooms,'unknown') = ('3')", sql)
        self.assertIn("IN ('O''Brien')", sql)
        self.assertIn("IN ('Centar')", sql)
        self.assertLess(sql.index("IN ('2')"), sql.index("FROM base"))

    def test_null_selection_and_unsafe_values_remain_valid_sql(self):
        sql = render(parity.push_cross_filters("SELECT count(*) FROM lean.listings"), {
            "property_type": [{"op": "IN", "val": [None]}],
            "neighborhood": [{"op": "IN", "val": ["x'); DROP TABLE listings; --"]}],
        })
        self.assertIn("FALSE OR cf.property_type::text IS NULL", sql)
        self.assertNotIn("IN ()", sql)
        self.assertIn("'x''); DROP TABLE listings; --'", sql)

    def test_every_chart_selection_reaches_every_sibling_including_raw_tables(self):
        charts = [{"id": i, "slice_name": str(i)} for i in range(1, 6)]
        metadata = cross_filter_metadata(charts)
        for chart in charts:
            scope = metadata["chart_configuration"][str(chart["id"])]["crossFilters"]
            self.assertEqual(scope["chartsInScope"], [i for i in range(1, 6) if i != chart["id"]])
            self.assertEqual(scope["scope"]["excluded"], [chart["id"]])
        self.assertEqual(metadata["global_chart_configuration"]["scope"]["excluded"], [])
        self.assertEqual(metadata["global_chart_configuration"]["chartsInScope"], [1, 2, 3, 4, 5])

    def test_room_bars_and_summary_tables_emit_dimensions_preserving_source_measures(self):
        board = next(b for b in self.boards if b["uid"] == "olx-overview")
        for panel_id, dimensions, names in [(8, ["rooms"], ["rooms", "listings"]),
                                            (22, ["segment"], ["segment", "listings", "median_ppm2"])]:
            panel = next(p for p in parity.panels(board) if p["id"] == panel_id)
            form = parity.chart_form(board, panel, 1, [{"column_name": n} for n in names])
            self.assertEqual(form["groupby"], dimensions)
            self.assertTrue(all(m["sqlExpression"].startswith('MAX(') for m in form["metrics"]))
            query = json.loads(query_context(1, 2, form))["queries"][0]
            self.assertEqual(query["columns"], ["Room count", "rooms"] if panel_id == 8 else dimensions)

    def test_event_population_never_filters_only_the_active_denominator(self):
        board = next(b for b in self.boards if b["uid"] == "olx-exits")
        panel = next(p for p in parity.panels(board) if p["id"] == 19)
        columns = parity.cross_filter_columns(parity.source_sql(board, panel))
        self.assertIn("rooms", columns)
        self.assertNotIn("floor", columns)
        sql = render(parity.compile_sql(board, panel), {"rooms": [{"op": "IN", "val": ["2"]}]})
        self.assertEqual(sql.count("coalesce(cf.rooms::text, 'unknown') IN ('2')"), 2)

    def test_chart_selections_filter_source_measures_without_sidebar_variables(self):
        board = next(b for b in self.boards if b["uid"] == "olx-overview")
        global_panel = next(p for p in parity.panels(board) if p["id"] == 10)
        self.assertFalse(parity.variable_names(parity.source_sql(board, global_panel)))
        sql = render(parity.compile_sql(board, global_panel), {"rooms": [{"op": "IN", "val": ["3"]}]})
        self.assertIn("coalesce(cf.rooms::text, 'unknown') IN ('3')", sql)

    def test_companion_selections_filter_inputs_even_when_dimension_is_not_output(self):
        sql = render(parity.push_cross_filters(
            "SELECT count(*) AS active FROM lean.listings WHERE closed_at IS NULL",
            unknown_label="Unknown"), {"rooms": [{"op": "IN", "val": ["Unknown"]}],
                                       "floor_num": [{"op": "IN", "val": [2]}]})
        self.assertIn("coalesce(cf.rooms::text, 'Unknown') IN ('Unknown')", sql)
        self.assertIn("cf.floor_num IN ('2')", sql)
        self.assertLess(sql.index("IN ('2')"), sql.index("WHERE closed_at"))

    def test_category_click_uses_membership_without_multiplying_listing_counts(self):
        sql = render(parity.push_cross_filters("SELECT count(*) FROM lean.listings"), {
            "category": [{"op": "IN", "val": ["O'Brien"]}]})
        self.assertIn("AND EXISTS (SELECT 1 FROM lean.saved_searches cf_search", sql)
        self.assertIn("cf_search.search_key = ANY(cf.search_keys)", sql)
        self.assertIn("IN ('O''Brien')", sql)
        self.assertNotIn("JOIN lean.saved_searches", sql)

    def test_companion_range_and_scalar_sidebar_filters_survive_pushdown(self):
        sql = render(parity.push_cross_filters("SELECT count(*) FROM lean.listings"), {
            "sqm": [{"op": ">=", "val": 40}, {"op": "<=", "val": 100}],
            "deal": [{"op": "==", "val": "sale"}]})
        self.assertIn("cf.sqm >= ('40')", sql)
        self.assertIn("cf.sqm <= ('100')", sql)
        self.assertIn("cf.deal::text = ('sale')", sql)

    def test_companion_unknown_property_selection_includes_missing_values(self):
        sql = render(parity.push_cross_filters("SELECT count(*) FROM lean.listings",
                                               unknown_label="Unknown"), {
            "property_type": [{"op": "IN", "val": ["Unknown"]}]})
        self.assertIn("cf.property_type::text IN ('Unknown')", sql)
        self.assertIn("OR cf.property_type IS NULL", sql)


if __name__ == "__main__":
    unittest.main()
