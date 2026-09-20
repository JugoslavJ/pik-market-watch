-- Canonical source views baseline.

-- Canonical source views baseline.
--
-- Name: v_listing_price_changes_source; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.v_listing_price_changes_source AS
 WITH resolved AS (
         SELECT DISTINCT ON (e.article_id, e.effective_at) e.id,
            e.article_id,
            e.effective_at,
            e.ingested_at,
            e.price,
            e.price_state,
            e.source,
            e.provenance,
            e.observed_at,
            e.renewed_at,
            e.effective_at_basis
           FROM public.listing_price_events e
          ORDER BY e.article_id, e.effective_at,
                CASE
                    WHEN (e.source = ANY (ARRAY['search'::text, 'detail'::text])) THEN 0
                    ELSE 1
                END,
                CASE e.price_state
                    WHEN 'conflict'::text THEN 0
                    WHEN 'invalid'::text THEN 1
                    WHEN 'unpriced'::text THEN 2
                    ELSE 3
                END, e.id DESC
        ), ordered AS (
         SELECT r.id,
            r.article_id,
            r.effective_at,
            r.ingested_at,
            r.price,
            r.price_state,
            r.source,
            r.provenance,
            r.observed_at,
            r.renewed_at,
            r.effective_at_basis,
            lag(r.price) OVER w AS prior_price,
            lag(r.price_state) OVER w AS prior_state,
            lag(r.effective_at) OVER w AS prior_effective_at
           FROM resolved r
          WINDOW w AS (PARTITION BY r.article_id ORDER BY r.effective_at, r.id)
        ), transitions AS (
         SELECT ordered.id,
            ordered.article_id,
            ordered.effective_at,
            ordered.ingested_at,
            ordered.price,
            ordered.price_state,
            ordered.source,
            ordered.provenance,
            ordered.observed_at,
            ordered.renewed_at,
            ordered.effective_at_basis,
            ordered.prior_price,
            ordered.prior_state,
            ordered.prior_effective_at
           FROM ordered
          WHERE ((ordered.price_state = 'valid'::text) AND (ordered.prior_state = 'valid'::text) AND (ordered.price IS NOT NULL) AND (ordered.prior_price IS NOT NULL) AND (ordered.price IS DISTINCT FROM ordered.prior_price))
        )
 SELECT t.article_id,
    t.effective_at,
    t.ingested_at,
    t.source,
    t.price,
    t.price_state,
        CASE
            WHEN s.is_rent THEN 'rent'::text
            ELSE 'sale'::text
        END AS deal,
    t.prior_price,
    (t.price - t.prior_price) AS delta,
        CASE
            WHEN (t.prior_price <> (0)::numeric) THEN (((t.price - t.prior_price) / t.prior_price) * (100)::numeric)
            ELSE NULL::numeric
        END AS pct_change,
    t.prior_effective_at,
    t.effective_at AS current_effective_at,
    s.category,
    s.category_membership AS category_memberships,
    s.sqm,
    s.rooms,
    s.filter_attributes AS provenance,
    false AS null_boundary
   FROM ((transitions t
     LEFT JOIN LATERAL ( SELECT h.is_rent,
            h.category,
            h.category_membership,
            h.sqm,
            h.rooms,
            h.filter_attributes
           FROM public.listing_state_history h
          WHERE ((h.article_id = t.article_id) AND (h.effective_at <= t.effective_at))
          ORDER BY h.effective_at DESC, h.id DESC
         LIMIT 1) s ON (true))
     LEFT JOIN LATERAL ( SELECT h.is_rent
           FROM public.listing_state_history h
          WHERE ((h.article_id = t.article_id) AND (h.effective_at <= t.prior_effective_at))
          ORDER BY h.effective_at DESC, h.id DESC
         LIMIT 1) previous ON (true))
  WHERE (
        CASE
            WHEN s.is_rent THEN 'rent'::text
            ELSE 'sale'::text
        END =
        CASE
            WHEN previous.is_rent THEN 'rent'::text
            ELSE 'sale'::text
        END);

--
-- Name: VIEW v_listing_price_changes_source; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON VIEW public.v_listing_price_changes_source IS 'Resolved price transitions; same-time evidence follows daily precedence and invalid/conflict/deal boundaries are suppressed.';

--
-- Name: v_listing_price_changes; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.v_listing_price_changes AS
 SELECT article_id,
    effective_at,
    ingested_at,
    source,
    price,
    price_state,
    deal,
    prior_price,
    delta,
    pct_change,
    prior_effective_at,
    current_effective_at,
    category,
    category_memberships,
    sqm,
    rooms,
    provenance,
    null_boundary
   FROM public.v_listing_price_changes_source;

--
-- Name: v_active_listings_source; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.v_active_listings_source AS
 SELECT article_id,
    url,
    title,
    sqm,
    rooms,
    price,
    price_text,
    ppm2,
    is_rent,
    location,
    latitude,
    longitude,
    closed_at,
    closing_price,
    closing_ppm2,
    closing_category,
    published_at,
    seller_type,
    rooms_detail,
    bathrooms,
    floor_num,
    floors_total,
    unit_levels,
    heating,
    furnished,
    condition,
    parking,
    garage,
    elevator,
    year_built,
    plot_sqm,
    orientation,
    views,
    favorites,
    characteristics,
    details_fetched_at,
    first_seen,
    last_seen,
    renewed_at
   FROM public.listings
  WHERE ((last_seen > (now() - '14 days'::interval)) AND (closed_at IS NULL));

--
-- Name: v_listing_lifecycle_cycles; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.v_listing_lifecycle_cycles AS
 WITH markers AS (
         SELECT first_search.article_id,
            first_search.effective_at AS opened_at,
            first_search.id AS marker_id
           FROM ( SELECT DISTINCT ON (listing_state_history.article_id) listing_state_history.article_id,
                    listing_state_history.effective_at,
                    listing_state_history.id
                   FROM public.listing_state_history
                  WHERE (listing_state_history.event_type = 'search_sighting'::text)
                  ORDER BY listing_state_history.article_id, listing_state_history.effective_at, listing_state_history.id) first_search
        UNION ALL
         SELECT listing_state_history.article_id,
            listing_state_history.effective_at,
            listing_state_history.id
           FROM public.listing_state_history
          WHERE (listing_state_history.event_type = 'reopened'::text)
        ), numbered AS (
         SELECT m.article_id,
            m.opened_at,
            m.marker_id,
            row_number() OVER (PARTITION BY m.article_id ORDER BY m.opened_at, m.marker_id) AS cycle_no,
            lead(m.opened_at) OVER (PARTITION BY m.article_id ORDER BY m.opened_at, m.marker_id) AS next_opened_at
           FROM markers m
        ), cycles AS (
         SELECT n.article_id,
            n.opened_at,
            n.marker_id,
            n.cycle_no,
            n.next_opened_at,
            c_1.closed_at
           FROM (numbered n
             LEFT JOIN LATERAL ( SELECT s.effective_at AS closed_at
                   FROM public.listing_state_history s
                  WHERE ((s.article_id = n.article_id) AND (s.event_type = 'closed'::text) AND (s.effective_at >= n.opened_at) AND ((n.next_opened_at IS NULL) OR (s.effective_at < n.next_opened_at)))
                  ORDER BY s.effective_at, s.id
                 LIMIT 1) c_1 ON (true))
        )
 SELECT c.article_id,
    c.cycle_no,
    c.opened_at,
    c.closed_at,
    fp.effective_at AS first_price_at,
    fp.price AS opening_price,
    (c.closed_at IS NOT NULL) AS is_closed,
        CASE
            WHEN (c.closed_at IS NULL) THEN NULL::integer
            ELSE GREATEST((round((EXTRACT(epoch FROM (c.closed_at - c.opened_at)) / 86400.0)))::integer, 0)
        END AS days_listed
   FROM (cycles c
     LEFT JOIN LATERAL ( SELECT e.effective_at,
            e.price
           FROM public.listing_price_events e
          WHERE ((e.article_id = c.article_id) AND (e.price_state = 'valid'::text) AND (e.effective_at >= c.opened_at) AND ((c.closed_at IS NULL) OR (e.effective_at <= c.closed_at)))
          ORDER BY e.effective_at, e.id
         LIMIT 1) fp ON (true));

--
-- Name: current_listings; Type: VIEW; Schema: reporting; Owner: -
--

CREATE VIEW reporting.current_listings AS
 SELECT article_id,
    url,
    title,
    sqm,
    rooms,
    price,
    price_text,
    ppm2,
    is_rent,
    location,
    latitude,
    longitude,
    closed_at,
    closing_price,
    closing_ppm2,
    closing_category,
    published_at,
    seller_type,
    rooms_detail,
    bathrooms,
    floor_num,
    floors_total,
    unit_levels,
    heating,
    furnished,
    condition,
    parking,
    garage,
    elevator,
    year_built,
    plot_sqm,
    orientation,
    views,
    favorites,
    characteristics,
    details_fetched_at,
    first_seen,
    last_seen,
    renewed_at
   FROM public.v_active_listings_source;

--
-- Name: resolved_price_evidence; Type: VIEW; Schema: reporting; Owner: -
--

CREATE VIEW reporting.resolved_price_evidence AS
 SELECT e.id,
    e.article_id,
    e.effective_at,
    e.ingested_at,
    e.price,
    e.price_state,
    e.source,
    e.provenance,
    e.observed_at,
    e.renewed_at,
    e.effective_at_basis,
    reporting.comparison_currency((e.provenance ->> 'currency'::text)) AS currency_normalized,
        CASE
            WHEN (e.provenance ? 'dealType'::text) THEN
            CASE (e.provenance ->> 'dealType'::text)
                WHEN 'sale'::text THEN false
                WHEN 'rent'::text THEN true
                ELSE NULL::boolean
            END
            ELSE s.is_rent
        END AS evidence_is_rent
   FROM (( SELECT DISTINCT ON (listing_price_events.article_id, listing_price_events.effective_at) listing_price_events.id,
            listing_price_events.article_id,
            listing_price_events.effective_at,
            listing_price_events.ingested_at,
            listing_price_events.price,
            listing_price_events.price_state,
            listing_price_events.source,
            listing_price_events.provenance,
            listing_price_events.observed_at,
            listing_price_events.renewed_at,
            listing_price_events.effective_at_basis
           FROM public.listing_price_events
          WHERE (listing_price_events.effective_at <= now())
          ORDER BY listing_price_events.article_id, listing_price_events.effective_at,
                CASE
                    WHEN (listing_price_events.source = ANY (ARRAY['search'::text, 'detail'::text])) THEN 0
                    ELSE 1
                END,
                CASE listing_price_events.price_state
                    WHEN 'conflict'::text THEN 0
                    WHEN 'invalid'::text THEN 1
                    WHEN 'unpriced'::text THEN 2
                    ELSE 3
                END, listing_price_events.id DESC) e
     LEFT JOIN LATERAL ( SELECT h.is_rent
           FROM public.listing_state_history h
          WHERE ((h.article_id = e.article_id) AND (h.effective_at <= e.effective_at) AND (h.is_rent IS NOT NULL))
          ORDER BY h.effective_at DESC, h.id DESC
         LIMIT 1) s ON (true));

--
-- Name: current_comparison_inputs; Type: VIEW; Schema: reporting; Owner: -
--

