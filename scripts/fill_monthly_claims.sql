-- Fills monthly_claims_by_supplier_service for every UTC month that has a settlement height it does not hold yet
-- (settlement_blocks.monthly_claims_rollup false: the heights written before the rollup existed), through
-- fill_monthly_claims_month: one month per transaction, newest first. get_supplier_earnings by service reads a month from
-- the rollup once every height of it is held. Idempotent: a stopped run is resumed by running it again; a month already
-- held is skipped.
--
--   psql -v schema=mainnet -f scripts/fill_monthly_claims.sql
--
-- Run it on the primary once the indexer with the rollup is running. Each month takes the settlement writer's lock while
-- it is computed, so the indexer and the history job wait for it (seconds per month on mainnet). Prints the heights
-- marked per month, then how many heights are left unmarked (0 when done).
\set ON_ERROR_STOP on
SET search_path = :schema;
SELECT format('SELECT %L AS month, fill_monthly_claims_month(%L) AS heights_marked', month, month)
FROM (SELECT DISTINCT date_trunc('month', day::timestamp)::date AS month FROM settlement_blocks WHERE NOT monthly_claims_rollup) m
ORDER BY month DESC
\gexec
SELECT count(*) AS heights_unmarked FROM settlement_blocks WHERE NOT monthly_claims_rollup;
