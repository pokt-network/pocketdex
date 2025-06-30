export function getRewardsByDate(dbSchema: string): string {
  return `CREATE OR REPLACE FUNCTION ${dbSchema}.get_rewards_by_date(
    start_date TIMESTAMP,
    end_date TIMESTAMP
)
RETURNS JSON AS $$
BEGIN
    RETURN (
        SELECT json_agg(
            json_build_object(
                'date_truncated', date_truncated,
                'relays', relays,
				'computed_units', computed_units,
				'claimed_amount', claimed_amount
            )
            ORDER BY date_truncated
        )
        FROM (
			SELECT
				date_trunc(trunc_interval, b.timestamp) date_truncated,
				SUM(r.relays) relays,
				SUM(r.computed_units) computed_units,
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
