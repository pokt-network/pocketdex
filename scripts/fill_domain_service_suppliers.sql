-- Fills domain_service_daily_suppliers (the staked supplier sets beside domain_service_daily_rewards.suppliers_count,
-- domainRewards.ts) for every day before the latest block's day whose rewards rows do not all have their set yet,
-- through rebuild_domain_service_daily_suppliers: one day per transaction (each \gexec statement runs on its own),
-- newest first, so recent ranges are answered first. Until a day has its sets, get_domain_service_rewards answers
-- staked_suppliers NULL for several domains on it (one domain reads suppliers_count, as before). The latest block's day
-- is the indexer's: its next settlement block writes the day's sets.
-- Idempotent: a stopped run is resumed by running it again; a day whose rows all have their set is skipped. A day is the
-- writer's own count of that day, over the configs that overlap its blocks up to its last settlement block (0.4-1.7 s a
-- day on the mainnet replica, 2026-10-20), and it writes the count again with the set, from the same rows.
--
--   psql -v schema=mainnet -f scripts/fill_domain_service_suppliers.sql
--   psql -v schema=mainnet -v since=2026-01-01 -f scripts/fill_domain_service_suppliers.sql   (only the days from that date)
--
-- Run it on the primary once the indexer with the sets is running. Prints the set rows written per day, then how many
-- days are still not held (0 when done).
\set ON_ERROR_STOP on
\if :{?since}
\else
  \set since '1970-01-01'
\endif
SET search_path = :schema;
SET jit = off;
SELECT format('SELECT %L AS day, rebuild_domain_service_daily_suppliers(%L::date) AS set_rows', r.day, r.day)
FROM (SELECT DISTINCT d.day FROM domain_service_daily_rewards d
      WHERE d.day >= :'since'::date
        AND d.day < (SELECT b.timestamp::date FROM blocks b ORDER BY b.timestamp DESC, b.id DESC LIMIT 1)
        AND NOT EXISTS (SELECT 1 FROM domain_service_daily_suppliers s
                        WHERE s.day = d.day AND s.domain = d.domain AND s.service_id = d.service_id)) r
ORDER BY r.day DESC
\gexec
SELECT count(DISTINCT d.day) AS days_not_held
FROM domain_service_daily_rewards d
WHERE d.day >= :'since'::date
  AND d.day < (SELECT b.timestamp::date FROM blocks b ORDER BY b.timestamp DESC, b.id DESC LIMIT 1)
  AND NOT EXISTS (SELECT 1 FROM domain_service_daily_suppliers s
                  WHERE s.day = d.day AND s.domain = d.domain AND s.service_id = d.service_id);
