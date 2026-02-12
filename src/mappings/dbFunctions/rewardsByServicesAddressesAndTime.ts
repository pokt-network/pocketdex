// Used to get the proof, claim and slash data between block timestamps and for the list of delegator addresses
export function getRewardsByDelegatorAddressesAndTimesGroupByServiceFn (dbSchema: string): string {
  return `CREATE OR REPLACE FUNCTION ${dbSchema}.get_rewards_by_addresses_and_time_group_by_service(
  addresses TEXT[],
  start_ts TIMESTAMP,
  end_ts TIMESTAMP
)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
WITH matched_suppliers AS (
  	SELECT
      distinct ssc.supplier_id,
      elem->>'address' AS address
    FROM ${dbSchema}.supplier_service_configs ssc
    INNER JOIN ${dbSchema}.suppliers s ON s.id = ssc.supplier_id
    CROSS JOIN jsonb_array_elements(ssc.rev_share) AS elem
    WHERE elem->>'address' = ANY (addresses)
      AND upper_inf(ssc._block_range)
      AND s.stake_status = 'Staked'
      AND upper_inf(s._block_range)
  ),
  services as (
	SELECT
	  distinct ssc.service_id
	FROM ${dbSchema}.supplier_service_configs ssc
	INNER JOIN matched_suppliers ON ssc.supplier_id = matched_suppliers.supplier_id
	WHERE upper_inf(ssc._block_range)
  ),
  rewards as (
	SELECT
		e.service_id,
		SUM(m.amount) net_rewards,
		SUM(e.claimed_amount) gross_rewards,
		SUM(e.num_relays) relays,
		SUM(e.num_estimated_relays) estimated_relays,
		SUM(e.num_claimed_computed_units) computed_units,
		SUM(e.num_estimated_computed_units) estimated_computed_units
	FROM ${dbSchema}.mod_to_acct_transfers m
	INNER JOIN ${dbSchema}.blocks b ON b.id = m.block_id
	INNER JOIN ${dbSchema}.event_claim_settleds e ON e.id = m.event_claim_settled_id
	WHERE m.recipient_id = ANY (addresses) AND
			b.timestamp BETWEEN start_ts AND end_ts
	GROUP BY e.service_id
  )

  SELECT jsonb_agg(
    jsonb_build_object(
      'service_id', service_id,
      'relays', COALESCE(relays, 0),
      'computed_units', COALESCE(computed_units, 0),
      'gross_rewards', COALESCE(gross_rewards, 0),
      'net_rewards', COALESCE(net_rewards, 0)
    )
  ) FROM (
	SELECT 
		COALESCE(s.service_id, r.service_id, '') as service_id,
		r.relays as relays,
		r.computed_units as computed_units,
		r.gross_rewards as gross_rewards,
		r.net_rewards net_rewards
	FROM services s
	LEFT JOIN rewards r ON r.service_id = s.service_id
);
$$;
`
}
