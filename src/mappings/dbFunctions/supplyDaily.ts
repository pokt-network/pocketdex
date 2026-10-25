export const refreshSupplyDailyFnName = "refresh_supply_daily";

// supply_daily and supply_composition_daily: the supply at the last block of each UTC day that has an upokt supply
// (height), as get_supply_composition_between_dates and get_total_supply_by_day compute it per bucket at its latest
// block (supply.ts), so a range reads one row per day instead of summing balances at each point (~86 ms a point on the
// mainnet replica: 30 days took 2.4 s). Both are written by _supply_at, the one computation the catalog's live points
// use too (get_supply, get_supply_composition). A day with a row is a day held; a held day with no block with an upokt
// supply (mainnet has six days without blocks, 2025-05-01..06) has a NULL height and no composition rows: it has no
// point, and a bucket takes the point of its last day that has one. first_height / last_height are the day's first and
// last block (NULL with no block); they are the same on every row of a day. Plain DDL, hidden from the API.
export function createSupplyDailyTablesFn(dbSchema: string): string {
  return `
CREATE TABLE IF NOT EXISTS ${dbSchema}.supply_daily (
  day                  DATE    NOT NULL PRIMARY KEY,
  height               BIGINT,
  network_supply_upokt NUMERIC,
  unmigrated_upokt     NUMERIC,
  total_supply_upokt   NUMERIC,
  first_height         BIGINT,
  last_height          BIGINT
);

CREATE TABLE IF NOT EXISTS ${dbSchema}.supply_composition_daily (
  day          DATE    NOT NULL,
  label        TEXT    NOT NULL,
  amount_upokt NUMERIC NOT NULL,
  first_height BIGINT,
  last_height  BIGINT,
  PRIMARY KEY (day, label)
);
`;
}

// The supply at block p_height, as get_supply_composition_between_dates computes it at a bucket's latest block:
// network_supply_upokt = the upokt supply recorded at that block (NULL when it has none); unmigrated_upokt = the Morse
// balances not claimed at that block (the unclaimed accounts now plus the ones claimed after it: unstaked balance,
// supplier and application stake); total_supply_upokt = their sum; composition = {label: upokt} of the upokt balances at
// that block, by module account name, 'dao' (the tokenomics dao_reward_address at that block), 'wrapped' (the bridge
// address) or 'others', NULL without p_composition (get_supply: the totals need no balances, which are most of the
// ~60 ms). The point's height is chosen by the caller (_supply_height).
// p_anchor (get_supply's live points): the unmigrated amount from the nearest day the rollup holds at or below the
// height, less the Morse accounts claimed in between, instead of summing every unclaimed account (42,901 rows, 15-30 ms
// on the mainnet replica, 2026-10-20, which is all of get_total_supply_by_day's 30 days): unclaimed now plus claimed
// after a height only loses, from one height to a later one, the accounts claimed between them, whenever it is read.
// The day the rollup holds was written by this function in full, so a live point reads what the rollup would hold; with
// no such day it is computed in full.
export function createSupplyAtFn(dbSchema: string): string {
  return `
CREATE OR REPLACE FUNCTION ${dbSchema}._supply_at(p_height bigint, p_composition boolean DEFAULT true,
  p_anchor boolean DEFAULT false)
RETURNS TABLE(network_supply_upokt numeric, unmigrated_upokt numeric, total_supply_upokt numeric, composition jsonb)
LANGUAGE plpgsql STABLE
SET jit = off
-- planned for the height: a generic plan of the balances read took 160-220 ms a point on the mainnet replica, a custom
-- one 60 ms warm (2026-10-20)
SET plan_cache_mode = force_custom_plan
AS $$
DECLARE
  a_height bigint;
  a_unmigrated numeric;
BEGIN
  IF p_anchor AND NOT p_composition THEN
    SELECT sd.height, sd.unmigrated_upokt INTO a_height, a_unmigrated
    FROM ${dbSchema}.supply_daily sd WHERE sd.height IS NOT NULL AND sd.height <= p_height ORDER BY sd.day DESC LIMIT 1;
  END IF;
  IF a_height IS NOT NULL THEN
    RETURN QUERY
    WITH sp AS (
      SELECT sp.amount
      FROM ${dbSchema}.block_supplies bs
      JOIN ${dbSchema}.supplies sp ON sp.id = bs.supply_id
      WHERE bs.block_id = p_height AND sp.denom = 'upokt'
      LIMIT 1
    ),
    m AS (
      SELECT a_unmigrated - COALESCE(SUM(unstaked_balance_amount), 0) - COALESCE(SUM(supplier_stake_amount), 0)
               - COALESCE(SUM(application_stake_amount), 0) unmigrated
      FROM ${dbSchema}.morse_claimable_accounts WHERE claimed_at_id > a_height AND claimed_at_id <= p_height
    )
    SELECT (SELECT amount FROM sp), m.unmigrated, COALESCE((SELECT amount FROM sp), 0) + m.unmigrated, NULL::jsonb FROM m;
    RETURN;
  END IF;
  RETURN QUERY
  WITH sp AS (
    SELECT sp.amount
    FROM ${dbSchema}.block_supplies bs
    JOIN ${dbSchema}.supplies sp ON sp.id = bs.supply_id
    WHERE bs.block_id = p_height AND sp.denom = 'upokt'
    LIMIT 1
  ),
  u AS (
    SELECT SUM(unstaked_balance_amount) a, SUM(supplier_stake_amount) s, SUM(application_stake_amount) p
    FROM ${dbSchema}.morse_claimable_accounts WHERE claimed = false
  ),
  r AS (
    SELECT SUM(unstaked_balance_amount) a, SUM(supplier_stake_amount) s, SUM(application_stake_amount) p
    FROM ${dbSchema}.morse_claimable_accounts WHERE claimed_at_id > p_height
  ),
  m AS (
    SELECT COALESCE(u.a, 0) + COALESCE(r.a, 0) + COALESCE(u.s, 0) + COALESCE(r.s, 0) + COALESCE(u.p, 0) + COALESCE(r.p, 0) unmigrated
    FROM u CROSS JOIN r
  ),
  c AS (
    SELECT
      COALESCE(
        a.name,
        CASE
          WHEN b.account_id = d.address THEN 'dao'
          WHEN b.account_id = 'pokt14q8l4hlsdf2fqws7n6q6ck3xg5yt2qvgyynnll' THEN 'wrapped'
          ELSE 'others'
        END
      ) AS label,
      SUM(b.amount) AS amount
    FROM ${dbSchema}.balances b
    LEFT JOIN ${dbSchema}.module_accounts a ON a.id = b.account_id
    LEFT JOIN (
      SELECT p.value AS address FROM ${dbSchema}.params p
      WHERE p.namespace = 'tokenomics' AND p.key = 'dao_reward_address' AND p._block_range @> p_height
    ) d ON true
    WHERE b.denom = 'upokt' AND b._block_range @> p_height
    GROUP BY 1
  )
  SELECT (SELECT amount FROM sp), m.unmigrated, COALESCE((SELECT amount FROM sp), 0) + m.unmigrated,
         CASE WHEN p_composition THEN (SELECT jsonb_object_agg(c.label, c.amount) FROM c) END
  FROM m;
END
$$;

-- The last block of [p_from, p_to) (UTC, as blocks.timestamp) that has an upokt supply: the point the old functions read
-- for a bucket (their latest block joined to its upokt supply), backwards on idx_blocks_timestamp_id.
CREATE OR REPLACE FUNCTION ${dbSchema}._supply_height(p_from timestamp, p_to timestamp)
RETURNS bigint
LANGUAGE sql STABLE
SET jit = off
AS $$
  SELECT b.id::bigint FROM ${dbSchema}.blocks b
  WHERE b.timestamp >= p_from AND b.timestamp < p_to
    AND EXISTS (SELECT 1 FROM ${dbSchema}.block_supplies bs JOIN ${dbSchema}.supplies sp ON sp.id = bs.supply_id
                WHERE bs.block_id = b.id AND sp.denom = 'upokt')
  ORDER BY b.timestamp DESC, b.id DESC
  LIMIT 1
$$;
`;
}

