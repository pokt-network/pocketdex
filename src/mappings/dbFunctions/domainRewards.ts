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
  -- claims: relay/reward aggregates from event_claim_settleds, each attributed to the config its supplier had
  --   declared for the service before the claim's session started (the block before the session start), which is
  --   the config that served the session: a stake in the session's first block activates at the next session, and
  --   an activation at that block carries the config already declared before it. In order of priority, among the
  --   supplier's versions of that config with at least one domain: the one live at that block; else the latest that
  --   started at or before it (one that ended before it); else the earliest one (genesis writes its configs at the
  --   first session's start), so a claim is never dropped. Within each, the latest version (then _id) wins, so an id the index
  --   still holds twice gives one row: a claim counts once. COALESCE evaluates the three in that order and stops at
  --   the first.
  --   The session start is the event's, or, when the event omits it (zero), session end - num_blocks_per_session
  --   + 1 with the param in force for that session (by active_at; equal to the event's start on every claim checked
  --   that carries one). Without either (no session heights), the settlement block is used, as before.
  --   Settlement comes sessions after the claim, so the config live at the settlement block can be another one,
  --   or none after an unstake.
  -- staked: distinct suppliers staked at any point during the day per (domain, service_id),
  --   uses _block_range && v_block_range; COUNT(DISTINCT) deduplicates across restakes.
  -- A row can carry rewards with suppliers_count 0 (or fewer suppliers than earned): a supplier that unstaked before
  --   the day its claims settled earns on it without being staked on it. No pocketdex function divides by it; the one
  --   consumer that does (igniter shareCalculations.ts, staked_suppliers) already skips a zero.
  WITH claims AS (
    SELECT
      domain,
      e.service_id,
      SUM(e.num_relays)                  AS relays,
      SUM(e.num_estimated_relays)        AS estimated_relays,
      SUM(e.num_claimed_computed_units)  AS computed_units,
      SUM(e.num_estimated_computed_units) AS estimated_computed_units,
      SUM(e.claimed_amount)              AS gross_rewards
    FROM (
      SELECT e.supplier_id, e.service_id, e.num_relays, e.num_estimated_relays, e.num_claimed_computed_units,
             e.num_estimated_computed_units, e.claimed_amount,
             -- without session heights (or a derived start that is not a height), the settlement block, as before
             coalesce(s.start - 1, e.block_id::bigint) AS declared_at
      FROM ${dbSchema}.event_claim_settleds e
      INNER JOIN ${dbSchema}.blocks b ON b.id = e.block_id
      -- the version in force for the session: the latest active at or before its end. A join, not a subquery in the
      -- CASE: memoized by session end it costs a few dozen probes a day, where the subquery ran once per claim
      LEFT JOIN LATERAL (
        SELECT p.value::bigint AS n FROM ${dbSchema}.params p
        WHERE p.namespace = 'shared' AND p.key = 'num_blocks_per_session'
          AND coalesce(p.active_at, lower(p._block_range)) <= e.session_end_height
        ORDER BY coalesce(p.active_at, lower(p._block_range)) DESC LIMIT 1
      ) p ON TRUE
      CROSS JOIN LATERAL (
        SELECT nullif(greatest(CASE WHEN e.session_start_height > 0 THEN e.session_start_height::bigint
                                    WHEN e.session_end_height > 0 THEN e.session_end_height::bigint - p.n + 1 END, 0),
                      0) AS start
      ) s
      WHERE b.timestamp::date = v_day
      -- a fence: the config lookup below then probes the index with declared_at as one column
      OFFSET 0
    ) e
    CROSS JOIN LATERAL (
      SELECT coalesce(
        (SELECT c.domains FROM ${dbSchema}.supplier_service_configs c
          WHERE c.supplier_id = e.supplier_id AND c.service_id = e.service_id AND jsonb_array_length(c.domains) > 0
            AND c._block_range @> e.declared_at
          ORDER BY lower(c._block_range) DESC, c._id LIMIT 1),
        (SELECT c.domains FROM ${dbSchema}.supplier_service_configs c
          WHERE c.supplier_id = e.supplier_id AND c.service_id = e.service_id AND jsonb_array_length(c.domains) > 0
            AND lower(c._block_range) <= e.declared_at
          ORDER BY lower(c._block_range) DESC, c._id LIMIT 1),
        (SELECT c.domains FROM ${dbSchema}.supplier_service_configs c
          WHERE c.supplier_id = e.supplier_id AND c.service_id = e.service_id AND jsonb_array_length(c.domains) > 0
            AND NOT isempty(c._block_range)
          ORDER BY lower(c._block_range), c._id LIMIT 1)) AS domains
      -- evaluated once per claim (inlined, a filter on it would run the lookups a second time)
      OFFSET 0
    ) d
    -- no row for a claim without domains (jsonb_array_elements_text of NULL is empty)
    CROSS JOIN jsonb_array_elements_text(d.domains) AS domain
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
    // The settlement catalog functions (settlement/functions.ts) read the first settlement height
    // (ORDER BY block_id LIMIT 1, on every call) and join entity rows to their block by id; the GIST
    // indexes SubQuery creates cannot serve either. Both already exist on mainnet under these names.
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_event_claim_settleds_block_id
      ON ${dbSchema}.event_claim_settleds (block_id)`,
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_blocks_id
      ON ${dbSchema}.blocks (id)`,
    // GIN index for array overlap queries on the domains column.
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ssc_domains
      ON ${dbSchema}.supplier_service_configs USING GIN (domains)`,
    // get_supplier_stats_by_domains reads only the live configs (upper_inf(_block_range)); without this
    // it seq-scans every config version (713k pages on mainnet for 243k live rows), and idx_ssc_domains
    // indexes all versions, so it does not help.
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ssc_live_supplier_domains
      ON ${dbSchema}.supplier_service_configs (supplier_id) INCLUDE (domains)
      WHERE upper_inf(_block_range)`,
    // Indexes for the domain_service_daily_rewards summary table.
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_dsdr_domain_day
      ON ${dbSchema}.domain_service_daily_rewards (domain, day)`,
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_dsdr_day
      ON ${dbSchema}.domain_service_daily_rewards (day)`,
    // Covering partial index for the PostGraphile `transactions` connection
    // (`ORDER BY block_id DESC LIMIT n` + `count(*)`). SubQuery only creates GIST
    // (col, _block_range) indexes, which cannot serve ordering, so both halves of
    // that query were parallel seq scans of the whole heap. PostGraphile adds
    // `id IS NOT NULL` to the WHERE clause, so the index is partial on that
    // predicate to allow an index-only scan for the count.
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS transactions_block_id_desc_live_idx
      ON ${dbSchema}.transactions (block_id DESC, _id) INCLUDE (_block_range)
      WHERE id IS NOT NULL`,
    // The PostGraphile `transactions` connection filtered by signer (`signer_address = $ ORDER BY
    // block_id DESC, _id LIMIT n`): the GIST (signer_address, _block_range) finds the rows but cannot
    // order them, so every transaction of the signer was read from the heap and sorted.
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS transactions_signer_block_id_desc_idx
      ON ${dbSchema}.transactions (signer_address, block_id DESC, _id) INCLUDE (_block_range)`,
    // Functional btree for the balances "reopen rows closed at this height" UPDATE
    // in updateBalances (src/mappings/bank/balanceChange.ts):
    //   UPDATE balances SET _block_range = int8range(lower(_block_range), NULL, '[)')
    //   WHERE upper(_block_range) = <blockId>
    // SubQuery only creates GIST (col, _block_range) indexes plus btrees on
    // id/_id/last_updated_block_id; none can serve `upper(_block_range) = $1`,
    // so every call was an index-only scan of the whole 2.7 GB GIST index.
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS balances_block_range_upper_idx
      ON ${dbSchema}.balances (upper(_block_range))`,
  ];
}
