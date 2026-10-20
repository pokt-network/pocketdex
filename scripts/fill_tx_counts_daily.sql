-- Fills tx_counts_daily for every UTC day with blocks before the latest block's day that it does not hold yet, through
-- rebuild_tx_counts_daily: one day per transaction (each \gexec statement runs on its own), newest first, so the recent
-- ranges are answered first. get_tx_counts reads a full day from the rollup once it is held; until then the day is a gap
-- in covered_gaps, never a zero. A day without blocks (mainnet 2025-05-01..06) has nothing to hold and is no gap. The
-- latest block's day is the indexer's: its per-block refresh rebuilds a day it does not hold at its first block.
-- Idempotent: a stopped run is resumed by running it again; a day already held is skipped. A day is read once, from the
-- transactions of its blocks (163,490 of them took 250 ms on the mainnet replica, 2026-10-10), so a year is about
-- 365 short transactions; each takes row locks on that day's rollup rows only.
--
--   psql -v schema=mainnet -f scripts/fill_tx_counts_daily.sql
--   psql -v schema=mainnet -v since=2026-01-01 -f scripts/fill_tx_counts_daily.sql   (only the days from that date)
--
-- Run it on the primary once the indexer with the rollup is running. Prints the transactions counted per day, then how
-- many days with blocks are still not held (0 when done).
\set ON_ERROR_STOP on
\if :{?since}
\else
  \set since '1970-01-01'
\endif
SET search_path = :schema;
SET jit = off;
SELECT format('SELECT %L AS day, rebuild_tx_counts_daily(%L::date) AS txs', d::date, d::date)
FROM generate_series(
       greatest(:'since'::date, (SELECT b.timestamp::date FROM blocks b ORDER BY b.timestamp, b.id LIMIT 1)),
       (SELECT b.timestamp::date FROM blocks b ORDER BY b.timestamp DESC, b.id DESC LIMIT 1) - 1,
       interval '1 day') d
WHERE NOT EXISTS (SELECT 1 FROM tx_counts_daily t WHERE t.day = d::date)
  AND EXISTS (SELECT 1 FROM blocks b WHERE b.timestamp >= d AND b.timestamp < d + interval '1 day')
ORDER BY d DESC
\gexec
SELECT count(*) AS days_not_held
FROM generate_series(
       greatest(:'since'::date, (SELECT b.timestamp::date FROM blocks b ORDER BY b.timestamp, b.id LIMIT 1)),
       (SELECT b.timestamp::date FROM blocks b ORDER BY b.timestamp DESC, b.id DESC LIMIT 1) - 1,
       interval '1 day') d
WHERE NOT EXISTS (SELECT 1 FROM tx_counts_daily t WHERE t.day = d::date)
  AND EXISTS (SELECT 1 FROM blocks b WHERE b.timestamp >= d AND b.timestamp < d + interval '1 day');
