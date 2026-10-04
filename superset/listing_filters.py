"""Shared property controls and trusted expressions for listing fact filters.

Raw OLX attributes supplement typed fields (some OLX codes have aliases).
Unknown is distinct from No. Event prices use the event snapshot; amenities
use the latest fetched listing details because events do not snapshot them.
"""

PREFIX = "__property_"


def text_value(expression):
    return f"coalesce(nullif(({expression})::text, ''), 'Unknown')"


def numeric_value(expression):
    return (f"CASE WHEN ({expression})::text ~ '^-?[0-9]+([.][0-9]+)?$' "
            f"THEN ({expression})::text::numeric END")


def attribute(*codes):
    return "coalesce(" + ", ".join(
        f"nullif(cf.extra->'characteristics'->>'{code}', '')" for code in codes
    ) + ", NULL)"


def boolean_value(expression):
    return (f"CASE lower(({expression})::text) WHEN 'true' THEN 'Yes' "
            "WHEN '1' THEN 'Yes' WHEN 'da' THEN 'Yes' WHEN 'yes' THEN 'Yes' "
            "WHEN 'false' THEN 'No' WHEN '0' THEN 'No' WHEN 'ne' THEN 'No' "
            "WHEN 'no' THEN 'No' ELSE 'Unknown' END")


# name, label, input kind, expression. Codes are repository constants only.
FILTERS = [
    ("deal", "Deal", "select", text_value("cf.deal")),
    ("property_type", "Property type", "select", text_value("cf.property_type")),
    ("neighborhood", "Neighborhood", "select", text_value("cf.neighborhood")),
    ("rooms", "Rooms", "select", text_value("cf.rooms")),
    ("seller_type", "Seller type", "select", text_value("cf.seller_type")),
    ("price_bam", "Asking price (BAM)", "range", "CASE WHEN cf.currency = 'BAM' THEN cf.price END"),
    ("ppm2_bam", "Price per m² (BAM)", "range", "CASE WHEN cf.currency = 'BAM' THEN cf.price / nullif(cf.sqm, 0) END"),
    ("sqm", "Area (m²)", "range", "cf.sqm"),
    ("floor_num", "Floor", "select", text_value("coalesce(cf.floor_num::text, " + attribute("sprat") + ")")),
    ("year_built", "Year built", "range", "cf.year_built"),
    ("elevator", "Lift available", "select", boolean_value("coalesce(cf.elevator::text, " + attribute("lift") + ")")),
    ("heating", "Heating", "select", text_value("coalesce(cf.extra->>'heating', " + attribute("vrsta-grijanja", "grijanje") + ")")),
    ("condition", "Apartment / property condition", "select", text_value("coalesce(cf.condition, " + attribute("stanje") + ")")),
    ("parking", "Parking", "select", boolean_value("coalesce(cf.parking::text, " + attribute("parking") + ")")),
    ("furnished", "Furnishing", "select", text_value("coalesce(" + attribute("opremljenost", "namjesten", "namjestena") + ", cf.extra->>'furnished')")),
    ("garage", "Garage", "select", boolean_value("coalesce(cf.extra->>'garage', " + attribute("gara-a", "garaza") + ")")),
    ("bathrooms", "Bathrooms", "range", numeric_value("coalesce(cf.extra->>'bathrooms', " + attribute("broj-kupatila", "broj-kupatil") + ")")),
    ("floors_total", "Building floors", "range", numeric_value("coalesce(cf.extra->>'floors_total', " + attribute("broj-spratova", "ukupno-spratova") + ")")),
    ("unit_levels", "Property levels", "range", numeric_value("coalesce(cf.extra->>'unit_levels', " + attribute("broj-etaza") + ")")),
    ("plot_sqm", "Plot area (m²)", "range", numeric_value("coalesce(cf.extra->>'plot_sqm', " + attribute("okucnica-kvadratura") + ")")),
    ("orientation", "Orientation", "select", text_value("coalesce(cf.extra->>'orientation', " + attribute("primarna-orjentacija") + ")")),
    ("balcony_sqm", "Balcony area (m²)", "range", numeric_value(attribute("kvadratura-balkona"))),
    ("views", "Ad views", "range", numeric_value("cf.extra->>'views'")),
    ("favorites", "Ad favourites", "range", numeric_value("cf.extra->>'favorites'")),
    ("price_state", "Price availability", "select", text_value("cf.extra->>'latest_price_state'")),
]

