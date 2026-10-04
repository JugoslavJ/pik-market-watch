"""Patch the pinned Superset 6.0.0 vector map and cross-filter handlers.

Upstream DeckGLContainer.tsx mounts StaticMap only for mapbox:// styles.
Allow the versioned CARTO style endpoint through the same vector renderer.
Fail the image build if the pinned upstream gate changes. Rehash changed JS
assets and their references so browsers receive the rebuilt map component.
The time-series click handler must strip metric labels before constructing
dimension filters (the context-menu handler already accounts for this offset).
"""

import hashlib
import json
import re
from pathlib import Path


VECTOR_STYLES = "https://basemaps.cartocdn.com/gl/"
GATE = re.compile(
    r"(children:\(null==\((\w+)=(\w+)\.mapStyle\)\?void 0:\2)"
    r"\.startsWith\(\w+\.\w+\)"
    r'(\)\&\&\(0,\w+\.\w+\)\(\w+\.\w+,\{preserveDrawingBuffer:!0,'
    r'mapStyle:\3\.mapStyle\|\|"light",mapboxApiAccessToken:\3\.mapboxApiAccessToken\}\))'
)
VECTOR_CHECK = r".match(/^(?:mapbox:\/\/|https:\/\/basemaps\.cartocdn\.com\/gl\/)/)"
VALIDATOR_URLS = '["https://tile.osm","https://tile.openstreetmap"]'
ASSET_NAME = re.compile(r"(?P<digest>[0-9a-f]{20,64})(?P<tail>(?:\.(?:chunk|entry))?\.js)$")
CROSS_FILTER = ('const n=l.map((e=>p[e]));return{dataMask:{extraFormData:{'
                'filters:0===l.length?[]:h.map(((e,t)=>{const l=n.map((e=>e[t]));')
CROSS_FILTER_FIXED = CROSS_FILTER.replace('p[e]', 'p[e].slice(-h.length)')
CHART_LOADING = re.compile(
    r"(?P<loading>[A-Za-z_$][\w$]*)\?this\.renderSpinner\((?P<database>[^()]*)\)"
    r":this\.renderChartContainer\(\)"
)


def patch_chart_loading(text):
    patched, count = CHART_LOADING.subn(
        lambda match: (
            f"{match['loading']}&&!(this.props.queriesResponse&&"
            f"this.props.queriesResponse.length&&!this.props.queriesResponse[0].error&&"
            f"!this.props.queriesResponse[0].errors?.length)?this.renderSpinner({match['database']})"
            ":this.renderChartContainer()"
        ),
        text,
    )
    if count != 1:
        raise RuntimeError("Chart loading branch must occur exactly once")
    return patched


def find_chart_loading_asset(assets):
    matches = [path for path, text in assets.items() if CHART_LOADING.search(text)]
    if len(matches) != 1:
        raise RuntimeError(
            f"Expected one Superset 6 chart loading branch; found {len(matches)}"
        )
    return matches[0]


