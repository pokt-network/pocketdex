import { ROLLUP_VERSION } from "./writer";

// Catalog functions over the settlement money tables (./schema.ts), plus three over SubQuery entity
// tables (app auto-unstakes, supplier proofs, param history).
//
// Time: [range_start, range_end) against the settlement block_time; NULL/NULL is the whole history. Both are
// timestamptz at any precision: pass them with an explicit zone ('2026-10-01T00:00:00Z', '...-04:00'). A value without
// a zone is read in the session's TimeZone before the function sees it, so it cannot be detected or rejected here; on
// pnf that is UTC (SHOW timezone on the explorer replica: Etc/UTC, from the configuration file, 2026-10-02). GraphQL
// passes a Datetime without a zone the same way (measured in tilt). bucket is NULL (one total) or
// hour | day | week | month | year, in UTC. Every row carries bucket_start and bucket_end: the bucket's
// edges, or, without a bucket, the span the call summed. Reads are hybrid: whole UTC days inside the range come
// from the daily rollups, the edges and hourly buckets from the per-settlement tables.
// By default the output is sparse: only the buckets and series that have rows, and a bucket, series or id that is
// absent is 0 (the caller fills gaps when it charts). fill_empty_buckets => true returns every bucket of every series
// up to the last written settlement with 0 where nothing happened, at a considerable latency cost on large answers
// (for the largest shareholder by supplier and service over 30 days by day it adds 867k zero rows to 1.06M).
// Rows come newest first (bucket_start descending; get_param_history by height descending), then by the text columns
// ascending, so paging and CSV exports are stable and a capped GraphQL list keeps the newest rows.
//
// A breakdown column the caller did not ask for (by_service = false, ...) holds 'all': the row sums every value
// of it. NULL means the column does not apply to the row (a staker payout has no supplier or service).
// transfer_count counts payout legs: one per claim and family (relay, global) that paid the address.
// The id a function is asked about is a breakdown too: by_supplier / by_address / by_application / ... (default true)
// gives a row per id, false sums the whole list into one row with 'all' (a fleet or group total). Every requested id
// gets its row or series even without activity (0), and an idle list its zero group row, only with
// fill_empty_buckets => true; such a row says 'all' in the breakdown columns it has no value for.
// A NULL id list means every id in get_supplier_earnings, get_supplier_proofs (with no owners either),
// get_validator_rewards and get_delegator_income, so a caller never has to send the list; get_delegator_income also
// takes validators, keeping the income its delegators got from those validators. The size of such an answer is set by
// the bucket and the by_* flags, and GraphQL caps its rows (--query-limit).
// The supplier functions take suppliers or owners: owners resolves, with no cap, the suppliers each owner owns now
// (the Supplier entity's current version, unstaked suppliers included) and reports their whole history, also from
// before a change of owner. An owner with no supplier returns no rows.
//
// Coverage: a range that starts before the first written settlement raises, unless the first written
// settlement is the chain's first one, and so does a range that overlaps a settlement_gaps row. Heights that
// were never written must not read as zero. money_coverage(range_start, range_end) lists the settlement heights in a
// range that are missing, and the recorded gaps.
//
// The legacy_* functions answer the live get_rewards_* / get_mint_breakdown_between_dates /
// get_burn_breakdown_between_dates with their signatures and JSON, from the money tables, for a consumer to switch to.
// Their names swap "get_" for "legacy_" (a prefix would push two of them past PostgreSQL's 63-character limit). Like
// the live functions, they take any number of addresses; the catalog functions take at most 200 ids. A range the money
// tables do not cover (money_coverage) raises, where the live function would answer from its own tables.
// The catalog functions that return rows: GraphQL lists (smartTags.ts) with a <name>_json twin (end of this file).
export const CATALOG_FUNCTIONS = [
  "money_coverage",
  "get_application_spend",
  "get_gateway_spend",
  "get_supplier_earnings",
  "get_supplier_distribution",
  "get_income",
  "get_validator_rewards",
  "get_delegator_income",
  "get_supply_flows",
  "get_supplier_penalties",
  "get_service_usage",
  "get_app_auto_unstakes",
  "get_supplier_proofs",
  "get_param_history",
];
const CATALOG_SQL = `ARRAY[${CATALOG_FUNCTIONS.map((f) => `'${f}'`).join(", ")}]::text[]`;

