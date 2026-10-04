import sys
import unittest
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from viewer_queries import BOARDS, compile_dashboard, selections


class ViewerQueryTests(unittest.TestCase):
    def test_all_71_panels_have_shared_sources_and_no_unexpanded_macros(self):
        count = 0
        for board in BOARDS.values():
            sql, params, groups = compile_dashboard(board)
            self.assertNotIn('${', sql)
            self.assertNotIn('$__', sql)
            self.assertNotIn('{%', sql)
            self.assertIn('jsonb_build_object', sql)
            self.assertTrue(params)
            count += len([p for p in board['panels'] if p['type'] != 'row'])
        self.assertEqual(count, 71)

    def test_filter_values_are_parameters_not_sql(self):
        hostile = "x'); DROP TABLE lean.listings; --"
        sql, params, _ = compile_dashboard(BOARDS['olx-overview'], {'neighborhood': [hostile]}, {'rooms': [hostile]})
        self.assertNotIn(hostile, sql)
        self.assertIn(hostile, params.values())
        self.assertNotIn('{%', sql)

    def test_concurrent_requests_do_not_share_bind_values(self):
        def compile(value):
            sql, params, _ = compile_dashboard(BOARDS['olx-overview'], cross={'rooms': [value]})
            return [v for v in params.values() if v in ('a_unique', 'b_unique')]
        with ThreadPoolExecutor() as pool:
            results = list(pool.map(compile, ['a_unique', 'b_unique'] * 5))
        for result, expected in zip(results, ['a_unique', 'b_unique'] * 5):
            self.assertTrue(result)
            self.assertEqual(set(result), {expected})

    def test_unsupported_and_invalid_filters_are_rejected(self):
        board = BOARDS['olx-overview']
        for selection in [{'sql': ['anything']}, {'min_sqm': ['-1']}, {'deal': []}]:
            with self.assertRaises(ValueError):
                compile_dashboard(board, selection)
        with self.assertRaises(ValueError):
            compile_dashboard(board, cross={'sql': ['anything']})
        with self.assertRaises(ValueError):
            compile_dashboard(board, days=0)


if __name__ == '__main__':
    unittest.main()
