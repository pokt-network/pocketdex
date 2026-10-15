-- Marks supplier_rev_share_wallets as filled: from this commit on, _operator_suppliers_ever (operator_scope ever) reads
-- it instead of the config versions. Run once, AFTER the release with the writer is running and AFTER
-- backfill_rev_share_wallets.sql has run again following that release, and after check_rev_share_wallets.sql shows
-- missing = 0. Running it again changes nothing.
--   psql -d explorer-mainnet -v ON_ERROR_STOP=1 -v schema=mainnet -f scripts/set_rev_share_wallets_coverage.sql
\set ON_ERROR_STOP on
INSERT INTO :"schema".supplier_rev_share_wallets_coverage (backfilled_at) VALUES (now()) ON CONFLICT (singleton) DO NOTHING;
SELECT backfilled_at FROM :"schema".supplier_rev_share_wallets_coverage;
