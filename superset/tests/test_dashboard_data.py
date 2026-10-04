import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


class ProjectionContracts(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from dashboard_projection import simple_projection
        cls.projection = staticmethod(simple_projection)
        cls.source = SimpleNamespace(columns=[SimpleNamespace(column_name='active')])

    def body(self, metric):
        return {'result_format': 'json', 'result_type': 'full',
                'queries': [{'columns': [], 'metrics': [metric], 'extras': {}}]}

    def test_plain_aggregates_can_use_the_validated_response_cache(self):
        for expression in ['MAX("active")', 'COUNT(*)', '1']:
            self.assertTrue(self.projection(self.body({'sqlExpression': expression}), self.source))

    def test_ad_hoc_subqueries_and_sql_clauses_use_full_validation(self):
        for expression in ['(SELECT active FROM another_table)', 'MAX("other")', 'MAX(active)']:
            self.assertFalse(self.projection(self.body({'sqlExpression': expression}), self.source))
        body = self.body({'sqlExpression': 'COUNT(*)'})
        body['queries'][0]['extras']['where'] = 'EXISTS (SELECT 1 FROM another_table)'
        self.assertFalse(self.projection(body, self.source))

    def test_ad_hoc_axis_expressions_use_full_validation(self):
        body = self.body({'sqlExpression': 'COUNT(*)'})
        body['queries'][0]['columns'] = [{'sqlExpression': '(SELECT active FROM another_table)'}]
        self.assertFalse(self.projection(body, self.source))


if __name__ == '__main__':
    unittest.main()
