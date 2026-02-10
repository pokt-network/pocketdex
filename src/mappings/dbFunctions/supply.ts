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

export function getBurnBreakdownBetweenDatesFn(dbSchema: string): string {
  return `CREATE OR REPLACE FUNCTION ${dbSchema}.get_burn_breakdown_between_dates(
    start_date TIMESTAMP,
    end_date TIMESTAMP
)
RETURNS JSON
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  burn_mint_amount NUMERIC := 0;
BEGIN
  SELECT
    SUM(REPLACE(elem->>'amount', 'n', '')::numeric)
  INTO
    burn_mint_amount
  FROM ${dbSchema}.event_claim_settleds t
  INNER JOIN ${dbSchema}.blocks b ON t.block_id = b.id
  JOIN LATERAL jsonb_array_elements(t.burns) AS elem ON TRUE
  WHERE b.timestamp BETWEEN start_date AND end_date;

  RETURN json_build_object(
    'burn_mint', COALESCE(burn_mint_amount, 0)
  );
END;
$$;

COMMENT ON FUNCTION ${dbSchema}.get_burn_breakdown_between_dates(timestamp without time zone, timestamp without time zone) IS
'@name getBurnBreakdownBetweenDates
Returns the breakdown of burned tokens between two dates.';
`;
}

export function getMintBreakdownBetweenDatesFn(dbSchema: string): string {
  return `CREATE OR REPLACE FUNCTION ${dbSchema}.get_mint_breakdown_between_dates(
    start_date TIMESTAMP,
    end_date TIMESTAMP
)
RETURNS JSON
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  reimbursement_amount NUMERIC := 0;
  reimbursement_v2_amount NUMERIC := 0;
  inflation_amount NUMERIC := 0;
  mint_burn_amount NUMERIC := 0;
BEGIN
  -- Reimbursement amount
  SELECT COALESCE(SUM(t.amount), 0) INTO reimbursement_amount
  FROM ${dbSchema}.mod_to_acct_transfers t
  INNER JOIN ${dbSchema}.blocks b ON t.block_id = b.id
  WHERE t.op_reason = 'TLM_GLOBAL_MINT_REIMBURSEMENT_REQUEST_ESCROW_DAO_TRANSFER'
    AND b.timestamp BETWEEN start_date AND end_date;

  -- Mint by op_reason
  SELECT
    SUM(CASE WHEN (elem->>'opReason')::int = 10 THEN REPLACE(elem->>'amount', 'n', '')::numeric ELSE 0 END),
    SUM(CASE WHEN (elem->>'opReason')::int = 3 THEN REPLACE(elem->>'amount', 'n', '')::numeric ELSE 0 END),
    SUM(CASE WHEN (elem->>'opReason')::int = 1 THEN REPLACE(elem->>'amount', 'n', '')::numeric ELSE 0 END)
  INTO
    reimbursement_v2_amount, inflation_amount, mint_burn_amount
  FROM ${dbSchema}.event_claim_settleds t
  INNER JOIN ${dbSchema}.blocks b ON t.block_id = b.id
  JOIN LATERAL jsonb_array_elements(t.mints) AS elem ON TRUE
  WHERE b.timestamp BETWEEN start_date AND end_date;

  RETURN json_build_object(
    'reimbursement', reimbursement_amount + reimbursement_v2_amount,
    'inflation', inflation_amount,
    'mint_burn', mint_burn_amount
  );
END;
$$;

COMMENT ON FUNCTION ${dbSchema}.get_mint_breakdown_between_dates(timestamp without time zone, timestamp without time zone) IS
'@name getMintBreakdownBetweenDates
Returns the breakdown of minted tokens by category (reimbursement, inflation, mint_burn) between two dates.';
`;
}