CREATE VIEW reporting.current_comparison_inputs AS
 WITH evidence AS (
         SELECT l.article_id,
            l.url,
            l.title,
            l.sqm,
            l.rooms,
            l.is_rent,
                CASE
                    WHEN l.is_rent THEN 'rent'::text
                    ELSE 'sale'::text
                END AS deal,
            l.latitude,
            l.longitude,
            l.first_seen,
            l.last_seen,
            l.seller_type,
            l.condition,
            l.parking,
            l.garage,
            l.elevator,
            l.heating,
            l.floor_num,
            l.plot_sqm,
            l.year_built,
            l.bathrooms,
            l.rooms_detail,
                CASE
                    WHEN furnishing.found THEN furnishing.value
                    ELSE l.furnished
                END AS furnished,
            types.category_memberships,
            reporting.comparison_property_type(types.category_memberships) AS property_type,
            n.name AS neighborhood,
                CASE
                    WHEN (l.rooms ~ '^[0-9]+[+]?$'::text) THEN
                    CASE
                        WHEN ((split_part(l.rooms, '+'::text, 1))::numeric >= (4)::numeric) THEN '4+'::text
                        ELSE l.rooms
                    END
                    ELSE NULL::text
                END AS room_bucket,
            p.price AS resolved_price,
            COALESCE(p.price_state, 'unknown'::text) AS price_state,
            p.currency_normalized AS currency,
            p.effective_at AS price_effective_at,
            p.evidence_is_rent,
            cycle.opened_at AS cycle_opened_at,
                CASE
                    WHEN (cycle.opened_at IS NOT NULL) THEN (floor((EXTRACT(epoch FROM (now() - cycle.opened_at)) / (86400)::numeric)))::integer
                    ELSE NULL::integer
                END AS current_cycle_age_days,
            COALESCE((cycle.cycle_no > 1), false) AS reopened,
            now() AS benchmark_at,
            1 AS score_version
           FROM (((((reporting.current_listings l
             LEFT JOIN LATERAL ( SELECT array_agg(DISTINCT ss.category ORDER BY ss.category) AS category_memberships
                   FROM (public.search_results sr
                     JOIN public.saved_searches ss USING (search_key))
                  WHERE (sr.article_id = l.article_id)) types ON (true))
             LEFT JOIN public.neighborhoods n ON ((n.name = COALESCE(NULLIF(l.location, ''::text), public.neighborhood_of(l.latitude, l.longitude)))))
             LEFT JOIN LATERAL ( SELECT e.id,
                    e.article_id,
                    e.effective_at,
                    e.ingested_at,
                    e.price,
                    e.price_state,
                    e.source,
                    e.provenance,
                    e.observed_at,
                    e.renewed_at,
                    e.effective_at_basis,
                    e.currency_normalized,
                    e.evidence_is_rent
                   FROM reporting.resolved_price_evidence e
                  WHERE (e.article_id = l.article_id)
                  ORDER BY e.effective_at DESC
                 LIMIT 1) p ON (true))
             LEFT JOIN LATERAL ( SELECT true AS found,
                        CASE (h.filter_attributes ->> 'furnished'::text)
                            WHEN 'true'::text THEN true
                            WHEN 'false'::text THEN false
                            ELSE NULL::boolean
                        END AS value
                   FROM public.listing_state_history h
                  WHERE ((h.article_id = l.article_id) AND (h.effective_at <= now()) AND (h.filter_attributes ? 'furnished'::text))
                  ORDER BY h.effective_at DESC, h.id DESC
                 LIMIT 1) furnishing ON (true))
             LEFT JOIN LATERAL ( SELECT c.article_id,
                    c.cycle_no,
                    c.opened_at,
                    c.closed_at,
                    c.first_price_at,
                    c.opening_price,
                    c.is_closed,
                    c.days_listed
                   FROM public.v_listing_lifecycle_cycles c
                  WHERE ((c.article_id = l.article_id) AND (c.opened_at <= now()))
                  ORDER BY c.opened_at DESC, c.cycle_no DESC
                 LIMIT 1) cycle ON ((cycle.closed_at IS NULL)))
        ), quality AS (
         SELECT e.article_id,
            e.url,
            e.title,
            e.sqm,
            e.rooms,
            e.is_rent,
            e.deal,
            e.latitude,
            e.longitude,
            e.first_seen,
            e.last_seen,
            e.seller_type,
            e.condition,
            e.parking,
            e.garage,
            e.elevator,
            e.heating,
            e.floor_num,
            e.plot_sqm,
            e.year_built,
            e.bathrooms,
            e.rooms_detail,
            e.furnished,
            e.category_memberships,
            e.property_type,
            e.neighborhood,
            e.room_bucket,
            e.resolved_price,
            e.price_state,
            e.currency,
            e.price_effective_at,
            e.evidence_is_rent,
            e.cycle_opened_at,
            e.current_cycle_age_days,
            e.reopened,
            e.benchmark_at,
            e.score_version,
            COALESCE(
                CASE
                    WHEN ((e.evidence_is_rent IS DISTINCT FROM e.is_rent) AND (e.price_state = 'valid'::text)) THEN 'Price evidence belongs to another or unknown deal segment'::text
                    ELSE NULL::text
                END,
                CASE
                    WHEN (EXISTS ( SELECT 1
                       FROM public.listing_state_history h
                      WHERE ((h.article_id = e.article_id) AND (h.effective_at > e.price_effective_at) AND (h.effective_at <= now()) AND (h.is_rent IS DISTINCT FROM e.is_rent) AND (h.is_rent IS NOT NULL)))) THEN 'Price evidence predates a deal switch'::text
                    ELSE NULL::text
                END, reporting.comparison_price_reason(e.resolved_price, e.price_state, e.currency, e.is_rent)) AS price_reason
           FROM evidence e
        ), eligible AS (
         SELECT q.article_id,
            q.url,
            q.title,
            q.sqm,
            q.rooms,
            q.is_rent,
            q.deal,
            q.latitude,
            q.longitude,
            q.first_seen,
            q.last_seen,
            q.seller_type,
            q.condition,
            q.parking,
            q.garage,
            q.elevator,
            q.heating,
            q.floor_num,
            q.plot_sqm,
            q.year_built,
            q.bathrooms,
            q.rooms_detail,
            q.furnished,
            q.category_memberships,
            q.property_type,
            q.neighborhood,
            q.room_bucket,
            q.resolved_price,
            q.price_state,
            q.currency,
            q.price_effective_at,
            q.evidence_is_rent,
            q.cycle_opened_at,
            q.current_cycle_age_days,
            q.reopened,
            q.benchmark_at,
            q.score_version,
            q.price_reason,
                CASE
                    WHEN (q.price_reason IS NULL) THEN q.resolved_price
                    ELSE NULL::numeric
                END AS asking_price,
                CASE
                    WHEN ((q.price_reason IS NULL) AND (reporting.comparison_quality_reason(q.resolved_price, q.price_state, q.currency, q.sqm, q.is_rent) IS NULL)) THEN (q.resolved_price / q.sqm)
                    ELSE NULL::numeric
                END AS asking_rate,
            COALESCE(q.price_reason, reporting.comparison_quality_reason(q.resolved_price, q.price_state, q.currency, q.sqm, q.is_rent),
                CASE
                    WHEN (q.neighborhood IS NULL) THEN 'Missing mapped neighbourhood'::text
                    WHEN (q.property_type IS NULL) THEN 'Unknown or ambiguous property type'::text
                    WHEN (q.room_bucket IS NULL) THEN 'Missing or unsupported room bucket'::text
                    WHEN (q.is_rent AND (q.furnished IS NULL)) THEN 'Unknown or partial furnishing'::text
                    ELSE NULL::text
                END) AS score_input_reason
           FROM quality q
        )
 SELECT article_id,
    url,
    title,
    sqm,
    rooms,
    is_rent,
    deal,
    latitude,
    longitude,
    first_seen,
    last_seen,
    seller_type,
    condition,
    parking,
    garage,
    elevator,
    heating,
    floor_num,
    plot_sqm,
    year_built,
    bathrooms,
    rooms_detail,
    furnished,
    category_memberships,
    property_type,
    neighborhood,
    room_bucket,
    resolved_price,
    price_state,
    currency,
    price_effective_at,
    evidence_is_rent,
    cycle_opened_at,
    current_cycle_age_days,
    reopened,
    benchmark_at,
    score_version,
    price_reason,
    asking_price,
    asking_rate,
    score_input_reason
   FROM eligible;

--
-- Name: current_listings; Type: VIEW; Schema: dashboard_public; Owner: -
--

CREATE VIEW dashboard_public.current_listings AS
 SELECT article_id,
    url,
    title,
    category_memberships,
    deal,
    sqm,
    rooms,
    price,
    ppm2,
    neighborhood,
    latitude,
    longitude,
    published_at,
    first_seen,
    renewed_at,
    last_seen,
    views
   FROM olap.public_current_listings;

--
-- Name: current_listings_source; Type: VIEW; Schema: dashboard_public; Owner: -
--

CREATE VIEW dashboard_public.current_listings_source AS
 SELECT l.article_id,
        CASE
            WHEN (l.url ~ '^https?://(www\.)?olx\.ba/artikal/[0-9]+/?$'::text) THEN l.url
            ELSE NULL::text
        END AS url,
    l.title,
    COALESCE(m.categories, '{}'::text[]) AS category_memberships,
        CASE
            WHEN l.is_rent THEN 'rent'::text
            ELSE 'sale'::text
        END AS deal,
    l.sqm,
    l.rooms,
    l.price,
    l.ppm2,
    COALESCE(NULLIF(l.location, ''::text),
        CASE
            WHEN (l.latitude IS NULL) THEN '(no pin)'::text
            ELSE '(unmapped)'::text
        END) AS neighborhood,
    l.latitude,
    l.longitude,
    l.published_at,
    l.first_seen,
    l.renewed_at,
    l.last_seen,
    l.views
   FROM (public.listings l
     LEFT JOIN LATERAL ( SELECT array_agg(DISTINCT ss.category ORDER BY ss.category) FILTER (WHERE (NULLIF(btrim(ss.category), ''::text) IS NOT NULL)) AS categories
           FROM (public.search_results sr
             JOIN public.saved_searches ss ON ((ss.search_key = sr.search_key)))
          WHERE (sr.article_id = l.article_id)) m ON (true))
  WHERE ((l.closed_at IS NULL) AND (l.last_seen > (now() - '14 days'::interval)));

--
-- Name: VIEW current_listings_source; Type: COMMENT; Schema: dashboard_public; Owner: -
--

COMMENT ON VIEW dashboard_public.current_listings_source IS 'Observed active OLX article IDs, deduplicated at article grain; current market fields only.';

--
-- Name: daily_market_source; Type: VIEW; Schema: dashboard_public; Owner: -
--

CREATE VIEW dashboard_public.daily_market_source AS
 SELECT day,
    article_id,
    COALESCE(NULLIF(category_memberships, '{}'::text[]),
        CASE
            WHEN (category IS NULL) THEN '{}'::text[]
            ELSE ARRAY[category]
        END) AS category_memberships,
        CASE
            WHEN (is_rent IS TRUE) THEN 'rent'::text
            WHEN (is_rent IS FALSE) THEN 'sale'::text
            ELSE 'unknown'::text
        END AS deal,
    sqm,
    rooms,
    price,
    price_state,
    ppm2,
    COALESCE(NULLIF(neighborhood, ''::text),
        CASE
            WHEN (location IS NULL) THEN '(unmapped)'::text
            ELSE location
        END) AS neighborhood,
    stale_observation,
    provisional_day,
    membership_inferred,
    attributes_inferred
   FROM public.listing_daily d;

--
-- Name: VIEW daily_market_source; Type: COMMENT; Schema: dashboard_public; Owner: -
--

COMMENT ON VIEW dashboard_public.daily_market_source IS 'Reconstructed listing-day evidence with explicit deal and quality flags.';

--
-- Name: exit_cycles_source; Type: VIEW; Schema: dashboard_public; Owner: -
--

CREATE VIEW dashboard_public.exit_cycles_source AS
 WITH closed AS (
         SELECT c.article_id,
            c.cycle_no,
            c.opened_at,
            c.closed_at,
            c.days_listed,
            l.title,
                CASE
                    WHEN (l.url ~ '^https?://(www\.)?olx\.ba/artikal/[0-9]+/?$'::text) THEN l.url
                    ELSE NULL::text
                END AS url
           FROM (public.v_listing_lifecycle_cycles c
             JOIN public.listings l ON ((l.article_id = c.article_id)))
          WHERE c.is_closed
        ), state_at_close AS (
         SELECT c.article_id,
            c.cycle_no,
            c.opened_at,
            c.closed_at,
            c.days_listed,
            c.title,
            c.url,
            s.category,
            s.category_membership,
            s.is_rent,
            s.sqm,
            s.rooms
           FROM (closed c
             LEFT JOIN LATERAL ( SELECT h.category,
                    h.category_membership,
                    h.is_rent,
                    h.sqm,
                    h.rooms
                   FROM public.listing_state_history h
                  WHERE ((h.article_id = c.article_id) AND (h.effective_at <= c.closed_at) AND (h.event_type = ANY (ARRAY['search_sighting'::text, 'detail_update'::text, 'reopened'::text])))
                  ORDER BY h.effective_at DESC, h.id DESC
                 LIMIT 1) s ON (true))
        ), price_at_close AS (
         SELECT s.article_id,
            s.cycle_no,
            s.opened_at,
            s.closed_at,
            s.days_listed,
            s.title,
            s.url,
            s.category,
            s.category_membership,
            s.is_rent,
            s.sqm,
            s.rooms,
            p.price_state,
            p.price,
                CASE
                    WHEN ((p.price_state = 'valid'::text) AND (p.price IS NOT NULL) AND (s.is_rent = false) AND ((s.sqm >= (5)::numeric) AND (s.sqm <= (500)::numeric)) AND (((p.price / NULLIF(s.sqm, (0)::numeric)) >= (1)::numeric) AND ((p.price / NULLIF(s.sqm, (0)::numeric)) <= (15000)::numeric))) THEN (round((p.price / NULLIF(s.sqm, (0)::numeric))))::integer
                    ELSE NULL::integer
                END AS asking_ppm2
           FROM (state_at_close s
             LEFT JOIN LATERAL ( SELECT e.price_state,
                    e.price
                   FROM public.listing_price_events e
                  WHERE ((e.article_id = s.article_id) AND (e.effective_at <= s.closed_at))
                  ORDER BY e.effective_at DESC,
                        CASE
                            WHEN (e.source = ANY (ARRAY['search'::text, 'detail'::text])) THEN 0
                            ELSE 1
                        END,
                        CASE e.price_state
                            WHEN 'conflict'::text THEN 0
                            WHEN 'invalid'::text THEN 1
                            WHEN 'unpriced'::text THEN 2
                            ELSE 3
                        END, e.id DESC
                 LIMIT 1) p ON (true))
        )
 SELECT article_id,
    cycle_no,
    title,
    url,
    opened_at,
    closed_at,
    days_listed,
    COALESCE(category_membership,
        CASE
            WHEN (category IS NULL) THEN '{}'::text[]
            ELSE ARRAY[category]
        END) AS category_memberships,
    category,
        CASE
            WHEN (is_rent IS TRUE) THEN 'rent'::text
            WHEN (is_rent IS FALSE) THEN 'sale'::text
            ELSE 'unknown'::text
        END AS deal,
    sqm,
    rooms,
        CASE
            WHEN (price_state = 'valid'::text) THEN price
            ELSE NULL::numeric
        END AS last_asking_price,
    asking_ppm2 AS last_asking_ppm2,
    (cycle_no > 1) AS reopened_cycle
   FROM price_at_close;

--
-- Name: VIEW exit_cycles_source; Type: COMMENT; Schema: dashboard_public; Owner: -
--

COMMENT ON VIEW dashboard_public.exit_cycles_source IS 'Observed closure cycles with attributes and asking price resolved at closure time; not confirmed transactions.';

--
-- Name: freshness_source; Type: VIEW; Schema: dashboard_public; Owner: -
--

