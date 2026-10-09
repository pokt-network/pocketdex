-- Fills daily_claims_paid_by_address_service for every day that has a settlement height it does not hold yet
-- (settlement_blocks.claims_paid_rollup false: the heights written before the rollup existed), through
-- fill_claims_paid_day: one day per transaction, newest first, so the recent ranges read the rollup first.
-- legacy_rewards_by_addresses_and_time_group_by_service reads a day from the rollup once every height of it is held.
-- Idempotent: a stopped run is resumed by running it again; a day already held is skipped.
--
--   psql -v schema=mainnet -f scripts/fill_claims_paid.sql
--
-- Run it on the primary once the indexer with the rollup is running. Each day takes the settlement writer's lock while
-- it is computed, so the indexer and the history job wait for it (seconds per day on mainnet). Prints the heights
-- marked per day, then how many heights are left unmarked (0 when done).
\set ON_ERROR_STOP on
SET search_path = :schema;
SELECT format('SELECT %L AS day, fill_claims_paid_day(%L) AS heights_marked', day, day)
FROM (SELECT DISTINCT day FROM settlement_blocks WHERE NOT claims_paid_rollup) d
ORDER BY day DESC
\gexec
SELECT count(*) AS heights_unmarked FROM settlement_blocks WHERE NOT claims_paid_rollup;
