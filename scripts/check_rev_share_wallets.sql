-- Compares supplier_rev_share_wallets with the pairs the config versions hold now. Read-only; runs on the replica
-- (its pass over the versions took 3.6 s on mainnet, 2026-10-15). Expected after a backfill:
--   pairs_in_table = pairs_in_configs, missing = 0, extra = 0, lower_height_in_configs = 0.
-- Between the release and the second backfill run, missing counts the pairs first listed in that window.
--   psql -d explorer-mainnet -v schema=mainnet -f scripts/check_rev_share_wallets.sql   (on the replica)
SET jit = off;
WITH cfg AS MATERIALIZED (
  SELECT e->>'address' AS wallet_address, c.supplier_id, min(lower(c._block_range))::bigint AS first_seen_height
  FROM :"schema".supplier_service_configs c, jsonb_array_elements(c.rev_share) e
  WHERE NOT isempty(c._block_range)
  GROUP BY 1, 2)
SELECT (SELECT count(*) FROM :"schema".supplier_rev_share_wallets) AS pairs_in_table,
       (SELECT count(*) FROM cfg) AS pairs_in_configs,
       (SELECT count(*) FROM cfg WHERE NOT EXISTS (SELECT 1 FROM :"schema".supplier_rev_share_wallets w
          WHERE w.wallet_address = cfg.wallet_address AND w.supplier_id = cfg.supplier_id)) AS missing,
       (SELECT count(*) FROM :"schema".supplier_rev_share_wallets w WHERE NOT EXISTS (SELECT 1 FROM cfg
          WHERE w.wallet_address = cfg.wallet_address AND w.supplier_id = cfg.supplier_id)) AS extra,
       (SELECT count(*) FROM cfg JOIN :"schema".supplier_rev_share_wallets w USING (wallet_address, supplier_id)
          WHERE cfg.first_seen_height < w.first_seen_height) AS lower_height_in_configs,
       (SELECT backfilled_at FROM :"schema".supplier_rev_share_wallets_coverage) AS backfilled_at;