// Writes one UTC day again at its point (_supply_height over the day) and returns that height (NULL: the day is held
// with no point). One transaction per day is what the backfill (scripts/fill_supply_daily.sql) runs; the per-block
// refresh calls it when a day closes.
export function rebuildSupplyDailyFn(dbSchema: string): string {
  return `
CREATE OR REPLACE FUNCTION ${dbSchema}.rebuild_supply_daily(p_day date)
RETURNS bigint
LANGUAGE plpgsql
SET jit = off
SET plan_cache_mode = force_custom_plan
AS $$
DECLARE
  v_lo bigint;
  v_hi bigint;
  v_h bigint;
  r record;
BEGIN
  -- the day's blocks through the (timestamp, id) index
  SELECT MIN(id)::bigint, MAX(id)::bigint INTO v_lo, v_hi
  FROM (
    SELECT id FROM ${dbSchema}.blocks
    WHERE timestamp >= p_day AND timestamp < p_day + 1
    OFFSET 0
  ) b;

  DELETE FROM ${dbSchema}.supply_composition_daily WHERE day = p_day;
  DELETE FROM ${dbSchema}.supply_daily WHERE day = p_day;
  v_h := ${dbSchema}._supply_height(p_day::timestamp, (p_day + 1)::timestamp);
  IF v_h IS NULL THEN
    INSERT INTO ${dbSchema}.supply_daily (day, first_height, last_height) VALUES (p_day, v_lo, v_hi);
    RETURN NULL;
  END IF;

  SELECT * INTO r FROM ${dbSchema}._supply_at(v_h);
  INSERT INTO ${dbSchema}.supply_daily (day, height, network_supply_upokt, unmigrated_upokt, total_supply_upokt, first_height, last_height)
  VALUES (p_day, v_h, r.network_supply_upokt, r.unmigrated_upokt, r.total_supply_upokt, v_lo, v_hi);
  INSERT INTO ${dbSchema}.supply_composition_daily (day, label, amount_upokt, first_height, last_height)
  SELECT p_day, e.key, e.value::numeric, v_lo, v_hi FROM jsonb_each_text(r.composition) e;
  RETURN v_h;
END;
$$;
`;
}

