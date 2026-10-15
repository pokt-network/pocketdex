-- Fills supplier_rev_share_wallets with the (wallet, supplier) pair of every rev_share entry of every service config
-- version, at the first height a version listed it. Does NOT set the coverage row (set_rev_share_wallets_coverage.sql
-- does, as its own step), so _operator_suppliers_ever keeps reading the config versions until then.
-- Idempotent: run it now (before the release), and again right after the release, to fill the blocks between the two.
-- A pair already in the table keeps the lower of the two heights: the writer of the release inserts a pair at the height
-- of the first block it sees it in, which can be later than a version written between the two runs, and DO NOTHING would
-- keep that later height. A re-run with nothing new updates 0 rows.
-- One statement. Its SELECT over the whole table, run on the replica (2026-10-15): mainnet 3.6 s, 30,408
-- pairs (8,692 wallets, 10,251 suppliers); beta 8 ms, 88 pairs. Far under 300 s, so no batches.
--   psql -d explorer-mainnet -v ON_ERROR_STOP=1 -v schema=mainnet -f scripts/backfill_rev_share_wallets.sql
--   psql -d explorer-testnet -v ON_ERROR_STOP=1 -v schema=beta    -f scripts/backfill_rev_share_wallets.sql
\set ON_ERROR_STOP on
SET jit = off;
INSERT INTO :"schema".supplier_rev_share_wallets AS w (wallet_address, supplier_id, first_seen_height)
SELECT e->>'address', c.supplier_id, min(lower(c._block_range))::bigint
FROM :"schema".supplier_service_configs c, jsonb_array_elements(c.rev_share) e
WHERE NOT isempty(c._block_range)
GROUP BY 1, 2
ON CONFLICT (wallet_address, supplier_id) DO UPDATE SET first_seen_height = EXCLUDED.first_seen_height
  WHERE EXCLUDED.first_seen_height < w.first_seen_height;
SELECT count(*) AS pairs, count(DISTINCT wallet_address) AS wallets, count(DISTINCT supplier_id) AS suppliers,
       min(first_seen_height) AS lowest_height, max(first_seen_height) AS highest_height
FROM :"schema".supplier_rev_share_wallets;
