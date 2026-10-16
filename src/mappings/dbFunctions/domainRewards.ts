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
-- The settlement heights that formed each row: the lowest and the highest whose claims it holds. The refresh adds each
-- settlement block to its day and uses last_height to know the day already holds every earlier one. NULL on rows written
-- before these columns existed (no default, so the ALTER only changes the catalog): the refresh then rebuilds the day.
-- Altered only when a column is missing: ALTER TABLE takes its ACCESS EXCLUSIVE lock even when IF NOT EXISTS then changes
-- nothing, which every start would queue behind the readers of this table. Hidden from the API, which keeps its fields.
DO $$
BEGIN
  IF (SELECT count(*) FROM pg_attribute WHERE attrelid = '${dbSchema}.domain_service_daily_rewards'::regclass
        AND attname IN ('first_height', 'last_height') AND NOT attisdropped) < 2 THEN
    ALTER TABLE ${dbSchema}.domain_service_daily_rewards
      ADD COLUMN IF NOT EXISTS first_height BIGINT, ADD COLUMN IF NOT EXISTS last_height BIGINT;
    COMMENT ON COLUMN ${dbSchema}.domain_service_daily_rewards.first_height IS E'@omit';
    COMMENT ON COLUMN ${dbSchema}.domain_service_daily_rewards.last_height IS E'@omit';
  END IF;
END $$;
`;
}

export function refreshDomainServiceDailyRewardsFn(dbSchema: string): string {
  return `
CREATE OR REPLACE FUNCTION ${dbSchema}.${refreshDomainServiceDailyRewardsFnName}(p_block_id bigint)
RETURNS void
LANGUAGE plpgsql
SET jit = off
-- planned for each call: the claims read is one block or the whole day, and a generic plan would serve both alike
SET plan_cache_mode = force_custom_plan
AS $$
DECLARE
  v_day DATE;
  v_block_range int8range;
  v_known BOOLEAN;
  v_last BIGINT;
  v_full BOOLEAN;
