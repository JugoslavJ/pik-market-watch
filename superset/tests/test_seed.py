import sys
import unittest
from pathlib import Path
from unittest.mock import Mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from client import InternalServiceCookiePolicy, SupersetAPI
from provisioning import (add_property_filters, prune_charts, query_context, raw_table, save_dashboard,
                          verify_chart)


class SeedContracts(unittest.TestCase):
    def test_secure_cookie_exception_is_limited_to_the_internal_service(self):
        from types import SimpleNamespace
        policy = InternalServiceCookiePolicy()
        cookie = SimpleNamespace(secure=True)
        self.assertTrue(policy.return_ok_secure(cookie, SimpleNamespace(type="http", host="superset:8088")))
        self.assertFalse(policy.return_ok_secure(cookie, SimpleNamespace(type="http", host="other:8088")))
        self.assertTrue(policy.return_ok_secure(cookie, SimpleNamespace(type="https", host="example.com")))

    def test_reseed_preserves_explicit_publication(self):
        api = Mock()
        api.call.return_value = {"result": {}}
        save_dashboard(api, {"id": 1, "dashboard_title": "Live", "published": True}, {}, {})
        self.assertTrue(api.call.call_args_list[0].args[2]["published"])
        self.assertNotIn("roles", api.call.call_args_list[0].args[2])

    def test_reseed_deletes_only_this_dashboards_stale_panel_charts(self):
        api = SupersetAPI()
        api.resource_rows = {"chart": [{"id": 2, "slice_name": "Board / Old"},
                                       {"id": 1, "slice_name": "Board / Kept"}]}
        api.call = Mock(return_value={"result": [
            {"id": 1, "slice_name": "Board / Kept"},
            {"id": 2, "slice_name": "Board / Old"},
            {"id": 3, "slice_name": "Other dashboard chart"},
        ]})
        self.assertEqual(prune_charts(api, 9, "Board / ", {1}), ["Board / Old"])
        self.assertEqual([c.args for c in api.call.call_args_list],
                         [("GET", "/api/v1/dashboard/9/charts"), ("DELETE", "/api/v1/chart/2")])
        self.assertIsNone(api.find("chart", "slice_name", "Board / Old"))

    def test_map_validation_requires_a_features_payload(self):
        api = Mock()
        api.call.return_value = {"data": {"rows": []}}
        with self.assertRaisesRegex(RuntimeError, "Map query failed"):
            verify_chart(api, {"id": 2, "slice_name": "Map"}, {"viz_type": "deck_scatter"})
        api.call.return_value = {"data": {"features": []}}
        self.assertEqual(verify_chart(api, {"id": 2, "slice_name": "Map"}, {"viz_type": "deck_scatter"}), 0)

    def test_lookup_fetches_each_page_once_and_reruns_do_not_duplicate_charts(self):
        api = SupersetAPI()
        first_page = [{"id": n, "slice_name": f"chart {n}"} for n in range(100)]
        api.call = Mock(side_effect=[
            {"result": first_page}, {"result": [{"id": 100, "slice_name": "last"}]},
            {"id": 101, "result": {"slice_name": "new"}},
        ])
        self.assertEqual(api.find("chart", "slice_name", "last")["id"], 100)
        self.assertEqual(api.find("chart", "slice_name", "chart 0")["id"], 0)
        one = api.ensure("chart", "slice_name", "new", {"slice_name": "new"})
        two = api.ensure("chart", "slice_name", "new", {"slice_name": "new"})
        self.assertEqual(one["id"], two["id"])
        self.assertEqual(api.call.call_count, 3)

    def test_raw_queries_preserve_duplicate_source_rows(self):
        import json
        spec = raw_table("Events", 1, ["article_id", "exit_date"])
        query = json.loads(query_context(1, 2, spec[2]))["queries"][0]
        self.assertIsNone(query["metrics"])
        self.assertEqual(query["columns"], ["article_id", "exit_date"])

    def test_property_filters_include_all_controls_and_exclude_operational_charts(self):
        api = Mock()
        api.ensure.return_value = {'id': 9}
        api.call.return_value = {'result': {'id': 9}}
        filters = add_property_filters(api, 1, [], [
            (1, 'SELECT count(*) FROM lean.listings'),
            (2, 'SELECT count(*) FROM lean.scrape_runs'),
            (3, 'SELECT count(*) FROM lean.listing_lifecycle_events'),
        ])
        by_column = {f['targets'][0]['column']['name']: f for f in filters}
        for column in ('__property_elevator', '__property_heating', '__property_condition', '__property_price_bam'):
            self.assertEqual(by_column[column]['scope']['excluded'], [2])
            self.assertEqual(by_column[column]['defaultDataMask']['extraFormData'], {})
        self.assertEqual(by_column['__property_price_bam']['filterType'], 'filter_range')


if __name__ == "__main__":
    unittest.main()
