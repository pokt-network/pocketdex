export const refreshStakedSuppliersDailyFnName = "refresh_staked_suppliers_daily";

// staked_suppliers_daily: the staked suppliers of each UTC day by service, so a range does not sum
// staked_suppliers_by_block_and_services (one row per block and service: get_amount_of_blocks_and_suppliers_by_times
// took ~1.0 s over 30 days and 1.3 s over 90 on the mainnet replica). blocks = the day's blocks with a row for the
// service, suppliers_staked = the sum of their amount (staked suppliers per block); service_id '*' is every block of the
// day (blocks) and every service (suppliers_staked), and is there even with no staked supplier, so a day with rows is a
// day held. first_height / last_height are the blocks of the day the rows hold, as in tx_counts_daily (txCounts.ts).
// suppliers_stake_upokt = the sum of their tokens (the stake of the service's staked suppliers per block, a supplier's
// whole stake in each of its services, as get_suppliers_staked_and_blocks_by_point_json summed it); it came later, so a
// day written before holds it NULL until it is written again (the per-block refresh does that for the day it adds to,
// scripts/fill_staked_suppliers_daily.sql for the others). Plain DDL, hidden from the API (it is not an exposed entity table, closedSchema.ts).
export function createStakedSuppliersDailyTableFn(dbSchema: string): string {
  return `
CREATE TABLE IF NOT EXISTS ${dbSchema}.staked_suppliers_daily (
  day              DATE   NOT NULL,
  service_id       TEXT   NOT NULL,
  blocks           BIGINT NOT NULL DEFAULT 0,
  suppliers_staked BIGINT NOT NULL DEFAULT 0,
  first_height     BIGINT NOT NULL,
  last_height      BIGINT NOT NULL,
  PRIMARY KEY (day, service_id)
);
ALTER TABLE ${dbSchema}.staked_suppliers_daily ADD COLUMN IF NOT EXISTS suppliers_stake_upokt NUMERIC;
`;
}

// The staked suppliers of blocks p_lo..p_hi per service, and '*' (always one row): the blocks of that range and every
// service. The block ids of a day are consecutive but for the ones missing from blocks, which have no
// staked_suppliers_by_block_and_services row (two on mainnet, 694937 and 694938, 2026-10-20), so the id range reads the
// rows _blocks_and_suppliers_by_service reads. suppliers_stake_upokt came later to the rows: a return type CREATE OR
// REPLACE cannot change, so an older one is dropped first.
export function createStakedSuppliersOfBlocksFn(dbSchema: string): string {
  return `
DO $$
DECLARE f regprocedure;
BEGIN
  FOR f IN SELECT p.oid::regprocedure FROM pg_proc p
           WHERE p.pronamespace = '${dbSchema}'::regnamespace AND p.proname = '_staked_suppliers_of_blocks'
             AND NOT ('suppliers_stake_upokt' = ANY(coalesce(p.proargnames, '{}'))) LOOP
    EXECUTE format('DROP FUNCTION %s', f);
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION ${dbSchema}._staked_suppliers_of_blocks(p_lo bigint, p_hi bigint)
RETURNS TABLE(service_id text, blocks bigint, suppliers_staked bigint, suppliers_stake_upokt numeric)
LANGUAGE sql STABLE
SET jit = off
AS $$
  WITH x AS MATERIALIZED (
    SELECT s.service_id, s.amount, s.tokens
    FROM ${dbSchema}.staked_suppliers_by_block_and_services s
    WHERE s.block_id BETWEEN p_lo AND p_hi
  )
  SELECT '*'::text, (SELECT count(*) FROM ${dbSchema}.blocks b WHERE b.id BETWEEN p_lo AND p_hi)::bigint,
         coalesce(sum(x.amount), 0)::bigint, coalesce(sum(x.tokens), 0)::numeric
  FROM x
  UNION ALL
  -- one row per block and service (upsert_staked_suppliers_by_block_and_services), so count(*) counts blocks
  SELECT x.service_id, count(*)::bigint, sum(x.amount)::bigint, sum(x.tokens)::numeric FROM x GROUP BY x.service_id
$$;
`;
}

