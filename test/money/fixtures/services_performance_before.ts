// services_performance_between_times as main had it before the rewrite, frozen as the oracle the rewrite must match.
export function servicesPerformanceBetweenTimesBefore(dbSchema: string): string {
  return `CREATE OR REPLACE FUNCTION ${dbSchema}.services_performance_between_times_before(
    end_current TIMESTAMP,
    start_current_and_end_previous TIMESTAMP,
    start_previous TIMESTAMP
)
RETURNS jsonb
LANGUAGE sql
STABLE
AS $$
    with c as (
        SELECT
            r.service_id,
            SUM(r.relays) relays,
            SUM(r.estimated_relays) estimated_relays,
            SUM(r.computed_units) computed_units,
            SUM(r.estimated_computed_units) estimated_computed_units,
            SUM(r.claimed_upokt) claimed_upokt
        FROM ${dbSchema}.relay_by_block_and_services r
        INNER JOIN ${dbSchema}.blocks b ON b.id = r.block_id
        WHERE b.timestamp BETWEEN start_current_and_end_previous AND end_current
        GROUP BY r.service_id
    ),
    p as (
        SELECT
            r.service_id,
            SUM(r.estimated_computed_units) estimated_computed_units
        FROM ${dbSchema}.relay_by_block_and_services r
        INNER JOIN ${dbSchema}.blocks b ON b.id = r.block_id
        WHERE b.timestamp BETWEEN start_previous AND start_current_and_end_previous
        GROUP BY r.service_id
    ),
    apps as (
        SELECT
            app_ser.service_id,
            COUNT(DISTINCT app.id) amount
        FROM ${dbSchema}.applications app
        INNER JOIN ${dbSchema}.application_services app_ser ON app.id = app_ser.application_id
        WHERE
            app.stake_status = 'Staked' AND upper_inf(app._block_range) AND upper_inf(app_ser._block_range)
        GROUP BY app_ser.service_id
    ),
    suppliers as (
        SELECT
            supplier_ser.service_id,
            COUNT(DISTINCT supplier.id) amount
        FROM ${dbSchema}.suppliers supplier
        INNER JOIN ${dbSchema}.supplier_service_configs supplier_ser ON supplier.id = supplier_ser.supplier_id
        WHERE
            supplier.stake_status = 'Staked' AND upper_inf(supplier._block_range) AND upper_inf(supplier_ser._block_range)
        GROUP BY supplier_ser.service_id
    )
  SELECT jsonb_agg(to_jsonb(row)) FROM (
    SELECT
      c.service_id,
      s.name AS service_name,
      c.relays,
      c.estimated_relays,
      c.computed_units,
      c.estimated_computed_units,
      c.claimed_upokt,
      CASE
        WHEN p.estimated_computed_units IS NOT NULL AND p.estimated_computed_units <> 0 THEN
          (c.estimated_computed_units - p.estimated_computed_units)::NUMERIC / p.estimated_computed_units
        ELSE 1
      END AS change,
      COALESCE(apps.amount, 0) AS apps_staked,
      COALESCE(suppliers.amount, 0) AS suppliers_staked
    FROM c
    LEFT JOIN p ON c.service_id = p.service_id
    LEFT JOIN apps ON c.service_id = apps.service_id
    LEFT JOIN suppliers ON c.service_id = suppliers.service_id
    LEFT JOIN ${dbSchema}.services s ON c.service_id = s.id
    WHERE upper_inf(s._block_range)
    ORDER BY c.computed_units DESC
  ) row;
$$;
`;
}
