-- Fills supply_daily and supply_composition_daily for every UTC day before the latest block's day that they do not hold
-- yet, through rebuild_supply_daily: one day per transaction (each \gexec statement runs on its own), newest first, so
-- the recent ranges are answered first. get_supply and get_supply_composition read a full day from the rollup once it is
-- held; until then a bucket whose point is that day has no row and the day is a gap in covered_gaps, never an earlier
-- point. A day without blocks, or with no block with an upokt supply, is held with no point. The latest block's day is
-- the indexer's: refresh_supply_daily writes it when the next day's first block comes.
-- Idempotent: a stopped run is resumed by running it again; a day already held is skipped. A day is one point, the
-- upokt balances at its last block (~60-250 ms on the mainnet replica, 2026-10-20), so the whole chain (~570 days) is
-- a few minutes of short transactions; each takes row locks on that day's rollup rows only.
--
--   psql -v schema=mainnet -f scripts/fill_supply_daily.sql
--   psql -v schema=mainnet -v since=2026-01-01 -f scripts/fill_supply_daily.sql   (only the days from that date)
--
-- Run it on the primary once the indexer with the rollup is running. Prints each day's point (its height; empty for a
-- day held with none), then how many days are still not held (0 when done).
\set ON_ERROR_STOP on
\if :{?since}
\else
  \set since '1970-01-01'
\endif
SET search_path = :schema;
SET jit = off;
SELECT format('SELECT %L AS day, rebuild_supply_daily(%L::date) AS height', d::date, d::date)
FROM generate_series(
       greatest(:'since'::date, (SELECT b.timestamp::date FROM blocks b ORDER BY b.timestamp, b.id LIMIT 1)),
       (SELECT b.timestamp::date FROM blocks b ORDER BY b.timestamp DESC, b.id DESC LIMIT 1) - 1,
       interval '1 day') d
WHERE NOT EXISTS (SELECT 1 FROM supply_daily t WHERE t.day = d::date)
ORDER BY d DESC
\gexec
SELECT count(*) AS days_not_held
FROM generate_series(
       greatest(:'since'::date, (SELECT b.timestamp::date FROM blocks b ORDER BY b.timestamp, b.id LIMIT 1)),
       (SELECT b.timestamp::date FROM blocks b ORDER BY b.timestamp DESC, b.id DESC LIMIT 1) - 1,
       interval '1 day') d
WHERE NOT EXISTS (SELECT 1 FROM supply_daily t WHERE t.day = d::date);