def patch_assets(root, request_script=None):
    assets = {p: p.read_text(encoding="utf-8") for p in root.glob("*.js")}
    matches = [(p, text) for p, text in assets.items() if GATE.search(text)]
    if len(matches) != 1:
        raise RuntimeError(f"Expected one Superset 6 Deck.gl vector gate; found {len(matches)}")
    path, text = matches[0]
    patched, count = GATE.subn(lambda m: m[1] + VECTOR_CHECK + m[4], text)
    if count != 1:
        raise RuntimeError("Deck.gl vector gate must occur exactly once")
    # Webpack entry runtimes can reference one another. Find the dependency
    # closure before assigning cache hashes, instead of iteratively hashing
    # those cycles until their filenames stop changing.
    changes = {path: patched}
    chart_path = find_chart_loading_asset(assets)
    changes[chart_path] = patch_chart_loading(
        changes.get(chart_path, assets[chart_path])
    )
    # ChartRenderer refuses updates while loading, preserving its mounted
    # chart. Its render guard also needs to allow a previously loaded result
    # when a chart moves back into view during a filter request.
    guard = re.compile(r'if\("loading"===(\w+)\|\|(\w+)\|\|null===\1\)return null;')
    chart_text = changes[chart_path]
    chart_text, count = guard.subn(
        lambda m: f'if(("loading"==={m[1]}&&!this.props.queriesResponse?.length)'
                  f'||{m[2]}||null==={m[1]})return null;', chart_text)
    if count != 1:
        raise RuntimeError("Expected one ChartRenderer loading guard")
    changes[chart_path] = chart_text
    if request_script is not None:
        overlay = re.compile(
            r'children:\[([\w$]+)&&'
            r'(\(0,[\w$]+\.[\w$]+\)\([\w$]+,\{style:\{width:[\w$]+,height:[\w$]+\(\)\}\}\))')
        overlays = [(p, overlay.search(content)) for p, content in assets.items()
                    if overlay.search(content)]
        if len(overlays) != 1:
            raise RuntimeError("Expected one dashboard chart loading overlay")
        overlay_path, match = overlays[0]
        source = re.search(r'queriesResponse:([\w$]+)\.queriesResponse',
                           assets[overlay_path][match.end():match.end() + 2500])
        if not source:
            raise RuntimeError("Expected chart response after loading overlay")
        overlay_text = changes.get(overlay_path, assets[overlay_path])
        changes[overlay_path] = overlay_text.replace(match[0],
            f'children:[{match[1]}&&!({source[1]}.queriesResponse?.length&&'
            f'!{source[1]}.queriesResponse[0].error)&&{match[2]}', 1)
        fetch_targets = [p for p, content in assets.items()
                         if 'fetchRetryOptions' in content and 'async function' in content
                         and 'constructorAction:"preserve"' in content]
        if len(fetch_targets) != 1:
            raise RuntimeError("Expected one Superset fetch client bundle")
        fetch_path = fetch_targets[0]
        changes[fetch_path] = request_script + '\n' + changes.get(fetch_path, assets[fetch_path])
    validators = [(p, content) for p, content in assets.items() if VALIDATOR_URLS in content]
    if len(validators) != 1:
        raise RuntimeError(f"Expected one Superset 6 map style validator; found {len(validators)}")
    validator_path, validator_content = validators[0]
    changes[validator_path] = changes.get(validator_path, validator_content).replace(
        VALIDATOR_URLS,
        '["https://tile.osm","https://tile.openstreetmap",' + json.dumps(VECTOR_STYLES) + ']',
    )
    handlers = [(p, content) for p, content in assets.items() if CROSS_FILTER in content]
    if len(handlers) != 1 or handlers[0][1].count(CROSS_FILTER) != 1:
        raise RuntimeError(f"Expected one Superset 6 timeseries selection handler; found {len(handlers)}")
    handler_path, handler_content = handlers[0]
    changes[handler_path] = changes.get(handler_path, handler_content).replace(
        CROSS_FILTER, CROSS_FILTER_FIXED,
    )
    fingerprint = "\n".join(changes[p] for p in sorted(changes))
    affected = set(changes)
    while True:
        digests = [ASSET_NAME.search(p.name)["digest"] for p in affected]
        expanded = affected | {p for p, content in assets.items()
                               if any(digest in content for digest in digests)}
        if expanded == affected:
            break
        affected = expanded
    replacements = {}
    names = {}
    for current_path in affected:
        name = ASSET_NAME.search(current_path.name)
        if not name:
            raise RuntimeError(f"Expected a content-hashed JavaScript asset: {current_path.name}")
        digest = name["digest"]
        # Hash the original asset with the changes as a build fingerprint.
        # Every affected filename changes deterministically, including cycles.
        updated_digest = hashlib.sha256(
            (assets[current_path] + fingerprint).encode()
        ).hexdigest()[:len(digest)]
        replacements[digest] = updated_digest
        names[current_path] = current_path.with_name(
            current_path.name.replace(digest, updated_digest)
        )
    for current_path, updated_path in names.items():
        content = changes.get(current_path, assets[current_path])
        for before, after in replacements.items():
            content = content.replace(before, after)
        updated_path.write_text(content, encoding="utf-8")
        current_path.unlink()
        # Superset's image ships uncompressed assets. Refuse stale precompressed
        # copies rather than serving an unpatched component through a proxy.
        for suffix in (".gz", ".br"):
            if current_path.with_name(current_path.name + suffix).exists():
                raise RuntimeError(f"Unexpected compressed asset: {current_path.name}{suffix}")
    # Webpack shares a chunk digest between its JS and extracted CSS. Updating
    # a JS chunk's runtime reference also changes miniCssF; rename its matching
    # stylesheet so lazy dashboard imports do not fail with a CSS 404.
    for stylesheet in root.glob("*.css"):
        updated_name = stylesheet.name
        for before, after in replacements.items():
            updated_name = updated_name.replace(before, after)
        if updated_name != stylesheet.name:
            stylesheet.rename(stylesheet.with_name(updated_name))
    for manifest in root.glob("*.json"):
        content = manifest.read_text(encoding="utf-8")
        for before, after in replacements.items():
            content = content.replace(before, after)
        json.loads(content)
        manifest.write_text(content, encoding="utf-8")
    print(
        "Fixed vector basemaps and chart selections, preserved rendered charts "
        f"during refresh; rehashed {len(replacements)} frontend assets"
    )


if __name__ == "__main__":
    patch_assets(Path("/app/superset/static/assets"),
                 Path("/tmp/dashboard_requests.js").read_text(encoding="utf-8"))
