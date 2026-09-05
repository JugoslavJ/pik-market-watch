# Payload normalization and price quality

**Owner:** Pure parsers and shared price validation.  
**Dependencies:** [Shared contracts](00-contracts-and-dependencies.md).

## Changes

- Introduce one normalization policy used by search parsing, detail parsing, historical imports and legacy conversion.
- Preserve declared sale/rent classification independently of price validity.
- Emit a price state of `valid`, `unpriced` or `invalid`; invalid numeric prices become null in canonical data, with a rejection reason.
- Parse both detail current price and detail history. Preserve source JSON separately rather than treating the current transformed `api_price_history` column as a raw archive.
- Accept the two existing history formats: API `{price, created_at}` and stored `{price, date}`.
- Validate IDs, finite numeric values and Unix-second timestamps. Reject missing, invalid or future historical timestamps; never substitute import time.
- Preserve existing characteristic mapping and neighborhood inputs.

## Acceptance criteria

Fixture tests cover 0, 26, threshold boundaries, declared rentals, cheap declared sales, missing area, excessive KM/m², numeric strings, malformed dates, unsorted history and duplicate history entries. A valid price remains importable when area is unknown.
