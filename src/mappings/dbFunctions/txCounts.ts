export const refreshTxCountsDailyFnName = "refresh_tx_counts_daily";

// tx_counts_daily: the transactions of each UTC day, by message type and status, so a total does not count the
// transactions table (44.7M rows on mainnet: an unfiltered totalCount took 4.7 s to over 30 s). A transaction counts
// once under each message type it holds (amount_of_messages) and once under '*', which is every transaction;
// status is 'success' (code 0) or 'failed'. first_height / last_height are the blocks of the day the rows hold: the
// same on every row of a day, and the day is complete when they are its first and last block. Plain DDL, hidden from the
// API (it is not an exposed entity table, closedSchema.ts).
export function createTxCountsDailyTableFn(dbSchema: string): string {
  return `
CREATE TABLE IF NOT EXISTS ${dbSchema}.tx_counts_daily (
  day          DATE   NOT NULL,
  msg_type     TEXT   NOT NULL,
  status       TEXT   NOT NULL,
  txs          BIGINT NOT NULL DEFAULT 0,
  first_height BIGINT NOT NULL,
  last_height  BIGINT NOT NULL,
  PRIMARY KEY (day, msg_type, status)
);
`;
}

// The counts of the transactions of blocks p_lo..p_hi, one pass over them: per (message type, status), with '*' for
// every transaction. A day of 163k transactions took 250 ms on the mainnet replica (2026-10-10), one block 1 to 3 ms.
export function createTxCountsOfBlocksFn(dbSchema: string): string {
  return `
CREATE OR REPLACE FUNCTION ${dbSchema}._tx_counts_of_blocks(p_lo bigint, p_hi bigint)
RETURNS TABLE(msg_type text, status text, txs bigint)
LANGUAGE sql STABLE
SET jit = off
AS $$
  WITH x AS MATERIALIZED (
    SELECT t.code = 0 AS ok, t.amount_of_messages AS m
    FROM ${dbSchema}.transactions t
    WHERE t.block_id BETWEEN p_lo AND p_hi AND upper_inf(t._block_range)
  )
  SELECT '*'::text, CASE WHEN ok THEN 'success' ELSE 'failed' END, count(*)::bigint FROM x GROUP BY ok
  UNION ALL
  SELECT mt.type, CASE WHEN x.ok THEN 'success' ELSE 'failed' END, count(*)::bigint
  FROM x CROSS JOIN LATERAL (SELECT DISTINCT e->>'type' AS type FROM jsonb_array_elements(x.m) e) mt
  WHERE mt.type IS NOT NULL
  GROUP BY mt.type, x.ok
$$;
`;
}

// Writes one UTC day again from its transactions, blocks first block of the day..p_up_to_block (the whole day when
// NULL), and returns the transactions it counted. One transaction per day is what the backfill
// (scripts/fill_tx_counts_daily.sql) runs; the per-block refresh calls it when the day's rows do not hold the blocks
// before the one it adds. The '*' rows exist for both statuses even with no transaction, so a day with rows is a day
// held.
export function rebuildTxCountsDailyFn(dbSchema: string): string {
  return `
CREATE OR REPLACE FUNCTION ${dbSchema}.rebuild_tx_counts_daily(p_day date, p_up_to_block bigint DEFAULT NULL)
RETURNS bigint
LANGUAGE plpgsql
SET jit = off
-- planned for each call: the transactions read is one day or one block
SET plan_cache_mode = force_custom_plan
AS $$
DECLARE
  v_lo bigint;
  v_hi bigint;
  v_total bigint;
BEGIN
  -- the day's blocks through the (timestamp, id) index: MIN/MAX over the table walk the id index from its first block
  SELECT MIN(id)::bigint, MAX(id)::bigint INTO v_lo, v_hi
  FROM (
    SELECT id FROM ${dbSchema}.blocks
    WHERE timestamp >= p_day AND timestamp < p_day + 1
    OFFSET 0
  ) b;

  DELETE FROM ${dbSchema}.tx_counts_daily WHERE day = p_day;
  IF v_lo IS NULL THEN
    RETURN 0;
  END IF;
  v_hi := least(v_hi, coalesce(p_up_to_block, v_hi));

  INSERT INTO ${dbSchema}.tx_counts_daily (day, msg_type, status, txs, first_height, last_height)
  SELECT p_day, c.msg_type, c.status, c.txs, v_lo, v_hi FROM ${dbSchema}._tx_counts_of_blocks(v_lo, v_hi) c;

  INSERT INTO ${dbSchema}.tx_counts_daily (day, msg_type, status, txs, first_height, last_height)
  SELECT p_day, '*', s, 0, v_lo, v_hi FROM unnest(ARRAY['success', 'failed']) s
  ON CONFLICT (day, msg_type, status) DO NOTHING;

  SELECT coalesce(sum(txs), 0) INTO v_total FROM ${dbSchema}.tx_counts_daily WHERE day = p_day AND msg_type = '*';
  RETURN v_total;
END;
$$;
`;
}

