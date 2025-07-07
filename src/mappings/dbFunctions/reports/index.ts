export const updateBlockReportsFnName = 'update_block_reports'

// This will create a function that receives the height (id) and
// updates all the block reports columns on blocks table for that height (id)
export function updateBlockReportsFn(dbSchema: string): string {
  return `CREATE OR REPLACE FUNCTION ${dbSchema}.${updateBlockReportsFnName}(p_block_id bigint)
RETURNS void AS $$
BEGIN
  -- Block-level updates
  PERFORM ${dbSchema}.update_block_relays(p_block_id);
  PERFORM ${dbSchema}.update_block_staked_apps(p_block_id);
  PERFORM ${dbSchema}.update_block_staked_gateways(p_block_id);
  PERFORM ${dbSchema}.update_block_staked_suppliers(p_block_id);
  PERFORM ${dbSchema}.update_block_staked_validators(p_block_id);
  PERFORM ${dbSchema}.update_block_took(p_block_id);
  PERFORM ${dbSchema}.update_block_transactions(p_block_id);
  PERFORM ${dbSchema}.update_block_unstaked_apps(p_block_id);
  PERFORM ${dbSchema}.update_block_unstaked_gateways(p_block_id);
  PERFORM ${dbSchema}.update_block_unstaked_suppliers(p_block_id);
  PERFORM ${dbSchema}.update_block_unstaking_apps(p_block_id);
  PERFORM ${dbSchema}.update_block_unstaking_suppliers(p_block_id);
  PERFORM ${dbSchema}.update_block_unstaking_validators(p_block_id);

  -- Per-service upserts
  PERFORM ${dbSchema}.upsert_relays_by_block_and_services(p_block_id);
  PERFORM ${dbSchema}.upsert_staked_apps_by_block_and_services(p_block_id);
  PERFORM ${dbSchema}.upsert_staked_suppliers_by_block_and_services(p_block_id);
END;
$$ LANGUAGE plpgsql;
`
}
// This will create a function that receives two arguments: start_height and end_height
// and the function will iterate from the start to the end calling update_block_reports function
export function updateBlockReportsRangeFn(dbSchema: string): string {
  return `CREATE OR REPLACE FUNCTION ${dbSchema}.update_block_reports_range(start_block bigint, end_block bigint)
RETURNS void AS $$
DECLARE
  block_id bigint;
BEGIN
  FOR block_id IN start_block..end_block LOOP
    RAISE NOTICE 'Updating metadata for block %', block_id;
    PERFORM ${dbSchema}.update_block_reports(block_id);
  END LOOP;
END;
$$ LANGUAGE plpgsql;
`
}

// This will create the extension "uuid-ossp" needed to be able to use uuid_generate_v4
// to generate uuid for the _id while upserting data by block and services
export function createNeededExtensions(): string {
  return `
   CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
  `
}