export function getSupplyCompositionBetweenDatesFn(dbSchema: string): string {
  return `CREATE OR REPLACE FUNCTION ${dbSchema}.get_supply_composition_between_dates(
    start_date TIMESTAMP,
    end_date TIMESTAMP,
    trunc_interval TEXT
)
RETURNS JSON
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
    RETURN (
        SELECT json_agg(
            json_build_object(
                'date_truncated', b.day_ts,
                'latest_block', b.block_id,
                'network_supply', b.shannon_supply,
                'unmigrated_supply', b.unmigrated_supply,
                'total_supply', b.total_supply,
                'network_supply_composition', b.supply_composition
            )
            ORDER BY b.day_ts
        )
        FROM (
            WITH latest_blocks_per_day AS (
                SELECT DISTINCT ON (date_trunc(trunc_interval, b.timestamp))
                    date_trunc(trunc_interval, b.timestamp) AS day_ts,
                    b.id AS block_id,
                    sp.amount AS shannon_supply
                FROM ${dbSchema}.blocks b
                INNER JOIN ${dbSchema}.block_supplies bs ON bs.block_id = b.id
                INNER JOIN ${dbSchema}.supplies sp ON sp.id = bs.supply_id
                WHERE sp.denom = 'upokt'
                  AND b.timestamp BETWEEN start_date AND end_date
                ORDER BY date_trunc(trunc_interval, b.timestamp), b.timestamp DESC
            ),
            unclaimed_accounts AS (
                SELECT
                    SUM(unstaked_balance_amount) AS unstaked_balance_amount,
                    SUM(supplier_stake_amount) AS supplier_stake_amount,
                    SUM(application_stake_amount) AS application_stake_amount
                FROM ${dbSchema}.morse_claimable_accounts
                WHERE claimed = false
            ),
            recently_claimed_accounts AS (
                SELECT
                    l.day_ts,
                    SUM(unstaked_balance_amount) AS unstaked_balance_amount,
                    SUM(supplier_stake_amount) AS supplier_stake_amount,
                    SUM(application_stake_amount) AS application_stake_amount
                FROM ${dbSchema}.morse_claimable_accounts m
                JOIN latest_blocks_per_day l ON m.claimed_at_id > l.block_id
                GROUP BY l.day_ts
            ),
            dao_address AS (
                SELECT
                    l.day_ts,
                    p.value AS address
                FROM ${dbSchema}.params p
                JOIN latest_blocks_per_day l ON p._block_range @> l.block_id::BIGINT
                WHERE p.namespace = 'tokenomics' AND p.key = 'dao_reward_address'
                GROUP BY l.day_ts, p.value
            ),
            balances_per_day AS (
                SELECT
                    l.day_ts,
                    l.block_id,
                    l.shannon_supply,
                    COALESCE(u.unstaked_balance_amount, 0) + COALESCE(r.unstaked_balance_amount, 0) AS unstaked_balance_amount,
                    COALESCE(u.supplier_stake_amount, 0) + COALESCE(r.supplier_stake_amount, 0) AS supplier_stake_amount,
                    COALESCE(u.application_stake_amount, 0) + COALESCE(r.application_stake_amount, 0) AS application_stake_amount
                FROM latest_blocks_per_day l
                CROSS JOIN unclaimed_accounts u
                LEFT JOIN recently_claimed_accounts r ON l.day_ts = r.day_ts
            ),
            supply_composition AS (
                SELECT
                    l.day_ts,
                    COALESCE(
                        a.name,
                        CASE
                            WHEN b.account_id = d.address THEN 'dao'
                            WHEN b.account_id = 'pokt14q8l4hlsdf2fqws7n6q6ck3xg5yt2qvgyynnll' THEN 'wrapped'
                            ELSE 'others'
                        END
                    ) AS label,
                    SUM(b.amount) AS total_amount
                FROM ${dbSchema}.balances b
                LEFT JOIN ${dbSchema}.module_accounts a ON a.id = b.account_id
                JOIN latest_blocks_per_day l ON b._block_range @> l.block_id::BIGINT
                LEFT JOIN dao_address d ON d.day_ts = l.day_ts
                WHERE b.denom = 'upokt'
                GROUP BY l.day_ts, label
            )
            SELECT
                b.*,
                (
                    COALESCE(b.application_stake_amount, 0) +
                    COALESCE(b.unstaked_balance_amount, 0) +
                    COALESCE(b.supplier_stake_amount, 0)
                ) AS unmigrated_supply,
                (
                    COALESCE(b.shannon_supply, 0) +
                    COALESCE(b.unstaked_balance_amount, 0) +
                    COALESCE(b.supplier_stake_amount, 0) +
                    COALESCE(b.application_stake_amount, 0)
                ) AS total_supply,
                (
                    SELECT json_agg(json_build_object(
                        'label', s.label,
                        'amount', s.total_amount
                    ))
                    FROM supply_composition s
                    WHERE s.day_ts = b.day_ts
                ) AS supply_composition
            FROM balances_per_day b
            ORDER BY b.day_ts
        ) b
    );
END;
$$;

COMMENT ON FUNCTION ${dbSchema}.get_supply_composition_between_dates(timestamp without time zone, timestamp without time zone, text) IS
'@name getSupplyCompositionBetweenDates
Returns detailed supply composition including network supply, unmigrated supply, and breakdown by account type over time intervals.';
`;
}

