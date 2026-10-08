import json
import sys
import unittest
from pathlib import Path

from jinja2.sandbox import SandboxedEnvironment
from sqlalchemy import literal
from sqlalchemy.dialects import postgresql

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import definitions


def render(sql, selections=None):
    selections = selections or {}
    env = SandboxedEnvironment()
    env.filters["where_in"] = lambda values: "(" + ", ".join(
        str(literal(v).compile(dialect=postgresql.dialect(),
                               compile_kwargs={"literal_binds": True}))
        for v in values) + ")"
    return env.from_string(sql).render(get_filters=lambda name, **kw: selections.get(name, []))


class DefinitionContracts(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.boards = [json.loads(p.read_text(encoding="utf-8-sig"))
                      for p in sorted(definitions.SOURCE_DIR.glob("*.json"))]
        if not cls.boards:
            raise RuntimeError("Dashboard definitions must be mounted for definition tests")

    def board(self, uid):
        return next(b for b in self.boards if b["uid"] == uid)

    def test_every_dashboard_keeps_its_panels(self):
        expected = {"olx-home": 10, "olx-overview": 20, "olx-exits": 13, "olx-health": 20}
        self.assertEqual({b["uid"]: len(definitions.panels(b)) for b in self.boards}, expected)

    def test_reused_panels_share_their_source_query(self):
        for board in self.boards:
            for panel in definitions.panels(board):
                source_id = panel.get("source_panel")
                if source_id:
                    source = next(p for p in definitions.panels(board) if p["id"] == source_id)
                    self.assertEqual(definitions.dataset_name(board, panel),
                                     definitions.dataset_name(board, source))
                    self.assertEqual(definitions.source_sql(board, panel),
                                     definitions.source_sql(board, source))

    def test_exit_summary_cards_share_one_scan_and_all_metrics(self):
        board = self.board("olx-exits")
        cards = [p for p in definitions.panels(board) if p["id"] in (1, 2, 3, 4)]
        self.assertEqual(len({definitions.dataset_name(board, p) for p in cards}), 1)
        sql = definitions.shared_source_sql(board, cards[0])
        self.assertEqual(sql.count("FROM lean.listing_lifecycle_events"), 1)
        for card in cards:
            self.assertIn(card["field"], sql)

    def test_null_selection_and_unsafe_values_remain_valid_sql(self):
        sql = render(definitions.push_cross_filters("SELECT count(*) FROM lean.listings"), {
            "property_type": [{"op": "IN", "val": [None]}],
            "neighborhood": [{"op": "IN", "val": ["x'); DROP TABLE listings; --"]}],
        })
        self.assertIn("FALSE OR cf.property_type::text IS NULL", sql)
        self.assertNotIn("IN ()", sql)
        self.assertIn("'x''); DROP TABLE listings; --'", sql)

    def test_event_population_never_filters_only_the_active_denominator(self):
        board = self.board("olx-exits")
        panel = next(p for p in definitions.panels(board) if p["id"] == 19)
        sql = definitions.source_sql(board, panel)
        columns = definitions.cross_filter_columns(sql)
        self.assertIn("rooms", columns)
        self.assertNotIn("floor", columns)
        rendered = render(definitions.push_cross_filters(sql), {"rooms": [{"op": "IN", "val": ["2"]}]})
        self.assertEqual(rendered.count("coalesce(cf.rooms::text, 'unknown') IN ('2')"), 2)

    def test_selections_filter_inputs_even_when_dimension_is_not_output(self):
        sql = render(definitions.push_cross_filters(
            "SELECT count(*) AS active FROM lean.listings WHERE closed_at IS NULL"),
            {"rooms": [{"op": "IN", "val": ["unknown"]}], "floor_num": [{"op": "IN", "val": [2]}]})
        self.assertIn("coalesce(cf.rooms::text, 'unknown') IN ('unknown')", sql)
        self.assertIn("cf.floor_num IN ('2')", sql)
        self.assertLess(sql.index("IN ('2')"), sql.index("WHERE closed_at"))

    def test_category_selection_uses_membership_without_multiplying_listing_counts(self):
        sql = render(definitions.push_cross_filters("SELECT count(*) FROM lean.listings"), {
            "category": [{"op": "IN", "val": ["O'Brien"]}]})
        self.assertIn("AND EXISTS (SELECT 1 FROM lean.saved_searches cf_search", sql)
        self.assertIn("cf_search.search_key = ANY(cf.search_keys)", sql)
        self.assertIn("IN ('O''Brien')", sql)
        self.assertNotIn("JOIN lean.saved_searches", sql)

    def test_range_and_scalar_filters_survive_pushdown(self):
        sql = render(definitions.push_cross_filters("SELECT count(*) FROM lean.listings"), {
            "sqm": [{"op": ">=", "val": 40}, {"op": "<=", "val": 100}],
            "deal": [{"op": "==", "val": "sale"}]})
        self.assertIn("cf.sqm >= ('40')", sql)
        self.assertIn("cf.sqm <= ('100')", sql)
        self.assertIn("cf.deal::text = ('sale')", sql)

    def test_default_windows_follow_the_definition(self):
        self.assertEqual(definitions.default_days(self.board("olx-overview")), 90)
        self.assertEqual(definitions.default_days(self.board("olx-health")), 2)


if __name__ == "__main__":
    unittest.main()