// Writes one UTC day again from its blocks' rows, first block of the day..p_up_to_block (the whole day when NULL), and
// returns the blocks it read. One transaction per day is what the backfill (scripts/fill_staked_suppliers_daily.sql)
// runs; the per-block refresh calls it when the day's rows do not hold the blocks before the one it adds.
export function rebuildStakedSuppliersDailyFn(dbSchema: string): string {
  return `
CREATE OR REPLACE FUNCTION ${dbSchema}.rebuild_staked_suppliers_daily(p_day date, p_up_to_block bigint DEFAULT NULL)
RETURNS bigint
LANGUAGE plpgsql
SET jit = off
-- planned for each call: the rows read are one day or one block
SET plan_cache_mode = force_custom_plan
AS $$
DECLARE
  v_lo bigint;
  v_hi bigint;
  v_blocks bigint;
BEGIN
  -- the day's blocks through the (timestamp, id) index: MIN/MAX over the table walk the id index from its first block
  SELECT MIN(id)::bigint, MAX(id)::bigint INTO v_lo, v_hi
  FROM (
    SELECT id FROM ${dbSchema}.blocks
    WHERE timestamp >= p_day AND timestamp < p_day + 1
    OFFSET 0
  ) b;

  DELETE FROM ${dbSchema}.staked_suppliers_daily WHERE day = p_day;
  IF v_lo IS NULL THEN
    RETURN 0;
  END IF;
  v_hi := least(v_hi, coalesce(p_up_to_block, v_hi));

  INSERT INTO ${dbSchema}.staked_suppliers_daily (day, service_id, blocks, suppliers_staked, suppliers_stake_upokt, first_height, last_height)
  SELECT p_day, c.service_id, c.blocks, c.suppliers_staked, c.suppliers_stake_upokt, v_lo, v_hi
  FROM ${dbSchema}._staked_suppliers_of_blocks(v_lo, v_hi) c;

  SELECT blocks INTO v_blocks FROM ${dbSchema}.staked_suppliers_daily WHERE day = p_day AND service_id = '*';
  RETURN v_blocks;
END;
$$;
`;
}

// Adds one block's rows to its day, called at the end of upsert_staked_suppliers_by_block_and_services (reports/
// suppliers.ts), once the block's rows are written. Idempotent on a rewind, as refresh_tx_counts_daily: the day is
// rebuilt up to this block when the rows already hold it or a later block of the day, when they do not hold every
// block before it (the first call of a day deployed mid-way, a block indexed out of order), and when a row of the day
// has no suppliers_stake_upokt (written before it was: adding to a NULL would keep it NULL).
export function refreshStakedSuppliersDailyFn(dbSchema: string): string {
  return `
CREATE OR REPLACE FUNCTION ${dbSchema}.${refreshStakedSuppliersDailyFnName}(p_block_id bigint)
RETURNS void
LANGUAGE plpgsql
SET jit = off
SET plan_cache_mode = force_custom_plan
AS $$
DECLARE
  v_day DATE;
  v_first BIGINT;
  v_last BIGINT;
  v_no_stake BOOLEAN;
BEGIN
  SELECT b.timestamp::date INTO v_day FROM ${dbSchema}.blocks b WHERE b.id = p_block_id;
  IF v_day IS NULL THEN
    RETURN;
  END IF;

  SELECT MIN(first_height), MAX(last_height), bool_or(suppliers_stake_upokt IS NULL) INTO v_first, v_last, v_no_stake
  FROM ${dbSchema}.staked_suppliers_daily WHERE day = v_day;

  IF v_last IS NULL THEN
    -- no rows: this block starts the day, or the day is read whole up to it
    IF EXISTS (SELECT 1 FROM ${dbSchema}.blocks b WHERE b.timestamp >= v_day AND b.timestamp < v_day + 1 AND b.id < p_block_id) THEN
      PERFORM ${dbSchema}.rebuild_staked_suppliers_daily(v_day, p_block_id);
      RETURN;
    END IF;
    v_first := p_block_id;
  ELSIF v_last >= p_block_id OR v_no_stake OR EXISTS (
    SELECT 1 FROM ${dbSchema}.blocks b WHERE b.id > v_last AND b.id < p_block_id AND b.timestamp >= v_day
  ) THEN
    PERFORM ${dbSchema}.rebuild_staked_suppliers_daily(v_day, p_block_id);
    RETURN;
  END IF;

  INSERT INTO ${dbSchema}.staked_suppliers_daily (day, service_id, blocks, suppliers_staked, suppliers_stake_upokt, first_height, last_height)
  SELECT v_day, c.service_id, c.blocks, c.suppliers_staked, c.suppliers_stake_upokt, v_first, p_block_id
  FROM ${dbSchema}._staked_suppliers_of_blocks(p_block_id, p_block_id) c
  ON CONFLICT (day, service_id) DO UPDATE
    SET blocks = ${dbSchema}.staked_suppliers_daily.blocks + EXCLUDED.blocks,
        suppliers_staked = ${dbSchema}.staked_suppliers_daily.suppliers_staked + EXCLUDED.suppliers_staked,
        suppliers_stake_upokt = ${dbSchema}.staked_suppliers_daily.suppliers_stake_upokt + EXCLUDED.suppliers_stake_upokt,
        last_height = EXCLUDED.last_height;

  -- every row of the day holds the block, with or without a staked supplier of that service in it
  UPDATE ${dbSchema}.staked_suppliers_daily SET last_height = p_block_id WHERE day = v_day AND last_height < p_block_id;
END;
$$;
`;
}
