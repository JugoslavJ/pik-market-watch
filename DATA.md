# Data provenance and licensing

The repository’s code, SQL, scripts, and dashboard definitions are licensed under AGPLv3. The neighborhood boundaries below have separate provenance and may carry additional attribution obligations.

| Artifact | Origin | Use and attribution |
|---|---|---|
| `db/init-lean/02-lean-neighborhoods.sql` | Banja Luka mjesne zajednice (MZ) boundaries traced from the city’s official map | The city map has no identified open-data licence in this repository. Use for personal analysis with attribution to the City of Banja Luka; obtain suitable permission before wider redistribution. |

The seed combines hand-drawn city-core and traced boundaries. Neighborhood names were cross-checked against OpenStreetMap place data (© OpenStreetMap contributors, ODbL 1.0). The source GeoJSON and tooling were removed from the working tree and remain in Git history. These polygons support approximate neighborhood assignment from listing pins, not cadastral boundaries.
