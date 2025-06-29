// This will create a function that receives the height (id) and
// updates the `took` column on blocks table for that height (id)
export function updateTookOnBlocksFn(dbSchema: string): string {
  return `CREATE OR REPLACE FUNCTION ${dbSchema}.update_block_took(target_block_id bigint)
RETURNS void AS $$
DECLARE
  current_ts timestamp;
  previous_ts timestamp;
  took_ms numeric := 0;
BEGIN
  -- Get current block timestamp
  SELECT timestamp INTO current_ts
  FROM ${dbSchema}.blocks
  WHERE id = target_block_id;

  IF current_ts IS NULL THEN
    RAISE NOTICE 'Block % not found.', target_block_id;
    RETURN;
  END IF;

  -- Try to get previous block timestamp
  SELECT timestamp INTO previous_ts
  FROM ${dbSchema}.blocks
  WHERE id = target_block_id - 1;

  -- If previous timestamp exists, compute the time difference
  IF previous_ts IS NOT NULL THEN
    took_ms := EXTRACT(EPOCH FROM (current_ts - previous_ts)) * 1000;
  END IF;

  -- Update the block with computed or default took
  UPDATE ${dbSchema}.blocks
  SET time_to_block = took_ms
  WHERE id = target_block_id;
END;
$$ LANGUAGE plpgsql;`
}
