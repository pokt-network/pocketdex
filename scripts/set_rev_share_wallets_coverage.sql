-- Marks supplier_rev_share_wallets as filled: from this commit on, _operator_suppliers_ever (operator_scope ever) reads
-- it instead of the config versions. Step 3 of the runbook in scripts/backfill_rev_share_wallets.sql, with the indexer
-- live: after the backfill has run following the release that writes the pairs. In one statement it compares the table
-- with the pairs of the config versions (as check_rev_share_wallets.sql does, ~4 s on mainnet) and refuses, writing
-- nothing, unless no pair is missing, none is extra, and none is stored above the first height a config version lists
-- it at (a rewind to a height between the two would delete such a pair, and nothing would write it again). One snapshot sees a block's versions and its pairs together, since
-- the indexer writes both in the block transaction. Running it again changes nothing.
--   psql -d explorer-mainnet -v ON_ERROR_STOP=1 -v schema=mainnet -f scripts/set_rev_share_wallets_coverage.sql
\set ON_ERROR_STOP on
SET jit = off;
SELECT set_config('rev_share_wallets.schema', :'schema', false);
DO $$
DECLARE
  s text := current_setting('rev_share_wallets.schema');
  missing bigint;
  extra bigint;
  higher bigint;
BEGIN
  EXECUTE format('
    WITH cfg AS MATERIALIZED (
      SELECT e->>''address'' AS wallet_address, c.supplier_id, min(lower(c._block_range))::bigint AS first_seen_height
      FROM %1$I.supplier_service_configs c, jsonb_array_elements(c.rev_share) e
      WHERE NOT isempty(c._block_range)
      GROUP BY 1, 2)
    SELECT (SELECT count(*) FROM cfg WHERE NOT EXISTS (SELECT 1 FROM %1$I.supplier_rev_share_wallets w
              WHERE w.wallet_address = cfg.wallet_address AND w.supplier_id = cfg.supplier_id)),
           (SELECT count(*) FROM %1$I.supplier_rev_share_wallets w WHERE NOT EXISTS (SELECT 1 FROM cfg
              WHERE w.wallet_address = cfg.wallet_address AND w.supplier_id = cfg.supplier_id)),
           (SELECT count(*) FROM cfg JOIN %1$I.supplier_rev_share_wallets w USING (wallet_address, supplier_id)
              WHERE cfg.first_seen_height < w.first_seen_height)', s)
  INTO missing, extra, higher;
  IF missing <> 0 OR extra <> 0 OR higher <> 0 THEN
    RAISE EXCEPTION 'supplier_rev_share_wallets is not complete: % pairs missing (run backfill_rev_share_wallets.sql again), % extra (pairs no config version lists, which a rewind racing a backfill batch can leave: delete them), % above their first height (run backfill_rev_share_wallets.sql again, which lowers them); then run this again', missing, extra, higher;
  END IF;
  EXECUTE format('INSERT INTO %I.supplier_rev_share_wallets_coverage (backfilled_at) VALUES (now()) ON CONFLICT (singleton) DO NOTHING', s);
  RAISE NOTICE 'complete (0 missing, 0 extra, 0 above their first height): covered (the row below; kept from the first run)';
END $$;
SELECT backfilled_at FROM :"schema".supplier_rev_share_wallets_coverage;
