// Claim and proof analytics functions

export function getClaimProofsDataByDelegatorsAndTimeFn(dbSchema: string): string {
  return `CREATE OR REPLACE FUNCTION ${dbSchema}.get_claim_proofs_data_by_delegators_and_time(
  addresses TEXT[],
  start_ts TIMESTAMP,
  end_ts TIMESTAMP,
  trunc_interval TEXT
)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  WITH matched_suppliers AS (
    SELECT DISTINCT
      ssc.supplier_id
    FROM ${dbSchema}.supplier_service_configs ssc
    INNER JOIN ${dbSchema}.suppliers s ON s.id = ssc.supplier_id
    CROSS JOIN jsonb_array_elements(ssc.rev_share) AS elem
    WHERE elem->>'address' = ANY (addresses)
      AND upper_inf(ssc._block_range)
      AND s.stake_status = 'Staked'
      AND upper_inf(s._block_range)
  ),

  claim_agg AS (
    SELECT
      DATE_TRUNC(trunc_interval, b.timestamp) AS date_truncated,
      COUNT(DISTINCT mcc.id) AS claim_count,
      SUM(mcc.num_relays) AS claim_relays,
      SUM(mcc.num_estimated_relays) AS claim_estimated_relays,
      SUM(mcc.num_claimed_computed_units) AS claim_computed_units,
      SUM(mcc.num_estimated_computed_units) AS claim_estimated_computed_units,
      SUM(mcc.claimed_amount) AS claim_upokt
    FROM ${dbSchema}.msg_create_claims mcc
    INNER JOIN ${dbSchema}.blocks b ON b.id = mcc.block_id
    INNER JOIN matched_suppliers ms ON ms.supplier_id = mcc.supplier_id
    WHERE b.timestamp BETWEEN start_ts AND end_ts
    GROUP BY date_truncated
  ),

  proof_agg AS (
    SELECT
      DATE_TRUNC(trunc_interval, b.timestamp) AS date_truncated,
      COUNT(DISTINCT ecs.id) AS proof_count,
      SUM(ecs.num_relays) AS proof_relays,
      SUM(ecs.num_estimated_relays) AS proof_estimated_relays,
      SUM(ecs.num_claimed_computed_units) AS proof_computed_units,
      SUM(ecs.num_estimated_computed_units) AS proof_estimated_computed_units,
      SUM(ecs.claimed_amount) AS proof_upokt
    FROM ${dbSchema}.event_claim_settleds ecs
    INNER JOIN ${dbSchema}.blocks b ON b.id = ecs.block_id
    INNER JOIN matched_suppliers ms ON ms.supplier_id = ecs.supplier_id
    WHERE b.timestamp BETWEEN start_ts AND end_ts
    GROUP BY date_truncated
  ),

  expired_proof_agg AS (
    SELECT
      DATE_TRUNC(trunc_interval, b.timestamp) AS date_truncated,
      COUNT(DISTINCT ecs.id) AS proof_count,
      SUM(ecs.num_relays) AS proof_relays,
      SUM(ecs.num_estimated_relays) AS proof_estimated_relays,
      SUM(ecs.num_claimed_computed_units) AS proof_computed_units,
      SUM(ecs.num_estimated_computed_units) AS proof_estimated_computed_units,
      SUM(ecs.claimed_amount) AS proof_upokt
    FROM ${dbSchema}.event_claim_expireds ecs
    INNER JOIN ${dbSchema}.blocks b ON b.id = ecs.block_id
    INNER JOIN matched_suppliers ms ON ms.supplier_id = ecs.supplier_id
    WHERE b.timestamp BETWEEN start_ts AND end_ts
    GROUP BY date_truncated
  )

  SELECT jsonb_agg(
    jsonb_build_object(
      'date', d.date_truncated,
      'proof_relays', COALESCE(p.proof_relays, 0),
      'proof_estimated_relays', COALESCE(p.proof_estimated_relays, 0),
      'proof_computed_units', COALESCE(p.proof_computed_units, 0),
      'proof_estimated_computed_units', COALESCE(p.proof_estimated_computed_units, 0),
      'proof_upokt', COALESCE(p.proof_upokt, 0),
      'proof_amount', COALESCE(p.proof_count, 0),
      'expired_proof_relays', COALESCE(ep.proof_relays, 0),
      'expired_proof_estimated_relays', COALESCE(ep.proof_estimated_relays, 0),
      'expired_proof_computed_units', COALESCE(ep.proof_computed_units, 0),
      'expired_proof_estimated_computed_units', COALESCE(ep.proof_estimated_computed_units, 0),
      'expired_proof_upokt', COALESCE(ep.proof_upokt, 0),
      'expired_proof_amount', COALESCE(ep.proof_count, 0),
      'claim_relays', COALESCE(c.claim_relays, 0),
      'claim_estimated_relays', COALESCE(c.claim_estimated_relays, 0),
      'claim_computed_units', COALESCE(c.claim_computed_units, 0),
      'claim_estimated_computed_units', COALESCE(c.claim_estimated_computed_units, 0),
      'claim_upokt', COALESCE(c.claim_upokt, 0),
      'claim_amount', COALESCE(c.claim_count, 0)
    )
    ORDER BY d.date_truncated
  )
  FROM (
    -- create a union of all possible date buckets so left joins align
    SELECT date_truncated FROM claim_agg
    UNION
    SELECT date_truncated FROM proof_agg
    UNION
    SELECT date_truncated FROM expired_proof_agg
  ) d
  LEFT JOIN claim_agg c ON c.date_truncated = d.date_truncated
  LEFT JOIN proof_agg p ON p.date_truncated = d.date_truncated
  LEFT JOIN expired_proof_agg ep ON ep.date_truncated = d.date_truncated;
$$;

COMMENT ON FUNCTION ${dbSchema}.get_claim_proofs_data_by_delegators_and_time(text[], timestamp without time zone, timestamp without time zone, text) IS
'@name getClaimProofsDataByDelegatorsAndTime
Returns claim and proof statistics for specific delegator addresses aggregated over time intervals.';
`;
}