// Per block, a probe of the block before it: when that one is on an earlier UTC day, those days closed, and this writes
// them (the days between, which have no block, as held with no point). One ~100 ms computation per day; nothing on the
// other blocks. Rewind-safe: a day whose blocks are indexed again is written again when the next day's first block comes
// back, so its point is the last block it has then. A day before the indexer ran with this is the backfill's.
export function refreshSupplyDailyFn(dbSchema: string): string {
  return `
CREATE OR REPLACE FUNCTION ${dbSchema}.${refreshSupplyDailyFnName}(p_block_id bigint)
RETURNS void
LANGUAGE plpgsql
SET jit = off
SET plan_cache_mode = force_custom_plan
AS $$
DECLARE
  v_day DATE;
  v_prev DATE;
  d DATE;
BEGIN
  SELECT b.timestamp::date INTO v_day FROM ${dbSchema}.blocks b WHERE b.id = p_block_id;
  SELECT b.timestamp::date INTO v_prev FROM ${dbSchema}.blocks b WHERE b.id < p_block_id ORDER BY b.id DESC LIMIT 1;
  IF v_day IS NULL OR v_prev IS NULL OR v_prev >= v_day THEN
    RETURN;
  END IF;
  d := v_prev;
  WHILE d < v_day LOOP
    PERFORM ${dbSchema}.rebuild_supply_daily(d);
    d := d + 1;
  END LOOP;
END;
$$;
`;
}

// The point of each bucket of [p_from, p_to) (UTC, a covered range: get_supply, get_supply_composition): the last day of
// the bucket inside the range that has one. A full UTC day inside the range is the rollup's (kind rollup), not
// considered when it is held with no point, and a gap when the rollup does not hold it (kind gap: the bucket has no
// point, never an earlier one); the partial days at the ends of the range are read live (kind live: _supply_height over
// the part of the day inside the range, then _supply_at at the caller), and not considered when that part has no
// point. bucket_start = the bucket (date_trunc in UTC), height = the point's block.
export function createSupplyPointsFn(dbSchema: string): string {
  return `
CREATE OR REPLACE FUNCTION ${dbSchema}._supply_points(p_from timestamp, p_to timestamp, p_bucket text)
RETURNS TABLE(bucket_start timestamp, day date, kind text, height bigint)
LANGUAGE sql STABLE
SET jit = off
AS $$
  WITH e AS (
    -- fd = the first day, [d1, d2) = the full days
    SELECT date_trunc('day', p_from)::date fd,
           (date_trunc('day', p_from) + CASE WHEN p_from = date_trunc('day', p_from) THEN interval '0' ELSE interval '1 day' END)::date d1,
           date_trunc('day', p_to)::date d2
  ),
  cand AS (
    SELECT g::date AS day, CASE WHEN s.day IS NULL THEN 'gap' ELSE 'rollup' END AS kind, s.height
    FROM e CROSS JOIN generate_series(e.d1, e.d2 - 1, interval '1 day') g
    LEFT JOIN ${dbSchema}.supply_daily s ON s.day = g::date
    WHERE s.day IS NULL OR s.height IS NOT NULL
    UNION ALL
    SELECT w.day, 'live', ${dbSchema}._supply_height(w.a, w.b)
    FROM e CROSS JOIN LATERAL (VALUES
      -- the start of the range to the end of its first day, when that day is not whole and the range goes past it
      (e.fd, p_from, e.d1::timestamp, e.d1 <= e.d2),
      -- the last day's part, from its start or from the start of the range
      (e.d2, greatest(e.d2::timestamp, p_from), p_to, true)) w(day, a, b, ok)
    WHERE w.ok AND w.a < w.b
  )
  SELECT DISTINCT ON (1) date_trunc(p_bucket, c.day::timestamp), c.day, c.kind, c.height
  FROM cand c
  WHERE c.kind <> 'live' OR c.height IS NOT NULL
  ORDER BY 1, c.day DESC
$$;

-- The days of [p_from, p_to) whose bucket has no point because the rollup does not hold them (_supply_points' gaps), as
-- covered_gaps ({from, to}, half-open, consecutive days merged).
CREATE OR REPLACE FUNCTION ${dbSchema}._supply_gaps(p_from timestamp, p_to timestamp, p_bucket text)
RETURNS jsonb
LANGUAGE sql STABLE
SET jit = off
AS $$
  SELECT coalesce(jsonb_agg(jsonb_build_object('from', g.a AT TIME ZONE 'UTC', 'to', g.b AT TIME ZONE 'UTC') ORDER BY g.a), '[]')
  FROM (SELECT min(m.day)::timestamp a, (max(m.day) + 1)::timestamp b
        FROM (SELECT p.day, p.day - (row_number() OVER (ORDER BY p.day))::int AS grp
              FROM ${dbSchema}._supply_points(p_from, p_to, p_bucket) p WHERE p.kind = 'gap') m
        GROUP BY m.grp) g
$$;
`;
}
