"""Execute real dashboard SQL against a tiny market with independently known results."""
import os
import sys
import unittest
from pathlib import Path

import psycopg2
from sqlalchemy import text
from sqlalchemy.dialects import postgresql

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import outlines
from viewer_queries import BOARDS, compile_dashboard
from definitions import dataset_name, panels


@unittest.skipUnless(os.environ.get("TEST_REPORTING_DATABASE_URL"), "Run npm run test:reporting for the disposable database")
class ReportingRules(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.seed = psycopg2.connect(os.environ["TEST_SEED_DATABASE_URL"])
        cls.reporting = psycopg2.connect(os.environ["TEST_REPORTING_DATABASE_URL"])
        cls.reporting.autocommit = True
        with cls.seed, cls.seed.cursor() as cursor:
            cursor.execute("""TRUNCATE lean.listings,lean.price_history,lean.saved_searches,
                lean.scrape_runs,lean.listing_lifecycle_events RESTART IDENTITY CASCADE;
                INSERT INTO lean.saved_searches(search_key,name,url)
                  VALUES ('a','Real estate','https://olx.ba'),
                         ('b','Real estate again','https://olx.ba');
                INSERT INTO lean.listings(article_id,title,url,deal,currency,price,sqm,ppm2,rooms,
                  search_keys,property_type,first_seen,elevator,closed_at,closing_price)
                  VALUES (1,'Sale A','https://olx.ba/artikal/1','sale','BAM',100000,50,2000,'2',
                            '{a,b}','apartments',current_date-20,true,NULL,NULL),
                         (2,'Sale B','https://olx.ba/artikal/2','sale','BAM',240000,60,4000,'3',
                            '{a}','apartments',current_date-15,false,NULL,NULL),
                         (3,'Rent','https://olx.ba/artikal/3','rent','BAM',600,50,NULL,'2',
                            '{a}','apartments',current_date-10,true,NULL,NULL),
                         (4,'Reopened','https://olx.ba/artikal/4','sale','BAM',120000,60,2000,'2',
                            '{a}','apartments',current_date-30,true,NULL,NULL),
                         (5,'Closed','https://olx.ba/artikal/5','sale','BAM',180000,60,3000,'3',
                            '{}','apartments',current_date-20,false,current_date-2,180000),
                         (6,'Plot','https://olx.ba/artikal/6','sale','BAM',50000,400,125,NULL,
                            '{a}','land',current_date-12,NULL,NULL,NULL),
                         (7,'Stan na dan','https://olx.ba/artikal/7','daily_rent','BAM',40,35,NULL,'1',
                            '{a}','daily_rent',current_date-3,NULL,NULL,NULL);
                INSERT INTO lean.listing_lifecycle_events(article_id,event_type,occurred_at,opened_at,
                   price,deal,property_type,sqm,rooms,title,url)
                  VALUES (4,'closed',current_date-8,current_date-30,150000,'sale','apartments',60,'2','Reopened','https://olx.ba/artikal/4'),
                         (4,'reopened',current_date-7,NULL,140000,'sale','apartments',60,'2','Reopened','https://olx.ba/artikal/4'),
                         (4,'closed',current_date-5,current_date-7,130000,'sale','apartments',60,'2','Reopened','https://olx.ba/artikal/4'),
                         (5,'closed',current_date-2,current_date-20,180000,'sale','apartments',60,'3','Closed','https://olx.ba/artikal/5');
                INSERT INTO lean.price_history(article_id,price_date,price,currency,source)
                  VALUES (1,current_date-6,120000,'BAM','api_price_history'),
                         (1,current_date-4,110000,'BAM','api_price_history'),
                         (1,current_date-2,100000,'BAM','api_price_history'),
                         (4,current_date-30,160000,'BAM','api_price_history'),
                         (4,current_date-8,150000,'BAM','api_price_history'),
                         (4,current_date-7,140000,'BAM','api_price_history'),
                         (4,current_date-5,130000,'BAM','api_price_history');
                INSERT INTO lean.scrape_runs(search_key,started_at,finished_at,status,is_complete,cards)
                  VALUES ('a',now()-interval '100 days',now()-interval '100 days'+interval '1 minute','ok',true,4),
                         ('a',now()-interval '1 hour',now()-interval '59 minutes','ok',true,4),
                         ('b',now()-interval '30 minutes',now()-interval '29 minutes','error',false,0);
            """)

    @classmethod
    def tearDownClass(cls):
        cls.reporting.close()
        cls.seed.close()

    def query(self, uid, selected=None, cross=None, days=None):
        sql, params, _ = compile_dashboard(BOARDS[uid], selected, cross, days=days)
        statement = text(sql)
        compiled = statement.bindparams(**{k: v for k, v in params.items() if k in statement._bindparams}).compile(dialect=postgresql.dialect())
        with self.reporting.cursor() as cursor:
            cursor.execute(str(compiled), compiled.params)
            return cursor.fetchone()[0]["rows"]

    def panel(self, uid, rows, panel_id):
        panel = next(panel for panel in panels(BOARDS[uid]) if panel["id"] == panel_id)
        return rows[dataset_name(BOARDS[uid], panel)]

    def test_every_panel_executes_against_empty_and_populated_markets(self):
        for uid in BOARDS:
            with self.subTest(uid=uid):
                # Every visibility rule allows All, so this selection shows every panel.
                shown = {name: ["All"] for panel in panels(BOARDS[uid]) for name in panel.get("when", {})}
                rows = self.query(uid, shown)
                for panel in panels(BOARDS[uid]):
                    self.assertIsInstance(rows[dataset_name(BOARDS[uid], panel)], list)
                empty = self.query(uid, cross={"rooms": ["no-such-room"]})
                self.assertIsInstance(empty, dict)

    def test_inventory_medians_and_yield_have_known_values(self):
        home = self.query("olx-home")
        summary = self.panel("olx-home", home, 2)[0]
        # Every category counts as inventory; prices describe apartments only.
        self.assertEqual(summary["active"], 6)
        self.assertEqual(summary["median_sale_ppm2"], 2000)
        self.assertEqual(summary["median_rent"], 600)
        self.assertEqual(summary["gross_yield_pct"], 6)
        overview = self.query("olx-overview")
        self.assertEqual(self.panel("olx-overview", overview, 1)[0]["active"], 4)
        self.assertEqual(self.panel("olx-overview", overview, 3)[0]["drops"], 2)

    def test_history_panels_follow_the_time_window(self):
        # Seven days hold exits on days -5 and -2; the week before holds day -8.
        summary = self.panel("olx-exits", self.query("olx-exits", days=7), 1)[0]
        self.assertEqual((summary["exits"], summary["exits_prev"]), (2, 1))
        self.assertEqual(summary["median_days_on_market"], 10)
        overview = self.query("olx-overview", days=7)
        # No apartment listing appeared this week; the rental appeared on day -10.
        tiles = self.panel("olx-overview", overview, 1)[0]
        self.assertEqual((tiles["new_n"], tiles["new_prev"]), (0, 1))
        # Listing 1 was cut on days -6, -4 and -2 and listing 4 on day -5; listing 4 also on day -8.
        cuts = self.panel("olx-overview", overview, 3)[0]
        self.assertEqual((cuts["drops"], cuts["drops_prev"]), (2, 1))
        self.assertEqual(cuts["cut_share_pct"], 50)
        # Collection began 100 days ago, so the window before the default 90 days is not covered.
        default = self.panel("olx-exits", self.query("olx-exits"), 1)[0]
        self.assertIsNone(default["exits_prev"])

    def test_deal_specific_panels_are_left_out_for_the_other_deal(self):
        board = BOARDS["olx-overview"]
        rent = self.query("olx-overview", {"deal": ["rent"]})
        keys = lambda ids: {dataset_name(board, p) for p in panels(board) if p["id"] in ids}
        # Sales charts are not computed; the rent tile and shared summary still are.
        self.assertFalse(keys([21, 26, 33]) & set(rent))
        self.assertTrue(keys([5]) <= set(rent))
        self.assertEqual(self.panel("olx-overview", rent, 1)[0]["median_rent"], 600)
        # The property-type mix needs every category.
        self.assertNotIn(dataset_name(board, next(p for p in panels(board) if p["id"] == 22)), self.query("olx-overview"))
        mix = self.panel("olx-overview", self.query("olx-overview", {"category": ["All"]}), 22)
        self.assertEqual([(row["segment"], row["listings"]) for row in mix], [("apartments", 3), ("land", 1)])

    def test_box_and_pie_panels_have_known_values(self):
        overview = self.query("olx-overview")
        rooms = {row["rooms"]: row for row in self.panel("olx-overview", overview, 21)}
        self.assertEqual({k: (v["listings"], v["p25"], v["median_ppm2"], v["p75"]) for k, v in rooms.items()},
                         {"2": (2, 2000, 2000, 2000), "3": (1, 4000, 4000, 4000)})
        exits = self.query("olx-exits")
        # Listing 5 has no price history, so only listing 4's two exits have an opening ask.
        self.assertEqual([(row["direction"], row["listings"]) for row in self.panel("olx-exits", exits, 15)],
                         [("lower", 2)])
        days = {row["rooms"]: row for row in self.panel("olx-exits", exits, 10)}
        self.assertEqual({k: (v["exits"], v["p25"], v["median_days"], v["p75"]) for k, v in days.items()},
                         {"2": (2, 7, 12, 17), "3": (1, 18, 18, 18)})

    def test_categories_follow_olx_and_intersecting_filters_do_not_multiply_inventory(self):
        rows = self.query("olx-overview", {"category": ["apartments"]})
        self.assertEqual(self.panel("olx-overview", rows, 1)[0]["active"], 4)
        # Every category except daily rentals, which only the Daily Rent board shows.
        rows = self.query("olx-overview", {"category": ["All"]})
        self.assertEqual(self.panel("olx-overview", rows, 1)[0]["active"], 5)
        rows = self.query("olx-overview", {"category": ["land"]})
        self.assertEqual(self.panel("olx-overview", rows, 1)[0]["active"], 1)
        rows = self.query("olx-overview", {"rooms": ["2"], "deal": ["sell"]}, {"rooms": ["3"]})
        self.assertEqual(self.panel("olx-overview", rows, 1)[0]["active"], 0)
        rows = self.query("olx-overview", {"__property_elevator": ["Yes"]})
        self.assertEqual(self.panel("olx-overview", rows, 1)[0]["active"], 3)

    def test_reopened_listings_keep_every_exit_and_filter_both_event_and_active_populations(self):
        exits = self.query("olx-exits")
        summary = self.panel("olx-exits", exits, 1)[0]
        self.assertEqual(summary["exits"], 3)
        # Four actives against three exits per 90 days: one a month.
        self.assertEqual(summary["months_of_inventory"], 4)
        self.assertEqual(summary["median_days_on_market"], 18)
        recent = self.panel("olx-exits", exits, 9)
        self.assertEqual(sum(row["title"] == "Reopened" for row in recent), 2)
        exits = self.query("olx-exits", cross={"rooms": ["2"]})
        summary = self.panel("olx-exits", exits, 1)[0]
        self.assertEqual(summary["exits"], 2)
        self.assertEqual(summary["months_of_inventory"], 4.5)

    def test_price_check_ranges_comparables_and_ignores_page_filters(self):
        # Sale comparables for 55 m²: actives 1, 2, 4 (2000, 4000, 2000 KM/m²) and exit 5 (3000).
        manual = {"subject_sqm": ["55"]}
        rows = self.query("olx-buyer", manual)
        check = self.panel("olx-buyer", rows, 1)[0]
        self.assertEqual(check["comps"], 4)
        self.assertEqual(check["fair_low"], 110000)
        self.assertEqual(check["fair_price"], 138000)
        self.assertEqual(check["fair_high"], 179000)
        self.assertIsNone(check["ask_vs_fair_change_pct"])
        # Listing 4 is active again; it appears once, as active.
        statuses = {row["title"]: row["status"] for row in self.panel("olx-buyer", rows, 7)}
        self.assertEqual(statuses, {"Sale A": "active", "Sale B": "active", "Reopened": "active",
                                    "Closed": "exited"})
        budget = self.query("olx-buyer", {**manual, "__property_price_bam_max": ["110000"]},
                            {"rooms": ["3"]})
        self.assertEqual(self.panel("olx-buyer", budget, 1)[0], check)

        linked = self.panel("olx-buyer", self.query("olx-buyer", {"subject": ["https://olx.ba/artikal/1"]}), 1)[0]
        self.assertEqual(linked["comps"], 3)
        self.assertEqual(linked["fair_price"], 150000)
        self.assertEqual(linked["ask_vs_fair_change_pct"], -33.3)

        rent = self.panel("olx-renter", self.query("olx-renter", {"subject_sqm": ["50"]}), 1)[0]
        self.assertEqual((rent["comps"], rent["fair_price"]), (1, 600))
        empty = self.panel("olx-buyer", self.query("olx-buyer"), 1)[0]
        self.assertEqual(empty["comps"], 0)

    def test_audience_market_figures_have_known_values(self):
        pro = self.panel("olx-pro", self.query("olx-pro"), 1)[0]
        self.assertEqual((pro["active"], pro["exits"]), (3, 3))
        # Three exits in the 90-day window are one a month against three actives.
        self.assertEqual(pro["months_of_inventory"], 3)
        buyer = self.query("olx-buyer")
        self.assertEqual(self.panel("olx-buyer", buyer, 10)[0]["active"], 3)
        # Listing 1 (120000 → 100000) and 4 (160000 → 120000) sit below their peak; 2 has no history.
        self.assertEqual(self.panel("olx-buyer", buyer, 10)[0]["cut_share_pct"], 66.7)
        # Both cycles of listing 4 ended below their first ask (-6.25% and -7.14%).
        negotiation = self.panel("olx-buyer", buyer, 31)[0]
        self.assertEqual(negotiation["below_first_pct"], 100)
        self.assertEqual(negotiation["median_final_change_pct"], -6.7)
        amenities = {row["amenity"]: row for row in self.panel("olx-renter", self.query("olx-renter"), 30)}
        self.assertEqual((amenities["Lift"]["with_amenity"], amenities["Lift"]["median_rent_with"]), (1, 600))
        self.assertEqual(amenities["Pets allowed"]["with_amenity"], 0)

    def test_daily_rentals_measure_activity_by_repricing(self):
        # Hosts reprice the same ad: listed at 45 KM a night on day -3, then 40 KM from day -1.
        with self.seed, self.seed.cursor() as cursor:
            cursor.execute("""INSERT INTO lean.price_history(article_id,price_date,price,currency,source)
                VALUES (7,current_date-3,45,'BAM','api_price_history'),
                       (7,current_date-1,40,'BAM','api_price_history')""")
        try:
            daily = self.query("olx-daily")
            summary = self.panel("olx-daily", daily, 10)[0]
            self.assertEqual((summary["repriced_pct"], summary["repriced_pct_prev"]), (100, 0))
            nights = {row["time"][:10]: row["median"] for row in self.panel("olx-daily", daily, 31)}
            prices = sorted(set(nights.values()))
            self.assertEqual(prices, [40, 45])
            self.assertEqual(nights[max(nights)], 40)
            # A seven-day window holds the change; the week before it does not.
            week = self.panel("olx-daily", self.query("olx-daily", days=7), 10)[0]
            self.assertEqual((week["repriced_pct"], week["repriced_pct_prev"]), (100, 0))
        finally:
            with self.seed, self.seed.cursor() as cursor:
                cursor.execute("DELETE FROM lean.price_history WHERE article_id = 7")

    def test_daily_rentals_stay_apart_from_monthly_rent(self):
        for category in ("apartments", "All"):
            rent = self.panel("olx-renter", self.query("olx-renter", {"category": [category]}), 10)[0]
            self.assertEqual((rent["active"], rent["median_rent"]), (1, 600))
        daily = self.panel("olx-daily", self.query("olx-daily"), 10)[0]
        self.assertEqual((daily["active"], daily["median_night"]), (1, 40))
        # Without an area bound, listings of unknown area still count.
        with self.seed, self.seed.cursor() as cursor:
            cursor.execute("UPDATE lean.listings SET sqm = NULL WHERE article_id = 7")
        try:
            daily = self.panel("olx-daily", self.query("olx-daily"), 10)[0]
            self.assertEqual(daily["active"], 1)
            bounded = self.panel("olx-daily", self.query("olx-daily", {"min_sqm": ["20"]}), 10)[0]
            self.assertEqual(bounded["active"], 0)
        finally:
            with self.seed, self.seed.cursor() as cursor:
                cursor.execute("UPDATE lean.listings SET sqm = 35 WHERE article_id = 7")

    def test_area_outlines_need_no_public_schema_access(self):
        # Some databases drop PostgreSQL's default USAGE on public for PUBLIC;
        # the reporting role must still read every outline.
        with self.seed, self.seed.cursor() as cursor:
            cursor.execute("REVOKE USAGE ON SCHEMA public FROM PUBLIC")
        try:
            with self.reporting.cursor() as cursor:
                cursor.execute(outlines.SQL)
                shapes = outlines.collection(cursor.fetchall())
        finally:
            with self.seed, self.seed.cursor() as cursor:
                cursor.execute("GRANT USAGE ON SCHEMA public TO PUBLIC")
        self.assertEqual(len(shapes["features"]), 56)
        self.assertEqual(shapes["features"][0]["geometry"]["type"], "MultiPolygon")

    def test_operational_counts_distinguish_success_and_incomplete_failures(self):
        health = self.query("olx-health")
        self.assertEqual(self.panel("olx-health", health, 1)[0]["searches"], 2)
        summary = self.panel("olx-health", health, 2)[0]
        self.assertEqual(summary["failed_runs"], 1)
        self.assertEqual(summary["success_rate"], 50)
        self.assertEqual(summary["cards"], 4)
        self.assertEqual(summary["incomplete"], 1)