// claims_by_block: one row per block with claims created, settled or expired in it, holding what
// get_claim_proofs_data_by_time sums, so the function reads a few thousand rows instead of every claim row of the
// range (~200k a day). Blocks without any of the three have no row.
//
// Plain DDL that SubQuery does not manage, like relay_by_block_and_services: its rewind does not touch it. Every
// block calls write_claims_by_block(height, height) in the block transaction (src/mappings/pocket/reports.ts),
// after the claim entities are written, and the function deletes the heights it writes first, so a reindexed
// block is rewritten. The history is filled once with the same function over ranges of heights
// (scripts/fill_claims_by_block.sql).
//
// claims_by_block_coverage holds covered_from_height: the table is complete from that height to the head. The first
// start sets it to the next height the indexer will write; a write of [from, to] that reaches it (to + 1 >= it) lowers
// it to from, so the fill, which walks down from it, extends it chunk by chunk. get_claim_proofs_data_by_time reads the
// table only for a range without blocks below it, and the raw tables otherwise.
//
// Each row is counted from the raw tables exactly as get_claim_proofs_data_by_time did: COUNT(DISTINCT id) and
// SUM over every row, only for heights present in blocks (the function joined blocks). An event id never spans two
// blocks (it carries the tx hash or the height: src/mappings/utils/ids.ts), so a bucket's distinct count is the sum of
// its blocks' counts. Schema changes are ALTER statements in a PR: CREATE ... IF NOT EXISTS never alters the table.
const COLUMNS = ["timestamp"].concat(
  ...["claim", "settled", "expired"].map((p) =>
    ["count", "relays", "estimated_relays", "computed_units", "estimated_computed_units", "upokt"].map((c) => `${p}_${c}`)
  )
);

