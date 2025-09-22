export function getTotalSupplyByDay(dbSchema: string): string {
  return `CREATE OR REPLACE FUNCTION ${dbSchema}.get_total_supply_by_day(
    start_date TIMESTAMP,
    end_date TIMESTAMP
)
RETURNS JSON AS $$
BEGIN
    RETURN (
        SELECT json_agg(
            json_build_object(
                'day', day_ts,
                'last_block_id', block_id,
                'shannon_supply', shannon_supply,
				'unstaked_balance_amount', unstaked_balance_amount,
				'supplier_stake_amount', supplier_stake_amount,
				'application_stake_amount', application_stake_amount,
				'total_supply', total_supply
            )
            ORDER BY day_ts
        )
        FROM (
			WITH latest_blocks_per_day AS (
			  SELECT DISTINCT ON (date_trunc('day', b.timestamp)) 
			    date_trunc('day', b.timestamp) AS day_ts,
			    b.id AS block_id,
			    sp.amount AS shannon_supply
			  FROM ${dbSchema}.blocks b
			  INNER JOIN ${dbSchema}.block_supplies bs ON bs.block_id = b.id
			  INNER JOIN ${dbSchema}.supplies sp ON sp.id = bs.supply_id
			  WHERE sp.denom = 'upokt' AND b.timestamp BETWEEN start_date AND end_date
			  ORDER BY date_trunc('day', b.timestamp), b.timestamp DESC
			),
			unclaimed_accounts AS (
			  SELECT
			  	SUM(unstaked_balance_amount) unstaked_balance_amount,
				SUM(supplier_stake_amount) supplier_stake_amount,
				SUM(application_stake_amount) application_stake_amount
			  FROM ${dbSchema}.morse_claimable_accounts WHERE claimed = false
			),
			recently_claimed_accounts AS (
			  SELECT
			  	l.day_ts,
			  	SUM(unstaked_balance_amount) unstaked_balance_amount,
				SUM(supplier_stake_amount) supplier_stake_amount,
				SUM(application_stake_amount) application_stake_amount
			  FROM ${dbSchema}.morse_claimable_accounts m
			  JOIN latest_blocks_per_day l ON m.claimed_at_id > l.block_id
			  GROUP BY l.day_ts
			),
			balances_per_day AS (
			  SELECT
			    l.day_ts,
			    l.block_id,
			    l.shannon_supply,
			    SUM(m.unstaked_balance_amount + COALESCE(r.unstaked_balance_amount,0)) AS unstaked_balance_amount,
			    SUM(m.supplier_stake_amount + COALESCE(r.supplier_stake_amount,0)) AS supplier_stake_amount,
			    SUM(m.application_stake_amount + COALESCE(r.application_stake_amount,0)) AS application_stake_amount
			  FROM latest_blocks_per_day l
			  JOIN unclaimed_accounts m ON true
			  LEFT JOIN recently_claimed_accounts r on l.day_ts = r.day_ts 
			  GROUP BY l.day_ts, l.block_id, l.shannon_supply
			)
			SELECT 
			  *,
			  (
			    COALESCE(shannon_supply, 0) + 
			    COALESCE(unstaked_balance_amount, 0) + 
			    COALESCE(supplier_stake_amount, 0) + 
			    COALESCE(application_stake_amount, 0)
			  ) AS total_supply
			FROM balances_per_day
			ORDER BY day_ts
        ) subquery
    );
END;
$$ LANGUAGE plpgsql STABLE;`
}
