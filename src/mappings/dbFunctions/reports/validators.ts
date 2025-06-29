// This will create a function that receives the height (id) and
// updates the `staked_validators` and `staked_validators_tokens` columns on blocks table for that height (id)
export function updateStakedValidatorsDataOnBlockFn(dbSchema: string): string {
  return `CREATE OR REPLACE FUNCTION ${dbSchema}.update_block_staked_validators(p_block_id bigint)
RETURNS void AS $$
DECLARE
  v_staked_validators bigint := 0;
  v_staked_validators_tokens numeric := 0;
BEGIN
  SELECT
    COUNT(*),
    COALESCE(SUM(stake_amount), 0)
  INTO
    v_staked_validators,
    v_staked_validators_tokens
  FROM ${dbSchema}.validators s
  WHERE s.stake_status = 'Staked'
    AND s._block_range @> p_block_id;

  -- Update the blocks table
  UPDATE ${dbSchema}.blocks
  SET
    staked_validators = v_staked_validators,
    staked_validators_tokens = v_staked_validators_tokens
  WHERE id = p_block_id;
END;
$$ LANGUAGE plpgsql;
`
}

// This will create a function that receives the height (id) and
// updates the `unstaking_validators` and `unstaking_validators_tokens` columns on blocks table for that height (id)
export function updateUnstakingValidatorsDataOnBlockFn(dbSchema: string): string {
  return `CREATE OR REPLACE FUNCTION ${dbSchema}.update_block_unstaking_validators(p_block_id bigint)
RETURNS void AS $$
DECLARE
  v_unstaking_validators bigint := 0;
  v_unstaking_validators_tokens numeric := 0;
BEGIN
  SELECT
    COUNT(*),
    COALESCE(SUM(stake_amount), 0)
  INTO
    v_unstaking_validators,
    v_unstaking_validators_tokens
  FROM ${dbSchema}.validators s
  WHERE s.stake_status = 'Unstaking'
    AND s._block_range @> p_block_id;

  -- Update the blocks table
  UPDATE ${dbSchema}.blocks
  SET
    unstaking_validators = v_unstaking_validators,
    unstaking_validators_tokens = v_unstaking_validators_tokens
  WHERE id = p_block_id;
END;
$$ LANGUAGE plpgsql;
`
}
