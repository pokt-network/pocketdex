export function getRelaysByServicePerPointJsonFn(dbSchema: string): string {
  return `CREATE OR REPLACE FUNCTION ${dbSchema}.get_relays_by_service_per_point_json(
    start_timestamp TIMESTAMP,
    end_timestamp TIMESTAMP,
    trunc_interval TEXT  -- 'day' or 'hour'
)
RETURNS TEXT AS $$
BEGIN
    RETURN (
        SELECT json_agg(
            json_build_object(
                'date_truncated', date_truncated,
                'service_id', service_id,
                'relays', relays,
                'estimated_relays', estimated_relays,
                'computed_units', computed_units,
                'estimated_computed_units', estimated_computed_units,
                'claimed_upokt', claimed_upokt
            )
            ORDER BY date_truncated
        )::text
        FROM (
            SELECT 
                date_trunc(trunc_interval, b.timestamp) AS date_truncated, 
                r.service_id, 
                SUM(r.relays)::NUMERIC AS relays, 
                SUM(r.estimated_relays)::NUMERIC AS estimated_relays, 
                SUM(r.computed_units)::NUMERIC AS computed_units, 
                SUM(r.estimated_computed_units)::NUMERIC AS estimated_computed_units, 
                SUM(r.claimed_upokt)::NUMERIC AS claimed_upokt
            FROM ${dbSchema}.relay_by_block_and_services r
            INNER JOIN ${dbSchema}.blocks b ON b.id = r.block_id
            WHERE b.timestamp BETWEEN start_timestamp AND end_timestamp
            GROUP BY date_truncated, r.service_id
            ORDER BY date_truncated
        ) subquery
    );
END;
$$ LANGUAGE plpgsql STABLE;

COMMENT ON FUNCTION ${dbSchema}.get_relays_by_service_per_point_json(timestamp, timestamp, text) IS
'Relays per service and time bucket between two block times, from the per-block relay totals of the claims. Arguments: start_timestamp and end_timestamp = UTC times without a zone, trunc_interval = day or hour. Returns a JSON array as text, ordered by date: date_truncated, service_id, relays, estimated_relays, computed_units, estimated_computed_units and claimed_upokt (the claimed amount, in upokt). Null when the range holds no block with relays.';
`
}
