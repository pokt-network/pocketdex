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

//TODO: check index exists before running alter table, it will throw an error if exists
// This will two things:
// 1- An unique index by block_id and service_id to enable upsert operation
// 2- A function that receives the height (id) and upsert the values of that block
// for the table staked_apps_by_block_and_services
export function upsertAppsByBlockAndServiceFn(dbSchema: string): string {
  return `DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'staked_apps_by_block_and_services_block_service_key'
      AND conrelid = '${dbSchema}.staked_apps_by_block_and_services'::regclass
  ) THEN
    ALTER TABLE ${dbSchema}.staked_apps_by_block_and_services
    ADD CONSTRAINT staked_apps_by_block_and_services_block_service_key
    UNIQUE (block_id, service_id);
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION ${dbSchema}.upsert_staked_apps_by_block_and_services(p_block_id bigint)
RETURNS void AS $$
BEGIN
  INSERT INTO ${dbSchema}.staked_apps_by_block_and_services (
    _id,
    id,
    block_id,
    service_id,
    amount,
    tokens,
    _block_range
  )
  SELECT
    uuid_generate_v4(),  -- _id (UUID)
    CONCAT(p_block_id::text, '-', ss.service_id) AS id,
    p_block_id,
    ss.service_id,
    COUNT(*) AS amount,
    SUM(s.stake_amount) AS tokens,
    int8range(p_block_id, NULL) AS _block_range  -- open-ended: [block_id,)
  FROM ${dbSchema}.applications s
  INNER JOIN ${dbSchema}.application_services ss ON ss.application_id = s.id
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
