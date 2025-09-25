// This will create a function that receives the height (id) and
// updates the `staked_apps` and `staked_apps_tokens` columns on blocks table for that height (id)
export function updateStakedAppsDataOnBlockFn(dbSchema: string): string {
  return `CREATE OR REPLACE FUNCTION ${dbSchema}.update_block_staked_apps(p_block_id bigint)
RETURNS void AS $$
DECLARE
  v_staked_apps bigint := 0;
  v_staked_apps_tokens numeric := 0;
BEGIN
  -- Aggregate staked applications for the block
  SELECT
    COUNT(*),
    COALESCE(SUM(stake_amount), 0)
  INTO
    v_staked_apps,
    v_staked_apps_tokens
  FROM ${dbSchema}.applications s
  WHERE s.stake_status = 'Staked'
    AND s._block_range @> p_block_id;

  -- Update the blocks table
  UPDATE ${dbSchema}.blocks
  SET
    staked_apps = v_staked_apps,
    staked_apps_tokens = v_staked_apps_tokens
  WHERE id = p_block_id;
END;
$$ LANGUAGE plpgsql;
`
}

// This will create a function that receives the height (id) and
// updates the `unstaking_apps` and `unstaking_apps_tokens` columns on blocks table for that height (id)
export function updateUnstakingAppsDataOnBlockFn(dbSchema: string): string {
  return `CREATE OR REPLACE FUNCTION ${dbSchema}.update_block_unstaking_apps(p_block_id bigint)
RETURNS void AS $$
DECLARE
  v_unstaking_apps bigint := 0;
  v_unstaking_apps_tokens numeric := 0;
BEGIN
  -- Aggregate unstaking apps for the block
  SELECT
    COUNT(*),
    COALESCE(SUM(stake_amount), 0)
  INTO
    v_unstaking_apps,
    v_unstaking_apps_tokens
  FROM ${dbSchema}.applications s
  WHERE s.stake_status = 'Unstaking'
    AND s._block_range @> p_block_id;

  -- Update the blocks table
  UPDATE ${dbSchema}.blocks
  SET
    unstaking_apps = v_unstaking_apps,
    unstaking_apps_tokens = v_unstaking_apps_tokens
  WHERE id = p_block_id;
END;
$$ LANGUAGE plpgsql;
`
}

// This will create a function that receives the height (id) and
// updates the `unstaked_apps` and `unstaked_apps_tokens` columns on blocks table for that height (id)
export function updateUnstakedAppsDataOnBlockFn(dbSchema: string): string {
  return `CREATE OR REPLACE FUNCTION ${dbSchema}.update_block_unstaked_apps(p_block_id bigint)
RETURNS void AS $$
DECLARE
  v_unstaked_apps bigint := 0;
  v_unstaked_apps_tokens numeric := 0;
BEGIN
  -- Aggregate unstaked applications at a specific block
  SELECT
    COUNT(*),
    COALESCE(SUM(stake_amount), 0)
  INTO
    v_unstaked_apps,
    v_unstaked_apps_tokens
  FROM ${dbSchema}.applications s
  WHERE s.stake_status = 'Unstaked'
    AND s.unstaking_end_block_id = p_block_id;

  -- Update the corresponding row in the blocks table
  UPDATE ${dbSchema}.blocks
  SET
    unstaked_apps = v_unstaked_apps,
    unstaked_apps_tokens = v_unstaked_apps_tokens
  WHERE id = p_block_id;
END;
$$ LANGUAGE plpgsql;
`
}

export const upsertAppsByBlockAndServicesFnName = 'upsert_staked_apps_by_block_and_services'

// Here we are creating a table outside SubQuery to avoid unnecessary indexes
export function upsertAppsByBlockAndServiceFn(dbSchema: string): string {
  return `
CREATE TABLE IF NOT EXISTS ${dbSchema}.staked_apps_by_block_and_services
(
    tokens numeric NOT NULL,
    amount integer NOT NULL,
    block_id numeric NOT NULL,
    service_id text NOT NULL,
    _id uuid NOT NULL,
    CONSTRAINT apps_by_block_and_services_pkey PRIMARY KEY (_id)
);

COMMENT ON TABLE ${dbSchema}.staked_apps_by_block_and_services
    IS '@foreignKey (block_id) REFERENCES blocks (id)';
    
CREATE INDEX IF NOT EXISTS idx_apps_services_block_id
    ON ${dbSchema}.staked_apps_by_block_and_services USING btree
    (block_id ASC NULLS LAST)
    TABLESPACE pg_default;

CREATE OR REPLACE FUNCTION ${dbSchema}.${upsertAppsByBlockAndServicesFnName}(p_block_id bigint)
RETURNS void AS $$
BEGIN
  -- Delete existing rows for this block
  DELETE FROM ${dbSchema}.staked_apps_by_block_and_services
  WHERE block_id = p_block_id;

  INSERT INTO ${dbSchema}.staked_apps_by_block_and_services (
    _id,
    block_id,
    service_id,
    amount,
    tokens
  )
  SELECT
    uuid_generate_v4(),  -- _id (UUID)
    p_block_id,
    ss.service_id,
    COUNT(*) AS amount,
    SUM(s.stake_amount) AS tokens
  FROM ${dbSchema}.applications s
  INNER JOIN ${dbSchema}.application_services ss ON ss.application_id = s.id
  WHERE s.stake_status = 'Staked'
    AND s._block_range @> p_block_id
    AND ss._block_range @> p_block_id
  GROUP BY ss.service_id;
END;
$$ LANGUAGE plpgsql;
`
}
