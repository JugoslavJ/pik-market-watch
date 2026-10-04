-- Latest attempt per run and requested page, with parser and upstream status.
SELECT DISTINCT ON (p.run_id, p.page_number)
  p.run_id,
  r.search_key,
  ss.name AS search_name,
  p.page_number,
  p.attempt,
  p.fetched_at,
  p.response_state,
  p.expected_total,
  p.expected_last_page,
  p.raw_item_count,
  p.parsed_item_count,
  p.duplicate_item_count,
  p.parse_rejection_count,
  p.error,
  p.is_authoritative
FROM lean.scrape_run_pages p
JOIN lean.scrape_runs r ON r.id = p.run_id
LEFT JOIN lean.saved_searches ss USING (search_key)
ORDER BY p.run_id, p.page_number, p.attempt DESC
