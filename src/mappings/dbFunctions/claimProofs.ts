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
      SUM(mcc.num_claimed_computed_units) AS claim_computed_units,
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
      SUM(ecs.num_claimed_computed_units) AS proof_computed_units,
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
      SUM(ecs.num_claimed_computed_units) AS proof_computed_units,
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
      'proof_computed_units', COALESCE(p.proof_computed_units, 0),
      'proof_upokt', COALESCE(p.proof_upokt, 0),
      'proof_amount', COALESCE(p.proof_count, 0),
      'expired_proof_relays', COALESCE(ep.proof_relays, 0),
      'expired_proof_computed_units', COALESCE(ep.proof_computed_units, 0),
      'expired_proof_upokt', COALESCE(ep.proof_upokt, 0),
      'expired_proof_amount', COALESCE(ep.proof_count, 0),
      'claim_relays', COALESCE(c.claim_relays, 0),
      'claim_computed_units', COALESCE(c.claim_computed_units, 0),
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

export function getClaimProofsDataByTimeFn(dbSchema: string): string {
  return `CREATE OR REPLACE FUNCTION ${dbSchema}.get_claim_proofs_data_by_time(
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
      SUM(mcc.num_claimed_computed_units) AS claim_computed_units,
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
      SUM(ecs.num_claimed_computed_units) AS proof_computed_units,
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
      SUM(ecs.num_claimed_computed_units) AS proof_computed_units,
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
      'proof_computed_units', COALESCE(p.proof_computed_units, 0),
      'proof_upokt', COALESCE(p.proof_upokt, 0),
      'proof_amount', COALESCE(p.proof_count, 0),
      'expired_proof_relays', COALESCE(ep.proof_relays, 0),
      'expired_proof_computed_units', COALESCE(ep.proof_computed_units, 0),
      'expired_proof_upokt', COALESCE(ep.proof_upokt, 0),
      'expired_proof_amount', COALESCE(ep.proof_count, 0),
      'claim_relays', COALESCE(c.claim_relays, 0),
      'claim_computed_units', COALESCE(c.claim_computed_units, 0),
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

COMMENT ON FUNCTION ${dbSchema}.get_claim_proofs_data_by_time(timestamp without time zone, timestamp without time zone, text) IS
'@name getClaimProofsDataByTime
Returns aggregated claim and proof statistics over time intervals for all suppliers.';
`;
}
