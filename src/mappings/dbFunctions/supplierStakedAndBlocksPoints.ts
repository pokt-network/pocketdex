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
$$ LANGUAGE plpgsql STABLE;

COMMENT ON FUNCTION ${dbSchema}.get_suppliers_staked_and_blocks_by_point_json(timestamp, timestamp, text) IS
'Staked suppliers per service and time bucket between two block times, from the per-block staked-supplier counts. Arguments: start_timestamp and end_timestamp = UTC times without a zone, trunc_interval = day or hour. Returns a JSON array as text, newest bucket first: date_truncated, service_id, amount and tokens, the number of staked suppliers and their stake in upokt summed over the blocks of the bucket, and blocks, the number of blocks in it (divide by blocks for an average per block). Null when the range holds no such block.';
`
}