CREATE VIEW dashboard_public.freshness_source AS
 SELECT COALESCE(NULLIF(ss.category, ''::text), '(unclassified)'::text) AS category,
    (count(*))::integer AS configured_searches,
        CASE
            WHEN (count(success.finished_at) = count(*)) THEN min(success.finished_at)
            ELSE NULL::timestamp with time zone
        END AS last_success_at
   FROM (public.saved_searches ss
     LEFT JOIN LATERAL ( SELECT max(r.finished_at) AS finished_at
           FROM public.scrape_runs r
          WHERE ((r.search_key = ss.search_key) AND (r.status = 'ok'::text) AND (r.is_complete = true) AND (r.finished_at IS NOT NULL))) success ON (true))
  GROUP BY COALESCE(NULLIF(ss.category, ''::text), '(unclassified)'::text);

--
-- Name: VIEW freshness_source; Type: COMMENT; Schema: dashboard_public; Owner: -
--

COMMENT ON VIEW dashboard_public.freshness_source IS 'Per-category oldest authoritative search success; any never-successful configured search makes the watermark unknown.';

--
-- Name: price_reductions_source; Type: VIEW; Schema: dashboard_public; Owner: -
--

CREATE VIEW dashboard_public.price_reductions_source AS
 SELECT pc.article_id,
        CASE
            WHEN (l.url ~ '^https?://(www\.)?olx\.ba/artikal/[0-9]+/?$'::text) THEN l.url
            ELSE NULL::text
        END AS url,
    l.title,
    pc.category_memberships,
    pc.category,
    pc.deal,
    pc.sqm,
    pc.rooms,
    COALESCE(NULLIF(l.location, ''::text),
        CASE
            WHEN (l.latitude IS NULL) THEN '(no pin)'::text
            ELSE '(unmapped)'::text
        END) AS neighborhood,
    pc.prior_price,
    pc.price AS new_price,
    (- pc.delta) AS reduction_km,
    (- pc.pct_change) AS reduction_pct,
    pc.effective_at AS event_at,
    ((l.closed_at IS NULL) AND (l.last_seen > (now() - '14 days'::interval))) AS currently_observed,
    l.last_seen
   FROM (public.v_listing_price_changes_source pc
     JOIN public.listings l ON ((l.article_id = pc.article_id)))
  WHERE (pc.delta < (0)::numeric);

--
-- Name: VIEW price_reductions_source; Type: COMMENT; Schema: dashboard_public; Owner: -
--

COMMENT ON VIEW dashboard_public.price_reductions_source IS 'Resolved valid-to-valid asking-price reductions; historical events are retained separately from current availability.';

--
-- Name: v_listing_daily; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.v_listing_daily AS
 SELECT d.day,
    d.article_id,
    l.title,
    l.url,
    d.category,
    d.category_memberships,
    d.is_rent,
        CASE
            WHEN d.is_rent THEN 'rent'::text
            ELSE 'sale'::text
        END AS deal,
    d.rooms,
    d.sqm,
    d.location,
    d.neighborhood,
    d.price,
    d.price_state,
    d.ppm2,
    d.state_effective_at,
    d.price_effective_at,
    d.membership_inferred,
    d.attributes_inferred,
    d.stale_observation,
    d.provisional_day,
    d.filter_attributes
   FROM (public.listing_daily d
     JOIN public.listings l ON ((l.article_id = d.article_id)));

--
-- Name: v_listing_evidence_timeline; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.v_listing_evidence_timeline AS
 SELECT listing_price_events.article_id,
    listing_price_events.effective_at,
    listing_price_events.observed_at,
    listing_price_events.ingested_at,
    'price'::text AS evidence_kind,
    listing_price_events.price_state AS state,
    listing_price_events.price,
    listing_price_events.source,
    listing_price_events.provenance
   FROM public.listing_price_events
UNION ALL
 SELECT listing_state_history.article_id,
    listing_state_history.effective_at,
    NULL::timestamp with time zone AS observed_at,
    listing_state_history.ingested_at,
    'state'::text AS evidence_kind,
    listing_state_history.event_type AS state,
    listing_state_history.price,
    listing_state_history.source,
    listing_state_history.filter_attributes AS provenance
   FROM public.listing_state_history
UNION ALL
 SELECT listing_publication_evidence.article_id,
    listing_publication_evidence.published_at AS effective_at,
    listing_publication_evidence.observed_at,
    listing_publication_evidence.ingested_at,
    'publication'::text AS evidence_kind,
    listing_publication_evidence.evidence_kind AS state,
    NULL::numeric AS price,
    listing_publication_evidence.source,
    '{}'::jsonb AS provenance
   FROM public.listing_publication_evidence;

--
-- Name: VIEW v_listing_evidence_timeline; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON VIEW public.v_listing_evidence_timeline IS 'Normalized evidence timeline retained after raw response expiry; no synthetic prices or availability are added.';

--
-- Name: v_listing_exit_economics_source; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.v_listing_exit_economics_source AS
 SELECT l.article_id,
    fp.opening_price,
        CASE
            WHEN (COALESCE(fs.effective_at, l.first_seen) IS NULL) THEN NULL::integer
            ELSE GREATEST((round((EXTRACT(epoch FROM (COALESCE(
            CASE
                WHEN (ls.event_type = 'closed'::text) THEN ls.effective_at
                ELSE l.closed_at
            END, now()) - COALESCE(fs.effective_at, l.first_seen))) / 86400.0)))::integer, 0)
        END AS days_listed
   FROM (((public.listings l
     LEFT JOIN LATERAL ( SELECT h.effective_at
           FROM public.listing_state_history h
          WHERE ((h.article_id = l.article_id) AND (h.event_type = ANY (ARRAY['search_sighting'::text, 'reopened'::text])))
          ORDER BY h.effective_at, h.id
         LIMIT 1) fs ON (true))
     LEFT JOIN LATERAL ( SELECT h.event_type,
            h.effective_at
           FROM public.listing_state_history h
          WHERE ((h.article_id = l.article_id) AND (h.event_type = ANY (ARRAY['search_sighting'::text, 'closed'::text, 'reopened'::text])))
          ORDER BY h.effective_at DESC, h.id DESC
         LIMIT 1) ls ON (true))
     LEFT JOIN LATERAL ( SELECT e.price AS opening_price
           FROM public.listing_price_events e
          WHERE ((e.article_id = l.article_id) AND (e.price_state = 'valid'::text))
          ORDER BY e.effective_at, e.id
         LIMIT 1) fp ON (true));

--
-- Name: VIEW v_listing_exit_economics_source; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON VIEW public.v_listing_exit_economics_source IS 'Indexed per-listing subset of v_listing_lifecycle; preserves lifetime duration and first valid asking price, including legacy fallbacks.';

--
-- Name: v_listing_history_contract; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.v_listing_history_contract AS
 WITH first_observation AS (
         SELECT listing_state_history.article_id,
            min(listing_state_history.effective_at) AS first_observed_at
           FROM public.listing_state_history
          WHERE (listing_state_history.event_type = ANY (ARRAY['search_sighting'::text, 'detail_update'::text, 'reopened'::text]))
          GROUP BY listing_state_history.article_id
        ), first_price AS (
         SELECT listing_price_events.article_id,
            min(listing_price_events.effective_at) AS first_supported_price_at
           FROM public.listing_price_events
          WHERE ((listing_price_events.price_state = 'valid'::text) AND (listing_price_events.price IS NOT NULL))
          GROUP BY listing_price_events.article_id
        ), publication AS (
         SELECT listing_publication_evidence.article_id,
            min(listing_publication_evidence.published_at) AS publication_at
           FROM public.listing_publication_evidence
          GROUP BY listing_publication_evidence.article_id
        )
 SELECT l.article_id,
    COALESCE(p.publication_at, l.published_at) AS publication_at,
        CASE
            WHEN (COALESCE(p.publication_at, l.published_at) IS NULL) THEN 'unknown'::text
            ELSE 'known'::text
        END AS publication_status,
    f.first_observed_at,
    fp.first_supported_price_at,
        CASE
            WHEN (f.first_observed_at IS NULL) THEN 'unknown_before_observation'::text
            WHEN (COALESCE(p.publication_at, l.published_at) IS NULL) THEN 'unknown_publication'::text
            WHEN (COALESCE(p.publication_at, l.published_at) < f.first_observed_at) THEN 'unknown_before_first_observation'::text
            ELSE 'observed_from_publication'::text
        END AS pre_observation_status,
    l.first_seen,
    l.closed_at
   FROM (((public.listings l
     LEFT JOIN publication p USING (article_id))
     LEFT JOIN first_observation f USING (article_id))
     LEFT JOIN first_price fp USING (article_id));

--
-- Name: VIEW v_listing_history_contract; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON VIEW public.v_listing_history_contract IS 'Per-article publication, first observation, supported price boundary, and explicit pre-observation gap contract.';

--
-- Name: v_listing_lifecycle; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.v_listing_lifecycle AS
 WITH first_state AS (
         SELECT DISTINCT ON (listing_state_history.article_id) listing_state_history.id,
            listing_state_history.article_id,
            listing_state_history.effective_at,
            listing_state_history.ingested_at,
            listing_state_history.source,
            listing_state_history.event_type,
            listing_state_history.run_id,
            listing_state_history.search_key,
            listing_state_history.category,
            listing_state_history.category_membership,
            listing_state_history.is_rent,
            listing_state_history.sqm,
            listing_state_history.rooms,
            listing_state_history.price,
            listing_state_history.ppm2,
            listing_state_history.filter_attributes,
            listing_state_history.last_seen_at,
            listing_state_history.closed_at,
            listing_state_history.is_closed,
            listing_state_history.membership_inferred,
            listing_state_history.attributes_inferred
           FROM public.listing_state_history
          WHERE (listing_state_history.event_type = ANY (ARRAY['search_sighting'::text, 'reopened'::text]))
          ORDER BY listing_state_history.article_id, listing_state_history.effective_at, listing_state_history.id
        ), last_state AS (
         SELECT DISTINCT ON (listing_state_history.article_id) listing_state_history.article_id,
            listing_state_history.event_type,
            listing_state_history.effective_at
           FROM public.listing_state_history
          WHERE (listing_state_history.event_type = ANY (ARRAY['search_sighting'::text, 'closed'::text, 'reopened'::text]))
          ORDER BY listing_state_history.article_id, listing_state_history.effective_at DESC, listing_state_history.id DESC
        ), prices AS (
         SELECT e.article_id,
            min(e.effective_at) AS first_price_at,
            (array_agg(e.price ORDER BY e.effective_at, e.id))[1] AS opening_price,
            NULL::numeric AS opening_ppm2,
            max(e.effective_at) AS last_change_at,
            (array_agg(e.price ORDER BY e.effective_at DESC, e.id DESC))[1] AS last_history_price,
            NULL::numeric AS last_history_ppm2,
            (count(*))::integer AS n_changes,
            min(e.price) AS min_price,
            max(e.price) AS max_price
           FROM public.listing_price_events e
          WHERE (e.price_state = 'valid'::text)
          GROUP BY e.article_id
        )
 SELECT l.article_id,
    l.title,
    l.url,
    fs.sqm,
    fs.rooms,
    public.room_bucket(fs.rooms) AS room_bucket,
    fs.is_rent,
    COALESCE(fs.category, l.closing_category, ( SELECT ss.category
           FROM (public.search_results sr
             JOIN public.saved_searches ss USING (search_key))
          WHERE (sr.article_id = l.article_id)
          ORDER BY ss.created_at
         LIMIT 1)) AS category,
    fs.category_membership AS category_memberships,
    COALESCE(fs.effective_at, l.first_seen) AS opened_at,
    p.first_price_at,
    p.opening_price,
    p.opening_ppm2,
    p.last_change_at,
    p.last_history_price,
    p.last_history_ppm2,
    p.n_changes,
    p.min_price,
    p.max_price,
    l.price AS current_price,
    l.ppm2 AS current_ppm2,
        CASE
            WHEN (ls.event_type = 'closed'::text) THEN ls.effective_at
            ELSE NULL::timestamp with time zone
        END AS closed_at,
    l.closing_price,
    l.closing_ppm2,
    l.closing_category,
    COALESCE((ls.event_type = 'closed'::text), (l.closed_at IS NOT NULL), false) AS is_closed,
    ( SELECT (count(*))::integer AS count
           FROM public.listing_state_history r
          WHERE ((r.article_id = l.article_id) AND (r.event_type = 'reopened'::text))) AS reopen_count,
    l.published_at,
    l.renewed_at,
    COALESCE(fs.effective_at, l.first_seen) AS first_seen,
        CASE
            WHEN (COALESCE(fs.effective_at, l.first_seen) IS NULL) THEN NULL::integer
            ELSE GREATEST((round((EXTRACT(epoch FROM (COALESCE(
            CASE
                WHEN (ls.event_type = 'closed'::text) THEN ls.effective_at
                ELSE l.closed_at
            END, now()) - COALESCE(fs.effective_at, l.first_seen))) / 86400.0)))::integer, 0)
        END AS days_listed,
        CASE
            WHEN (l.renewed_at IS NOT NULL) THEN GREATEST((round((EXTRACT(epoch FROM (COALESCE(
            CASE
                WHEN (ls.event_type = 'closed'::text) THEN ls.effective_at
                ELSE NULL::timestamp with time zone
            END, now()) - l.renewed_at)) / 86400.0)))::integer, 0)
            ELSE NULL::integer
        END AS days_since_renewal
   FROM (((public.listings l
     LEFT JOIN first_state fs ON ((fs.article_id = l.article_id)))
     LEFT JOIN last_state ls ON ((ls.article_id = l.article_id)))
     LEFT JOIN prices p ON ((p.article_id = l.article_id)));