export function createClaimsByBlockFn(dbSchema: string): string {
  const s = dbSchema;
  const agg = (table: string) => `SELECT block_id, COUNT(DISTINCT id) AS n, SUM(num_relays) AS relays,
        SUM(num_estimated_relays) AS estimated_relays, SUM(num_claimed_computed_units) AS computed_units,
        SUM(num_estimated_computed_units) AS estimated_computed_units, SUM(claimed_amount) AS upokt
      FROM ${s}.${table} WHERE block_id BETWEEN from_height AND to_height GROUP BY block_id`;
  const cols = (p: string) =>
    `COALESCE(${p}.n, 0), ${p}.relays, ${p}.estimated_relays, ${p}.computed_units, ${p}.estimated_computed_units, ${p}.upokt`;
  return `
CREATE TABLE IF NOT EXISTS ${s}.claims_by_block (
  block_id                         NUMERIC   PRIMARY KEY,
  timestamp                        TIMESTAMP NOT NULL,
  claim_count                      BIGINT    NOT NULL,
  claim_relays                     NUMERIC,
  claim_estimated_relays           NUMERIC,
  claim_computed_units             NUMERIC,
  claim_estimated_computed_units   NUMERIC,
  claim_upokt                      NUMERIC,
  settled_count                    BIGINT    NOT NULL,
  settled_relays                   NUMERIC,
  settled_estimated_relays         NUMERIC,
  settled_computed_units           NUMERIC,
  settled_estimated_computed_units NUMERIC,
  settled_upokt                    NUMERIC,
  expired_count                    BIGINT    NOT NULL,
  expired_relays                   NUMERIC,
  expired_estimated_relays         NUMERIC,
  expired_computed_units           NUMERIC,
  expired_estimated_computed_units NUMERIC,
  expired_upokt                    NUMERIC
);
CREATE INDEX IF NOT EXISTS claims_by_block_timestamp_idx ON ${s}.claims_by_block (timestamp);
COMMENT ON TABLE ${s}.claims_by_block IS E'@omit';
CREATE TABLE IF NOT EXISTS ${s}.claims_by_block_coverage (
  singleton           BOOLEAN PRIMARY KEY DEFAULT true CHECK (singleton),
  covered_from_height BIGINT  NOT NULL
);
-- on the first start, at a height the indexer has not written yet: the next one it writes
INSERT INTO ${s}.claims_by_block_coverage (covered_from_height)
SELECT COALESCE(max(id), 0)::bigint + 1 FROM ${s}.blocks
ON CONFLICT (singleton) DO NOTHING;
COMMENT ON TABLE ${s}.claims_by_block_coverage IS E'@omit';

-- Rewrites the rows of the heights [from_height, to_height] from the raw tables, and lowers the coverage to
-- from_height when the range reaches it; returns how many rows it wrote.
CREATE OR REPLACE FUNCTION ${s}.write_claims_by_block(from_height BIGINT, to_height BIGINT)
RETURNS INTEGER
LANGUAGE plpgsql
AS $$
DECLARE written INTEGER;
BEGIN
  DELETE FROM ${s}.claims_by_block WHERE block_id BETWEEN from_height AND to_height;
  INSERT INTO ${s}.claims_by_block
  SELECT b.id, b.timestamp, ${cols("c")}, ${cols("p")}, ${cols("e")}
  FROM ${s}.blocks b
  LEFT JOIN (${agg("msg_create_claims")}) c ON c.block_id = b.id
  LEFT JOIN (${agg("event_claim_settleds")}) p ON p.block_id = b.id
  LEFT JOIN (${agg("event_claim_expireds")}) e ON e.block_id = b.id
  WHERE b.id BETWEEN from_height AND to_height
    AND (c.block_id IS NOT NULL OR p.block_id IS NOT NULL OR e.block_id IS NOT NULL)
  -- the indexer and the history fill may write the same height at once; both write the same values
  ON CONFLICT (block_id) DO UPDATE SET (${COLUMNS.join(", ")}) = (${COLUMNS.map((c) => `EXCLUDED.${c}`).join(", ")});
  GET DIAGNOSTICS written = ROW_COUNT;
  UPDATE ${s}.claims_by_block_coverage SET covered_from_height = from_height
  WHERE from_height < covered_from_height AND to_height + 1 >= covered_from_height;
  RETURN written;
END;
$$;
COMMENT ON FUNCTION ${s}.write_claims_by_block(BIGINT, BIGINT) IS E'@omit';
`;
}

