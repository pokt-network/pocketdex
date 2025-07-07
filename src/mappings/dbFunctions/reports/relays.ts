// This will create a function that receives the height (id) and
// updates the `total_relays` and `total_computed_units` column on blocks table for that height (id)
export function updateRelaysDataOnBlockFn(dbSchema: string): string {
  return `CREATE OR REPLACE FUNCTION ${dbSchema}.update_block_relays(p_block_id bigint)
RETURNS void AS $$
DECLARE
  v_total_relays bigint := 0;
  v_total_computed_units bigint := 0;
BEGIN
  -- Aggregate values from event_claim_settleds
  SELECT
    COALESCE(SUM(num_relays), 0),
    COALESCE(SUM(num_claimed_computed_units), 0)
  INTO
    v_total_relays,
    v_total_computed_units
  FROM ${dbSchema}.event_claim_settleds
  WHERE block_id = p_block_id;

  -- Update the blocks table with the computed values
  UPDATE ${dbSchema}.blocks
  SET
    total_relays = v_total_relays,
    total_computed_units = v_total_computed_units
  WHERE id = p_block_id;
END;
$$ LANGUAGE plpgsql;
`
}

// This will two things:
// 1- An unique index by block_id and service_id to enable upsert operation
// 2- A function that receives the height (id) and upsert the values of that block
// for the table relay_by_block_and_services
export function upsertRelaysByBlockAndServiceFn(dbSchema: string): string {
  return `DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'relay_by_block_and_services_block_service_key'
      AND conrelid = '${dbSchema}.relay_by_block_and_services'::regclass
  ) THEN
    ALTER TABLE ${dbSchema}.relay_by_block_and_services
    ADD CONSTRAINT relay_by_block_and_services_block_service_key
    UNIQUE (block_id, service_id);
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION ${dbSchema}.upsert_relays_by_block_and_services(p_block_id bigint)
RETURNS void AS $$
BEGIN
  -- Perform the upsert
  INSERT INTO ${dbSchema}.relay_by_block_and_services (
    id,
    service_id,
    block_id,
    amount,
    relays,
    computed_units,
    claimed_upokt,
	_id,
	_block_range
  )
  SELECT
    CONCAT(p_block_id::text, '-', c.service_id) AS id,
    c.service_id,
    p_block_id,
    COUNT(*) AS amount,
    SUM(c.num_relays) AS relays,
    SUM(c.num_claimed_computed_units) AS computed_units,
    SUM(c.claimed_amount) AS claimed_upokt,
	uuid_generate_v4() _id,
	int8range(p_block_id, NULL) _block_range
  FROM ${dbSchema}.event_claim_settleds c
  WHERE c.block_id = p_block_id
  GROUP BY c.service_id
  ON CONFLICT (block_id, service_id) DO UPDATE
  SET
    amount = EXCLUDED.amount,
    relays = EXCLUDED.relays,
    computed_units = EXCLUDED.computed_units,
    claimed_upokt = EXCLUDED.claimed_upokt;
END;
$$ LANGUAGE plpgsql;
`
}