--
-- Name: v_market_daily_source; Type: VIEW; Schema: public; Owner: -
--

CREATE VIEW public.v_market_daily_source AS
 WITH bounds AS (
         SELECT min(listing_daily.day) AS first_day,
            ((now() AT TIME ZONE 'Europe/Sarajevo'::text))::date AS last_day
           FROM public.listing_daily
        ), grid AS (
         SELECT (s.d)::date AS day
           FROM (bounds b
             CROSS JOIN LATERAL generate_series((COALESCE(b.first_day, b.last_day))::timestamp with time zone, (b.last_day)::timestamp with time zone, '1 day'::interval) s(d))
        ), flows AS (
         SELECT events.day,
            (sum(events.new_n))::integer AS new_n,
            (sum(events.closed_n))::integer AS closed_n,
            (sum(events.reopened_n))::integer AS reopened_n
           FROM ( SELECT ((listing_state_history.effective_at AT TIME ZONE 'Europe/Sarajevo'::text))::date AS day,
                    0 AS new_n,
                    (count(*) FILTER (WHERE (listing_state_history.event_type = 'closed'::text)))::integer AS closed_n,
                    (count(*) FILTER (WHERE (listing_state_history.event_type = 'reopened'::text)))::integer AS reopened_n
                   FROM public.listing_state_history
                  WHERE (listing_state_history.event_type = ANY (ARRAY['closed'::text, 'reopened'::text]))
                  GROUP BY (((listing_state_history.effective_at AT TIME ZONE 'Europe/Sarajevo'::text))::date)
                UNION ALL
                 SELECT ((l.first_seen AT TIME ZONE 'Europe/Sarajevo'::text))::date AS timezone,
                    1,
                    0,
                    0
                   FROM public.listings l
                UNION ALL
                 SELECT ((l.closed_at AT TIME ZONE 'Europe/Sarajevo'::text))::date AS timezone,
                    0,
                    1,
                    0
                   FROM public.listings l
                  WHERE ((l.closed_at IS NOT NULL) AND (NOT (EXISTS ( SELECT 1
                           FROM public.listing_state_history h
                          WHERE ((h.article_id = l.article_id) AND (h.event_type = 'closed'::text) AND (h.effective_at = l.closed_at))))))) events
          GROUP BY events.day
        ), inventory_raw AS (
         SELECT listing_daily.day,
            (count(*))::integer AS active_est,
            (count(*) FILTER (WHERE listing_daily.stale_observation))::integer AS stale_n,
            bool_or(listing_daily.provisional_day) AS provisional_day
           FROM public.listing_daily
          GROUP BY listing_daily.day
        UNION ALL
         SELECT ((now() AT TIME ZONE 'Europe/Sarajevo'::text))::date AS timezone,
            (count(*))::integer AS count,
            0,
            true
           FROM public.listings l
          WHERE ((l.closed_at IS NULL) AND (NOT (EXISTS ( SELECT 1
                   FROM public.listing_state_history h
                  WHERE (h.article_id = l.article_id)))))
        ), inventory AS (
         SELECT inventory_raw.day,
            (sum(inventory_raw.active_est))::integer AS active_est,
            (sum(inventory_raw.stale_n))::integer AS stale_n,
            bool_or(inventory_raw.provisional_day) AS provisional_day
           FROM inventory_raw
          GROUP BY inventory_raw.day
        )
 SELECT g.day,
    COALESCE(f.new_n, 0) AS new_n,
    COALESCE(f.closed_n, 0) AS closed_n,
    COALESCE(f.reopened_n, 0) AS reopened_n,
    COALESCE(i.active_est, 0) AS active_est,
    COALESCE(i.stale_n, 0) AS stale_n,
    COALESCE(i.provisional_day, (g.day = ((now() AT TIME ZONE 'Europe/Sarajevo'::text))::date)) AS provisional_day
   FROM ((grid g
     LEFT JOIN flows f USING (day))
     LEFT JOIN inventory i USING (day))
  ORDER BY g.day;

--
-- Name: comparison_price_changes_source; Type: VIEW; Schema: reporting; Owner: -
--

CREATE VIEW reporting.comparison_price_changes_source AS
 WITH ordered AS (
         SELECT e_1.id,
            e_1.article_id,
            e_1.effective_at,
            e_1.ingested_at,
            e_1.price,
            e_1.price_state,
            e_1.source,
            e_1.provenance,
            e_1.observed_at,
            e_1.renewed_at,
            e_1.effective_at_basis,
            e_1.currency_normalized,
            e_1.evidence_is_rent,
            lag(e_1.price) OVER w AS prior_price,
            lag(e_1.price_state) OVER w AS prior_state,
            lag(e_1.currency_normalized) OVER w AS prior_currency,
            lag(e_1.evidence_is_rent) OVER w AS prior_is_rent,
            lag(e_1.effective_at) OVER w AS prior_effective_at
           FROM reporting.resolved_price_evidence e_1
          WINDOW w AS (PARTITION BY e_1.article_id ORDER BY e_1.effective_at, e_1.id)
        )
 SELECT e.article_id,
    e.effective_at,
    e.prior_effective_at,
    e.prior_price,
    e.price,
    (e.price - e.prior_price) AS delta,
    (((100)::numeric * (e.price - e.prior_price)) / e.prior_price) AS pct_change,
        CASE
            WHEN e.evidence_is_rent THEN 'rent'::text
            ELSE 'sale'::text
        END AS deal,
    e.currency_normalized AS currency
   FROM (ordered e
     JOIN reporting.current_comparison_inputs l USING (article_id))
  WHERE ((e.effective_at >= l.cycle_opened_at) AND (e.prior_effective_at >= l.cycle_opened_at) AND (e.evidence_is_rent = l.is_rent) AND (e.prior_is_rent = e.evidence_is_rent) AND (reporting.comparison_price_reason(e.price, e.price_state, e.currency_normalized, e.evidence_is_rent) IS NULL) AND (reporting.comparison_price_reason(e.prior_price, e.prior_state, e.prior_currency, e.prior_is_rent) IS NULL) AND (e.price <> e.prior_price) AND (NOT (EXISTS ( SELECT 1
           FROM public.listing_state_history h
          WHERE ((h.article_id = e.article_id) AND (h.effective_at > e.prior_effective_at) AND (h.effective_at <= e.effective_at) AND (h.is_rent IS NOT NULL) AND (h.is_rent <> e.evidence_is_rent))))));

--
-- Name: current_listing_scores_source; Type: VIEW; Schema: reporting; Owner: -
--

CREATE VIEW reporting.current_listing_scores_source AS
 WITH inputs AS MATERIALIZED (
         SELECT current_comparison_inputs.article_id,
            current_comparison_inputs.url,
            current_comparison_inputs.title,
            current_comparison_inputs.sqm,
            current_comparison_inputs.rooms,
            current_comparison_inputs.is_rent,
            current_comparison_inputs.deal,
            current_comparison_inputs.latitude,
            current_comparison_inputs.longitude,
            current_comparison_inputs.first_seen,
            current_comparison_inputs.last_seen,
            current_comparison_inputs.seller_type,
            current_comparison_inputs.condition,
            current_comparison_inputs.parking,
            current_comparison_inputs.garage,
            current_comparison_inputs.elevator,
            current_comparison_inputs.heating,
            current_comparison_inputs.floor_num,
            current_comparison_inputs.plot_sqm,
            current_comparison_inputs.year_built,
            current_comparison_inputs.bathrooms,
            current_comparison_inputs.rooms_detail,
            current_comparison_inputs.furnished,
            current_comparison_inputs.category_memberships,
            current_comparison_inputs.property_type,
            current_comparison_inputs.neighborhood,
            current_comparison_inputs.room_bucket,
            current_comparison_inputs.resolved_price,
            current_comparison_inputs.price_state,
            current_comparison_inputs.currency,
            current_comparison_inputs.price_effective_at,
            current_comparison_inputs.evidence_is_rent,
            current_comparison_inputs.cycle_opened_at,
            current_comparison_inputs.current_cycle_age_days,
            current_comparison_inputs.reopened,
            current_comparison_inputs.benchmark_at,
            current_comparison_inputs.score_version,
            current_comparison_inputs.price_reason,
            current_comparison_inputs.asking_price,
            current_comparison_inputs.asking_rate,
            current_comparison_inputs.score_input_reason
           FROM reporting.current_comparison_inputs
        ), changes AS MATERIALIZED (
         SELECT comparison_price_changes_source.article_id,
            comparison_price_changes_source.effective_at,
            comparison_price_changes_source.prior_effective_at,
            comparison_price_changes_source.prior_price,
            comparison_price_changes_source.price,
            comparison_price_changes_source.delta,
            comparison_price_changes_source.pct_change,
            comparison_price_changes_source.deal,
            comparison_price_changes_source.currency
           FROM reporting.comparison_price_changes_source
        ), cohorts AS (
         SELECT t.article_id,
            t.url,
            t.title,
            t.sqm,
            t.rooms,
            t.is_rent,
            t.deal,
            t.latitude,
            t.longitude,
            t.first_seen,
            t.last_seen,
            t.seller_type,
            t.condition,
            t.parking,
            t.garage,
            t.elevator,
            t.heating,
            t.floor_num,
            t.plot_sqm,
            t.year_built,
            t.bathrooms,
            t.rooms_detail,
            t.furnished,
            t.category_memberships,
            t.property_type,
            t.neighborhood,
            t.room_bucket,
            t.resolved_price,
            t.price_state,
            t.currency,
            t.price_effective_at,
            t.evidence_is_rent,
            t.cycle_opened_at,
            t.current_cycle_age_days,
            t.reopened,
            t.benchmark_at,
            t.score_version,
            t.price_reason,
            t.asking_price,
            t.asking_rate,
            t.score_input_reason,
            a.comparable_count,
                CASE
                    WHEN (a.comparable_count >= 5) THEN a.median
                    ELSE NULL::numeric
                END AS benchmark_rate,
                CASE
                    WHEN (a.comparable_count >= 5) THEN a.p25
                    ELSE NULL::numeric
                END AS benchmark_p25,
                CASE
                    WHEN (a.comparable_count >= 5) THEN a.p75
                    ELSE NULL::numeric
                END AS benchmark_p75
           FROM (inputs t
             LEFT JOIN LATERAL ( SELECT (count(*))::integer AS comparable_count,
                    (percentile_cont((0.5)::double precision) WITHIN GROUP (ORDER BY ((c.asking_rate)::double precision)))::numeric AS median,
                    (percentile_cont((0.25)::double precision) WITHIN GROUP (ORDER BY ((c.asking_rate)::double precision)))::numeric AS p25,
                    (percentile_cont((0.75)::double precision) WITHIN GROUP (ORDER BY ((c.asking_rate)::double precision)))::numeric AS p75
                   FROM inputs c
                  WHERE ((t.score_input_reason IS NULL) AND (c.score_input_reason IS NULL) AND (c.article_id <> t.article_id) AND (c.neighborhood = t.neighborhood) AND (c.property_type = t.property_type) AND (c.is_rent = t.is_rent) AND (c.room_bucket = t.room_bucket) AND ((c.sqm >= (t.sqm * 0.8)) AND (c.sqm <= (t.sqm * 1.2))) AND ((NOT t.is_rent) OR (c.furnished = t.furnished)))) a ON (true))
        ), deviations AS (
         SELECT c.article_id,
            c.url,
            c.title,
            c.sqm,
            c.rooms,
            c.is_rent,
            c.deal,
            c.latitude,
            c.longitude,
            c.first_seen,
            c.last_seen,
            c.seller_type,
            c.condition,
            c.parking,
            c.garage,
            c.elevator,
            c.heating,
            c.floor_num,
            c.plot_sqm,
            c.year_built,
            c.bathrooms,
            c.rooms_detail,
            c.furnished,
            c.category_memberships,
            c.property_type,
            c.neighborhood,
            c.room_bucket,
            c.resolved_price,
            c.price_state,
            c.currency,
            c.price_effective_at,
            c.evidence_is_rent,
            c.cycle_opened_at,
            c.current_cycle_age_days,
            c.reopened,
            c.benchmark_at,
            c.score_version,
            c.price_reason,
            c.asking_price,
            c.asking_rate,
            c.score_input_reason,
            c.comparable_count,
            c.benchmark_rate,
            c.benchmark_p25,
            c.benchmark_p75,
            ((100)::numeric * ((c.asking_rate / c.benchmark_rate) - (1)::numeric)) AS deviation_pct,
            COALESCE(c.score_input_reason,
                CASE
                    WHEN (c.comparable_count < 5) THEN 'Insufficient comparables'::text
                    ELSE NULL::text
                END) AS unscored_reason,
                CASE
                    WHEN (c.comparable_count >= 20) THEN 'Larger sample'::text
                    WHEN (c.comparable_count >= 10) THEN 'Limited sample'::text
                    WHEN (c.comparable_count >= 5) THEN 'Higher variance sample'::text
                    ELSE 'Insufficient comparables'::text
                END AS confidence
           FROM cohorts c
        )
 SELECT d.article_id,
    d.url,
    d.title,
    d.sqm,
    d.rooms,
    d.is_rent,
    d.deal,
    d.latitude,
    d.longitude,
    d.first_seen,
    d.last_seen,
    d.seller_type,
    d.condition,
    d.parking,
    d.garage,
    d.elevator,
    d.heating,
    d.floor_num,
    d.plot_sqm,
    d.year_built,
    d.bathrooms,
    d.rooms_detail,
    d.furnished,
    d.category_memberships,
    d.property_type,
    d.neighborhood,
    d.room_bucket,
    d.resolved_price,
    d.price_state,
    d.currency,
    d.price_effective_at,
    d.evidence_is_rent,
    d.cycle_opened_at,
    d.current_cycle_age_days,
    d.reopened,
    d.benchmark_at,
    d.score_version,
    d.price_reason,
    d.asking_price,
    d.asking_rate,
    d.score_input_reason,
    d.comparable_count,
    d.benchmark_rate,
    d.benchmark_p25,
    d.benchmark_p75,
    d.deviation_pct,
    d.unscored_reason,
    d.confidence,
        CASE
            WHEN (d.deviation_pct IS NOT NULL) THEN (round(GREATEST((0)::numeric, LEAST((100)::numeric, ((50)::numeric - d.deviation_pct)))))::integer
            ELSE NULL::integer
        END AS score,
        CASE
            WHEN (d.deviation_pct < ('-10'::integer)::numeric) THEN 'Well below local asking benchmark'::text
            WHEN (d.deviation_pct < ('-5'::integer)::numeric) THEN 'Below local asking benchmark'::text
            WHEN (d.deviation_pct <= (5)::numeric) THEN 'Near local asking benchmark'::text
            WHEN (d.deviation_pct <= (10)::numeric) THEN 'Above local asking benchmark'::text
            WHEN (d.deviation_pct > (10)::numeric) THEN 'Well above local asking benchmark'::text
            ELSE NULL::text
        END AS position_label,
    (d.benchmark_rate * d.sqm) AS indicative_total,
    (d.benchmark_p25 * d.sqm) AS indicative_low,
    (d.benchmark_p75 * d.sqm) AS indicative_high,
    (d.asking_price - (d.benchmark_rate * d.sqm)) AS asking_gap_km,
    reduction.effective_at AS latest_reduction_at,
    (- reduction.delta) AS reduction_km,
    (- reduction.pct_change) AS reduction_pct
   FROM (deviations d
     LEFT JOIN LATERAL ( SELECT pc.article_id,
            pc.effective_at,
            pc.prior_effective_at,
            pc.prior_price,
            pc.price,
            pc.delta,
            pc.pct_change,
            pc.deal,
            pc.currency
           FROM changes pc
          WHERE ((pc.article_id = d.article_id) AND (pc.delta < (0)::numeric) AND (pc.price = d.asking_price) AND (NOT (EXISTS ( SELECT 1
                   FROM reporting.resolved_price_evidence e
                  WHERE ((e.article_id = d.article_id) AND (e.effective_at > pc.effective_at) AND ((e.price_state <> 'valid'::text) OR (e.price IS DISTINCT FROM pc.price) OR (e.currency_normalized IS DISTINCT FROM 'BAM'::text) OR (e.evidence_is_rent IS DISTINCT FROM d.is_rent)))))) AND (NOT (EXISTS ( SELECT 1
                   FROM public.listing_state_history h
                  WHERE ((h.article_id = d.article_id) AND (h.effective_at > pc.effective_at) AND (h.effective_at <= now()) AND (h.is_rent IS NOT NULL) AND (h.is_rent <> d.is_rent))))))
          ORDER BY pc.effective_at DESC
         LIMIT 1) reduction ON (true));