export function getClaimProofsDataByTimeFn(dbSchema: string): string {
  return `CREATE OR REPLACE FUNCTION ${dbSchema}.get_claim_proofs_data_by_time(
  start_ts TIMESTAMP,
  end_ts TIMESTAMP,
  trunc_interval TEXT
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
  -- claims_by_block only when it holds every block of the range (see createClaimsByBlockFn)
  IF NOT EXISTS (
    SELECT 1 FROM ${dbSchema}.blocks b, ${dbSchema}.claims_by_block_coverage cv
    WHERE b.id < cv.covered_from_height AND b.timestamp BETWEEN start_ts AND end_ts
  ) THEN
    RETURN (
      -- claims_by_block holds each block's counts and sums (createClaimsByBlockFn); "proof" is a settled claim
      WITH buckets AS (
        SELECT
          DATE_TRUNC(trunc_interval, cb.timestamp) AS date_truncated,
          SUM(cb.claim_count) AS claim_count,
          SUM(cb.claim_relays) AS claim_relays,
          SUM(cb.claim_estimated_relays) AS claim_estimated_relays,
          SUM(cb.claim_computed_units) AS claim_computed_units,
          SUM(cb.claim_estimated_computed_units) AS claim_estimated_computed_units,
          SUM(cb.claim_upokt) AS claim_upokt,
          SUM(cb.settled_count) AS settled_count,
          SUM(cb.settled_relays) AS settled_relays,
          SUM(cb.settled_estimated_relays) AS settled_estimated_relays,
          SUM(cb.settled_computed_units) AS settled_computed_units,
          SUM(cb.settled_estimated_computed_units) AS settled_estimated_computed_units,
          SUM(cb.settled_upokt) AS settled_upokt,
          SUM(cb.expired_count) AS expired_count,
          SUM(cb.expired_relays) AS expired_relays,
          SUM(cb.expired_estimated_relays) AS expired_estimated_relays,
          SUM(cb.expired_computed_units) AS expired_computed_units,
          SUM(cb.expired_estimated_computed_units) AS expired_estimated_computed_units,
          SUM(cb.expired_upokt) AS expired_upokt
        FROM ${dbSchema}.claims_by_block cb
        WHERE cb.timestamp BETWEEN start_ts AND end_ts
        GROUP BY 1
      )
      SELECT jsonb_agg(
        jsonb_build_object(
          'date', d.date_truncated,
          'proof_relays', COALESCE(v.settled_relays, 0),
          'proof_estimated_relays', COALESCE(v.settled_estimated_relays, 0),
          'proof_computed_units', COALESCE(v.settled_computed_units, 0),
          'proof_estimated_computed_units', COALESCE(v.settled_estimated_computed_units, 0),
          'proof_upokt', COALESCE(v.settled_upokt, 0),
          'proof_amount', COALESCE(v.settled_count, 0),
          'expired_proof_relays', COALESCE(v.expired_relays, 0),
          'expired_proof_estimated_relays', COALESCE(v.expired_estimated_relays, 0),
          'expired_proof_computed_units', COALESCE(v.expired_computed_units, 0),
          'expired_proof_estimated_computed_units', COALESCE(v.expired_estimated_computed_units, 0),
          'expired_proof_upokt', COALESCE(v.expired_upokt, 0),
          'expired_proof_amount', COALESCE(v.expired_count, 0),
          'claim_relays', COALESCE(v.claim_relays, 0),
          'claim_estimated_relays', COALESCE(v.claim_estimated_relays, 0),
          'claim_computed_units', COALESCE(v.claim_computed_units, 0),
          'claim_estimated_computed_units', COALESCE(v.claim_estimated_computed_units, 0),
          'claim_upokt', COALESCE(v.claim_upokt, 0),
          'claim_amount', COALESCE(v.claim_count, 0)
        )
        ORDER BY d.date_truncated
      )
      -- each bucket joined to its own sums by =, as the previous version joined its date list: a NULL bucket
      -- (trunc_interval NULL) answers zeros
      FROM buckets d
      LEFT JOIN buckets v ON v.date_truncated = d.date_truncated
    );
  END IF;
  -- the range has blocks the table does not hold yet: the previous body, over the raw tables
  RETURN (
    WITH claim_agg AS (
      SELECT
        DATE_TRUNC(trunc_interval, b.timestamp) AS date_truncated,
        COUNT(DISTINCT mcc.id) AS claim_count,
        SUM(mcc.num_relays) AS claim_relays,
        SUM(mcc.num_estimated_relays) AS claim_estimated_relays,
        SUM(mcc.num_claimed_computed_units) AS claim_computed_units,
        SUM(mcc.num_estimated_computed_units) AS claim_estimated_computed_units,
        SUM(mcc.claimed_amount) AS claim_upokt
      FROM ${dbSchema}.msg_create_claims mcc
      INNER JOIN ${dbSchema}.blocks b ON b.id = mcc.block_id
      WHERE b.timestamp BETWEEN start_ts AND end_ts
      GROUP BY date_truncated
    ),

    proof_agg AS (
      SELECT
        DATE_TRUNC(trunc_interval, b.timestamp) AS date_truncated,
        COUNT(DISTINCT ecs.id) AS proof_count,
        SUM(ecs.num_relays) AS proof_relays,
        SUM(ecs.num_estimated_relays) AS proof_estimated_relays,
        SUM(ecs.num_claimed_computed_units) AS proof_computed_units,
        SUM(ecs.num_estimated_computed_units) AS proof_estimated_computed_units,
        SUM(ecs.claimed_amount) AS proof_upokt
      FROM ${dbSchema}.event_claim_settleds ecs
      INNER JOIN ${dbSchema}.blocks b ON b.id = ecs.block_id
      WHERE b.timestamp BETWEEN start_ts AND end_ts
      GROUP BY date_truncated
    ),

    expired_proof_agg AS (
      SELECT
        DATE_TRUNC(trunc_interval, b.timestamp) AS date_truncated,
        COUNT(DISTINCT ecs.id) AS proof_count,
        SUM(ecs.num_relays) AS proof_relays,
        SUM(ecs.num_estimated_relays) AS proof_estimated_relays,
        SUM(ecs.num_claimed_computed_units) AS proof_computed_units,
        SUM(ecs.num_estimated_computed_units) AS proof_estimated_computed_units,
        SUM(ecs.claimed_amount) AS proof_upokt
      FROM ${dbSchema}.event_claim_expireds ecs
      INNER JOIN ${dbSchema}.blocks b ON b.id = ecs.block_id
      WHERE b.timestamp BETWEEN start_ts AND end_ts
      GROUP BY date_truncated
    )

    SELECT jsonb_agg(
      jsonb_build_object(
        'date', d.date_truncated,
        'proof_relays', COALESCE(p.proof_relays, 0),
        'proof_estimated_relays', COALESCE(p.proof_estimated_relays, 0),
        'proof_computed_units', COALESCE(p.proof_computed_units, 0),
        'proof_estimated_computed_units', COALESCE(p.proof_estimated_computed_units, 0),
        'proof_upokt', COALESCE(p.proof_upokt, 0),
        'proof_amount', COALESCE(p.proof_count, 0),
        'expired_proof_relays', COALESCE(ep.proof_relays, 0),
        'expired_proof_estimated_relays', COALESCE(ep.proof_estimated_relays, 0),
        'expired_proof_computed_units', COALESCE(ep.proof_computed_units, 0),
        'expired_proof_estimated_computed_units', COALESCE(ep.proof_estimated_computed_units, 0),
        'expired_proof_upokt', COALESCE(ep.proof_upokt, 0),
        'expired_proof_amount', COALESCE(ep.proof_count, 0),
        'claim_relays', COALESCE(c.claim_relays, 0),
        'claim_estimated_relays', COALESCE(c.claim_estimated_relays, 0),
        'claim_computed_units', COALESCE(c.claim_computed_units, 0),
        'claim_estimated_computed_units', COALESCE(c.claim_estimated_computed_units, 0),
        'claim_upokt', COALESCE(c.claim_upokt, 0),
        'claim_amount', COALESCE(c.claim_count, 0)
      )
      ORDER BY d.date_truncated
    )
    FROM (
      -- create a union of all possible date buckets so left joins align
      SELECT date_truncated FROM claim_agg
      UNION
      SELECT date_truncated FROM proof_agg
      UNION
      SELECT date_truncated FROM expired_proof_agg
    ) d
    LEFT JOIN claim_agg c ON c.date_truncated = d.date_truncated
    LEFT JOIN proof_agg p ON p.date_truncated = d.date_truncated
    LEFT JOIN expired_proof_agg ep ON ep.date_truncated = d.date_truncated
  );
END;
$$;

COMMENT ON FUNCTION ${dbSchema}.get_claim_proofs_data_by_time(timestamp without time zone, timestamp without time zone, text) IS
'@name getClaimProofsDataByTime
Returns aggregated claim and proof statistics over time intervals for all suppliers.';
`;
}
