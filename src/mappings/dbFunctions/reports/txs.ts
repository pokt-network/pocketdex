// This will create a function that receives the height (id) and
// updates the `total_txs`, `successful_txs` and `failed_txs` columns on blocks table for that height (id)
export function updateTxsDataOnBlockFn(dbSchema: string): string {
  return `CREATE OR REPLACE FUNCTION ${dbSchema}.update_block_transactions(p_block_id bigint)
RETURNS void AS $$
DECLARE
  v_successful_txs bigint := 0;
  v_failed_txs bigint := 0;
  v_total_txs bigint := 0;
BEGIN
  -- Aggregate transaction stats
  SELECT
    SUM(CASE WHEN code = 0 THEN 1 ELSE 0 END),
    SUM(CASE WHEN code <> 0 THEN 1 ELSE 0 END),
    COUNT(*)
  INTO
    v_successful_txs,
    v_failed_txs,
    v_total_txs
  FROM ${dbSchema}.transactions
  WHERE block_id = p_block_id;

  -- Update the blocks table
  UPDATE ${dbSchema}.blocks
  SET
    successful_txs = COALESCE(v_successful_txs, 0),
    failed_txs = COALESCE(v_failed_txs, 0),
    total_txs = COALESCE(v_total_txs, 0)
  WHERE id = p_block_id;
END;
$$ LANGUAGE plpgsql;
`
}