--
-- Name: VIEW current_listing_scores_source; Type: COMMENT; Schema: reporting; Owner: -
--

COMMENT ON VIEW reporting.current_listing_scores_source IS 'Canonical exact-local OLTP-to-OLAP transformation used as the input to the sparse-cohort fallback.';

CREATE FUNCTION reporting.nearest_neighborhoods(p_name text, p_limit integer DEFAULT 3)
RETURNS TABLE(neighborhood text, neighbor_rank integer)
LANGUAGE sql STABLE STRICT
AS $$
  WITH subject AS (
    SELECT avg(n.poly[i]) AS longitude, avg(n.poly[i + 1]) AS latitude
      FROM public.neighborhoods n
      CROSS JOIN LATERAL generate_series(1, array_length(n.poly, 1), 2) i
     WHERE n.name = p_name
  )
  SELECT n.name,
         row_number() OVER (
           ORDER BY public.polygon_distance_m(s.latitude, s.longitude, n.poly), n.name
         )::integer
    FROM subject s
    CROSS JOIN public.neighborhoods n
   WHERE n.name <> p_name AND p_limit > 0
   ORDER BY public.polygon_distance_m(s.latitude, s.longitude, n.poly), n.name
   LIMIT p_limit
$$;

ALTER VIEW reporting.current_listing_scores_source
  RENAME TO current_listing_scores_local_source;

CREATE VIEW reporting.current_listing_scores_source AS
WITH local AS MATERIALIZED (
  SELECT * FROM reporting.current_listing_scores_local_source
), nearest AS MATERIALIZED (
  SELECT x.name AS subject_neighborhood, n.neighborhood
    FROM public.neighborhoods x
    CROSS JOIN LATERAL reporting.nearest_neighborhoods(x.name, 3) n
), fallback AS MATERIALIZED (
  SELECT t.article_id,
         count(c.article_id)::integer AS comparable_count,
         percentile_cont(0.5) WITHIN GROUP (ORDER BY c.asking_rate)::numeric AS median,
         percentile_cont(0.25) WITHIN GROUP (ORDER BY c.asking_rate)::numeric AS p25,
         percentile_cont(0.75) WITHIN GROUP (ORDER BY c.asking_rate)::numeric AS p75,
         array_agg(DISTINCT c.neighborhood ORDER BY c.neighborhood)
           FILTER (WHERE c.neighborhood <> t.neighborhood) AS neighborhoods
    FROM local t
    JOIN local c
      ON c.score_input_reason IS NULL
     AND c.article_id <> t.article_id
     AND c.property_type = t.property_type
     AND c.is_rent = t.is_rent
     AND c.room_bucket = t.room_bucket
     AND c.sqm BETWEEN t.sqm * 0.8 AND t.sqm * 1.2
     AND (NOT t.is_rent OR c.furnished = t.furnished)
     AND (
       c.neighborhood = t.neighborhood
       OR EXISTS (
         SELECT 1 FROM nearest n
          WHERE n.subject_neighborhood = t.neighborhood
            AND n.neighborhood = c.neighborhood
       )
     )
   WHERE t.score_input_reason IS NULL AND t.comparable_count < 5
   GROUP BY t.article_id
), effective AS (
  SELECT t.*,
         COALESCE(f.comparable_count, t.comparable_count) AS effective_count,
         CASE WHEN f.comparable_count >= 5 THEN f.median ELSE t.benchmark_rate END AS effective_median,
         CASE WHEN f.comparable_count >= 5 THEN f.p25 ELSE t.benchmark_p25 END AS effective_p25,
         CASE WHEN f.comparable_count >= 5 THEN f.p75 ELSE t.benchmark_p75 END AS effective_p75,
         COALESCE(f.comparable_count >= 5, false) AS uses_fallback,
         f.neighborhoods AS fallback_neighborhoods
    FROM local t
    LEFT JOIN fallback f USING (article_id)
), derived AS (
  SELECT e.*,
         CASE WHEN e.effective_median IS NOT NULL
              THEN 100 * (e.asking_rate / e.effective_median - 1) END AS effective_deviation
    FROM effective e
)
SELECT expanded.*
FROM derived d
CROSS JOIN LATERAL jsonb_populate_record(
  NULL::olap.current_listing_scores,
  to_jsonb(d) || jsonb_build_object(
    'comparable_count', d.effective_count,
    'benchmark_rate', d.effective_median,
    'benchmark_p25', d.effective_p25,
    'benchmark_p75', d.effective_p75,
    'deviation_pct', d.effective_deviation,
    'unscored_reason', COALESCE(
      d.score_input_reason,
      CASE WHEN d.effective_count < 5 THEN 'Insufficient comparables' END
    ),
    'confidence', CASE
      WHEN d.uses_fallback THEN 'Nearby-area fallback · Higher variance'
      WHEN d.effective_count >= 20 THEN 'Larger sample'
      WHEN d.effective_count >= 10 THEN 'Limited sample'
      WHEN d.effective_count >= 5 THEN 'Higher variance sample'
      ELSE 'Insufficient comparables'
    END,
    'score', CASE WHEN d.effective_deviation IS NOT NULL THEN
      round(greatest(0, least(100, 50 - d.effective_deviation)))::integer END,
    'position_label', CASE
      WHEN d.effective_deviation < -10 THEN 'Well below local asking benchmark'
      WHEN d.effective_deviation < -5 THEN 'Below local asking benchmark'
      WHEN d.effective_deviation <= 5 THEN 'Near local asking benchmark'
      WHEN d.effective_deviation <= 10 THEN 'Above local asking benchmark'
      WHEN d.effective_deviation > 10 THEN 'Well above local asking benchmark'
    END,
    'indicative_total', d.effective_median * d.sqm,
    'indicative_low', d.effective_p25 * d.sqm,
    'indicative_high', d.effective_p75 * d.sqm,
    'asking_gap_km', d.asking_price - d.effective_median * d.sqm,
    'local_comparable_count', d.comparable_count,
    'benchmark_scope', CASE
      WHEN d.score_input_reason IS NOT NULL THEN NULL
      WHEN d.uses_fallback THEN 'nearest_3_neighborhoods'
      WHEN d.effective_count >= 5 THEN 'local'
    END,
    'benchmark_neighborhoods', CASE
      WHEN d.uses_fallback THEN d.fallback_neighborhoods
      WHEN d.effective_count >= 5 THEN ARRAY[d.neighborhood]
    END
  )
) expanded;

COMMENT ON VIEW reporting.current_listing_scores_source IS 'Canonical current score source. Exact local inputs and the neighbourhood proximity map are materialized once; cohorts below five comparables may expand to the three nearest neighbourhood polygons.';

--
-- Name: daily_listing_facts_source; Type: VIEW; Schema: reporting; Owner: -
--

