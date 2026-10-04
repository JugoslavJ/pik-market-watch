"""Shared vector basemap and pin presentation settings."""

MAP_STYLE = "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json"


def map_controls(columns, viewport):
    return {
        "spatial": {"type": "latlong", "latCol": "latitude", "lonCol": "longitude"},
        "js_columns": [column for column in columns if column not in ("latitude", "longitude")],
        "point_radius_fixed": {"type": "fix", "value": 35},
        "point_unit": "radius_m", "min_radius": 4, "max_radius": 8,
        "mapbox_style": MAP_STYLE, "autozoom": True, "filter_nulls": True,
        "color_picker": {"r": 46, "g": 196, "b": 182, "a": 0.85},
        "viewport": viewport,
    }
