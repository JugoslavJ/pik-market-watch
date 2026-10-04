import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from patch_frontend import CROSS_FILTER, CROSS_FILTER_FIXED, patch_assets


GATE = ('children:(null==(o=t.mapStyle)?void 0:o.startsWith(m.Pn))&&'
        '(0,a.Y)(i.b,{preserveDrawingBuffer:!0,mapStyle:t.mapStyle||"light",'
        'mapboxApiAccessToken:t.mapboxApiAccessToken})')
LOADING = ';h?this.renderSpinner(u):this.renderChartContainer();'
GUARD = 'if("loading"===a||n||null===a)return null;'


class VectorMapBundleTests(unittest.TestCase):
    def test_vector_gate_and_cache_references_are_updated_even_with_cycles(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            map_hash, app_hash, extra_hash = "a" * 20, "b" * 20, "c" * 20
            (root / f"{map_hash}.chunk.js").write_text(
                GATE + '; const urls=["https://tile.osm","https://tile.openstreetmap"];' + CROSS_FILTER + LOADING + GUARD)
            (root / f"spa.{app_hash}.entry.js").write_text(map_hash + " " + extra_hash)
            (root / f"explore.{extra_hash}.entry.js").write_text(app_hash)
            (root / f"DashboardContainer.{map_hash}.chunk.css").write_text('.chart { color: red; }')
            (root / "manifest.json").write_text(json.dumps({
                "map": f"{map_hash}.chunk.js", "app": f"spa.{app_hash}.entry.js",
                "explore": f"explore.{extra_hash}.entry.js",
                "css": f"DashboardContainer.{map_hash}.chunk.css",
            }))
            patch_assets(root)
            files = list(root.glob("*.js"))
            self.assertEqual(len(files), 3)
            text = " ".join(p.read_text() for p in files)
            self.assertIn("cartocdn", text)
            self.assertIn("mapbox", text)
            self.assertIn(CROSS_FILTER_FIXED, text)
            self.assertNotIn(CROSS_FILTER, text)
            self.assertIn('!this.props.queriesResponse[0].errors?.length', text)
            self.assertIn('"loading"===a&&!this.props.queriesResponse?.length', text)
            for old in (map_hash, app_hash, extra_hash):
                self.assertNotIn(old, text)
                self.assertNotIn(old, (root / "manifest.json").read_text())
            for filename in json.loads((root / "manifest.json").read_text()).values():
                self.assertTrue((root / filename).is_file())

    def test_image_build_fails_if_the_upstream_component_changes(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / ("a" * 20 + ".chunk.js")).write_text("changed upstream component")
            with self.assertRaisesRegex(RuntimeError, "Expected one Superset 6"):
                patch_assets(root)

    def test_image_build_fails_if_the_selection_handler_changes(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / ("a" * 20 + ".chunk.js")).write_text(
                GATE + '; const urls=["https://tile.osm","https://tile.openstreetmap"];' + LOADING + GUARD)
            with self.assertRaisesRegex(RuntimeError, "timeseries selection handler"):
                patch_assets(root)


if __name__ == "__main__":
    unittest.main()