CREATE VIEW reporting.daily_listing_facts_source AS
 WITH evidence AS (
         SELECT d.day,
            d.article_id,
            d.title,
            d.url,
            d.category,
            d.category_memberships,
            d.is_rent,
            d.deal,
            d.rooms,
            d.sqm,
            d.location,
            d.neighborhood,
            d.price,
            d.price_state,
            d.ppm2,
            d.state_effective_at,
            d.price_effective_at,
            d.membership_inferred,
            d.attributes_inferred,
            d.stale_observation,
            d.provisional_day,
            d.filter_attributes,
            p.currency_normalized AS currency,
            p.evidence_is_rent,
            ARRAY( SELECT DISTINCT members.member
                   FROM unnest((COALESCE(d.category_memberships, '{}'::text[]) ||
                        CASE
                            WHEN (NULLIF(btrim(d.category), ''::text) IS NULL) THEN '{}'::text[]
                            ELSE ARRAY[d.category]
                        END)) members(member)
                  WHERE ((members.member IS NOT NULL) AND (members.member <> ''::text))
                  ORDER BY members.member) AS resolved_category_memberships,
            reporting.comparison_property_type(ARRAY( SELECT DISTINCT members.member
                   FROM unnest((COALESCE(d.category_memberships, '{}'::text[]) ||
                        CASE
                            WHEN (NULLIF(btrim(d.category), ''::text) IS NULL) THEN '{}'::text[]
                            ELSE ARRAY[d.category]
                        END)) members(member)
                  WHERE ((members.member IS NOT NULL) AND (members.member <> ''::text))
                  ORDER BY members.member)) AS property_type
           FROM (public.v_listing_daily d
             LEFT JOIN reporting.resolved_price_evidence p ON (((p.article_id = d.article_id) AND (p.effective_at = d.price_effective_at))))
        ), quality AS (
         SELECT e.day,
            e.article_id,
            e.title,
            e.url,
            e.category,
            e.category_memberships,
            e.is_rent,
            e.deal,
            e.rooms,
            e.sqm,
            e.location,
            e.neighborhood,
            e.price,
            e.price_state,
            e.ppm2,
            e.state_effective_at,
            e.price_effective_at,
            e.membership_inferred,
            e.attributes_inferred,
            e.stale_observation,
            e.provisional_day,
            e.filter_attributes,
            e.currency,
            e.evidence_is_rent,
            e.resolved_category_memberships,
            e.property_type,
                CASE
                    WHEN ((e.price_effective_at IS NOT NULL) AND (e.evidence_is_rent IS DISTINCT FROM e.is_rent)) THEN 'price evidence belongs to another deal'::text
                    WHEN ((e.price_effective_at IS NOT NULL) AND (EXISTS ( SELECT 1
                       FROM public.listing_state_history h
                      WHERE ((h.article_id = e.article_id) AND (h.effective_at > e.price_effective_at) AND (h.effective_at < public.analytics_sarajevo_day_start((e.day + 1))) AND (h.is_rent IS NOT NULL) AND (h.is_rent IS DISTINCT FROM e.evidence_is_rent))))) THEN 'price evidence predates a deal switch'::text
                    ELSE reporting.comparison_price_reason(e.price, e.price_state, e.currency, e.is_rent)
                END AS price_quality_reason,
                CASE
                    WHEN ((e.price_effective_at IS NOT NULL) AND (e.evidence_is_rent IS DISTINCT FROM e.is_rent)) THEN 'price evidence belongs to another deal'::text
                    WHEN ((e.price_effective_at IS NOT NULL) AND (EXISTS ( SELECT 1
                       FROM public.listing_state_history h
                      WHERE ((h.article_id = e.article_id) AND (h.effective_at > e.price_effective_at) AND (h.effective_at < public.analytics_sarajevo_day_start((e.day + 1))) AND (h.is_rent IS NOT NULL) AND (h.is_rent IS DISTINCT FROM e.evidence_is_rent))))) THEN 'price evidence predates a deal switch'::text
                    ELSE reporting.comparison_quality_reason(e.price, e.price_state, e.currency, e.sqm, e.is_rent)
                END AS rate_quality_reason
           FROM evidence e
        )
 SELECT day,
    article_id,
    title,
    url,
    category,
    resolved_category_memberships AS category_memberships,
    is_rent,
        CASE
            WHEN (is_rent IS TRUE) THEN 'rent'::text
            WHEN (is_rent IS FALSE) THEN 'sale'::text
            ELSE 'unknown'::text
        END AS deal,
    rooms,
    sqm,
    location,
    neighborhood,
    price,
    price_state,
    ppm2,
    state_effective_at,
    price_effective_at,
    membership_inferred,
    attributes_inferred,
    stale_observation,
    provisional_day,
    filter_attributes,
    property_type,
    public.room_bucket(rooms) AS room_bucket,
    currency,
    filter_attributes AS historical_attributes,
    NULLIF(COALESCE((filter_attributes ->> 'sellerType'::text), ((filter_attributes -> 'searchAttributes'::text) ->> 'sellerType'::text)), ''::text) AS historical_seller_type,
    NULLIF(COALESCE((filter_attributes ->> 'condition'::text), ((filter_attributes -> 'searchAttributes'::text) ->> 'condition'::text)), ''::text) AS historical_condition,
        CASE lower(COALESCE((filter_attributes ->> 'furnished'::text), ((filter_attributes -> 'searchAttributes'::text) ->> 'furnished'::text), ''::text))
            WHEN 'true'::text THEN true
            WHEN 't'::text THEN true
            WHEN 'yes'::text THEN true
            WHEN '1'::text THEN true
            WHEN 'false'::text THEN false
            WHEN 'f'::text THEN false
            WHEN 'no'::text THEN false
            WHEN '0'::text THEN false
            ELSE NULL::boolean
        END AS historical_furnished,
    NULLIF(COALESCE((filter_attributes ->> 'heating'::text), ((filter_attributes -> 'searchAttributes'::text) ->> 'heating'::text)), ''::text) AS historical_heating,
        CASE lower(COALESCE((filter_attributes ->> 'parking'::text), ((filter_attributes -> 'searchAttributes'::text) ->> 'parking'::text), ''::text))
            WHEN 'true'::text THEN true
            WHEN 't'::text THEN true
            WHEN 'yes'::text THEN true
            WHEN '1'::text THEN true
            WHEN 'false'::text THEN false
            WHEN 'f'::text THEN false
            WHEN 'no'::text THEN false
            WHEN '0'::text THEN false
            ELSE NULL::boolean
        END AS historical_parking,
        CASE lower(COALESCE((filter_attributes ->> 'garage'::text), ((filter_attributes -> 'searchAttributes'::text) ->> 'garage'::text), ''::text))
            WHEN 'true'::text THEN true
            WHEN 't'::text THEN true
            WHEN 'yes'::text THEN true
            WHEN '1'::text THEN true
            WHEN 'false'::text THEN false
            WHEN 'f'::text THEN false
            WHEN 'no'::text THEN false
            WHEN '0'::text THEN false
            ELSE NULL::boolean
        END AS historical_garage,
        CASE lower(COALESCE((filter_attributes ->> 'elevator'::text), ((filter_attributes -> 'searchAttributes'::text) ->> 'elevator'::text), ''::text))
            WHEN 'true'::text THEN true
            WHEN 't'::text THEN true
            WHEN 'yes'::text THEN true
            WHEN '1'::text THEN true
            WHEN 'false'::text THEN false
            WHEN 'f'::text THEN false
            WHEN 'no'::text THEN false
            WHEN '0'::text THEN false
            ELSE NULL::boolean
        END AS historical_elevator,
        CASE
            WHEN ((COALESCE((filter_attributes ->> 'floorNum'::text), ((filter_attributes -> 'searchAttributes'::text) ->> 'floorNum'::text)) ~ '^-?[0-9]{1,5}$'::text) AND (((COALESCE((filter_attributes ->> 'floorNum'::text), ((filter_attributes -> 'searchAttributes'::text) ->> 'floorNum'::text)))::numeric >= ('-32768'::integer)::numeric) AND ((COALESCE((filter_attributes ->> 'floorNum'::text), ((filter_attributes -> 'searchAttributes'::text) ->> 'floorNum'::text)))::numeric <= (32767)::numeric))) THEN (COALESCE((filter_attributes ->> 'floorNum'::text), ((filter_attributes -> 'searchAttributes'::text) ->> 'floorNum'::text)))::smallint
            ELSE NULL::smallint
        END AS historical_floor_num,
    price_quality_reason,
    rate_quality_reason,
    (price_quality_reason IS NULL) AS price_eligible,
    (rate_quality_reason IS NULL) AS rate_eligible,
        CASE
            WHEN (price_quality_reason IS NULL) THEN price
            ELSE NULL::numeric
        END AS asking_price,
        CASE
            WHEN (rate_quality_reason IS NULL) THEN (price / NULLIF(sqm, (0)::numeric))
            ELSE NULL::numeric
        END AS asking_rate,
        CASE
            WHEN (is_rent IS TRUE) THEN 'KM/month'::text
            WHEN (is_rent IS FALSE) THEN 'KM'::text
            ELSE NULL::text
        END AS asking_price_unit,
        CASE
            WHEN (is_rent IS TRUE) THEN 'KM/m²/month'::text
            WHEN (is_rent IS FALSE) THEN 'KM/m²'::text
            ELSE NULL::text
        END AS asking_rate_unit
   FROM quality q;

--
-- Name: VIEW daily_listing_facts_source; Type: COMMENT; Schema: reporting; Owner: -
--

COMMENT ON VIEW reporting.daily_listing_facts_source IS 'One reconstructed Sarajevo listing-day per article. asking_price and asking_rate are separately eligible historical samples; historical_attributes and quality flags are recorded/inferred at that day, never copied from the current listing.';

--
-- Name: lifecycle_cycles_source; Type: VIEW; Schema: reporting; Owner: -
--

