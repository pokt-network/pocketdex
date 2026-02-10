// Validator monitoring and tracking functions

export function getMissingValidatorBlocksFn(dbSchema: string): string {
  return `CREATE OR REPLACE FUNCTION ${dbSchema}.get_missing_validator_blocks(
    from_id BIGINT,
    validator_address TEXT
)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(
    jsonb_agg(id ORDER BY id ASC),
    '[]'::jsonb
  )
  FROM ${dbSchema}.block_metadata bm
  WHERE bm.id >= from_id
    AND NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(bm.last_commit->'signatures') AS sig
      WHERE sig->>'validatorAddress' = validator_address
    );
$$;

COMMENT ON FUNCTION ${dbSchema}.get_missing_validator_blocks(bigint, text) IS
'@name getMissingValidatorBlocks
Returns block IDs where a specific validator was missing from the signature set.';
`;
}

export function getProducedBlocksByValidatorFn(dbSchema: string): string {
  return `CREATE OR REPLACE FUNCTION ${dbSchema}.get_produced_blocks_by_validator(
    from_id BIGINT,
    validator_address TEXT
)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(
    jsonb_agg(id ORDER BY id ASC),
    '[]'::jsonb
  )
  FROM ${dbSchema}.blocks b
  WHERE b.id >= from_id
    AND b.proposer_address = validator_address
$$;

COMMENT ON FUNCTION ${dbSchema}.get_produced_blocks_by_validator(bigint, text) IS
'@name getProducedBlocksByValidator
Returns block IDs produced (proposed) by a specific validator starting from a given block ID.';
`;
}
