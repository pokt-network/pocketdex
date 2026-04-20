export const refreshDomainServiceDailyRewardsFnName = 'refresh_domain_service_daily_rewards';

export function createDomainServiceDailyRewardsTableFn(dbSchema: string): string {
  return `
CREATE TABLE IF NOT EXISTS ${dbSchema}.domain_service_daily_rewards (
  domain                    TEXT    NOT NULL,
  service_id                TEXT    NOT NULL,
  day                       DATE    NOT NULL,
  relays                    BIGINT  NOT NULL DEFAULT 0,
  estimated_relays          BIGINT  NOT NULL DEFAULT 0,
  computed_units            BIGINT  NOT NULL DEFAULT 0,
  estimated_computed_units  BIGINT  NOT NULL DEFAULT 0,
  gross_rewards             NUMERIC NOT NULL DEFAULT 0,
  suppliers_count           INT     NOT NULL DEFAULT 0,
  PRIMARY KEY (domain, service_id, day)
);
`;
}

export function refreshDomainServiceDailyRewardsFn(dbSchema: string): string {
  return `
CREATE OR REPLACE FUNCTION ${dbSchema}.${refreshDomainServiceDailyRewardsFnName}(p_block_id bigint)
RETURNS void
LANGUAGE plpgsql
SET jit = off
AS $$
DECLARE
  v_day DATE;
  v_block_range int8range;
BEGIN
  SELECT b.timestamp::date
  INTO v_day
  FROM ${dbSchema}.blocks b
  WHERE b.id = p_block_id;

  IF v_day IS NULL THEN
    RETURN;
  END IF;

  SELECT int8range(MIN(id)::bigint, MAX(id)::bigint, '[]')
  INTO v_block_range
  FROM ${dbSchema}.blocks
  WHERE timestamp::date = v_day;

  DELETE FROM ${dbSchema}.domain_service_daily_rewards
  WHERE day = v_day;

  -- Recompute and insert the full day's data.
  -- claims: relay/reward aggregates from event_claim_settleds.
  --   joins ssc on supplier_id, service_id, and _block_range @> e.block_id to match exactly
  --   the one ssc record active at claim time — avoids overcounting from historical restakes.
  -- staked: distinct suppliers staked at any point during the day per (domain, service_id),
  --   uses _block_range && v_block_range; COUNT(DISTINCT) deduplicates across restakes.
  WITH claims AS (
    SELECT
      domain,
      e.service_id,
      SUM(e.num_relays)                  AS relays,
      SUM(e.num_estimated_relays)        AS estimated_relays,
      SUM(e.num_claimed_computed_units)  AS computed_units,
      SUM(e.num_estimated_computed_units) AS estimated_computed_units,
      SUM(e.claimed_amount)              AS gross_rewards
    FROM ${dbSchema}.event_claim_settleds e
    INNER JOIN ${dbSchema}.blocks b ON b.id = e.block_id
    INNER JOIN ${dbSchema}.supplier_service_configs ssc
      ON ssc.supplier_id = e.supplier_id
      AND ssc.service_id = e.service_id
      AND ssc._block_range @> e.block_id::bigint
    CROSS JOIN jsonb_array_elements_text(ssc.domains) AS domain
    WHERE b.timestamp::date = v_day
      AND ssc.domains IS NOT NULL
    GROUP BY domain, e.service_id
  ),
  staked AS (
    SELECT
      domain,
      ssc.service_id,
      COUNT(DISTINCT ssc.supplier_id) AS suppliers_count
    FROM ${dbSchema}.supplier_service_configs ssc
    INNER JOIN ${dbSchema}.suppliers s ON s.id = ssc.supplier_id
      AND s._block_range && v_block_range
      AND s.stake_status = 'Staked'
    CROSS JOIN jsonb_array_elements_text(ssc.domains) AS domain
    WHERE ssc._block_range && v_block_range
      AND ssc.domains IS NOT NULL
    GROUP BY domain, ssc.service_id
  )
  INSERT INTO ${dbSchema}.domain_service_daily_rewards
    (domain, service_id, day, relays, estimated_relays,
     computed_units, estimated_computed_units, gross_rewards, suppliers_count)
  SELECT
    c.domain,
    c.service_id,
    v_day,
    c.relays,
    c.estimated_relays,
    c.computed_units,
    c.estimated_computed_units,
    c.gross_rewards,
    COALESCE(s.suppliers_count, 0)
  FROM claims c
  LEFT JOIN staked s ON s.domain = c.domain AND s.service_id = c.service_id;
END;
$$;
`;
}

// Each SQL must be executed as a separate query — CREATE INDEX CONCURRENTLY cannot run inside a transaction.
export function getPerformanceIndexSqls(dbSchema: string): string[] {
  return [
    // Composite index for event_claim_settleds lookups by supplier + block + service.
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_event_claim_settleds_supplier_block_service
      ON ${dbSchema}.event_claim_settleds (supplier_id, block_id, service_id)`,
    // Covering index for blocks timestamp→id lookups (enables index-only scans).
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_blocks_timestamp_id
      ON ${dbSchema}.blocks (timestamp, id)`,
    // GIN index for array overlap queries on the domains column.
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ssc_domains
      ON ${dbSchema}.supplier_service_configs USING GIN (domains)`,
    // Indexes for the domain_service_daily_rewards summary table.
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_dsdr_domain_day
      ON ${dbSchema}.domain_service_daily_rewards (domain, day)`,
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_dsdr_day
      ON ${dbSchema}.domain_service_daily_rewards (day)`,
  ];
}
