import sys
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from viewer_queries import (BOARDS, TRANSLATIONS, compile_dashboard, filter_template, listing_reference,
                            presentation, selections)
from listing_filters import PREFIX


class ViewerQueryTests(unittest.TestCase):
    def test_template_cache_reuses_compilation_and_evicts_old_sources(self):
        filter_template.cache_clear()
        self.addCleanup(filter_template.cache_clear)
        source = "SELECT {{ value }}"
        template = filter_template(source)
        self.assertIs(filter_template(source), template)
        self.assertEqual(template.render(value="first"), "SELECT first")
        self.assertEqual(template.render(value="second"), "SELECT second")
        for index in range(256):
            filter_template(f"SELECT {index}")
        self.assertEqual(filter_template.cache_info().currsize, 256)
        self.assertIsNot(filter_template(source), template)

    def test_all_142_panels_have_shared_sources_and_no_unexpanded_macros(self):
        count = 0
        for board in BOARDS.values():
            sql, params, groups = compile_dashboard(board)
            self.assertNotIn('${', sql)
            self.assertNotIn('{%', sql)
            self.assertIn('jsonb_build_object', sql)
            self.assertTrue(params)
            count += len(board['panels'])
        self.assertEqual(count, 142)

    def test_cached_option_lists_are_left_out_of_the_statement(self):
        for uid, board in BOARDS.items():
            with self.subTest(uid=uid):
                sql, _, _ = compile_dashboard(board, include_options=False)
                self.assertNotIn('property_options', sql)
                self.assertNotIn("'options'", sql)
                self.assertNotRegex(sql, r'^s*WITHs+SELECT')
                self.assertIn("'options'", compile_dashboard(board)[0])

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

    def test_property_filters_are_bound_and_applied_before_market_aggregation(self):
        hostile = "x'); DROP TABLE lean.listings; --"
        sql, params, _ = compile_dashboard(BOARDS['olx-overview'], {
            PREFIX + 'heating': [hostile], PREFIX + 'elevator': ['Yes'],
            PREFIX + 'price_bam_min': ['100000'], PREFIX + 'price_bam_max': ['300000'],
        }, {'rooms': ['3']})
        self.assertNotIn(hostile, sql)
        self.assertIn(hostile, params.values())
        self.assertIn('100000.0', params.values())
        self.assertIn('300000.0', params.values())
        self.assertIn("vrsta-grijanja", sql)
        self.assertIn("cf.elevator::text", sql)
        self.assertIn("cf.currency = 'BAM' THEN cf.price END >=", sql)
        self.assertIn("coalesce(cf.rooms::text, 'unknown') IN", sql)

    def test_amenities_reach_events_and_listing_denominators_together(self):
        sql, params, _ = compile_dashboard(BOARDS['olx-exits'], {PREFIX + 'elevator': ['No']})
        self.assertIn('property_listing.article_id = cf.article_id', sql)
        self.assertIn('cf.elevator::text', sql)
        self.assertIn('No', params.values())

    def test_every_page_has_property_controls_and_unknown_options(self):
        for board in BOARDS.values():
            names = {v['name'] for v in presentation(board)['variables']}
            for name in ('elevator', 'heating', 'condition', 'pets', 'balcony', 'bills_included', 'price_bam_min', 'price_bam_max'):
                self.assertIn(PREFIX + name, names)
            sql, _, _ = compile_dashboard(board)
            self.assertIn('SELECT DISTINCT "__property_heating"', sql)
            self.assertIn("'Unknown'", sql)

    def test_invalid_property_ranges_cannot_reach_the_database(self):
        for value in ('nan', 'inf', '-1', 'not a number'):
            with self.assertRaises(ValueError):
                selections(BOARDS['olx-overview'], {PREFIX + 'price_bam_min': [value]})
        with self.assertRaises(ValueError):
            selections(BOARDS['olx-overview'], {PREFIX + 'price_bam_min': ['200'], PREFIX + 'price_bam_max': ['100']})


    def test_listing_links_reduce_to_their_id(self):
        for value, expected in (('', ''), (' 123 ', '123'), ('https://olx.ba/artikal/77906444', '77906444'),
                                ('https://www.olx.ba/artikal/77906444/stan-centar?x=1', '77906444'),
                                ('HTTPS://OLX.BA/artikal/5#photos', '5')):
            self.assertEqual(listing_reference(value), expected)
        for value in ('1 OR 1=1', 'https://evil.example/artikal/5', 'https://olx.ba/artikal/abc',
                      '1234567890123', "5'; DROP TABLE lean.listings; --", 'olx.ba/artikal/5'):
            with self.subTest(value=value), self.assertRaises(ValueError):
                listing_reference(value)

    def test_price_check_inputs_are_validated_and_bound(self):
        board = BOARDS['olx-buyer']
        picked = selections(board, {'subject': ['https://olx.ba/artikal/42/stan'], 'subject_sqm': ['55']})
        self.assertEqual(picked['subject'], ['42'])
        sql, params, _ = compile_dashboard(board, {'subject': ['42'], 'subject_sqm': ['55']})
        self.assertIn('42', params.values())
        self.assertNotIn("'42'", sql)
        for selection in ({'subject': ['1; SELECT 1']}, {'subject_sqm': ['abc']}, {'subject_sqm': ['nan']}):
            with self.subTest(selection=selection), self.assertRaises(ValueError):
                selections(board, selection)

    def test_section_inputs_and_translations_reach_the_viewer(self):
        shown = presentation(BOARDS['olx-buyer'])
        sections = {v['name']: v.get('section') for v in shown['variables']}
        self.assertEqual(sections['subject'], 'Price check')
        self.assertIsNone(sections['rooms'])
        self.assertEqual(set(shown['translations']), set(TRANSLATIONS))
        area_map = next(p for p in presentation(BOARDS['olx-pro'])['panels'] if p['id'] == 10)
        self.assertEqual(area_map['view']['layer'], 'areas')


if __name__ == '__main__':
    unittest.main()
