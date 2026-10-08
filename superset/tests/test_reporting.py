"""Execute real dashboard SQL against a tiny market with independently known results."""
import os
import sys
import unittest
from pathlib import Path

import psycopg2
from sqlalchemy import text
from sqlalchemy.dialects import postgresql

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
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
                INSERT INTO lean.saved_searches(search_key,name,url,category)
                  VALUES ('a','Apartments','https://olx.ba','apartments'),
                         ('b','Other apartments','https://olx.ba','apartments');
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
                            '{}','apartments',current_date-20,false,current_date-2,180000);
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
                  VALUES ('a',now()-interval '1 hour',now()-interval '59 minutes','ok',true,4),
                         ('b',now()-interval '30 minutes',now()-interval '29 minutes','error',false,0);
            """)

    @classmethod
    def tearDownClass(cls):
        cls.reporting.close()
        cls.seed.close()

    def query(self, uid, selected=None, cross=None):
        sql, params, _ = compile_dashboard(BOARDS[uid], selected, cross)
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
                rows = self.query(uid)
                for panel in panels(BOARDS[uid]):
                    self.assertIsInstance(rows[dataset_name(BOARDS[uid], panel)], list)
                empty = self.query(uid, cross={"rooms": ["no-such-room"]})
                self.assertIsInstance(empty, dict)

    def test_inventory_medians_and_yield_have_known_values(self):
        home = self.query("olx-home")
        summary = self.panel("olx-home", home, 2)[0]
        self.assertEqual(summary["active"], 4)
        self.assertEqual(summary["median_sale_ppm2"], 2000)
        self.assertEqual(summary["median_rent"], 600)
        self.assertEqual(summary["gross_yield_pct"], 6)
        overview = self.query("olx-overview")
        self.assertEqual(self.panel("olx-overview", overview, 1)[0]["active"], 4)
        self.assertEqual(self.panel("olx-overview", overview, 3)[0]["drops"], 2)

    def test_overlapping_categories_and_intersecting_filters_do_not_multiply_inventory(self):
        rows = self.query("olx-overview", {"category": ["apartments"]})
        self.assertEqual(self.panel("olx-overview", rows, 1)[0]["active"], 4)
        rows = self.query("olx-overview", {"rooms": ["2"], "deal": ["sell"]}, {"rooms": ["3"]})
        self.assertEqual(self.panel("olx-overview", rows, 1)[0]["active"], 0)
        rows = self.query("olx-overview", {"__property_elevator": ["Yes"]})
        self.assertEqual(self.panel("olx-overview", rows, 1)[0]["active"], 3)

    def test_reopened_listings_keep_every_exit_and_filter_both_event_and_active_populations(self):
        exits = self.query("olx-exits")
        summary = self.panel("olx-exits", exits, 1)[0]
        self.assertEqual(summary["closed_30d"], 3)
        self.assertAlmostEqual(summary["exit_ratio"], 42.9)
        self.assertEqual(summary["median_days_on_market"], 18)
        recent = self.panel("olx-exits", exits, 9)
        self.assertEqual(sum(row["title"] == "Reopened" for row in recent), 2)
        exits = self.query("olx-exits", cross={"rooms": ["2"]})
        summary = self.panel("olx-exits", exits, 1)[0]
        self.assertEqual(summary["closed_30d"], 2)
        self.assertEqual(summary["exit_ratio"], 40)

    def test_operational_counts_distinguish_success_and_incomplete_failures(self):
        health = self.query("olx-health")
        self.assertEqual(self.panel("olx-health", health, 1)[0]["searches"], 2)
        summary = self.panel("olx-health", health, 2)[0]
        self.assertEqual(summary["failed_24h"], 1)
        self.assertEqual(summary["success_rate"], 50)
        self.assertEqual(summary["cards_24h"], 4)
        self.assertEqual(summary["incomplete"], 1)