export function createSettlementFunctionsFn(dbSchema: string): string {
  const s = dbSchema;
  return `
CREATE OR REPLACE FUNCTION ${s}._validate(p_list text[], p_name text, range_start timestamptz, range_end timestamptz, bucket text)
RETURNS void LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  IF p_name <> '' AND (p_list IS NULL OR cardinality(p_list) < 1 OR cardinality(p_list) > 200) THEN
    RAISE EXCEPTION '% must have between 1 and 200 elements (has %)', p_name, coalesce(cardinality(p_list), 0);
  END IF;
  IF bucket IS NOT NULL AND bucket NOT IN ('hour', 'day', 'week', 'month', 'year') THEN
    RAISE EXCEPTION 'invalid bucket: %', bucket;
  END IF;
  -- Which buckets a range allows, to stay within the latency budget: hour up to 7 days, day up to
  -- 92 days (three months), week up to 366 days, month/year any range. The whole history allows a total, month or year.
  IF bucket = 'hour' AND (range_start IS NULL OR range_end IS NULL OR range_end - range_start > interval '7 days') THEN
    RAISE EXCEPTION 'bucket=hour allows ranges up to 7 days; use day (up to 92 days), week, month or year for longer ones';
  END IF;
  IF bucket = 'day' AND (range_start IS NULL OR range_end IS NULL OR range_end - range_start > interval '92 days') THEN
    RAISE EXCEPTION 'bucket=day allows ranges up to 92 days; use week (up to 366 days), month or year for longer ones';
  END IF;
  IF bucket = 'week' AND (range_start IS NULL OR range_end IS NULL OR range_end - range_start > interval '366 days') THEN
    RAISE EXCEPTION 'bucket=week allows ranges up to 366 days; use month or year for longer ones';
  END IF;
  IF range_start IS NOT NULL AND range_end IS NOT NULL AND range_start >= range_end THEN
    RAISE EXCEPTION 'range_start must be earlier than range_end';
  END IF;
END $$;

-- Raises when [range_start, range_end) starts before the first written settlement, unless that settlement is the
-- chain's first one (the min block_id of event_claim_settleds), or overlaps a settlement_gaps row. Those
-- lookups are index probes: a gap spans the time between the written settlements around it.
CREATE OR REPLACE FUNCTION ${s}._check_coverage(range_start timestamptz, range_end timestamptz)
RETURNS void LANGUAGE plpgsql STABLE SET plan_cache_mode = force_custom_plan AS $$
DECLARE v_first bigint; v_first_ts timestamptz; v_chain_first numeric; v_gap_from bigint; v_gap_to bigint;
BEGIN
  SELECT e.block_id INTO v_chain_first FROM ${s}.event_claim_settleds e ORDER BY e.block_id LIMIT 1;
  IF v_chain_first IS NULL THEN RETURN; END IF;
  SELECT sb.height, sb.block_time INTO v_first, v_first_ts FROM ${s}.settlement_blocks sb ORDER BY sb.height LIMIT 1;
  IF v_first IS NULL THEN
    RAISE EXCEPTION 'no settlement height is written yet (the chain settles claims since height %)', v_chain_first;
  END IF;
  IF v_first > v_chain_first AND (range_start IS NULL OR range_start < v_first_ts) THEN
    RAISE EXCEPTION 'the range starts before the first written settlement (height %, %): earlier settlement heights are not written',
      v_first, v_first_ts;
  END IF;
  SELECT gp.from_height, gp.to_height INTO v_gap_from, v_gap_to
  FROM ${s}.settlement_gaps gp
  WHERE (range_end IS NULL OR range_end > coalesce((SELECT sb.block_time FROM ${s}.settlement_blocks sb WHERE sb.height < gp.from_height
                                          ORDER BY sb.height DESC LIMIT 1), '-infinity'))
    AND (range_start IS NULL OR range_start < coalesce((SELECT sb.block_time FROM ${s}.settlement_blocks sb WHERE sb.height > gp.to_height
                                              ORDER BY sb.height LIMIT 1), 'infinity'))
  ORDER BY gp.from_height LIMIT 1;
  IF v_gap_from IS NOT NULL THEN
    RAISE EXCEPTION 'the range overlaps settlement heights % to %, which are not written (settlement_gaps)', v_gap_from, v_gap_to;
  END IF;
END $$;

-- A rollup column added later (claims_with_proof v2, commission_na_count v2, the monthly triple v3, replayed_count v4)
-- holds its default on days written before, until rebuild_rollups recomputes them: reading those days would undercount
-- without any error. Every read of rollup days [d1, d2] raises instead when a settlement of those days carries an older
-- rollup_version than the writer's (ROLLUP_VERSION, ./writer.ts).
CREATE OR REPLACE FUNCTION ${s}._require_current_rollups(d1 date, d2 date)
RETURNS void LANGUAGE plpgsql STABLE SET plan_cache_mode = force_custom_plan AS $$
DECLARE v int; h1 bigint; h2 bigint;
BEGIN
  SELECT min(sb.rollup_version), min(sb.height), max(sb.height) INTO v, h1, h2 FROM ${s}.settlement_blocks sb
  WHERE sb.day BETWEEN d1 AND d2 AND sb.rollup_version < ${ROLLUP_VERSION};
  IF v IS NOT NULL THEN
    RAISE EXCEPTION 'settlement heights % to % were written with rollup version % (current %): run rebuild_rollups first',
      h1, h2, v, ${ROLLUP_VERSION};
  END IF;
END $$;

-- Rollup days [d1, d2] = the whole UTC days inside [from, to) (rollups are incremental: there is no
-- "closed day"). Base = heights in [lo1, hi1] and [lo2, hi2] (the edges). p_no_rollup, or the GUC
-- money.no_rollup = on, sends everything to the base tables.
CREATE OR REPLACE FUNCTION ${s}._ranges(range_start timestamptz, range_end timestamptz, bucket text, p_no_rollup boolean DEFAULT false,
  OUT d1 date, OUT d2 date, OUT lo1 bigint, OUT hi1 bigint, OUT lo2 bigint, OUT hi2 bigint)
LANGUAGE plpgsql STABLE SET plan_cache_mode = force_custom_plan AS $$
DECLARE f timestamptz := coalesce(range_start, '-infinity'); t timestamptz := coalesce(range_end, 'infinity');
BEGIN
  PERFORM ${s}._check_coverage(range_start, range_end);
  IF bucket IS DISTINCT FROM 'hour' AND NOT p_no_rollup AND coalesce(current_setting('money.no_rollup', true), 'off') <> 'on' THEN
    d1 := CASE WHEN range_start IS NULL THEN (SELECT min(day) FROM ${s}.settlement_blocks)
               WHEN range_start = ((range_start AT TIME ZONE 'UTC')::date::timestamp AT TIME ZONE 'UTC') THEN (range_start AT TIME ZONE 'UTC')::date
               ELSE (range_start AT TIME ZONE 'UTC')::date + 1 END;
    d2 := CASE WHEN range_end IS NULL THEN (SELECT max(day) FROM ${s}.settlement_blocks)
               ELSE (range_end AT TIME ZONE 'UTC')::date - 1 END;
    IF d1 IS NULL OR d2 IS NULL OR d1 > d2 THEN d1 := NULL; END IF;
  END IF;
  IF d1 IS NULL THEN
    d1 := 'infinity'; d2 := '-infinity';
    SELECT min(height), max(height) INTO lo1, hi1 FROM ${s}.settlement_blocks WHERE block_time >= f AND block_time < t;
    lo2 := 0; hi2 := -1;
  ELSE
    SELECT min(height), max(height) INTO lo1, hi1 FROM ${s}.settlement_blocks
    WHERE block_time >= f AND block_time < (d1::timestamp AT TIME ZONE 'UTC');
    SELECT min(height), max(height) INTO lo2, hi2 FROM ${s}.settlement_blocks
    WHERE block_time >= ((d2 + 1)::timestamp AT TIME ZONE 'UTC') AND block_time < t;
  END IF;
  lo1 := coalesce(lo1, 0); hi1 := coalesce(hi1, -1); lo2 := coalesce(lo2, 0); hi2 := coalesce(hi2, -1);
  IF d1 <= d2 THEN PERFORM ${s}._require_current_rollups(d1, d2); END IF;
END $$;

-- The span a call answers for: the requested [range_start, range_end), or, for an open end, the first / last written
-- settlement. Every row carries it as bucket_start / bucket_end when there is no bucket, so a caller sees what
-- was summed. An open range_end gives the last settlement's block_time, which the span includes. t_last is the
-- last instant a series lists buckets for: range_end (exclusive) or the last written settlement, whichever comes
-- first, so a bucket that is not indexed yet is absent, not a zero.
CREATE OR REPLACE FUNCTION ${s}._span(range_start timestamptz, range_end timestamptz, OUT f timestamptz, OUT t timestamptz,
  OUT t_last timestamptz)
LANGUAGE sql STABLE AS $$
  SELECT coalesce(range_start, (SELECT min(block_time) FROM ${s}.settlement_blocks)),
         coalesce(range_end, (SELECT max(block_time) FROM ${s}.settlement_blocks)),
         least(range_end - interval '1 microsecond', (SELECT max(block_time) FROM ${s}.settlement_blocks))
$$;

-- The same span over indexed blocks, for the functions that count chain events outside settlements (auto-unstakes,
-- proofs): their series run to the last indexed block, not to the last settlement, so a series sums to its total.
CREATE OR REPLACE FUNCTION ${s}._block_span(range_start timestamptz, range_end timestamptz, OUT f timestamptz,
  OUT t timestamptz, OUT t_last timestamptz)
LANGUAGE sql STABLE AS $$
  SELECT coalesce(range_start, b.first_ts), coalesce(range_end, b.last_ts), least(range_end - interval '1 microsecond', b.last_ts)
  FROM (SELECT (SELECT bl.timestamp AT TIME ZONE 'UTC' FROM ${s}.blocks bl ORDER BY bl.timestamp, bl.id LIMIT 1) first_ts,
               (SELECT bl.timestamp AT TIME ZONE 'UTC' FROM ${s}.blocks bl ORDER BY bl.timestamp DESC, bl.id DESC LIMIT 1) last_ts) b
$$;

-- Every bucket of a span, in UTC: with a bucket and fill_empty_buckets, the catalog functions return each series once per bucket, with
-- zeros where nothing happened, so the result plots without client-side gap filling. A function returns its rows up
-- to t_last as they are and adds only the (bucket, series) cells it has no row for, by NOT EXISTS, and runs with
-- enable_mergejoin = off: the planner sees ~1,000 buckets per series and far fewer rows than there are, and picks a
-- merge join whose sorts of every row spill to disk (by supplier per day over a year, 802k rows: 8.7 s warm, 4.7 s
-- with the hash anti-join; measured on the one-year synthetic data).
-- plan_cache_mode = force_custom_plan: PL/pgSQL caches each statement's plan and from the sixth call in a session
-- switches to a generic plan made without the arguments, where "list IS NULL OR id = ANY(list)" and the range bounds
-- are unknown; PostGraphile reuses connections, so every call after the fifth would get it. Measured on the synthetic
-- data: get_income for the largest shareholder, a year by supplier and service, 27 s with a custom plan, over 90 s
-- (cancelled) with the generic one.
CREATE OR REPLACE FUNCTION ${s}._buckets(bucket text, span_first timestamptz, span_last timestamptz,
  OUT bucket_start timestamptz, OUT bucket_end timestamptz)
RETURNS SETOF record LANGUAGE sql IMMUTABLE AS $$
  SELECT g AT TIME ZONE 'UTC', (g + ('1 ' || bucket)::interval) AT TIME ZONE 'UTC'
  FROM generate_series(date_trunc(bucket, span_first AT TIME ZONE 'UTC'), date_trunc(bucket, span_last AT TIME ZONE 'UTC'),
                       ('1 ' || bucket)::interval) g
$$;

-- Bucket edges in UTC: the start of the hour/day/... and the start of the next one; without a bucket, the span.
-- They run once per base row, so they must be inlined: _bucket_end is STABLE because the text-to-interval cast is,
-- and an IMMUTABLE SQL function whose body calls a STABLE one is executed as a call (2.4x slower over 738k rows, measured).
CREATE OR REPLACE FUNCTION ${s}._bucket(bucket text, p_ts timestamptz, p_span_from timestamptz)
RETURNS timestamptz LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN bucket IS NULL THEN p_span_from ELSE date_trunc(bucket, p_ts AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' END
$$;
CREATE OR REPLACE FUNCTION ${s}._bucket_end(bucket text, p_ts timestamptz, p_span_to timestamptz)
RETURNS timestamptz LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN bucket IS NULL THEN p_span_to
              ELSE (date_trunc(bucket, p_ts AT TIME ZONE 'UTC') + ('1 ' || bucket)::interval) AT TIME ZONE 'UTC' END
$$;

-- Block heights of [range_start, range_end), for the functions that read SubQuery entity tables (blocks.timestamp is
-- UTC without time zone; idx_blocks_timestamp_id serves both lookups). lo is NULL when no block is that late.
CREATE OR REPLACE FUNCTION ${s}._block_heights(range_start timestamptz, range_end timestamptz, OUT lo numeric, OUT hi numeric)
LANGUAGE plpgsql STABLE SET plan_cache_mode = force_custom_plan AS $$
BEGIN
  IF range_start IS NULL THEN lo := 0;
  ELSE
    SELECT bl.id INTO lo FROM ${s}.blocks bl WHERE bl.timestamp >= (range_start AT TIME ZONE 'UTC')
    ORDER BY bl.timestamp, bl.id LIMIT 1;
  END IF;
  IF range_end IS NULL THEN hi := 9223372036854775807;
  ELSE
    SELECT bl.id INTO hi FROM ${s}.blocks bl WHERE bl.timestamp < (range_end AT TIME ZONE 'UTC')
    ORDER BY bl.timestamp DESC, bl.id DESC LIMIT 1;
  END IF;
END $$;

-- Written settlement heights in [range_start, range_end), the settlement heights the chain has there (distinct
-- event_claim_settleds.block_id) that settlement_blocks lacks, and the settlement_gaps rows in the range
-- ('from-to'). The distinct block ids come from a loose index scan: one index probe per settlement height,
-- not one row per claim.
CREATE OR REPLACE FUNCTION ${s}.money_coverage(range_start timestamptz, range_end timestamptz)
RETURNS TABLE(first_height bigint, last_height bigint, first_block_time timestamptz, last_block_time timestamptz,
  settlements bigint, missing_heights bigint[], gaps text[])
LANGUAGE plpgsql STABLE SET plan_cache_mode = force_custom_plan AS $$
DECLARE rg record;
BEGIN
  PERFORM ${s}._validate(NULL, '', range_start, range_end, NULL);
  rg := ${s}._block_heights(range_start, range_end);
  RETURN QUERY
  WITH RECURSIVE h AS (
    (SELECT e.block_id FROM ${s}.event_claim_settleds e
     WHERE e.block_id >= rg.lo AND e.block_id <= rg.hi ORDER BY e.block_id LIMIT 1)
    UNION ALL
    SELECT (SELECT e.block_id FROM ${s}.event_claim_settleds e
            WHERE e.block_id > h.block_id AND e.block_id <= rg.hi ORDER BY e.block_id LIMIT 1)
    FROM h WHERE h.block_id IS NOT NULL
  )
  SELECT c.lo, c.hi, c.lo_ts, c.hi_ts, c.settlement_count,
         (SELECT coalesce(array_agg(h.block_id::bigint ORDER BY h.block_id), '{}') FROM h
          WHERE h.block_id IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM ${s}.settlement_blocks sb WHERE sb.height = h.block_id::bigint)),
         (SELECT coalesce(array_agg(gp.from_height || '-' || gp.to_height ORDER BY gp.from_height), '{}')
          FROM ${s}.settlement_gaps gp WHERE gp.from_height <= rg.hi AND gp.to_height >= rg.lo)
  FROM (SELECT min(sb.height) lo, max(sb.height) hi, min(sb.block_time) lo_ts, max(sb.block_time) hi_ts, count(*) settlement_count
        FROM ${s}.settlement_blocks sb
        WHERE (range_start IS NULL OR sb.block_time >= range_start) AND (range_end IS NULL OR sb.block_time < range_end)) c;
END $$;

-- Application: what it paid
CREATE OR REPLACE FUNCTION ${s}.get_application_spend(applications text[], range_start timestamptz, range_end timestamptz,
  bucket text DEFAULT NULL, by_service boolean DEFAULT false, by_supplier boolean DEFAULT false, by_application boolean DEFAULT true,
  fill_empty_buckets boolean DEFAULT false)
RETURNS TABLE(bucket_start timestamptz, bucket_end timestamptz, application_id text, service_id text, supplier_id text,
  burned_upokt numeric, overserviced_unpaid_upokt numeric, reimbursed_upokt numeric,
  relays numeric, estimated_relays numeric, compute_units numeric, estimated_compute_units numeric, claims bigint)
LANGUAGE plpgsql STABLE SET enable_mergejoin = off SET plan_cache_mode = force_custom_plan AS $$
DECLARE rg record; sp record;
BEGIN
  PERFORM ${s}._validate(applications, 'applications', range_start, range_end, bucket);
  sp := ${s}._span(range_start, range_end);
  rg := ${s}._ranges(range_start, range_end, bucket);
  RETURN QUERY
  WITH res0(bucket_start, bucket_end, application_id, service_id, supplier_id, burned_upokt, overserviced_unpaid_upokt, reimbursed_upokt, relays, estimated_relays, compute_units, estimated_compute_units, claims) AS (
  WITH r AS (
    SELECT d.day::timestamp AT TIME ZONE 'UTC' block_time, d.application_id, d.service_id, ''::text supplier_id, d.settled_upokt,
           d.overservicing_loss_upokt, d.global_minted_upokt, d.relays, d.estimated_relays, d.claimed_compute_units, d.estimated_compute_units,
           d.claim_count claims
    FROM ${s}.daily_claims_by_application_service d
    WHERE NOT by_supplier AND d.application_id = ANY(applications) AND d.day BETWEEN rg.d1 AND rg.d2
    UNION ALL
    SELECT d.day::timestamp AT TIME ZONE 'UTC', d.application_id, d.service_id, d.supplier_id, d.settled_upokt, d.overservicing_loss_upokt,
           d.global_minted_upokt, d.relays, d.estimated_relays, d.claimed_compute_units, d.estimated_compute_units, d.claim_count
    FROM ${s}.daily_claims_by_supplier_application_service d
    WHERE by_supplier AND d.application_id = ANY(applications) AND d.day BETWEEN rg.d1 AND rg.d2
    UNION ALL
    SELECT c.block_time, c.application_id, c.service_id, '', c.settled_upokt, c.overservicing_loss_upokt,
           c.global_minted_upokt, c.relays, c.estimated_relays, c.claimed_compute_units, c.estimated_compute_units, c.claim_count
    FROM ${s}.settlement_claims_by_application_service c
    WHERE NOT by_supplier AND c.application_id = ANY(applications) AND (c.height BETWEEN rg.lo1 AND rg.hi1 OR c.height BETWEEN rg.lo2 AND rg.hi2)
    UNION ALL
    SELECT c.block_time, c.application_id, c.service_id, c.supplier_id, c.settled_upokt, c.overservicing_loss_upokt,
           c.global_minted_upokt, c.relays, c.estimated_relays, c.claimed_compute_units, c.estimated_compute_units, 1::bigint
    FROM ${s}.claim_settlements c
    WHERE by_supplier AND c.application_id = ANY(applications) AND (c.height BETWEEN rg.lo1 AND rg.hi1 OR c.height BETWEEN rg.lo2 AND rg.hi2)
  )
  SELECT ${s}._bucket(bucket, r.block_time, sp.f), ${s}._bucket_end(bucket, r.block_time, sp.t), CASE WHEN by_application THEN r.application_id ELSE 'all' END,
         CASE WHEN by_service THEN r.service_id ELSE 'all' END, CASE WHEN by_supplier THEN r.supplier_id ELSE 'all' END,
         sum(r.settled_upokt)::numeric, sum(r.overservicing_loss_upokt)::numeric, sum(r.global_minted_upokt)::numeric,
         sum(r.relays)::numeric, sum(r.estimated_relays)::numeric, sum(r.claimed_compute_units)::numeric,
         sum(r.estimated_compute_units)::numeric, sum(r.claims)::bigint
  FROM r GROUP BY 1, 2, 3, 4, 5
  ), res(bucket_start, bucket_end, application_id, service_id, supplier_id, burned_upokt, overserviced_unpaid_upokt, reimbursed_upokt, relays, estimated_relays, compute_units, estimated_compute_units, claims) AS (
  -- every requested id gets its row or series, 0 where it had no activity (not in the sparse output)
  SELECT * FROM res0
  UNION ALL
  SELECT ${s}._bucket(bucket, sp.f, sp.f), ${s}._bucket_end(bucket, sp.f, sp.t), u.id, 'all', 'all', 0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::bigint
  FROM (SELECT DISTINCT unnest(applications) id) u
  WHERE u.id IS NOT NULL AND fill_empty_buckets AND by_application AND sp.f IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM res0 r0 WHERE r0.application_id = u.id)
  UNION ALL
  -- the group total of a list with no activity at all: one zero row
  SELECT ${s}._bucket(bucket, sp.f, sp.f), ${s}._bucket_end(bucket, sp.f, sp.t), 'all', 'all', 'all', 0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::bigint
  WHERE fill_empty_buckets AND NOT by_application AND sp.f IS NOT NULL AND cardinality(applications) > 0 AND NOT EXISTS (SELECT 1 FROM res0)
  )
  SELECT r.* FROM res r WHERE bucket IS NULL OR NOT fill_empty_buckets OR r.bucket_start <= sp.t_last
  UNION ALL
  SELECT b.bucket_start, b.bucket_end, k.application_id, k.service_id, k.supplier_id, CASE WHEN k.burned_upokt_na THEN NULL ELSE 0 END, CASE WHEN k.overserviced_unpaid_upokt_na THEN NULL ELSE 0 END, CASE WHEN k.reimbursed_upokt_na THEN NULL ELSE 0 END, CASE WHEN k.relays_na THEN NULL ELSE 0 END, CASE WHEN k.estimated_relays_na THEN NULL ELSE 0 END, CASE WHEN k.compute_units_na THEN NULL ELSE 0 END, CASE WHEN k.estimated_compute_units_na THEN NULL ELSE 0 END, CASE WHEN k.claims_na THEN NULL ELSE 0 END
  FROM ${s}._buckets(bucket, sp.f, sp.t_last) b
  CROSS JOIN (SELECT r.application_id, r.service_id, r.supplier_id, bool_and(r.burned_upokt IS NULL) burned_upokt_na, bool_and(r.overserviced_unpaid_upokt IS NULL) overserviced_unpaid_upokt_na, bool_and(r.reimbursed_upokt IS NULL) reimbursed_upokt_na, bool_and(r.relays IS NULL) relays_na, bool_and(r.estimated_relays IS NULL) estimated_relays_na, bool_and(r.compute_units IS NULL) compute_units_na, bool_and(r.estimated_compute_units IS NULL) estimated_compute_units_na, bool_and(r.claims IS NULL) claims_na FROM res r GROUP BY r.application_id, r.service_id, r.supplier_id) k
  WHERE bucket IS NOT NULL AND fill_empty_buckets
    AND NOT EXISTS (SELECT 1 FROM res r WHERE r.bucket_start = b.bucket_start AND coalesce(r.application_id, chr(1)) = coalesce(k.application_id, chr(1)) AND coalesce(r.service_id, chr(1)) = coalesce(k.service_id, chr(1)) AND coalesce(r.supplier_id, chr(1)) = coalesce(k.supplier_id, chr(1)))
  ORDER BY 1 DESC, 3, 4, 5;
END $$;

-- Gateway: what the applications delegated to it spent, by the delegation in force at each settlement
-- height. Delegations are the ApplicationGateway entity history: _block_range = [delegated, undelegated).
CREATE OR REPLACE FUNCTION ${s}.get_gateway_spend(gateways text[], range_start timestamptz, range_end timestamptz,
  bucket text DEFAULT NULL, by_application boolean DEFAULT false, by_service boolean DEFAULT false, by_gateway boolean DEFAULT true,
  fill_empty_buckets boolean DEFAULT false)
RETURNS TABLE(bucket_start timestamptz, bucket_end timestamptz, gateway_id text, application_id text, service_id text,
  burned_upokt numeric, overserviced_unpaid_upokt numeric, reimbursed_upokt numeric,
  relays numeric, estimated_relays numeric, compute_units numeric, estimated_compute_units numeric, claims bigint)
LANGUAGE plpgsql STABLE SET enable_mergejoin = off SET plan_cache_mode = force_custom_plan AS $$
DECLARE rg record; sp record;
BEGIN
  PERFORM ${s}._validate(gateways, 'gateways', range_start, range_end, bucket);
  sp := ${s}._span(range_start, range_end);
  rg := ${s}._ranges(range_start, range_end, bucket);
  RETURN QUERY
  WITH res0(bucket_start, bucket_end, gateway_id, application_id, service_id, burned_upokt, overserviced_unpaid_upokt, reimbursed_upokt, relays, estimated_relays, compute_units, estimated_compute_units, claims) AS (
  WITH days AS (
    SELECT sb.day, min(sb.height) lo, max(sb.height) hi FROM ${s}.settlement_blocks sb
    WHERE sb.day BETWEEN rg.d1 AND rg.d2 GROUP BY sb.day
  ), iv AS (
    SELECT ag.application_id, ag.gateway_id, lower(ag._block_range) from_height, upper(ag._block_range) to_height
    FROM ${s}.application_gateways ag WHERE ag.gateway_id = ANY(gateways)
  ), x AS (
    -- rollup days the delegation covers whole
    SELECT dc.day::timestamp AT TIME ZONE 'UTC' block_time, iv.gateway_id gw, dc.application_id, dc.service_id, dc.settled_upokt,
           dc.overservicing_loss_upokt, dc.global_minted_upokt, dc.relays, dc.estimated_relays, dc.claimed_compute_units,
           dc.estimated_compute_units, dc.claim_count claims
    FROM iv JOIN days d ON iv.from_height <= d.lo AND (iv.to_height IS NULL OR iv.to_height > d.hi)
    JOIN ${s}.daily_claims_by_application_service dc ON dc.application_id = iv.application_id AND dc.day = d.day
    UNION ALL
    -- rollup days it covers in part (usually none): the claims of those (application, day) pairs by index
    SELECT c.block_time, iv.gateway_id, c.application_id, c.service_id, c.settled_upokt, c.overservicing_loss_upokt, c.global_minted_upokt,
           c.relays, c.estimated_relays, c.claimed_compute_units, c.estimated_compute_units, c.claim_count
    FROM iv JOIN days d ON NOT (iv.from_height <= d.lo AND (iv.to_height IS NULL OR iv.to_height > d.hi))
                       AND iv.from_height <= d.hi AND (iv.to_height IS NULL OR iv.to_height > d.lo)
    CROSS JOIN LATERAL (
      SELECT * FROM ${s}.settlement_claims_by_application_service c
      WHERE c.application_id = iv.application_id
        AND c.height BETWEEN greatest(d.lo, iv.from_height) AND least(d.hi, coalesce(iv.to_height - 1, d.hi))
    ) c
    UNION ALL
    -- edges: base
    SELECT c.block_time, iv.gateway_id, c.application_id, c.service_id, c.settled_upokt, c.overservicing_loss_upokt, c.global_minted_upokt,
           c.relays, c.estimated_relays, c.claimed_compute_units, c.estimated_compute_units, c.claim_count
    FROM iv JOIN ${s}.settlement_claims_by_application_service c ON c.application_id = iv.application_id
         AND c.height >= iv.from_height AND (iv.to_height IS NULL OR c.height < iv.to_height)
    WHERE (c.height BETWEEN rg.lo1 AND rg.hi1 OR c.height BETWEEN rg.lo2 AND rg.hi2)
  )
  SELECT ${s}._bucket(bucket, x.block_time, sp.f), ${s}._bucket_end(bucket, x.block_time, sp.t), CASE WHEN by_gateway THEN x.gw ELSE 'all' END, CASE WHEN by_application THEN x.application_id ELSE 'all' END,
         CASE WHEN by_service THEN x.service_id ELSE 'all' END,
         sum(x.settled_upokt)::numeric, sum(x.overservicing_loss_upokt)::numeric, sum(x.global_minted_upokt)::numeric,
         sum(x.relays)::numeric, sum(x.estimated_relays)::numeric, sum(x.claimed_compute_units)::numeric,
         sum(x.estimated_compute_units)::numeric, sum(x.claims)::bigint
  FROM x GROUP BY 1, 2, 3, 4, 5
  ), res(bucket_start, bucket_end, gateway_id, application_id, service_id, burned_upokt, overserviced_unpaid_upokt, reimbursed_upokt, relays, estimated_relays, compute_units, estimated_compute_units, claims) AS (
  -- every requested id gets its row or series, 0 where it had no activity (not in the sparse output)
  SELECT * FROM res0
  UNION ALL
  SELECT ${s}._bucket(bucket, sp.f, sp.f), ${s}._bucket_end(bucket, sp.f, sp.t), u.id, 'all', 'all', 0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::bigint
  FROM (SELECT DISTINCT unnest(gateways) id) u
  WHERE u.id IS NOT NULL AND fill_empty_buckets AND by_gateway AND sp.f IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM res0 r0 WHERE r0.gateway_id = u.id)
  UNION ALL
  -- the group total of a list with no activity at all: one zero row
  SELECT ${s}._bucket(bucket, sp.f, sp.f), ${s}._bucket_end(bucket, sp.f, sp.t), 'all', 'all', 'all', 0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::bigint
  WHERE fill_empty_buckets AND NOT by_gateway AND sp.f IS NOT NULL AND cardinality(gateways) > 0 AND NOT EXISTS (SELECT 1 FROM res0)
  )
  SELECT r.* FROM res r WHERE bucket IS NULL OR NOT fill_empty_buckets OR r.bucket_start <= sp.t_last
  UNION ALL
  SELECT b.bucket_start, b.bucket_end, k.gateway_id, k.application_id, k.service_id, CASE WHEN k.burned_upokt_na THEN NULL ELSE 0 END, CASE WHEN k.overserviced_unpaid_upokt_na THEN NULL ELSE 0 END, CASE WHEN k.reimbursed_upokt_na THEN NULL ELSE 0 END, CASE WHEN k.relays_na THEN NULL ELSE 0 END, CASE WHEN k.estimated_relays_na THEN NULL ELSE 0 END, CASE WHEN k.compute_units_na THEN NULL ELSE 0 END, CASE WHEN k.estimated_compute_units_na THEN NULL ELSE 0 END, CASE WHEN k.claims_na THEN NULL ELSE 0 END
  FROM ${s}._buckets(bucket, sp.f, sp.t_last) b
  CROSS JOIN (SELECT r.gateway_id, r.application_id, r.service_id, bool_and(r.burned_upokt IS NULL) burned_upokt_na, bool_and(r.overserviced_unpaid_upokt IS NULL) overserviced_unpaid_upokt_na, bool_and(r.reimbursed_upokt IS NULL) reimbursed_upokt_na, bool_and(r.relays IS NULL) relays_na, bool_and(r.estimated_relays IS NULL) estimated_relays_na, bool_and(r.compute_units IS NULL) compute_units_na, bool_and(r.estimated_compute_units IS NULL) estimated_compute_units_na, bool_and(r.claims IS NULL) claims_na FROM res r GROUP BY r.gateway_id, r.application_id, r.service_id) k
  WHERE bucket IS NOT NULL AND fill_empty_buckets
    AND NOT EXISTS (SELECT 1 FROM res r WHERE r.bucket_start = b.bucket_start AND coalesce(r.gateway_id, chr(1)) = coalesce(k.gateway_id, chr(1)) AND coalesce(r.application_id, chr(1)) = coalesce(k.application_id, chr(1)) AND coalesce(r.service_id, chr(1)) = coalesce(k.service_id, chr(1)))
  ORDER BY 1 DESC, 3, 4, 5;
END $$;

-- Supplier: what it generated
CREATE OR REPLACE FUNCTION ${s}.get_supplier_earnings(suppliers text[], range_start timestamptz, range_end timestamptz,
  bucket text DEFAULT NULL, by_service boolean DEFAULT false, by_application boolean DEFAULT false, by_supplier boolean DEFAULT true,
  owners text[] DEFAULT NULL, fill_empty_buckets boolean DEFAULT false)
RETURNS TABLE(bucket_start timestamptz, bucket_end timestamptz, supplier_id text, service_id text, application_id text,
  claimed_upokt numeric, settled_upokt numeric, overservicing_loss_upokt numeric,
  relays numeric, estimated_relays numeric, compute_units numeric, estimated_compute_units numeric, settled_claims bigint,
  settled_claims_with_proof bigint, settled_claims_without_proof bigint)
LANGUAGE plpgsql STABLE SET enable_mergejoin = off SET plan_cache_mode = force_custom_plan AS $$
DECLARE rg record; sp record; all_suppliers boolean;
BEGIN
  IF suppliers IS NOT NULL AND owners IS NOT NULL THEN
    RAISE EXCEPTION 'pass suppliers or owners (the suppliers they own now), not both';
  END IF;
  IF owners IS NOT NULL THEN
    PERFORM ${s}._validate(owners, 'owners', range_start, range_end, bucket);
    -- no cap: an owner can have any number of suppliers
    suppliers := ARRAY(SELECT DISTINCT su.id FROM ${s}.suppliers su WHERE su.owner_id = ANY(owners) AND su._block_range @> 9223372036854775807::bigint);
  ELSE
    -- NULL suppliers (and no owners): every supplier
    PERFORM ${s}._validate(suppliers, CASE WHEN suppliers IS NULL THEN '' ELSE 'suppliers' END, range_start, range_end, bucket);
  END IF;
  all_suppliers := suppliers IS NULL;
  sp := ${s}._span(range_start, range_end);
  rg := ${s}._ranges(range_start, range_end, bucket);
  RETURN QUERY
  WITH res0(bucket_start, bucket_end, supplier_id, service_id, application_id, claimed_upokt, settled_upokt, overservicing_loss_upokt, relays, estimated_relays, compute_units, estimated_compute_units, settled_claims, settled_claims_with_proof, settled_claims_without_proof) AS (
  WITH r AS (
    -- without a breakdown the smaller daily_claims_by_supplier is enough (25x fewer rows over every supplier)
    SELECT d.day::timestamp AT TIME ZONE 'UTC' block_time, d.supplier_id, ''::text service_id, ''::text application_id, d.claimed_upokt,
           d.settled_upokt, d.overservicing_loss_upokt, d.relays, d.estimated_relays, d.claimed_compute_units, d.estimated_compute_units,
           d.claim_count claims, d.claims_with_proof with_proof
    FROM ${s}.daily_claims_by_supplier d
    WHERE NOT (by_service OR by_application) AND (all_suppliers OR d.supplier_id = ANY(suppliers)) AND d.day BETWEEN rg.d1 AND rg.d2
    UNION ALL
    SELECT d.day::timestamp AT TIME ZONE 'UTC', d.supplier_id, d.service_id, d.application_id, d.claimed_upokt, d.settled_upokt,
           d.overservicing_loss_upokt, d.relays, d.estimated_relays, d.claimed_compute_units, d.estimated_compute_units,
           d.claim_count, d.claims_with_proof
    FROM ${s}.daily_claims_by_supplier_application_service d
    WHERE (by_service OR by_application) AND (all_suppliers OR d.supplier_id = ANY(suppliers)) AND d.day BETWEEN rg.d1 AND rg.d2
    UNION ALL
    SELECT c.block_time, c.supplier_id, c.service_id, c.application_id, c.claimed_upokt, c.settled_upokt,
           c.overservicing_loss_upokt, c.relays, c.estimated_relays, c.claimed_compute_units, c.estimated_compute_units, 1::bigint,
           c.settled_with_proof::int::bigint
    FROM ${s}.claim_settlements c
    WHERE (all_suppliers OR c.supplier_id = ANY(suppliers)) AND (c.height BETWEEN rg.lo1 AND rg.hi1 OR c.height BETWEEN rg.lo2 AND rg.hi2)
  )
  SELECT ${s}._bucket(bucket, r.block_time, sp.f), ${s}._bucket_end(bucket, r.block_time, sp.t), CASE WHEN by_supplier THEN r.supplier_id ELSE 'all' END,
         CASE WHEN by_service THEN r.service_id ELSE 'all' END, CASE WHEN by_application THEN r.application_id ELSE 'all' END,
         sum(r.claimed_upokt)::numeric, sum(r.settled_upokt)::numeric, sum(r.overservicing_loss_upokt)::numeric,
         sum(r.relays)::numeric, sum(r.estimated_relays)::numeric, sum(r.claimed_compute_units)::numeric,
         sum(r.estimated_compute_units)::numeric, sum(r.claims)::bigint,
         sum(r.with_proof)::bigint, sum(r.claims - r.with_proof)::bigint
  FROM r GROUP BY 1, 2, 3, 4, 5
  ), res(bucket_start, bucket_end, supplier_id, service_id, application_id, claimed_upokt, settled_upokt, overservicing_loss_upokt, relays, estimated_relays, compute_units, estimated_compute_units, settled_claims, settled_claims_with_proof, settled_claims_without_proof) AS (
  -- every requested id gets its row or series, 0 where it had no activity (not in the sparse output)
  SELECT * FROM res0
  UNION ALL
  SELECT ${s}._bucket(bucket, sp.f, sp.f), ${s}._bucket_end(bucket, sp.f, sp.t), u.id, 'all', 'all', 0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::bigint, 0::bigint, 0::bigint
  FROM (SELECT DISTINCT unnest(suppliers) id) u
  WHERE u.id IS NOT NULL AND fill_empty_buckets AND by_supplier AND sp.f IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM res0 r0 WHERE r0.supplier_id = u.id)
  UNION ALL
  -- the group total of a list with no activity at all: one zero row
  SELECT ${s}._bucket(bucket, sp.f, sp.f), ${s}._bucket_end(bucket, sp.f, sp.t), 'all', 'all', 'all', 0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::bigint, 0::bigint, 0::bigint
  WHERE fill_empty_buckets AND NOT by_supplier AND sp.f IS NOT NULL AND (all_suppliers OR cardinality(suppliers) > 0) AND NOT EXISTS (SELECT 1 FROM res0)
  )
  SELECT r.* FROM res r WHERE bucket IS NULL OR NOT fill_empty_buckets OR r.bucket_start <= sp.t_last
  UNION ALL
  SELECT b.bucket_start, b.bucket_end, k.supplier_id, k.service_id, k.application_id, CASE WHEN k.claimed_upokt_na THEN NULL ELSE 0 END, CASE WHEN k.settled_upokt_na THEN NULL ELSE 0 END, CASE WHEN k.overservicing_loss_upokt_na THEN NULL ELSE 0 END, CASE WHEN k.relays_na THEN NULL ELSE 0 END, CASE WHEN k.estimated_relays_na THEN NULL ELSE 0 END, CASE WHEN k.compute_units_na THEN NULL ELSE 0 END, CASE WHEN k.estimated_compute_units_na THEN NULL ELSE 0 END, CASE WHEN k.settled_claims_na THEN NULL ELSE 0 END, CASE WHEN k.settled_claims_with_proof_na THEN NULL ELSE 0 END, CASE WHEN k.settled_claims_without_proof_na THEN NULL ELSE 0 END
  FROM ${s}._buckets(bucket, sp.f, sp.t_last) b
  CROSS JOIN (SELECT r.supplier_id, r.service_id, r.application_id, bool_and(r.claimed_upokt IS NULL) claimed_upokt_na, bool_and(r.settled_upokt IS NULL) settled_upokt_na, bool_and(r.overservicing_loss_upokt IS NULL) overservicing_loss_upokt_na, bool_and(r.relays IS NULL) relays_na, bool_and(r.estimated_relays IS NULL) estimated_relays_na, bool_and(r.compute_units IS NULL) compute_units_na, bool_and(r.estimated_compute_units IS NULL) estimated_compute_units_na, bool_and(r.settled_claims IS NULL) settled_claims_na, bool_and(r.settled_claims_with_proof IS NULL) settled_claims_with_proof_na, bool_and(r.settled_claims_without_proof IS NULL) settled_claims_without_proof_na FROM res r GROUP BY r.supplier_id, r.service_id, r.application_id) k
  WHERE bucket IS NOT NULL AND fill_empty_buckets
    AND NOT EXISTS (SELECT 1 FROM res r WHERE r.bucket_start = b.bucket_start AND coalesce(r.supplier_id, chr(1)) = coalesce(k.supplier_id, chr(1)) AND coalesce(r.service_id, chr(1)) = coalesce(k.service_id, chr(1)) AND coalesce(r.application_id, chr(1)) = coalesce(k.application_id, chr(1)))
  ORDER BY 1 DESC, 3, 4, 5;
END $$;

-- Supplier: how what it generated was distributed. Stakers come as ONE row per supplier with recipient 'all'
-- (the chain pays every validator and delegator once per settlement, not per claim); its transfer_count is
-- the claims that gave stakers a share. The other rows count payout legs: one per claim and family (relay,
-- global) that paid that recipient, so a claim with global mint counts twice unless by_reason splits it.
CREATE OR REPLACE FUNCTION ${s}.get_supplier_distribution(suppliers text[], range_start timestamptz, range_end timestamptz,
  bucket text DEFAULT NULL, by_reason boolean DEFAULT false, by_supplier boolean DEFAULT true,
  owners text[] DEFAULT NULL, fill_empty_buckets boolean DEFAULT false)
RETURNS TABLE(bucket_start timestamptz, bucket_end timestamptz, supplier_id text, recipient_id text, role text, family text,
  amount_upokt numeric, transfer_count bigint)
LANGUAGE plpgsql STABLE SET enable_mergejoin = off SET plan_cache_mode = force_custom_plan AS $$
DECLARE rg record; sp record;
BEGIN
  IF (suppliers IS NULL) = (owners IS NULL) THEN
    RAISE EXCEPTION 'pass suppliers or owners (the suppliers they own now)';
  END IF;
  IF owners IS NOT NULL THEN
    PERFORM ${s}._validate(owners, 'owners', range_start, range_end, bucket);
    -- no cap: an owner can have any number of suppliers
    suppliers := ARRAY(SELECT DISTINCT su.id FROM ${s}.suppliers su WHERE su.owner_id = ANY(owners) AND su._block_range @> 9223372036854775807::bigint);
  ELSE
    PERFORM ${s}._validate(suppliers, 'suppliers', range_start, range_end, bucket);
  END IF;
  sp := ${s}._span(range_start, range_end);
  rg := ${s}._ranges(range_start, range_end, bucket);
  RETURN QUERY
  WITH res0(bucket_start, bucket_end, supplier_id, recipient_id, role, family, amount_upokt, transfer_count) AS (
  WITH x AS (
    SELECT d.day::timestamp AT TIME ZONE 'UTC' block_time, d.supplier_id, CASE WHEN d.role = 'stakers' THEN 'all' ELSE d.address END address, d.role, d.family,
           d.amount_upokt, d.transfer_count
    FROM ${s}.daily_income_by_address_supplier d
    WHERE d.supplier_id = ANY(suppliers) AND d.day BETWEEN rg.d1 AND rg.d2
    UNION ALL
    SELECT sb.block_time, v.supplier_id, v.address, v.role, v.family, v.amount_upokt, v.transfer_count::bigint
    FROM ${s}.v_income_base v JOIN ${s}.settlement_blocks sb USING (height)
    WHERE v.supplier_id = ANY(suppliers) AND (v.height BETWEEN rg.lo1 AND rg.hi1 OR v.height BETWEEN rg.lo2 AND rg.hi2)
    UNION ALL
    SELECT c.block_time, c.supplier_id, 'all', 'stakers', 'relay', c.relay_to_stakers_upokt,
           (c.relay_to_stakers_upokt > 0)::int::bigint
    FROM ${s}.claim_settlements c
    WHERE c.supplier_id = ANY(suppliers) AND (c.height BETWEEN rg.lo1 AND rg.hi1 OR c.height BETWEEN rg.lo2 AND rg.hi2)
  )
  SELECT ${s}._bucket(bucket, x.block_time, sp.f), ${s}._bucket_end(bucket, x.block_time, sp.t), CASE WHEN by_supplier THEN x.supplier_id ELSE 'all' END, x.address, x.role, CASE WHEN by_reason THEN x.family ELSE 'all' END,
         sum(x.amount_upokt)::numeric, sum(x.transfer_count)::bigint
  FROM x GROUP BY 1, 2, 3, 4, 5, 6
  ), res(bucket_start, bucket_end, supplier_id, recipient_id, role, family, amount_upokt, transfer_count) AS (
  -- every requested id gets its row or series, 0 where it had no activity (not in the sparse output)
  SELECT * FROM res0
  UNION ALL
  SELECT ${s}._bucket(bucket, sp.f, sp.f), ${s}._bucket_end(bucket, sp.f, sp.t), u.id, 'all', 'all', 'all', 0::numeric, 0::bigint
  FROM (SELECT DISTINCT unnest(suppliers) id) u
  WHERE u.id IS NOT NULL AND fill_empty_buckets AND by_supplier AND sp.f IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM res0 r0 WHERE r0.supplier_id = u.id)
  UNION ALL
  -- the group total of a list with no activity at all: one zero row
  SELECT ${s}._bucket(bucket, sp.f, sp.f), ${s}._bucket_end(bucket, sp.f, sp.t), 'all', 'all', 'all', 'all', 0::numeric, 0::bigint
  WHERE fill_empty_buckets AND NOT by_supplier AND sp.f IS NOT NULL AND cardinality(suppliers) > 0 AND NOT EXISTS (SELECT 1 FROM res0)
  )
  SELECT r.* FROM res r WHERE bucket IS NULL OR NOT fill_empty_buckets OR r.bucket_start <= sp.t_last
  UNION ALL
  SELECT b.bucket_start, b.bucket_end, k.supplier_id, k.recipient_id, k.role, k.family, CASE WHEN k.amount_upokt_na THEN NULL ELSE 0 END, CASE WHEN k.transfer_count_na THEN NULL ELSE 0 END
  FROM ${s}._buckets(bucket, sp.f, sp.t_last) b
  CROSS JOIN (SELECT r.supplier_id, r.recipient_id, r.role, r.family, bool_and(r.amount_upokt IS NULL) amount_upokt_na, bool_and(r.transfer_count IS NULL) transfer_count_na FROM res r GROUP BY r.supplier_id, r.recipient_id, r.role, r.family) k
  WHERE bucket IS NOT NULL AND fill_empty_buckets
    AND NOT EXISTS (SELECT 1 FROM res r WHERE r.bucket_start = b.bucket_start AND coalesce(r.supplier_id, chr(1)) = coalesce(k.supplier_id, chr(1)) AND coalesce(r.recipient_id, chr(1)) = coalesce(k.recipient_id, chr(1)) AND coalesce(r.role, chr(1)) = coalesce(k.role, chr(1)) AND coalesce(r.family, chr(1)) = coalesce(k.family, chr(1)))
  ORDER BY 1 DESC, 3, 4, 5, 6;
END $$;

-- Income of any address. The rollup follows the breakdown: daily_income_by_address (none), daily_income_by_address_supplier /
-- monthly_income_by_address_supplier (by supplier), daily_income_by_address_service / monthly_income_by_address_service (by service).
-- Supplier AND service at once: whole months from monthly_income_by_address_supplier_service, everything else from the base.
-- suppliers (with by_supplier) keeps only the income those suppliers generated, read by index
-- instead of filtering the result (the legacy_* functions). Unordered: get_income orders.
CREATE OR REPLACE FUNCTION ${s}._income(addresses text[], range_start timestamptz, range_end timestamptz,
  bucket text DEFAULT NULL, by_reason boolean DEFAULT false, by_supplier boolean DEFAULT false,
  by_service boolean DEFAULT false, by_address boolean DEFAULT true,
  fill_empty_buckets boolean DEFAULT false, suppliers text[] DEFAULT NULL)
RETURNS TABLE(bucket_start timestamptz, bucket_end timestamptz, address text, role text, family text, supplier_id text, service_id text,
  amount_upokt numeric, transfer_count bigint)
LANGUAGE plpgsql STABLE SET enable_mergejoin = off SET plan_cache_mode = force_custom_plan AS $$
DECLARE rg record; sp record; m1 date; m2 date; use_month boolean; use_month_svc boolean;
  mw1 timestamptz; mw2 timestamptz; use_month_triple boolean; hm1 bigint; hm2 bigint;
BEGIN
  PERFORM ${s}._validate(addresses, '', range_start, range_end, bucket);
  sp := ${s}._span(range_start, range_end);
  rg := ${s}._ranges(range_start, range_end, bucket, by_supplier AND by_service);
  -- whole months inside the rollup days [d1, d2], only when the series needs no days
  m1 := CASE WHEN rg.d1 = date_trunc('month', rg.d1)::date THEN rg.d1 ELSE (date_trunc('month', rg.d1) + interval '1 month')::date END;
  m2 := (date_trunc('month', rg.d2 + 1) - interval '1 month')::date;  -- last month that ends <= d2
  use_month := by_supplier AND NOT by_service AND coalesce(bucket, 'month') IN ('month', 'year')
               AND rg.d1 <= rg.d2 AND m1 <= m2;
  use_month_svc := by_service AND NOT by_supplier AND coalesce(bucket, 'month') IN ('month', 'year')
                   AND rg.d1 <= rg.d2 AND m1 <= m2;
  -- supplier AND service: whole UTC months [mw1, mw2) of the range from monthly_income_by_address_supplier_service, the
  -- rest (and the staker rows, which have neither) from the base; an open end makes its edge month whole
  mw1 := CASE WHEN range_start IS NULL THEN '-infinity'
              WHEN range_start = date_trunc('month', range_start, 'UTC') THEN range_start
              ELSE date_trunc('month', range_start, 'UTC') + interval '1 month' END;
  mw2 := CASE WHEN range_end IS NULL THEN 'infinity' ELSE date_trunc('month', range_end, 'UTC') END;
  use_month_triple := by_supplier AND by_service AND coalesce(bucket, 'month') IN ('month', 'year') AND mw1 < mw2
                      AND coalesce(current_setting('money.no_rollup', true), 'off') <> 'on';
  IF use_month_triple THEN
    -- the base reads the heights before and after the whole months, and inside them only the staker rows
    SELECT coalesce(max(sb.height), -1) INTO hm1 FROM ${s}.settlement_blocks sb WHERE sb.block_time < mw1;
    SELECT coalesce(min(sb.height), 9223372036854775807) INTO hm2 FROM ${s}.settlement_blocks sb WHERE sb.block_time >= mw2;
    PERFORM ${s}._require_current_rollups(greatest((mw1 AT TIME ZONE 'UTC')::date, (SELECT min(day) FROM ${s}.settlement_blocks)),
                                          least((mw2 AT TIME ZONE 'UTC')::date - 1, (SELECT max(day) FROM ${s}.settlement_blocks)));
  END IF;
  RETURN QUERY
  WITH res0(bucket_start, bucket_end, address, role, family, supplier_id, service_id, amount_upokt, transfer_count) AS (
  WITH x AS (
    SELECT d.day::timestamp AT TIME ZONE 'UTC' block_time, d.address, d.role, d.family, ''::text sup, ''::text svc, d.amount_upokt,
           d.transfer_count
    FROM ${s}.daily_income_by_address d
    WHERE NOT by_supplier AND NOT by_service
      AND d.address = ANY(addresses) AND d.day BETWEEN rg.d1 AND rg.d2
    UNION ALL
    SELECT d.day::timestamp AT TIME ZONE 'UTC', d.address, d.role, d.family, d.supplier_id, '', d.amount_upokt, d.transfer_count
    FROM ${s}.daily_income_by_address_supplier d
    WHERE by_supplier AND NOT by_service AND d.role <> 'stakers'
      AND d.address = ANY(addresses) AND d.day BETWEEN rg.d1 AND rg.d2
      AND (suppliers IS NULL OR nullif(d.supplier_id, '') = ANY(suppliers))
      AND NOT (use_month AND d.day BETWEEN m1 AND (m2 + interval '1 month' - interval '1 day')::date)
    UNION ALL
    SELECT d.month::timestamp AT TIME ZONE 'UTC', d.address, d.role, d.family, d.supplier_id, '', d.amount_upokt, d.transfer_count
    FROM ${s}.monthly_income_by_address_supplier d
    WHERE use_month AND d.role <> 'stakers' AND d.address = ANY(addresses) AND d.month BETWEEN m1 AND m2
      AND (suppliers IS NULL OR nullif(d.supplier_id, '') = ANY(suppliers))
    UNION ALL
    SELECT d.day::timestamp AT TIME ZONE 'UTC', d.address, d.role, d.family, '', d.service_id, d.amount_upokt, d.transfer_count
    FROM ${s}.daily_income_by_address_service d
    WHERE by_service AND NOT by_supplier
      AND d.address = ANY(addresses) AND d.day BETWEEN rg.d1 AND rg.d2
      AND NOT (use_month_svc AND d.day BETWEEN m1 AND (m2 + interval '1 month' - interval '1 day')::date)
    UNION ALL
    SELECT d.month::timestamp AT TIME ZONE 'UTC', d.address, d.role, d.family, '', d.service_id, d.amount_upokt, d.transfer_count
    FROM ${s}.monthly_income_by_address_service d
    WHERE use_month_svc AND d.address = ANY(addresses) AND d.month BETWEEN m1 AND m2
    UNION ALL
    -- with a supplier or service breakdown, staker income (no supplier, no service) comes from the address rollup
    SELECT d.day::timestamp AT TIME ZONE 'UTC', d.address, d.role, d.family, '', '', d.amount_upokt, d.transfer_count
    FROM ${s}.daily_income_by_address d
    WHERE (by_supplier OR by_service) AND d.role IN ('validator', 'delegator') AND suppliers IS NULL
      AND d.address = ANY(addresses) AND d.day BETWEEN rg.d1 AND rg.d2
    UNION ALL
    SELECT sb.block_time, v.address, v.role, v.family, v.supplier_id, v.service_id, v.amount_upokt, v.transfer_count::bigint
    FROM ${s}.v_income_base v JOIN ${s}.settlement_blocks sb USING (height)
    WHERE (by_supplier OR by_service) AND (suppliers IS NULL OR nullif(v.supplier_id, '') = ANY(suppliers))
      AND v.address = ANY(addresses) AND (v.height BETWEEN rg.lo1 AND rg.hi1 OR v.height BETWEEN rg.lo2 AND rg.hi2)
      AND (NOT use_month_triple OR v.height <= hm1 OR v.height >= hm2)
    UNION ALL
    -- staker rows (no supplier, no service) inside the whole months: v_income_base's staker_payouts branch
    SELECT sb.block_time, p.recipient_id, p.role, p.family, '', '', p.amount_upokt, 1::bigint
    FROM ${s}.staker_payouts p JOIN ${s}.settlement_blocks sb USING (height)
    WHERE use_month_triple AND suppliers IS NULL AND p.recipient_id = ANY(addresses) AND p.height > hm1 AND p.height < hm2
    UNION ALL
    SELECT d.month::timestamp AT TIME ZONE 'UTC', d.address, d.role, d.family, d.supplier_id, d.service_id, d.amount_upokt, d.transfer_count
    FROM ${s}.monthly_income_by_address_supplier_service d
    WHERE use_month_triple AND d.address = ANY(addresses)
      AND (suppliers IS NULL OR d.supplier_id = ANY(suppliers))
      AND d.month >= (mw1 AT TIME ZONE 'UTC')::date AND (d.month::timestamp AT TIME ZONE 'UTC') < mw2
    UNION ALL
    SELECT sb.block_time, a.address, a.role, a.family, '', '', a.amount_upokt, a.transfer_count
    FROM ${s}.settlement_income_by_address a JOIN ${s}.settlement_blocks sb USING (height)
    WHERE NOT by_supplier AND NOT by_service
      AND a.address = ANY(addresses) AND (a.height BETWEEN rg.lo1 AND rg.hi1 OR a.height BETWEEN rg.lo2 AND rg.hi2)
  )
  SELECT ${s}._bucket(bucket, x.block_time, sp.f), ${s}._bucket_end(bucket, x.block_time, sp.t), CASE WHEN by_address THEN x.address ELSE 'all' END, x.role, CASE WHEN by_reason THEN x.family ELSE 'all' END,
         CASE WHEN by_supplier THEN nullif(x.sup, '') ELSE 'all' END, CASE WHEN by_service THEN nullif(x.svc, '') ELSE 'all' END,
         sum(x.amount_upokt)::numeric, sum(x.transfer_count)::bigint
  FROM x GROUP BY 1, 2, 3, 4, 5, 6, 7
  ), res(bucket_start, bucket_end, address, role, family, supplier_id, service_id, amount_upokt, transfer_count) AS (
  -- every requested id gets its row or series, 0 where it had no activity (not in the sparse output)
  SELECT * FROM res0
  UNION ALL
  SELECT ${s}._bucket(bucket, sp.f, sp.f), ${s}._bucket_end(bucket, sp.f, sp.t), u.id, 'all', 'all', 'all', 'all', 0::numeric, 0::bigint
  FROM (SELECT DISTINCT unnest(addresses) id) u
  WHERE u.id IS NOT NULL AND fill_empty_buckets AND by_address AND sp.f IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM res0 r0 WHERE r0.address = u.id)
  UNION ALL
  -- the group total of a list with no activity at all: one zero row
  SELECT ${s}._bucket(bucket, sp.f, sp.f), ${s}._bucket_end(bucket, sp.f, sp.t), 'all', 'all', 'all', 'all', 'all', 0::numeric, 0::bigint
  WHERE fill_empty_buckets AND NOT by_address AND sp.f IS NOT NULL AND cardinality(addresses) > 0 AND NOT EXISTS (SELECT 1 FROM res0)
  )
  SELECT r.* FROM res r WHERE bucket IS NULL OR NOT fill_empty_buckets OR r.bucket_start <= sp.t_last
  UNION ALL
  SELECT b.bucket_start, b.bucket_end, k.address, k.role, k.family, k.supplier_id, k.service_id, CASE WHEN k.amount_upokt_na THEN NULL ELSE 0 END, CASE WHEN k.transfer_count_na THEN NULL ELSE 0 END
  FROM ${s}._buckets(bucket, sp.f, sp.t_last) b
  CROSS JOIN (SELECT r.address, r.role, r.family, r.supplier_id, r.service_id, bool_and(r.amount_upokt IS NULL) amount_upokt_na, bool_and(r.transfer_count IS NULL) transfer_count_na FROM res r GROUP BY r.address, r.role, r.family, r.supplier_id, r.service_id) k
  WHERE bucket IS NOT NULL AND fill_empty_buckets
    AND NOT EXISTS (SELECT 1 FROM res r WHERE r.bucket_start = b.bucket_start AND coalesce(r.address, chr(1)) = coalesce(k.address, chr(1)) AND coalesce(r.role, chr(1)) = coalesce(k.role, chr(1)) AND coalesce(r.family, chr(1)) = coalesce(k.family, chr(1)) AND coalesce(r.supplier_id, chr(1)) = coalesce(k.supplier_id, chr(1)) AND coalesce(r.service_id, chr(1)) = coalesce(k.service_id, chr(1)));
END $$;

-- The API entry point: at most 200 addresses per call. The legacy_* functions call _income directly,
-- because the live functions they replace take any number of addresses (an owner with thousands of rev-share
-- accounts).
CREATE OR REPLACE FUNCTION ${s}.get_income(addresses text[], range_start timestamptz, range_end timestamptz,
  bucket text DEFAULT NULL, by_reason boolean DEFAULT false, by_supplier boolean DEFAULT false,
  by_service boolean DEFAULT false, by_address boolean DEFAULT true, fill_empty_buckets boolean DEFAULT false)
RETURNS TABLE(bucket_start timestamptz, bucket_end timestamptz, address text, role text, family text, supplier_id text, service_id text,
  amount_upokt numeric, transfer_count bigint)
LANGUAGE plpgsql STABLE SET plan_cache_mode = force_custom_plan AS $$
BEGIN
  PERFORM ${s}._validate(addresses, 'addresses', range_start, range_end, bucket);
  RETURN QUERY SELECT * FROM ${s}._income(addresses, range_start, range_end, bucket, by_reason, by_supplier, by_service,
                                           by_address, fill_empty_buckets) i ORDER BY 1 DESC, 3, 4, 5, 6, 7;
END $$;

-- Validator: commission, self-delegation and what it passed to its delegators, both families, from
-- validator_distributions (one row per validator and settlement), which also gives the delegated stake each settlement
-- saw: its average, minimum and maximum over the bucket (for an APR). From 288,180 to the batched_vrd era the rows are
-- replayed from the delegations snapshot (row_source replay / derived_split), with no commission: commission_upokt is
-- the sum of the commissions known, NULL when none is (never 0 for an unknown), and commission_unknown_count counts the
-- distributions without one; replayed_count counts the replayed rows. Before 288,180 there are no rows.
CREATE OR REPLACE FUNCTION ${s}.get_validator_rewards(validators text[], range_start timestamptz, range_end timestamptz,
  bucket text DEFAULT NULL, by_validator boolean DEFAULT true,
  fill_empty_buckets boolean DEFAULT false)
RETURNS TABLE(bucket_start timestamptz, bucket_end timestamptz, validator_operator text, commission_upokt numeric,
  commission_unknown_count bigint, self_delegation_upokt numeric, delegators_upokt numeric, total_upokt numeric,
  distributions bigint, replayed_count bigint, delegated_stake_avg_upokt numeric, delegated_stake_min_upokt numeric,
  delegated_stake_max_upokt numeric)
LANGUAGE plpgsql STABLE SET enable_mergejoin = off SET plan_cache_mode = force_custom_plan AS $$
DECLARE sp record; lo bigint; hi bigint; all_validators boolean := validators IS NULL;
BEGIN
  -- NULL validators: every validator
  PERFORM ${s}._validate(validators, CASE WHEN validators IS NULL THEN '' ELSE 'validators' END, range_start, range_end, bucket);
  PERFORM ${s}._check_coverage(range_start, range_end);
  sp := ${s}._span(range_start, range_end);
  SELECT min(sb.height), max(sb.height) INTO lo, hi FROM ${s}.settlement_blocks sb
  WHERE (range_start IS NULL OR sb.block_time >= range_start) AND (range_end IS NULL OR sb.block_time < range_end);
  RETURN QUERY
  WITH res(bucket_start, bucket_end, validator_operator, commission_upokt, commission_unknown_count, self_delegation_upokt,
           delegators_upokt, total_upokt, distributions, replayed_count, delegated_stake_avg_upokt, delegated_stake_min_upokt,
           delegated_stake_max_upokt) AS (
    SELECT ${s}._bucket(bucket, sb.block_time, sp.f), ${s}._bucket_end(bucket, sb.block_time, sp.t),
           CASE WHEN by_validator THEN v.validator_operator ELSE 'all' END,
           sum(v.commission_upokt)::numeric, count(*) FILTER (WHERE v.commission_upokt IS NULL),
           sum(v.self_delegation_upokt)::numeric, sum(v.to_delegators_upokt)::numeric, sum(v.pool_share_upokt)::numeric,
           count(*), count(*) FILTER (WHERE v.row_source IN ('replay', 'derived_split')),
           -- the stake of one validator: a group total (by_validator false) mixes validators, so it has none
           CASE WHEN by_validator THEN avg(v.total_delegated_stake_upokt) END,
           CASE WHEN by_validator THEN min(v.total_delegated_stake_upokt)::numeric END,
           CASE WHEN by_validator THEN max(v.total_delegated_stake_upokt)::numeric END
    FROM ${s}.validator_distributions v JOIN ${s}.settlement_blocks sb USING (height)
    WHERE (all_validators OR v.validator_operator = ANY(validators)) AND v.height BETWEEN lo AND hi
    GROUP BY 1, 2, 3
    UNION ALL
    -- every requested id gets its row or series, 0 where it had no distribution (not in the sparse output)
    SELECT ${s}._bucket(bucket, sp.f, sp.f), ${s}._bucket_end(bucket, sp.f, sp.t), u.id, 0::numeric, 0::bigint, 0::numeric,
           0::numeric, 0::numeric, 0::bigint, 0::bigint, NULL::numeric, NULL::numeric, NULL::numeric
    FROM (SELECT DISTINCT unnest(validators) id) u
    WHERE u.id IS NOT NULL AND fill_empty_buckets AND by_validator AND sp.f IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM ${s}.validator_distributions v WHERE v.validator_operator = u.id AND v.height BETWEEN lo AND hi)
    UNION ALL
    -- the group total of a list with no distribution at all: one zero row
    SELECT ${s}._bucket(bucket, sp.f, sp.f), ${s}._bucket_end(bucket, sp.f, sp.t), 'all', 0::numeric, 0::bigint, 0::numeric,
           0::numeric, 0::numeric, 0::bigint, 0::bigint, NULL::numeric, NULL::numeric, NULL::numeric
    WHERE fill_empty_buckets AND NOT by_validator AND sp.f IS NOT NULL AND (all_validators OR cardinality(validators) > 0)
      AND NOT EXISTS (SELECT 1 FROM ${s}.validator_distributions v
                      WHERE (all_validators OR v.validator_operator = ANY(validators)) AND v.height BETWEEN lo AND hi)
  )
  SELECT r.* FROM res r WHERE bucket IS NULL OR NOT fill_empty_buckets OR r.bucket_start <= sp.t_last
  UNION ALL
  -- an empty cell: nothing was distributed, so 0, and no stake was seen (NULL)
  SELECT b.bucket_start, b.bucket_end, k.validator_operator, 0::numeric, 0::bigint, 0::numeric, 0::numeric, 0::numeric,
         0::bigint, 0::bigint, NULL::numeric, NULL::numeric, NULL::numeric
  FROM ${s}._buckets(bucket, sp.f, sp.t_last) b
  CROSS JOIN (SELECT DISTINCT r.validator_operator FROM res r) k
  WHERE bucket IS NOT NULL AND fill_empty_buckets
    AND NOT EXISTS (SELECT 1 FROM res r WHERE r.bucket_start = b.bucket_start AND r.validator_operator = k.validator_operator)
  ORDER BY 1 DESC, 3;
END $$;

-- Delegator: what it received for its delegations, per validator or in total. Both come from
-- delegator_validator_payouts, which the chain does not emit: derived at each settlement height from the
-- delegations (two-level largest remainder) and checked against the totals the chain emits, so the total is the
-- sum of the per-validator rows. For a validator's own account this includes the reward of its self-delegation
-- (also in get_validator_rewards.self_delegation_upokt) and of its delegations to other validators: the chain
-- pays that account as role 'validator' in get_income, so do not add the two.
-- validator_operator '' is not a validator: the family of a replayed height (288,180–788,944) whose replay did not
-- reproduce the chain's amounts is written unattributed (src/mappings/money/replay.ts), and the row holds the exact
-- amount the chain paid the delegator.
CREATE OR REPLACE FUNCTION ${s}.get_delegator_income(delegators text[], range_start timestamptz, range_end timestamptz,
  bucket text DEFAULT NULL, by_validator boolean DEFAULT false, by_delegator boolean DEFAULT true,
  fill_empty_buckets boolean DEFAULT false, validators text[] DEFAULT NULL)
RETURNS TABLE(bucket_start timestamptz, bucket_end timestamptz, delegator text, validator_operator text, amount_upokt numeric,
  replayed_count bigint)
LANGUAGE plpgsql STABLE SET enable_mergejoin = off SET plan_cache_mode = force_custom_plan AS $$
DECLARE rg record; sp record; all_delegators boolean := delegators IS NULL;
BEGIN
  -- NULL delegators: every delegator; validators keeps the income from those validators (their delegators)
  PERFORM ${s}._validate(delegators, CASE WHEN delegators IS NULL THEN '' ELSE 'delegators' END, range_start, range_end, bucket);
  IF validators IS NOT NULL THEN PERFORM ${s}._validate(validators, 'validators', NULL, NULL, NULL); END IF;
  sp := ${s}._span(range_start, range_end);
  rg := ${s}._ranges(range_start, range_end, bucket);
  RETURN QUERY
  WITH res0(bucket_start, bucket_end, delegator, validator_operator, amount_upokt, replayed_count) AS (
    WITH x AS (
      SELECT d.day::timestamp AT TIME ZONE 'UTC' block_time, d.delegator, d.validator_operator, d.amount_upokt, d.replayed_count replayed
      FROM ${s}.daily_delegator_rewards_by_validator d
      WHERE (all_delegators OR d.delegator = ANY(delegators)) AND (validators IS NULL OR d.validator_operator = ANY(validators))
        AND d.day BETWEEN rg.d1 AND rg.d2
      UNION ALL
      SELECT sb.block_time, p.delegator, p.validator_operator, p.amount_upokt,
             (p.row_source IN ('replay', 'derived_split'))::int::bigint
      FROM ${s}.delegator_validator_payouts p JOIN ${s}.settlement_blocks sb USING (height)
      WHERE (all_delegators OR p.delegator = ANY(delegators)) AND (validators IS NULL OR p.validator_operator = ANY(validators))
        AND (p.height BETWEEN rg.lo1 AND rg.hi1 OR p.height BETWEEN rg.lo2 AND rg.hi2)
    )
    SELECT ${s}._bucket(bucket, x.block_time, sp.f), ${s}._bucket_end(bucket, x.block_time, sp.t), CASE WHEN by_delegator THEN x.delegator ELSE 'all' END,
           CASE WHEN by_validator THEN x.validator_operator ELSE 'all' END, sum(x.amount_upokt)::numeric,
           sum(x.replayed)::bigint
    FROM x GROUP BY 1, 2, 3, 4
  ), res(bucket_start, bucket_end, delegator, validator_operator, amount_upokt, replayed_count) AS (
  -- every requested id gets its row or series, 0 where it had no activity (not in the sparse output)
  SELECT * FROM res0
  UNION ALL
  SELECT ${s}._bucket(bucket, sp.f, sp.f), ${s}._bucket_end(bucket, sp.f, sp.t), u.id, 'all', 0::numeric, 0::bigint
  FROM (SELECT DISTINCT unnest(delegators) id) u
  WHERE u.id IS NOT NULL AND fill_empty_buckets AND by_delegator AND sp.f IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM res0 r0 WHERE r0.delegator = u.id)
  UNION ALL
  -- the group total of a list with no activity at all: one zero row
  SELECT ${s}._bucket(bucket, sp.f, sp.f), ${s}._bucket_end(bucket, sp.f, sp.t), 'all', 'all', 0::numeric, 0::bigint
  WHERE fill_empty_buckets AND NOT by_delegator AND sp.f IS NOT NULL AND (all_delegators OR cardinality(delegators) > 0) AND NOT EXISTS (SELECT 1 FROM res0)
  )
  SELECT r.* FROM res r WHERE bucket IS NULL OR NOT fill_empty_buckets OR r.bucket_start <= sp.t_last
  UNION ALL
  SELECT b.bucket_start, b.bucket_end, k.delegator, k.validator_operator, CASE WHEN k.amount_upokt_na THEN NULL ELSE 0 END, 0::bigint
  FROM ${s}._buckets(bucket, sp.f, sp.t_last) b
  CROSS JOIN (SELECT r.delegator, r.validator_operator, bool_and(r.amount_upokt IS NULL) amount_upokt_na FROM res r GROUP BY r.delegator, r.validator_operator) k
  WHERE bucket IS NOT NULL AND fill_empty_buckets
    AND NOT EXISTS (SELECT 1 FROM res r WHERE r.bucket_start = b.bucket_start AND coalesce(r.delegator, chr(1)) = coalesce(k.delegator, chr(1)) AND coalesce(r.validator_operator, chr(1)) = coalesce(k.validator_operator, chr(1)))
  ORDER BY 1 DESC, 3, 4;
END $$;

-- Supply: burn, the relay mint (= burn × mint_ratio) and the global mint, each by receiving role. The
-- global mint's staker share is not on the claims: it is the 'global' family of the validator distributions, which
-- batched_vrd emits and the replay (288,180–788,944) writes from the same staker legs that are in staker_payouts.
-- So staker_payouts counts only at a height with no global validator distribution: the settlement_result era (paid
-- to the block proposer as a leg of each claim), the map eras before the replay, and a replayed height whose global
-- family was written unattributed (no validator rows). Those rows are read from the base table (a few per height).
-- The global staker share is 0 from 263,093 on mainnet (mint_allocation_percentages proposer; only
-- map_proposer_consensus pays one, measured in the params), and the parser stops a detailed_batch height that has one.
-- Known overstatement (follow-up): the claims that paid one shareholder address twice (mainnet 690,685–716,533, writer.ts)
-- carry the overpayment in relay_to_supplier_upokt and global_to_supplier_upokt, so the supplier role of mint_equals_burn
-- and global_mint includes it although it left the supplier module, not the mint: about 39 POKT of relay, a few upokt
-- of global. Taking it out needs the overpayment per claim in the base table and its rollup.
CREATE OR REPLACE FUNCTION ${s}.get_supply_flows(range_start timestamptz, range_end timestamptz, bucket text DEFAULT NULL,
  by_role boolean DEFAULT false, fill_empty_buckets boolean DEFAULT false)
RETURNS TABLE(bucket_start timestamptz, bucket_end timestamptz, flow text, role text, amount_upokt numeric)
LANGUAGE plpgsql STABLE SET enable_mergejoin = off SET plan_cache_mode = force_custom_plan AS $$
DECLARE rg record; sp record;
BEGIN
  PERFORM ${s}._validate(NULL, '', range_start, range_end, bucket);
  sp := ${s}._span(range_start, range_end);
  rg := ${s}._ranges(range_start, range_end, bucket);
  RETURN QUERY
  WITH res(bucket_start, bucket_end, flow, role, amount_upokt) AS (
  WITH c AS (
    SELECT d.day::timestamp AT TIME ZONE 'UTC' block_time, d.settled_upokt, d.relay_minted_upokt, d.mint_ratio_unminted_upokt, d.overservicing_loss_upokt,
           d.relay_to_supplier_upokt, d.relay_to_dao_upokt, d.relay_to_source_owner_upokt, d.relay_to_application_upokt, d.relay_to_stakers_upokt, d.global_to_supplier_upokt, d.global_to_dao_upokt, d.global_to_source_owner_upokt,
           d.global_to_application_upokt, d.reimbursement_to_dao_upokt
    FROM ${s}.daily_claims_by_application_service d WHERE d.day BETWEEN rg.d1 AND rg.d2
    UNION ALL
    SELECT sb.block_time, c.settled_upokt, c.relay_minted_upokt, c.mint_ratio_unminted_upokt, c.overservicing_loss_upokt,
           c.relay_to_supplier_upokt, c.relay_to_dao_upokt, c.relay_to_source_owner_upokt, c.relay_to_application_upokt, c.relay_to_stakers_upokt, c.global_to_supplier_upokt, c.global_to_dao_upokt, c.global_to_source_owner_upokt,
           c.global_to_application_upokt, c.reimbursement_to_dao_upokt
    FROM ${s}.settlement_supply_flows c JOIN ${s}.settlement_blocks sb USING (height)
    WHERE (c.height BETWEEN rg.lo1 AND rg.hi1 OR c.height BETWEEN rg.lo2 AND rg.hi2)
  ), f AS (
    SELECT c.block_time, x.flow, x.role, x.amount_upokt FROM c CROSS JOIN LATERAL (VALUES
      ('burn', 'application', c.settled_upokt),
      ('mint_equals_burn', 'supplier', c.relay_to_supplier_upokt), ('mint_equals_burn', 'dao', c.relay_to_dao_upokt),
      ('mint_equals_burn', 'source_owner', c.relay_to_source_owner_upokt), ('mint_equals_burn', 'application', c.relay_to_application_upokt),
      ('mint_equals_burn', 'stakers', c.relay_to_stakers_upokt),
      ('mint_ratio_unminted', 'network', c.mint_ratio_unminted_upokt), ('overservicing_loss', 'application', c.overservicing_loss_upokt),
      ('global_mint', 'supplier', c.global_to_supplier_upokt), ('global_mint', 'dao', c.global_to_dao_upokt),
      ('global_mint', 'source_owner', c.global_to_source_owner_upokt), ('global_mint', 'application', c.global_to_application_upokt),
      ('reimbursement', 'dao', c.reimbursement_to_dao_upokt)) x(flow, role, amount_upokt)
    UNION ALL
    SELECT d.day::timestamp AT TIME ZONE 'UTC', 'global_mint', 'stakers', d.pool_share_upokt
    FROM ${s}.daily_validator_rewards d WHERE d.family = 'global' AND d.day BETWEEN rg.d1 AND rg.d2
    UNION ALL
    SELECT sb.block_time, 'global_mint', 'stakers', v.pool_share_upokt
    FROM ${s}.validator_distributions v JOIN ${s}.settlement_blocks sb USING (height)
    WHERE v.family = 'global' AND (v.height BETWEEN rg.lo1 AND rg.hi1 OR v.height BETWEEN rg.lo2 AND rg.hi2)
    UNION ALL
    SELECT sb.block_time, 'global_mint', 'stakers', stk.amount_upokt
    FROM ${s}.settlement_blocks sb JOIN ${s}.staker_payouts stk ON stk.height = sb.height
    WHERE sb.era <> 'batched_vrd' AND stk.family = 'global'
      AND NOT EXISTS (SELECT 1 FROM ${s}.validator_distributions v WHERE v.height = sb.height AND v.family = 'global')
      AND (range_start IS NULL OR sb.block_time >= range_start) AND (range_end IS NULL OR sb.block_time < range_end)
    UNION ALL
    SELECT sb.block_time, 'slash', 'supplier', s.penalty_upokt
    FROM ${s}.supplier_slashes s JOIN ${s}.settlement_blocks sb USING (height)
    WHERE (range_start IS NULL OR sb.block_time >= range_start) AND (range_end IS NULL OR sb.block_time < range_end)
  )
  SELECT ${s}._bucket(bucket, f.block_time, sp.f), ${s}._bucket_end(bucket, f.block_time, sp.t), f.flow, CASE WHEN by_role THEN f.role ELSE 'all' END, sum(f.amount_upokt)::numeric
  FROM f GROUP BY 1, 2, 3, 4
  )
  SELECT r.* FROM res r WHERE bucket IS NULL OR NOT fill_empty_buckets OR r.bucket_start <= sp.t_last
  UNION ALL
  SELECT b.bucket_start, b.bucket_end, k.flow, k.role, CASE WHEN k.amount_upokt_na THEN NULL ELSE 0 END
  FROM ${s}._buckets(bucket, sp.f, sp.t_last) b
  CROSS JOIN (SELECT r.flow, r.role, bool_and(r.amount_upokt IS NULL) amount_upokt_na FROM res r GROUP BY r.flow, r.role) k
  WHERE bucket IS NOT NULL AND fill_empty_buckets
    AND NOT EXISTS (SELECT 1 FROM res r WHERE r.bucket_start = b.bucket_start AND coalesce(r.flow, chr(1)) = coalesce(k.flow, chr(1)) AND coalesce(r.role, chr(1)) = coalesce(k.role, chr(1)))
  ORDER BY 1 DESC, 3, 4;
END $$;

-- Supplier penalties: expired and discarded claims, and slashes. Base only: they are rare. A discarded
-- claim has no amount_upokt or relay counts on chain: NULL, not 0.
CREATE OR REPLACE FUNCTION ${s}.get_supplier_penalties(suppliers text[], range_start timestamptz, range_end timestamptz,
  bucket text DEFAULT NULL, by_service boolean DEFAULT false, by_supplier boolean DEFAULT true,
  owners text[] DEFAULT NULL, fill_empty_buckets boolean DEFAULT false)
RETURNS TABLE(bucket_start timestamptz, bucket_end timestamptz, supplier_id text, service_id text, kind text, reason text, events bigint, claimed_upokt numeric,
  slashed_upokt numeric, relays numeric, estimated_relays numeric, compute_units numeric, estimated_compute_units numeric)
LANGUAGE plpgsql STABLE SET enable_mergejoin = off SET plan_cache_mode = force_custom_plan AS $$
DECLARE rg record; sp record;
BEGIN
  IF (suppliers IS NULL) = (owners IS NULL) THEN
    RAISE EXCEPTION 'pass suppliers or owners (the suppliers they own now)';
  END IF;
  IF owners IS NOT NULL THEN
    PERFORM ${s}._validate(owners, 'owners', range_start, range_end, bucket);
    -- no cap: an owner can have any number of suppliers
    suppliers := ARRAY(SELECT DISTINCT su.id FROM ${s}.suppliers su WHERE su.owner_id = ANY(owners) AND su._block_range @> 9223372036854775807::bigint);
  ELSE
    PERFORM ${s}._validate(suppliers, 'suppliers', range_start, range_end, bucket);
  END IF;
  sp := ${s}._span(range_start, range_end);
  rg := ${s}._ranges(range_start, range_end, bucket, true);
  RETURN QUERY
  WITH res0(bucket_start, bucket_end, supplier_id, service_id, kind, reason, events, claimed_upokt, slashed_upokt, relays, estimated_relays, compute_units, estimated_compute_units) AS (
  WITH x AS (
    SELECT e.height, e.supplier_id, e.service_id, 'expired'::text kind, e.reason, e.claimed_upokt, NULL::bigint slashed,
           e.relays, e.estimated_relays, e.claimed_compute_units, e.estimated_compute_units
    FROM ${s}.claim_expirations e WHERE e.supplier_id = ANY(suppliers) AND e.height BETWEEN rg.lo1 AND rg.hi1
    UNION ALL
    SELECT e.height, e.supplier_id, e.service_id, 'discarded', left(e.error, 60), NULL::bigint, NULL::bigint, NULL::bigint, NULL::bigint,
           NULL::bigint, NULL::bigint
    FROM ${s}.claim_discards e WHERE e.supplier_id = ANY(suppliers) AND e.height BETWEEN rg.lo1 AND rg.hi1
    UNION ALL
    -- the chain slashes every expired claim, whatever the expiration reason: the slash takes its claim's reason
    SELECT s.height, s.supplier_id, s.service_id, 'slashed', coalesce(e.reason, 'unknown'), NULL::bigint, s.penalty_upokt,
           NULL::bigint, NULL::bigint, NULL::bigint, NULL::bigint
    FROM ${s}.supplier_slashes s
    LEFT JOIN ${s}.claim_expirations e ON e.height = s.height AND e.supplier_id = s.supplier_id
      AND e.application_id = s.application_id AND e.service_id = s.service_id AND e.session_end = s.session_end
    WHERE s.supplier_id = ANY(suppliers) AND s.height BETWEEN rg.lo1 AND rg.hi1
  )
  SELECT ${s}._bucket(bucket, sb.block_time, sp.f), ${s}._bucket_end(bucket, sb.block_time, sp.t), CASE WHEN by_supplier THEN x.supplier_id ELSE 'all' END, CASE WHEN by_service THEN x.service_id ELSE 'all' END, x.kind, x.reason,
         count(*)::bigint, sum(x.claimed_upokt)::numeric,
         sum(x.slashed)::numeric, sum(x.relays)::numeric, sum(x.estimated_relays)::numeric,
         sum(x.claimed_compute_units)::numeric, sum(x.estimated_compute_units)::numeric
  FROM x JOIN ${s}.settlement_blocks sb USING (height)
  GROUP BY 1, 2, 3, 4, 5, 6
  ), res(bucket_start, bucket_end, supplier_id, service_id, kind, reason, events, claimed_upokt, slashed_upokt, relays, estimated_relays, compute_units, estimated_compute_units) AS (
  -- every requested id gets its row or series, 0 where it had no activity (not in the sparse output)
  SELECT * FROM res0
  UNION ALL
  SELECT ${s}._bucket(bucket, sp.f, sp.f), ${s}._bucket_end(bucket, sp.f, sp.t), u.id, 'all', 'all', 'all', 0::bigint, 0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric
  FROM (SELECT DISTINCT unnest(suppliers) id) u
  WHERE u.id IS NOT NULL AND fill_empty_buckets AND by_supplier AND sp.f IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM res0 r0 WHERE r0.supplier_id = u.id)
  UNION ALL
  -- the group total of a list with no activity at all: one zero row
  SELECT ${s}._bucket(bucket, sp.f, sp.f), ${s}._bucket_end(bucket, sp.f, sp.t), 'all', 'all', 'all', 'all', 0::bigint, 0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric
  WHERE fill_empty_buckets AND NOT by_supplier AND sp.f IS NOT NULL AND cardinality(suppliers) > 0 AND NOT EXISTS (SELECT 1 FROM res0)
  )
  SELECT r.* FROM res r WHERE bucket IS NULL OR NOT fill_empty_buckets OR r.bucket_start <= sp.t_last
  UNION ALL
  SELECT b.bucket_start, b.bucket_end, k.supplier_id, k.service_id, k.kind, k.reason, CASE WHEN k.events_na THEN NULL ELSE 0 END, CASE WHEN k.claimed_upokt_na THEN NULL ELSE 0 END, CASE WHEN k.slashed_upokt_na THEN NULL ELSE 0 END, CASE WHEN k.relays_na THEN NULL ELSE 0 END, CASE WHEN k.estimated_relays_na THEN NULL ELSE 0 END, CASE WHEN k.compute_units_na THEN NULL ELSE 0 END, CASE WHEN k.estimated_compute_units_na THEN NULL ELSE 0 END
  FROM ${s}._buckets(bucket, sp.f, sp.t_last) b
  CROSS JOIN (SELECT r.supplier_id, r.service_id, r.kind, r.reason, bool_and(r.events IS NULL) events_na, bool_and(r.claimed_upokt IS NULL) claimed_upokt_na, bool_and(r.slashed_upokt IS NULL) slashed_upokt_na, bool_and(r.relays IS NULL) relays_na, bool_and(r.estimated_relays IS NULL) estimated_relays_na, bool_and(r.compute_units IS NULL) compute_units_na, bool_and(r.estimated_compute_units IS NULL) estimated_compute_units_na FROM res r GROUP BY r.supplier_id, r.service_id, r.kind, r.reason) k
  WHERE bucket IS NOT NULL AND fill_empty_buckets
    AND NOT EXISTS (SELECT 1 FROM res r WHERE r.bucket_start = b.bucket_start AND coalesce(r.supplier_id, chr(1)) = coalesce(k.supplier_id, chr(1)) AND coalesce(r.service_id, chr(1)) = coalesce(k.service_id, chr(1)) AND coalesce(r.kind, chr(1)) = coalesce(k.kind, chr(1)) AND coalesce(r.reason, chr(1)) = coalesce(k.reason, chr(1)))
  ORDER BY 1 DESC, 3, 4, 5, 6;
END $$;

-- Service: the total usage of a set of services (a service owner resolves its own through services.owner_id).
-- Pass services, top_by_settled, or both: top_by_settled = N picks the N services (among services, when given) with the most settled_upokt in
-- the whole range (ties by service_id), and a series then covers those N; rank_by_settled is their place (1 = most),
-- NULL when the caller names the services. Rows come ordered by rank, then bucket.
CREATE OR REPLACE FUNCTION ${s}.get_service_usage(services text[], range_start timestamptz, range_end timestamptz,
  bucket text DEFAULT NULL, top_by_settled int DEFAULT NULL, by_service boolean DEFAULT true,
  fill_empty_buckets boolean DEFAULT false)
RETURNS TABLE(bucket_start timestamptz, bucket_end timestamptz, service_id text, claimed_upokt numeric, settled_upokt numeric,
  overservicing_loss_upokt numeric, relays numeric, estimated_relays numeric, compute_units numeric,
  estimated_compute_units numeric, claims bigint, rank_by_settled int)
LANGUAGE plpgsql STABLE SET enable_mergejoin = off SET plan_cache_mode = force_custom_plan AS $$
DECLARE rg record; sp record;
BEGIN
  IF services IS NULL AND top_by_settled IS NULL THEN
    RAISE EXCEPTION 'pass services, top_by_settled, or both (the top among those services)';
  END IF;
  IF top_by_settled IS NOT NULL AND (top_by_settled < 1 OR top_by_settled > 200) THEN
    RAISE EXCEPTION 'top_by_settled must be between 1 and 200 (is %)', top_by_settled;
  END IF;
  PERFORM ${s}._validate(services, CASE WHEN services IS NULL THEN '' ELSE 'services' END, range_start, range_end, bucket);
  sp := ${s}._span(range_start, range_end);
  IF top_by_settled IS NOT NULL THEN
    rg := ${s}._ranges(range_start, range_end, NULL);
    services := ARRAY(
      SELECT t.service_id FROM (
        SELECT d.service_id, d.settled_upokt FROM ${s}.daily_claims_by_application_service d
        WHERE d.day BETWEEN rg.d1 AND rg.d2 AND (services IS NULL OR d.service_id = ANY(services))
        UNION ALL
        SELECT c.service_id, c.settled_upokt FROM ${s}.settlement_claims_by_application_service c
        WHERE (c.height BETWEEN rg.lo1 AND rg.hi1 OR c.height BETWEEN rg.lo2 AND rg.hi2)
          AND (services IS NULL OR c.service_id = ANY(services))) t
      GROUP BY t.service_id ORDER BY sum(t.settled_upokt) DESC, t.service_id COLLATE "C" LIMIT top_by_settled);
  END IF;
  rg := ${s}._ranges(range_start, range_end, bucket);
  RETURN QUERY
  WITH res0(bucket_start, bucket_end, service_id, claimed_upokt, settled_upokt, overservicing_loss_upokt, relays, estimated_relays, compute_units, estimated_compute_units, claims) AS (
  WITH r AS (
    SELECT d.day::timestamp AT TIME ZONE 'UTC' block_time, d.service_id, d.claimed_upokt, d.settled_upokt, d.overservicing_loss_upokt,
           d.relays, d.estimated_relays, d.claimed_compute_units, d.estimated_compute_units, d.claim_count claims
    FROM ${s}.daily_claims_by_application_service d WHERE d.service_id = ANY(services) AND d.day BETWEEN rg.d1 AND rg.d2
    UNION ALL
    SELECT c.block_time, c.service_id, c.claimed_upokt, c.settled_upokt, c.overservicing_loss_upokt,
           c.relays, c.estimated_relays, c.claimed_compute_units, c.estimated_compute_units, c.claim_count
    FROM ${s}.settlement_claims_by_application_service c
    WHERE c.service_id = ANY(services) AND (c.height BETWEEN rg.lo1 AND rg.hi1 OR c.height BETWEEN rg.lo2 AND rg.hi2)
  )
  SELECT ${s}._bucket(bucket, r.block_time, sp.f), ${s}._bucket_end(bucket, r.block_time, sp.t), CASE WHEN by_service THEN r.service_id ELSE 'all' END, sum(r.claimed_upokt)::numeric, sum(r.settled_upokt)::numeric,
         sum(r.overservicing_loss_upokt)::numeric, sum(r.relays)::numeric, sum(r.estimated_relays)::numeric,
         sum(r.claimed_compute_units)::numeric, sum(r.estimated_compute_units)::numeric, sum(r.claims)::bigint
  FROM r GROUP BY 1, 2, 3
  ), res(bucket_start, bucket_end, service_id, claimed_upokt, settled_upokt, overservicing_loss_upokt, relays, estimated_relays, compute_units, estimated_compute_units, claims) AS (
  -- every requested id gets its row or series, 0 where it had no activity (not in the sparse output)
  SELECT * FROM res0
  UNION ALL
  SELECT ${s}._bucket(bucket, sp.f, sp.f), ${s}._bucket_end(bucket, sp.f, sp.t), u.id, 0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::bigint
  FROM (SELECT DISTINCT unnest(services) id) u
  WHERE u.id IS NOT NULL AND fill_empty_buckets AND by_service AND sp.f IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM res0 r0 WHERE r0.service_id = u.id)
  UNION ALL
  -- the group total of a list with no activity at all: one zero row
  SELECT ${s}._bucket(bucket, sp.f, sp.f), ${s}._bucket_end(bucket, sp.f, sp.t), 'all', 0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::bigint
  WHERE fill_empty_buckets AND NOT by_service AND sp.f IS NOT NULL AND cardinality(services) > 0 AND NOT EXISTS (SELECT 1 FROM res0)
  )
  SELECT r.*, CASE WHEN top_by_settled IS NOT NULL THEN array_position(services, r.service_id) END FROM res r
  WHERE bucket IS NULL OR NOT fill_empty_buckets OR r.bucket_start <= sp.t_last
  UNION ALL
  SELECT b.bucket_start, b.bucket_end, k.service_id, CASE WHEN k.claimed_upokt_na THEN NULL ELSE 0 END, CASE WHEN k.settled_upokt_na THEN NULL ELSE 0 END, CASE WHEN k.overservicing_loss_upokt_na THEN NULL ELSE 0 END, CASE WHEN k.relays_na THEN NULL ELSE 0 END, CASE WHEN k.estimated_relays_na THEN NULL ELSE 0 END, CASE WHEN k.compute_units_na THEN NULL ELSE 0 END, CASE WHEN k.estimated_compute_units_na THEN NULL ELSE 0 END, CASE WHEN k.claims_na THEN NULL ELSE 0 END, CASE WHEN top_by_settled IS NOT NULL THEN array_position(services, k.service_id) END
  FROM ${s}._buckets(bucket, sp.f, sp.t_last) b
  CROSS JOIN (SELECT r.service_id, bool_and(r.claimed_upokt IS NULL) claimed_upokt_na, bool_and(r.settled_upokt IS NULL) settled_upokt_na, bool_and(r.overservicing_loss_upokt IS NULL) overservicing_loss_upokt_na, bool_and(r.relays IS NULL) relays_na, bool_and(r.estimated_relays IS NULL) estimated_relays_na, bool_and(r.compute_units IS NULL) compute_units_na, bool_and(r.estimated_compute_units IS NULL) estimated_compute_units_na, bool_and(r.claims IS NULL) claims_na FROM res r GROUP BY r.service_id) k
  WHERE bucket IS NOT NULL AND fill_empty_buckets
    AND NOT EXISTS (SELECT 1 FROM res r WHERE r.bucket_start = b.bucket_start AND coalesce(r.service_id, chr(1)) = coalesce(k.service_id, chr(1)))
  ORDER BY 12, 1 DESC, 3;
END $$;

-- Applications unstaked by the chain because their stake fell below the minimum
-- (EventApplicationUnbondingBegin.reason = APPLICATION_UNBONDING_REASON_BELOW_MIN_STAKE = 1, stored as the
-- proto enum number). applications NULL = every application.
CREATE OR REPLACE FUNCTION ${s}.get_app_auto_unstakes(applications text[], range_start timestamptz, range_end timestamptz,
  bucket text DEFAULT NULL, by_application boolean DEFAULT true,
  fill_empty_buckets boolean DEFAULT false)
RETURNS TABLE(bucket_start timestamptz, bucket_end timestamptz, application_id text, unstakes bigint)
LANGUAGE plpgsql STABLE SET enable_mergejoin = off SET plan_cache_mode = force_custom_plan AS $$
DECLARE rg record; sp record;
BEGIN
  PERFORM ${s}._validate(applications, CASE WHEN applications IS NULL THEN '' ELSE 'applications' END,
                         range_start, range_end, bucket);
  sp := ${s}._block_span(range_start, range_end);
  rg := ${s}._block_heights(range_start, range_end);
  RETURN QUERY
  WITH res0(bucket_start, bucket_end, application_id, unstakes) AS (
  SELECT ${s}._bucket(bucket, bl.timestamp AT TIME ZONE 'UTC', sp.f), ${s}._bucket_end(bucket, bl.timestamp AT TIME ZONE 'UTC', sp.t), CASE WHEN by_application THEN e.application_id ELSE 'all' END, count(*)::bigint
  FROM ${s}.event_application_unbonding_begins e JOIN ${s}.blocks bl ON bl.id = e.block_id
  WHERE e.reason = 1 AND (applications IS NULL OR e.application_id = ANY(applications))
    AND e.block_id BETWEEN rg.lo AND rg.hi
  GROUP BY 1, 2, 3
  ), res(bucket_start, bucket_end, application_id, unstakes) AS (
  -- every requested id gets its row or series, 0 where it had no activity (not in the sparse output)
  SELECT * FROM res0
  UNION ALL
  SELECT ${s}._bucket(bucket, sp.f, sp.f), ${s}._bucket_end(bucket, sp.f, sp.t), u.id, 0::bigint
  FROM (SELECT DISTINCT unnest(applications) id) u
  WHERE u.id IS NOT NULL AND fill_empty_buckets AND by_application AND sp.f IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM res0 r0 WHERE r0.application_id = u.id)
  UNION ALL
  -- the group total of a list with no activity at all: one zero row
  SELECT ${s}._bucket(bucket, sp.f, sp.f), ${s}._bucket_end(bucket, sp.f, sp.t), 'all', 0::bigint
  WHERE fill_empty_buckets AND NOT by_application AND sp.f IS NOT NULL AND cardinality(applications) > 0 AND NOT EXISTS (SELECT 1 FROM res0)
  )
  SELECT r.* FROM res r WHERE bucket IS NULL OR NOT fill_empty_buckets OR r.bucket_start <= sp.t_last
  UNION ALL
  SELECT b.bucket_start, b.bucket_end, k.application_id, CASE WHEN k.unstakes_na THEN NULL ELSE 0 END
  FROM ${s}._buckets(bucket, sp.f, sp.t_last) b
  CROSS JOIN (SELECT r.application_id, bool_and(r.unstakes IS NULL) unstakes_na FROM res r GROUP BY r.application_id) k
  WHERE bucket IS NOT NULL AND fill_empty_buckets
    AND NOT EXISTS (SELECT 1 FROM res r WHERE r.bucket_start = b.bucket_start AND coalesce(r.application_id, chr(1)) = coalesce(k.application_id, chr(1)))
  ORDER BY 1 DESC, 3;
END $$;

-- Proofs per supplier: the claims it settled with and without a proof, the proofs it submitted, and how many the
-- chain validated or found invalid, the invalid ones counted per failure reason ({} when there are none). A claim
-- needs a proof only when the chain asks for one (probabilistic, or above the threshold). Each count is by the
-- block of its own event: a proof submitted in one bucket is often validated in the next, so submitted minus
-- validated minus invalid is the pending count only over a range that holds both events. Settled claims read
-- the daily rollup for whole days and claim_settlements at the edges, like get_supplier_earnings.
CREATE OR REPLACE FUNCTION ${s}.get_supplier_proofs(suppliers text[], range_start timestamptz, range_end timestamptz,
  bucket text DEFAULT NULL, by_service boolean DEFAULT false, by_supplier boolean DEFAULT true,
  owners text[] DEFAULT NULL, fill_empty_buckets boolean DEFAULT false)
RETURNS TABLE(bucket_start timestamptz, bucket_end timestamptz, supplier_id text, service_id text,
  claims_settled_with_proof bigint, claims_settled_without_proof bigint,
  proofs_submitted bigint, proofs_validated bigint, proofs_invalid bigint, invalid_by_reason jsonb)
LANGUAGE plpgsql STABLE SET enable_mergejoin = off SET plan_cache_mode = force_custom_plan AS $$
DECLARE rg record; rc record; sp record; all_suppliers boolean;
BEGIN
  IF suppliers IS NOT NULL AND owners IS NOT NULL THEN
    RAISE EXCEPTION 'pass suppliers or owners (the suppliers they own now), not both';
  END IF;
  IF owners IS NOT NULL THEN
    PERFORM ${s}._validate(owners, 'owners', range_start, range_end, bucket);
    -- no cap: an owner can have any number of suppliers
    suppliers := ARRAY(SELECT DISTINCT su.id FROM ${s}.suppliers su WHERE su.owner_id = ANY(owners) AND su._block_range @> 9223372036854775807::bigint);
  ELSE
    -- NULL suppliers (and no owners): every supplier
    PERFORM ${s}._validate(suppliers, CASE WHEN suppliers IS NULL THEN '' ELSE 'suppliers' END, range_start, range_end, bucket);
  END IF;
  all_suppliers := suppliers IS NULL;
  sp := ${s}._block_span(range_start, range_end);
  rg := ${s}._block_heights(range_start, range_end);
  rc := ${s}._ranges(range_start, range_end, bucket);
  RETURN QUERY
  WITH res0(bucket_start, bucket_end, supplier_id, service_id, claims_settled_with_proof, claims_settled_without_proof, proofs_submitted, proofs_validated, proofs_invalid, invalid_by_reason) AS (
  WITH x AS (
    SELECT d.day::timestamp AT TIME ZONE 'UTC' block_time, d.supplier_id sup, d.service_id svc,
           d.claims_with_proof with_proof, d.claim_count - d.claims_with_proof without_proof,
           0 submitted, 0 validated, 0 invalid, NULL::text reason
    FROM ${s}.daily_claims_by_supplier_application_service d
    WHERE (all_suppliers OR d.supplier_id = ANY(suppliers)) AND d.day BETWEEN rc.d1 AND rc.d2
    UNION ALL
    SELECT c.block_time, c.supplier_id, c.service_id, c.settled_with_proof::int, (NOT c.settled_with_proof)::int, 0, 0, 0, NULL
    FROM ${s}.claim_settlements c
    WHERE (all_suppliers OR c.supplier_id = ANY(suppliers)) AND (c.height BETWEEN rc.lo1 AND rc.hi1 OR c.height BETWEEN rc.lo2 AND rc.hi2)
    UNION ALL
    SELECT bl.timestamp AT TIME ZONE 'UTC', p.supplier_id, p.service_id, 0, 0, 1, 0, 0, NULL
    FROM ${s}.msg_submit_proofs p JOIN ${s}.blocks bl ON bl.id = p.block_id
    WHERE (all_suppliers OR p.supplier_id = ANY(suppliers)) AND p.block_id BETWEEN rg.lo AND rg.hi
    UNION ALL
    SELECT bl.timestamp AT TIME ZONE 'UTC', c.supplier_id, c.service_id, 0, 0, 0,
           (c.proof_validation_status::text = 'VALIDATED')::int, (c.proof_validation_status::text = 'INVALID')::int,
           CASE WHEN c.proof_validation_status::text = 'INVALID' THEN coalesce(nullif(c.failure_reason, ''), 'unspecified') END
    FROM ${s}.event_proof_validity_checkeds c JOIN ${s}.blocks bl ON bl.id = c.block_id
    WHERE (all_suppliers OR c.supplier_id = ANY(suppliers)) AND c.block_id BETWEEN rg.lo AND rg.hi
  ), g AS (
    SELECT ${s}._bucket(bucket, x.block_time, sp.f) b1, ${s}._bucket_end(bucket, x.block_time, sp.t) b2,
           CASE WHEN by_supplier THEN x.sup ELSE 'all' END sup, CASE WHEN by_service THEN x.svc ELSE 'all' END svc, x.reason,
           sum(x.with_proof) cw, sum(x.without_proof) cwo, sum(x.submitted) s, sum(x.validated) v, sum(x.invalid) i
    FROM x
    GROUP BY 1, 2, 3, 4, 5
  )
  SELECT g.b1, g.b2, g.sup, g.svc, sum(g.cw)::bigint, sum(g.cwo)::bigint, sum(g.s)::bigint, sum(g.v)::bigint,
         sum(g.i)::bigint, coalesce(jsonb_object_agg(g.reason, g.i) FILTER (WHERE g.reason IS NOT NULL), '{}'::jsonb)
  FROM g GROUP BY 1, 2, 3, 4
  ), res(bucket_start, bucket_end, supplier_id, service_id, claims_settled_with_proof, claims_settled_without_proof, proofs_submitted, proofs_validated, proofs_invalid, invalid_by_reason) AS (
  -- every requested id gets its row or series, 0 where it had no activity (not in the sparse output)
  SELECT * FROM res0
  UNION ALL
  SELECT ${s}._bucket(bucket, sp.f, sp.f), ${s}._bucket_end(bucket, sp.f, sp.t), u.id, 'all', 0::bigint, 0::bigint, 0::bigint, 0::bigint, 0::bigint, '{}'::jsonb
  FROM (SELECT DISTINCT unnest(suppliers) id) u
  WHERE u.id IS NOT NULL AND fill_empty_buckets AND by_supplier AND sp.f IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM res0 r0 WHERE r0.supplier_id = u.id)
  UNION ALL
  -- the group total of a list with no activity at all: one zero row
  SELECT ${s}._bucket(bucket, sp.f, sp.f), ${s}._bucket_end(bucket, sp.f, sp.t), 'all', 'all', 0::bigint, 0::bigint, 0::bigint, 0::bigint, 0::bigint, '{}'::jsonb
  WHERE fill_empty_buckets AND NOT by_supplier AND sp.f IS NOT NULL AND (all_suppliers OR cardinality(suppliers) > 0) AND NOT EXISTS (SELECT 1 FROM res0)
  )
  SELECT r.* FROM res r WHERE bucket IS NULL OR NOT fill_empty_buckets OR r.bucket_start <= sp.t_last
  UNION ALL
  SELECT b.bucket_start, b.bucket_end, k.supplier_id, k.service_id, CASE WHEN k.claims_settled_with_proof_na THEN NULL ELSE 0 END, CASE WHEN k.claims_settled_without_proof_na THEN NULL ELSE 0 END, CASE WHEN k.proofs_submitted_na THEN NULL ELSE 0 END, CASE WHEN k.proofs_validated_na THEN NULL ELSE 0 END, CASE WHEN k.proofs_invalid_na THEN NULL ELSE 0 END, CASE WHEN k.invalid_by_reason_na THEN NULL ELSE '{}'::jsonb END
  FROM ${s}._buckets(bucket, sp.f, sp.t_last) b
  CROSS JOIN (SELECT r.supplier_id, r.service_id, bool_and(r.claims_settled_with_proof IS NULL) claims_settled_with_proof_na, bool_and(r.claims_settled_without_proof IS NULL) claims_settled_without_proof_na, bool_and(r.proofs_submitted IS NULL) proofs_submitted_na, bool_and(r.proofs_validated IS NULL) proofs_validated_na, bool_and(r.proofs_invalid IS NULL) proofs_invalid_na, bool_and(r.invalid_by_reason IS NULL) invalid_by_reason_na FROM res r GROUP BY r.supplier_id, r.service_id) k
  WHERE bucket IS NOT NULL AND fill_empty_buckets
    AND NOT EXISTS (SELECT 1 FROM res r WHERE r.bucket_start = b.bucket_start AND coalesce(r.supplier_id, chr(1)) = coalesce(k.supplier_id, chr(1)) AND coalesce(r.service_id, chr(1)) = coalesce(k.service_id, chr(1)))
  ORDER BY 1 DESC, 3, 4;
END $$;

-- Governance parameter history: only versions whose value differs from the previous version of the same
-- param (a module update rewrites every key; most rewrites change nothing). shared
-- session_grid_anchor_height 0 means the genesis grid, i.e. 1 (poktroll x/shared/types/session.go), so
-- 0 <-> 1 is not a change. active_at is NULL on versions written before that field existed.
CREATE OR REPLACE FUNCTION ${s}.get_param_history(namespaces text[], keys text[], range_start timestamptz,
  range_end timestamptz)
RETURNS TABLE(namespace text, key text, height bigint, block_time timestamptz, active_at bigint, value text, previous_value text)
LANGUAGE plpgsql STABLE SET plan_cache_mode = force_custom_plan AS $$
DECLARE rg record;
BEGIN
  PERFORM ${s}._validate(NULL, '', range_start, range_end, NULL);
  rg := ${s}._block_heights(range_start, range_end);
  RETURN QUERY
  SELECT x.namespace, x.key, x.height::bigint, bl.timestamp AT TIME ZONE 'UTC', x.active_at::bigint, x.value, x.prev
  FROM (
    SELECT p.namespace, p.key, lower(p._block_range) height, p.active_at, p.value, p.eff,
           lag(p.value) OVER w prev, lag(p.eff) OVER w prev_eff
    FROM (
      SELECT pp.*, CASE WHEN pp.namespace = 'shared' AND pp.key = 'session_grid_anchor_height' AND pp.value = '0'
                        THEN '1' ELSE pp.value END eff
      FROM ${s}.params pp
      WHERE (namespaces IS NULL OR pp.namespace = ANY(namespaces)) AND (keys IS NULL OR pp.key = ANY(keys))
    ) p
    WINDOW w AS (PARTITION BY p.id ORDER BY lower(p._block_range))
  ) x JOIN ${s}.blocks bl ON bl.id = x.height
  WHERE x.prev_eff IS DISTINCT FROM x.eff AND x.height BETWEEN rg.lo AND rg.hi
  ORDER BY 3 DESC, 1, 2;
END $$;

-- Compatibility: the signatures and JSON of the live functions, BETWEEN inclusive on UTC timestamps. They were named
-- money_* before; a database written by that version still has them.
DROP FUNCTION IF EXISTS ${s}.money_rewards_by_addresses_and_time(text[], timestamp, timestamp);
DROP FUNCTION IF EXISTS ${s}.money_rewards_by_addresses_and_time_group_by_date(text[], timestamp, timestamp, text);
DROP FUNCTION IF EXISTS ${s}.money_rewards_by_addresses_and_time_group_by_address_and_date(text[], timestamp, timestamp, text);
DROP FUNCTION IF EXISTS ${s}.money_rewards_of_addresses_by_suppliers_and_time(text[], text[], timestamp, timestamp);
DROP FUNCTION IF EXISTS ${s}.money_rewards_by_suppliers_and_time_group_by_address_and_date(text[], text[], timestamp, timestamp, text);
DROP FUNCTION IF EXISTS ${s}.money_mint_breakdown_between_dates(timestamp, timestamp);

CREATE OR REPLACE FUNCTION ${s}.legacy_rewards_by_addresses_and_time(addresses text[], start_date timestamp,
  end_date timestamp)
RETURNS numeric LANGUAGE sql STABLE AS $$
  SELECT coalesce(sum(i.amount_upokt), 0)::numeric
  FROM ${s}._income(addresses, start_date AT TIME ZONE 'UTC', (end_date + interval '1 microsecond') AT TIME ZONE 'UTC', fill_empty_buckets => false) i
$$;

CREATE OR REPLACE FUNCTION ${s}.legacy_rewards_by_addresses_and_time_group_by_date(addresses text[], start_date timestamp,
  end_date timestamp, trunc_interval text)
RETURNS json LANGUAGE sql STABLE AS $$
  SELECT json_agg(json_build_object('date_truncated', t, 'total_amount', a) ORDER BY t)
  FROM (SELECT (CASE WHEN trunc_interval IS NOT NULL THEN i.bucket_start AT TIME ZONE 'UTC' END) t, sum(i.amount_upokt)::numeric a
        FROM ${s}._income(addresses, start_date AT TIME ZONE 'UTC', (end_date + interval '1 microsecond') AT TIME ZONE 'UTC',
                             trunc_interval, fill_empty_buckets => false) i GROUP BY 1) s
$$;

CREATE OR REPLACE FUNCTION ${s}.legacy_rewards_by_addresses_and_time_group_by_address_and_date(addresses text[],
  start_date timestamp, end_date timestamp, trunc_interval text)
RETURNS json LANGUAGE sql STABLE AS $$
  SELECT json_agg(json_build_object('address', ad, 'date_truncated', t, 'total_amount', a) ORDER BY t)
  FROM (SELECT i.address ad, (CASE WHEN trunc_interval IS NOT NULL THEN i.bucket_start AT TIME ZONE 'UTC' END) t, sum(i.amount_upokt)::numeric a
        FROM ${s}._income(addresses, start_date AT TIME ZONE 'UTC', (end_date + interval '1 microsecond') AT TIME ZONE 'UTC',
                             trunc_interval, fill_empty_buckets => false) i GROUP BY 1, 2) s
$$;

CREATE OR REPLACE FUNCTION ${s}.legacy_rewards_of_addresses_by_suppliers_and_time(addresses text[],
  supplier_addresses text[], start_date timestamp, end_date timestamp)
RETURNS numeric LANGUAGE plpgsql STABLE SET plan_cache_mode = force_custom_plan AS $$
BEGIN
  RETURN (SELECT coalesce(sum(i.amount_upokt), 0)::numeric
          FROM ${s}._income(addresses, start_date AT TIME ZONE 'UTC', (end_date + interval '1 microsecond') AT TIME ZONE 'UTC',
                               NULL, false, true, fill_empty_buckets => false, suppliers => coalesce(supplier_addresses, '{}')) i);
END $$;

-- Hourly series read hourly_income_by_address_supplier, which has exactly this grain (address, hour, supplier), for the
-- hours inside the range; the partial hours at its edges come from the base tables through get_income.
CREATE OR REPLACE FUNCTION ${s}.legacy_rewards_by_suppliers_and_time_group_by_address_and_date(addresses text[],
  supplier_addresses text[], start_date timestamp, end_date timestamp, trunc_interval text)
RETURNS json LANGUAGE plpgsql STABLE SET plan_cache_mode = force_custom_plan AS $$
DECLARE
  f timestamptz := start_date AT TIME ZONE 'UTC';
  t timestamptz := (end_date + interval '1 microsecond') AT TIME ZONE 'UTC';
  h1 timestamptz := date_trunc('hour', f, 'UTC');
  h2 timestamptz := date_trunc('hour', t, 'UTC');
  e1 boolean; e2 boolean;
BEGIN
  IF trunc_interval IS DISTINCT FROM 'hour' THEN
    RETURN (SELECT json_agg(json_build_object('address', ad, 'date_truncated', d, 'total_amount', a) ORDER BY d)
            FROM (SELECT i.address ad, (CASE WHEN trunc_interval IS NOT NULL THEN i.bucket_start AT TIME ZONE 'UTC' END) d, sum(i.amount_upokt)::numeric a
                  FROM ${s}._income(addresses, f, t, trunc_interval, false, true, fill_empty_buckets => false,
                                    suppliers => coalesce(supplier_addresses, '{}')) i
                  GROUP BY 1, 2) s);
  END IF;
  PERFORM ${s}._validate(addresses, '', f, t, 'hour');
  PERFORM ${s}._check_coverage(f, t);
  IF h1 < f THEN h1 := h1 + interval '1 hour'; END IF;  -- first whole hour
  IF h1 >= h2 THEN h1 := t; h2 := t; END IF;  -- no whole hour: everything from the base
  -- an edge with no settlement is skipped (end_date is inclusive, so a whole-hour range leaves a 1 µs tail)
  e1 := f < h1 AND EXISTS (SELECT 1 FROM ${s}.settlement_blocks sb WHERE sb.block_time >= f AND sb.block_time < h1);
  e2 := h2 < t AND EXISTS (SELECT 1 FROM ${s}.settlement_blocks sb WHERE sb.block_time >= h2 AND sb.block_time < t);
  RETURN (SELECT json_agg(json_build_object('address', ad, 'date_truncated', d, 'total_amount', a) ORDER BY d)
          FROM (SELECT x.address ad, (x.hour AT TIME ZONE 'UTC') d, sum(x.amount_upokt)::numeric a
                FROM (SELECT h.address, h.hour, h.amount_upokt FROM ${s}.hourly_income_by_address_supplier h
                      WHERE h.address = ANY(addresses) AND h.hour >= h1 AND h.hour < h2
                        AND h.supplier_id = ANY(supplier_addresses)
                      UNION ALL
                      SELECT i.address, i.bucket_start, i.amount_upokt
                      FROM ${s}._income(addresses, f, h1, 'hour', false, true, fill_empty_buckets => false,
                                        suppliers => coalesce(supplier_addresses, '{}')) i
                      WHERE e1
                      UNION ALL
                      SELECT i.address, i.bucket_start, i.amount_upokt
                      FROM ${s}._income(addresses, h2, t, 'hour', false, true, fill_empty_buckets => false,
                                        suppliers => coalesce(supplier_addresses, '{}')) i
                      WHERE e2) x
                GROUP BY 1, 2) s);
END $$;

-- inflation is the whole global mint (every role, = TLM_GLOBAL_MINT_INFLATION), reimbursement the application's escrow to
-- the DAO, mint_burn the relay mint: the same JSON as the live function since #94 (md5 equal on mainnet over 24 h, 7 d
-- and 30 d, and on beta month by month, 2026-10-05), except at beta heights 153513, 153573, 153633 and 153693, whose 32
-- claims each carry a 1 upokt escrow here and none in the indexer's event_claim_settleds.mints (128 upokt in March 2026).
CREATE OR REPLACE FUNCTION ${s}.legacy_mint_breakdown_between_dates(start_date timestamp, end_date timestamp)
RETURNS json LANGUAGE sql STABLE AS $$
  SELECT json_build_object(
    'reimbursement', coalesce(sum(f.amount_upokt) FILTER (WHERE f.flow = 'reimbursement'), 0),
    'inflation', coalesce(sum(f.amount_upokt) FILTER (WHERE f.flow = 'global_mint'), 0),
    'mint_burn', coalesce(sum(f.amount_upokt) FILTER (WHERE f.flow = 'mint_equals_burn'), 0))
  FROM ${s}.get_supply_flows(start_date AT TIME ZONE 'UTC', (end_date + interval '1 microsecond') AT TIME ZONE 'UTC') f
$$;

-- burn_mint: what the applications burned for the claims settled in the range (get_supply_flows' burn).
CREATE OR REPLACE FUNCTION ${s}.legacy_burn_breakdown_between_dates(start_date timestamp, end_date timestamp)
RETURNS json LANGUAGE sql STABLE AS $$
  SELECT json_build_object('burn_mint', coalesce(sum(f.amount_upokt) FILTER (WHERE f.flow = 'burn'), 0))
  FROM ${s}.get_supply_flows(start_date AT TIME ZONE 'UTC', (end_date + interval '1 microsecond') AT TIME ZONE 'UTC') f
$$;

-- The claims of these suppliers settled in [f, t), by service, from the daily rollup and the base at the edges, as
-- get_supplier_earnings reads them; any number of suppliers. settled_upokt is the live functions' gross_rewards: the
-- indexer's event_claim_settleds.claimed_amount is the settled amount (an overserviced claim's is below its claim),
-- measured equal per settlement height over the whole money history of mainnet and beta (2026-10-05).
CREATE OR REPLACE FUNCTION ${s}._legacy_claims_by_service(p_suppliers text[], f timestamptz, t timestamptz)
RETURNS TABLE(service_id text, settled_upokt numeric, relays numeric, estimated_relays numeric, compute_units numeric,
  estimated_compute_units numeric)
LANGUAGE plpgsql STABLE SET plan_cache_mode = force_custom_plan AS $$
DECLARE rg record;
BEGIN
  rg := ${s}._ranges(f, t, NULL);
  RETURN QUERY
  SELECT r.service_id, sum(r.settled_upokt)::numeric, sum(r.relays)::numeric, sum(r.estimated_relays)::numeric,
         sum(r.claimed_compute_units)::numeric, sum(r.estimated_compute_units)::numeric
  FROM (
    SELECT d.service_id, d.settled_upokt, d.relays, d.estimated_relays, d.claimed_compute_units, d.estimated_compute_units
    FROM ${s}.daily_claims_by_supplier_application_service d
    WHERE d.supplier_id = ANY(p_suppliers) AND d.day BETWEEN rg.d1 AND rg.d2
    UNION ALL
    SELECT c.service_id, c.settled_upokt, c.relays, c.estimated_relays, c.claimed_compute_units, c.estimated_compute_units
    FROM ${s}.claim_settlements c
    WHERE c.supplier_id = ANY(p_suppliers) AND (c.height BETWEEN rg.lo1 AND rg.hi1 OR c.height BETWEEN rg.lo2 AND rg.hi2)
  ) r GROUP BY 1;
END $$;

-- One element per service the suppliers are configured for now (as the live function), with the claims they settled
-- in the range on it; services ordered by id.
CREATE OR REPLACE FUNCTION ${s}.legacy_rewards_by_suppliers_and_time_group_by_service(operator_addresses text[],
  start_ts timestamp, end_ts timestamp)
RETURNS jsonb LANGUAGE plpgsql STABLE SET plan_cache_mode = force_custom_plan AS $$
DECLARE
  f timestamptz := start_ts AT TIME ZONE 'UTC';
  t timestamptz := (end_ts + interval '1 microsecond') AT TIME ZONE 'UTC';
BEGIN
  PERFORM ${s}._validate(NULL, '', f, t, NULL);
  -- the claims are read only for listed services: an empty list must raise outside the coverage too
  PERFORM ${s}._check_coverage(f, t);
  RETURN (
    SELECT jsonb_agg(jsonb_build_object(
             'service_id', sv.service_id,
             'relays', coalesce(c.relays, 0),
             'estimated_relays', coalesce(c.estimated_relays, 0),
             'computed_units', coalesce(c.compute_units, 0),
             'estimated_computed_units', coalesce(c.estimated_compute_units, 0),
             'gross_rewards', coalesce(c.settled_upokt, 0)) ORDER BY sv.service_id)
    FROM (SELECT DISTINCT ssc.service_id FROM ${s}.supplier_service_configs ssc
          WHERE ssc.supplier_id = ANY(operator_addresses) AND upper_inf(ssc._block_range)) sv
    LEFT JOIN ${s}._legacy_claims_by_service(operator_addresses, f, t) c ON c.service_id = sv.service_id);
END $$;

-- One element per service of the staked suppliers whose current configuration shares revenue with the addresses (as the
-- live function). net_rewards is what the addresses received from that service's claims, as the live function. The claim
-- columns (gross_rewards, relays, computed_units and their estimates) differ on purpose: the live function adds a claim
-- once per transfer that paid one of the addresses (relay and global mint, and each address of the list), here each claim
-- that paid them counts once. Measured on mainnet: pokt1m0yk72fcvut72ujrs7hyf4mzgahe4c9ya429eh on 2026-10-03 got 27
-- transfers from 20 claims (948613-finalize_block-3067 pays it twice): relays 577,473 live, 289,472 per claim; gross
-- 553,512,909 live, 277,061,678 per claim; net 209,138,830 in both.
CREATE OR REPLACE FUNCTION ${s}.legacy_rewards_by_addresses_and_time_group_by_service(addresses text[],
  start_ts timestamp, end_ts timestamp)
RETURNS jsonb LANGUAGE plpgsql STABLE SET plan_cache_mode = force_custom_plan AS $$
DECLARE
  f timestamptz := start_ts AT TIME ZONE 'UTC';
  t timestamptz := (end_ts + interval '1 microsecond') AT TIME ZONE 'UTC';
  lo bigint; hi bigint;
BEGIN
  PERFORM ${s}._validate(NULL, '', f, t, NULL);
  PERFORM ${s}._check_coverage(f, t);
  SELECT min(sb.height), max(sb.height) INTO lo, hi FROM ${s}.settlement_blocks sb WHERE sb.block_time >= f AND sb.block_time < t;
  RETURN (
    WITH matched_suppliers AS (
      SELECT DISTINCT ssc.supplier_id
      FROM ${s}.supplier_service_configs ssc
      JOIN ${s}.suppliers su ON su.id = ssc.supplier_id
      CROSS JOIN jsonb_array_elements(ssc.rev_share) AS elem
      WHERE elem->>'address' = ANY(addresses) AND upper_inf(ssc._block_range)
        AND su.stake_status = 'Staked' AND upper_inf(su._block_range)
    ), services AS (
      SELECT DISTINCT ssc.service_id
      FROM ${s}.supplier_service_configs ssc JOIN matched_suppliers m ON m.supplier_id = ssc.supplier_id
      WHERE upper_inf(ssc._block_range)
    ), paid AS (
      -- the claims that paid the addresses, each once: every role a claim pays (v_income_base's claim branches)
      SELECT sp.height, sp.event_idx FROM ${s}.shareholder_payouts sp
      WHERE sp.recipient_id = ANY(addresses) AND sp.height BETWEEN lo AND hi AND (sp.relay_upokt > 0 OR sp.global_upokt > 0)
      UNION
      SELECT c.height, c.event_idx FROM ${s}.claim_settlements c
      WHERE c.source_owner_id = ANY(addresses) AND c.height BETWEEN lo AND hi
        AND (c.relay_to_source_owner_upokt > 0 OR c.global_to_source_owner_upokt > 0)
      UNION
      SELECT c.height, c.event_idx FROM ${s}.claim_settlements c
      WHERE c.application_id = ANY(addresses) AND c.height BETWEEN lo AND hi
        AND (c.relay_to_application_upokt > 0 OR c.global_to_application_upokt > 0)
      UNION
      SELECT c.height, c.event_idx FROM ${s}.settlement_blocks sb JOIN ${s}.claim_settlements c USING (height)
      WHERE sb.dao_address = ANY(addresses) AND sb.height BETWEEN lo AND hi
        AND (c.relay_to_dao_upokt > 0 OR c.global_to_dao_upokt > 0 OR c.reimbursement_to_dao_upokt > 0)
    ), claims AS (
      SELECT c.service_id, sum(c.settled_upokt)::numeric settled_upokt, sum(c.relays)::numeric relays,
             sum(c.estimated_relays)::numeric estimated_relays, sum(c.claimed_compute_units)::numeric compute_units,
             sum(c.estimated_compute_units)::numeric estimated_compute_units
      FROM paid p JOIN ${s}.claim_settlements c ON c.height = p.height AND c.event_idx = p.event_idx GROUP BY 1
    ), net AS (
      SELECT i.service_id, sum(i.amount_upokt) amount_upokt
      FROM ${s}._income(addresses, f, t, NULL, false, false, true, false) i
      WHERE i.service_id IS NOT NULL GROUP BY 1
    )
    SELECT jsonb_agg(jsonb_build_object(
             'service_id', sv.service_id,
             'relays', coalesce(c.relays, 0),
             'estimated_relays', coalesce(c.estimated_relays, 0),
             'computed_units', coalesce(c.compute_units, 0),
             'estimated_computed_units', coalesce(c.estimated_compute_units, 0),
             'gross_rewards', coalesce(c.settled_upokt, 0),
             'net_rewards', coalesce(n.amount_upokt, 0)) ORDER BY sv.service_id)
    FROM services sv
    LEFT JOIN claims c ON c.service_id = sv.service_id
    LEFT JOIN net n ON n.service_id = sv.service_id);
END $$;

-- Every number inside a jsonb (arrays and objects, at any depth) as a JSON string: the twins' nested values, such as
-- coverage heights and get_supplier_proofs.invalid_by_reason counts.
CREATE OR REPLACE FUNCTION ${s}._json_strings(j jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE jsonb_typeof(j)
    WHEN 'number' THEN to_jsonb(j #>> '{}')
    WHEN 'array' THEN (SELECT coalesce(jsonb_agg(${s}._json_strings(x) ORDER BY i), '[]'::jsonb)
                       FROM jsonb_array_elements(j) WITH ORDINALITY a(x, i))
    WHEN 'object' THEN (SELECT coalesce(jsonb_object_agg(k, ${s}._json_strings(v)), '{}'::jsonb) FROM jsonb_each(j) e(k, v))
    ELSE j END
$$;

-- <function>_json for every catalog function that returns rows: the same arguments and defaults, and every row in one
-- jsonb array, in the function's row order, from one execution. Numbers come as JSON strings (amounts reach 2^53, past
-- what a JavaScript number holds exactly), as the GraphQL list gives BigInt / BigFloat. GraphQL serves the row variant as a list capped at
-- --query-limit (1000 in tilt); the jsonb is a scalar, so no row cap or page applies. Built from pg_proc, so a
-- wrapper always has its function's current signature; the old ones are dropped first.
DO $$
DECLARE f record;
BEGIN
  FOR f IN SELECT p.oid::regprocedure sig FROM pg_proc p
           WHERE p.pronamespace = '${s}'::regnamespace AND p.proname IN (SELECT c || '_json' FROM unnest(${CATALOG_SQL}) c) LOOP
    EXECUTE format('DROP FUNCTION %s', f.sig);
  END LOOP;
  FOR f IN SELECT p.proname, pg_get_function_arguments(p.oid) args,
                  (SELECT string_agg(format('%I => %I', n, n), ', ' ORDER BY i)
                   FROM unnest(p.proargnames[1:p.pronargs]) WITH ORDINALITY a(n, i)) call
           FROM pg_proc p
           WHERE p.pronamespace = '${s}'::regnamespace AND p.proname = ANY(${CATALOG_SQL}) LOOP
    EXECUTE format('CREATE FUNCTION ${s}.%I(%s) RETURNS jsonb LANGUAGE sql STABLE AS $f$
      SELECT coalesce(jsonb_agg((SELECT jsonb_object_agg(e.k, CASE jsonb_typeof(e.v)
                 WHEN ''number'' THEN to_jsonb(e.v #>> ''{}'')
                 WHEN ''array'' THEN ${s}._json_strings(e.v) WHEN ''object'' THEN ${s}._json_strings(e.v)
                 ELSE e.v END)
               FROM jsonb_each(to_jsonb(r) - ''ordinality'') e(k, v)) ORDER BY r.ordinality), ''[]''::jsonb)
      FROM ${s}.%I(%s) WITH ORDINALITY r $f$', f.proname || '_json', f.args, f.proname, f.call);
  END LOOP;
END $$;
`;
}
