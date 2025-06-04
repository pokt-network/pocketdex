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
                'computed_units', computed_units,
                'claimed_upokt', claimed_upokt
            )
            ORDER BY date_truncated
        )::text
        FROM (
            SELECT 
                date_trunc(trunc_interval, b.timestamp) AS date_truncated, 
                r.service_id, 
                SUM(r.relays)::NUMERIC AS relays, 
                SUM(r.computed_units)::NUMERIC AS computed_units, 
                SUM(r.claimed_upokt)::NUMERIC AS claimed_upokt
            FROM ${dbSchema}.relay_by_block_and_services r
            INNER JOIN ${dbSchema}.blocks b ON b.id = r.block_id
            WHERE b.timestamp BETWEEN start_timestamp AND end_timestamp
            GROUP BY date_truncated, r.service_id
            ORDER BY date_truncated
        ) subquery
    );
END;
$$ LANGUAGE plpgsql STABLE;`
}
