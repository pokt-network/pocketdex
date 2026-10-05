// get_amount_of_blocks_and_suppliers_by_times as main had it before the rewrite, frozen as the oracle the rewrite must match.
export function getAmountOfBlocksAndSuppliersByTimesBefore(dbSchema: string): string {
  return `CREATE OR REPLACE FUNCTION ${dbSchema}.get_amount_of_blocks_and_suppliers_by_times_before(
    start_date TIMESTAMP,
    end_date TIMESTAMP
)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
  SELECT jsonb_agg(to_jsonb(row)) FROM (
    SELECT
        ss.service_id,
        COUNT(DISTINCT ss.block_id) blocks,
        SUM(ss.amount) suppliers_staked
    FROM ${dbSchema}.staked_suppliers_by_block_and_services ss
    INNER JOIN ${dbSchema}.blocks b ON b.id = ss.block_id
    WHERE b.timestamp BETWEEN start_date AND end_date
    GROUP BY ss.service_id
  ) row;
$$;
`;
}
