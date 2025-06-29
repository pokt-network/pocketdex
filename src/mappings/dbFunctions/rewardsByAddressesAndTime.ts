export function getRewardsByAddressesAndTimeGroupByDate(dbSchema: string): string {
  return `CREATE OR REPLACE FUNCTION ${dbSchema}.get_rewards_by_addresses_and_time_group_by_date(
    addresses TEXT[],
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
                'total_amount', total_amount
            )
            ORDER BY date_truncated
        )
        FROM (
            SELECT 
                date_trunc(trunc_interval, b.timestamp) AS date_truncated,
                SUM(t.amount)::NUMERIC AS total_amount
            FROM ${dbSchema}.mod_to_acct_transfers t
            INNER JOIN ${dbSchema}.blocks b ON b.id = t.block_id
            WHERE t.recipient_id = ANY(addresses) 
                AND b.timestamp BETWEEN start_date AND end_date
            GROUP BY date_truncated
            ORDER BY date_truncated
        ) subquery
    );
END;
$$ LANGUAGE plpgsql STABLE;`
}

export function getRewardsByAddressesAndTime(dbSchema: string): string {
  return `CREATE OR REPLACE FUNCTION ${dbSchema}.get_rewards_by_addresses_and_time(
    addresses TEXT[],
    start_date TIMESTAMP,
    end_date TIMESTAMP
)
RETURNS NUMERIC AS $$
BEGIN
    RETURN (
        SELECT COALESCE(SUM(t.amount), 0)::NUMERIC
        FROM ${dbSchema}.mod_to_acct_transfers t
        INNER JOIN ${dbSchema}.blocks b ON b.id = t.block_id
        WHERE t.recipient_id = ANY(addresses) 
            AND b.timestamp BETWEEN start_date AND end_date
    );
END;
$$ LANGUAGE plpgsql STABLE;`
}