BEGIN
  SELECT b.timestamp::date
  INTO v_day
  FROM ${dbSchema}.blocks b
  WHERE b.id = p_block_id;

  IF v_day IS NULL THEN
    RETURN;
  END IF;

  -- the day's blocks through the (timestamp, id) index (10 ms): MIN/MAX over the table walk the id index from its
  -- first block until one is in the day (0.6 s on mainnet, 883k buffers), so the fence keeps them on the day's rows
  SELECT int8range(MIN(id)::bigint, MAX(id)::bigint, '[]')
  INTO v_block_range
  FROM (
    SELECT id FROM ${dbSchema}.blocks
    WHERE timestamp >= v_day AND timestamp < v_day + 1
    OFFSET 0
  ) b;

  -- Each settlement block adds its own claims to its day's rows, so the cost of a block does not grow through the day
  -- (recomputing the day took 0.9 s at the first settlement block and 16 s at the last, mainnet replica 2026-10-16).
  -- That holds the day exactly when the rows already hold every settlement height of the day below this one and none
  -- at or above it: every row has its heights, the highest is below this block, and no claim of the day settled after
  -- it other than this block's (the rows' heights are the settlement blocks that credited a domain). Otherwise the day
  -- is rebuilt from its claims: a block indexed again after a rewind (SubQuery's rewind does not touch this table, and
  -- the rewound claims are gone), rows written before the height columns, or a call for any other block, such as a
  -- manual call for a day whose rows were deleted.
  SELECT bool_and(last_height IS NOT NULL), max(last_height)
  INTO v_known, v_last
  FROM ${dbSchema}.domain_service_daily_rewards
  WHERE day = v_day;
  v_last := coalesce(v_last, lower(v_block_range) - 1);
  v_full := NOT coalesce(v_known, true) OR v_last >= p_block_id OR EXISTS (
    SELECT 1 FROM ${dbSchema}.event_claim_settleds
    WHERE block_id > v_last AND block_id < p_block_id
  ) OR EXISTS (
    SELECT 1 FROM ${dbSchema}.event_claim_settleds
    WHERE block_id > p_block_id AND block_id < upper(v_block_range)
  );

  IF v_full THEN
    DELETE FROM ${dbSchema}.domain_service_daily_rewards
    WHERE day = v_day;
  END IF;

  -- The claims of the day (rebuild) or of this block, added to the day's rows.
  -- claims: relay/reward aggregates from event_claim_settleds, each attributed to the config its supplier had
  --   declared for the service before the claim's session started (the block before the session start), which is
  --   the config that served the session: a stake in the session's first block activates at the next session, and
  --   an activation at that block carries the config already declared before it. In order of priority, among the
  --   supplier's versions of that config: the one live at that block; else the latest that started at or before it
  --   (one that ended before it); else the earliest one (genesis writes its configs at the first session's start),
  --   so a claim always finds its version. The version is chosen by time alone: its domains are the claim's, and a
  --   version without domains (NULL or []) credits none, as the staked part counts it under none. Skipping it for
  --   another version's domains would credit a domain the supplier did not declare for that session. Within each, the latest version (then _id) wins, so an id the index
  --   still holds twice gives one row: a claim counts once. COALESCE evaluates the three in that order and stops at
  --   the first.
  --   The session start is the event's, or, when the event omits it (zero), session end - num_blocks_per_session
  --   + 1 with the param in force for that session (by active_at; equal to the event's start on every claim checked
  --   that carries one). Without either (no session heights), the settlement block is used, as before.
  --   Settlement comes sessions after the claim, so the config live at the settlement block can be another one,
  --   or none after an unstake.
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
      SUM(e.claimed_amount)              AS gross_rewards,
      MIN(e.block_id)                    AS first_height,
      MAX(e.block_id)                    AS last_height
    FROM (
      SELECT e.block_id, e.supplier_id, e.service_id, e.num_relays, e.num_estimated_relays, e.num_claimed_computed_units,
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
        -- this block only, unless the day is rebuilt: the day's blocks are within v_block_range
        AND e.block_id BETWEEN CASE WHEN v_full THEN lower(v_block_range) ELSE p_block_id END
                           AND CASE WHEN v_full THEN upper(v_block_range) - 1 ELSE p_block_id END
      -- a fence: the config lookup below then probes the index with declared_at as one column
      OFFSET 0
    ) e
    CROSS JOIN LATERAL (
      -- each lookup returns its version as {"d": domains}, never NULL when it finds one: the version found decides,
      -- even with no domains (NULL or []), and the next lookup runs only when none was found
      SELECT coalesce(
        (SELECT jsonb_build_object('d', c.domains) FROM ${dbSchema}.supplier_service_configs c
          WHERE c.supplier_id = e.supplier_id AND c.service_id = e.service_id
            AND c._block_range @> e.declared_at
          ORDER BY lower(c._block_range) DESC, c._id LIMIT 1),
        (SELECT jsonb_build_object('d', c.domains) FROM ${dbSchema}.supplier_service_configs c
          WHERE c.supplier_id = e.supplier_id AND c.service_id = e.service_id
            AND lower(c._block_range) <= e.declared_at
          ORDER BY lower(c._block_range) DESC, c._id LIMIT 1),
        -- runs only when no version started at or before declared_at: the session precedes the first one (genesis)
        (SELECT jsonb_build_object('d', c.domains) FROM ${dbSchema}.supplier_service_configs c
          WHERE c.supplier_id = e.supplier_id AND c.service_id = e.service_id AND NOT isempty(c._block_range)
          ORDER BY lower(c._block_range), c._id LIMIT 1))->'d' AS domains
      -- evaluated once per claim (inlined, a filter on it would run the lookups a second time)
      OFFSET 0
    ) d
    -- no row for a claim whose version has no domain (NULL, JSON null or []): the has-domain rule of the staked part
    CROSS JOIN jsonb_array_elements_text(CASE WHEN jsonb_typeof(d.domains) = 'array' THEN d.domains END) AS domain
    GROUP BY domain, e.service_id
  )
  INSERT INTO ${dbSchema}.domain_service_daily_rewards AS t
    (domain, service_id, day, relays, estimated_relays,
     computed_units, estimated_computed_units, gross_rewards, first_height, last_height)
  SELECT
    c.domain,
    c.service_id,
    v_day,
    c.relays,
    c.estimated_relays,
    c.computed_units,
    c.estimated_computed_units,
    c.gross_rewards,
    c.first_height,
    c.last_height
  FROM claims c
  ON CONFLICT (domain, service_id, day) DO UPDATE SET
    relays                   = t.relays + EXCLUDED.relays,
    estimated_relays         = t.estimated_relays + EXCLUDED.estimated_relays,
    computed_units           = t.computed_units + EXCLUDED.computed_units,
    estimated_computed_units = t.estimated_computed_units + EXCLUDED.estimated_computed_units,
    gross_rewards            = t.gross_rewards + EXCLUDED.gross_rewards,
    first_height             = LEAST(t.first_height, EXCLUDED.first_height),
    last_height              = GREATEST(t.last_height, EXCLUDED.last_height);

  -- staked: distinct suppliers staked at any point during the day so far per (domain, service_id), on every row of the
  --   day, as the day's blocks grow; uses _block_range && v_block_range; COUNT(DISTINCT) deduplicates across restakes.
  --   It is not a sum over blocks, so it is recounted, which costs the same at every block (0.5 s, mainnet replica).
  WITH staked AS (
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
      AND jsonb_array_length(ssc.domains) > 0
    GROUP BY domain, ssc.service_id
  )
  UPDATE ${dbSchema}.domain_service_daily_rewards r
  SET suppliers_count = x.suppliers_count
  FROM (
    SELECT d.domain, d.service_id, COALESCE(s.suppliers_count, 0) AS suppliers_count
    FROM ${dbSchema}.domain_service_daily_rewards d
    LEFT JOIN staked s ON s.domain = d.domain AND s.service_id = d.service_id
    WHERE d.day = v_day
  ) x
  WHERE r.day = v_day AND r.domain = x.domain AND r.service_id = x.service_id
    AND r.suppliers_count IS DISTINCT FROM x.suppliers_count;
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
    // get_supplier_stats_by_domains (igniter, once a minute per provider): the live configs of the domains, then their
    // live suppliers. Both tables keep every version (mainnet 2026-10-13: 179,283 supplier rows for nodefleet.net's
    // 2,350 live suppliers), and the indexes above cover all of them, so the query read 725k supplier rows (a seq
    // scan, ~400 ms). These cover the live rows only.
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ssc_live_domains
      ON ${dbSchema}.supplier_service_configs USING GIN (domains)
      WHERE upper_inf(_block_range)`,
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_suppliers_live_id
      ON ${dbSchema}.suppliers (id) INCLUDE (stake_status, stake_amount)
      WHERE upper_inf(_block_range)`,
    // get_service_summary and get_supplier_fleet(services): the live configs of a service. Without it the summary of
    // every service seq-scanned all 9.6M config versions for the 157k live ones (1.8 s, mainnet replica 2026-10-13).
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ssc_live_service
      ON ${dbSchema}.supplier_service_configs (service_id, supplier_id)
      WHERE upper_inf(_block_range)`,
    // get_supplier_fleet's per-supplier service count: the live configs of each supplier by supplier_id first. With only
    // idx_ssc_live_service (service_id first), the planner inside the function scanned that whole index once per
    // supplier: an owner of 230 suppliers took 1.4 s and 340k buffer reads (mainnet replica, 2026-10-14) for what an
    // index led by supplier_id answers in ~25 ms.
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ssc_live_supplier_service
      ON ${dbSchema}.supplier_service_configs (supplier_id, service_id)
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
    // get_supplier_proofs reads proofs by supplier over a block range. SubQuery's GIST (supplier_id, _block_range) and
    // (block_id, _block_range) cannot serve that, so an owner's 1037 suppliers over 30 days read every proof of the
    // network in the range (17.6 s on mainnet, 2026-10-08; 14.7M rows in each table).
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_msg_submit_proofs_supplier_block
      ON ${dbSchema}.msg_submit_proofs (supplier_id, block_id)`,
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_event_proof_validity_checkeds_supplier_block
      ON ${dbSchema}.event_proof_validity_checkeds (supplier_id, block_id)`,
    // The suppliers that share revenue with an address now (the catalog's `operators`): containment on the live
    // configs, which otherwise scans all 157k of them (0.36 s on mainnet, 2026-10-08).
    // Claims and proofs looked up by session (PostGraphile `sessionId: { in: [...] }`): with no index on session_id,
    // each lookup scanned the table (38.8 s on event_claim_settleds, 18.2 s on msg_submit_proofs, mainnet 2026-10-09).
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_event_claim_settleds_session_id
      ON ${dbSchema}.event_claim_settleds (session_id)`,
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_msg_submit_proofs_session_id
      ON ${dbSchema}.msg_submit_proofs (session_id)`,
    // Claims settled looked up by service and session window, paged by id (PostGraphile `serviceId` + `sessionEndHeight`
    // range): with no index on them, each page walked the id index over the whole table (~10 s, 3.4M blocks read,
    // mainnet replica 2026-10-10).
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_event_claim_settleds_service_session_end
      ON ${dbSchema}.event_claim_settleds (service_id, session_end_height)`,
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_ssc_live_rev_share
      ON ${dbSchema}.supplier_service_configs USING GIN (rev_share jsonb_path_ops)
      WHERE upper_inf(_block_range)`,
    // The newest relay mining difficulty update of a service (get_service_summary; get_relay_mining_difficulty's newest
    // first per service): the GiST on (service_id, _block_range) finds a service's updates but cannot order them, so the
    // summary of every service read all 1.06M and sorted them per service (2.2 s, mainnet replica 2026-10-14).
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_rmd_service_block
      ON ${dbSchema}.event_relay_mining_difficulty_updateds (service_id, block_id)`,
    // Morse claimable accounts by their Shannon destination and by their Morse address (/migration search,
    // pnf-explorer): only GiST indexes on other columns, so each lookup scanned the table (57,764 rows, 53 MB on
    // mainnet, 2026-10-14).
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_morse_claimable_accounts_shannon_dest
      ON ${dbSchema}.morse_claimable_accounts (shannon_dest_address)`,
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_morse_claimable_accounts_morse_output
      ON ${dbSchema}.morse_claimable_accounts (morse_output_address)`,
    // A block's metadata record by height (get_block_metadata): only SubQuery's primary key and a GiST on other
    // columns, so each lookup scanned the table (1148 MB on beta, 2026-10-15). Built by hand on mainnet first, with this
    // definition.
    `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_block_metadata_id
      ON ${dbSchema}.block_metadata USING btree (id)`,
  ];
}
