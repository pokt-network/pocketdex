// DAO-related analytics functions

export function getDaoBalanceAtHeightFn(dbSchema: string): string {
  return `CREATE OR REPLACE FUNCTION ${dbSchema}.get_dao_balance_at_height(
    height BIGINT DEFAULT 0
)
RETURNS NUMERIC
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  amount NUMERIC := 0;
  effective_height BIGINT;
BEGIN
    -- get latest block if height = 0

    IF height = 0 THEN
      SELECT id INTO effective_height
      FROM ${dbSchema}.blocks
      ORDER BY id DESC
      LIMIT 1;
    ELSE
      effective_height := height;
    END IF;

      SELECT
        COALESCE(b.amount, 0)
    INTO
        amount
    FROM ${dbSchema}.params p
    LEFT JOIN ${dbSchema}.balances b ON b.account_id = p.value
    WHERE
        p.namespace = 'tokenomics' AND
        p.key = 'dao_reward_address' AND
        p._block_range @> effective_height AND
        b.denom = 'upokt' AND
        b._block_range @> effective_height;

  RETURN amount;
END;
$$;

COMMENT ON FUNCTION ${dbSchema}.get_dao_balance_at_height(bigint) IS
'@name getDaoBalanceAtHeight
Returns the DAO balance at a specific block height. If height is 0, returns balance at the latest block.';
`;
}