export function getTotalSupplyBetweenDatesFn(dbSchema: string): string {
  return `CREATE OR REPLACE FUNCTION ${dbSchema}.get_total_supply_between_dates(
    start_date TIMESTAMP,
    end_date TIMESTAMP
)
RETURNS JSON
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
    latest_block_id BIGINT;
    shannon_supply BIGINT;
BEGIN
    -- Get latest block and its supply
    SELECT b.id, sp.amount INTO latest_block_id, shannon_supply
    FROM ${dbSchema}.blocks b
    INNER JOIN ${dbSchema}.block_supplies bs ON bs.block_id = b.id
    INNER JOIN ${dbSchema}.supplies sp ON sp.id = bs.supply_id
    WHERE b.timestamp BETWEEN start_date AND end_date
      AND sp.denom = 'upokt'
    ORDER BY b.timestamp DESC
    LIMIT 1;

    RETURN (
        WITH
        unclaimed_accounts AS (
            SELECT
                SUM(unstaked_balance_amount) AS unstaked_balance_amount,
                SUM(supplier_stake_amount) AS supplier_stake_amount,
                SUM(application_stake_amount) AS application_stake_amount
            FROM ${dbSchema}.morse_claimable_accounts
            WHERE claimed = false
        ),
        recently_claimed_accounts AS (
            SELECT
                SUM(unstaked_balance_amount) AS unstaked_balance_amount,
                SUM(supplier_stake_amount) AS supplier_stake_amount,
                SUM(application_stake_amount) AS application_stake_amount
            FROM ${dbSchema}.morse_claimable_accounts
            WHERE claimed_at_id > latest_block_id
        )
        SELECT json_build_object(
            'latest_block', latest_block_id,
            'network_supply', shannon_supply,
            'unstaked_balance_amount', COALESCE(u.unstaked_balance_amount, 0) + COALESCE(r.unstaked_balance_amount, 0),
            'supplier_stake_amount', COALESCE(u.supplier_stake_amount, 0) + COALESCE(r.supplier_stake_amount, 0),
            'application_stake_amount', COALESCE(u.application_stake_amount, 0) + COALESCE(r.application_stake_amount, 0),
            'unmigrated_supply',
                COALESCE(u.unstaked_balance_amount, 0) + COALESCE(r.unstaked_balance_amount, 0) +
                COALESCE(u.supplier_stake_amount, 0) + COALESCE(r.supplier_stake_amount, 0) +
                COALESCE(u.application_stake_amount, 0) + COALESCE(r.application_stake_amount, 0),
            'total_supply',
                COALESCE(shannon_supply, 0) +
                COALESCE(u.unstaked_balance_amount, 0) + COALESCE(r.unstaked_balance_amount, 0) +
                COALESCE(u.supplier_stake_amount, 0) + COALESCE(r.supplier_stake_amount, 0) +
                COALESCE(u.application_stake_amount, 0) + COALESCE(r.application_stake_amount, 0)
        )
        FROM unclaimed_accounts u, recently_claimed_accounts r
    );
END;
$$;

COMMENT ON FUNCTION ${dbSchema}.get_total_supply_between_dates(timestamp without time zone, timestamp without time zone) IS
'@name getTotalSupplyBetweenDates
Returns a snapshot of total supply metrics including network supply, unmigrated supply, and total supply for the latest block in the date range.';
`;
}