CREATE VIEW reporting.lifecycle_cycles_source AS
 WITH cycle_states AS (
         SELECT c.article_id,
            c.cycle_no,
            c.opened_at,
            c.closed_at,
            c.is_closed,
            c.days_listed AS observed_cycle_duration_days,
            od.category AS opening_direct_category,
            od.category_membership AS opening_direct_memberships,
            od.is_rent AS opening_direct_is_rent,
            od.sqm AS opening_direct_sqm,
            od.rooms AS opening_direct_rooms,
            od.filter_attributes AS opening_direct_attributes,
            od.membership_inferred AS opening_direct_membership_inferred,
            od.attributes_inferred AS opening_direct_attributes_inferred,
            os.category AS opening_history_category,
            os.memberships AS opening_history_memberships,
            os.is_rent AS opening_history_is_rent,
            os.sqm AS opening_history_sqm,
            os.rooms AS opening_history_rooms,
            os.attributes AS opening_history_attributes,
            cd.category AS closing_direct_category,
            cd.category_membership AS closing_direct_memberships,
            cd.is_rent AS closing_direct_is_rent,
            cd.sqm AS closing_direct_sqm,
            cd.rooms AS closing_direct_rooms,
            cd.filter_attributes AS closing_direct_attributes,
            cd.membership_inferred AS closing_direct_membership_inferred,
            cd.attributes_inferred AS closing_direct_attributes_inferred,
            cs.category AS closing_history_category,
            cs.memberships AS closing_history_memberships,
            cs.is_rent AS closing_history_is_rent,
            cs.sqm AS closing_history_sqm,
            cs.rooms AS closing_history_rooms,
            cs.attributes AS closing_history_attributes
           FROM ((((public.v_listing_lifecycle_cycles c
             LEFT JOIN LATERAL ( SELECT h.id,
                    h.article_id,
                    h.effective_at,
                    h.ingested_at,
                    h.source,
                    h.event_type,
                    h.run_id,
                    h.search_key,
                    h.category,
                    h.category_membership,
                    h.is_rent,
                    h.sqm,
                    h.rooms,
                    h.price,
                    h.ppm2,
                    h.filter_attributes,
                    h.last_seen_at,
                    h.closed_at,
                    h.is_closed,
                    h.membership_inferred,
                    h.attributes_inferred
                   FROM public.listing_state_history h
                  WHERE ((h.article_id = c.article_id) AND (h.effective_at = c.opened_at) AND (h.event_type = ANY (ARRAY['search_sighting'::text, 'reopened'::text])))
                  ORDER BY h.id DESC
                 LIMIT 1) od ON (true))
             LEFT JOIN LATERAL ( SELECT fields.category,
                    fields.is_rent,
                    fields.sqm,
                    fields.rooms,
                    memberships.memberships,
                    attributes.attributes
                   FROM ((LATERAL ( SELECT (array_agg(h.category ORDER BY h.effective_at DESC, h.id DESC) FILTER (WHERE (NULLIF(btrim(h.category), ''::text) IS NOT NULL)))[1] AS category,
                            (array_agg(h.is_rent ORDER BY h.effective_at DESC, h.id DESC) FILTER (WHERE (h.is_rent IS NOT NULL)))[1] AS is_rent,
                            (array_agg(h.sqm ORDER BY h.effective_at DESC, h.id DESC) FILTER (WHERE (h.sqm IS NOT NULL)))[1] AS sqm,
                            (array_agg(h.rooms ORDER BY h.effective_at DESC, h.id DESC) FILTER (WHERE (h.rooms IS NOT NULL)))[1] AS rooms
                           FROM public.listing_state_history h
                          WHERE ((h.article_id = c.article_id) AND (h.effective_at <= c.opened_at) AND (h.event_type = ANY (ARRAY['search_sighting'::text, 'detail_update'::text, 'reopened'::text])))) fields
                     CROSS JOIN LATERAL ( SELECT COALESCE(array_agg(DISTINCT members.member ORDER BY members.member), '{}'::text[]) AS memberships
                           FROM (public.listing_state_history h
                             CROSS JOIN LATERAL unnest(h.category_membership) members(member))
                          WHERE ((h.article_id = c.article_id) AND (h.effective_at <= c.opened_at) AND (h.event_type = ANY (ARRAY['search_sighting'::text, 'detail_update'::text, 'reopened'::text])) AND (members.member IS NOT NULL) AND (members.member <> ''::text))) memberships)
                     CROSS JOIN LATERAL ( SELECT COALESCE(jsonb_object_agg(a.key, a.value), '{}'::jsonb) AS attributes
                           FROM ( SELECT DISTINCT ON (attrs.key) attrs.key,
                                    attrs.value
                                   FROM (public.listing_state_history h
                                     CROSS JOIN LATERAL jsonb_each(
CASE
 WHEN (jsonb_typeof(h.filter_attributes) = 'object'::text) THEN h.filter_attributes
 ELSE '{}'::jsonb
END) attrs(key, value))
                                  WHERE ((h.article_id = c.article_id) AND (h.effective_at <= c.opened_at) AND (h.event_type = ANY (ARRAY['search_sighting'::text, 'detail_update'::text, 'reopened'::text])))
                                  ORDER BY attrs.key, h.effective_at DESC, h.id DESC) a) attributes)) os ON (true))
             LEFT JOIN LATERAL ( SELECT h.id,
                    h.article_id,
                    h.effective_at,
                    h.ingested_at,
                    h.source,
                    h.event_type,
                    h.run_id,
                    h.search_key,
                    h.category,
                    h.category_membership,
                    h.is_rent,
                    h.sqm,
                    h.rooms,
                    h.price,
                    h.ppm2,
                    h.filter_attributes,
                    h.last_seen_at,
                    h.closed_at,
                    h.is_closed,
                    h.membership_inferred,
                    h.attributes_inferred
                   FROM public.listing_state_history h
                  WHERE ((h.article_id = c.article_id) AND (h.effective_at = c.closed_at) AND (h.event_type = 'closed'::text))
                  ORDER BY h.id DESC
                 LIMIT 1) cd ON (true))
             LEFT JOIN LATERAL ( SELECT fields.category,
                    fields.is_rent,
                    fields.sqm,
                    fields.rooms,
                    memberships.memberships,
                    attributes.attributes
                   FROM ((LATERAL ( SELECT (array_agg(h.category ORDER BY h.effective_at DESC, h.id DESC) FILTER (WHERE (NULLIF(btrim(h.category), ''::text) IS NOT NULL)))[1] AS category,
                            (array_agg(h.is_rent ORDER BY h.effective_at DESC, h.id DESC) FILTER (WHERE (h.is_rent IS NOT NULL)))[1] AS is_rent,
                            (array_agg(h.sqm ORDER BY h.effective_at DESC, h.id DESC) FILTER (WHERE (h.sqm IS NOT NULL)))[1] AS sqm,
                            (array_agg(h.rooms ORDER BY h.effective_at DESC, h.id DESC) FILTER (WHERE (h.rooms IS NOT NULL)))[1] AS rooms
                           FROM public.listing_state_history h
                          WHERE ((h.article_id = c.article_id) AND (h.effective_at < c.closed_at) AND (h.event_type = ANY (ARRAY['search_sighting'::text, 'detail_update'::text, 'reopened'::text])))) fields
                     CROSS JOIN LATERAL ( SELECT COALESCE(array_agg(DISTINCT members.member ORDER BY members.member), '{}'::text[]) AS memberships
                           FROM (public.listing_state_history h
                             CROSS JOIN LATERAL unnest(h.category_membership) members(member))
                          WHERE ((h.article_id = c.article_id) AND (h.effective_at < c.closed_at) AND (h.event_type = ANY (ARRAY['search_sighting'::text, 'detail_update'::text, 'reopened'::text])) AND (members.member IS NOT NULL) AND (members.member <> ''::text))) memberships)
                     CROSS JOIN LATERAL ( SELECT COALESCE(jsonb_object_agg(a.key, a.value), '{}'::jsonb) AS attributes
                           FROM ( SELECT DISTINCT ON (attrs.key) attrs.key,
                                    attrs.value
                                   FROM (public.listing_state_history h
                                     CROSS JOIN LATERAL jsonb_each(
CASE
 WHEN (jsonb_typeof(h.filter_attributes) = 'object'::text) THEN h.filter_attributes
 ELSE '{}'::jsonb
END) attrs(key, value))
                                  WHERE ((h.article_id = c.article_id) AND (h.effective_at < c.closed_at) AND (h.event_type = ANY (ARRAY['search_sighting'::text, 'detail_update'::text, 'reopened'::text])))
                                  ORDER BY attrs.key, h.effective_at DESC, h.id DESC) a) attributes)) cs ON (true))
        ), frozen_states AS (
         SELECT s.article_id,
            s.cycle_no,
            s.opened_at,
            s.closed_at,
            s.is_closed,
            s.observed_cycle_duration_days,
            s.opening_direct_category,
            s.opening_direct_memberships,
            s.opening_direct_is_rent,
            s.opening_direct_sqm,
            s.opening_direct_rooms,
            s.opening_direct_attributes,
            s.opening_direct_membership_inferred,
            s.opening_direct_attributes_inferred,
            s.opening_history_category,
            s.opening_history_memberships,
            s.opening_history_is_rent,
            s.opening_history_sqm,
            s.opening_history_rooms,
            s.opening_history_attributes,
            s.closing_direct_category,
            s.closing_direct_memberships,
            s.closing_direct_is_rent,
            s.closing_direct_sqm,
            s.closing_direct_rooms,
            s.closing_direct_attributes,
            s.closing_direct_membership_inferred,
            s.closing_direct_attributes_inferred,
            s.closing_history_category,
            s.closing_history_memberships,
            s.closing_history_is_rent,
            s.closing_history_sqm,
            s.closing_history_rooms,
            s.closing_history_attributes,
            COALESCE(s.opening_direct_category, s.opening_history_category) AS opening_category,
            ARRAY( SELECT DISTINCT members.member
                   FROM unnest(((COALESCE(s.opening_history_memberships, '{}'::text[]) || COALESCE(s.opening_direct_memberships, '{}'::text[])) ||
                        CASE
                            WHEN (COALESCE(s.opening_direct_category, s.opening_history_category) IS NULL) THEN '{}'::text[]
                            ELSE ARRAY[COALESCE(s.opening_direct_category, s.opening_history_category)]
                        END)) members(member)
                  WHERE ((members.member IS NOT NULL) AND (members.member <> ''::text))
                  ORDER BY members.member) AS opening_category_memberships,
            COALESCE(s.opening_direct_is_rent, s.opening_history_is_rent) AS opening_is_rent,
            COALESCE(s.opening_direct_sqm, s.opening_history_sqm) AS opening_sqm,
            COALESCE(s.opening_direct_rooms, s.opening_history_rooms) AS opening_rooms,
            (COALESCE(s.opening_history_attributes, '{}'::jsonb) || COALESCE(s.opening_direct_attributes, '{}'::jsonb)) AS opening_attributes,
            (COALESCE(s.opening_direct_membership_inferred, false) OR (EXISTS ( SELECT 1
                   FROM unnest(COALESCE(s.opening_history_memberships, '{}'::text[])) m(member)
                  WHERE (NOT (m.member = ANY (COALESCE(s.opening_direct_memberships, '{}'::text[]))))))) AS opening_membership_inferred,
            (COALESCE(s.opening_direct_attributes_inferred, false) OR ((s.opening_direct_category IS NULL) AND (s.opening_history_category IS NOT NULL)) OR ((s.opening_direct_is_rent IS NULL) AND (s.opening_history_is_rent IS NOT NULL)) OR ((s.opening_direct_sqm IS NULL) AND (s.opening_history_sqm IS NOT NULL)) OR ((s.opening_direct_rooms IS NULL) AND (s.opening_history_rooms IS NOT NULL)) OR (EXISTS ( SELECT 1
                   FROM jsonb_object_keys(COALESCE(s.opening_history_attributes, '{}'::jsonb)) a(key)
                  WHERE (NOT (COALESCE(s.opening_direct_attributes, '{}'::jsonb) ? a.key))))) AS opening_attributes_inferred,
            public.analytics_state_neighborhood((COALESCE(s.opening_history_attributes, '{}'::jsonb) || COALESCE(s.opening_direct_attributes, '{}'::jsonb))) AS opening_neighborhood,
            COALESCE(s.closing_direct_category, s.closing_history_category) AS closing_category,
            ARRAY( SELECT DISTINCT members.member
                   FROM unnest(((COALESCE(s.closing_history_memberships, '{}'::text[]) || COALESCE(s.closing_direct_memberships, '{}'::text[])) ||
                        CASE
                            WHEN (COALESCE(s.closing_direct_category, s.closing_history_category) IS NULL) THEN '{}'::text[]
                            ELSE ARRAY[COALESCE(s.closing_direct_category, s.closing_history_category)]
                        END)) members(member)
                  WHERE ((members.member IS NOT NULL) AND (members.member <> ''::text))
                  ORDER BY members.member) AS closing_category_memberships,
            COALESCE(s.closing_direct_is_rent, s.closing_history_is_rent) AS closing_is_rent,
            COALESCE(s.closing_direct_sqm, s.closing_history_sqm) AS closing_sqm,
            COALESCE(s.closing_direct_rooms, s.closing_history_rooms) AS closing_rooms,
            (COALESCE(s.closing_history_attributes, '{}'::jsonb) || COALESCE(s.closing_direct_attributes, '{}'::jsonb)) AS closing_attributes,
            (COALESCE(s.closing_direct_membership_inferred, false) OR (EXISTS ( SELECT 1
                   FROM unnest(COALESCE(s.closing_history_memberships, '{}'::text[])) m(member)
                  WHERE (NOT (m.member = ANY (COALESCE(s.closing_direct_memberships, '{}'::text[]))))))) AS closing_membership_inferred,
            (COALESCE(s.closing_direct_attributes_inferred, false) OR ((s.closing_direct_category IS NULL) AND (s.closing_history_category IS NOT NULL)) OR ((s.closing_direct_is_rent IS NULL) AND (s.closing_history_is_rent IS NOT NULL)) OR ((s.closing_direct_sqm IS NULL) AND (s.closing_history_sqm IS NOT NULL)) OR ((s.closing_direct_rooms IS NULL) AND (s.closing_history_rooms IS NOT NULL)) OR (EXISTS ( SELECT 1
                   FROM jsonb_object_keys(COALESCE(s.closing_history_attributes, '{}'::jsonb)) a(key)
                  WHERE (NOT (COALESCE(s.closing_direct_attributes, '{}'::jsonb) ? a.key))))) AS closing_attributes_inferred,
            public.analytics_state_neighborhood((COALESCE(s.closing_history_attributes, '{}'::jsonb) || COALESCE(s.closing_direct_attributes, '{}'::jsonb))) AS closing_neighborhood
           FROM cycle_states s
        ), priced AS (
         SELECT f.article_id,
            f.cycle_no,
            f.opened_at,
            f.closed_at,
            f.is_closed,
            f.observed_cycle_duration_days,
            f.opening_direct_category,
            f.opening_direct_memberships,
            f.opening_direct_is_rent,
            f.opening_direct_sqm,
            f.opening_direct_rooms,
            f.opening_direct_attributes,
            f.opening_direct_membership_inferred,
            f.opening_direct_attributes_inferred,
            f.opening_history_category,
            f.opening_history_memberships,
            f.opening_history_is_rent,
            f.opening_history_sqm,
            f.opening_history_rooms,
            f.opening_history_attributes,
            f.closing_direct_category,
            f.closing_direct_memberships,
            f.closing_direct_is_rent,
            f.closing_direct_sqm,
            f.closing_direct_rooms,
            f.closing_direct_attributes,
            f.closing_direct_membership_inferred,
            f.closing_direct_attributes_inferred,
            f.closing_history_category,
            f.closing_history_memberships,
            f.closing_history_is_rent,
            f.closing_history_sqm,
            f.closing_history_rooms,
            f.closing_history_attributes,
            f.opening_category,
            f.opening_category_memberships,
            f.opening_is_rent,
            f.opening_sqm,
            f.opening_rooms,
            f.opening_attributes,
            f.opening_membership_inferred,
            f.opening_attributes_inferred,
            f.opening_neighborhood,
            f.closing_category,
            f.closing_category_memberships,
            f.closing_is_rent,
            f.closing_sqm,
            f.closing_rooms,
            f.closing_attributes,
            f.closing_membership_inferred,
            f.closing_attributes_inferred,
            f.closing_neighborhood,
            p.effective_at AS closing_price_effective_at,
            p.price AS closing_observed_price,
            COALESCE(p.price_state, 'unknown'::text) AS closing_price_state,
            p.currency_normalized AS closing_currency,
            p.evidence_is_rent AS closing_price_is_rent
           FROM (frozen_states f
             LEFT JOIN LATERAL ( SELECT e.id,
                    e.article_id,
                    e.effective_at,
                    e.ingested_at,
                    e.price,
                    e.price_state,
                    e.source,
                    e.provenance,
                    e.observed_at,
                    e.renewed_at,
                    e.effective_at_basis,
                    e.currency_normalized,
                    e.evidence_is_rent
                   FROM reporting.resolved_price_evidence e
                  WHERE ((e.article_id = f.article_id) AND (f.closed_at IS NOT NULL) AND (e.effective_at <= f.closed_at))
                  ORDER BY e.effective_at DESC, e.id DESC
                 LIMIT 1) p ON (true))
        ), quality AS (
         SELECT p.article_id,
            p.cycle_no,
            p.opened_at,
            p.closed_at,
            p.is_closed,
            p.observed_cycle_duration_days,
            p.opening_direct_category,
            p.opening_direct_memberships,
            p.opening_direct_is_rent,
            p.opening_direct_sqm,
            p.opening_direct_rooms,
            p.opening_direct_attributes,
            p.opening_direct_membership_inferred,
            p.opening_direct_attributes_inferred,
            p.opening_history_category,
            p.opening_history_memberships,
            p.opening_history_is_rent,
            p.opening_history_sqm,
            p.opening_history_rooms,
            p.opening_history_attributes,
            p.closing_direct_category,
            p.closing_direct_memberships,
            p.closing_direct_is_rent,
            p.closing_direct_sqm,
            p.closing_direct_rooms,
            p.closing_direct_attributes,
            p.closing_direct_membership_inferred,
            p.closing_direct_attributes_inferred,
            p.closing_history_category,
            p.closing_history_memberships,
            p.closing_history_is_rent,
            p.closing_history_sqm,
            p.closing_history_rooms,
            p.closing_history_attributes,
            p.opening_category,
            p.opening_category_memberships,
            p.opening_is_rent,
            p.opening_sqm,
            p.opening_rooms,
            p.opening_attributes,
            p.opening_membership_inferred,
            p.opening_attributes_inferred,
            p.opening_neighborhood,
            p.closing_category,
            p.closing_category_memberships,
            p.closing_is_rent,
            p.closing_sqm,
            p.closing_rooms,
            p.closing_attributes,
            p.closing_membership_inferred,
            p.closing_attributes_inferred,
            p.closing_neighborhood,
            p.closing_price_effective_at,
            p.closing_observed_price,
            p.closing_price_state,
            p.closing_currency,
            p.closing_price_is_rent,
            reporting.comparison_property_type(p.opening_category_memberships) AS opening_property_type,
            reporting.comparison_property_type(p.closing_category_memberships) AS closing_property_type,
                CASE
                    WHEN ((p.closing_price_effective_at IS NOT NULL) AND (p.closing_price_is_rent IS DISTINCT FROM p.closing_is_rent)) THEN 'price evidence belongs to another deal'::text
                    WHEN ((p.closing_price_effective_at IS NOT NULL) AND (EXISTS ( SELECT 1
                       FROM public.listing_state_history h
                      WHERE ((h.article_id = p.article_id) AND (h.effective_at > p.closing_price_effective_at) AND (h.effective_at <= p.closed_at) AND (h.is_rent IS NOT NULL) AND (h.is_rent IS DISTINCT FROM p.closing_price_is_rent))))) THEN 'price evidence predates a deal switch'::text
                    ELSE reporting.comparison_price_reason(p.closing_observed_price, p.closing_price_state, p.closing_currency, p.closing_is_rent)
                END AS closing_price_quality_reason,
                CASE
                    WHEN ((p.closing_price_effective_at IS NOT NULL) AND (p.closing_price_is_rent IS DISTINCT FROM p.closing_is_rent)) THEN 'price evidence belongs to another deal'::text
                    WHEN ((p.closing_price_effective_at IS NOT NULL) AND (EXISTS ( SELECT 1
                       FROM public.listing_state_history h
                      WHERE ((h.article_id = p.article_id) AND (h.effective_at > p.closing_price_effective_at) AND (h.effective_at <= p.closed_at) AND (h.is_rent IS NOT NULL) AND (h.is_rent IS DISTINCT FROM p.closing_price_is_rent))))) THEN 'price evidence predates a deal switch'::text
                    ELSE reporting.comparison_quality_reason(p.closing_observed_price, p.closing_price_state, p.closing_currency, p.closing_sqm, p.closing_is_rent)
                END AS closing_rate_quality_reason
           FROM priced p
        )
 SELECT article_id,
    cycle_no,
    opened_at,
    ((opened_at AT TIME ZONE 'Europe/Sarajevo'::text))::date AS opened_day,
    closed_at,
        CASE
            WHEN (closed_at IS NULL) THEN NULL::date
            ELSE ((closed_at AT TIME ZONE 'Europe/Sarajevo'::text))::date
        END AS closed_day,
    is_closed,
    (cycle_no > 1) AS reopened_cycle,
    observed_cycle_duration_days,
        CASE
            WHEN ((closed_at IS NULL) AND (opened_at IS NOT NULL)) THEN GREATEST((round((EXTRACT(epoch FROM (now() - opened_at)) / 86400.0)))::integer, 0)
            ELSE NULL::integer
        END AS current_cycle_age_days,
    opening_category,
    opening_category_memberships,
        CASE
            WHEN (opening_is_rent IS TRUE) THEN 'rent'::text
            WHEN (opening_is_rent IS FALSE) THEN 'sale'::text
            ELSE 'unknown'::text
        END AS opening_deal,
    opening_property_type,
    opening_sqm,
    opening_rooms,
    public.room_bucket(opening_rooms) AS opening_room_bucket,
    opening_neighborhood,
    opening_attributes,
    opening_membership_inferred,
    opening_attributes_inferred,
    closing_category,
    closing_category_memberships,
        CASE
            WHEN (closing_is_rent IS TRUE) THEN 'rent'::text
            WHEN (closing_is_rent IS FALSE) THEN 'sale'::text
            ELSE 'unknown'::text
        END AS closing_deal,
    closing_property_type,
    closing_sqm,
    closing_rooms,
    public.room_bucket(closing_rooms) AS closing_room_bucket,
    closing_neighborhood,
    closing_attributes,
    closing_membership_inferred,
    closing_attributes_inferred,
    closing_price_effective_at,
    closing_price_state,
    closing_currency,
    closing_observed_price,
    closing_price_quality_reason,
    closing_rate_quality_reason,
    (closing_price_quality_reason IS NULL) AS closing_price_eligible,
    (closing_rate_quality_reason IS NULL) AS closing_rate_eligible,
        CASE
            WHEN (closing_price_quality_reason IS NULL) THEN closing_observed_price
            ELSE NULL::numeric
        END AS final_asking_price,
        CASE
            WHEN (closing_rate_quality_reason IS NULL) THEN (closing_observed_price / NULLIF(closing_sqm, (0)::numeric))
            ELSE NULL::numeric
        END AS final_asking_rate,
        CASE
            WHEN (closing_is_rent IS TRUE) THEN 'KM/month'::text
            WHEN (closing_is_rent IS FALSE) THEN 'KM'::text
            ELSE NULL::text
        END AS final_asking_price_unit,
        CASE
            WHEN (closing_is_rent IS TRUE) THEN 'KM/m²/month'::text
            WHEN (closing_is_rent IS FALSE) THEN 'KM/m²'::text
            ELSE NULL::text
        END AS final_asking_rate_unit
   FROM quality q;

