// Used to get the proof, claim and slash data between block timestamps and for the list of delegator addresses
export function getDataByDelegatorAddressesAndTimesFn (dbSchema: string): string {
  return `CREATE OR REPLACE FUNCTION ${dbSchema}.get_data_by_delegator_addresses_and_times(
  addresses TEXT[],
  start_ts TIMESTAMP,
  end_ts TIMESTAMP
)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  WITH matched_suppliers AS (
    SELECT DISTINCT ON (elem->>'address') 
      ssc.supplier_id,
      elem->>'address' AS address
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
      mcc.supplier_id,
      COUNT(DISTINCT mcc.id) AS claim_count,
      SUM(r.num_relays) AS claim_relays,
      SUM(r.num_claimed_computed_units) AS claim_computed_units,
      SUM(r.claimed_amount) AS claim_upokt
    FROM ${dbSchema}.msg_create_claims mcc
    INNER JOIN ${dbSchema}.blocks b ON b.id = mcc.block_id
    INNER JOIN ${dbSchema}.relays r ON r.msg_create_claim_id = mcc.id
    WHERE b.timestamp BETWEEN start_ts AND end_ts
    GROUP BY mcc.supplier_id
  ),

  proof_agg AS (
    SELECT 
      ecs.supplier_id,
      COUNT(DISTINCT ecs.id) AS proof_count,
      SUM(ecs.num_relays) AS proof_relays,
      SUM(ecs.num_claimed_computed_units) AS proof_computed_units,
      SUM(ecs.claimed_amount) AS proof_upokt
    FROM ${dbSchema}.event_claim_settleds ecs
    INNER JOIN ${dbSchema}.blocks b ON b.id = ecs.block_id
    WHERE b.timestamp BETWEEN start_ts AND end_ts
    GROUP BY ecs.supplier_id
  ),

  slashed_agg AS (
    SELECT 
      ess.supplier_id,
      SUM(ess.previous_stake_amount - ess.after_stake_amount) AS slashed
    FROM ${dbSchema}.event_supplier_slasheds ess
    INNER JOIN ${dbSchema}.blocks b ON b.id = ess.block_id
    WHERE b.timestamp BETWEEN start_ts AND end_ts
    GROUP BY ess.supplier_id
  )

  SELECT jsonb_agg(
    jsonb_build_object(
      'address', ms.address,
      'proof_relays', COALESCE(p.proof_relays, 0),
      'proof_computed_units', COALESCE(p.proof_computed_units, 0),
      'proof_upokt', COALESCE(p.proof_upokt, 0),
      'proof_amount', COALESCE(p.proof_count, 0),
      'claim_relays', COALESCE(c.claim_relays, 0),
      'claim_computed_units', COALESCE(c.claim_computed_units, 0),
      'claim_upokt', COALESCE(c.claim_upokt, 0),
      'claim_amount', COALESCE(c.claim_count, 0),
      'slashed', COALESCE(s.slashed, 0)
    )
  )
  FROM matched_suppliers ms
  LEFT JOIN claim_agg c ON c.supplier_id = ms.supplier_id
  LEFT JOIN proof_agg p ON p.supplier_id = ms.supplier_id
  LEFT JOIN slashed_agg s ON s.supplier_id = ms.supplier_id;
$$;
`
}
