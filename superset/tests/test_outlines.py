"""Neighborhood outline simplification for area maps."""

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import outlines


class OutlineTests(unittest.TestCase):
    def test_staircase_edges_collapse_and_rings_stay_closed(self):
        # A grid-traced edge: 0.0001° steps along a square.
        edge = [[17 + i / 10000, 44] for i in range(0, 101)]
        ring = edge + [[17.01, 44.01], [17, 44.01], [17, 44]]
        simplified = outlines.simplify(ring)
        self.assertLess(len(simplified), 10)
        self.assertEqual(simplified[0], simplified[-1])
        self.assertGreaterEqual(len(simplified), 4)

    def test_features_round_coordinates_and_skip_missing_geometry(self):
        shape = {"type": "Polygon", "coordinates": [[[17.123456, 44.1], [17.2, 44.1], [17.2, 44.2],
                                                     [17.123456, 44.1]]]}
        collection = outlines.collection([("Ada", shape), ("Empty", None)])
        self.assertEqual([f["properties"]["name"] for f in collection["features"]], ["Ada"])
        geometry = collection["features"][0]["geometry"]
        self.assertEqual(geometry["type"], "MultiPolygon")
        self.assertEqual(geometry["coordinates"][0][0][0], [17.1235, 44.1])


if __name__ == "__main__":
    unittest.main()
