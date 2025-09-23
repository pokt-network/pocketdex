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

export const upsertSuppliersByBlockAndServicesFnName = 'upsert_staked_suppliers_by_block_and_services'

// Here we are creating a table outside SubQuery to avoid unnecessary indexes
export function upsertSuppliersByBlockAndServiceFn(dbSchema: string): string {
  return `
CREATE TABLE IF NOT EXISTS ${dbSchema}.staked_suppliers_by_block_and_services
(
    tokens numeric NOT NULL,
    amount integer NOT NULL,
    block_id numeric NOT NULL,
    service_id text NOT NULL,
    _id uuid NOT NULL,
    CONSTRAINT staked_suppliers_by_block_and_services_pkey PRIMARY KEY (_id)
);

COMMENT ON TABLE ${dbSchema}.staked_suppliers_by_block_and_services
    IS '@foreignKey (block_id) REFERENCES blocks (id)';
    
CREATE INDEX IF NOT EXISTS idx_suppliers_services_block_id
    ON ${dbSchema}.staked_suppliers_by_block_and_services USING btree
    (block_id ASC NULLS LAST)
    TABLESPACE pg_default;

CREATE OR REPLACE FUNCTION ${dbSchema}.${upsertSuppliersByBlockAndServicesFnName}(p_block_id bigint)
RETURNS void AS $$
BEGIN
  -- Delete existing rows for this block
  DELETE FROM ${dbSchema}.staked_suppliers_by_block_and_services
  WHERE block_id = p_block_id;

  INSERT INTO ${dbSchema}.staked_suppliers_by_block_and_services (
    _id,
    block_id,
    service_id,
    amount,
    tokens
  )
  SELECT
    uuid_generate_v4(),  -- _id
    p_block_id,
    ss.service_id,
    COUNT(*) AS amount,
    SUM(s.stake_amount) AS tokens
  FROM ${dbSchema}.suppliers s
  INNER JOIN ${dbSchema}.supplier_service_configs ss
    ON ss.supplier_id = s.id
  WHERE s.stake_status = 'Staked'
    AND s._block_range @> p_block_id
    AND ss._block_range @> p_block_id
  GROUP BY ss.service_id;
END;
$$ LANGUAGE plpgsql;
`
}
