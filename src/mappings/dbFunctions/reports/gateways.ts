// This will create a function that receives the height (id) and
// updates the `staked_gateways` and `staked_gateways_tokens` columns on blocks table for that height (id)
export function updateStakedGatewaysDataOnBlockFn(dbSchema: string): string {
  return `CREATE OR REPLACE FUNCTION ${dbSchema}.update_block_staked_gateways(p_block_id bigint)
RETURNS void AS $$
DECLARE
  v_staked_gateways bigint := 0;
  v_staked_gateways_tokens numeric := 0;
BEGIN
  SELECT
    COUNT(*),
    COALESCE(SUM(stake_amount), 0)
  INTO
    v_staked_gateways,
    v_staked_gateways_tokens
  FROM ${dbSchema}.gateways s
  WHERE s.stake_status = 'Staked'
    AND s._block_range @> p_block_id;

  -- Update the blocks table
  UPDATE ${dbSchema}.blocks
  SET
    staked_gateways = v_staked_gateways,
    staked_gateways_tokens = v_staked_gateways_tokens
  WHERE id = p_block_id;
END;
$$ LANGUAGE plpgsql;
`
}

// This will create a function that receives the height (id) and
// updates the `unstaked_gateways` and `unstaked_gateways_tokens` columns on blocks table for that height (id)
export function updateUnstakedGatewaysDataOnBlockFn(dbSchema: string): string {
  return `CREATE OR REPLACE FUNCTION ${dbSchema}.update_block_unstaked_gateways(p_block_id bigint)
RETURNS void AS $$
DECLARE
  v_unstaked_gateways bigint := 0;
  v_unstaked_gateways_tokens numeric := 0;
BEGIN
  -- Aggregate unstaked gateways at a specific block
  SELECT
    COUNT(*),
    COALESCE(SUM(stake_amount), 0)
  INTO
    v_unstaked_gateways,
    v_unstaked_gateways_tokens
  FROM ${dbSchema}.gateways s
  WHERE s.stake_status = 'Unstaked'
    AND s.unstaking_end_block_id = p_block_id;

  -- Update the corresponding row in the blocks table
  UPDATE ${dbSchema}.blocks
  SET
    unstaked_gateways = v_unstaked_gateways,
    unstaked_gateways_tokens = v_unstaked_gateways_tokens
  WHERE id = p_block_id;
END;
$$ LANGUAGE plpgsql;
`
}
