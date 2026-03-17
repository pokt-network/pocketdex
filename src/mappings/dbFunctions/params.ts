// Params analytics functions

export function getComputeUnitsToTokensMultiplierEvolutionFn(dbSchema: string): string {
  return `CREATE OR REPLACE FUNCTION ${dbSchema}.get_compute_units_to_tokens_multiplier_evolution(
    start_date TIMESTAMP,
    end_date TIMESTAMP,
    trunc_interval TEXT
)
RETURNS JSON
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
    RETURN (
        SELECT json_agg(
            json_build_object(
                'date_truncated', interval_ts,
                'block_id', block_id,
                'value', value
            )
            ORDER BY interval_ts
        )
        FROM (
            WITH latest_blocks_per_interval AS (
                SELECT DISTINCT ON (date_trunc(trunc_interval, b.timestamp))
                    date_trunc(trunc_interval, b.timestamp) AS interval_ts,
                    b.id AS block_id
                FROM ${dbSchema}.blocks b
                WHERE b.timestamp BETWEEN start_date AND end_date
                ORDER BY date_trunc(trunc_interval, b.timestamp), b.id DESC
            )
            SELECT
                lbpi.interval_ts,
                lbpi.block_id,
                p.value
            FROM latest_blocks_per_interval lbpi
            LEFT JOIN ${dbSchema}.params p ON
                p.id = 'shared-compute_units_to_tokens_multiplier' AND
                p._block_range @> lbpi.block_id::BIGINT
        ) subquery
    );
END;
$$;

COMMENT ON FUNCTION ${dbSchema}.get_compute_units_to_tokens_multiplier_evolution(timestamp without time zone, timestamp without time zone, text) IS
'@name getComputeUnitsToTokensMultiplierEvolution
Returns the evolution of the shared compute_units_to_tokens_multiplier param over time intervals,
showing the latest active value per interval between start_date and end_date.';
`;
}