for name, label, codes in [
    ("balcony", "Balcony", ["balkon"]),
    ("air_conditioning", "Air conditioning", ["klima"]),
    ("electricity", "Electricity", ["struja"]),
    ("water", "Water", ["voda"]),
    ("sewerage", "Sewerage", ["kanalizacija"]),
    ("gas", "Gas", ["plin"]),
    ("registered", "Registered in land registry", ["uknjizeno-zk"]),
    ("internet", "Internet", ["internet"]),
    ("cable_tv", "Cable TV", ["kablovska-tv"]),
    ("security_door", "Security door", ["blindirana-vrata"]),
    ("telephone", "Telephone connection", ["telefonski-priklju-ak", "telefonski-prikljucak"]),
    ("video_surveillance", "Video surveillance", ["video-nadzor"]),
    ("storage", "Storage / pantry", ["ostava-pajz", "ostava-spajz"]),
    ("basement_attic", "Basement / attic", ["podrum-tavan"]),
    ("alarm", "Alarm", ["alarm"]),
    ("students", "Suitable for students", ["za-studente"]),
    ("bills_included", "Bills included", ["ukljucen-trosak-rezija"]),
    ("pets", "Pets allowed", ["kucni-ljubimci"]),
    ("pool", "Pool", ["bazen"]),
    ("new_build", "New build", ["novogradnja"]),
    ("recently_renovated", "Recently renovated", ["nedavno-adaptiran"]),
]:
    FILTERS.append((name, label, "select", boolean_value(attribute(*codes))))

for name, label, codes in [
    ("flooring", "Flooring", ["vrsta-poda"]),
    ("address", "Address", ["adresa"]),
    ("property_kind", "OLX property category", ["vrsta-nekretnine"]),
    ("ad_kind", "OLX ad type", ["vrsta-oglasa"]),
    ("agent_license", "Agent name / licence", ["ime-i-broj-licence-agenta"]),
    ("agency_contract", "Agency contract number", ["broj-posrednickog-ugovora"]),
]:
    FILTERS.append((name, label, "select", text_value(attribute(*codes))))

EXPRESSIONS = {PREFIX + name: expression for name, _, _, expression in FILTERS}
EVENT_EXPRESSIONS = {
    column: (expression if column in {PREFIX + n for n in ("deal", "property_type", "neighborhood", "rooms", "sqm")}
             else "cf.price" if column == PREFIX + "price_bam"
             else "cf.price / nullif(cf.sqm, 0)" if column == PREFIX + "ppm2_bam"
             else "(SELECT " + expression.replace("cf.", "property_listing.")
             + " FROM lean.listings property_listing WHERE property_listing.article_id = cf.article_id)")
    for column, expression in EXPRESSIONS.items()
}


def options_sql():
    return "SELECT " + ",\n".join(
        expression + ' AS "' + PREFIX + name + '"' for name, _, _, expression in FILTERS
    ) + " FROM lean.listings cf"


def viewer_variables(board):
    existing = {v["name"] for v in board.get("templating", {}).get("list", [])}
    result = []
    for name, label, kind, _ in FILTERS:
        if name in existing or (name == "sqm" and "min_sqm" in existing):
            continue
        column = PREFIX + name
        if kind == "range":
            result.extend({"name": column + suffix, "column": column, "op": op,
                           "label": label + " " + bound, "type": "textbox", "default": "",
                           "multi": False, "min": -5 if name == "floor_num" else 0,
                           "choices": [], "property": True}
                          for suffix, op, bound in [("_min", ">=", "minimum"), ("_max", "<=", "maximum")])
        else:
            result.append({"name": column, "column": column, "op": "IN", "label": label,
                           "type": "query", "multi": True, "default": "All", "choices": [], "property": True})
    return result
