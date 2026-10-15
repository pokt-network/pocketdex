-- Fills supplier_rev_share_wallets with the (wallet, supplier) pair of every rev_share entry of every service config
-- version, at the first height a version listed it. It does NOT set the coverage row (set_rev_share_wallets_coverage.sql
-- does). Idempotent: a pair already in the table keeps the lower of the two heights, and a re-run with nothing new changes
-- 0 rows.
--
-- Runs with the indexer live, which is never paused. Runbook, beta first:
--   1. deploy the release that writes the pairs (src/mappings/pocket/rev_share_wallets.ts);
--   2. this script: every pair of a block committed before a batch reads the versions is in that batch, and every later
--      one is written by the indexer itself;
--   3. scripts/check_rev_share_wallets.sql (missing = 0, extra = 0), then scripts/set_rev_share_wallets_coverage.sql,
--      which checks the same and refuses otherwise.
--   psql -d explorer-mainnet -v ON_ERROR_STOP=1 -v schema=mainnet -f scripts/backfill_rev_share_wallets.sql
--   psql -d explorer-testnet -v ON_ERROR_STOP=1 -v schema=beta    -f scripts/backfill_rev_share_wallets.sql
-- Not with psql -1 / --single-transaction: each batch must commit on its own.
--
-- The suppliers are split into batches of 1,000 by supplier_id range (mainnet, 2026-10-14: 10,252 suppliers, 11
-- batches; -v batch_size=N changes the size, the DB test uses 2); the first and last ranges are open, so a supplier added meanwhile falls in one. Each batch is one DO
-- statement, so its own short transaction: no table lock, no temporary table, and no snapshot outlives a batch (psql
-- \gexec reads the list of batches whole, then runs them one by one). A batch inserts its pairs ORDER BY
-- (wallet_address, supplier_id), as the indexer's insert does, so the two take their row locks in the same order and
-- do not deadlock each other. The rewind DELETE, which the indexer runs only on the first block after it starts or
-- rewinds, locks in no such order: avoid starting the backfill while the indexer restarts. A batch that meets a block's
-- uncommitted pairs waits at most 2 s (lock_timeout), then rolls back and is retried alone, every second, up to 60
-- attempts (the server cuts a statement at 300 s; a settlement block holds its pairs ~40 s); the block waits at most for
-- one batch's INSERT.
\set ON_ERROR_STOP on
\unset FETCH_COUNT
\if :{?batch_size}
\else
  \set batch_size 1000
\endif
SET jit = off;
SET lock_timeout = '2s';
SELECT format($batch$
DO $do$
DECLARE
  attempt integer := 0;
  written bigint;
BEGIN
  LOOP
    attempt := attempt + 1;
    BEGIN
      INSERT INTO %1$I.supplier_rev_share_wallets AS w (wallet_address, supplier_id, first_seen_height)
      SELECT e->>'address', c.supplier_id, min(lower(c._block_range))::bigint
      FROM %1$I.supplier_service_configs c, jsonb_array_elements(c.rev_share) e
      WHERE NOT isempty(c._block_range) AND %2$s
      GROUP BY 1, 2
      ORDER BY 1, 2
      ON CONFLICT (wallet_address, supplier_id) DO UPDATE SET first_seen_height = EXCLUDED.first_seen_height
        WHERE EXCLUDED.first_seen_height < w.first_seen_height;
      GET DIAGNOSTICS written = ROW_COUNT;
      EXIT;
    EXCEPTION WHEN lock_not_available OR deadlock_detected THEN
      IF attempt >= 60 THEN
        RAISE;
      END IF;
      RAISE NOTICE 'batch %3$s/%4$s attempt %%: %%, retrying in 1 s', attempt, SQLERRM;
      PERFORM pg_sleep(1);
    END;
  END LOOP;
  RAISE NOTICE 'batch %3$s/%4$s: %% pairs inserted or lowered (attempt %%)', written, attempt;
END $do$
$batch$, :'schema',
  concat_ws(' AND ', CASE WHEN lo IS NOT NULL THEN format('c.supplier_id >= %L', lo) END,
                     CASE WHEN hi IS NOT NULL THEN format('c.supplier_id < %L', hi) END, 'true'),
  n, count(*) OVER ())
FROM (
  SELECT CASE WHEN n = 1 THEN NULL ELSE supplier_id END AS lo, lead(supplier_id) OVER (ORDER BY supplier_id) AS hi, n
  FROM (SELECT supplier_id, row_number() OVER (ORDER BY supplier_id) AS rn, (row_number() OVER (ORDER BY supplier_id) - 1) / :batch_size + 1 AS n
        FROM (SELECT DISTINCT supplier_id FROM :"schema".supplier_service_configs WHERE supplier_id IS NOT NULL) d) s
  WHERE (rn - 1) % :batch_size = 0
) b
ORDER BY n
\gexec
SELECT count(*) AS pairs, count(DISTINCT wallet_address) AS wallets, count(DISTINCT supplier_id) AS suppliers,
       min(first_seen_height) AS lowest_height, max(first_seen_height) AS highest_height
FROM :"schema".supplier_rev_share_wallets;
