// This will create a function that receives the height (id) and
// updates the `staked_suppliers` and `staked_suppliers_tokens` columns on blocks table for that height (id)
export function updateStakedSuppliersDataOnBlockFn(dbSchema: string): string {
  return `CREATE OR REPLACE FUNCTION ${dbSchema}.update_block_staked_suppliers(p_block_id bigint)
RETURNS void AS $$
DECLARE
  v_staked_suppliers bigint := 0;
  v_staked_tokens numeric := 0;
BEGIN
  -- Aggregate supplier stats for the block
  SELECT
    COUNT(*),
    COALESCE(SUM(stake_amount), 0)
  INTO
    v_staked_suppliers,
    v_staked_tokens
  FROM ${dbSchema}.suppliers s
  WHERE s.stake_status = 'Staked'
    AND s._block_range @> p_block_id;

  -- Update the blocks table
  UPDATE ${dbSchema}.blocks
  SET
    staked_suppliers = v_staked_suppliers,
    staked_suppliers_tokens = v_staked_tokens
  WHERE id = p_block_id;
END;
$$ LANGUAGE plpgsql;
`
}

// This will create a function that receives the height (id) and
// updates the `unstaking_suppliers` and `unstaking_suppliers_tokens` column on blocks table for that height (id)
export function updateUnstakingSuppliersDataOnBlockFn(dbSchema: string): string {
  return `CREATE OR REPLACE FUNCTION ${dbSchema}.update_block_unstaking_suppliers(p_block_id bigint)
RETURNS void AS $$
DECLARE
  v_unstaking_suppliers bigint := 0;
  v_unstaking_tokens numeric := 0;
BEGIN
  -- Aggregate unstaking supplier stats for the block
  SELECT
    COUNT(*),
    COALESCE(SUM(stake_amount), 0)
  INTO
    v_unstaking_suppliers,
    v_unstaking_tokens
  FROM ${dbSchema}.suppliers s
  WHERE s.stake_status = 'Unstaking'
    AND s._block_range @> p_block_id;

  -- Update the blocks table
  UPDATE ${dbSchema}.blocks
  SET
    unstaking_suppliers = v_unstaking_suppliers,
    unstaking_suppliers_tokens = v_unstaking_tokens
  WHERE id = p_block_id;
END;
$$ LANGUAGE plpgsql;
`
}

// This will create a function that receives the height (id) and
// updates the `unstaked_suppliers` and `unstaked_suppliers_tokens` column on blocks table for that height (id)
export function updateUnstakedSuppliersDataOnBlockFn(dbSchema: string): string {
  return `CREATE OR REPLACE FUNCTION ${dbSchema}.update_block_unstaked_suppliers(p_block_id bigint)
RETURNS void AS $$
DECLARE
  v_unstaked_suppliers bigint := 0;
  v_unstaked_tokens numeric := 0;
BEGIN
  -- Aggregate unstaked supplier stats for the block
  SELECT
    COUNT(*),
    COALESCE(SUM(stake_amount), 0)
  INTO
    v_unstaked_suppliers,
    v_unstaked_tokens
  FROM ${dbSchema}.suppliers s
  WHERE s.stake_status = 'Unstaked'
    AND s.unstaking_end_block_id = p_block_id;

  -- Update the blocks table
  UPDATE ${dbSchema}.blocks
  SET
    unstaked_suppliers = v_unstaked_suppliers,
    unstaked_suppliers_tokens = v_unstaked_tokens
  WHERE id = p_block_id;
END;
$$ LANGUAGE plpgsql;
`
}

// This will two things:
// 1- An unique index by block_id and service_id to enable upsert operation
// 2- A function that receives the height (id) and upsert the values of that block
// for the table staked_suppliers_by_block_and_services
export function upsertSuppliersByBlockAndServiceFn(dbSchema: string): string {
  return `DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'staked_suppliers_by_block_and_services_block_service_key'
      AND conrelid = '${dbSchema}.staked_suppliers_by_block_and_services'::regclass
  ) THEN
    ALTER TABLE ${dbSchema}.staked_suppliers_by_block_and_services
    ADD CONSTRAINT staked_suppliers_by_block_and_services_block_service_key
    UNIQUE (block_id, service_id);
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION ${dbSchema}.upsert_staked_suppliers_by_block_and_services(p_block_id bigint)
RETURNS void AS $$
BEGIN
  INSERT INTO ${dbSchema}.staked_suppliers_by_block_and_services (
    _id,
    id,
    block_id,
    service_id,
    amount,
    tokens,
    _block_range
  )
  SELECT
    uuid_generate_v4(),  -- _id
    CONCAT(p_block_id::text, '-', ss.service_id) AS id,
    p_block_id,
    ss.service_id,
    COUNT(*) AS amount,
    SUM(s.stake_amount) AS tokens,
    int8range(p_block_id, NULL) AS _block_range  -- open-ended: [block_id,)
  FROM ${dbSchema}.suppliers s
  INNER JOIN ${dbSchema}.supplier_service_configs ss
    ON ss.supplier_id = s.id
  WHERE s.stake_status = 'Staked'
    AND s._block_range @> p_block_id
    AND ss._block_range @> p_block_id
  GROUP BY ss.service_id
  ON CONFLICT (block_id, service_id) DO UPDATE
  SET
    amount = EXCLUDED.amount,
    tokens = EXCLUDED.tokens,
    _block_range = EXCLUDED._block_range;
END;
$$ LANGUAGE plpgsql;
`
}
