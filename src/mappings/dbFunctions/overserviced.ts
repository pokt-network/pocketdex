// Used to get the proof, claim and slash data between block timestamps and for the list of delegator addresses
export function getOverservicedsByDelegatorAddressesAndTimesFn (dbSchema: string): string {
  return `CREATE OR REPLACE FUNCTION ${dbSchema}.get_overserviced_by_addresses_and_time(
  addresses TEXT[],
  start_ts TIMESTAMP,
  end_ts TIMESTAMP,
  trunc_interval TEXT
)
RETURNS jsonb
LANGUAGE sql
STABLE
SET jit = off
AS $$
-- the range's first and last block: block time only grows with the height, so the range's events are the ones whose
-- block_id is between them. Overserviced events are few: they are read by supplier and joined to their own block,
-- instead of probing them for every block of the range.
WITH range_blocks AS MATERIALIZED (
    SELECT
      (SELECT id FROM ${dbSchema}.blocks WHERE timestamp >= start_ts ORDER BY timestamp, id LIMIT 1) lo,
      (SELECT id FROM ${dbSchema}.blocks WHERE timestamp <= end_ts ORDER BY timestamp DESC, id DESC LIMIT 1) hi
  ),
  matched_suppliers AS MATERIALIZED (
  	SELECT
      distinct ssc.supplier_id
    FROM ${dbSchema}.supplier_service_configs ssc
    INNER JOIN ${dbSchema}.suppliers s ON s.id = ssc.supplier_id
    CROSS JOIN jsonb_array_elements(ssc.rev_share) AS elem
    WHERE elem->>'address' = ANY (addresses)
      AND upper_inf(ssc._block_range)
      AND s.stake_status = 'Staked'
      AND upper_inf(s._block_range)
  ),
  overserviced as (
	SELECT
    date_trunc(trunc_interval, b.timestamp) AS date_truncated, 
		SUM(o.expected_burn) expected_burn,
		SUM(o.effective_burn) effective_burn
	FROM ${dbSchema}.event_application_overserviceds o
	INNER JOIN ${dbSchema}.blocks b ON b.id = o.block_id
	WHERE o.supplier_id IN (SELECT supplier_id FROM matched_suppliers)
	  AND o.block_id BETWEEN (SELECT lo FROM range_blocks) AND (SELECT hi FROM range_blocks)
	GROUP BY date_truncated
  ORDER BY date_truncated
  )

  SELECT jsonb_agg(
    jsonb_build_object(
      'date_truncated', date_truncated,
      'expected_burn', COALESCE(expected_burn, 0),
      'effective_burn', COALESCE(effective_burn, 0)
    )
  ) FROM overserviced
$$;
`
}
