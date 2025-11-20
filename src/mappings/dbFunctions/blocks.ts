// used to get the last block of each day in the date range
export function getLatestBlockByDayFn (dbSchema: string): string {
  return `CREATE OR REPLACE FUNCTION ${dbSchema}.get_latest_blocks_by_day(
    start_date timestamp,
    end_date timestamp
)
RETURNS JSONB
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
`
}
