export function getRewardsByDate(dbSchema: string): string {
  return `CREATE OR REPLACE FUNCTION ${dbSchema}.get_rewards_by_date(
    start_date TIMESTAMP,
    end_date TIMESTAMP,
    trunc_interval TEXT  -- 'day' or 'hour'
)
RETURNS JSON AS $$
BEGIN
    RETURN (
        SELECT json_agg(
            json_build_object(
                'date_truncated', date_truncated,
                'relays', relays,
                'estimated_relays', estimated_relays,
				        'computed_units', computed_units,
				        'estimated_computed_units', estimated_computed_units,
				        'claimed_amount', claimed_amount
            )
            ORDER BY date_truncated
        )
        FROM (
			SELECT
				date_trunc(trunc_interval, b.timestamp) date_truncated,
				SUM(r.relays) relays,
				SUM(r.estimated_relays) estimated_relays,
				SUM(r.computed_units) computed_units,
				SUM(r.estimated_computed_units) estimated_computed_units,
				SUM(r.claimed_upokt) claimed_amount
			FROM ${dbSchema}.relay_by_block_and_services r
			INNER JOIN ${dbSchema}.blocks b on b.id = r.block_id
			WHERE b.timestamp BETWEEN start_date AND end_date
			GROUP BY date_truncated
			ORDER BY date_truncated ASC
        ) subquery
    );
END;
$$ LANGUAGE plpgsql STABLE;`
}

// Used to get supplier count and total staked tokens for a list of domains
export function getSupplierStatsByDomainsFn (dbSchema: string): string {
  return `CREATE OR REPLACE FUNCTION ${dbSchema}.get_supplier_stats_by_domains(
  domains TEXT[]
)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
WITH matched_suppliers AS (
    SELECT DISTINCT ssc.supplier_id
    FROM ${dbSchema}.supplier_service_configs ssc
    CROSS JOIN jsonb_array_elements(ssc.endpoints) AS endpoint
    WHERE EXISTS (
      SELECT 1
      FROM unnest(domains) AS domain
      WHERE
        substring(endpoint->>'url' FROM 'https?://([^/:]+)') = domain
        OR substring(endpoint->>'url' FROM 'https?://([^/:]+)') LIKE '%.' || domain
    )
    AND upper_inf(ssc._block_range)
  )

  SELECT jsonb_build_object(
    'suppliers_count', COALESCE(COUNT(*), 0),
    'total_staked_tokens', COALESCE(SUM(s.stake_amount), 0)
  )
  FROM ${dbSchema}.suppliers s
  INNER JOIN matched_suppliers ms ON s.id = ms.supplier_id
  WHERE upper_inf(s._block_range);
$$;
`
}

// Used to get the proof, claim and slash data between block timestamps and for the list of supplier domains.
// Reads pre-computed daily summaries from domain_service_daily_rewards for relay/reward/supplier aggregates.
// staked_suppliers per service comes from the most recent day's record in the queried range.
export function getRewardsByDomainsAndTimesGroupByServiceFn (dbSchema: string): string {
  return `CREATE OR REPLACE FUNCTION ${dbSchema}.get_rewards_by_domains_and_time_group_by_service(
  domains TEXT[],
  start_ts TIMESTAMP,
  end_ts TIMESTAMP
)
RETURNS jsonb
LANGUAGE sql
STABLE
SET jit = off
AS $$
WITH reward_data AS (
  SELECT
    dsr.service_id,
    SUM(dsr.relays)                   AS relays,
    SUM(dsr.estimated_relays)         AS estimated_relays,
    SUM(dsr.computed_units)           AS computed_units,
    SUM(dsr.estimated_computed_units) AS estimated_computed_units,
    SUM(dsr.gross_rewards)            AS gross_rewards
  FROM ${dbSchema}.domain_service_daily_rewards dsr
  WHERE dsr.domain = ANY(domains)
    AND dsr.day BETWEEN start_ts::date AND end_ts::date
  GROUP BY dsr.service_id
),
latest_staked AS (
  SELECT DISTINCT ON (dsr.service_id)
    dsr.service_id,
    dsr.suppliers_count
  FROM ${dbSchema}.domain_service_daily_rewards dsr
  WHERE dsr.domain = ANY(domains)
    AND dsr.day BETWEEN start_ts::date AND end_ts::date
  ORDER BY dsr.service_id, dsr.day DESC
)
SELECT jsonb_build_object(
  'services', COALESCE(jsonb_agg(
    jsonb_build_object(
      'service_id', rd.service_id,
      'staked_suppliers', COALESCE(ls.suppliers_count, 0),
      'relays', COALESCE(rd.relays, 0),
      'estimated_relays', COALESCE(rd.estimated_relays, 0),
      'computed_units', COALESCE(rd.computed_units, 0),
      'estimated_computed_units', COALESCE(rd.estimated_computed_units, 0),
      'gross_rewards', COALESCE(rd.gross_rewards, 0)
    )
  ), '[]'::jsonb)
)
FROM reward_data rd
LEFT JOIN latest_staked ls ON ls.service_id = rd.service_id;
$$;
`
}

// Used to get the proof, claim and slash data between block timestamps and for the list of supplier operator addresses
export function getRewardsByOperatorAddressesAndTimesGroupByServiceFn (dbSchema: string): string {
  return `CREATE OR REPLACE FUNCTION ${dbSchema}.get_rewards_by_suppliers_and_time_group_by_service(
  operator_addresses TEXT[],
  start_ts TIMESTAMP,
  end_ts TIMESTAMP
)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
WITH services as (
	SELECT distinct ssc.service_id
	FROM ${dbSchema}.supplier_service_configs ssc
	WHERE ssc.supplier_id = ANY(operator_addresses)
	  AND upper_inf(ssc._block_range)
  ),
  rewards as (
	SELECT
		e.service_id,
		SUM(e.claimed_amount) gross_rewards,
		SUM(e.num_relays) relays,
		SUM(e.num_estimated_relays) estimated_relays,
		SUM(e.num_claimed_computed_units) computed_units,
		SUM(e.num_estimated_computed_units) estimated_computed_units
	FROM ${dbSchema}.event_claim_settleds e
	INNER JOIN ${dbSchema}.blocks b ON b.id = e.block_id
	WHERE e.supplier_id = ANY(operator_addresses)
	  AND b.timestamp BETWEEN start_ts AND end_ts
	GROUP BY e.service_id
  )

  SELECT jsonb_agg(
    jsonb_build_object(
      'service_id', service_id,
      'relays', COALESCE(relays, 0),
      'estimated_relays', COALESCE(estimated_relays, 0),
      'computed_units', COALESCE(computed_units, 0),
      'estimated_computed_units', COALESCE(estimated_computed_units, 0),
      'gross_rewards', COALESCE(gross_rewards, 0)
    )
  ) FROM (
	SELECT 
		COALESCE(s.service_id, r.service_id, '') as service_id,
		r.relays as relays,
		r.estimated_relays as estimated_relays,
		r.computed_units as computed_units,
		r.estimated_computed_units as estimated_computed_units,
		r.gross_rewards as gross_rewards
	FROM services s
	LEFT JOIN rewards r ON r.service_id = s.service_id
);
$$;
`
}
