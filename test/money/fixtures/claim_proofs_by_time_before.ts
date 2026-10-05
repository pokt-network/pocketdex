// get_claim_proofs_data_by_time as main had it before it read claims_by_block, frozen as the oracle the rewrite must
// match.
export function getClaimProofsDataByTimeBefore(dbSchema: string): string {
  return `CREATE OR REPLACE FUNCTION ${dbSchema}.get_claim_proofs_data_by_time_before(
  start_ts TIMESTAMP,
  end_ts TIMESTAMP,
  trunc_interval TEXT
)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
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
  LEFT JOIN expired_proof_agg ep ON ep.date_truncated = d.date_truncated;
$$;
`;
}
