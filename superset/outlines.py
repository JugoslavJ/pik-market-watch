"""Neighborhood outlines for area maps, simplified for the browser.

The reporting role cannot call PostGIS functions, but PostGIS's json cast
returns each boundary as GeoJSON; simplification happens here instead.
"""

TOLERANCE = 0.0005  # degrees, about 50 m at Banja Luka
DIGITS = 4  # about 10 m


def simplify(points, tolerance=TOLERANCE):
    """Douglas-Peucker on one ring; the ring stays closed and keeps at least 4 points."""
    if len(points) <= 4:
        return points
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        start, end = stack.pop()
        (x1, y1), (x2, y2) = points[start][:2], points[end][:2]
        dx, dy = x2 - x1, y2 - y1
        length = (dx * dx + dy * dy) ** 0.5
        farthest, index = 0.0, None
        for i in range(start + 1, end):
            x, y = points[i][:2]
            distance = (abs(dy * x - dx * y + x2 * y1 - y2 * x1) / length if length
                        else ((x - x1) ** 2 + (y - y1) ** 2) ** 0.5)
            if distance > farthest:
                farthest, index = distance, i
        if index is not None and farthest > tolerance:
            keep[index] = True
            stack.extend([(start, index), (index, end)])
    result = [point for point, kept in zip(points, keep) if kept]
    if len(result) < 4:
        # A closed ring this small would collapse; keep the original shape.
        return points
    return result


def feature(name, geometry):
    rings = ([geometry["coordinates"]] if geometry["type"] == "Polygon"
             else geometry["coordinates"])
    polygons = [[[[round(x, DIGITS), round(y, DIGITS)] for x, y, *_ in simplify(ring)]
                 for ring in polygon] for polygon in rings]
    return {"type": "Feature", "properties": {"name": name},
            "geometry": {"type": "MultiPolygon", "coordinates": polygons}}


def collection(rows):
    return {"type": "FeatureCollection",
            "features": [feature(name, geometry) for name, geometry in rows if geometry]}
