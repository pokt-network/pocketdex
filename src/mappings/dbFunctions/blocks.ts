// Block analytics functions

export function getLatestBlocksByDayFn(dbSchema: string): string {
  return `CREATE OR REPLACE FUNCTION ${dbSchema}.get_latest_blocks_by_day(
    start_date TIMESTAMP,
    end_date TIMESTAMP
)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
    SELECT jsonb_agg(
        jsonb_build_object(
            'date', latest.day,
            'block', to_jsonb(b)
        )
        ORDER BY latest.day
    )
    FROM (
        SELECT date_trunc('day', "timestamp") AS day,
               MAX("timestamp") AS max_ts
        FROM ${dbSchema}.blocks
        WHERE "timestamp" >= start_date
          AND "timestamp" <= end_date
        GROUP BY 1
    ) latest
    JOIN ${dbSchema}.blocks b
      ON date_trunc('day', b."timestamp") = latest.day
     AND b."timestamp" = latest.max_ts;
$$;

COMMENT ON FUNCTION ${dbSchema}.get_latest_blocks_by_day(timestamp without time zone, timestamp without time zone) IS
'@name getLatestBlocksByDay
Returns the latest block for each day within the specified date range.';
`;
}
