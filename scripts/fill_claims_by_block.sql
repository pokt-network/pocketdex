-- Fills claims_by_block for the heights [:from, coverage - 1], the history below the height the indexer started
-- writing it at, through the same write_claims_by_block the indexer calls on every block: chunk heights per
-- transaction, walking DOWN from the coverage, so each chunk lowers claims_by_block_coverage and
-- get_claim_proofs_data_by_time reads the table for every range above it (the raw tables below it).
-- Idempotent: a stopped run is resumed by running it again.
--
--   psql -v schema=mainnet -v from=1 -v chunk=5000 -f scripts/fill_claims_by_block.sql
--
-- Run it on the primary once the indexer with claims_by_block is running. Prints the rows written per chunk.
\set ON_ERROR_STOP on
SET search_path = :schema;
SELECT covered_from_height - 1 AS to FROM claims_by_block_coverage \gset
SELECT format('SELECT %s AS from_height, %s AS to_height, write_claims_by_block(%s, %s) AS rows_written',
              greatest(hi - :chunk + 1, :from), hi, greatest(hi - :chunk + 1, :from), hi)
FROM generate_series(:to::bigint, :from::bigint, -:chunk::bigint) hi
ORDER BY hi DESC
\gexec
SELECT covered_from_height FROM claims_by_block_coverage;
