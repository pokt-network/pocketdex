// This will create a function that receives the height (id) and
// updates the `total_relays` and `total_computed_units` column on blocks table for that height (id)
export function updateRelaysDataOnBlockFn(dbSchema: string): string {
  return `CREATE OR REPLACE FUNCTION ${dbSchema}.update_block_relays(p_block_id bigint)
RETURNS void AS $$
DECLARE
  v_total_relays bigint := 0;
  v_total_estimated_relays bigint := 0;
  v_total_computed_units bigint := 0;
  v_total_estimated_computed_units bigint := 0;
BEGIN
  -- Aggregate values from event_claim_settleds
  SELECT
    COALESCE(SUM(num_relays), 0),
    COALESCE(SUM(num_estimated_relays), 0),
    COALESCE(SUM(num_claimed_computed_units), 0),
    COALESCE(SUM(num_estimated_computed_units), 0)
  INTO
    v_total_relays,
    v_total_estimated_relays,
    v_total_computed_units,
    v_total_estimated_computed_units
  FROM ${dbSchema}.event_claim_settleds
  WHERE block_id = p_block_id;

  -- Update the blocks table with the computed values
  UPDATE ${dbSchema}.blocks
  SET
    total_relays = v_total_relays,
    total_estimated_relays = v_total_estimated_relays,
    total_computed_units = v_total_computed_units,
    total_estimated_computed_units = v_total_estimated_computed_units
  WHERE id = p_block_id;
END;
$$ LANGUAGE plpgsql;
`
}

export const upsertRelaysByBlockAndServicesFnName = 'upsert_relays_by_block_and_services'

// Here we are creating a table outside SubQuery to avoid unnecessary indexes
export function upsertRelaysByBlockAndServiceFn(dbSchema: string): string {
  return `
CREATE TABLE IF NOT EXISTS ${dbSchema}.relay_by_block_and_services
(
    relays numeric NOT NULL,
    estimated_relays numeric,
    computed_units numeric NOT NULL,
    estimated_computed_units numeric,
    claimed_upokt numeric NOT NULL,
    amount integer NOT NULL,
    block_id numeric NOT NULL,
    service_id text NOT NULL,
    _id uuid NOT NULL,
    CONSTRAINT relay_by_block_and_services_pkey PRIMARY KEY (_id)
);

COMMENT ON TABLE ${dbSchema}.relay_by_block_and_services
    IS '@foreignKey (block_id) REFERENCES blocks (id)';

CREATE INDEX IF NOT EXISTS idx_relays_services_block_id
    ON ${dbSchema}.relay_by_block_and_services USING btree
    (block_id ASC NULLS LAST)
    TABLESPACE pg_default;
    
CREATE OR REPLACE FUNCTION ${dbSchema}.${upsertRelaysByBlockAndServicesFnName}(p_block_id bigint)
RETURNS void AS $$
BEGIN
  -- Delete existing rows for this block
  DELETE FROM ${dbSchema}.relay_by_block_and_services
  WHERE block_id = p_block_id;
  
  -- Perform the upsert
  INSERT INTO ${dbSchema}.relay_by_block_and_services (
    service_id,
    block_id,
    amount,
    relays,
    estimated_relays,
    computed_units,
    estimated_computed_units,
    claimed_upokt,
	  _id
  )
  SELECT
    c.service_id,
    p_block_id,
    COUNT(*) AS amount,
    SUM(c.num_relays) AS relays,
    SUM(c.num_estimated_relays) AS estimated_relays,
    SUM(c.num_claimed_computed_units) AS computed_units,
    SUM(c.num_estimated_computed_units) AS estimated_computed_units,
    SUM(c.claimed_amount) AS claimed_upokt,
	  uuid_generate_v4() _id
  FROM ${dbSchema}.event_claim_settleds c
  WHERE c.block_id = p_block_id
  GROUP BY c.service_id;
END;
$$ LANGUAGE plpgsql;
`
}