// Adds one block's transactions to its day. Idempotent on a rewind: the block's day is rebuilt up to this block when
// the rows already hold it or a later block of the day, and when they do not hold every block before it (the first call
// of a day deployed mid-way, a block indexed out of order); otherwise the cost of a block does not grow through the day.
export function refreshTxCountsDailyFn(dbSchema: string): string {
  return `
CREATE OR REPLACE FUNCTION ${dbSchema}.${refreshTxCountsDailyFnName}(p_block_id bigint)
RETURNS void
LANGUAGE plpgsql
SET jit = off
SET plan_cache_mode = force_custom_plan
AS $$
DECLARE
  v_day DATE;
  v_first BIGINT;
  v_last BIGINT;
BEGIN
  SELECT b.timestamp::date INTO v_day FROM ${dbSchema}.blocks b WHERE b.id = p_block_id;
  IF v_day IS NULL THEN
    RETURN;
  END IF;

  SELECT MIN(first_height), MAX(last_height) INTO v_first, v_last
  FROM ${dbSchema}.tx_counts_daily WHERE day = v_day;

  IF v_last IS NULL THEN
    -- no rows: this block starts the day, or the day is read whole up to it
    IF EXISTS (SELECT 1 FROM ${dbSchema}.blocks b WHERE b.timestamp >= v_day AND b.timestamp < v_day + 1 AND b.id < p_block_id) THEN
      PERFORM ${dbSchema}.rebuild_tx_counts_daily(v_day, p_block_id);
      RETURN;
    END IF;
    v_first := p_block_id;
  ELSIF v_last >= p_block_id OR EXISTS (
    SELECT 1 FROM ${dbSchema}.blocks b WHERE b.id > v_last AND b.id < p_block_id AND b.timestamp >= v_day
  ) THEN
    PERFORM ${dbSchema}.rebuild_tx_counts_daily(v_day, p_block_id);
    RETURN;
  END IF;

  INSERT INTO ${dbSchema}.tx_counts_daily (day, msg_type, status, txs, first_height, last_height)
  SELECT v_day, c.msg_type, c.status, c.txs, v_first, p_block_id FROM ${dbSchema}._tx_counts_of_blocks(p_block_id, p_block_id) c
  ON CONFLICT (day, msg_type, status) DO UPDATE
    SET txs = ${dbSchema}.tx_counts_daily.txs + EXCLUDED.txs, last_height = EXCLUDED.last_height;

  INSERT INTO ${dbSchema}.tx_counts_daily (day, msg_type, status, txs, first_height, last_height)
  SELECT v_day, '*', s, 0, v_first, p_block_id FROM unnest(ARRAY['success', 'failed']) s
  ON CONFLICT (day, msg_type, status) DO NOTHING;

  -- every row of the day holds the block, with or without a transaction of that type in it
  UPDATE ${dbSchema}.tx_counts_daily SET last_height = p_block_id WHERE day = v_day AND last_height < p_block_id;
END;
$$;
`;
}
