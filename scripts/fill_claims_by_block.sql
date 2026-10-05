-- Fills claims_by_block for the heights [:from, :to] (the history before the indexer wrote it), chunk heights
-- per transaction, through the same write_claims_by_block the indexer calls on every block. Idempotent: a chunk
-- rewrites its heights, so a stopped run is resumed by running it again from any height.
--
--   psql -v schema=mainnet -v from=1 -v to=950000 -v chunk=5000 -f scripts/fill_claims_by_block.sql
--
-- Run it on the primary once the indexer with claims_by_block is deployed; until it ends,
-- get_claim_proofs_data_by_time answers only the heights already written. Prints the rows written per chunk.
\set ON_ERROR_STOP on
SET search_path = :schema;
SELECT format('SELECT %s AS from_height, %s AS to_height, write_claims_by_block(%s, %s) AS rows_written',
              lo, least(lo + :chunk - 1, :to), lo, least(lo + :chunk - 1, :to))
FROM generate_series(:from::bigint, :to::bigint, :chunk::bigint) lo
\gexec
