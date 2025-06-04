// Used to get the amount of supplier staked, tokens staked and blocks by date and service between blocks timestamps
export function getSuppliersStakedAndBlocksByPointJsonFn(dbSchema: string): string {
 return `CREATE OR REPLACE FUNCTION ${dbSchema}.get_suppliers_staked_and_blocks_by_point_json(
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
                'amount', amount,
                'tokens', tokens,
                'blocks', blocks
            )
            ORDER BY date_truncated DESC, amount DESC
        )::text
        FROM (
            SELECT 
                date_trunc(trunc_interval, b.timestamp) date_truncated, 
                s.service_id, 
                SUM(s.amount)::NUMERIC amount, 
                SUM(s.tokens)::NUMERIC tokens, 
                COUNT(b.id)::NUMERIC blocks
            FROM ${dbSchema}.staked_suppliers_by_block_and_services s
            INNER JOIN ${dbSchema}.blocks b ON b.id = s.block_id
            WHERE b.timestamp BETWEEN start_timestamp AND end_timestamp
            GROUP BY date_truncated, s.service_id
            ORDER BY date_truncated DESC, amount DESC
        ) subquery
    );
END;
$$ LANGUAGE plpgsql STABLE;`
}