--
-- Name: VIEW lifecycle_cycles_source; Type: COMMENT; Schema: reporting; Owner: -
--

COMMENT ON VIEW reporting.lifecycle_cycles_source IS 'One row per observed opening/reopening cycle. Closure fields are frozen from evidence no later than closed_at; final asking values have independent eligibility and do not use current listing scores or attributes.';

--
-- Name: lifecycle_movements_from_olap_cycles; Type: VIEW; Schema: reporting; Owner: -
--

CREATE VIEW reporting.lifecycle_movements_from_olap_cycles AS
 WITH movement_rows AS (
         SELECT
                CASE
                    WHEN c.reopened_cycle THEN 'reopening'::text
                    ELSE 'first_observation'::text
                END AS movement_type,
            c.opened_at AS event_at,
            c.opened_day AS event_day,
            c.article_id,
            c.cycle_no,
            c.reopened_cycle,
            c.opening_deal AS deal,
            c.opening_property_type AS property_type,
            c.opening_category AS category,
            c.opening_category_memberships AS category_memberships,
            c.opening_sqm AS sqm,
            c.opening_rooms AS rooms,
            c.opening_room_bucket AS room_bucket,
            c.opening_neighborhood AS neighborhood,
            c.opening_attributes AS historical_attributes,
            c.opening_membership_inferred AS membership_inferred,
            c.opening_attributes_inferred AS attributes_inferred,
            NULL::text AS price_state,
            NULL::text AS currency,
            NULL::numeric AS asking_price,
            NULL::numeric AS asking_rate,
            NULL::boolean AS price_eligible,
            NULL::boolean AS rate_eligible
           FROM olap.lifecycle_cycles c
        UNION ALL
         SELECT 'closure'::text,
            c.closed_at,
            c.closed_day,
            c.article_id,
            c.cycle_no,
            c.reopened_cycle,
            c.closing_deal,
            c.closing_property_type,
            c.closing_category,
            c.closing_category_memberships,
            c.closing_sqm,
            c.closing_rooms,
            c.closing_room_bucket,
            c.closing_neighborhood,
            c.closing_attributes,
            c.closing_membership_inferred,
            c.closing_attributes_inferred,
            c.closing_price_state,
            c.closing_currency,
            c.final_asking_price,
            c.final_asking_rate,
            c.closing_price_eligible,
            c.closing_rate_eligible
           FROM olap.lifecycle_cycles c
          WHERE c.is_closed
        )
 SELECT movement_type,
    event_at,
    event_day,
    article_id,
    cycle_no,
    reopened_cycle,
    deal,
    property_type,
    category,
    category_memberships,
    sqm,
    rooms,
    room_bucket,
    neighborhood,
    historical_attributes,
    membership_inferred,
    attributes_inferred,
    price_state,
    currency,
    asking_price,
    asking_rate,
    price_eligible,
    rate_eligible,
    NULLIF((historical_attributes ->> 'sellerType'::text), ''::text) AS historical_seller_type,
    NULLIF((historical_attributes ->> 'condition'::text), ''::text) AS historical_condition,
        CASE lower(COALESCE((historical_attributes ->> 'furnished'::text), ''::text))
            WHEN 'true'::text THEN true
            WHEN 't'::text THEN true
            WHEN 'yes'::text THEN true
            WHEN '1'::text THEN true
            WHEN 'false'::text THEN false
            WHEN 'f'::text THEN false
            WHEN 'no'::text THEN false
            WHEN '0'::text THEN false
            ELSE NULL::boolean
        END AS historical_furnished,
    NULLIF((historical_attributes ->> 'heating'::text), ''::text) AS historical_heating,
        CASE lower(COALESCE((historical_attributes ->> 'parking'::text), ''::text))
            WHEN 'true'::text THEN true
            WHEN 't'::text THEN true
            WHEN 'yes'::text THEN true
            WHEN '1'::text THEN true
            WHEN 'false'::text THEN false
            WHEN 'f'::text THEN false
            WHEN 'no'::text THEN false
            WHEN '0'::text THEN false
            ELSE NULL::boolean
        END AS historical_parking,
        CASE lower(COALESCE((historical_attributes ->> 'garage'::text), ''::text))
            WHEN 'true'::text THEN true
            WHEN 't'::text THEN true
            WHEN 'yes'::text THEN true
            WHEN '1'::text THEN true
            WHEN 'false'::text THEN false
            WHEN 'f'::text THEN false
            WHEN 'no'::text THEN false
            WHEN '0'::text THEN false
            ELSE NULL::boolean
        END AS historical_garage,
        CASE lower(COALESCE((historical_attributes ->> 'elevator'::text), ''::text))
            WHEN 'true'::text THEN true
            WHEN 't'::text THEN true
            WHEN 'yes'::text THEN true
            WHEN '1'::text THEN true
            WHEN 'false'::text THEN false
            WHEN 'f'::text THEN false
            WHEN 'no'::text THEN false
            WHEN '0'::text THEN false
            ELSE NULL::boolean
        END AS historical_elevator,
        CASE
            WHEN (((historical_attributes ->> 'floorNum'::text) ~ '^-?[0-9]{1,5}$'::text) AND ((((historical_attributes ->> 'floorNum'::text))::numeric >= ('-32768'::integer)::numeric) AND (((historical_attributes ->> 'floorNum'::text))::numeric <= (32767)::numeric))) THEN ((historical_attributes ->> 'floorNum'::text))::smallint
            ELSE NULL::smallint
        END AS historical_floor_num
   FROM movement_rows m;

--
-- Name: lifecycle_movements_source; Type: VIEW; Schema: reporting; Owner: -
--

CREATE VIEW reporting.lifecycle_movements_source AS
 WITH movement_rows AS (
         SELECT
                CASE
                    WHEN c.reopened_cycle THEN 'reopening'::text
                    ELSE 'first_observation'::text
                END AS movement_type,
            c.opened_at AS event_at,
            c.opened_day AS event_day,
            c.article_id,
            c.cycle_no,
            c.reopened_cycle,
            c.opening_deal AS deal,
            c.opening_property_type AS property_type,
            c.opening_category AS category,
            c.opening_category_memberships AS category_memberships,
            c.opening_sqm AS sqm,
            c.opening_rooms AS rooms,
            c.opening_room_bucket AS room_bucket,
            c.opening_neighborhood AS neighborhood,
            c.opening_attributes AS historical_attributes,
            c.opening_membership_inferred AS membership_inferred,
            c.opening_attributes_inferred AS attributes_inferred,
            NULL::text AS price_state,
            NULL::text AS currency,
            NULL::numeric AS asking_price,
            NULL::numeric AS asking_rate,
            NULL::boolean AS price_eligible,
            NULL::boolean AS rate_eligible
           FROM reporting.lifecycle_cycles_source c
        UNION ALL
         SELECT 'closure'::text,
            c.closed_at,
            c.closed_day,
            c.article_id,
            c.cycle_no,
            c.reopened_cycle,
            c.closing_deal,
            c.closing_property_type,
            c.closing_category,
            c.closing_category_memberships,
            c.closing_sqm,
            c.closing_rooms,
            c.closing_room_bucket,
            c.closing_neighborhood,
            c.closing_attributes,
            c.closing_membership_inferred,
            c.closing_attributes_inferred,
            c.closing_price_state,
            c.closing_currency,
            c.final_asking_price,
            c.final_asking_rate,
            c.closing_price_eligible,
            c.closing_rate_eligible
           FROM reporting.lifecycle_cycles_source c
          WHERE c.is_closed
        )
 SELECT movement_type,
    event_at,
    event_day,
    article_id,
    cycle_no,
    reopened_cycle,
    deal,
    property_type,
    category,
    category_memberships,
    sqm,
    rooms,
    room_bucket,
    neighborhood,
    historical_attributes,
    membership_inferred,
    attributes_inferred,
    price_state,
    currency,
    asking_price,
    asking_rate,
    price_eligible,
    rate_eligible,
    NULLIF((historical_attributes ->> 'sellerType'::text), ''::text) AS historical_seller_type,
    NULLIF((historical_attributes ->> 'condition'::text), ''::text) AS historical_condition,
        CASE lower(COALESCE((historical_attributes ->> 'furnished'::text), ''::text))
            WHEN 'true'::text THEN true
            WHEN 't'::text THEN true
            WHEN 'yes'::text THEN true
            WHEN '1'::text THEN true
            WHEN 'false'::text THEN false
            WHEN 'f'::text THEN false
            WHEN 'no'::text THEN false
            WHEN '0'::text THEN false
            ELSE NULL::boolean
        END AS historical_furnished,
    NULLIF((historical_attributes ->> 'heating'::text), ''::text) AS historical_heating,
        CASE lower(COALESCE((historical_attributes ->> 'parking'::text), ''::text))
            WHEN 'true'::text THEN true
            WHEN 't'::text THEN true
            WHEN 'yes'::text THEN true
            WHEN '1'::text THEN true
            WHEN 'false'::text THEN false
            WHEN 'f'::text THEN false
            WHEN 'no'::text THEN false
            WHEN '0'::text THEN false
            ELSE NULL::boolean
        END AS historical_parking,
        CASE lower(COALESCE((historical_attributes ->> 'garage'::text), ''::text))
            WHEN 'true'::text THEN true
            WHEN 't'::text THEN true
            WHEN 'yes'::text THEN true
            WHEN '1'::text THEN true
            WHEN 'false'::text THEN false
            WHEN 'f'::text THEN false
            WHEN 'no'::text THEN false
            WHEN '0'::text THEN false
            ELSE NULL::boolean
        END AS historical_garage,
        CASE lower(COALESCE((historical_attributes ->> 'elevator'::text), ''::text))
            WHEN 'true'::text THEN true
            WHEN 't'::text THEN true
            WHEN 'yes'::text THEN true
            WHEN '1'::text THEN true
            WHEN 'false'::text THEN false
            WHEN 'f'::text THEN false
            WHEN 'no'::text THEN false
            WHEN '0'::text THEN false
            ELSE NULL::boolean
        END AS historical_elevator,
        CASE
            WHEN (((historical_attributes ->> 'floorNum'::text) ~ '^-?[0-9]{1,5}$'::text) AND ((((historical_attributes ->> 'floorNum'::text))::numeric >= ('-32768'::integer)::numeric) AND (((historical_attributes ->> 'floorNum'::text))::numeric <= (32767)::numeric))) THEN ((historical_attributes ->> 'floorNum'::text))::smallint
            ELSE NULL::smallint
        END AS historical_floor_num
   FROM movement_rows m;

--
-- Name: VIEW lifecycle_movements_source; Type: COMMENT; Schema: reporting; Owner: -
--

COMMENT ON VIEW reporting.lifecycle_movements_source IS 'Event-time supply movements at article-cycle grain. Closure rows come only from closed lifecycle cycles; score filters never select this historical population.';
