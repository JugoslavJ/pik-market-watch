-- Keep listing_comparables' original declared row type so bootstrap adoption
-- can replay migration 16 before replaying the OLAP migrations. The values are
-- still sourced exclusively from the physical OLAP snapshot; JSON record
-- projection selects the original input columns by name and ignores score-only
-- snapshot columns.

DROP FUNCTION reporting.listing_comparables(bigint);

CREATE FUNCTION reporting.listing_comparables(p_article_id bigint)
RETURNS SETOF reporting.current_comparison_inputs
LANGUAGE sql STABLE
AS $$
  SELECT projected.*
    FROM reporting.current_listing_scores_olap t
    JOIN reporting.current_listing_scores_olap c
      ON c.article_id <> t.article_id
     AND c.neighborhood = t.neighborhood
     AND c.property_type = t.property_type
     AND c.is_rent = t.is_rent
     AND c.room_bucket = t.room_bucket
     AND c.sqm BETWEEN t.sqm * 0.8 AND t.sqm * 1.2
     AND (NOT t.is_rent OR c.furnished = t.furnished)
    CROSS JOIN LATERAL jsonb_populate_record(
      NULL::reporting.current_comparison_inputs,
      to_jsonb(c)
    ) projected
   WHERE t.article_id = p_article_id
     AND t.score_input_reason IS NULL
     AND c.score_input_reason IS NULL
   ORDER BY c.article_id
$$;

COMMENT ON FUNCTION reporting.listing_comparables(bigint) IS
  'Original input-row contract, with exact comparable values read only from the current-market OLAP snapshot.';
