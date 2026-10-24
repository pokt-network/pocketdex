import { SESSION_ROSTER_CATALOG_FUNCTIONS } from "../sessionRosters";
import { ROLLUP_VERSION, STAKER_ROLES_SQL } from "./writer";

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
// A NULL id list means every id in get_supplier_earnings, get_supplier_proofs, get_supplier_penalties (with no owners or
// operators either), get_validator_rewards and get_delegator_income, so a caller never has to send the list; get_delegator_income also
// takes validators, keeping the income its delegators got from those validators. The size of such an answer is set by
// the bucket and the by_* flags, and GraphQL caps its rows (--query-limit).
// The supplier functions take suppliers, owners or operators: owners resolves, with no cap, the suppliers each owner owns
// now (the Supplier entity's current version, unstaked suppliers included) and reports their whole history, also from
// before a change of owner. An owner with no supplier returns no rows. operators resolves, with no cap, the Staked
// suppliers whose live service configs share revenue with those addresses now (_operator_suppliers), likewise.
//
// Coverage: no function fails for it. Heights that were never written must not read as zero, so each answers for the
// part of the range the money tables cover and says which part that is (_coverage: what is indexed minus the
// settlement_gaps): every row carries covered_from and covered_to (the bounds of that part, half-open; both NULL when
// nothing in the range is covered) and covered_gaps (the gaps that overlap the range, whose heights read as nothing);
// the _json twins return {range, data} with the same. A range that nothing written overlaps returns no rows, so only the _json twin tells
// "not covered" ([] with its range) from "nothing happened". money_coverage(range_start, range_end) lists the
// settlement heights in a range that are missing, and the recorded gaps.
//
// The legacy_* functions answer the live get_rewards_* / get_mint_breakdown_between_dates /
// get_burn_breakdown_between_dates with their arguments and, under data, their JSON, from the money tables, for a
// consumer to switch to.
// Their names swap "get_" for "legacy_" (a prefix would push two of them past PostgreSQL's 63-character limit). Like
// the live functions, they take any number of addresses; the catalog functions take at most 200 ids. They return
// {range, data}: data is the live function's JSON (the two totals' number) over the part of the range the money tables
// cover (_legacy_range), so a consumer that switches also reads .data.
// The catalog functions that return rows: GraphQL lists (smartTags.ts) with a <name>_json twin (end of this file).
// The internal helpers this DDL reshaped, and their current signatures as pg_get_function_arguments gives them (input
// and OUT columns, defaults): the DDL drops every other overload first (null: every overload), because two overloads
// make the calls ambiguous and CREATE OR REPLACE cannot change OUT columns. They are created only by this DDL; a test
// fails when one drifts.
export const HELPER_SIGNATURES: Record<string, string | null> = {
  _income:
    "addresses text[], range_start timestamp with time zone, range_end timestamp with time zone, bucket text DEFAULT NULL::text, by_reason boolean DEFAULT false, by_supplier boolean DEFAULT false, by_service boolean DEFAULT false, by_address boolean DEFAULT true, fill_empty_buckets boolean DEFAULT false, suppliers text[] DEFAULT NULL::text[], capped boolean DEFAULT true, p_covered tstzmultirange DEFAULT NULL::tstzmultirange, p_span_from timestamp with time zone DEFAULT NULL::timestamp with time zone, p_first timestamp with time zone DEFAULT NULL::timestamp with time zone, p_last timestamp with time zone DEFAULT NULL::timestamp with time zone, p_covered_to timestamp with time zone DEFAULT NULL::timestamp with time zone",
  _supply_flows:
    "range_start timestamp with time zone, range_end timestamp with time zone, bucket text DEFAULT NULL::text, by_role boolean DEFAULT false, fill_empty_buckets boolean DEFAULT false, p_covered tstzmultirange DEFAULT NULL::tstzmultirange, p_span_from timestamp with time zone DEFAULT NULL::timestamp with time zone, p_first timestamp with time zone DEFAULT NULL::timestamp with time zone, p_last timestamp with time zone DEFAULT NULL::timestamp with time zone, p_covered_to timestamp with time zone DEFAULT NULL::timestamp with time zone",
  _covered_buckets:
    "bucket text, span_first timestamp with time zone, span_last timestamp with time zone, covered tstzmultirange, OUT bucket_start timestamp with time zone, OUT bucket_end timestamp with time zone",
  _first_bucket:
    "bucket text, span_first timestamp with time zone, span_last timestamp with time zone, covered tstzmultirange",
  _coverage:
    "range_start timestamp with time zone, range_end timestamp with time zone, p_blocks boolean DEFAULT false, OUT requested_from timestamp with time zone, OUT covered_from timestamp with time zone, OUT covered_to timestamp with time zone, OUT gaps jsonb, OUT data_from timestamp with time zone, OUT empty boolean, OUT covered tstzmultirange, OUT first_settled timestamp with time zone, OUT last_settled timestamp with time zone, OUT first_block timestamp with time zone, OUT last_block timestamp with time zone",
  _legacy_range:
    "start_date timestamp without time zone, end_date timestamp without time zone, OUT range json, OUT start_from timestamp without time zone, OUT empty boolean, OUT end_to timestamp without time zone",
  _range_json:
    "range_start timestamp with time zone, range_end timestamp with time zone, p_blocks boolean DEFAULT false",
  _range_of:
    "requested_from timestamp with time zone, requested_to timestamp with time zone, covered_from timestamp with time zone, covered_to timestamp with time zone, gaps jsonb, end_inclusive boolean",
  _span:
    "range_start timestamp with time zone, range_end timestamp with time zone, p_first timestamp with time zone, p_last timestamp with time zone, p_covered_to timestamp with time zone, OUT f timestamp with time zone, OUT t timestamp with time zone, OUT t_last timestamp with time zone",
  // gone: every overload is dropped
  _check_coverage: null,
  _block_span: null,
  _legacy_range_of: null,
};

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
  "get_claims",
  "get_actor_lifecycle",
  "get_block_stats",
  "get_tx_counts",
  "get_staked_suppliers_by_service",
  "get_supply",
  "get_supply_composition",
  "get_network_rewards",
  "get_network_claims",
  "get_overserviced",
  "get_domain_service_rewards",
  "get_supplier_sessions",
  "get_domain_staked_suppliers",
  // the session rosters (sessionRosters.ts)
  ...SESSION_ROSTER_CATALOG_FUNCTIONS,
  "get_relay_mining_difficulty",
  "get_created_claims",
  "get_morse_claims",
  "get_native_transfers",
];
const CATALOG_SQL = `ARRAY[${CATALOG_FUNCTIONS.map((f) => `'${f}'`).join(", ")}]::text[]`;

// The application unbonding events keep the proto's number: get_actor_lifecycle names it with the Application entity's
// unstaking_reason names: the mapping of applications.ts getAppUnbondingReasonFromSDK, which applications.spec.ts checks
// against this one. The entity can also say TRANSFER, which comes from a transfer, not from an unbonding event. An
// unbonding end whose reason the indexer did not recognize is stored as -1 (applicationUnbondingReasonFromJSON) and comes
// as UNRECOGNIZED, the proto's name, which the entity's enum lacks; an unbonding begin with one stops the indexer
// (getAppUnbondingReasonFromSDK throws), so none is stored.
export const APP_UNBONDING_REASON_NAMES: Record<number, string> = {
  0: "ELECTIVE",
  1: "BELOW_MINIMUM_STAKE",
  2: "MIGRATION",
};
const appReason =
  `CASE m.reason ${Object.entries(APP_UNBONDING_REASON_NAMES).map(([n, name]) => `WHEN ${n} THEN '${name}'`).join(" ")} ` +
  "WHEN -1 THEN 'UNRECOGNIZED' ELSE m.reason::text END";

// get_actor_lifecycle reads one table per (kind, event): the columns each fills, by name (the others are NULL), with
// the same actor filter, height range and keyset in every branch (keysetBranches).
const LIFECYCLE_COLUMNS: Record<string, string> = {
  transaction_id: "text",
  stake_upokt: "numeric",
  owner_id: "text",
  reason: "text",
  unbonding_end_height: "numeric",
  session_end_height: "numeric",
  service_id: "text",
  application_id: "text",
  session_id: "text",
  penalty_upokt: "numeric",
  previous_stake_upokt: "numeric",
  proof_validation_status: "text",
  gateway_id: "text",
};
const unbonding = { unbonding_end_height: "m.unbonding_end_height", session_end_height: "m.session_end_height" };
const delegation = { transaction_id: "m.transaction_id", application_id: "m.application_id", gateway_id: "m.gateway_id" };
const appUnbonding = { reason: appReason, unbonding_end_height: "m.unstaking_end_height", session_end_height: "m.session_end_height" };
const LIFECYCLE_BRANCHES: { kind: string; event: string; table: string; actor: string; cols: Record<string, string> }[] = [
  { kind: "supplier", event: "stake", table: "msg_stake_suppliers", actor: "supplier_id",
    cols: { transaction_id: "m.transaction_id", stake_upokt: "m.stake_amount", owner_id: "m.owner_id" } },
  { kind: "supplier", event: "unstake", table: "msg_unstake_suppliers", actor: "supplier_id", cols: { transaction_id: "m.transaction_id" } },
  { kind: "supplier", event: "unbonding_begin", table: "event_supplier_unbonding_begins", actor: "supplier_id",
    cols: { reason: "m.reason::text", ...unbonding } },
  { kind: "supplier", event: "unbonding_end", table: "event_supplier_unbonding_ends", actor: "supplier_id",
    cols: { reason: "m.reason::text", ...unbonding } },
  { kind: "supplier", event: "slash", table: "event_supplier_slasheds", actor: "supplier_id",
    cols: { stake_upokt: "m.after_stake_amount", session_end_height: "m.session_end_height", service_id: "m.service_id",
      application_id: "m.application_id", session_id: "m.session_id", penalty_upokt: "m.proof_missing_penalty",
      previous_stake_upokt: "m.previous_stake_amount", proof_validation_status: "m.proof_validation_status::text" } },
  { kind: "application", event: "stake", table: "msg_stake_applications", actor: "application_id",
    cols: { transaction_id: "m.transaction_id", stake_upokt: "m.stake_amount" } },
  { kind: "application", event: "unstake", table: "msg_unstake_applications", actor: "application_id", cols: { transaction_id: "m.transaction_id" } },
  { kind: "application", event: "unbonding_begin", table: "event_application_unbonding_begins", actor: "application_id", cols: appUnbonding },
  { kind: "application", event: "unbonding_end", table: "event_application_unbonding_ends", actor: "application_id", cols: appUnbonding },
  { kind: "gateway", event: "stake", table: "msg_stake_gateways", actor: "gateway_id",
    cols: { transaction_id: "m.transaction_id", stake_upokt: "m.stake_amount" } },
  { kind: "gateway", event: "unstake", table: "msg_unstake_gateways", actor: "gateway_id", cols: { transaction_id: "m.transaction_id" } },
  { kind: "gateway", event: "unbonding_begin", table: "event_gateway_unbonding_begins", actor: "gateway_id",
    cols: { transaction_id: "m.transaction_id", ...unbonding } },
  { kind: "gateway", event: "unbonding_end", table: "event_gateway_unbonding_ends", actor: "gateway_id", cols: unbonding },
  // a delegation is an event of both actors: the application's row names the gateway, the gateway's the application
  ...(["application", "gateway"] as const).flatMap((kind) => [
    { kind, event: "delegate", table: "msg_delegate_to_gateways", actor: `${kind}_id`, cols: delegation },
    { kind, event: "undelegate", table: "msg_undelegate_from_gateways", actor: `${kind}_id`, cols: delegation },
  ]),
];
// get_morse_claims reads one table per kind of Morse claim, the same way: the columns each fills, by name.
const MORSE_COLUMNS: Record<string, string> = {
  transaction_id: "text",
  morse_src_address: "text",
  shannon_dest_address: "text",
  shannon_operator_address: "text",
  shannon_signing_address: "text",
  morse_node_address: "text",
  balance_upokt: "numeric",
  stake_upokt: "numeric",
  claim_signer_type: "text",
  is_admin: "boolean",
};
const morseClaim = {
  transaction_id: "m.transaction_id",
  morse_src_address: "m.morse_src_address",
  shannon_signing_address: "m.shannon_signing_address",
  balance_upokt: "m.balance_amount",
};
// shannon: the columns shannon_addresses matches
const MORSE_BRANCHES: { kind: string; table: string; shannon: string[]; cols: Record<string, string> }[] = [
  { kind: "account", table: "msg_claim_morse_accounts", shannon: ["shannon_dest_address"],
    cols: { ...morseClaim, shannon_dest_address: "m.shannon_dest_address" } },
  { kind: "application", table: "msg_claim_morse_applications", shannon: ["shannon_dest_address"],
    cols: { ...morseClaim, shannon_dest_address: "m.shannon_dest_address", stake_upokt: "m.stake_amount" } },
  { kind: "supplier", table: "msg_claim_morse_suppliers", shannon: ["shannon_owner_address", "shannon_operator_address"],
    cols: { ...morseClaim, shannon_operator_address: "m.shannon_operator_address",
      morse_node_address: "m.morse_node_address", stake_upokt: "m.stake_amount", claim_signer_type: "m.claim_signer_type::text" } },
  { kind: "recover", table: "msg_recover_morse_accounts", shannon: ["shannon_dest_address_id"],
    cols: { transaction_id: "m.transaction_id", morse_src_address: "m.morse_src_address",
      shannon_dest_address: "m.shannon_dest_address_id", balance_upokt: "m.recovered_balance_amount", is_admin: "m.is_admin" } },
];
// morse_lc: morse_addresses lowercased, as the indexer stores morse_src_address
const morseBranches = (s: string) =>
  keysetBranches(
    s,
    MORSE_COLUMNS,
    MORSE_BRANCHES.map((b) => ({
      table: b.table,
      head: `'${b.kind}', m.id`,
      cols: b.cols,
      filter: `(kinds IS NULL OR '${b.kind}' = ANY(kinds)) AND (morse_lc IS NULL OR m.morse_src_address = ANY(morse_lc))
       AND (shannon_addresses IS NULL OR ${b.shannon.map((c) => `m.${c} = ANY(shannon_addresses)`).join(" OR ")})`,
    }))
  );

// UNION ALL of one newest-first read per table, for get_actor_lifecycle and get_morse_claims: after head, the columns
// each branch fills by name (NULL::type for the others), its own filter, and the same height range and (height, id)
// keyset, written once here.
const keysetBranches = (
  s: string,
  columns: Record<string, string>,
  branches: { table: string; head: string; cols: Record<string, string>; filter: string }[]
) =>
  branches
    .map(
      (b) => `    (SELECT m.block_id, ${b.head},
            ${Object.entries(columns).map(([c, type]) => b.cols[c] ?? `NULL::${type}`).join(", ")}
     FROM ${s}.${b.table} m
     WHERE ${b.filter}
       AND m.block_id BETWEEN rg.lo AND rg.hi AND (m.block_id < bh OR m.block_id = bh AND m.id < before_id)
     ORDER BY m.block_id DESC, m.id DESC LIMIT row_limit)`
    )
    .join("\n    UNION ALL\n");
// the events each kind has
const LIFECYCLE_KINDS = [...new Set(LIFECYCLE_BRANCHES.map((b) => b.kind))];
const LIFECYCLE_KIND_EVENTS = LIFECYCLE_KINDS.map(
  (kind) => [kind, [...new Set(LIFECYCLE_BRANCHES.filter((b) => b.kind === kind).map((b) => b.event))]] as const
);
const lifecycleBranches = (s: string) =>
  keysetBranches(
    s,
    LIFECYCLE_COLUMNS,
    LIFECYCLE_BRANCHES.map((b) => ({
      table: b.table,
      head: `m.${b.actor}, '${b.event}', m.id`,
      cols: b.cols,
      filter: `kind = '${b.kind}' AND (events IS NULL OR '${b.event}' = ANY(events)) AND m.${b.actor} = ANY(ids)`,
    }))
  );

// operator_scope (get_supplier_fleet, get_claims, get_actor_lifecycle, get_supplier_penalties): now (default) = operators as _supplier_ids
// resolves them; ever = every supplier any version of whose service configs shared revenue with them
// (_operator_suppliers_ever), in any stake status, with all its rows. list = the function's own supplier list argument.
const OPERATOR_SCOPE_CHECK = `  IF operator_scope IS NULL OR operator_scope NOT IN ('now', 'ever') THEN
    RAISE EXCEPTION 'operator_scope is now or ever (has %)', operator_scope;
  END IF;
  IF operator_scope = 'ever' AND operators IS NULL THEN
    RAISE EXCEPTION 'operator_scope ever applies to operators';
  END IF;`;
const scopedSupplierIds = (s: string, list: string, requireOne: boolean, rs: string, re: string, pad = "  ", bucket = "NULL") =>
  [
    `IF operator_scope = 'ever' AND num_nonnulls(${list}, owners) = 0 THEN`,
    `  PERFORM ${s}._validate(operators, 'operators', ${rs}, ${re}, ${bucket});`,
    `  ids := ${s}._operator_suppliers_ever(operators);`,
    `ELSE`,
    `  ids := ${s}._supplier_ids(${list}, owners, operators, ${requireOne}, ${rs}, ${re}, ${bucket});`,
    `END IF;`,
  ].map((l) => pad + l).join("\n");

// get_service_usage: per service, the usage summed over the range of the _ranges record rg (rollup days and the edge
// heights), for the services filter keeps ($ = the table alias).
const serviceUsageSums = (s: string, rg: string, filter: string) =>
  `SELECT t.service_id, sum(t.claimed_upokt) claimed_upokt, sum(t.settled_upokt) settled_upokt, sum(t.relays) relays,
           sum(t.estimated_relays) estimated_relays, sum(t.claimed_compute_units) compute_units,
           sum(t.estimated_compute_units) estimated_compute_units
    FROM (
      SELECT d.service_id, d.claimed_upokt, d.settled_upokt, d.relays, d.estimated_relays, d.claimed_compute_units,
             d.estimated_compute_units
      FROM ${s}.daily_claims_by_application_service d WHERE d.day BETWEEN ${rg}.d1 AND ${rg}.d2 AND (${filter.replace(/\$/g, "d")})
      UNION ALL
      SELECT c.service_id, c.claimed_upokt, c.settled_upokt, c.relays, c.estimated_relays, c.claimed_compute_units,
             c.estimated_compute_units
      FROM ${s}.settlement_claims_by_application_service c
      WHERE (c.height BETWEEN ${rg}.lo1 AND ${rg}.hi1 OR c.height BETWEEN ${rg}.lo2 AND ${rg}.hi2) AND (${filter.replace(/\$/g, "c")})) t
    GROUP BY t.service_id`;

// get_service_usage: the Staked suppliers and applications configured for each service now, as
// services_performance_between_times counts them, for the services filter keeps ($ = the table alias).
const stakedCounts = (s: string, filter: string) =>
  `SELECT coalesce(su.service_id, ap.service_id) service_id, coalesce(su.n, 0) staked_suppliers, coalesce(ap.n, 0) staked_applications
    FROM (
      -- a semi join: the staked suppliers are few, a nested loop over every live config probed each one's history
      SELECT c.service_id, count(DISTINCT c.supplier_id) n FROM ${s}.supplier_service_configs c
      WHERE upper_inf(c._block_range) AND (${filter.replace(/\$/g, "c")})
        AND c.supplier_id IN (SELECT p.id FROM ${s}.suppliers p WHERE p.stake_status = 'Staked' AND upper_inf(p._block_range))
      GROUP BY 1) su
    FULL JOIN (
      SELECT a.service_id, count(DISTINCT a.application_id) n FROM ${s}.application_services a
      JOIN ${s}.applications p ON p.id = a.application_id AND p._block_range @> 9223372036854775807::bigint
      WHERE a._block_range @> 9223372036854775807::bigint AND p.stake_status = 'Staked' AND (${filter.replace(/\$/g, "a")})
      GROUP BY 1) ap ON ap.service_id = su.service_id`;

// get_service_usage's change, the rule of services_performance_between_times: 1 when the previous value is 0 or none.
const usageChange = (current: string, previous: string) =>
  `CASE WHEN ${previous} <> 0 THEN (coalesce(${current}, 0) - ${previous}) / ${previous} ELSE 1 END`;

export function createSettlementFunctionsFn(dbSchema: string): string {
  const s = dbSchema;
  // The endpoint root domains of a service config (alias a, of supplier_service_configs) as rows x: its domains array,
  // nothing when it is not one
  const configDomains = (a: string) =>
    `jsonb_array_elements_text(CASE WHEN jsonb_typeof(${a}.domains) = 'array' THEN ${a}.domains ELSE '[]'::jsonb END)`;
  // the domain keys of a config (alias a) as rows x: each distinct domain, and '' for a null or '' element or when it
  // has none, so every config has at least one; get_staked_domain_services' rows
  const domainKeys = (a: string) =>
    `(SELECT DISTINCT coalesce(e.x, '') x FROM (SELECT 1) z LEFT JOIN LATERAL ${configDomains(a)} e(x) ON true)`;
  // a config on the row of domain '' of get_staked_domain_services, and so in get_supplier_fleet's domain '': the same
  // keys (0.25-0.32 s over the live configs on mainnet, 2026-10-15, against 0.16 s for a length test that missed [null])
  const noDomain = (a: string) => `'' IN (SELECT k.x FROM ${domainKeys(a)} k)`;
  // get_claims' current_owner_id: the supplier's owner now, from its live version (LIMIT 1: a scalar subquery must not
  // fail)
  const currentOwner = (alias: string) =>
    `(SELECT su.owner_id FROM ${s}.suppliers su WHERE su.id = ${alias}.supplier_id AND upper_inf(su._block_range)
      LIMIT 1)`;
  // the reshaped helpers as SQL VALUES (name, signature or NULL): the DDL drops their other overloads
  const helperValues = Object.entries(HELPER_SIGNATURES)
    .map(([name, args]) => `('${name}', ${args === null ? "NULL" : `'${args}'`})`)
    .join(", ");
  // The start of every catalog function over the money tables, in one place so that none can skip it: the part of
  // the range the money tables cover (_coverage), no rows when nothing covered overlaps it, the data read from
  // covered_from on, and the span its rows report (sp, _span over cv's bounds; none for get_income and
  // get_supply_flows, which pass cv to _income / _supply_flows; blocks for the functions over the indexer's own
  // tables). Without a bucket a row's bucket_start is the requested range_start (covered_from with an open start). The rows then carry
  // cv.covered_from, cv.covered_to and cv.gaps, and every fill keeps to cv.covered.
  const covered = (span: "settled" | "blocks" | null, blocks = false) =>
    [
      "  -- what is not written is not read: the covered part of the range only (_coverage)",
      `  cv := ${s}._coverage(range_start, range_end${blocks ? ", true" : ""});`,
      "  IF cv.empty THEN RETURN; END IF;",
      "  range_start := cv.data_from;",
      // nothing past covered_to is read either (a rewind leaves rows above the progress until they are rewritten);
      // _ranges keeps an edge day in the rollups when it holds no settlement outside the range
      "  range_end := least(range_end, cv.covered_to);",
      ...(span
        ? [
            // _span from the bounds _coverage already read: settlements, or blocks for the indexer's tables
            span === "settled"
              ? `  sp := ${s}._span(range_start, range_end, cv.first_settled, cv.last_settled, cv.covered_to);`
              : // _coverage reads the block bounds only for p_blocks: a blocks span over the money tables reads them here
                [
                  ...(blocks
                    ? []
                    : [
                        `  SELECT bl.timestamp AT TIME ZONE 'UTC' INTO cv.first_block FROM ${s}.blocks bl ORDER BY bl.timestamp, bl.id LIMIT 1;`,
                        `  SELECT bl.timestamp AT TIME ZONE 'UTC' INTO cv.last_block FROM ${s}.blocks bl ORDER BY bl.timestamp DESC, bl.id DESC LIMIT 1;`,
                      ]),
                  `  sp := ${s}._span(range_start, range_end, cv.first_block, cv.last_block, cv.covered_to);`,
                ].join("\n"),
            "  IF bucket IS NULL THEN sp.f := coalesce(cv.requested_from, cv.covered_from); END IF;",
          ]
        : []),
    ].join("\n");
  // get_service_usage's rows (q): every bucket and service, with the fill rows; the same query with or without the
  // columns compare_start and with_details add
  const usageRows = `  WITH res0(bucket_start, bucket_end, service_id, claimed_upokt, settled_upokt, overservicing_loss_upokt, relays, estimated_relays, compute_units, estimated_compute_units, claims) AS (
  WITH r AS (
    SELECT d.day::timestamp AT TIME ZONE 'UTC' block_time, d.service_id, d.claimed_upokt, d.settled_upokt, d.overservicing_loss_upokt,
           d.relays, d.estimated_relays, d.claimed_compute_units, d.estimated_compute_units, d.claim_count claims
    FROM ${s}.daily_claims_by_application_service d WHERE (all_services OR d.service_id = ANY(services)) AND d.day BETWEEN rg.d1 AND rg.d2
    UNION ALL
    SELECT c.block_time, c.service_id, c.claimed_upokt, c.settled_upokt, c.overservicing_loss_upokt,
           c.relays, c.estimated_relays, c.claimed_compute_units, c.estimated_compute_units, c.claim_count
    FROM ${s}.settlement_claims_by_application_service c
    WHERE (all_services OR c.service_id = ANY(services)) AND (c.height BETWEEN rg.lo1 AND rg.hi1 OR c.height BETWEEN rg.lo2 AND rg.hi2)
  )
  SELECT ${s}._bucket(bucket, r.block_time, sp.f), ${s}._bucket_end(bucket, r.block_time, sp.t), CASE WHEN by_service THEN r.service_id ELSE 'all' END, sum(r.claimed_upokt)::numeric, sum(r.settled_upokt)::numeric,
         sum(r.overservicing_loss_upokt)::numeric, sum(r.relays)::numeric, sum(r.estimated_relays)::numeric,
         sum(r.claimed_compute_units)::numeric, sum(r.estimated_compute_units)::numeric, sum(r.claims)::bigint
  FROM r GROUP BY 1, 2, 3
  ), res(bucket_start, bucket_end, service_id, claimed_upokt, settled_upokt, overservicing_loss_upokt, relays, estimated_relays, compute_units, estimated_compute_units, claims) AS (
  -- every requested id gets its row or series, 0 where it had no activity (not in the sparse output)
  SELECT * FROM res0
  UNION ALL
  SELECT ${s}._bucket(bucket, fb, sp.f), ${s}._bucket_end(bucket, fb, sp.t), u.id, 0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::bigint
  FROM (SELECT DISTINCT unnest(services) id) u
  WHERE u.id IS NOT NULL AND fill_empty_buckets AND by_service AND fb IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM res0 r0 WHERE r0.service_id = u.id)
  UNION ALL
  -- the group total of a list with no activity at all: one zero row
  SELECT ${s}._bucket(bucket, fb, sp.f), ${s}._bucket_end(bucket, fb, sp.t), 'all', 0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::bigint
  WHERE fill_empty_buckets AND NOT by_service AND fb IS NOT NULL AND (all_services OR cardinality(services) > 0) AND NOT EXISTS (SELECT 1 FROM res0)
  )
  SELECT r.*, CASE WHEN top_by_settled IS NOT NULL THEN coalesce(row_offset, 0) + array_position(services, r.service_id) END, ranked FROM res r
  WHERE bucket IS NULL OR NOT fill_empty_buckets OR r.bucket_start <= sp.t_last
  UNION ALL
  SELECT b.bucket_start, b.bucket_end, k.service_id, CASE WHEN k.claimed_upokt_na THEN NULL ELSE 0 END, CASE WHEN k.settled_upokt_na THEN NULL ELSE 0 END, CASE WHEN k.overservicing_loss_upokt_na THEN NULL ELSE 0 END, CASE WHEN k.relays_na THEN NULL ELSE 0 END, CASE WHEN k.estimated_relays_na THEN NULL ELSE 0 END, CASE WHEN k.compute_units_na THEN NULL ELSE 0 END, CASE WHEN k.estimated_compute_units_na THEN NULL ELSE 0 END, CASE WHEN k.claims_na THEN NULL ELSE 0 END, CASE WHEN top_by_settled IS NOT NULL THEN coalesce(row_offset, 0) + array_position(services, k.service_id) END, ranked
  FROM ${s}._covered_buckets(bucket, sp.f, sp.t_last, cv.covered) b
  CROSS JOIN (SELECT r.service_id, bool_and(r.claimed_upokt IS NULL) claimed_upokt_na, bool_and(r.settled_upokt IS NULL) settled_upokt_na, bool_and(r.overservicing_loss_upokt IS NULL) overservicing_loss_upokt_na, bool_and(r.relays IS NULL) relays_na, bool_and(r.estimated_relays IS NULL) estimated_relays_na, bool_and(r.compute_units IS NULL) compute_units_na, bool_and(r.estimated_compute_units IS NULL) estimated_compute_units_na, bool_and(r.claims IS NULL) claims_na FROM res r GROUP BY r.service_id) k
  WHERE bucket IS NOT NULL AND fill_empty_buckets
    AND NOT EXISTS (SELECT 1 FROM res r WHERE r.bucket_start = b.bucket_start AND coalesce(r.service_id, chr(1)) = coalesce(k.service_id, chr(1)))`;
  return `
CREATE OR REPLACE FUNCTION ${s}._validate(p_list text[], p_name text, range_start timestamptz, range_end timestamptz, bucket text)
RETURNS void LANGUAGE plpgsql STABLE SET plan_cache_mode = force_custom_plan AS $$
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

-- The internal helpers this version reshaped: every overload but the current signature goes first (HELPER_SIGNATURES:
-- the full argument list, OUT columns included; NULL drops every overload).
DO $$
DECLARE f regprocedure;
BEGIN
  FOR f IN SELECT p.oid::regprocedure FROM pg_proc p
           JOIN (VALUES
    ${helperValues}) h(name, args) ON h.name = p.proname
           WHERE p.pronamespace = '${s}'::regnamespace AND pg_get_function_arguments(p.oid) IS DISTINCT FROM h.args LOOP
    EXECUTE format('DROP FUNCTION %s', f);
  END LOOP;
END $$;

-- What the money tables cover of [range_start, range_end): ONE covered set per call, which every catalog and legacy_*
-- function reads, for its rows, its fills and its range. No money event table is probed: money_progress says how far
-- the indexer's money step went, and settlement_gaps what it or the history job left unwritten (schema.ts).
-- The covered span ends at the earlier of range_end and the block at money_progress.height + 1 µs (half-open, like the
-- range; the latest indexed block when the blocks table does not have that block yet, its writes may lag): an active
-- POCKETDEX_MONEY_FROM_HEIGHT override freezes the progress, so the heights it skips are not covered, never zero.
-- It starts at the later of range_start and the block at money_progress.from_height (the first indexed block at or after
-- it when the blocks table lacks that block): the lowest height the money step processed, seeded once on a database
-- written before the table existed (schema.ts), and lowered by the history job as it walks (job.ts lowerGap). Nothing
-- else is inferred. No progress yet: nothing covered. The functions over the indexer's own tables (p_blocks) cover the
-- indexed blocks.
-- The gaps: each settlement_gaps row as the half-open time between the covered heights next to it, [the block before
-- its first height + 1 µs, the block after its last height), falling back to the written settlement on that side when
-- the blocks table lacks the block (NULL = unbounded); overlapping or contiguous gaps merge (range_agg).
-- covered = the span minus the gaps (a tstzmultirange); covered_from / covered_to are its bounds, both NULL when it is
-- empty (nothing covered: empty = true, nothing to read); gaps = the merged gaps that overlap the requested range, as
-- {from, to}, half-open. data_from is the range_start to read with: covered_from, so the data never sums heights that
-- were not written (the callers clip the end to covered_to too). A row without a bucket reports covered_from as its
-- bucket_start for an open range_start. first_settled /
-- last_settled are the span bounds of the money tables (_span, covered()), read once here; first_block / last_block
-- only for p_blocks, where they are the covered span (a blocks span over the money tables reads them itself, and the
-- end falls back to the latest block only when the progress block is missing).
-- Index probes only, and few gap rows (0.8 ms on the mainnet replica, 2026-10-06). jit = off: a settlement_gaps never
-- analyzed is planned at ~200 rows, past jit_above_cost, and JIT compiling took ~30 ms per call (measured locally).
CREATE OR REPLACE FUNCTION ${s}._coverage(range_start timestamptz, range_end timestamptz, p_blocks boolean DEFAULT false,
  OUT requested_from timestamptz, OUT covered_from timestamptz, OUT covered_to timestamptz, OUT gaps jsonb,
  OUT data_from timestamptz, OUT empty boolean, OUT covered tstzmultirange, OUT first_settled timestamptz,
  OUT last_settled timestamptz, OUT first_block timestamptz, OUT last_block timestamptz)
LANGUAGE plpgsql STABLE SET plan_cache_mode = force_custom_plan SET jit = off AS $$
DECLARE v_start timestamptz; v_end timestamptz; v_gaps tstzmultirange := '{}'; v_from_h bigint; v_progress bigint;
BEGIN
  requested_from := range_start; gaps := '[]'; covered := '{}'; data_from := range_start; empty := true;
  IF p_blocks THEN
    SELECT bl.timestamp AT TIME ZONE 'UTC' INTO last_block FROM ${s}.blocks bl ORDER BY bl.timestamp DESC, bl.id DESC LIMIT 1;
    SELECT bl.timestamp AT TIME ZONE 'UTC' INTO first_block FROM ${s}.blocks bl ORDER BY bl.timestamp, bl.id LIMIT 1;
    v_start := first_block;
    v_end := last_block + interval '1 microsecond';
  ELSE
    SELECT sb.block_time INTO first_settled FROM ${s}.settlement_blocks sb ORDER BY sb.height LIMIT 1;
    SELECT sb.block_time INTO last_settled FROM ${s}.settlement_blocks sb ORDER BY sb.height DESC LIMIT 1;
    SELECT mp.from_height, mp.height INTO v_from_h, v_progress FROM ${s}.money_progress mp;
    IF v_progress IS NOT NULL THEN
      v_end := coalesce((SELECT bl.timestamp AT TIME ZONE 'UTC' FROM ${s}.blocks bl WHERE bl.id = v_progress LIMIT 1),
                        (SELECT bl.timestamp AT TIME ZONE 'UTC' FROM ${s}.blocks bl
                         ORDER BY bl.timestamp DESC, bl.id DESC LIMIT 1)) + interval '1 microsecond';
      -- the block at from_height, or the first indexed one after it when the blocks table lacks it
      v_start := (SELECT bl.timestamp AT TIME ZONE 'UTC' FROM ${s}.blocks bl WHERE bl.id >= v_from_h ORDER BY bl.id LIMIT 1);
    END IF;
    SELECT coalesce(range_agg(tstzrange(g.f, g.t)), '{}') INTO v_gaps
    FROM (SELECT coalesce((SELECT bl.timestamp AT TIME ZONE 'UTC' FROM ${s}.blocks bl WHERE bl.id = gp.from_height - 1 LIMIT 1),
                          (SELECT sb.block_time FROM ${s}.settlement_blocks sb WHERE sb.height < gp.from_height
                           ORDER BY sb.height DESC LIMIT 1)) + interval '1 microsecond' f,
                 coalesce((SELECT bl.timestamp AT TIME ZONE 'UTC' FROM ${s}.blocks bl WHERE bl.id = gp.to_height + 1 LIMIT 1),
                          (SELECT sb.block_time FROM ${s}.settlement_blocks sb WHERE sb.height > gp.to_height
                           ORDER BY sb.height LIMIT 1)) t
          FROM ${s}.settlement_gaps gp) g
    WHERE g.f IS NULL OR g.t IS NULL OR g.f < g.t;
    SELECT coalesce(jsonb_agg(jsonb_build_object('from', lower(r), 'to', upper(r)) ORDER BY lower(r) NULLS FIRST), '[]') INTO gaps
    FROM unnest(v_gaps) r WHERE r && tstzrange(range_start, range_end);
  END IF;
  IF v_start IS NULL OR v_end IS NULL THEN RETURN; END IF;  -- nothing indexed, or no progress: nothing covered
  v_start := greatest(range_start, v_start);
  v_end := least(range_end, v_end);
  IF v_start < v_end THEN covered := tstzmultirange(tstzrange(v_start, v_end)) - v_gaps; END IF;
  empty := isempty(covered);
  IF NOT empty THEN
    covered_from := lower(covered); covered_to := upper(covered);
    data_from := covered_from;
  END IF;
END $$;

-- THE range object, for every _json twin and legacy_* function: what was asked, what the answer covers, the gaps
-- (half-open) and whether requested_to / covered_to are inclusive (legacy_*, end_date's sense) or exclusive (the
-- catalog, range_end's sense).
CREATE OR REPLACE FUNCTION ${s}._range_of(requested_from timestamptz, requested_to timestamptz, covered_from timestamptz,
  covered_to timestamptz, gaps jsonb, end_inclusive boolean)
RETURNS json LANGUAGE sql IMMUTABLE AS $$
  SELECT json_build_object('requested_from', requested_from, 'requested_to', requested_to, 'covered_from', covered_from,
    'covered_to', covered_to, 'gaps', gaps, 'end_inclusive', end_inclusive)
$$;

-- The catalog's range of an empty answer (a twin reads it from the rows otherwise).
CREATE OR REPLACE FUNCTION ${s}._range_json(range_start timestamptz, range_end timestamptz, p_blocks boolean DEFAULT false)
RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT ${s}._range_of(range_start, range_end, c.covered_from, c.covered_to, c.gaps, false)::jsonb
  FROM ${s}._coverage(range_start, range_end, p_blocks) c
$$;

-- covered_from / covered_to / covered_gaps were added to the rows of the catalog functions: a return type CREATE OR REPLACE cannot
-- change, so a database written before has its old functions dropped first (their _json twins are rebuilt below).
DO $$
DECLARE f regprocedure;
BEGIN
  FOR f IN SELECT p.oid::regprocedure FROM pg_proc p
           WHERE p.pronamespace = '${s}'::regnamespace AND p.proname = ANY(${CATALOG_SQL}) AND p.proretset
             AND pg_get_function_result(p.oid) NOT LIKE '%covered_gaps%' LOOP
    EXECUTE format('DROP FUNCTION %s', f);
  END LOOP;
END $$;

-- first_settled_height / last_settled_height came later to get_supplier_earnings's rows: a return type CREATE OR REPLACE
-- cannot change, so a database written before has its old one dropped first (the _json twin is rebuilt below).
DO $$
DECLARE f regprocedure;
BEGIN
  FOR f IN SELECT p.oid::regprocedure FROM pg_proc p
           WHERE p.pronamespace = '${s}'::regnamespace AND p.proname = 'get_supplier_earnings'
             AND pg_get_function_result(p.oid) NOT LIKE '%last_settled_height%' LOOP
    EXECUTE format('DROP FUNCTION %s', f);
  END LOOP;
END $$;

-- first_settled_height / last_settled_height came later to get_application_spend's and get_gateway_spend's rows, likewise.
DO $$
DECLARE f regprocedure;
BEGIN
  FOR f IN SELECT p.oid::regprocedure FROM pg_proc p
           WHERE p.pronamespace = '${s}'::regnamespace AND p.proname IN ('get_application_spend', 'get_gateway_spend')
             AND pg_get_function_result(p.oid) NOT LIKE '%last_settled_height%' LOOP
    EXECUTE format('DROP FUNCTION %s', f);
  END LOOP;
END $$;

-- operators came last to the supplier functions: CREATE OR REPLACE with it leaves the signature without it next to the
-- new one, and two overloads make every call ambiguous, so a database written before has the old one dropped first.
DO $$
DECLARE f regprocedure;
BEGIN
  FOR f IN SELECT p.oid::regprocedure FROM pg_proc p
           WHERE p.pronamespace = '${s}'::regnamespace
             AND p.proname IN ('get_supplier_earnings', 'get_supplier_distribution', 'get_supplier_penalties', 'get_supplier_proofs')
             AND NOT ('operators' = ANY(coalesce(p.proargnames, '{}'))) LOOP
    EXECUTE format('DROP FUNCTION %s', f);
  END LOOP;
END $$;

-- operator_scope came last to get_supplier_fleet, get_claims, get_actor_lifecycle and get_supplier_penalties, and gateway_id to the rows of
-- get_actor_lifecycle: likewise, a database written by an earlier build of them has those dropped first (their _json
-- twins are rebuilt below).
DO $$
DECLARE f regprocedure;
BEGIN
  FOR f IN SELECT p.oid::regprocedure FROM pg_proc p
           WHERE p.pronamespace = '${s}'::regnamespace
             AND p.proname IN ('get_supplier_fleet', 'get_claims', 'get_actor_lifecycle', 'get_supplier_penalties')
             AND (NOT ('operator_scope' = ANY(coalesce(p.proargnames, '{}')))
                  OR p.proname = 'get_actor_lifecycle' AND NOT ('gateway_id' = ANY(coalesce(p.proargnames, '{}')))) LOOP
    EXECUTE format('DROP FUNCTION %s', f);
  END LOOP;
END $$;

-- Arguments added last, or columns added to the rows (CREATE OR REPLACE cannot change those either), after the ones
-- above: likewise, a function without its newest one is dropped first. One row per function, newest name last.
DO $$
DECLARE f regprocedure;
BEGIN
  FOR f IN SELECT p.oid::regprocedure FROM pg_proc p
           JOIN (VALUES ('get_supplier_earnings', 'gateway_ids')
                      , ('get_created_claims', 'from_session_end_height')
                      , ('get_created_claims_count', 'beyond_tip')
                      , ('get_service_summary', 'owners')
                      , ('get_height_at', 'beyond_tip')
                      , ('get_claims', 'current_owner_id')
                      , ('get_supplier_fleet', 'row_offset')
                      , ('get_application_fleet', 'row_offset')
                      , ('get_gateway_delegations', 'height')
                      , ('get_staked_suppliers', 'at_height')
                      , ('get_block_supplies', 'hash')
                      , ('get_relay_mining_difficulty', 'row_offset')
                      , ('get_service_usage', 'search_text')
                      , ('get_supplier_distribution', 'by_service')
                ) n(name, arg) ON n.name = p.proname
           WHERE p.pronamespace = '${s}'::regnamespace AND NOT (n.arg = ANY(coalesce(p.proargnames, '{}'))) LOOP
    EXECUTE format('DROP FUNCTION %s', f);
  END LOOP;
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
-- "closed day"), and an edge day that holds no written settlement outside the range: its rollup sums exactly the range's
-- part of it (two index probes; a range clipped to what is covered keeps its first and last day in the rollups).
-- Base = heights in [lo1, hi1] and [lo2, hi2] (the edges). p_no_rollup, or the GUC
-- money.no_rollup = on, sends everything to the base tables.
CREATE OR REPLACE FUNCTION ${s}._ranges(range_start timestamptz, range_end timestamptz, bucket text, p_no_rollup boolean DEFAULT false,
  OUT d1 date, OUT d2 date, OUT lo1 bigint, OUT hi1 bigint, OUT lo2 bigint, OUT hi2 bigint)
LANGUAGE plpgsql STABLE SET plan_cache_mode = force_custom_plan AS $$
DECLARE f timestamptz := coalesce(range_start, '-infinity'); t timestamptz := coalesce(range_end, 'infinity');
BEGIN
  IF bucket IS DISTINCT FROM 'hour' AND NOT p_no_rollup AND coalesce(current_setting('money.no_rollup', true), 'off') <> 'on' THEN
    d1 := CASE WHEN range_start IS NULL THEN (SELECT min(day) FROM ${s}.settlement_blocks)
               WHEN range_start = ((range_start AT TIME ZONE 'UTC')::date::timestamp AT TIME ZONE 'UTC') THEN (range_start AT TIME ZONE 'UTC')::date
               ELSE (range_start AT TIME ZONE 'UTC')::date + 1 END;
    d2 := CASE WHEN range_end IS NULL THEN (SELECT max(day) FROM ${s}.settlement_blocks)
               ELSE (range_end AT TIME ZONE 'UTC')::date - 1 END;
    IF range_start IS NOT NULL AND d1 > (range_start AT TIME ZONE 'UTC')::date
       AND NOT EXISTS (SELECT 1 FROM ${s}.settlement_blocks sb
                       WHERE sb.block_time >= ((range_start AT TIME ZONE 'UTC')::date::timestamp AT TIME ZONE 'UTC')
                         AND sb.block_time < range_start) THEN
      d1 := (range_start AT TIME ZONE 'UTC')::date;
    END IF;
    IF range_end IS NOT NULL AND range_end > ((d2 + 1)::timestamp AT TIME ZONE 'UTC')
       AND NOT EXISTS (SELECT 1 FROM ${s}.settlement_blocks sb
                       WHERE sb.block_time >= range_end AND sb.block_time < ((d2 + 2)::timestamp AT TIME ZONE 'UTC')) THEN
      d2 := d2 + 1;
    END IF;
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

-- The span a call answers for, from bounds _coverage already read (no probe of its own): f = range_start, or p_first
-- for an open start (the callers set it to the requested start, or covered_from); t = the end of what is covered
-- (p_covered_to), or range_end / p_last without one (the legacy_ callers). Every row carries them as bucket_start /
-- bucket_end when there is no bucket, so a caller sees what was summed, and bucket_end equals covered_to. t_last is the last instant a series lists buckets for: the end of what is covered
-- (p_covered_to, exclusive), so a covered bucket with nothing in it is a zero and one that is not covered is absent.
-- Without bounds (the legacy_ callers, which pass both ends and fill nothing) it is range_end.
CREATE OR REPLACE FUNCTION ${s}._span(range_start timestamptz, range_end timestamptz, p_first timestamptz,
  p_last timestamptz, p_covered_to timestamptz, OUT f timestamptz, OUT t timestamptz, OUT t_last timestamptz)
LANGUAGE sql IMMUTABLE AS $$
  SELECT coalesce(range_start, p_first), coalesce(p_covered_to, range_end, p_last),
         least(range_end, p_covered_to) - interval '1 microsecond'
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

-- The buckets a zero fill may use (fill_empty_buckets): the buckets of the span that intersect the covered set
-- (_coverage: NULL = no limit), so no bucket that lies wholly before, after or inside a gap of what is covered reads as
-- zero. _first_bucket is where the zero row of a requested id with no activity goes: the first of them (the span's start
-- without a bucket). Every fill goes through these two.
CREATE OR REPLACE FUNCTION ${s}._covered_buckets(bucket text, span_first timestamptz, span_last timestamptz,
  covered tstzmultirange, OUT bucket_start timestamptz, OUT bucket_end timestamptz)
RETURNS SETOF record LANGUAGE sql STABLE AS $$
  SELECT b.bucket_start, b.bucket_end FROM ${s}._buckets(bucket, span_first, span_last) b
  WHERE covered IS NULL OR covered && tstzrange(b.bucket_start, b.bucket_end)
$$;
CREATE OR REPLACE FUNCTION ${s}._first_bucket(bucket text, span_first timestamptz, span_last timestamptz,
  covered tstzmultirange)
RETURNS timestamptz LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN bucket IS NULL THEN span_first
              ELSE (SELECT min(b.bucket_start) FROM ${s}._covered_buckets(bucket, span_first, span_last, covered) b) END
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

-- The highest height the money tables wrote (settlement_blocks: a height with settlement events, which may have no
-- settled claim) at or below money_progress.height, and its block time: the one-row money_progress and a probe of the
-- settlement_blocks primary key. It moves forward when a new settlement is written, so a client can poll it and refetch
-- only when it changes. A history fill or gap repair below it does not move it, nor does covered_to advancing with the
-- blocks. After a rewind of the money step it goes back to the highest written height at or below the progress, and
-- forward again as the step rewrites those heights. Until the first height is written, or while money_progress has no
-- row, height and block_time are NULL: not set-returning, so SQL gets one row of NULLs, not an empty result, and
-- GraphQL gets getLastSettlement null (subql-query 2.22.2, measured 2026-10-14).
CREATE OR REPLACE FUNCTION ${s}.get_last_settlement(OUT height bigint, OUT block_time timestamptz)
LANGUAGE sql STABLE AS $$
  -- not past money_progress, as the catalog: a rewound money step leaves its rows above the progress until it
  -- rewrites them
  SELECT sb.height, sb.block_time FROM ${s}.settlement_blocks sb
  WHERE sb.height <= (SELECT mp.height FROM ${s}.money_progress mp)
  ORDER BY sb.height DESC LIMIT 1
$$;

-- The last indexed block at or before a time: its height and block time, for a caller that has a time and needs the
-- height to ask the chain or the entity tables about (blocks.timestamp is UTC without time zone; one probe of
-- idx_blocks_timestamp_id). height and block_time are NULL when no indexed block is that early. A time after the newest
-- indexed block answers that block with beyond_tip true: the indexer has not reached it, so a later block may still
-- come at or before it. A time inside a stretch with no indexed block answers the last block before it. Not
-- set-returning, like get_last_settlement. PL/pgSQL: a SQL body would need the blocks table to exist when it is created.
CREATE OR REPLACE FUNCTION ${s}.get_height_at(at_time timestamptz, OUT height bigint, OUT block_time timestamptz,
  OUT beyond_tip boolean)
LANGUAGE plpgsql STABLE SET plan_cache_mode = force_custom_plan AS $$
BEGIN
  IF at_time IS NULL THEN
    RAISE EXCEPTION 'at_time is required: a timestamptz with an explicit zone (2026-10-01T00:00:00Z)';
  END IF;
  SELECT bl.id::bigint, bl.timestamp AT TIME ZONE 'UTC' INTO height, block_time FROM ${s}.blocks bl
  WHERE bl.timestamp <= (at_time AT TIME ZONE 'UTC') ORDER BY bl.timestamp DESC, bl.id DESC LIMIT 1;
  IF height IS NOT NULL THEN
    -- after the newest block's time; at it the answer is final (block times only increase)
    beyond_tip := NOT EXISTS (SELECT 1 FROM ${s}.blocks bl WHERE bl.timestamp >= (at_time AT TIME ZONE 'UTC'));
  END IF;
END $$;

-- Accounts active since each of since_times (up to 20): live upokt balances whose last update is in a block at or after
-- the time, as pnf-explorer's /accounts counted them (newest block before the time, then last_updated_block_id above
-- it). height = that newest block before the time (NULL before the first one); beyond_tip = no indexed block at or
-- after the time yet, and accounts is then NULL (not known). One pass over the live rows (16,868 on mainnet,
-- 2026-10-14) through balances_block_range_upper_idx: ~0.05-0.15 s for three times, where a count per time over
-- idx_balances_block_id read every version since then (3.7 s for 90 days).
CREATE OR REPLACE FUNCTION ${s}.get_active_accounts(since_times timestamptz[])
RETURNS TABLE(since_time timestamptz, height bigint, beyond_tip boolean, accounts bigint)
LANGUAGE plpgsql STABLE SET plan_cache_mode = force_custom_plan AS $$
BEGIN
  IF since_times IS NULL OR cardinality(since_times) < 1 OR cardinality(since_times) > 20 OR array_position(since_times, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'since_times must have between 1 and 20 times, none NULL (has %)', coalesce(cardinality(since_times), 0);
  END IF;
  RETURN QUERY
  WITH t AS (
    SELECT DISTINCT u.ts FROM unnest(since_times) u(ts)
  ), h AS (
    SELECT t.ts, (SELECT bl.id FROM ${s}.blocks bl WHERE bl.timestamp < (t.ts AT TIME ZONE 'UTC')
                  ORDER BY bl.timestamp DESC, bl.id DESC LIMIT 1) hh,
           NOT EXISTS (SELECT 1 FROM ${s}.blocks bl WHERE bl.timestamp >= (t.ts AT TIME ZONE 'UTC')) beyond
    FROM t
  ), b AS MATERIALIZED (
    SELECT bal.last_updated_block_id lu FROM ${s}.balances bal
    WHERE upper(bal._block_range) IS NULL AND upper_inf(bal._block_range) AND bal.denom = 'upokt'
  )
  SELECT h.ts, h.hh::bigint, h.beyond,
         CASE WHEN NOT h.beyond THEN (SELECT count(*) FROM b WHERE b.lu > coalesce(h.hh, -1)) END
  FROM h ORDER BY 1;
END $$;

-- The supply of each denomination at a block (the indexer's block_supplies rows of that height and their supplies):
-- what a block page read in two requests, block_supplies then supplies by id. The block by height or by hash (exactly
-- one; blocks.hash through its GiST index), so a page that has only the hash reads it beside the block row. Index
-- probes only (1 ms by hash on mainnet, 2026-10-15); no row for a block the indexer has no supply for.
CREATE OR REPLACE FUNCTION ${s}.get_block_supplies(height bigint DEFAULT NULL, hash text DEFAULT NULL)
RETURNS TABLE(denom text, amount numeric)
LANGUAGE plpgsql STABLE SET plan_cache_mode = force_custom_plan AS $$
DECLARE h bigint;
BEGIN
  h := ${s}._block_height_of(get_block_supplies.height, get_block_supplies.hash);
  RETURN QUERY
  SELECT sp.denom::text, sp.amount::numeric FROM ${s}.block_supplies bs
  JOIN ${s}.supplies sp ON sp.id = bs.supply_id AND upper_inf(sp._block_range)
  WHERE bs.block_id = h AND upper_inf(bs._block_range)
  ORDER BY 1;
END $$;

-- A block's metadata record (the CometBFT block id, header and last commit the indexer received), by height or by
-- hash, as get_block_supplies, so a block page reads its extras beside the block row (0.1-0.3 ms on mainnet).
CREATE OR REPLACE FUNCTION ${s}.get_block_metadata(height bigint DEFAULT NULL, hash text DEFAULT NULL)
RETURNS TABLE(block_height bigint, header jsonb, last_commit jsonb, block_id jsonb)
LANGUAGE plpgsql STABLE SET plan_cache_mode = force_custom_plan AS $$
DECLARE h bigint;
BEGIN
  h := ${s}._block_height_of(get_block_metadata.height, get_block_metadata.hash);
  RETURN QUERY
  SELECT m.id::bigint, m.header, m.last_commit, m.block_id FROM ${s}.block_metadata m
  WHERE m.id = h AND upper_inf(m._block_range)
  LIMIT 1;
END $$;

-- The height of a block given by height or by hash (exactly one; the hash in any case, with or without 0x, spaces
-- around it trimmed; blocks.hash is uppercase hex): NULL when no indexed block has that hash.
CREATE OR REPLACE FUNCTION ${s}._block_height_of(height bigint, hash text) RETURNS bigint
LANGUAGE plpgsql STABLE SET plan_cache_mode = force_custom_plan AS $$
DECLARE h bigint;
BEGIN
  IF num_nonnulls(height, hash) <> 1 THEN
    RAISE EXCEPTION 'pass height or hash (exactly one)';
  END IF;
  IF height IS NOT NULL THEN RETURN height; END IF;
  SELECT b.id::bigint INTO h FROM ${s}.blocks b
  WHERE b.hash = upper(regexp_replace(btrim(_block_height_of.hash), '^0x', '', 'i')) LIMIT 1;
  RETURN h;
END $$;

-- Written settlement heights in [range_start, range_end), the settlement heights the chain has there (distinct
-- event_claim_settleds.block_id) that settlement_blocks lacks, and the settlement_gaps rows in the range
-- ('from-to'). The distinct block ids come from a loose index scan: one index probe per settlement height,
-- not one row per claim.
CREATE OR REPLACE FUNCTION ${s}.money_coverage(range_start timestamptz, range_end timestamptz)
RETURNS TABLE(first_height bigint, last_height bigint, first_block_time timestamptz, last_block_time timestamptz,
  settlements bigint, missing_heights bigint[], gaps text[], covered_from timestamptz,
  covered_to timestamptz, covered_gaps jsonb)
LANGUAGE plpgsql STABLE SET plan_cache_mode = force_custom_plan AS $$
DECLARE rg record; cv record;
BEGIN
  PERFORM ${s}._validate(NULL, '', range_start, range_end, NULL);
  -- the coverage report itself reads any range (_coverage gives the columns)
  cv := ${s}._coverage(range_start, range_end);
  rg := ${s}._block_heights(range_start, range_end);
  RETURN QUERY SELECT q.*, cv.covered_from, cv.covered_to, cv.gaps FROM (
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
        WHERE (range_start IS NULL OR sb.block_time >= range_start) AND (range_end IS NULL OR sb.block_time < range_end)) c
  ) q;
END $$;

-- Application: what it paid
CREATE OR REPLACE FUNCTION ${s}.get_application_spend(applications text[], range_start timestamptz, range_end timestamptz,
  bucket text DEFAULT NULL, by_service boolean DEFAULT false, by_supplier boolean DEFAULT false, by_application boolean DEFAULT true,
  fill_empty_buckets boolean DEFAULT false)
RETURNS TABLE(bucket_start timestamptz, bucket_end timestamptz, application_id text, service_id text, supplier_id text,
  burned_upokt numeric, overserviced_unpaid_upokt numeric, reimbursed_upokt numeric,
  relays numeric, estimated_relays numeric, compute_units numeric, estimated_compute_units numeric, claims bigint,
  first_settled_height bigint, last_settled_height bigint, covered_from timestamptz, covered_to timestamptz, covered_gaps jsonb)
LANGUAGE plpgsql STABLE SET enable_mergejoin = off SET plan_cache_mode = force_custom_plan AS $$
DECLARE rg record; sp record; cv record; fb timestamptz; nb date[];
BEGIN
  PERFORM ${s}._validate(applications, 'applications', range_start, range_end, bucket);
${covered("settled")}
  rg := ${s}._ranges(range_start, range_end, bucket);
  -- the rollup days with a height whose first_height / last_height the rollups may not hold (settlement_blocks.bounds_rollup):
  -- a row of those reads as NULL height, and so does each group it is in, as in get_supplier_earnings
  nb := ARRAY(SELECT DISTINCT sb.day FROM ${s}.settlement_blocks sb WHERE NOT sb.bounds_rollup AND sb.day BETWEEN rg.d1 AND rg.d2);
  fb := CASE WHEN fill_empty_buckets THEN ${s}._first_bucket(bucket, sp.f, sp.t_last, cv.covered) END;
  RETURN QUERY SELECT q.*, cv.covered_from, cv.covered_to, cv.gaps FROM (
  WITH res0(bucket_start, bucket_end, application_id, service_id, supplier_id, burned_upokt, overserviced_unpaid_upokt, reimbursed_upokt, relays, estimated_relays, compute_units, estimated_compute_units, claims, first_settled_height, last_settled_height) AS (
  WITH r AS (
    SELECT d.day::timestamp AT TIME ZONE 'UTC' block_time, d.application_id, d.service_id, ''::text supplier_id, d.settled_upokt,
           d.overservicing_loss_upokt, d.global_minted_upokt, d.relays, d.estimated_relays, d.claimed_compute_units, d.estimated_compute_units,
           d.claim_count claims, CASE WHEN d.day <> ALL(nb) THEN d.first_height END fh,
           CASE WHEN d.day <> ALL(nb) THEN d.last_height END lh
    FROM ${s}.daily_claims_by_application_service d
    WHERE NOT by_supplier AND d.application_id = ANY(applications) AND d.day BETWEEN rg.d1 AND rg.d2
    UNION ALL
    SELECT d.day::timestamp AT TIME ZONE 'UTC', d.application_id, d.service_id, d.supplier_id, d.settled_upokt, d.overservicing_loss_upokt,
           d.global_minted_upokt, d.relays, d.estimated_relays, d.claimed_compute_units, d.estimated_compute_units, d.claim_count,
           CASE WHEN d.day <> ALL(nb) THEN d.first_height END, CASE WHEN d.day <> ALL(nb) THEN d.last_height END
    FROM ${s}.daily_claims_by_supplier_application_service d
    WHERE by_supplier AND d.application_id = ANY(applications) AND d.day BETWEEN rg.d1 AND rg.d2
    UNION ALL
    SELECT c.block_time, c.application_id, c.service_id, '', c.settled_upokt, c.overservicing_loss_upokt,
           c.global_minted_upokt, c.relays, c.estimated_relays, c.claimed_compute_units, c.estimated_compute_units, c.claim_count,
           c.height, c.height
    FROM ${s}.settlement_claims_by_application_service c
    WHERE NOT by_supplier AND c.application_id = ANY(applications) AND (c.height BETWEEN rg.lo1 AND rg.hi1 OR c.height BETWEEN rg.lo2 AND rg.hi2)
    UNION ALL
    SELECT c.block_time, c.application_id, c.service_id, c.supplier_id, c.settled_upokt, c.overservicing_loss_upokt,
           c.global_minted_upokt, c.relays, c.estimated_relays, c.claimed_compute_units, c.estimated_compute_units, 1::bigint,
           c.height, c.height
    FROM ${s}.claim_settlements c
    WHERE by_supplier AND c.application_id = ANY(applications) AND (c.height BETWEEN rg.lo1 AND rg.hi1 OR c.height BETWEEN rg.lo2 AND rg.hi2)
  )
  SELECT ${s}._bucket(bucket, r.block_time, sp.f), ${s}._bucket_end(bucket, r.block_time, sp.t), CASE WHEN by_application THEN r.application_id ELSE 'all' END,
         CASE WHEN by_service THEN r.service_id ELSE 'all' END, CASE WHEN by_supplier THEN r.supplier_id ELSE 'all' END,
         sum(r.settled_upokt)::numeric, sum(r.overservicing_loss_upokt)::numeric, sum(r.global_minted_upokt)::numeric,
         sum(r.relays)::numeric, sum(r.estimated_relays)::numeric, sum(r.claimed_compute_units)::numeric,
         sum(r.estimated_compute_units)::numeric, sum(r.claims)::bigint,
         -- a height only when every row of the group holds its bounds
         CASE WHEN bool_and(r.fh IS NOT NULL) THEN min(r.fh) END, CASE WHEN bool_and(r.lh IS NOT NULL) THEN max(r.lh) END
  FROM r GROUP BY 1, 2, 3, 4, 5
  ), res(bucket_start, bucket_end, application_id, service_id, supplier_id, burned_upokt, overserviced_unpaid_upokt, reimbursed_upokt, relays, estimated_relays, compute_units, estimated_compute_units, claims, first_settled_height, last_settled_height) AS (
  -- every requested id gets its row or series, 0 where it had no activity (not in the sparse output)
  SELECT * FROM res0
  UNION ALL
  SELECT ${s}._bucket(bucket, fb, sp.f), ${s}._bucket_end(bucket, fb, sp.t), u.id, 'all', 'all', 0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::bigint, NULL::bigint, NULL::bigint
  FROM (SELECT DISTINCT unnest(applications) id) u
  WHERE u.id IS NOT NULL AND fill_empty_buckets AND by_application AND fb IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM res0 r0 WHERE r0.application_id = u.id)
  UNION ALL
  -- the group total of a list with no activity at all: one zero row
  SELECT ${s}._bucket(bucket, fb, sp.f), ${s}._bucket_end(bucket, fb, sp.t), 'all', 'all', 'all', 0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::bigint, NULL::bigint, NULL::bigint
  WHERE fill_empty_buckets AND NOT by_application AND fb IS NOT NULL AND cardinality(applications) > 0 AND NOT EXISTS (SELECT 1 FROM res0)
  )
  SELECT r.* FROM res r WHERE bucket IS NULL OR NOT fill_empty_buckets OR r.bucket_start <= sp.t_last
  UNION ALL
  SELECT b.bucket_start, b.bucket_end, k.application_id, k.service_id, k.supplier_id, CASE WHEN k.burned_upokt_na THEN NULL ELSE 0 END, CASE WHEN k.overserviced_unpaid_upokt_na THEN NULL ELSE 0 END, CASE WHEN k.reimbursed_upokt_na THEN NULL ELSE 0 END, CASE WHEN k.relays_na THEN NULL ELSE 0 END, CASE WHEN k.estimated_relays_na THEN NULL ELSE 0 END, CASE WHEN k.compute_units_na THEN NULL ELSE 0 END, CASE WHEN k.estimated_compute_units_na THEN NULL ELSE 0 END, CASE WHEN k.claims_na THEN NULL ELSE 0 END, NULL::bigint, NULL::bigint
  FROM ${s}._covered_buckets(bucket, sp.f, sp.t_last, cv.covered) b
  CROSS JOIN (SELECT r.application_id, r.service_id, r.supplier_id, bool_and(r.burned_upokt IS NULL) burned_upokt_na, bool_and(r.overserviced_unpaid_upokt IS NULL) overserviced_unpaid_upokt_na, bool_and(r.reimbursed_upokt IS NULL) reimbursed_upokt_na, bool_and(r.relays IS NULL) relays_na, bool_and(r.estimated_relays IS NULL) estimated_relays_na, bool_and(r.compute_units IS NULL) compute_units_na, bool_and(r.estimated_compute_units IS NULL) estimated_compute_units_na, bool_and(r.claims IS NULL) claims_na FROM res r GROUP BY r.application_id, r.service_id, r.supplier_id) k
  WHERE bucket IS NOT NULL AND fill_empty_buckets
    AND NOT EXISTS (SELECT 1 FROM res r WHERE r.bucket_start = b.bucket_start AND coalesce(r.application_id, chr(1)) = coalesce(k.application_id, chr(1)) AND coalesce(r.service_id, chr(1)) = coalesce(k.service_id, chr(1)) AND coalesce(r.supplier_id, chr(1)) = coalesce(k.supplier_id, chr(1)))
  ) q ORDER BY 1 DESC, 3, 4, 5;
END $$;

-- Gateway: what the applications delegated to it spent, by the delegation in force at each settlement
-- height. Delegations are the ApplicationGateway entity history: _block_range = [delegated, undelegated).
CREATE OR REPLACE FUNCTION ${s}.get_gateway_spend(gateways text[], range_start timestamptz, range_end timestamptz,
  bucket text DEFAULT NULL, by_application boolean DEFAULT false, by_service boolean DEFAULT false, by_gateway boolean DEFAULT true,
  fill_empty_buckets boolean DEFAULT false)
RETURNS TABLE(bucket_start timestamptz, bucket_end timestamptz, gateway_id text, application_id text, service_id text,
  burned_upokt numeric, overserviced_unpaid_upokt numeric, reimbursed_upokt numeric,
  relays numeric, estimated_relays numeric, compute_units numeric, estimated_compute_units numeric, claims bigint,
  first_settled_height bigint, last_settled_height bigint, covered_from timestamptz, covered_to timestamptz, covered_gaps jsonb)
LANGUAGE plpgsql STABLE SET enable_mergejoin = off SET plan_cache_mode = force_custom_plan AS $$
DECLARE rg record; sp record; cv record; fb timestamptz; nb date[];
BEGIN
  PERFORM ${s}._validate(gateways, 'gateways', range_start, range_end, bucket);
${covered("settled")}
  rg := ${s}._ranges(range_start, range_end, bucket);
  -- the rollup days with a height whose first_height / last_height the rollups may not hold (settlement_blocks.bounds_rollup):
  -- a row of those reads as NULL height, and so does each group it is in, as in get_supplier_earnings
  nb := ARRAY(SELECT DISTINCT sb.day FROM ${s}.settlement_blocks sb WHERE NOT sb.bounds_rollup AND sb.day BETWEEN rg.d1 AND rg.d2);
  fb := CASE WHEN fill_empty_buckets THEN ${s}._first_bucket(bucket, sp.f, sp.t_last, cv.covered) END;
  RETURN QUERY SELECT q.*, cv.covered_from, cv.covered_to, cv.gaps FROM (
  WITH res0(bucket_start, bucket_end, gateway_id, application_id, service_id, burned_upokt, overserviced_unpaid_upokt, reimbursed_upokt, relays, estimated_relays, compute_units, estimated_compute_units, claims, first_settled_height, last_settled_height) AS (
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
           dc.estimated_compute_units, dc.claim_count claims, CASE WHEN dc.day <> ALL(nb) THEN dc.first_height END fh,
           CASE WHEN dc.day <> ALL(nb) THEN dc.last_height END lh
    FROM iv JOIN days d ON iv.from_height <= d.lo AND (iv.to_height IS NULL OR iv.to_height > d.hi)
    JOIN ${s}.daily_claims_by_application_service dc ON dc.application_id = iv.application_id AND dc.day = d.day
    UNION ALL
    -- rollup days it covers in part (usually none): the claims of those (application, day) pairs by index
    SELECT c.block_time, iv.gateway_id, c.application_id, c.service_id, c.settled_upokt, c.overservicing_loss_upokt, c.global_minted_upokt,
           c.relays, c.estimated_relays, c.claimed_compute_units, c.estimated_compute_units, c.claim_count, c.height, c.height
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
           c.relays, c.estimated_relays, c.claimed_compute_units, c.estimated_compute_units, c.claim_count, c.height, c.height
    FROM iv JOIN ${s}.settlement_claims_by_application_service c ON c.application_id = iv.application_id
         AND c.height >= iv.from_height AND (iv.to_height IS NULL OR c.height < iv.to_height)
    WHERE (c.height BETWEEN rg.lo1 AND rg.hi1 OR c.height BETWEEN rg.lo2 AND rg.hi2)
  )
  SELECT ${s}._bucket(bucket, x.block_time, sp.f), ${s}._bucket_end(bucket, x.block_time, sp.t), CASE WHEN by_gateway THEN x.gw ELSE 'all' END, CASE WHEN by_application THEN x.application_id ELSE 'all' END,
         CASE WHEN by_service THEN x.service_id ELSE 'all' END,
         sum(x.settled_upokt)::numeric, sum(x.overservicing_loss_upokt)::numeric, sum(x.global_minted_upokt)::numeric,
         sum(x.relays)::numeric, sum(x.estimated_relays)::numeric, sum(x.claimed_compute_units)::numeric,
         sum(x.estimated_compute_units)::numeric, sum(x.claims)::bigint,
         -- a height only when every row of the group holds its bounds
         CASE WHEN bool_and(x.fh IS NOT NULL) THEN min(x.fh) END, CASE WHEN bool_and(x.lh IS NOT NULL) THEN max(x.lh) END
  FROM x GROUP BY 1, 2, 3, 4, 5
  ), res(bucket_start, bucket_end, gateway_id, application_id, service_id, burned_upokt, overserviced_unpaid_upokt, reimbursed_upokt, relays, estimated_relays, compute_units, estimated_compute_units, claims, first_settled_height, last_settled_height) AS (
  -- every requested id gets its row or series, 0 where it had no activity (not in the sparse output)
  SELECT * FROM res0
  UNION ALL
  SELECT ${s}._bucket(bucket, fb, sp.f), ${s}._bucket_end(bucket, fb, sp.t), u.id, 'all', 'all', 0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::bigint, NULL::bigint, NULL::bigint
  FROM (SELECT DISTINCT unnest(gateways) id) u
  WHERE u.id IS NOT NULL AND fill_empty_buckets AND by_gateway AND fb IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM res0 r0 WHERE r0.gateway_id = u.id)
  UNION ALL
  -- the group total of a list with no activity at all: one zero row
  SELECT ${s}._bucket(bucket, fb, sp.f), ${s}._bucket_end(bucket, fb, sp.t), 'all', 'all', 'all', 0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::bigint, NULL::bigint, NULL::bigint
  WHERE fill_empty_buckets AND NOT by_gateway AND fb IS NOT NULL AND cardinality(gateways) > 0 AND NOT EXISTS (SELECT 1 FROM res0)
  )
  SELECT r.* FROM res r WHERE bucket IS NULL OR NOT fill_empty_buckets OR r.bucket_start <= sp.t_last
  UNION ALL
  SELECT b.bucket_start, b.bucket_end, k.gateway_id, k.application_id, k.service_id, CASE WHEN k.burned_upokt_na THEN NULL ELSE 0 END, CASE WHEN k.overserviced_unpaid_upokt_na THEN NULL ELSE 0 END, CASE WHEN k.reimbursed_upokt_na THEN NULL ELSE 0 END, CASE WHEN k.relays_na THEN NULL ELSE 0 END, CASE WHEN k.estimated_relays_na THEN NULL ELSE 0 END, CASE WHEN k.compute_units_na THEN NULL ELSE 0 END, CASE WHEN k.estimated_compute_units_na THEN NULL ELSE 0 END, CASE WHEN k.claims_na THEN NULL ELSE 0 END, NULL::bigint, NULL::bigint
  FROM ${s}._covered_buckets(bucket, sp.f, sp.t_last, cv.covered) b
  CROSS JOIN (SELECT r.gateway_id, r.application_id, r.service_id, bool_and(r.burned_upokt IS NULL) burned_upokt_na, bool_and(r.overserviced_unpaid_upokt IS NULL) overserviced_unpaid_upokt_na, bool_and(r.reimbursed_upokt IS NULL) reimbursed_upokt_na, bool_and(r.relays IS NULL) relays_na, bool_and(r.estimated_relays IS NULL) estimated_relays_na, bool_and(r.compute_units IS NULL) compute_units_na, bool_and(r.estimated_compute_units IS NULL) estimated_compute_units_na, bool_and(r.claims IS NULL) claims_na FROM res r GROUP BY r.gateway_id, r.application_id, r.service_id) k
  WHERE bucket IS NOT NULL AND fill_empty_buckets
    AND NOT EXISTS (SELECT 1 FROM res r WHERE r.bucket_start = b.bucket_start AND coalesce(r.gateway_id, chr(1)) = coalesce(k.gateway_id, chr(1)) AND coalesce(r.application_id, chr(1)) = coalesce(k.application_id, chr(1)) AND coalesce(r.service_id, chr(1)) = coalesce(k.service_id, chr(1)))
  ) q ORDER BY 1 DESC, 3, 4, 5;
END $$;

-- The suppliers that share revenue with the addresses now: a live service config lists one of them in its rev_share,
-- and the supplier is Staked now (get_claim_proofs_data_by_delegators_and_time's matched_suppliers); no cap. Containment
-- per address, so the partial GIN idx_ssc_live_rev_share serves it: an operator's 1055 suppliers in 0.13 s on mainnet
-- (2026-10-08), where jsonb_array_elements over every live config took 1 s. PL/pgSQL: a SQL body would need the entity
-- tables to exist when it is created.
CREATE OR REPLACE FUNCTION ${s}._operator_suppliers(addresses text[]) RETURNS text[]
LANGUAGE plpgsql STABLE SET plan_cache_mode = force_custom_plan AS $$
BEGIN
  RETURN ARRAY(
    SELECT m.supplier_id
    FROM (SELECT DISTINCT ssc.supplier_id FROM unnest(addresses) a
          JOIN ${s}.supplier_service_configs ssc
            ON ssc.rev_share @> jsonb_build_array(jsonb_build_object('address', a)) AND upper_inf(ssc._block_range)) m
    WHERE EXISTS (SELECT 1 FROM ${s}.suppliers su WHERE su.id = m.supplier_id AND su.stake_status = 'Staked'
                    AND su._block_range @> 9223372036854775807::bigint)
    ORDER BY m.supplier_id);
END $$;

-- The suppliers that shared revenue with the addresses at any time: any version of a service config, live or closed,
-- lists one of them in its rev_share; any stake status, no cap (operator_scope ever). Used by operator_scope ever in
-- get_supplier_fleet, get_claims, get_actor_lifecycle and get_supplier_penalties. It reads the (wallet, supplier) pairs
-- of supplier_rev_share_wallets (revShareWallets.ts), one primary key range per address (23 ms for nodefleet's 7 wallets
-- and their 4,092 suppliers, mainnet replica 2026-10-15), once it covers every height
-- (supplier_rev_share_wallets_coverage: set at genesis, or after the backfill). Before that, the config versions
-- themselves, with the same pairs (both skip empty versions): SubQuery's GIN on rev_share
-- (jsonb_ops) serves the containment, but every stake writes a new version of the configs it lists, so a large operator
-- matches ~980k versions read from the heap, ~12 s for the 7 largest operators on mainnet (2026-10-14).
CREATE OR REPLACE FUNCTION ${s}._operator_suppliers_ever(addresses text[]) RETURNS text[]
LANGUAGE plpgsql STABLE SET plan_cache_mode = force_custom_plan AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM ${s}.supplier_rev_share_wallets_coverage) THEN
    RETURN ARRAY(
      SELECT DISTINCT w.supplier_id FROM ${s}.supplier_rev_share_wallets w WHERE w.wallet_address = ANY(addresses)
      ORDER BY 1);
  END IF;
  RETURN ARRAY(
    SELECT DISTINCT ssc.supplier_id FROM unnest(addresses) a
    JOIN ${s}.supplier_service_configs ssc ON ssc.rev_share @> jsonb_build_array(jsonb_build_object('address', a))
      -- the versions the table's pairs come from: an empty one was created and closed in one block
      AND NOT isempty(ssc._block_range)
    ORDER BY 1);
END $$;

-- The suppliers a supplier function answers for, from its three lists, of which it takes at most one: suppliers as given
-- (up to 200), owners (the suppliers each owns now, no cap) or operators (_operator_suppliers, no cap). NULL = every
-- supplier, which p_require_one refuses (get_supplier_distribution needs one of the lists).
CREATE OR REPLACE FUNCTION ${s}._supplier_ids(suppliers text[], owners text[], operators text[], p_require_one boolean,
  range_start timestamptz, range_end timestamptz, bucket text) RETURNS text[]
LANGUAGE plpgsql STABLE SET plan_cache_mode = force_custom_plan AS $$
BEGIN
  IF num_nonnulls(suppliers, owners, operators) > 1 OR (p_require_one AND num_nonnulls(suppliers, owners, operators) = 0) THEN
    RAISE EXCEPTION 'pass one of suppliers, owners (the suppliers they own now) or operators (the suppliers that share revenue with them now)';
  END IF;
  IF owners IS NOT NULL THEN
    PERFORM ${s}._validate(owners, 'owners', range_start, range_end, bucket);
    RETURN ARRAY(SELECT DISTINCT su.id FROM ${s}.suppliers su
                 WHERE su.owner_id = ANY(owners) AND su._block_range @> 9223372036854775807::bigint);
  END IF;
  IF operators IS NOT NULL THEN
    PERFORM ${s}._validate(operators, 'operators', range_start, range_end, bucket);
    RETURN ${s}._operator_suppliers(operators);
  END IF;
  PERFORM ${s}._validate(suppliers, CASE WHEN suppliers IS NULL THEN '' ELSE 'suppliers' END, range_start, range_end, bucket);
  RETURN suppliers;
END $$;

-- A fleet now: the suppliers of one list (_supplier_ids: suppliers, owners or operators; or domains: the suppliers with
-- a live service config whose endpoints are on one of them, any stake status), or every supplier when none is given,
-- their current version only, optionally kept to those with a live config for one of services, and to some stake
-- statuses. by_supplier: one row per supplier (its owner,
-- status, stake and the services it has a live config for), largest stake first, then by id; false: one row for the whole
-- fleet ('all' in supplier_id and stake_status, NULL owner and service_count), zeros when it is empty. The fleet row
-- leaves service_count out: nodefleet.net's 2,351 Staked suppliers have 98,510 live configs, and counting their
-- services took 158 ms of the call (mainnet replica, 2026-10-13).
-- Replaces the relation filter suppliers(serviceConfigs some revShare contains) with aggregates, and
-- get_supplier_stats_by_domains (domains, Staked, by_supplier false). Live rows through the partial indexes
-- idx_suppliers_live_id, idx_ssc_live_domains and idx_ssc_live_rev_share.
-- max_stake_upokt keeps the stakes below it (a below-minimum list). With services, each row also carries
-- service_domains: the endpoint root domains of its live configs for those services. row_limit (up to 1000) pages by
-- keyset on (stake_upokt descending, supplier_id) with after_stake_upokt / after_supplier_id, and counts services for
-- that page only: a page of 100 of the 4,548 Staked suppliers in 34 ms on mainnet, where every row takes 0.17-0.23 s
-- (2026-10-14). NULL = every row, as before. row_offset skips that many rows of the order first, so a page at any depth
-- counts services for its own rows only.
CREATE OR REPLACE FUNCTION ${s}.get_supplier_fleet(suppliers text[] DEFAULT NULL, owners text[] DEFAULT NULL,
  operators text[] DEFAULT NULL, domains text[] DEFAULT NULL, services text[] DEFAULT NULL,
  stake_statuses text[] DEFAULT NULL, by_supplier boolean DEFAULT true, operator_scope text DEFAULT 'now',
  max_stake_upokt numeric DEFAULT NULL, row_limit integer DEFAULT NULL, after_stake_upokt numeric DEFAULT NULL,
  after_supplier_id text DEFAULT NULL, row_offset integer DEFAULT 0)
RETURNS TABLE(supplier_id text, owner_id text, stake_status text, stake_upokt numeric, service_count bigint,
  supplier_count bigint, service_domains text[])
LANGUAGE plpgsql STABLE SET plan_cache_mode = force_custom_plan AS $$
DECLARE ids text[]; sids text[];
BEGIN
  IF stake_statuses IS NOT NULL AND NOT stake_statuses <@ ARRAY['Staked', 'Unstaking', 'Unstaked'] THEN
    RAISE EXCEPTION 'stake_statuses takes Staked, Unstaking and Unstaked (has %)', stake_statuses;
  END IF;
  IF row_limit < 1 OR row_limit > 1000 THEN
    RAISE EXCEPTION 'row_limit must be between 1 and 1000, or NULL for every row (has %)', row_limit;
  END IF;
  IF row_offset IS NULL OR row_offset < 0 THEN
    RAISE EXCEPTION 'row_offset must be 0 or more (has %)', row_offset;
  END IF;
  IF (after_stake_upokt IS NULL) <> (after_supplier_id IS NULL) OR (after_supplier_id IS NOT NULL AND row_limit IS NULL) THEN
    RAISE EXCEPTION 'pass both after_stake_upokt and after_supplier_id (the last row of the previous page) with row_limit, or neither';
  END IF;
${OPERATOR_SCOPE_CHECK}
  IF domains IS NOT NULL THEN
    IF num_nonnulls(suppliers, owners, operators) > 0 THEN
      RAISE EXCEPTION 'pass one of suppliers, owners (the suppliers they own now), operators (the suppliers that share revenue with them now) or domains (the suppliers with a live endpoint on them)';
    END IF;
    PERFORM ${s}._validate(domains, 'domains', NULL, NULL, NULL);
    IF services IS NULL THEN
      ids := ARRAY(SELECT DISTINCT c.supplier_id FROM ${s}.supplier_service_configs c
                   WHERE c.domains ?| get_supplier_fleet.domains AND upper_inf(c._block_range));
      -- domain '' = a live config with no domain, the '' row of get_staked_domain_services (no index on it: 0.25-0.32 s
      -- over the live configs on mainnet, none of which has no domain, 2026-10-15)
      IF '' = ANY(get_supplier_fleet.domains) THEN
        ids := ids || ARRAY(SELECT DISTINCT c.supplier_id FROM ${s}.supplier_service_configs c
                            WHERE upper_inf(c._block_range) AND ${noDomain("c")});
      END IF;
    ELSE
      PERFORM ${s}._validate(services, 'services', NULL, NULL, NULL);
      -- with services, ONE live config for one of the services with an endpoint on one of the domains (not a domain on
      -- one config and the service on another): the services' live configs through idx_ssc_live_service, then their
      -- domains; the fence keeps the planner off the all-versions GIN on domains (0.11 s against 0.38 s for
      -- nodefleet.net eth+base on mainnet, 2026-10-14)
      ids := ARRAY(SELECT DISTINCT x.supplier_id
                   FROM (SELECT c.supplier_id, c.domains FROM ${s}.supplier_service_configs c
                         WHERE c.service_id = ANY(get_supplier_fleet.services) AND upper_inf(c._block_range) OFFSET 0) x
                   WHERE x.domains ?| get_supplier_fleet.domains
                      OR '' = ANY(get_supplier_fleet.domains) AND ${noDomain("x")});
    END IF;
  ELSE
${scopedSupplierIds(s, "suppliers", false, "NULL", "NULL", "    ")}
  END IF;
  -- with domains, ids already holds only suppliers with a config for one of services
  IF services IS NOT NULL AND domains IS NULL THEN
    PERFORM ${s}._validate(services, 'services', NULL, NULL, NULL);
    -- idx_ssc_live_service
    sids := ARRAY(SELECT DISTINCT c.supplier_id FROM ${s}.supplier_service_configs c
                  WHERE c.service_id = ANY(get_supplier_fleet.services) AND upper_inf(c._block_range));
  END IF;
  RETURN QUERY
  WITH f AS (
    SELECT su.id, su.owner_id, su.stake_status::text st, su.stake_amount::numeric stake_amount
    FROM ${s}.suppliers su
    WHERE upper_inf(su._block_range) AND (ids IS NULL OR su.id = ANY(ids)) AND (sids IS NULL OR su.id = ANY(sids))
      AND (stake_statuses IS NULL OR su.stake_status::text = ANY(stake_statuses))
      AND (max_stake_upokt IS NULL OR su.stake_amount < max_stake_upokt)
  ), p AS (
    -- the rows of this call: every supplier, or one keyset page
    SELECT f.* FROM f
    WHERE by_supplier AND (after_supplier_id IS NULL OR f.stake_amount < after_stake_upokt
                           OR f.stake_amount = after_stake_upokt AND f.id > after_supplier_id)
    ORDER BY f.stake_amount DESC, f.id LIMIT row_limit OFFSET row_offset
  ), sv AS (
    SELECT c.supplier_id, c.service_id, c.domains FROM ${s}.supplier_service_configs c
    WHERE upper_inf(c._block_range) AND c.supplier_id IN (SELECT p.id FROM p)
  ), per AS (
    SELECT sv.supplier_id, count(DISTINCT sv.service_id) n FROM sv GROUP BY 1
  ), dom AS (
    -- grouped once: an array subquery per row would scan sv once per supplier (25 s for the 4,379 suppliers of one
    -- service)
    SELECT sv.supplier_id, array_agg(DISTINCT e.x ORDER BY e.x) d
    FROM sv, ${configDomains("sv")} e(x)
    WHERE services IS NOT NULL AND sv.service_id = ANY(get_supplier_fleet.services)
    GROUP BY 1
  )
  SELECT p.id, p.owner_id, p.st, p.stake_amount, coalesce(per.n, 0), 1::bigint,
         CASE WHEN services IS NOT NULL THEN coalesce(dom.d, '{}'::text[]) END
  FROM p LEFT JOIN per ON per.supplier_id = p.id LEFT JOIN dom ON dom.supplier_id = p.id
  UNION ALL
  SELECT 'all', NULL, 'all', coalesce((SELECT sum(f.stake_amount) FROM f), 0), NULL, (SELECT count(*) FROM f), NULL
  WHERE NOT by_supplier
  ORDER BY 4 DESC, 1;
END $$;

-- Per service now: the suppliers with a live config for it (staked_suppliers: of those, the Staked ones) and the
-- applications with a live service row for it (staked_applications likewise); services NULL = every service with a
-- live config or application. Live configs through idx_ssc_live_service; applications through the GiST indexes on
-- _block_range (332 live of 2.46M versions on mainnet, 2026-10-13).
-- And its relay mining difficulty now: the newest update of the service (its relays EMA, target hash and height),
-- which get_relay_mining_difficulty lists one by one (the Service entity's own difficulty columns are not written).
-- SubQuery's GiST on (service_id, _block_range) cannot order: it read every update of every service (1.06M) and took
-- 2.2 s for the 174 live services (mainnet replica, 2026-10-14); idx_rmd_service_block reads one per service.
-- owners keeps the services those addresses own now (the Service entity's owner_id). Every live service has its row,
-- zeros when it has no supplier config or application now.
CREATE OR REPLACE FUNCTION ${s}.get_service_summary(services text[] DEFAULT NULL, owners text[] DEFAULT NULL)
RETURNS TABLE(service_id text, staked_suppliers bigint, suppliers bigint, staked_applications bigint,
  applications bigint, num_relays_ema numeric, target_hash_hex text, difficulty_updated_height bigint)
LANGUAGE plpgsql STABLE SET plan_cache_mode = force_custom_plan AS $$
BEGIN
  IF services IS NOT NULL THEN PERFORM ${s}._validate(services, 'services', NULL, NULL, NULL); END IF;
  IF owners IS NOT NULL THEN
    PERFORM ${s}._validate(owners, 'owners', NULL, NULL, NULL);
    -- the services they own now (269 live Service rows on mainnet, 2026-10-14), among services when both are given
    services := ARRAY(SELECT sv.id FROM ${s}.services sv WHERE sv.owner_id = ANY(owners) AND upper_inf(sv._block_range)
                        AND (get_service_summary.services IS NULL OR sv.id = ANY(get_service_summary.services)));
  END IF;
  RETURN QUERY
  WITH sc AS (
    SELECT c.service_id, count(DISTINCT c.supplier_id) FILTER (WHERE su.stake_status::text = 'Staked') staked,
           count(DISTINCT c.supplier_id) n
    FROM ${s}.supplier_service_configs c
    LEFT JOIN ${s}.suppliers su ON su.id = c.supplier_id AND upper_inf(su._block_range)
    WHERE upper_inf(c._block_range) AND (services IS NULL OR c.service_id = ANY(services))
    GROUP BY 1
  ), ac AS (
    SELECT a.service_id, count(DISTINCT a.application_id) FILTER (WHERE ap.stake_status::text = 'Staked') staked,
           count(DISTINCT a.application_id) n
    FROM ${s}.application_services a
    LEFT JOIN ${s}.applications ap ON ap.id = a.application_id AND ap._block_range @> 9223372036854775807::bigint
    WHERE a._block_range @> 9223372036854775807::bigint AND (services IS NULL OR a.service_id = ANY(services))
    GROUP BY 1
  ), os AS (
    -- the live Service rows (those of services, which owners has resolved, or all): a service with no supplier config
    -- or application now has its row of zeros (83 of 269 on mainnet, 2026-10-15)
    SELECT sv.id service_id FROM ${s}.services sv
    WHERE upper_inf(sv._block_range) AND (get_service_summary.services IS NULL OR sv.id = ANY(get_service_summary.services))
  )
  SELECT coalesce(sc.service_id, ac.service_id, os.service_id), coalesce(sc.staked, 0), coalesce(sc.n, 0), coalesce(ac.staked, 0),
         coalesce(ac.n, 0), d.new_num_relays_ema::numeric, d.new_target_hash_hex_encoded::text, d.block_id::bigint
  FROM sc FULL JOIN ac ON ac.service_id = sc.service_id
  FULL JOIN os ON os.service_id = coalesce(sc.service_id, ac.service_id)
  -- the newest difficulty update of the service (idx_rmd_service_block)
  LEFT JOIN LATERAL (
    SELECT e.new_num_relays_ema, e.new_target_hash_hex_encoded, e.block_id FROM ${s}.event_relay_mining_difficulty_updateds e
    WHERE e.service_id = coalesce(sc.service_id, ac.service_id, os.service_id) ORDER BY e.block_id DESC LIMIT 1
  ) d ON true
  ORDER BY 1;
END $$;

-- Applications now, like get_supplier_fleet: their current version, kept to the applications listed (up to 200), to
-- those with a live service row for one of services and to those delegating to one of gateways now (all combined; none
-- = every application), and to some stake statuses. by_application: one row each (status, stake, how many services and
-- gateways it has now), largest stake first; false: one row for all ('all' in application_id and stake_status, NULL
-- counts). row_limit (up to 1000; NULL = every row) and row_offset return one page of that order, counted for its own
-- rows only.
CREATE OR REPLACE FUNCTION ${s}.get_application_fleet(applications text[] DEFAULT NULL, services text[] DEFAULT NULL,
  gateways text[] DEFAULT NULL, stake_statuses text[] DEFAULT NULL, by_application boolean DEFAULT true,
  row_limit integer DEFAULT NULL, row_offset integer DEFAULT 0)
RETURNS TABLE(application_id text, stake_status text, stake_upokt numeric, service_count bigint, gateway_count bigint,
  application_count bigint)
LANGUAGE plpgsql STABLE SET plan_cache_mode = force_custom_plan AS $$
BEGIN
  IF stake_statuses IS NOT NULL AND NOT stake_statuses <@ ARRAY['Staked', 'Unstaking', 'Unstaked'] THEN
    RAISE EXCEPTION 'stake_statuses takes Staked, Unstaking and Unstaked (has %)', stake_statuses;
  END IF;
  IF row_limit < 1 OR row_limit > 1000 THEN
    RAISE EXCEPTION 'row_limit must be between 1 and 1000, or NULL for every row (has %)', row_limit;
  END IF;
  IF row_offset IS NULL OR row_offset < 0 THEN
    RAISE EXCEPTION 'row_offset must be 0 or more (has %)', row_offset;
  END IF;
  IF applications IS NOT NULL THEN PERFORM ${s}._validate(applications, 'applications', NULL, NULL, NULL); END IF;
  IF services IS NOT NULL THEN PERFORM ${s}._validate(services, 'services', NULL, NULL, NULL); END IF;
  IF gateways IS NOT NULL THEN PERFORM ${s}._validate(gateways, 'gateways', NULL, NULL, NULL); END IF;
  RETURN QUERY
  WITH f AS (
    SELECT ap.id, ap.stake_status::text st, ap.stake_amount
    FROM ${s}.applications ap
    WHERE ap._block_range @> 9223372036854775807::bigint
      AND (get_application_fleet.applications IS NULL OR ap.id = ANY(get_application_fleet.applications))
      AND (stake_statuses IS NULL OR ap.stake_status::text = ANY(stake_statuses))
      AND (services IS NULL OR EXISTS (SELECT 1 FROM ${s}.application_services a WHERE a.application_id = ap.id
             AND a.service_id = ANY(services) AND a._block_range @> 9223372036854775807::bigint))
      AND (gateways IS NULL OR EXISTS (SELECT 1 FROM ${s}.application_gateways g WHERE g.application_id = ap.id
             AND g.gateway_id = ANY(gateways) AND g._block_range @> 9223372036854775807::bigint))
  ), p AS (
    -- the rows of this call, in order, before their counts: every application, or one page (row_limit, row_offset)
    SELECT f.* FROM f WHERE by_application ORDER BY f.stake_amount DESC, f.id LIMIT row_limit OFFSET row_offset
  )
  SELECT p.id, p.st, p.stake_amount,
         (SELECT count(DISTINCT a.service_id) FROM ${s}.application_services a
          WHERE a.application_id = p.id AND a._block_range @> 9223372036854775807::bigint),
         (SELECT count(DISTINCT g.gateway_id) FROM ${s}.application_gateways g
          WHERE g.application_id = p.id AND g._block_range @> 9223372036854775807::bigint), 1::bigint
  FROM p
  UNION ALL
  SELECT 'all', 'all', coalesce((SELECT sum(f.stake_amount) FROM f), 0), NULL, NULL, (SELECT count(*) FROM f)
  WHERE NOT by_application
  ORDER BY 3 DESC, 1;
END $$;

-- Gateways now, like get_application_fleet: their current version, kept to the gateways listed (up to 200; none = every
-- gateway) and to some stake statuses. by_gateway: one row each, with delegated_applications (the applications that
-- delegate to it now: live application_gateways rows, whatever the application's status) and the delegate and
-- undelegate messages it ever received (a re-delegation counts again; a delegation in the genesis state has no message
-- and is not counted: mainnet has none, 411 delegation rows for 411 messages, 2026-10-14), largest stake first; false: one row for all
-- ('all' in gateway_id and stake_status), the stakes and counts summed. Small tables (18 gateway versions, 411
-- delegations and no undelegation on mainnet, 2026-10-14): SubQuery's GiST indexes by gateway_id serve them.
CREATE OR REPLACE FUNCTION ${s}.get_gateway_fleet(gateways text[] DEFAULT NULL, stake_statuses text[] DEFAULT NULL,
  by_gateway boolean DEFAULT true)
RETURNS TABLE(gateway_id text, stake_status text, stake_upokt numeric, delegated_applications bigint,
  delegations_ever bigint, undelegations_ever bigint, gateway_count bigint)
LANGUAGE plpgsql STABLE SET plan_cache_mode = force_custom_plan AS $$
BEGIN
  IF stake_statuses IS NOT NULL AND NOT stake_statuses <@ ARRAY['Staked', 'Unstaking', 'Unstaked'] THEN
    RAISE EXCEPTION 'stake_statuses takes Staked, Unstaking and Unstaked (has %)', stake_statuses;
  END IF;
  IF gateways IS NOT NULL THEN PERFORM ${s}._validate(gateways, 'gateways', NULL, NULL, NULL); END IF;
  RETURN QUERY
  WITH f AS (
    SELECT g.id, g.stake_status::text st, g.stake_amount::numeric amount,
           (SELECT count(*) FROM ${s}.application_gateways ag
            WHERE ag.gateway_id = g.id AND ag._block_range @> 9223372036854775807::bigint) delegated,
           (SELECT count(*) FROM ${s}.msg_delegate_to_gateways m WHERE m.gateway_id = g.id) delegations,
           (SELECT count(*) FROM ${s}.msg_undelegate_from_gateways m WHERE m.gateway_id = g.id) undelegations
    FROM ${s}.gateways g
    WHERE g._block_range @> 9223372036854775807::bigint
      AND (get_gateway_fleet.gateways IS NULL OR g.id = ANY(get_gateway_fleet.gateways))
      AND (stake_statuses IS NULL OR g.stake_status::text = ANY(stake_statuses))
  )
  SELECT f.id, f.st, f.amount, f.delegated, f.delegations, f.undelegations, 1::bigint FROM f WHERE by_gateway
  UNION ALL
  SELECT 'all', 'all', coalesce((SELECT sum(f.amount) FROM f), 0), coalesce((SELECT sum(f.delegated) FROM f), 0)::bigint,
         coalesce((SELECT sum(f.delegations) FROM f), 0)::bigint, coalesce((SELECT sum(f.undelegations) FROM f), 0)::bigint,
         (SELECT count(*) FROM f)
  WHERE NOT by_gateway
  ORDER BY 3 DESC, 1;
END $$;

-- Gateways and the applications delegating to them at a height (at_height NULL = the last height the indexer processed,
-- _metadata.lastProcessedHeight; every row carries the height read): each gateway's stake and status,
-- and each delegated application's stake, status and services, all as of that height (the version of each row whose
-- _block_range holds it). One row per (gateway, application); a gateway with no delegation at the height has one row
-- with NULL application columns, and a gateway with no version at the height (not staked yet) none. Keyset paging on
-- (gateway_id, application_id). An application has many versions (16.5k for one, 1.35M for the 151 that delegate to
-- the largest gateway on mainnet, 2026-10-14): the one at the height comes from the GiST on (account_id, _block_range),
-- account_id being the application's own address like id (equal in all 2,499,720 versions on mainnet, counted
-- 2026-10-14; applications.ts sets both to the address): 46 ms for those 151 now, 7 ms at height 700,000 (mainnet
-- replica).
CREATE OR REPLACE FUNCTION ${s}.get_gateway_delegations(gateways text[], at_height bigint DEFAULT NULL,
  row_limit integer DEFAULT 1000, after_gateway_id text DEFAULT NULL, after_application_id text DEFAULT NULL)
RETURNS TABLE(gateway_id text, gateway_stake_upokt numeric, gateway_stake_status text, application_id text,
  stake_upokt numeric, stake_status text, service_ids text[], height bigint)
LANGUAGE plpgsql STABLE SET plan_cache_mode = force_custom_plan AS $$
DECLARE h bigint;
BEGIN
  PERFORM ${s}._validate(gateways, 'gateways', NULL, NULL, NULL);
  IF row_limit IS NULL OR row_limit < 1 OR row_limit > 1000 THEN
    RAISE EXCEPTION 'row_limit must be between 1 and 1000 (has %); page with after_gateway_id / after_application_id', row_limit;
  END IF;
  IF after_application_id IS NOT NULL AND after_gateway_id IS NULL THEN
    RAISE EXCEPTION 'after_application_id goes with after_gateway_id (the last row of the previous page)';
  END IF;
  IF at_height < 1 THEN
    RAISE EXCEPTION 'at_height must be a block height (has %)', at_height;
  END IF;
  -- now = the last height the indexer finished (_metadata.lastProcessedHeight, a jsonb number), not the live rows: a
  -- block being written is not read, and the caller gets the height to pass on later pages
  h := at_height;
  IF h IS NULL THEN
    SELECT (m.value #>> '{}')::bigint INTO h FROM ${s}._metadata m WHERE m.key = 'lastProcessedHeight';
  END IF;
  IF h IS NULL THEN
    RAISE EXCEPTION 'no lastProcessedHeight in _metadata: pass at_height';
  END IF;
  RETURN QUERY
  SELECT g.id, g.stake_amount::numeric, g.stake_status::text, d.application_id, a.stake_amount::numeric,
         a.stake_status::text,
         CASE WHEN d.application_id IS NOT NULL THEN ARRAY(
           SELECT DISTINCT sv.service_id FROM ${s}.application_services sv
           WHERE sv.application_id = d.application_id AND sv._block_range @> h ORDER BY 1) END, h
  FROM ${s}.gateways g
  LEFT JOIN ${s}.application_gateways d ON d.gateway_id = g.id AND d._block_range @> h
  LEFT JOIN LATERAL (
    SELECT ap.stake_amount, ap.stake_status FROM ${s}.applications ap
    WHERE ap.account_id = d.application_id AND ap.id = d.application_id AND ap._block_range @> h
  ) a ON true
  WHERE g.id = ANY(get_gateway_delegations.gateways) AND g._block_range @> h
    -- a page ending on a gateway's row with no application (after_application_id NULL) goes on with the next gateway
    AND (after_gateway_id IS NULL OR g.id >= after_gateway_id)
    AND (after_gateway_id IS NULL OR g.id > after_gateway_id OR d.application_id > after_application_id)
  ORDER BY 1, 4 LIMIT row_limit;
END $$;

-- Relay mining difficulty history: each update of the services listed (up to 200), newest first (by height, then
-- service), with the relays EMA and the target hash before and after it; the newest row of a service is its current
-- difficulty (the Service entity's own difficulty columns are not written: mainnet 2026-10-13). Keyset paging on (height, service_id), like get_claims. Covers the indexed blocks. Each service's
-- updates through the GiST index on (service_id, _block_range); 1.06M updates on mainnet (2026-10-13).
-- row_offset skips that many rows of the order first (each service reads row_limit + row_offset of its newest), for a
-- page past the first 1000 in one call; up to 10,000,000 (the busiest service has 20,957 updates on mainnet,
-- 2026-10-15: an offset past every row gives an empty page, an offset of 20,000 costs 6 ms).
CREATE OR REPLACE FUNCTION ${s}.get_relay_mining_difficulty(services text[], range_start timestamptz,
  range_end timestamptz, row_limit integer DEFAULT 100, before_height bigint DEFAULT NULL,
  before_service_id text DEFAULT NULL, row_offset integer DEFAULT 0)
RETURNS TABLE(height bigint, block_time timestamptz, service_id text, prev_num_relays_ema numeric,
  new_num_relays_ema numeric, prev_target_hash_hex text, new_target_hash_hex text, covered_from timestamptz,
  covered_to timestamptz, covered_gaps jsonb)
LANGUAGE plpgsql STABLE SET plan_cache_mode = force_custom_plan AS $$
DECLARE cv record; rg record; bh numeric;
BEGIN
  PERFORM ${s}._validate(services, 'services', range_start, range_end, NULL);
  IF row_limit IS NULL OR row_limit < 1 OR row_limit > 1000 THEN
    RAISE EXCEPTION 'row_limit must be between 1 and 1000 (has %); page with before_height / before_service_id', row_limit;
  END IF;
  IF row_offset IS NULL OR row_offset < 0 OR row_offset > 10000000 THEN
    RAISE EXCEPTION 'row_offset must be between 0 and 10000000 (has %)', row_offset;
  END IF;
  IF (before_height IS NULL) <> (before_service_id IS NULL) THEN
    RAISE EXCEPTION 'pass both before_height and before_service_id (the last row of the previous page), or neither';
  END IF;
${covered(null, true)}
  rg := ${s}._block_heights(range_start, range_end);
  IF rg.lo IS NULL OR rg.hi IS NULL OR rg.lo > rg.hi THEN RETURN; END IF;
  bh := coalesce(before_height, 9223372036854775807);
  -- the page (OFFSET, LIMIT) is cut before the join to blocks, so only its rows look up their block time (offset 1M
  -- over the 188 services with updates on mainnet, 2026-10-15: 1.58 s against 2.86 s joining every row read)
  RETURN QUERY
  SELECT d.block_id::bigint, bl.timestamp AT TIME ZONE 'UTC', d.service_id, d.prev_num_relays_ema, d.new_num_relays_ema,
         d.prev_target_hash_hex_encoded, d.new_target_hash_hex_encoded, cv.covered_from, cv.covered_to, cv.gaps
  FROM (
    SELECT p.* FROM (SELECT DISTINCT unnest(services) id) u CROSS JOIN LATERAL (
      SELECT e.block_id, e.service_id, e.prev_num_relays_ema, e.new_num_relays_ema, e.prev_target_hash_hex_encoded,
             e.new_target_hash_hex_encoded
      FROM ${s}.event_relay_mining_difficulty_updateds e
      WHERE e.service_id = u.id AND e.block_id BETWEEN rg.lo AND rg.hi
        AND (e.block_id < bh OR e.block_id = bh AND e.service_id < before_service_id)
      ORDER BY e.block_id DESC LIMIT row_limit::bigint + row_offset) p
    ORDER BY p.block_id DESC, p.service_id DESC LIMIT row_limit OFFSET row_offset) d
  JOIN ${s}.blocks bl ON bl.id = d.block_id
  ORDER BY d.block_id DESC, d.service_id DESC;
END $$;

-- Supplier domains ranked by what their suppliers claimed: domain_service_daily_rewards summed over the UTC days that
-- start inside [range_start, range_end) (NULL = every day), with the Staked suppliers that have a live config on the
-- domain now and their stake (as get_supplier_stats_by_domains); top keeps the first N (NULL = all). The live configs
-- are reduced to distinct (supplier, domains) before their domains are expanded: 157k configs are 4.5k suppliers
-- (mainnet replica 2026-10-13, 356 ms for the 35 domains; 2.5 s testing each config against each domain).
CREATE OR REPLACE FUNCTION ${s}.get_supplier_domains(range_start timestamptz DEFAULT NULL,
  range_end timestamptz DEFAULT NULL, top integer DEFAULT NULL)
RETURNS TABLE(domain text, claimed_upokt numeric, relays numeric, estimated_relays numeric, compute_units numeric,
  estimated_compute_units numeric, first_day date, last_day date, staked_suppliers bigint, staked_upokt numeric)
LANGUAGE plpgsql STABLE SET plan_cache_mode = force_custom_plan AS $$
BEGIN
  PERFORM ${s}._validate(NULL, '', range_start, range_end, NULL);
  IF top IS NOT NULL AND top < 1 THEN RAISE EXCEPTION 'top must be at least 1 (has %)', top; END IF;
  RETURN QUERY
  WITH g AS (
    SELECT d.domain, sum(d.gross_rewards) claimed, sum(d.relays) relays, sum(d.estimated_relays) est_relays,
           sum(d.computed_units) cu, sum(d.estimated_computed_units) est_cu, min(d.day) d1, max(d.day) d2
    FROM ${s}.domain_service_daily_rewards d
    WHERE (range_start IS NULL OR d.day::timestamp AT TIME ZONE 'UTC' >= range_start)
      AND (range_end IS NULL OR d.day::timestamp AT TIME ZONE 'UTC' < range_end)
    GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT top
  ), m0 AS (
    SELECT DISTINCT c.supplier_id, c.domains FROM ${s}.supplier_service_configs c WHERE upper_inf(c._block_range)
  ), m AS (
    SELECT DISTINCT x.domain, m0.supplier_id
    FROM m0 CROSS JOIN LATERAL jsonb_array_elements_text(m0.domains) x(domain)
    WHERE jsonb_typeof(m0.domains) = 'array' AND x.domain IN (SELECT g.domain FROM g)
  ), st AS (
    SELECT m.domain, count(*) n, sum(su.stake_amount) stake
    FROM m JOIN ${s}.suppliers su ON su.id = m.supplier_id AND upper_inf(su._block_range) AND su.stake_status::text = 'Staked'
    GROUP BY 1
  )
  SELECT g.domain, g.claimed, g.relays, g.est_relays, g.cu, g.est_cu, g.d1, g.d2, coalesce(st.n, 0),
         coalesce(st.stake, 0)
  FROM g LEFT JOIN st ON st.domain = g.domain
  ORDER BY 2 DESC, 1;
END $$;

-- A supplier's service configs over time, one row per stretch of heights in which a config declared the same content:
-- a row starts at the config's first version, after a gap (the supplier unstaked, or dropped the service and took it
-- back) and when its rev_share or endpoints change. Every stake writes a new version of all the supplier's configs, and
-- every activation another, so the versions repeat their content: the most of any supplier, 21,114 on mainnet, are 157
-- rows, in 0.42 s (replica, 2026-10-14). rev_share is compared and returned sorted by address: the CLI builds it from a
-- map, so its order changes on every stake (poktroll x/supplier/config/supplier_configs_reader.go). last_height is the
-- last height of the stretch (NULL while the config declares it now); domains are those of its newest version. The
-- configs are what the supplier declared, from its stake height (see getServices in src/mappings/pocket/suppliers.ts).
-- Keyset paging on (service_id, first_height). _supplier_config_history computes the rows of a list of suppliers, which
-- get_supplier_config_history (one supplier), get_suppliers_config_history (up to 200, keyset on (supplier_id,
-- service_id, first_height)) and get_suppliers_config_history_json (every row of up to 200 in one call) read, so their
-- rows cannot differ.
CREATE OR REPLACE FUNCTION ${s}._supplier_config_history(p_suppliers text[], services text[], p_limit integer,
  after_supplier_id text, after_service_id text, after_first_height bigint)
RETURNS TABLE(supplier_id text, service_id text, first_height bigint, last_height bigint, rev_share jsonb, endpoints jsonb,
  domains text[])
LANGUAGE plpgsql STABLE SET plan_cache_mode = force_custom_plan AS $$
DECLARE sid text; left_rows integer := p_limit; n integer;
BEGIN
  -- one supplier at a time, in order, until the page is full: a page reads its own suppliers' versions only (200 of an
  -- operator's suppliers have 321k versions, 31.5k rows: 3.9 s all at once on the mainnet replica, 2026-10-20)
  FOR sid IN SELECT DISTINCT u.x FROM unnest(p_suppliers) u(x)
             WHERE u.x IS NOT NULL AND (after_service_id IS NULL OR u.x >= after_supplier_id) ORDER BY 1 LOOP
    RETURN QUERY
    WITH v AS (
      SELECT c.service_id svc, lower(c._block_range) lo, upper(c._block_range) hi,
             (SELECT coalesce(jsonb_agg(x ORDER BY x->>'address', x->>'revSharePercentage'), '[]'::jsonb)
              FROM jsonb_array_elements(c.rev_share) x) rs,
             c.endpoints ep, c.domains dm
      FROM ${s}.supplier_service_configs c
      WHERE c.supplier_id = sid AND NOT isempty(c._block_range)
        AND (services IS NULL OR c.service_id = ANY(services))
        AND (after_service_id IS NULL OR sid > after_supplier_id OR c.service_id >= after_service_id)
    ), w AS (
      SELECT v.*, lag(v.hi) OVER k p_hi, lag(v.rs) OVER k p_rs, lag(v.ep) OVER k p_ep
      FROM v WINDOW k AS (PARTITION BY v.svc ORDER BY v.lo)
    ), g AS (
      -- the stretch of each version: how many rows started up to it
      SELECT w.*, count(*) FILTER (WHERE w.p_hi IS NULL OR w.p_hi <> w.lo OR w.rs <> w.p_rs OR w.ep <> w.p_ep)
                    OVER (PARTITION BY w.svc ORDER BY w.lo) seg
      FROM w
    ), r AS (
      SELECT g.svc, min(g.lo)::bigint f, CASE WHEN bool_or(g.hi IS NULL) THEN NULL ELSE max(g.hi)::bigint - 1 END l,
             (array_agg(g.rs ORDER BY g.lo))[1] rs, (array_agg(g.ep ORDER BY g.lo))[1] ep,
             (array_agg(g.dm ORDER BY g.lo DESC))[1] domains
      FROM g GROUP BY g.svc, g.seg
    )
    SELECT sid, r.svc, r.f, r.l, r.rs, r.ep, ARRAY(SELECT e.x FROM ${configDomains("r")} e(x))
    FROM r
    WHERE after_service_id IS NULL OR sid > after_supplier_id OR (r.svc, r.f) > (after_service_id, after_first_height)
    ORDER BY r.svc, r.f
    LIMIT left_rows;
    GET DIAGNOSTICS n = ROW_COUNT;
    left_rows := left_rows - n;
    EXIT WHEN left_rows <= 0;
  END LOOP;
END $$;

CREATE OR REPLACE FUNCTION ${s}.get_supplier_config_history(supplier_id text, services text[] DEFAULT NULL,
  row_limit integer DEFAULT 1000, after_service_id text DEFAULT NULL, after_first_height bigint DEFAULT NULL)
RETURNS TABLE(service_id text, first_height bigint, last_height bigint, rev_share jsonb, endpoints jsonb, domains text[])
LANGUAGE plpgsql STABLE SET plan_cache_mode = force_custom_plan AS $$
BEGIN
  IF get_supplier_config_history.supplier_id IS NULL THEN RAISE EXCEPTION 'supplier_id is required'; END IF;
  IF row_limit IS NULL OR row_limit < 1 OR row_limit > 1000 THEN
    RAISE EXCEPTION 'row_limit must be between 1 and 1000 (has %); page with after_service_id / after_first_height', row_limit;
  END IF;
  IF (after_service_id IS NULL) <> (after_first_height IS NULL) THEN
    RAISE EXCEPTION 'pass both after_service_id and after_first_height (the last row of the previous page), or neither';
  END IF;
  IF services IS NOT NULL THEN PERFORM ${s}._validate(services, 'services', NULL, NULL, NULL); END IF;
  RETURN QUERY
  SELECT h.service_id, h.first_height, h.last_height, h.rev_share, h.endpoints, h.domains
  FROM ${s}._supplier_config_history(ARRAY[get_supplier_config_history.supplier_id], services, row_limit,
                                     get_supplier_config_history.supplier_id, after_service_id, after_first_height) h;
END $$;

-- The same for up to 200 suppliers, one row per (supplier, stretch): row_limit rows (up to 1000) per call, keyset on
-- (after_supplier_id, after_service_id, after_first_height), all three or none.
-- Named get_suppliers_*, not get_supplier_config_histories: PostGraphile singularizes "histories" and both functions
-- would define the type GetSupplierConfigHistoryEdge, which stops subql-query from building its schema (2026-10-24).
CREATE OR REPLACE FUNCTION ${s}.get_suppliers_config_history(suppliers text[], services text[] DEFAULT NULL,
  row_limit integer DEFAULT 1000, after_supplier_id text DEFAULT NULL, after_service_id text DEFAULT NULL,
  after_first_height bigint DEFAULT NULL)
RETURNS TABLE(supplier_id text, service_id text, first_height bigint, last_height bigint, rev_share jsonb, endpoints jsonb,
  domains text[])
LANGUAGE plpgsql STABLE SET plan_cache_mode = force_custom_plan AS $$
BEGIN
  PERFORM ${s}._validate(suppliers, 'suppliers', NULL, NULL, NULL);
  IF row_limit IS NULL OR row_limit < 1 OR row_limit > 1000 THEN
    RAISE EXCEPTION 'row_limit must be between 1 and 1000 (has %); page with after_supplier_id / after_service_id / after_first_height', row_limit;
  END IF;
  IF (after_supplier_id IS NULL) <> (after_service_id IS NULL) OR (after_service_id IS NULL) <> (after_first_height IS NULL) THEN
    RAISE EXCEPTION 'pass after_supplier_id, after_service_id and after_first_height (the last row of the previous page), or none';
  END IF;
  IF services IS NOT NULL THEN PERFORM ${s}._validate(services, 'services', NULL, NULL, NULL); END IF;
  RETURN QUERY SELECT * FROM ${s}._supplier_config_history(suppliers, services, row_limit, after_supplier_id, after_service_id,
                                                           after_first_height);
END $$;

-- Every row of get_suppliers_config_history for up to 200 suppliers in one call, as a JSON array in its order (numbers
-- as strings, as the catalog's _json variants): the list caps a call at 1000 rows.
CREATE OR REPLACE FUNCTION ${s}.get_suppliers_config_history_json(suppliers text[], services text[] DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql STABLE SET plan_cache_mode = force_custom_plan AS $$
BEGIN
  PERFORM ${s}._validate(suppliers, 'suppliers', NULL, NULL, NULL);
  IF services IS NOT NULL THEN PERFORM ${s}._validate(services, 'services', NULL, NULL, NULL); END IF;
  RETURN (SELECT coalesce(jsonb_agg(${s}._json_strings(to_jsonb(h)) ORDER BY h.supplier_id, h.service_id, h.first_height), '[]'::jsonb)
          FROM ${s}._supplier_config_history(suppliers, services, NULL, NULL, NULL, NULL) h);
END $$;
COMMENT ON FUNCTION ${s}.get_suppliers_config_history_json(text[], text[]) IS
'Service configs over time of up to 200 suppliers (suppliers; services keeps those, up to 200) in one call: every row of getSuppliersConfigHistoryList, as one JSON array in its order (supplier_id, service_id, first_height), numbers as strings. For answers above the list''s 1000 rows.';

-- The live service configs of the Staked suppliers, one row per (supplier, service), with the supplier's owner and stake
-- and the config's endpoint domains: the suppliers { serviceConfigs } join consumers built by hand (158,314 live configs
-- on mainnet, 2026-10-14, unique per supplier and service). Keyset paging on (supplier_id, service_id) through
-- idx_ssc_live_supplier_service; services narrows through idx_ssc_live_service.
CREATE OR REPLACE FUNCTION ${s}.get_staked_supplier_services(services text[] DEFAULT NULL, row_limit integer DEFAULT 1000,
  after_supplier_id text DEFAULT NULL, after_service_id text DEFAULT NULL)
RETURNS TABLE(supplier_id text, service_id text, owner_id text, stake_upokt numeric, domains text[],
  activated_at_height bigint)
LANGUAGE plpgsql STABLE SET plan_cache_mode = force_custom_plan AS $$
BEGIN
  IF row_limit IS NULL OR row_limit < 1 OR row_limit > 1000 THEN
    RAISE EXCEPTION 'row_limit must be between 1 and 1000 (has %); page with after_supplier_id / after_service_id', row_limit;
  END IF;
  IF (after_supplier_id IS NULL) <> (after_service_id IS NULL) THEN
    RAISE EXCEPTION 'pass both after_supplier_id and after_service_id (the last row of the previous page), or neither';
  END IF;
  IF services IS NOT NULL THEN PERFORM ${s}._validate(services, 'services', NULL, NULL, NULL); END IF;
  RETURN QUERY
  SELECT c.supplier_id, c.service_id, su.owner_id, su.stake_amount,
         ARRAY(SELECT e.x FROM ${configDomains("c")} e(x)),
         c.activated_at_id::bigint
  FROM ${s}.supplier_service_configs c
  JOIN ${s}.suppliers su ON su.id = c.supplier_id AND upper_inf(su._block_range) AND su.stake_status::text = 'Staked'
  WHERE upper_inf(c._block_range) AND (services IS NULL OR c.service_id = ANY(services))
    -- the plain bound lets the index range start at the key; with the row comparison alone the planner walked the
    -- suppliers from the first one (1.2 s for a middle page on mainnet; 26 ms with it, 2026-10-14)
    AND (after_supplier_id IS NULL OR c.supplier_id >= after_supplier_id)
    AND (after_supplier_id IS NULL OR (c.supplier_id, c.service_id) > (after_supplier_id, after_service_id))
  ORDER BY c.supplier_id, c.service_id
  LIMIT row_limit;
END $$;

-- The live service configs of the Staked suppliers counted per (endpoint root domain, service): configs = the configs
-- that list the domain (once per config, whatever it repeats), as get_staked_supplier_services gives their domains;
-- a config with no domain is counted on the row of domain '' of its service, so the configs of the rows add up to at
-- least total_configs. total_configs and total_suppliers, the same on every row of the first page
-- (NULL on the next ones), are all those configs and their distinct suppliers, for a client to check it read everything. 472 groups over 160,488 configs on mainnet
-- (2026-10-14; no config repeats a domain): the groups take ~0.2 s and the totals ~0.12 s through
-- idx_suppliers_live_id and idx_ssc_live_supplier_service. Keyset paging on (domain, service_id).
CREATE OR REPLACE FUNCTION ${s}.get_staked_domain_services(row_limit integer DEFAULT 1000, after_domain text DEFAULT NULL,
  after_service_id text DEFAULT NULL)
RETURNS TABLE(domain text, service_id text, configs bigint, total_configs bigint, total_suppliers bigint)
LANGUAGE plpgsql STABLE SET plan_cache_mode = force_custom_plan AS $$
DECLARE n_configs bigint; n_suppliers bigint;
BEGIN
  IF row_limit IS NULL OR row_limit < 1 OR row_limit > 1000 THEN
    RAISE EXCEPTION 'row_limit must be between 1 and 1000 (has %); page with after_domain / after_service_id', row_limit;
  END IF;
  IF (after_domain IS NULL) <> (after_service_id IS NULL) THEN
    RAISE EXCEPTION 'pass both after_domain and after_service_id (the last row of the previous page), or neither';
  END IF;
  -- the totals on the first page only (a pass over every config: ~0.35 s on mainnet)
  IF after_domain IS NULL THEN
    SELECT count(*), count(DISTINCT c.supplier_id) INTO n_configs, n_suppliers
    FROM ${s}.supplier_service_configs c
    JOIN ${s}.suppliers su ON su.id = c.supplier_id AND upper_inf(su._block_range) AND su.stake_status::text = 'Staked'
    WHERE upper_inf(c._block_range);
  END IF;
  RETURN QUERY
  SELECT d.x, c.service_id, count(*)::bigint, n_configs, n_suppliers
  FROM ${s}.supplier_service_configs c
  JOIN ${s}.suppliers su ON su.id = c.supplier_id AND upper_inf(su._block_range) AND su.stake_status::text = 'Staked'
  -- each distinct domain of the config, or one '' when it has none (so every config is counted on some row)
  CROSS JOIN LATERAL ${domainKeys("c")} d
  WHERE upper_inf(c._block_range)
    AND (after_domain IS NULL OR d.x >= after_domain)
    AND (after_domain IS NULL OR (d.x, c.service_id) > (after_domain, after_service_id))
  GROUP BY 1, 2
  ORDER BY 1, 2
  LIMIT row_limit;
END $$;

-- The Staked suppliers now (or those of stake_statuses), one row each in supplier_id order: owner, operator, stake, and
-- the services and endpoint root domains of their live configs (empty arrays without one; for a supplier not Staked
-- with none live, the configs closed at its last closing): the suppliers { serviceConfigs } walk consumers made.
-- Keyset paging on supplier_id: a stable key, so a walk neither skips nor repeats a supplier whose stake changes
-- meanwhile; at_height (NULL = _metadata.lastProcessedHeight) reads the versions in force at one height, which every
-- row carries, so all the pages of a walk read the same state. A page of 1000 takes 31-50 ms on mainnet (4,548 Staked suppliers, 2026-10-14), through idx_suppliers_live_id,
-- idx_ssc_live_supplier_service and idx_ssc_live_supplier_domains.
CREATE OR REPLACE FUNCTION ${s}.get_staked_suppliers(row_limit integer DEFAULT 1000, after_supplier_id text DEFAULT NULL,
  stake_statuses text[] DEFAULT ARRAY['Staked'], at_height bigint DEFAULT NULL)
RETURNS TABLE(supplier_id text, owner_id text, operator_id text, stake_upokt numeric, service_ids text[], domains text[],
  height bigint)
LANGUAGE plpgsql STABLE SET plan_cache_mode = force_custom_plan AS $$
DECLARE h bigint;
BEGIN
  IF row_limit IS NULL OR row_limit < 1 OR row_limit > 1000 THEN
    RAISE EXCEPTION 'row_limit must be between 1 and 1000 (has %); page with after_supplier_id', row_limit;
  END IF;
  IF stake_statuses IS NULL OR cardinality(stake_statuses) < 1 OR NOT stake_statuses <@ ARRAY['Staked', 'Unstaking', 'Unstaked'] THEN
    RAISE EXCEPTION 'stake_statuses takes Staked, Unstaking and Unstaked (has %)', stake_statuses;
  END IF;
  IF at_height < 1 THEN
    RAISE EXCEPTION 'at_height must be a block height (has %)', at_height;
  END IF;
  -- as get_gateway_delegations: NULL = the last height the indexer finished, read here; every row carries it, so a walk
  -- pins its next pages (and other functions) to the same height
  h := at_height;
  IF h IS NULL THEN
    SELECT (m.value #>> '{}')::bigint INTO h FROM ${s}._metadata m WHERE m.key = 'lastProcessedHeight';
  END IF;
  IF h IS NULL THEN
    RAISE EXCEPTION 'no lastProcessedHeight in _metadata: pass at_height';
  END IF;
  IF stake_statuses <> ARRAY['Staked'] THEN
    -- other statuses: a supplier not Staked with no config at the height gets the configs closed at its last closing up
    -- to it (a Staked one with none gets empty arrays; the newest upper of its versions, through the GiST on
    -- (supplier_id, _block_range)): ~2.8 s a page of 1000 Unstaked suppliers on mainnet
    RETURN QUERY
    SELECT su.id, su.owner_id, su.operator_id, su.stake_amount::numeric,
           ARRAY(SELECT DISTINCT c.service_id FROM ${s}.supplier_service_configs c WHERE c.supplier_id = su.id
                 AND CASE WHEN m.live OR su.stake_status::text = 'Staked' THEN c._block_range @> h
                          ELSE upper(c._block_range) = m.last_upper END ORDER BY 1),
           ARRAY(SELECT DISTINCT e.x FROM ${s}.supplier_service_configs c, ${configDomains("c")} e(x) WHERE c.supplier_id = su.id
                 AND CASE WHEN m.live OR su.stake_status::text = 'Staked' THEN c._block_range @> h
                          ELSE upper(c._block_range) = m.last_upper END ORDER BY 1),
           h
    FROM ${s}.suppliers su
    CROSS JOIN LATERAL (SELECT bool_or(c._block_range @> h) live,
                               max(upper(c._block_range)) FILTER (WHERE upper(c._block_range) <= h) last_upper
                        FROM ${s}.supplier_service_configs c WHERE c.supplier_id = su.id) m
    WHERE su._block_range @> h AND su.stake_status::text = ANY(stake_statuses)
      AND (after_supplier_id IS NULL OR su.id > after_supplier_id)
    ORDER BY su.id
    LIMIT row_limit;
    RETURN;
  END IF;
  RETURN QUERY
  -- the versions in force at the height: suppliers through their GiST indexes, each supplier's configs through the
  -- GiST on (supplier_id, _block_range); ~0.33 s a page of 1000 on mainnet, against ~0.16 s for the live rows, which a
  -- block being written can show half-updated
  SELECT su.id, su.owner_id, su.operator_id, su.stake_amount::numeric,
         ARRAY(SELECT DISTINCT c.service_id FROM ${s}.supplier_service_configs c
               WHERE c.supplier_id = su.id AND c._block_range @> h ORDER BY 1),
         ARRAY(SELECT DISTINCT e.x FROM ${s}.supplier_service_configs c, ${configDomains("c")} e(x)
               WHERE c.supplier_id = su.id AND c._block_range @> h ORDER BY 1),
         h
  FROM ${s}.suppliers su
  WHERE su._block_range @> h AND su.stake_status::text = 'Staked'
    AND (after_supplier_id IS NULL OR su.id > after_supplier_id)
  ORDER BY su.id
  LIMIT row_limit;
END $$;

-- Created claims (MsgCreateClaim) counted per supplier, for up to 20 suppliers, in [range_start, range_end): what
-- msgCreateClaims { totalCount } answered, which get_created_claims can only list row by row. One row per requested
-- supplier, 0 when it made none, with the first and last height counted. Covers the indexed blocks (_block_heights of
-- the range). beyond_tip = no indexed block at or after range_end yet (range_end NULL: range_start), as get_height_at:
-- the indexer has not reached the end of the range, so the count may still grow, and a 0 there says nothing (a range
-- past the tip counted 0, as an idle supplier does). One probe of idx_blocks_timestamp_id. msg_create_claims has only GiST indexes: the busiest mainnet supplier's 30 days in 830 ms on the replica
-- (2026-10-14), hence the cap.
CREATE OR REPLACE FUNCTION ${s}.get_created_claims_count(suppliers text[], range_start timestamptz,
  range_end timestamptz, from_session_end_height bigint DEFAULT NULL)
RETURNS TABLE(supplier_id text, claims bigint, first_height bigint, last_height bigint, beyond_tip boolean)
LANGUAGE plpgsql STABLE SET plan_cache_mode = force_custom_plan AS $$
DECLARE rg record; bt boolean;
BEGIN
  IF suppliers IS NULL OR cardinality(suppliers) < 1 OR cardinality(suppliers) > 20 THEN
    RAISE EXCEPTION 'suppliers must have between 1 and 20 elements (has %)', coalesce(cardinality(suppliers), 0);
  END IF;
  PERFORM ${s}._validate(NULL, '', range_start, range_end, NULL);
  rg := ${s}._block_heights(range_start, range_end);
  -- as get_created_claims: the claims of sessions ending at or after it, read from that height
  rg.lo := CASE WHEN rg.lo IS NOT NULL THEN greatest(rg.lo, from_session_end_height) END;
  bt := coalesce(range_end, range_start) IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM ${s}.blocks bl WHERE bl.timestamp >= (coalesce(range_end, range_start) AT TIME ZONE 'UTC'));
  RETURN QUERY
  SELECT u.sid, coalesce(c.n, 0)::bigint, c.lo::bigint, c.hi::bigint, bt
  FROM (SELECT DISTINCT unnest(suppliers) sid) u
  LEFT JOIN LATERAL (
    SELECT count(*) n, min(m.block_id) lo, max(m.block_id) hi FROM ${s}.msg_create_claims m
    WHERE m.supplier_id = u.sid AND m.block_id BETWEEN rg.lo AND rg.hi
      AND (from_session_end_height IS NULL OR m.session_end_height >= from_session_end_height)
  ) c ON true
  ORDER BY 1;
END $$;

-- The Morse accounts the Shannon migration imported, claimed or not: how many and what they hold (liquid balance, and
-- the supplier and application stakes to restake). Current versions of morse_claimable_accounts (57,762, 53 MB on
-- mainnet, 2026-10-13); the accounts themselves stay a GraphQL list. PL/pgSQL, like _operator_suppliers.
CREATE OR REPLACE FUNCTION ${s}.get_morse_claim_summary()
RETURNS TABLE(claimed boolean, accounts bigint, unstaked_balance_upokt numeric, supplier_stake_upokt numeric,
  application_stake_upokt numeric)
LANGUAGE plpgsql STABLE SET plan_cache_mode = force_custom_plan AS $$
BEGIN
  RETURN QUERY
  SELECT m.claimed, count(*), coalesce(sum(m.unstaked_balance_amount), 0), coalesce(sum(m.supplier_stake_amount), 0),
         coalesce(sum(m.application_stake_amount), 0)
  FROM ${s}.morse_claimable_accounts m WHERE upper_inf(m._block_range)
  GROUP BY 1 ORDER BY 1;
END $$;

-- Claims one by one, newest first: settled (claim_settlements) and expired (claim_expirations), at most row_limit
-- (up to 1000) per call; the next page passes the last row's height and event_idx as before_height / before_event_idx
-- (a keyset: rows written meanwhile do not shift the pages). Filters: one of suppliers / owners / operators
-- (_supplier_ids; NULL = every supplier), and applications and services (up to 200 each), all combined.
-- Each settled-claim filter has its own index walk, picked before the query (measured on the mainnet replica,
-- 2026-10-13, 100 newest rows): up to 200 suppliers, each supplier's newest claims from (supplier_id, height), 12 ms
-- for 3; a larger fleet (owners, operators) or no filter, the settlement heights newest first, each height's claims
-- (~3,100) by the primary key, ~5 ms for nodefleet.net's 2,351 suppliers, which hold half of each height's claims (a
-- fleet that settles rarely walks many heights); applications, each one's newest from (application_id, height);
-- services, each one's newest (height, application) from settlement_claims_by_application_service, then those
-- applications' claims, 1.5 ms for 100 rows, 75 ms for 1000 (claim_settlements has no index by service; measured on the
-- mainnet replica, 2026-10-13, when the busiest services had 2 or 3 applications at the last settlement height, so
-- whole heights cost little). The OFFSET 0 keeps the primary key probe: with
-- the fleet filter pushed in, the planner probed (supplier_id, height) once per supplier per height (120 ms a height).
-- Expired claims: their small table (617k rows) by supplier index for a short list, else walked newest first (the
-- whole table when nothing matches: 338 ms).
CREATE OR REPLACE FUNCTION ${s}.get_claims(suppliers text[], range_start timestamptz, range_end timestamptz,
  owners text[] DEFAULT NULL, operators text[] DEFAULT NULL, applications text[] DEFAULT NULL,
  services text[] DEFAULT NULL, statuses text[] DEFAULT NULL, row_limit integer DEFAULT 100,
  before_height bigint DEFAULT NULL, before_event_idx integer DEFAULT NULL, operator_scope text DEFAULT 'now')
RETURNS TABLE(status text, height bigint, event_idx integer, block_time timestamptz, supplier_id text,
  supplier_owner_id text, application_id text, service_id text, session_id text, session_end_height bigint,
  relays bigint, estimated_relays bigint, claimed_compute_units bigint, estimated_compute_units bigint,
  claimed_upokt bigint, settled_upokt bigint, relay_minted_upokt bigint, global_minted_upokt bigint,
  overservicing_loss_upokt bigint, settled_with_proof boolean, expiration_reason text, current_owner_id text,
  covered_from timestamptz, covered_to timestamptz, covered_gaps jsonb)
LANGUAGE plpgsql STABLE SET plan_cache_mode = force_custom_plan AS $$
DECLARE cv record; lo bigint; hi bigint; ids text[]; path text; bh bigint; be integer;
BEGIN
  IF row_limit IS NULL OR row_limit < 1 OR row_limit > 1000 THEN
    RAISE EXCEPTION 'row_limit must be between 1 and 1000 (has %); page with before_height / before_event_idx', row_limit;
  END IF;
  IF statuses IS NOT NULL AND NOT statuses <@ ARRAY['settled', 'expired'] THEN
    RAISE EXCEPTION 'statuses takes settled and expired (has %)', statuses;
  END IF;
  IF (before_height IS NULL) <> (before_event_idx IS NULL) THEN
    RAISE EXCEPTION 'pass both before_height and before_event_idx (the last row of the previous page), or neither';
  END IF;
${OPERATOR_SCOPE_CHECK}
${scopedSupplierIds(s, "suppliers", false, "range_start", "range_end")}
  IF applications IS NOT NULL THEN PERFORM ${s}._validate(applications, 'applications', NULL, NULL, NULL); END IF;
  IF services IS NOT NULL THEN PERFORM ${s}._validate(services, 'services', NULL, NULL, NULL); END IF;
${covered(null)}
  -- heights bound the index walks; each row is also kept to the range by its settlement's time
  SELECT min(sb.height), max(sb.height) INTO lo, hi FROM ${s}.settlement_blocks sb
  WHERE sb.block_time >= range_start AND sb.block_time < range_end;
  -- a keyset row past the range reads nothing past the range
  bh := coalesce(before_height, 9223372036854775807);
  be := coalesce(before_event_idx, 2147483647);
  hi := least(hi, bh);
  IF lo IS NULL OR hi IS NULL OR lo > hi THEN RETURN; END IF;
  path := CASE WHEN ids IS NOT NULL AND cardinality(ids) <= 200 THEN 'suppliers' WHEN ids IS NOT NULL THEN 'heights'
               WHEN applications IS NOT NULL THEN 'applications' WHEN services IS NOT NULL THEN 'services' ELSE 'heights' END;
  RETURN QUERY
  WITH k(height, event_idx) AS (
    SELECT q.height, q.event_idx FROM (
      SELECT c.height, c.event_idx FROM (SELECT DISTINCT unnest(ids) id) u CROSS JOIN LATERAL (
        SELECT c.height, c.event_idx FROM ${s}.claim_settlements c
        WHERE c.supplier_id = u.id AND c.height BETWEEN lo AND hi AND (c.height, c.event_idx) < (bh, be)
          AND c.block_time >= range_start AND c.block_time < range_end
          AND (applications IS NULL OR c.application_id = ANY(applications)) AND (services IS NULL OR c.service_id = ANY(services))
        ORDER BY c.height DESC, c.event_idx DESC LIMIT row_limit) c
      WHERE path = 'suppliers'
      UNION ALL
      SELECT c.height, c.event_idx FROM (SELECT DISTINCT unnest(applications) id) u CROSS JOIN LATERAL (
        SELECT c.height, c.event_idx FROM ${s}.claim_settlements c
        WHERE c.application_id = u.id AND c.height BETWEEN lo AND hi AND (c.height, c.event_idx) < (bh, be)
          AND c.block_time >= range_start AND c.block_time < range_end
          AND (services IS NULL OR c.service_id = ANY(services))
        ORDER BY c.height DESC, c.event_idx DESC LIMIT row_limit) c
      WHERE path = 'applications'
      UNION ALL
      SELECT c.height, c.event_idx FROM (SELECT DISTINCT unnest(services) id) u CROSS JOIN LATERAL (
        SELECT c.height, c.event_idx
        -- every (height, application) of the service at its newest row_limit + 1 heights: each height has a claim of the
        -- service, so row_limit of them below the keyset's height hold at least row_limit claims, whatever the keyset
        -- leaves at its own height
        FROM (SELECT a.height, a.application_id FROM ${s}.settlement_claims_by_application_service a
              WHERE a.service_id = u.id AND a.height IN (
                SELECT DISTINCT a2.height FROM ${s}.settlement_claims_by_application_service a2
                WHERE a2.service_id = u.id AND a2.height BETWEEN lo AND hi AND a2.block_time >= range_start
                  AND a2.block_time < range_end ORDER BY a2.height DESC LIMIT row_limit + 1)) a
        CROSS JOIN LATERAL (SELECT c.height, c.event_idx FROM ${s}.claim_settlements c
                            WHERE c.application_id = a.application_id AND c.height = a.height AND c.service_id = u.id
                              AND (c.height, c.event_idx) < (bh, be)) c
        ORDER BY c.height DESC, c.event_idx DESC LIMIT row_limit) c
      WHERE path = 'services'
      UNION ALL
      (SELECT c.height, c.event_idx
       FROM (SELECT sb.height FROM ${s}.settlement_blocks sb WHERE sb.height BETWEEN lo AND hi
               AND sb.block_time >= range_start AND sb.block_time < range_end ORDER BY sb.height DESC) h
       CROSS JOIN LATERAL (SELECT c.height, c.event_idx, c.supplier_id, c.application_id, c.service_id
                           FROM ${s}.claim_settlements c WHERE c.height = h.height OFFSET 0) c
       WHERE path = 'heights' AND (c.height, c.event_idx) < (bh, be) AND (ids IS NULL OR c.supplier_id = ANY(ids))
         AND (applications IS NULL OR c.application_id = ANY(applications)) AND (services IS NULL OR c.service_id = ANY(services))
       ORDER BY h.height DESC, c.event_idx DESC LIMIT row_limit)
    ) q WHERE statuses IS NULL OR 'settled' = ANY(statuses)
    ORDER BY 1 DESC, 2 DESC LIMIT row_limit
  ), x(height, event_idx) AS (
    (SELECT e.height, e.event_idx FROM ${s}.claim_expirations e
     JOIN ${s}.settlement_blocks sb ON sb.height = e.height AND sb.block_time >= range_start AND sb.block_time < range_end
     WHERE (statuses IS NULL OR 'expired' = ANY(statuses)) AND cardinality(ids) <= 200
       AND e.supplier_id = ANY(ids) AND e.height BETWEEN lo AND hi AND (e.height, e.event_idx) < (bh, be)
       AND (applications IS NULL OR e.application_id = ANY(applications)) AND (services IS NULL OR e.service_id = ANY(services))
     ORDER BY e.height DESC, e.event_idx DESC LIMIT row_limit)
    UNION ALL
    (SELECT e.height, e.event_idx
     FROM (SELECT e.* FROM ${s}.claim_expirations e WHERE e.height BETWEEN lo AND hi
           ORDER BY e.height DESC, e.event_idx DESC OFFSET 0) e
     JOIN ${s}.settlement_blocks sb ON sb.height = e.height AND sb.block_time >= range_start AND sb.block_time < range_end
     WHERE (statuses IS NULL OR 'expired' = ANY(statuses)) AND (ids IS NULL OR cardinality(ids) > 200)
       AND (e.height, e.event_idx) < (bh, be) AND (ids IS NULL OR e.supplier_id = ANY(ids))
       AND (applications IS NULL OR e.application_id = ANY(applications)) AND (services IS NULL OR e.service_id = ANY(services))
     ORDER BY e.height DESC, e.event_idx DESC LIMIT row_limit)
  )
  -- the current owner of the rows of the page only, after the order and limit
  SELECT l.a1, l.a2, l.a3, l.a4, l.supplier_id, l.a6, l.a7, l.a8, l.a9, l.a10, l.a11, l.a12, l.a13, l.a14, l.a15, l.a16,
         l.a17, l.a18, l.a19, l.a20, l.a21, ${currentOwner("l")}, cv.covered_from, cv.covered_to, cv.gaps
  FROM (
    SELECT r.* FROM (
      SELECT 'settled'::text, c.height, c.event_idx, c.block_time, c.supplier_id, nullif(c.supplier_owner_id, ''),
             c.application_id, c.service_id, c.session_id, c.session_end, c.relays, c.estimated_relays, c.claimed_compute_units,
             c.estimated_compute_units, c.claimed_upokt, c.settled_upokt, c.relay_minted_upokt, c.global_minted_upokt,
             c.overservicing_loss_upokt, c.settled_with_proof, NULL::text
      FROM k JOIN ${s}.claim_settlements c ON c.height = k.height AND c.event_idx = k.event_idx
      UNION ALL
      SELECT 'expired', e.height, e.event_idx, sb.block_time, e.supplier_id, NULL, e.application_id, e.service_id, NULL,
             e.session_end, e.relays, e.estimated_relays, e.claimed_compute_units, e.estimated_compute_units,
             e.claimed_upokt, NULL, NULL, NULL, NULL, NULL, e.reason
      FROM x JOIN ${s}.claim_expirations e ON e.height = x.height AND e.event_idx = x.event_idx
      JOIN ${s}.settlement_blocks sb ON sb.height = e.height
    ) r(a1, a2, a3, a4, supplier_id, a6, a7, a8, a9, a10, a11, a12, a13, a14, a15, a16, a17, a18, a19, a20, a21)
    ORDER BY 2 DESC, 3 DESC LIMIT row_limit
  ) l
  ORDER BY l.a2 DESC, l.a3 DESC;
END $$;

-- Claims created (MsgCreateClaim) by up to 20 suppliers, newest first, before they settle or expire: what get_claims
-- cannot list, for a supplier's own monitor (the sessions it claimed, the last claim it made). msg_create_claims has
-- only GiST indexes (54 GB, 46M rows on mainnet): each supplier's claims are a bitmap of all of them, ~130 ms for the
-- busiest one (mainnet replica, 2026-10-13), hence the cap. Keyset paging on (height, id), like get_claims. Covers the
-- indexed blocks. from_session_end_height keeps the claims of sessions ending at or after it (a monitor that knows the
-- sessions it already saw), and starts the read at that height. Same claims with and without that bound for the 3 most
-- active suppliers on mainnet (2026-10-14); a page took 0.19 s with it and 0.16 s without (warm): the bound joins the
-- GiST on block_id to the one on supplier_id, so it does not make a recent read faster.
CREATE OR REPLACE FUNCTION ${s}.get_created_claims(suppliers text[], range_start timestamptz, range_end timestamptz,
  row_limit integer DEFAULT 100, before_height bigint DEFAULT NULL, before_id text DEFAULT NULL,
  from_session_end_height bigint DEFAULT NULL)
RETURNS TABLE(height bigint, block_time timestamptz, id text, supplier_id text, application_id text, service_id text,
  session_id text, session_end_height bigint, relays numeric, estimated_relays numeric, claimed_compute_units numeric,
  estimated_compute_units numeric, claimed_upokt numeric, transaction_id text, covered_from timestamptz,
  covered_to timestamptz, covered_gaps jsonb)
LANGUAGE plpgsql STABLE SET plan_cache_mode = force_custom_plan AS $$
DECLARE cv record; rg record; bh numeric;
BEGIN
  IF suppliers IS NULL OR cardinality(suppliers) < 1 OR cardinality(suppliers) > 20 THEN
    RAISE EXCEPTION 'suppliers must have between 1 and 20 elements (has %)', coalesce(cardinality(suppliers), 0);
  END IF;
  PERFORM ${s}._validate(NULL, '', range_start, range_end, NULL);
  IF row_limit IS NULL OR row_limit < 1 OR row_limit > 1000 THEN
    RAISE EXCEPTION 'row_limit must be between 1 and 1000 (has %); page with before_height / before_id', row_limit;
  END IF;
  IF (before_height IS NULL) <> (before_id IS NULL) THEN
    RAISE EXCEPTION 'pass both before_height and before_id (the last row of the previous page), or neither';
  END IF;
${covered(null, true)}
  rg := ${s}._block_heights(range_start, range_end);
  -- a claim lands after its session ends (the claim window opens at session end + offset + 1, poktroll
  -- shared GetClaimWindowOpenHeight): no claim of those sessions is in an earlier block
  rg.lo := CASE WHEN rg.lo IS NOT NULL THEN greatest(rg.lo, from_session_end_height) END;
  IF rg.lo IS NULL OR rg.hi IS NULL OR rg.lo > rg.hi THEN RETURN; END IF;
  bh := coalesce(before_height, 9223372036854775807);
  RETURN QUERY
  SELECT m.block_id::bigint, bl.timestamp AT TIME ZONE 'UTC', m.id, m.supplier_id, m.application_id, m.service_id,
         m.session_id, m.session_end_height::bigint, m.num_relays, m.num_estimated_relays, m.num_claimed_computed_units,
         m.num_estimated_computed_units, m.claimed_amount, m.transaction_id, cv.covered_from, cv.covered_to, cv.gaps
  FROM (SELECT DISTINCT unnest(suppliers) sid) u CROSS JOIN LATERAL (
    SELECT m.* FROM ${s}.msg_create_claims m
    WHERE m.supplier_id = u.sid AND m.block_id BETWEEN rg.lo AND rg.hi
      AND (m.block_id < bh OR m.block_id = bh AND m.id < before_id)
      AND (from_session_end_height IS NULL OR m.session_end_height >= from_session_end_height)
    ORDER BY m.block_id DESC, m.id DESC LIMIT row_limit) m
  JOIN ${s}.blocks bl ON bl.id = m.block_id
  ORDER BY m.block_id DESC, m.id DESC LIMIT row_limit;
END $$;

-- Native transfers (MsgSend) of up to 200 addresses, newest first (by height, then id), with their block time and their
-- transaction's code, codespace, fees, signer and memo: what nativeTransfers { block { timestamp } transaction { ... } }
-- answered in one request before the relations closed (pokt-data-agent: 2 requests to 1). direction: sent (the sender
-- is one of addresses), received (the recipient is) or NULL for both; a transfer between two of them comes once. Keyset
-- paging on (height, id), like get_created_claims. native_transfers is small (115,821 rows, 57 MB on mainnet,
-- 2026-10-15): each direction through the GiST on sender_id / recipient_id, then sorted; the busiest address (19,070
-- transfers), a page of 100 with its transactions in 47 ms. Every transfer of the addresses is read to sort it: at the
-- 200-address cap the planner may scan the whole table instead of the GiST; the 200 busiest senders (80,107 sent and
-- 55,943 received) take 0.4 s. Covers the indexed blocks.
CREATE OR REPLACE FUNCTION ${s}.get_native_transfers(addresses text[], direction text DEFAULT NULL,
  range_start timestamptz DEFAULT NULL, range_end timestamptz DEFAULT NULL, row_limit integer DEFAULT 100,
  before_height bigint DEFAULT NULL, before_id text DEFAULT NULL)
RETURNS TABLE(height bigint, block_time timestamptz, id text, sender_id text, recipient_id text, denom text,
  amounts jsonb, status text, transaction_id text, tx_code integer, tx_codespace text, tx_fees jsonb,
  tx_signer_address text, tx_memo text, covered_from timestamptz, covered_to timestamptz, covered_gaps jsonb)
LANGUAGE plpgsql STABLE SET plan_cache_mode = force_custom_plan AS $$
DECLARE cv record; rg record; bh numeric;
BEGIN
  PERFORM ${s}._validate(addresses, 'addresses', range_start, range_end, NULL);
  IF direction IS NOT NULL AND direction NOT IN ('sent', 'received') THEN
    RAISE EXCEPTION 'direction is sent, received or NULL for both (has %)', direction;
  END IF;
  IF row_limit IS NULL OR row_limit < 1 OR row_limit > 1000 THEN
    RAISE EXCEPTION 'row_limit must be between 1 and 1000 (has %); page with before_height / before_id', row_limit;
  END IF;
  IF (before_height IS NULL) <> (before_id IS NULL) THEN
    RAISE EXCEPTION 'pass both before_height and before_id (the last row of the previous page), or neither';
  END IF;
${covered(null, true)}
  rg := ${s}._block_heights(range_start, range_end);
  IF rg.lo IS NULL OR rg.hi IS NULL OR rg.lo > rg.hi THEN RETURN; END IF;
  bh := coalesce(before_height, 9223372036854775807);
  RETURN QUERY
  WITH n AS (
    (SELECT n.id, n.block_id, n.sender_id, n.recipient_id, n.denom, n.amounts, n.status::text st, n.transaction_id
     FROM ${s}.native_transfers n
     WHERE (direction IS NULL OR direction = 'sent') AND n.sender_id = ANY(addresses) AND upper_inf(n._block_range)
       AND n.block_id BETWEEN rg.lo AND rg.hi AND (n.block_id < bh OR n.block_id = bh AND n.id < before_id)
     ORDER BY n.block_id DESC, n.id DESC LIMIT row_limit)
    UNION
    (SELECT n.id, n.block_id, n.sender_id, n.recipient_id, n.denom, n.amounts, n.status::text, n.transaction_id
     FROM ${s}.native_transfers n
     WHERE (direction IS NULL OR direction = 'received') AND n.recipient_id = ANY(addresses) AND upper_inf(n._block_range)
       AND n.block_id BETWEEN rg.lo AND rg.hi AND (n.block_id < bh OR n.block_id = bh AND n.id < before_id)
     ORDER BY n.block_id DESC, n.id DESC LIMIT row_limit)
  )
  SELECT n.block_id::bigint, bl.timestamp AT TIME ZONE 'UTC', n.id, n.sender_id, n.recipient_id, n.denom, n.amounts,
         n.st, n.transaction_id, tx.code::integer, tx.codespace::text, tx.fees::jsonb, tx.signer_address::text,
         tx.memo::text, cv.covered_from, cv.covered_to, cv.gaps
  FROM n JOIN ${s}.blocks bl ON bl.id = n.block_id
  LEFT JOIN LATERAL (SELECT t.code, t.codespace, t.fees, t.signer_address, t.memo FROM ${s}.transactions t
                     WHERE t.id = n.transaction_id AND upper_inf(t._block_range) LIMIT 1) tx ON true
  ORDER BY n.block_id DESC, n.id DESC LIMIT row_limit;
END $$;

-- An actor's stake history, one row per event, newest first: stake and unstake messages, unbonding begin and end,
-- for suppliers the slashes (penalty, stake before and after, proof status), and for applications and gateways the
-- delegations of one to the other (delegate, undelegate). Reads the indexer's own message and event
-- tables, so it covers the indexed blocks. kind = supplier (suppliers, owners or operators, through _supplier_ids),
-- application or gateway (addresses, up to 200); one list is required: the tables have no block-ordered index (their
-- block_id indexes are GiST), so a network-wide newest-first read would sort them whole. Keyset paging like get_claims,
-- on (height, id).
CREATE OR REPLACE FUNCTION ${s}.get_actor_lifecycle(kind text, addresses text[], range_start timestamptz,
  range_end timestamptz, owners text[] DEFAULT NULL, operators text[] DEFAULT NULL, events text[] DEFAULT NULL,
  row_limit integer DEFAULT 100, before_height bigint DEFAULT NULL, before_id text DEFAULT NULL,
  operator_scope text DEFAULT 'now')
RETURNS TABLE(height bigint, block_time timestamptz, actor_id text, event text, id text, transaction_id text,
  stake_upokt numeric, owner_id text, reason text, unbonding_end_height bigint, session_end_height bigint,
  service_id text, application_id text, session_id text, penalty_upokt numeric, previous_stake_upokt numeric,
  proof_validation_status text, gateway_id text, covered_from timestamptz, covered_to timestamptz, covered_gaps jsonb)
LANGUAGE plpgsql STABLE SET plan_cache_mode = force_custom_plan AS $$
DECLARE cv record; rg record; ids text[]; bh numeric;
BEGIN
  IF kind IS NULL OR kind NOT IN (${LIFECYCLE_KINDS.map((k) => `'${k}'`).join(", ")}) THEN
    RAISE EXCEPTION 'kind is ${LIFECYCLE_KINDS.slice(0, -1).join(", ")} or ${LIFECYCLE_KINDS[LIFECYCLE_KINDS.length - 1]} (has %)', kind;
  END IF;
  IF row_limit IS NULL OR row_limit < 1 OR row_limit > 1000 THEN
    RAISE EXCEPTION 'row_limit must be between 1 and 1000 (has %); page with before_height / before_id', row_limit;
  END IF;
${LIFECYCLE_KIND_EVENTS.map(
    ([k, evs]) => `  IF kind = '${k}' AND events IS NOT NULL AND NOT events <@ ARRAY[${evs.map((e) => `'${e}'`).join(", ")}] THEN
    RAISE EXCEPTION 'events of kind ${k} are ${evs.join(", ")} (has %)', events;
  END IF;`
  ).join("\n")}
  IF (before_height IS NULL) <> (before_id IS NULL) THEN
    RAISE EXCEPTION 'pass both before_height and before_id (the last row of the previous page), or neither';
  END IF;
${OPERATOR_SCOPE_CHECK}
  IF kind = 'supplier' THEN
    -- checked here so the errors name addresses, the argument the caller passed, not _supplier_ids' suppliers
    IF num_nonnulls(addresses, owners, operators) <> 1 THEN
      RAISE EXCEPTION 'pass one of addresses, owners (the suppliers they own now) or operators (the suppliers that share revenue with them now)';
    END IF;
    PERFORM ${s}._validate(addresses, CASE WHEN addresses IS NULL THEN '' ELSE 'addresses' END, range_start, range_end, NULL);
${scopedSupplierIds(s, "addresses", true, "range_start", "range_end", "    ")}
  ELSE
    IF num_nonnulls(owners, operators) > 0 THEN
      RAISE EXCEPTION 'owners and operators apply to kind supplier';
    END IF;
    PERFORM ${s}._validate(addresses, 'addresses', range_start, range_end, NULL);
    ids := addresses;
  END IF;
${covered(null, true)}
  rg := ${s}._block_heights(range_start, range_end);
  IF rg.lo IS NULL OR rg.hi IS NULL OR rg.lo > rg.hi THEN RETURN; END IF;
  bh := coalesce(before_height, 9223372036854775807);
  RETURN QUERY
  WITH e(height, actor_id, event, id, transaction_id, stake_upokt, owner_id, reason, unbonding_end_height,
         session_end_height, service_id, application_id, session_id, penalty_upokt, previous_stake_upokt,
         proof_validation_status, gateway_id) AS (
${lifecycleBranches(s)}
  )
  SELECT e.height::bigint, bl.timestamp AT TIME ZONE 'UTC', e.actor_id, e.event, e.id, e.transaction_id, e.stake_upokt,
         e.owner_id, e.reason, e.unbonding_end_height::bigint, e.session_end_height::bigint, e.service_id,
         e.application_id, e.session_id, e.penalty_upokt, e.previous_stake_upokt, e.proof_validation_status,
         e.gateway_id, cv.covered_from, cv.covered_to, cv.gaps
  FROM e JOIN ${s}.blocks bl ON bl.id = e.height
  ORDER BY e.height DESC, e.id DESC LIMIT row_limit;
END $$;

-- Morse claims one by one, newest first: an account's balance (account), an application's or a supplier's stake and
-- balance (application, supplier: shannon_dest_address as the chain records it, from the claimed account, its operator, the services it claimed), and the
-- authority's recoveries (recover). Filters, combined: morse_addresses (up to 200, hex in any case: the indexer stores it lowercased),
-- shannon_addresses (up to 200: the destination; for a supplier its owner or operator), kinds (NULL = all). The four
-- message tables are small (8.8k supplier claims, 1.6k account claims, 0.6k recoveries on mainnet, 2026-10-14), so a
-- read with no list sorts them whole. Keyset paging on (height, id), like get_actor_lifecycle. Covers the indexed
-- blocks. The accounts that can be claimed are the morseClaimableAccounts list, and get_morse_claim_summary sums them.
CREATE OR REPLACE FUNCTION ${s}.get_morse_claims(morse_addresses text[], shannon_addresses text[],
  range_start timestamptz, range_end timestamptz, kinds text[] DEFAULT NULL, row_limit integer DEFAULT 100,
  before_height bigint DEFAULT NULL, before_id text DEFAULT NULL)
RETURNS TABLE(height bigint, block_time timestamptz, kind text, id text, transaction_id text, morse_src_address text,
  shannon_dest_address text, shannon_operator_address text, shannon_signing_address text, morse_node_address text,
  balance_upokt numeric, stake_upokt numeric, service_ids text[], claim_signer_type text, is_admin boolean,
  covered_from timestamptz, covered_to timestamptz, covered_gaps jsonb)
LANGUAGE plpgsql STABLE SET plan_cache_mode = force_custom_plan AS $$
DECLARE cv record; rg record; bh numeric; morse_lc text[];
BEGIN
  PERFORM ${s}._validate(NULL, '', range_start, range_end, NULL);
  IF morse_addresses IS NOT NULL THEN
    PERFORM ${s}._validate(morse_addresses, 'morse_addresses', NULL, NULL, NULL);
    morse_lc := ARRAY(SELECT lower(a) FROM unnest(morse_addresses) a);
  END IF;
  IF shannon_addresses IS NOT NULL THEN PERFORM ${s}._validate(shannon_addresses, 'shannon_addresses', NULL, NULL, NULL); END IF;
  IF kinds IS NOT NULL AND NOT kinds <@ ARRAY[${MORSE_BRANCHES.map((b) => `'${b.kind}'`).join(", ")}] THEN
    RAISE EXCEPTION 'kinds takes ${MORSE_BRANCHES.map((b) => b.kind).join(", ")} (has %)', kinds;
  END IF;
  IF row_limit IS NULL OR row_limit < 1 OR row_limit > 1000 THEN
    RAISE EXCEPTION 'row_limit must be between 1 and 1000 (has %); page with before_height / before_id', row_limit;
  END IF;
  IF (before_height IS NULL) <> (before_id IS NULL) THEN
    RAISE EXCEPTION 'pass both before_height and before_id (the last row of the previous page), or neither';
  END IF;
${covered(null, true)}
  rg := ${s}._block_heights(range_start, range_end);
  IF rg.lo IS NULL OR rg.hi IS NULL OR rg.lo > rg.hi THEN RETURN; END IF;
  bh := coalesce(before_height, 9223372036854775807);
  RETURN QUERY
  WITH c(height, kind, id, ${Object.keys(MORSE_COLUMNS).join(", ")}) AS (
${morseBranches(s)}
  )
  SELECT c.height::bigint, bl.timestamp AT TIME ZONE 'UTC', c.kind, c.id, c.transaction_id, c.morse_src_address,
         -- a supplier claim's destination as the chain records it: the claimed account's shannon_dest_address (the
         -- supplier address before poktroll v0.1.20, then the address the stake was minted to), one probe of the GiST
         -- on (claimed_msg_id, _block_range); 8,767 of 8,767 mainnet supplier claims have their account row
         CASE WHEN c.kind = 'supplier' THEN (SELECT a.shannon_dest_address::text FROM ${s}.morse_claimable_accounts a
                                             WHERE a.claimed_msg_id = c.id AND upper_inf(a._block_range) LIMIT 1)
              ELSE c.shannon_dest_address END,
         c.shannon_operator_address, c.shannon_signing_address, c.morse_node_address,
         c.balance_upokt, c.stake_upokt,
         CASE c.kind
           WHEN 'supplier' THEN ARRAY(SELECT DISTINCT sv.service_id FROM ${s}.msg_claim_morse_supplier_services sv
                                      WHERE sv.claim_msg_id = c.id ORDER BY 1)
           WHEN 'application' THEN ARRAY(SELECT DISTINCT sv.service_id FROM ${s}.msg_claim_morse_application_services sv
                                         WHERE sv.claim_msg_id = c.id ORDER BY 1)
         END,
         c.claim_signer_type, c.is_admin, cv.covered_from, cv.covered_to, cv.gaps
  FROM c JOIN ${s}.blocks bl ON bl.id = c.height
  ORDER BY c.height DESC, c.id DESC LIMIT row_limit;
END $$;

-- Block statistics per bucket from the blocks' own report columns (the indexer fills them per block): blocks, the
-- heights they span, transactions (total, successful, failed), relays and compute units (claimed and estimated), and
-- the time between blocks and the block size. Covers the indexed blocks. The whole chain is one parallel scan of
-- blocks (963k rows, 188 ms on the mainnet replica, 2026-10-13); a range reads idx_blocks_timestamp_id (24 hours by
-- hour 6 ms, 92 days by day 214 ms). A block whose previous one is not indexed has time_to_block 0
-- (update_block_took), which is no interval: the average and the minimum leave it out. time_to_block is bigint on
-- mainnet and numeric on beta (measured 2026-10-14), hence the casts.
CREATE OR REPLACE FUNCTION ${s}.get_block_stats(range_start timestamptz, range_end timestamptz, bucket text DEFAULT NULL)
RETURNS TABLE(bucket_start timestamptz, bucket_end timestamptz, blocks bigint, first_height bigint, last_height bigint,
  total_txs numeric, successful_txs numeric, failed_txs numeric, relays numeric, estimated_relays numeric,
  compute_units numeric, estimated_compute_units numeric, avg_time_to_block_ms numeric, min_time_to_block_ms numeric,
  max_time_to_block_ms numeric, avg_size_bytes numeric, covered_from timestamptz, covered_to timestamptz,
  covered_gaps jsonb)
LANGUAGE plpgsql STABLE SET plan_cache_mode = force_custom_plan AS $$
DECLARE sp record; cv record;
BEGIN
  PERFORM ${s}._validate(NULL, '', range_start, range_end, bucket);
${covered("blocks", true)}
  RETURN QUERY SELECT q.*, cv.covered_from, cv.covered_to, cv.gaps FROM (
    SELECT ${s}._bucket(bucket, bl.timestamp AT TIME ZONE 'UTC', sp.f) b_start,
           ${s}._bucket_end(bucket, bl.timestamp AT TIME ZONE 'UTC', sp.t) b_end,
           count(*)::bigint, min(bl.id)::bigint, max(bl.id)::bigint, sum(bl.total_txs)::numeric,
           sum(bl.successful_txs)::numeric, sum(bl.failed_txs)::numeric, sum(bl.total_relays), sum(bl.total_estimated_relays),
           sum(bl.total_computed_units), sum(bl.total_estimated_computed_units), round(avg(bl.time_to_block) FILTER (WHERE bl.time_to_block > 0), 3),
           min(bl.time_to_block) FILTER (WHERE bl.time_to_block > 0)::numeric, max(bl.time_to_block)::numeric, round(avg(bl.size), 3)
    FROM ${s}.blocks bl
    WHERE bl.timestamp >= range_start AT TIME ZONE 'UTC' AND bl.timestamp < range_end AT TIME ZONE 'UTC'
    GROUP BY 1, 2
  ) q ORDER BY 1 DESC;
END $$;

-- Transactions per message type and status over a range, without counting the transactions table (tx_counts_daily,
-- txCounts.ts): msg_type is a message type URL (a transaction counts under each one it holds) or '*', every
-- transaction; status is success (code 0) or failed. msg_types and statuses filter (NULL: every row). The UTC days
-- inside the range come from the rollup (one PK range read), the partial days at its ends from their blocks (the
-- blocks' own totals when only '*' is asked, else their transactions: up to two days of them, 250 ms a day on the mainnet
-- replica, 2026-10-10). A full day with blocks the rollup does not hold is a gap, not a zero (covered_gaps; a day without
-- blocks has nothing to hold, mainnet 2025-05-01..06), until the backfill has written it (scripts/fill_tx_counts_daily.sql):
-- its rows are the rollup's, which holds the blocks first_height..last_height of each day. A range with nothing in the rollup and gaps answers one row of NULLs that carries them. Covers the
-- indexed blocks (covered(..., true)).
CREATE OR REPLACE FUNCTION ${s}.get_tx_counts(range_start timestamptz, range_end timestamptz, msg_types text[] DEFAULT NULL,
  statuses text[] DEFAULT NULL)
RETURNS TABLE(msg_type text, status text, txs bigint, first_height bigint, last_height bigint, covered_from timestamptz,
  covered_to timestamptz, covered_gaps jsonb)
LANGUAGE plpgsql STABLE SET plan_cache_mode = force_custom_plan SET jit = off AS $$
DECLARE cv record; f timestamp; t timestamp; d1 date; d2 date; gp jsonb := '[]'; star_only boolean;
  ea timestamp[]; eb timestamp[];
BEGIN
  PERFORM ${s}._validate(NULL, '', range_start, range_end, NULL);
  IF msg_types IS NOT NULL THEN PERFORM ${s}._validate(msg_types, 'msg_types', NULL, NULL, NULL); END IF;
  IF statuses IS NOT NULL AND (cardinality(statuses) < 1 OR NOT statuses <@ ARRAY['success', 'failed']) THEN
    RAISE EXCEPTION 'statuses must be a list of success and failed';
  END IF;
  -- what is not written is not read: the covered part of the range only (_coverage)
  cv := ${s}._coverage(range_start, range_end, true);
  IF cv.empty THEN RETURN; END IF;
  range_start := cv.data_from;
  range_end := least(range_end, cv.covered_to);
  f := range_start AT TIME ZONE 'UTC'; t := range_end AT TIME ZONE 'UTC';
  -- the full UTC days [d1, d2) come from the rollup; the ends of the range (or all of it) from the blocks
  d1 := (date_trunc('day', f) + CASE WHEN f = date_trunc('day', f) THEN interval '0' ELSE interval '1 day' END)::date;
  d2 := date_trunc('day', t)::date;
  IF d1 < d2 THEN
    ea := ARRAY[f, d2::timestamp]; eb := ARRAY[d1::timestamp, t];
    SELECT coalesce(jsonb_agg(jsonb_build_object('from', g.a AT TIME ZONE 'UTC', 'to', g.b AT TIME ZONE 'UTC') ORDER BY g.a), '[]')
    INTO gp
    FROM (SELECT min(m.day)::timestamp a, (max(m.day) + 1)::timestamp b
          FROM (SELECT d::date AS day, d::date - (row_number() OVER (ORDER BY d))::int AS grp
                FROM generate_series(d1, d2 - 1, interval '1 day') d
                WHERE NOT EXISTS (SELECT 1 FROM ${s}.tx_counts_daily x WHERE x.day = d::date)
                  -- a day without blocks has nothing to hold (mainnet 2025-05-01..06): no gap
                  AND EXISTS (SELECT 1 FROM ${s}.blocks bl WHERE bl.timestamp >= d AND bl.timestamp < d + interval '1 day')) m
          GROUP BY m.grp) g;
  ELSE
    ea := ARRAY[f]; eb := ARRAY[t];
  END IF;
  gp := coalesce(cv.gaps, '[]'::jsonb) || gp;
  star_only := msg_types IS NOT NULL AND msg_types <@ ARRAY['*'];
  RETURN QUERY
  WITH edges AS (SELECT u.a, u.b FROM unnest(ea, eb) u(a, b) WHERE u.a < u.b),
  rolled AS (
    SELECT d.msg_type, d.status, d.txs, d.first_height, d.last_height
    FROM ${s}.tx_counts_daily d
    WHERE d1 < d2 AND d.day >= d1 AND d.day < d2
      AND (get_tx_counts.msg_types IS NULL OR d.msg_type = ANY(get_tx_counts.msg_types))
      AND (get_tx_counts.statuses IS NULL OR d.status = ANY(get_tx_counts.statuses))
  ),
  edge_all AS (
    SELECT c.msg_type, c.status, c.txs, q.lo first_height, q.hi last_height
    FROM edges e
    CROSS JOIN LATERAL (SELECT min(bl.id)::bigint lo, max(bl.id)::bigint hi
                        FROM (SELECT id FROM ${s}.blocks WHERE timestamp >= e.a AND timestamp < e.b OFFSET 0) bl) q
    CROSS JOIN LATERAL ${s}._tx_counts_of_blocks(q.lo, q.hi) c
    WHERE NOT star_only AND q.lo IS NOT NULL
      AND (get_tx_counts.msg_types IS NULL OR c.msg_type = ANY(get_tx_counts.msg_types))
      AND (get_tx_counts.statuses IS NULL OR c.status = ANY(get_tx_counts.statuses))
  ),
  edge_star AS (
    SELECT '*'::text msg_type, s.status, sum(CASE s.status WHEN 'success' THEN bl.successful_txs ELSE bl.failed_txs END)::bigint txs,
           min(bl.id)::bigint first_height, max(bl.id)::bigint last_height
    FROM edges e
    JOIN ${s}.blocks bl ON bl.timestamp >= e.a AND bl.timestamp < e.b
    CROSS JOIN (VALUES ('success'), ('failed')) s(status)
    WHERE star_only AND (get_tx_counts.statuses IS NULL OR s.status = ANY(get_tx_counts.statuses))
    GROUP BY s.status
  ),
  parts AS (SELECT * FROM rolled UNION ALL SELECT * FROM edge_all UNION ALL SELECT * FROM edge_star)
  SELECT p.msg_type, p.status, sum(p.txs)::bigint, min(p.first_height)::bigint, max(p.last_height)::bigint,
         cv.covered_from, cv.covered_to, gp
  FROM parts p
  GROUP BY p.msg_type, p.status
  ORDER BY p.msg_type, p.status;
  IF NOT FOUND AND jsonb_array_length(gp) > 0 THEN
    -- nothing to read but gaps: one row of NULLs, which carries them (an empty answer would report the range as covered)
    RETURN QUERY SELECT NULL::text, NULL::text, NULL::bigint, NULL::bigint, NULL::bigint, cv.covered_from, cv.covered_to, gp;
  END IF;
END $$;

-- Staked suppliers per service over a range, without summing staked_suppliers_by_block_and_services
-- (staked_suppliers_daily, stakedSuppliersDaily.ts): blocks = the blocks with a row for the service, suppliers_staked = the
-- staked suppliers summed over them (divide by blocks for the average per block), as
-- get_amount_of_blocks_and_suppliers_by_times gives them (the rollup's '*' rows only mark a day as held). services
-- filters (NULL: every service). The UTC days inside the range come from the rollup, the partial days at its ends from
-- their blocks' rows, read as _blocks_and_suppliers_by_service reads them: each end's first and last block by two probes
-- of idx_blocks_timestamp_id, then count(*) / sum over that id range inside RETURN QUERY, where the scan can run
-- parallel (24 hours: 40-60 ms with 4 workers on the mainnet replica, 2026-10-20, against ~100 ms in one process and
-- ~290 ms through _staked_suppliers_of_blocks' materialized rows); a full day with blocks the rollup does not hold is a
-- gap, not a zero (covered_gaps), until the backfill has written it (scripts/fill_staked_suppliers_daily.sql). A range
-- with nothing in the rollup and gaps answers one row of NULLs that carries them. Covers the indexed blocks
-- (covered(..., true)), as get_tx_counts.
CREATE OR REPLACE FUNCTION ${s}.get_staked_suppliers_by_service(range_start timestamptz, range_end timestamptz,
  services text[] DEFAULT NULL)
RETURNS TABLE(service_id text, blocks bigint, suppliers_staked bigint, first_height bigint, last_height bigint,
  covered_from timestamptz, covered_to timestamptz, covered_gaps jsonb)
LANGUAGE plpgsql STABLE SET plan_cache_mode = force_custom_plan SET jit = off AS $$
DECLARE cv record; f timestamp; t timestamp; d1 date; d2 date; gp jsonb := '[]'; ea timestamp[]; eb timestamp[];
  lo1 bigint; hi1 bigint; lo2 bigint; hi2 bigint;
BEGIN
  PERFORM ${s}._validate(NULL, '', range_start, range_end, NULL);
  IF services IS NOT NULL THEN PERFORM ${s}._validate(services, 'services', NULL, NULL, NULL); END IF;
  -- what is not written is not read: the covered part of the range only (_coverage)
  cv := ${s}._coverage(range_start, range_end, true);
  IF cv.empty THEN RETURN; END IF;
  range_start := cv.data_from;
  range_end := least(range_end, cv.covered_to);
  f := range_start AT TIME ZONE 'UTC'; t := range_end AT TIME ZONE 'UTC';
  -- the full UTC days [d1, d2) come from the rollup; the ends of the range (or all of it) from the blocks' rows
  d1 := (date_trunc('day', f) + CASE WHEN f = date_trunc('day', f) THEN interval '0' ELSE interval '1 day' END)::date;
  d2 := date_trunc('day', t)::date;
  IF d1 < d2 THEN
    ea := ARRAY[f, d2::timestamp]; eb := ARRAY[d1::timestamp, t];
    SELECT coalesce(jsonb_agg(jsonb_build_object('from', g.a AT TIME ZONE 'UTC', 'to', g.b AT TIME ZONE 'UTC') ORDER BY g.a), '[]')
    INTO gp
    FROM (SELECT min(m.day)::timestamp a, (max(m.day) + 1)::timestamp b
          FROM (SELECT d::date AS day, d::date - (row_number() OVER (ORDER BY d))::int AS grp
                FROM generate_series(d1, d2 - 1, interval '1 day') d
                WHERE NOT EXISTS (SELECT 1 FROM ${s}.staked_suppliers_daily x WHERE x.day = d::date)
                  -- a day without blocks has nothing to hold (mainnet 2025-05-01..06): no gap
                  AND EXISTS (SELECT 1 FROM ${s}.blocks bl WHERE bl.timestamp >= d AND bl.timestamp < d + interval '1 day')) m
          GROUP BY m.grp) g;
  ELSE
    ea := ARRAY[f]; eb := ARRAY[t];
  END IF;
  gp := coalesce(cv.gaps, '[]'::jsonb) || gp;
  -- each end's first and last block (NULL: no block there)
  IF ea[1] < eb[1] THEN
    SELECT bl.id INTO lo1 FROM ${s}.blocks bl WHERE bl.timestamp >= ea[1] AND bl.timestamp < eb[1] ORDER BY bl.timestamp, bl.id LIMIT 1;
    SELECT bl.id INTO hi1 FROM ${s}.blocks bl WHERE bl.timestamp >= ea[1] AND bl.timestamp < eb[1] ORDER BY bl.timestamp DESC, bl.id DESC LIMIT 1;
  END IF;
  IF cardinality(ea) > 1 AND ea[2] < eb[2] THEN
    SELECT bl.id INTO lo2 FROM ${s}.blocks bl WHERE bl.timestamp >= ea[2] AND bl.timestamp < eb[2] ORDER BY bl.timestamp, bl.id LIMIT 1;
    SELECT bl.id INTO hi2 FROM ${s}.blocks bl WHERE bl.timestamp >= ea[2] AND bl.timestamp < eb[2] ORDER BY bl.timestamp DESC, bl.id DESC LIMIT 1;
  END IF;
  RETURN QUERY
  WITH parts AS (
    SELECT d.service_id, d.blocks, d.suppliers_staked, d.first_height, d.last_height
    FROM ${s}.staked_suppliers_daily d
    WHERE d1 < d2 AND d.day >= d1 AND d.day < d2 AND d.service_id <> '*'
      AND (get_staked_suppliers_by_service.services IS NULL OR d.service_id = ANY(get_staked_suppliers_by_service.services))
    UNION ALL
    -- one row per block and service (upsert_staked_suppliers_by_block_and_services), so count(*) counts blocks
    SELECT ss.service_id, count(*)::bigint, sum(ss.amount)::bigint, lo1, hi1
    FROM ${s}.staked_suppliers_by_block_and_services ss
    WHERE ss.block_id BETWEEN lo1 AND hi1
      AND (get_staked_suppliers_by_service.services IS NULL OR ss.service_id = ANY(get_staked_suppliers_by_service.services))
    GROUP BY ss.service_id
    UNION ALL
    SELECT ss.service_id, count(*)::bigint, sum(ss.amount)::bigint, lo2, hi2
    FROM ${s}.staked_suppliers_by_block_and_services ss
    WHERE ss.block_id BETWEEN lo2 AND hi2
      AND (get_staked_suppliers_by_service.services IS NULL OR ss.service_id = ANY(get_staked_suppliers_by_service.services))
    GROUP BY ss.service_id
  )
  SELECT p.service_id, sum(p.blocks)::bigint, sum(p.suppliers_staked)::bigint, min(p.first_height)::bigint,
         max(p.last_height)::bigint, cv.covered_from, cv.covered_to, gp
  FROM parts p
  GROUP BY p.service_id
  ORDER BY p.service_id;
  IF NOT FOUND AND jsonb_array_length(gp) > 0 THEN
    -- nothing to read but gaps: one row of NULLs, which carries them (an empty answer would report the range as covered)
    RETURN QUERY SELECT NULL::text, NULL::bigint, NULL::bigint, NULL::bigint, NULL::bigint, cv.covered_from, cv.covered_to, gp;
  END IF;
END $$;

-- The supply per bucket at its point, the bucket's last block with an upokt supply inside the range (supplyDaily.ts):
-- height and block_time; network_supply_upokt, the upokt supply recorded at that block; unmigrated_upokt, the Morse
-- balances not claimed at that block; total_supply_upokt, their sum; as get_supply_composition_between_dates and
-- get_total_supply_by_day give them. bucket = day (default), week, month or year, in UTC; NULL = one row at the range's
-- last point, get_total_supply_between_dates' snapshot (bucket_start / bucket_end = the range). A bucket whose point is a full
-- day inside the range reads it from supply_daily; the partial days at the ends of the range are computed live by
-- _supply_at, the computation the rollup is written with. A full day the rollup does not hold is a gap (covered_gaps):
-- its bucket has no row, never an earlier point, until the backfill has written it (scripts/fill_supply_daily.sql). A
-- range with no row and gaps answers one row of NULLs that carries them. Covers the indexed blocks.
CREATE OR REPLACE FUNCTION ${s}.get_supply(range_start timestamptz, range_end timestamptz, bucket text DEFAULT 'day')
RETURNS TABLE(bucket_start timestamptz, bucket_end timestamptz, height bigint, block_time timestamptz,
  network_supply_upokt numeric, unmigrated_upokt numeric, total_supply_upokt numeric, covered_from timestamptz,
  covered_to timestamptz, covered_gaps jsonb)
LANGUAGE plpgsql STABLE SET plan_cache_mode = force_custom_plan SET jit = off AS $$
DECLARE cv record; f timestamp; t timestamp; gp jsonb;
BEGIN
  IF bucket IS NOT NULL AND bucket NOT IN ('day', 'week', 'month', 'year') THEN
    RAISE EXCEPTION 'bucket must be day, week, month, year or NULL (got %)', bucket;
  END IF;
  PERFORM ${s}._validate(NULL, '', range_start, range_end, NULL);
  -- what is not written is not read: the covered part of the range only (_coverage)
  cv := ${s}._coverage(range_start, range_end, true);
  IF cv.empty THEN RETURN; END IF;
  range_start := cv.data_from;
  range_end := least(range_end, cv.covered_to);
  f := range_start AT TIME ZONE 'UTC'; t := range_end AT TIME ZONE 'UTC';
  gp := coalesce(cv.gaps, '[]'::jsonb) || ${s}._supply_gaps(f, t, bucket);
  RETURN QUERY
  SELECT ${s}._bucket(bucket, p.bucket_start AT TIME ZONE 'UTC', coalesce(cv.requested_from, cv.covered_from)),
         ${s}._bucket_end(bucket, p.bucket_start AT TIME ZONE 'UTC', range_end),
         p.height, (SELECT bl.timestamp AT TIME ZONE 'UTC' FROM ${s}.blocks bl WHERE bl.id = p.height LIMIT 1),
         CASE p.kind WHEN 'rollup' THEN sd.network_supply_upokt ELSE l.network_supply_upokt END,
         CASE p.kind WHEN 'rollup' THEN sd.unmigrated_upokt ELSE l.unmigrated_upokt END,
         CASE p.kind WHEN 'rollup' THEN sd.total_supply_upokt ELSE l.total_supply_upokt END,
         cv.covered_from, cv.covered_to, gp
  FROM ${s}._supply_points(f, t, bucket) p
  LEFT JOIN ${s}.supply_daily sd ON p.kind = 'rollup' AND sd.day = p.day
  -- computed only for the live points (a one-time filter), without the composition and from the rollup's nearest day
  LEFT JOIN LATERAL (SELECT * FROM ${s}._supply_at(p.height, false, true) WHERE p.kind = 'live') l ON true
  WHERE p.kind <> 'gap'
  ORDER BY 1 DESC;
  IF NOT FOUND AND jsonb_array_length(gp) > 0 THEN
    RETURN QUERY SELECT NULL::timestamptz, NULL::timestamptz, NULL::bigint, NULL::timestamptz, NULL::numeric, NULL::numeric,
      NULL::numeric, cv.covered_from, cv.covered_to, gp;
  END IF;
END $$;

-- The supply composition per bucket at the same point as get_supply (height): one row per label, the upokt balances at
-- that block by module account name, 'dao' (the tokenomics dao_reward_address at that block), 'wrapped' (the bridge
-- address) or 'others', as get_supply_composition_between_dates gives them under network_supply_composition. Read as
-- get_supply: from supply_composition_daily, the partial days live by _supply_at, a day not held is a gap.
CREATE OR REPLACE FUNCTION ${s}.get_supply_composition(range_start timestamptz, range_end timestamptz, bucket text DEFAULT 'day')
RETURNS TABLE(bucket_start timestamptz, bucket_end timestamptz, height bigint, block_time timestamptz, label text,
  amount_upokt numeric, covered_from timestamptz, covered_to timestamptz, covered_gaps jsonb)
LANGUAGE plpgsql STABLE SET plan_cache_mode = force_custom_plan SET jit = off AS $$
DECLARE cv record; f timestamp; t timestamp; gp jsonb;
BEGIN
  IF bucket IS NULL OR bucket NOT IN ('day', 'week', 'month', 'year') THEN
    RAISE EXCEPTION 'bucket must be day, week, month or year (got %)', coalesce(bucket, 'NULL');
  END IF;
  PERFORM ${s}._validate(NULL, '', range_start, range_end, NULL);
  -- what is not written is not read: the covered part of the range only (_coverage)
  cv := ${s}._coverage(range_start, range_end, true);
  IF cv.empty THEN RETURN; END IF;
  range_start := cv.data_from;
  range_end := least(range_end, cv.covered_to);
  f := range_start AT TIME ZONE 'UTC'; t := range_end AT TIME ZONE 'UTC';
  gp := coalesce(cv.gaps, '[]'::jsonb) || ${s}._supply_gaps(f, t, bucket);
  RETURN QUERY
  SELECT ${s}._bucket(bucket, p.bucket_start AT TIME ZONE 'UTC', NULL), ${s}._bucket_end(bucket, p.bucket_start AT TIME ZONE 'UTC', NULL),
         p.height, (SELECT bl.timestamp AT TIME ZONE 'UTC' FROM ${s}.blocks bl WHERE bl.id = p.height LIMIT 1),
         x.label, x.amount_upokt, cv.covered_from, cv.covered_to, gp
  FROM ${s}._supply_points(f, t, bucket) p
  LEFT JOIN LATERAL (SELECT * FROM ${s}._supply_at(p.height) WHERE p.kind = 'live') l ON true
  CROSS JOIN LATERAL (
    SELECT c.label, c.amount_upokt FROM ${s}.supply_composition_daily c WHERE p.kind = 'rollup' AND c.day = p.day
    UNION ALL
    SELECT e.key, e.value::numeric FROM jsonb_each_text(l.composition) e WHERE p.kind = 'live'
  ) x(label, amount_upokt)
  WHERE p.kind <> 'gap'
  ORDER BY 1 DESC, 5;
  IF NOT FOUND AND jsonb_array_length(gp) > 0 THEN
    RETURN QUERY SELECT NULL::timestamptz, NULL::timestamptz, NULL::bigint, NULL::timestamptz, NULL::text, NULL::numeric,
      cv.covered_from, cv.covered_to, gp;
  END IF;
END $$;

-- The supply and its composition at one block, live (_supply_at): the last block at or below at_height (NULL = the
-- latest) that has an upokt supply, whose height and block_time every row carries; one row per composition label, with
-- the totals of get_supply repeated on each.
CREATE OR REPLACE FUNCTION ${s}.get_supply_composition_at(at_height bigint DEFAULT NULL)
RETURNS TABLE(height bigint, block_time timestamptz, network_supply_upokt numeric, unmigrated_upokt numeric,
  total_supply_upokt numeric, label text, amount_upokt numeric)
LANGUAGE plpgsql STABLE SET plan_cache_mode = force_custom_plan SET jit = off AS $$
DECLARE h bigint;
BEGIN
  SELECT bl.id::bigint INTO h FROM ${s}.blocks bl
  WHERE (at_height IS NULL OR bl.id <= at_height)
    AND EXISTS (SELECT 1 FROM ${s}.block_supplies bs JOIN ${s}.supplies sp ON sp.id = bs.supply_id
                WHERE bs.block_id = bl.id AND sp.denom = 'upokt')
  ORDER BY bl.id DESC LIMIT 1;
  IF h IS NULL THEN RETURN; END IF;
  RETURN QUERY
  SELECT h, (SELECT bl.timestamp AT TIME ZONE 'UTC' FROM ${s}.blocks bl WHERE bl.id = h LIMIT 1),
         a.network_supply_upokt, a.unmigrated_upokt, a.total_supply_upokt, e.key, e.value::numeric
  FROM ${s}._supply_at(h) a
  LEFT JOIN LATERAL jsonb_each_text(a.composition) e ON true
  ORDER BY e.key;
END $$;

-- Network totals of the settled claims per bucket, from relay_by_block_and_services (the per-block, per-service sums of
-- event_claim_settleds that get_rewards_by_date reads): relays, compute units and claimed_upokt, and the first and last
-- height summed. The range's blocks are an id range (_block_heights), so the rows are read by block_id and only joined to
-- their block for the bucket; get_rewards_by_date joined every block of the range by time (30 days by day: 141 ms against
-- ~280 ms on the mainnet replica, 2026-10-20). Covers the indexed blocks.
CREATE OR REPLACE FUNCTION ${s}.get_network_rewards(range_start timestamptz, range_end timestamptz, bucket text DEFAULT NULL)
RETURNS TABLE(bucket_start timestamptz, bucket_end timestamptz, relays numeric, estimated_relays numeric,
  compute_units numeric, estimated_compute_units numeric, claimed_upokt numeric, first_height bigint, last_height bigint,
  covered_from timestamptz, covered_to timestamptz, covered_gaps jsonb)
LANGUAGE plpgsql STABLE SET plan_cache_mode = force_custom_plan SET jit = off AS $$
DECLARE sp record; cv record; rg record;
BEGIN
  PERFORM ${s}._validate(NULL, '', range_start, range_end, bucket);
${covered("blocks", true)}
  rg := ${s}._block_heights(range_start, range_end);
  IF rg.lo IS NULL OR rg.hi IS NULL OR rg.lo > rg.hi THEN RETURN; END IF;
  RETURN QUERY
  SELECT ${s}._bucket(bucket, bl.timestamp AT TIME ZONE 'UTC', sp.f), ${s}._bucket_end(bucket, bl.timestamp AT TIME ZONE 'UTC', sp.t),
         sum(r.relays), sum(r.estimated_relays), sum(r.computed_units), sum(r.estimated_computed_units), sum(r.claimed_upokt),
         min(r.block_id)::bigint, max(r.block_id)::bigint, cv.covered_from, cv.covered_to, cv.gaps
  FROM ${s}.relay_by_block_and_services r
  JOIN ${s}.blocks bl ON bl.id = r.block_id
  WHERE r.block_id BETWEEN rg.lo AND rg.hi
  GROUP BY 1, 2
  ORDER BY 1 DESC;
END $$;

-- Network claims per bucket, from claims_by_block (one row per block with claims created, settled or expired, as
-- get_claim_proofs_data_by_time sums them; claimProofs.ts): claims created (claims, claimed_*), settled (settled_*: the
-- old function's proof_*) and expired (expired_*), each with relays, compute units and upokt, and the first and last
-- height summed. The heights below claims_by_block_coverage.covered_from_height are not written yet (the history fill
-- walks down to them): they are a gap in covered_gaps, never zeros (get_claim_proofs_data_by_time read the raw tables
-- then; on mainnet the table holds every height, 2026-10-20). A range with nothing written but that gap answers one row
-- of NULLs that carries it. Covers the indexed blocks.
CREATE OR REPLACE FUNCTION ${s}.get_network_claims(range_start timestamptz, range_end timestamptz, bucket text DEFAULT NULL)
RETURNS TABLE(bucket_start timestamptz, bucket_end timestamptz, claims bigint, claimed_relays numeric,
  claimed_estimated_relays numeric, claimed_compute_units numeric, claimed_estimated_compute_units numeric,
  claimed_upokt numeric, settled_claims bigint, settled_relays numeric, settled_estimated_relays numeric,
  settled_compute_units numeric, settled_estimated_compute_units numeric, settled_upokt numeric, expired_claims bigint,
  expired_relays numeric, expired_estimated_relays numeric, expired_compute_units numeric,
  expired_estimated_compute_units numeric, expired_upokt numeric, first_height bigint, last_height bigint,
  covered_from timestamptz, covered_to timestamptz, covered_gaps jsonb)
LANGUAGE plpgsql STABLE SET plan_cache_mode = force_custom_plan SET jit = off AS $$
DECLARE sp record; cv record; gp jsonb; ch bigint; ct timestamptz; head numeric;
BEGIN
  PERFORM ${s}._validate(NULL, '', range_start, range_end, bucket);
${covered("blocks", true)}
  gp := cv.gaps;
  -- the first written height's block: what is before it in the range is not written
  SELECT c.covered_from_height INTO ch FROM ${s}.claims_by_block_coverage c;
  SELECT bl.timestamp AT TIME ZONE 'UTC' INTO ct FROM ${s}.blocks bl WHERE bl.id >= coalesce(ch, 9223372036854775807)
  ORDER BY bl.id LIMIT 1;
  IF ct IS NULL OR ct > range_start THEN
    gp := gp || jsonb_build_array(jsonb_build_object('from', range_start, 'to', least(coalesce(ct, range_end), range_end)));
    range_start := least(coalesce(ct, range_end), range_end);
  END IF;
  SELECT max(bl.id) INTO head FROM ${s}.blocks bl;
  RETURN QUERY
  SELECT ${s}._bucket(bucket, cb.timestamp AT TIME ZONE 'UTC', sp.f), ${s}._bucket_end(bucket, cb.timestamp AT TIME ZONE 'UTC', sp.t),
         sum(cb.claim_count)::bigint, sum(cb.claim_relays), sum(cb.claim_estimated_relays), sum(cb.claim_computed_units),
         sum(cb.claim_estimated_computed_units), sum(cb.claim_upokt), sum(cb.settled_count)::bigint, sum(cb.settled_relays),
         sum(cb.settled_estimated_relays), sum(cb.settled_computed_units), sum(cb.settled_estimated_computed_units),
         sum(cb.settled_upokt), sum(cb.expired_count)::bigint, sum(cb.expired_relays), sum(cb.expired_estimated_relays),
         sum(cb.expired_computed_units), sum(cb.expired_estimated_computed_units), sum(cb.expired_upokt),
         min(cb.block_id)::bigint, max(cb.block_id)::bigint, cv.covered_from, cv.covered_to, gp
  FROM ${s}.claims_by_block cb
  WHERE range_start < range_end
    AND cb.timestamp >= range_start AT TIME ZONE 'UTC' AND cb.timestamp < range_end AT TIME ZONE 'UTC'
    -- not the rows of heights a rewind removed, until the next write deletes them
    AND cb.block_id <= head
  GROUP BY 1, 2
  ORDER BY 1 DESC;
  IF NOT FOUND AND jsonb_array_length(gp) > 0 THEN
    RETURN QUERY SELECT NULL::timestamptz, NULL::timestamptz, NULL::bigint, NULL::numeric, NULL::numeric, NULL::numeric,
      NULL::numeric, NULL::numeric, NULL::bigint, NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric,
      NULL::bigint, NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric, NULL::numeric, NULL::bigint, NULL::bigint,
      cv.covered_from, cv.covered_to, gp;
  END IF;
END $$;

-- Overservicing of the suppliers that share revenue with the operators now (_operator_suppliers: an address in the
-- rev_share of a live service config of a Staked supplier, as get_overserviced_by_addresses_and_time), per bucket:
-- expected_burn_upokt and effective_burn_upokt summed over their application overservicing events
-- (event_application_overserviceds), the events and the first and last height. These are the events' own amounts:
-- get_supplier_earnings.overservicing_loss_upokt comes from the settlements and differs from them by ~1 ppm. Each
-- supplier's events through the GiST index on (supplier_id, _block_range) within the range's heights. Covers the indexed
-- blocks.
CREATE OR REPLACE FUNCTION ${s}.get_overserviced(operators text[], range_start timestamptz, range_end timestamptz,
  bucket text DEFAULT NULL)
RETURNS TABLE(bucket_start timestamptz, bucket_end timestamptz, expected_burn_upokt numeric, effective_burn_upokt numeric,
  events bigint, first_height bigint, last_height bigint, covered_from timestamptz, covered_to timestamptz,
  covered_gaps jsonb)
LANGUAGE plpgsql STABLE SET plan_cache_mode = force_custom_plan SET jit = off AS $$
DECLARE sp record; cv record; rg record; sup text[];
BEGIN
  PERFORM ${s}._validate(operators, 'operators', range_start, range_end, bucket);
${covered("blocks", true)}
  rg := ${s}._block_heights(range_start, range_end);
  IF rg.lo IS NULL OR rg.hi IS NULL OR rg.lo > rg.hi THEN RETURN; END IF;
  sup := ${s}._operator_suppliers(operators);
  RETURN QUERY
  SELECT ${s}._bucket(bucket, bl.timestamp AT TIME ZONE 'UTC', sp.f), ${s}._bucket_end(bucket, bl.timestamp AT TIME ZONE 'UTC', sp.t),
         sum(o.expected_burn), sum(o.effective_burn), count(*)::bigint, min(o.block_id)::bigint, max(o.block_id)::bigint,
         cv.covered_from, cv.covered_to, cv.gaps
  FROM unnest(sup) u(id)
  CROSS JOIN LATERAL (SELECT e.expected_burn, e.effective_burn, e.block_id FROM ${s}.event_application_overserviceds e
                      WHERE e.supplier_id = u.id AND e.block_id BETWEEN rg.lo AND rg.hi) o
  JOIN ${s}.blocks bl ON bl.id = o.block_id
  GROUP BY 1, 2
  ORDER BY 1 DESC;
END $$;

-- What the suppliers serving the domains (up to 200 endpoint root domains) earned per service, from
-- domain_service_daily_rewards (domainRewards.ts) summed over the UTC days that start inside [range_start, range_end), as
-- get_supplier_domains reads it: relays, compute units, claimed_upokt (the table's gross_rewards), first_day / last_day,
-- the first and last height of those days, and staked_suppliers = the distinct staked suppliers of the service's last
-- day read: with one domain its suppliers_count, as the old function; with several, the union of the sets the writer
-- stores beside the counts (domain_service_daily_suppliers), so a supplier on two of the domains counts once, and NULL
-- while a set of that day is not written yet (scripts/fill_domain_service_suppliers.sql). The old function took the
-- count of one of the domains, whichever its DISTINCT ON met first (it differed for 32 of 100 services over 7 days for 3
-- domains on mainnet, 2026-10-20). get_rewards_by_domains_and_time_group_by_service read the days from the date of
-- start_ts to the date of end_ts, both included: the same days as range_start = that first midnight and range_end = the
-- midnight after the last day.
-- Covers the indexed blocks.
CREATE OR REPLACE FUNCTION ${s}.get_domain_service_rewards(domains text[], range_start timestamptz, range_end timestamptz)
RETURNS TABLE(service_id text, staked_suppliers bigint, relays numeric, estimated_relays numeric, compute_units numeric,
  estimated_compute_units numeric, claimed_upokt numeric, first_day date, last_day date, first_height bigint,
  last_height bigint, covered_from timestamptz, covered_to timestamptz, covered_gaps jsonb)
LANGUAGE plpgsql STABLE SET plan_cache_mode = force_custom_plan SET jit = off AS $$
DECLARE cv record; d1 date; d2 date; one boolean;
BEGIN
  PERFORM ${s}._validate(domains, 'domains', range_start, range_end, NULL);
  one := (SELECT count(DISTINCT x) FROM unnest(domains) x) = 1;
${covered(null, true)}
  -- the days that start inside the range: [d1, d2]; from the requested start, as the first indexed block is later than
  -- the start of its day (the end is the covered one: the day of the latest block starts before it)
  d1 := coalesce((date_trunc('day', cv.requested_from AT TIME ZONE 'UTC')
         + CASE WHEN cv.requested_from AT TIME ZONE 'UTC' = date_trunc('day', cv.requested_from AT TIME ZONE 'UTC') THEN interval '0' ELSE interval '1 day' END)::date,
         '-infinity'::date);
  d2 := (date_trunc('day', (range_end AT TIME ZONE 'UTC') - interval '1 microsecond'))::date;
  IF d1 > d2 THEN RETURN; END IF;
  RETURN QUERY
  WITH d AS MATERIALIZED (
    SELECT x.*, max(x.day) OVER (PARTITION BY x.service_id) last_day FROM ${s}.domain_service_daily_rewards x
    WHERE x.domain = ANY(get_domain_service_rewards.domains) AND x.day BETWEEN d1 AND d2
  ),
  -- several domains: the union of the last day's sets per service; held = every row of that day has its set
  st AS (
    SELECT d.service_id, public.icount(${s}._supplier_nums_union(ss.supplier_nums))::bigint n, bool_and(ss.day IS NOT NULL) held
    FROM d
    LEFT JOIN ${s}.domain_service_daily_suppliers ss ON ss.day = d.day AND ss.domain = d.domain AND ss.service_id = d.service_id
    WHERE NOT one AND d.day = d.last_day
    GROUP BY d.service_id
  )
  SELECT g.service_id, CASE WHEN one THEN g.staked WHEN st.held THEN st.n END, g.relays, g.estimated_relays,
         g.compute_units, g.estimated_compute_units, g.claimed_upokt, g.first_day, g.last_day, g.first_height, g.last_height,
         cv.covered_from, cv.covered_to, cv.gaps
  FROM (
    SELECT d.service_id, (sum(d.suppliers_count) FILTER (WHERE d.day = d.last_day))::bigint staked,
           sum(d.relays)::numeric relays, sum(d.estimated_relays)::numeric estimated_relays,
           sum(d.computed_units)::numeric compute_units, sum(d.estimated_computed_units)::numeric estimated_compute_units,
           sum(d.gross_rewards) claimed_upokt, min(d.day) first_day, max(d.day) last_day,
           min(d.first_height)::bigint first_height, max(d.last_height)::bigint last_height
    FROM d GROUP BY d.service_id
  ) g
  LEFT JOIN st ON st.service_id = g.service_id
  ORDER BY g.service_id;
END $$;

-- Sessions of a list of suppliers (up to 200): per bucket (and per service with by_service), the distinct sessions in
-- which at least one of them settled a claim, from claim_settlements (session_id). settled_claims counts the claims, as
-- get_supplier_earnings does: three of the suppliers in one session are three claims and one session. A session's claims
-- settle at one height, so a session is in one bucket. Its own function rather than a column of get_supplier_earnings:
-- distinct sessions cannot be summed from the rollups that function reads, so it reads every settled claim of the range
-- (200 suppliers over 30 days: 274k claims, 0.6-1.0 s on the mainnet replica, 2026-10-20), a cost the earnings calls do
-- not pay. Per supplier the sessions are its claims, hence no by_supplier.
CREATE OR REPLACE FUNCTION ${s}.get_supplier_sessions(suppliers text[], range_start timestamptz, range_end timestamptz,
  bucket text DEFAULT NULL, by_service boolean DEFAULT false)
RETURNS TABLE(bucket_start timestamptz, bucket_end timestamptz, service_id text, sessions bigint, settled_claims bigint,
  first_settled_height bigint, last_settled_height bigint, covered_from timestamptz, covered_to timestamptz,
  covered_gaps jsonb)
LANGUAGE plpgsql STABLE SET plan_cache_mode = force_custom_plan SET jit = off AS $$
DECLARE sp record; cv record; lo bigint; hi bigint;
BEGIN
  PERFORM ${s}._validate(suppliers, 'suppliers', range_start, range_end, bucket);
${covered("settled")}
  SELECT min(sb.height), max(sb.height) INTO lo, hi FROM ${s}.settlement_blocks sb
  WHERE sb.block_time >= range_start AND sb.block_time < range_end;
  IF lo IS NULL THEN RETURN; END IF;
  RETURN QUERY
  SELECT ${s}._bucket(bucket, c.block_time, sp.f), ${s}._bucket_end(bucket, c.block_time, sp.t),
         CASE WHEN by_service THEN c.service_id ELSE 'all' END, count(DISTINCT c.session_id)::bigint, count(*)::bigint,
         min(c.height)::bigint, max(c.height)::bigint, cv.covered_from, cv.covered_to, cv.gaps
  FROM ${s}.claim_settlements c
  WHERE c.supplier_id = ANY(get_supplier_sessions.suppliers) AND c.height BETWEEN lo AND hi
  GROUP BY 1, 2, 3
  ORDER BY 1 DESC, 3;
END $$;

-- The staked suppliers of the domains (up to 200) among a list of suppliers (up to 200), per UTC day that starts inside
-- the range, domain and service: the stored set of the day (domain_service_daily_suppliers, domainRewards.ts)
-- intersected with the list's numbers (intarray &), staked_suppliers = how many of the listed suppliers were staked on it
-- that day and supplier_ids = which. It answers only for the listed suppliers: no row where none of them was staked, and
-- nothing about the others (no total of the domain). A day of the domains' rewards rows whose sets are not written yet is
-- a gap (covered_gaps), until scripts/fill_domain_service_suppliers.sql writes it; a range with nothing but such days
-- answers one row of NULLs that carries them. Covers the indexed blocks.
CREATE OR REPLACE FUNCTION ${s}.get_domain_staked_suppliers(suppliers text[], domains text[], range_start timestamptz,
  range_end timestamptz)
RETURNS TABLE(day date, domain text, service_id text, staked_suppliers bigint, supplier_ids text[], first_height bigint,
  last_height bigint, covered_from timestamptz, covered_to timestamptz, covered_gaps jsonb)
LANGUAGE plpgsql STABLE SET plan_cache_mode = force_custom_plan SET jit = off AS $$
DECLARE cv record; d1 date; d2 date; nums integer[]; gp jsonb;
BEGIN
  PERFORM ${s}._validate(suppliers, 'suppliers', range_start, range_end, NULL);
  PERFORM ${s}._validate(domains, 'domains', NULL, NULL, NULL);
${covered(null, true)}
  -- the days that start inside the range, as get_domain_service_rewards reads them
  d1 := coalesce((date_trunc('day', cv.requested_from AT TIME ZONE 'UTC')
         + CASE WHEN cv.requested_from AT TIME ZONE 'UTC' = date_trunc('day', cv.requested_from AT TIME ZONE 'UTC') THEN interval '0' ELSE interval '1 day' END)::date,
         '-infinity'::date);
  d2 := (date_trunc('day', (range_end AT TIME ZONE 'UTC') - interval '1 microsecond'))::date;
  IF d1 > d2 THEN RETURN; END IF;
  -- the listed suppliers' numbers, sorted (a supplier never staked on a domain has none)
  nums := ARRAY(SELECT n.supplier_num FROM ${s}.supplier_numbers n
                WHERE n.supplier_id = ANY(get_domain_staked_suppliers.suppliers) ORDER BY 1);
  -- the days with a rewards row of the domains that has no set yet
  SELECT coalesce(jsonb_agg(jsonb_build_object('from', g.a AT TIME ZONE 'UTC', 'to', g.b AT TIME ZONE 'UTC') ORDER BY g.a), '[]')
  INTO gp
  FROM (SELECT min(m.day)::timestamp a, (max(m.day) + 1)::timestamp b
        FROM (SELECT x.day, x.day - (row_number() OVER (ORDER BY x.day))::int AS grp
              FROM (SELECT DISTINCT r.day FROM ${s}.domain_service_daily_rewards r
                    WHERE r.domain = ANY(get_domain_staked_suppliers.domains) AND r.day BETWEEN d1 AND d2
                      AND NOT EXISTS (SELECT 1 FROM ${s}.domain_service_daily_suppliers t
                                      WHERE t.day = r.day AND t.domain = r.domain AND t.service_id = r.service_id)) x) m
        GROUP BY m.grp) g;
  gp := coalesce(cv.gaps, '[]'::jsonb) || gp;
  RETURN QUERY
  SELECT t.day, t.domain, t.service_id, public.icount(i.x)::bigint,
         ARRAY(SELECT n.supplier_id FROM unnest(i.x) u(num) JOIN ${s}.supplier_numbers n ON n.supplier_num = u.num ORDER BY 1),
         t.first_height, t.last_height, cv.covered_from, cv.covered_to, gp
  FROM ${s}.domain_service_daily_suppliers t
  CROSS JOIN LATERAL (SELECT t.supplier_nums OPERATOR(public.&) nums AS x) i
  WHERE t.domain = ANY(get_domain_staked_suppliers.domains) AND t.day BETWEEN d1 AND d2 AND public.icount(i.x) > 0
  ORDER BY t.day DESC, t.domain, t.service_id;
  IF NOT FOUND AND jsonb_array_length(gp) > 0 THEN
    RETURN QUERY SELECT NULL::date, NULL::text, NULL::text, NULL::bigint, NULL::text[], NULL::bigint, NULL::bigint,
      cv.covered_from, cv.covered_to, gp;
  END IF;
END $$;

-- The blocks a validator produced (kind produced: blocks.proposer_address, as get_produced_blocks_by_validator) or
-- missed (kind missed: a block_metadata last_commit whose signatures lack it, as get_missing_validator_blocks) between
-- from_height and to_height (NULL = the latest), newest first, with the block's time (NULL while the block row is not
-- written). validator_address is the address the old functions took (the consensus address in hex). At most row_limit
-- rows (default 100, up to 1000) per call: for the next page pass the last row's height as before_height. Each candidate
-- block is read backwards from the newest by its id index, so a page costs its rows (and, for missed, the blocks it
-- passes); from_height bounds the walk.
CREATE OR REPLACE FUNCTION ${s}.get_validator_blocks(validator_address text, from_height bigint, to_height bigint DEFAULT NULL,
  kind text DEFAULT 'produced', row_limit integer DEFAULT 100, before_height bigint DEFAULT NULL)
RETURNS TABLE(height bigint, block_time timestamptz)
LANGUAGE plpgsql STABLE SET plan_cache_mode = force_custom_plan SET jit = off AS $$
DECLARE hi numeric;
BEGIN
  IF validator_address IS NULL OR from_height IS NULL THEN
    RAISE EXCEPTION 'validator_address and from_height are required';
  END IF;
  IF kind IS NULL OR kind NOT IN ('produced', 'missed') THEN
    RAISE EXCEPTION 'kind must be produced or missed (got %)', coalesce(kind, 'NULL');
  END IF;
  IF row_limit IS NULL OR row_limit < 1 OR row_limit > 1000 THEN
    RAISE EXCEPTION 'row_limit must be between 1 and 1000 (has %); page with before_height', row_limit;
  END IF;
  hi := least(coalesce(to_height, 9223372036854775807), coalesce(before_height - 1, 9223372036854775807));
  IF kind = 'produced' THEN
    RETURN QUERY
    SELECT b.id::bigint, b.timestamp AT TIME ZONE 'UTC'
    FROM ${s}.blocks b
    WHERE b.id >= from_height AND b.id <= hi AND b.proposer_address = validator_address
    ORDER BY b.id DESC LIMIT row_limit;
  ELSE
    RETURN QUERY
    SELECT m.id::bigint, (SELECT b.timestamp AT TIME ZONE 'UTC' FROM ${s}.blocks b WHERE b.id = m.id LIMIT 1)
    FROM ${s}.block_metadata m
    WHERE m.id >= from_height AND m.id <= hi
      AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(m.last_commit->'signatures') AS sig
                      WHERE sig->>'validatorAddress' = validator_address)
    ORDER BY m.id DESC LIMIT row_limit;
  END IF;
END $$;

-- Supplier: what it generated, and the first and last settlement height of the claims of each row (the rollups'
-- first_height / last_height and the edge claims' heights; NULL when a rollup row of the group has a height whose bounds
-- it may not hold yet). By service without application, with no bucket or a month or year one, each UTC month
-- inside the rollup days comes from monthly_claims_by_supplier_service when that rollup holds every settlement of the month
-- (settlement_blocks.monthly_claims_rollup) and the month has none outside those days; the other days from
-- daily_claims_by_supplier_application_service. An owner of 1037 suppliers by service over its whole history read 3.07M
-- daily rows there (mainnet, 2026-10-09), and has 253k monthly ones. services (up to 200) keeps those services' claims,
-- read from the same per-service sources as by_service (also without it, which then sums them as 'all').
-- by_application rows carry gateway_ids, the application's gateways now, so a client needs no second read for them.
CREATE OR REPLACE FUNCTION ${s}.get_supplier_earnings(suppliers text[], range_start timestamptz, range_end timestamptz,
  bucket text DEFAULT NULL, by_service boolean DEFAULT false, by_application boolean DEFAULT false, by_supplier boolean DEFAULT true,
  owners text[] DEFAULT NULL, fill_empty_buckets boolean DEFAULT false, operators text[] DEFAULT NULL,
  services text[] DEFAULT NULL)
RETURNS TABLE(bucket_start timestamptz, bucket_end timestamptz, supplier_id text, service_id text, application_id text,
  claimed_upokt numeric, settled_upokt numeric, overservicing_loss_upokt numeric,
  relays numeric, estimated_relays numeric, compute_units numeric, estimated_compute_units numeric, settled_claims bigint,
  settled_claims_with_proof bigint, settled_claims_without_proof bigint, first_settled_height bigint,
  last_settled_height bigint, gateway_ids text[], covered_from timestamptz, covered_to timestamptz, covered_gaps jsonb)
LANGUAGE plpgsql STABLE SET enable_mergejoin = off SET plan_cache_mode = force_custom_plan AS $$
DECLARE rg record; sp record; all_suppliers boolean; cv record; fb timestamptz; use_month boolean; mm date[]; dd date[];
  nb date[]; nbm date[];
BEGIN
  -- NULL (no suppliers, owners or operators): every supplier
  suppliers := ${s}._supplier_ids(suppliers, owners, operators, false, range_start, range_end, bucket);
  all_suppliers := suppliers IS NULL;
  IF services IS NOT NULL THEN PERFORM ${s}._validate(services, 'services', NULL, NULL, NULL); END IF;
${covered("settled")}
  rg := ${s}._ranges(range_start, range_end, bucket);
  -- the rollup days, and their months, with a height whose first_height / last_height the rollups may not hold
  -- (settlement_blocks.bounds_rollup): a row of those reads as NULL height, and so does each group it is in
  nb := ARRAY(SELECT DISTINCT sb.day FROM ${s}.settlement_blocks sb WHERE NOT sb.bounds_rollup AND sb.day BETWEEN rg.d1 AND rg.d2);
  nbm := ARRAY(SELECT DISTINCT date_trunc('month', u::timestamp)::date FROM unnest(nb) u);
  -- the months read from monthly_claims_by_supplier_service (mm), and the rollup days left to the daily rollup (dd)
  use_month := (by_service OR services IS NOT NULL) AND NOT by_application AND coalesce(bucket, 'month') IN ('month', 'year') AND rg.d1 <= rg.d2;
  IF use_month THEN
    mm := ARRAY(SELECT m::date FROM generate_series(date_trunc('month', rg.d1::timestamp), date_trunc('month', rg.d2::timestamp), interval '1 month') m
                WHERE NOT EXISTS (SELECT 1 FROM ${s}.settlement_blocks sb
                                  WHERE sb.day >= m AND sb.day < m + interval '1 month' AND NOT sb.monthly_claims_rollup)
                  AND NOT EXISTS (SELECT 1 FROM ${s}.settlement_blocks sb WHERE sb.day >= m AND sb.day < rg.d1)
                  AND NOT EXISTS (SELECT 1 FROM ${s}.settlement_blocks sb WHERE sb.day > rg.d2 AND sb.day < m + interval '1 month'));
    use_month := cardinality(mm) > 0;
    -- each day as an array element: the btree takes it with the suppliers as index conditions (an owner's 1216
    -- suppliers over 24 days: 254k rows in 0.27 s on mainnet), where a join on day ranges was planned as a scan of
    -- every row of the suppliers (0.9 s for 8 days)
    dd := ARRAY(SELECT g::date FROM generate_series(rg.d1::timestamp, rg.d2::timestamp, interval '1 day') g
                WHERE date_trunc('month', g)::date <> ALL(mm));
  END IF;
  fb := CASE WHEN fill_empty_buckets THEN ${s}._first_bucket(bucket, sp.f, sp.t_last, cv.covered) END;
  RETURN QUERY WITH q AS (
  WITH res0(bucket_start, bucket_end, supplier_id, service_id, application_id, claimed_upokt, settled_upokt, overservicing_loss_upokt, relays, estimated_relays, compute_units, estimated_compute_units, settled_claims, settled_claims_with_proof, settled_claims_without_proof, first_settled_height, last_settled_height) AS (
  WITH r AS (
    -- without a breakdown the smaller daily_claims_by_supplier is enough (25x fewer rows over every supplier); services
    -- reads the per-service sources, as by_service does, and sums them as 'all' without it
    SELECT d.day::timestamp AT TIME ZONE 'UTC' block_time, d.supplier_id, ''::text service_id, ''::text application_id, d.claimed_upokt,
           d.settled_upokt, d.overservicing_loss_upokt, d.relays, d.estimated_relays, d.claimed_compute_units, d.estimated_compute_units,
           d.claim_count claims, d.claims_with_proof with_proof,
           CASE WHEN d.day <> ALL(nb) THEN d.first_height END fh, CASE WHEN d.day <> ALL(nb) THEN d.last_height END lh
    FROM ${s}.daily_claims_by_supplier d
    WHERE NOT (by_service OR by_application OR services IS NOT NULL) AND (all_suppliers OR d.supplier_id = ANY(suppliers)) AND d.day BETWEEN rg.d1 AND rg.d2
    UNION ALL
    SELECT d.day::timestamp AT TIME ZONE 'UTC', d.supplier_id, d.service_id, d.application_id, d.claimed_upokt, d.settled_upokt,
           d.overservicing_loss_upokt, d.relays, d.estimated_relays, d.claimed_compute_units, d.estimated_compute_units,
           d.claim_count, d.claims_with_proof,
           CASE WHEN d.day <> ALL(nb) THEN d.first_height END, CASE WHEN d.day <> ALL(nb) THEN d.last_height END
    FROM ${s}.daily_claims_by_supplier_application_service d
    WHERE (by_service OR by_application OR services IS NOT NULL) AND NOT use_month AND (all_suppliers OR d.supplier_id = ANY(suppliers))
      AND d.day BETWEEN rg.d1 AND rg.d2 AND (services IS NULL OR d.service_id = ANY(services))
    UNION ALL
    SELECT d.day::timestamp AT TIME ZONE 'UTC', d.supplier_id, d.service_id, '', d.claimed_upokt, d.settled_upokt,
           d.overservicing_loss_upokt, d.relays, d.estimated_relays, d.claimed_compute_units, d.estimated_compute_units,
           d.claim_count, d.claims_with_proof,
           CASE WHEN d.day <> ALL(nb) THEN d.first_height END, CASE WHEN d.day <> ALL(nb) THEN d.last_height END
    FROM ${s}.daily_claims_by_supplier_application_service d
    WHERE use_month AND (all_suppliers OR d.supplier_id = ANY(suppliers)) AND d.day = ANY(dd)
      AND (services IS NULL OR d.service_id = ANY(services))
    UNION ALL
    SELECT d.month::timestamp AT TIME ZONE 'UTC', d.supplier_id, d.service_id, '', d.claimed_upokt, d.settled_upokt,
           d.overservicing_loss_upokt, d.relays, d.estimated_relays, d.claimed_compute_units, d.estimated_compute_units,
           d.claim_count, d.claims_with_proof,
           CASE WHEN d.month <> ALL(nbm) THEN d.first_height END, CASE WHEN d.month <> ALL(nbm) THEN d.last_height END
    FROM ${s}.monthly_claims_by_supplier_service d
    WHERE use_month AND (all_suppliers OR d.supplier_id = ANY(suppliers)) AND d.month = ANY(mm)
      AND (services IS NULL OR d.service_id = ANY(services))
    UNION ALL
    SELECT c.block_time, c.supplier_id, c.service_id, c.application_id, c.claimed_upokt, c.settled_upokt,
           c.overservicing_loss_upokt, c.relays, c.estimated_relays, c.claimed_compute_units, c.estimated_compute_units, 1::bigint,
           c.settled_with_proof::int::bigint, c.height, c.height
    FROM ${s}.claim_settlements c
    WHERE (all_suppliers OR c.supplier_id = ANY(suppliers)) AND (c.height BETWEEN rg.lo1 AND rg.hi1 OR c.height BETWEEN rg.lo2 AND rg.hi2)
      AND (services IS NULL OR c.service_id = ANY(services))
  )
  SELECT ${s}._bucket(bucket, r.block_time, sp.f), ${s}._bucket_end(bucket, r.block_time, sp.t), CASE WHEN by_supplier THEN r.supplier_id ELSE 'all' END,
         CASE WHEN by_service THEN r.service_id ELSE 'all' END, CASE WHEN by_application THEN r.application_id ELSE 'all' END,
         sum(r.claimed_upokt)::numeric, sum(r.settled_upokt)::numeric, sum(r.overservicing_loss_upokt)::numeric,
         sum(r.relays)::numeric, sum(r.estimated_relays)::numeric, sum(r.claimed_compute_units)::numeric,
         sum(r.estimated_compute_units)::numeric, sum(r.claims)::bigint,
         sum(r.with_proof)::bigint, sum(r.claims - r.with_proof)::bigint,
         -- a height only when every row of the group holds its bounds
         CASE WHEN bool_and(r.fh IS NOT NULL) THEN min(r.fh) END, CASE WHEN bool_and(r.lh IS NOT NULL) THEN max(r.lh) END
  FROM r GROUP BY 1, 2, 3, 4, 5
  ), res(bucket_start, bucket_end, supplier_id, service_id, application_id, claimed_upokt, settled_upokt, overservicing_loss_upokt, relays, estimated_relays, compute_units, estimated_compute_units, settled_claims, settled_claims_with_proof, settled_claims_without_proof, first_settled_height, last_settled_height) AS (
  -- every requested id gets its row or series, 0 where it had no activity (not in the sparse output)
  SELECT * FROM res0
  UNION ALL
  SELECT ${s}._bucket(bucket, fb, sp.f), ${s}._bucket_end(bucket, fb, sp.t), u.id, 'all', 'all', 0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::bigint, 0::bigint, 0::bigint, NULL::bigint, NULL::bigint
  FROM (SELECT DISTINCT unnest(suppliers) id) u
  WHERE u.id IS NOT NULL AND fill_empty_buckets AND by_supplier AND fb IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM res0 r0 WHERE r0.supplier_id = u.id)
  UNION ALL
  -- the group total of a list with no activity at all: one zero row
  SELECT ${s}._bucket(bucket, fb, sp.f), ${s}._bucket_end(bucket, fb, sp.t), 'all', 'all', 'all', 0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::bigint, 0::bigint, 0::bigint, NULL::bigint, NULL::bigint
  WHERE fill_empty_buckets AND NOT by_supplier AND fb IS NOT NULL AND (all_suppliers OR cardinality(suppliers) > 0) AND NOT EXISTS (SELECT 1 FROM res0)
  )
  SELECT r.* FROM res r WHERE bucket IS NULL OR NOT fill_empty_buckets OR r.bucket_start <= sp.t_last
  UNION ALL
  SELECT b.bucket_start, b.bucket_end, k.supplier_id, k.service_id, k.application_id, CASE WHEN k.claimed_upokt_na THEN NULL ELSE 0 END, CASE WHEN k.settled_upokt_na THEN NULL ELSE 0 END, CASE WHEN k.overservicing_loss_upokt_na THEN NULL ELSE 0 END, CASE WHEN k.relays_na THEN NULL ELSE 0 END, CASE WHEN k.estimated_relays_na THEN NULL ELSE 0 END, CASE WHEN k.compute_units_na THEN NULL ELSE 0 END, CASE WHEN k.estimated_compute_units_na THEN NULL ELSE 0 END, CASE WHEN k.settled_claims_na THEN NULL ELSE 0 END, CASE WHEN k.settled_claims_with_proof_na THEN NULL ELSE 0 END, CASE WHEN k.settled_claims_without_proof_na THEN NULL ELSE 0 END, NULL::bigint, NULL::bigint
  FROM ${s}._covered_buckets(bucket, sp.f, sp.t_last, cv.covered) b
  CROSS JOIN (SELECT r.supplier_id, r.service_id, r.application_id, bool_and(r.claimed_upokt IS NULL) claimed_upokt_na, bool_and(r.settled_upokt IS NULL) settled_upokt_na, bool_and(r.overservicing_loss_upokt IS NULL) overservicing_loss_upokt_na, bool_and(r.relays IS NULL) relays_na, bool_and(r.estimated_relays IS NULL) estimated_relays_na, bool_and(r.compute_units IS NULL) compute_units_na, bool_and(r.estimated_compute_units IS NULL) estimated_compute_units_na, bool_and(r.settled_claims IS NULL) settled_claims_na, bool_and(r.settled_claims_with_proof IS NULL) settled_claims_with_proof_na, bool_and(r.settled_claims_without_proof IS NULL) settled_claims_without_proof_na FROM res r GROUP BY r.supplier_id, r.service_id, r.application_id) k
  WHERE bucket IS NOT NULL AND fill_empty_buckets
    AND NOT EXISTS (SELECT 1 FROM res r WHERE r.bucket_start = b.bucket_start AND coalesce(r.supplier_id, chr(1)) = coalesce(k.supplier_id, chr(1)) AND coalesce(r.service_id, chr(1)) = coalesce(k.service_id, chr(1)) AND coalesce(r.application_id, chr(1)) = coalesce(k.application_id, chr(1)))
  ), gw AS (
    -- by_application: every application's gateways now (application_gateways is small: 411 rows on mainnet,
    -- 2026-10-14); independent of q, so q is read once and not materialized
    SELECT g.application_id, array_agg(DISTINCT g.gateway_id ORDER BY g.gateway_id) ids FROM ${s}.application_gateways g
    WHERE by_application AND g._block_range @> 9223372036854775807::bigint
    GROUP BY 1
  )
  SELECT q.*, CASE WHEN by_application THEN coalesce(gw.ids, '{}'::text[]) END, cv.covered_from, cv.covered_to, cv.gaps
  FROM q LEFT JOIN gw ON gw.application_id = q.application_id
  ORDER BY 1 DESC, 3, 4, 5;
END $$;

-- Supplier: how what it generated was distributed. Stakers come as ONE row per supplier with recipient 'all'
-- (the chain pays every validator and delegator once per settlement, not per claim); its transfer_count is
-- the claims that gave stakers a share. The other rows count payout legs: one per claim and family (relay,
-- global) that paid that recipient, so a claim with global mint counts twice unless by_reason splits it.
-- by_service splits the rows by the service of the claims that paid them (service_id; 'all' without it), the
-- stakers' row too (claim_settlements.relay_to_stakers_upokt is per claim): the range is read from the per-settlement
-- tables, as the daily rollup has no service. Without it the reads are those of before (service_id 'all').
CREATE OR REPLACE FUNCTION ${s}.get_supplier_distribution(suppliers text[], range_start timestamptz, range_end timestamptz,
  bucket text DEFAULT NULL, by_reason boolean DEFAULT false, by_supplier boolean DEFAULT true,
  owners text[] DEFAULT NULL, fill_empty_buckets boolean DEFAULT false, operators text[] DEFAULT NULL,
  by_service boolean DEFAULT false)
RETURNS TABLE(bucket_start timestamptz, bucket_end timestamptz, supplier_id text, service_id text, recipient_id text, role text, family text,
  amount_upokt numeric, transfer_count bigint, covered_from timestamptz,
  covered_to timestamptz, covered_gaps jsonb)
LANGUAGE plpgsql STABLE SET enable_mergejoin = off SET plan_cache_mode = force_custom_plan AS $$
DECLARE rg record; sp record; cv record; fb timestamptz;
BEGIN
  suppliers := ${s}._supplier_ids(suppliers, owners, operators, true, range_start, range_end, bucket);
${covered("settled")}
  -- by_service: daily_income_by_address_supplier has no service, so every height of the range comes from the base
  rg := ${s}._ranges(range_start, range_end, bucket, by_service);
  fb := CASE WHEN fill_empty_buckets THEN ${s}._first_bucket(bucket, sp.f, sp.t_last, cv.covered) END;
  RETURN QUERY SELECT q.*, cv.covered_from, cv.covered_to, cv.gaps FROM (
  WITH res0(bucket_start, bucket_end, supplier_id, service_id, recipient_id, role, family, amount_upokt, transfer_count) AS (
  WITH x AS (
    SELECT d.day::timestamp AT TIME ZONE 'UTC' block_time, d.supplier_id, ''::text service_id, CASE WHEN d.role = 'stakers' THEN 'all' ELSE d.address END address, d.role, d.family,
           d.amount_upokt, d.transfer_count
    FROM ${s}.daily_income_by_address_supplier d
    WHERE d.supplier_id = ANY(suppliers) AND d.day BETWEEN rg.d1 AND rg.d2
    UNION ALL
    SELECT sb.block_time, v.supplier_id, v.service_id, v.address, v.role, v.family, v.amount_upokt, v.transfer_count::bigint
    FROM ${s}.v_income_base v JOIN ${s}.settlement_blocks sb USING (height)
    WHERE NOT by_service AND v.supplier_id = ANY(suppliers) AND (v.height BETWEEN rg.lo1 AND rg.hi1 OR v.height BETWEEN rg.lo2 AND rg.hi2)
    UNION ALL
    SELECT c.block_time, c.supplier_id, c.service_id, 'all', 'stakers', 'relay', c.relay_to_stakers_upokt,
           (c.relay_to_stakers_upokt > 0)::int::bigint
    FROM ${s}.claim_settlements c
    WHERE NOT by_service AND c.supplier_id = ANY(suppliers) AND (c.height BETWEEN rg.lo1 AND rg.hi1 OR c.height BETWEEN rg.lo2 AND rg.hi2)
    -- by_service reads the whole range from the base: v_income_base's branches as one read of each table (the view reads
    -- claim_settlements once per branch: 200 suppliers over 30 days took 5.1 s through it on the mainnet replica,
    -- 2026-10-20), with the same legs: an amount above 0 each, and the stakers' share of every claim
    UNION ALL
    SELECT sb.block_time, shp.supplier_id, shp.service_id, shp.recipient_id, 'rev_share', f.family, f.amt, 1::bigint
    FROM ${s}.shareholder_payouts shp JOIN ${s}.settlement_blocks sb USING (height)
    CROSS JOIN LATERAL (VALUES ('relay', shp.relay_upokt), ('global', shp.global_upokt)) f(family, amt)
    WHERE by_service AND shp.supplier_id = ANY(suppliers) AND (shp.height BETWEEN rg.lo1 AND rg.hi1 OR shp.height BETWEEN rg.lo2 AND rg.hi2)
      AND f.amt > 0
    UNION ALL
    SELECT c.block_time, c.supplier_id, c.service_id, f.address, f.role, f.family, f.amt,
           CASE WHEN f.role = 'stakers' THEN (f.amt > 0)::int ELSE 1 END::bigint
    FROM ${s}.claim_settlements c JOIN ${s}.settlement_blocks sb USING (height)
    CROSS JOIN LATERAL (VALUES (sb.dao_address, 'dao', 'relay', c.relay_to_dao_upokt),
                               (sb.dao_address, 'dao', 'global', c.global_to_dao_upokt),
                               (sb.dao_address, 'dao', 'reimb_escrow', c.reimbursement_to_dao_upokt),
                               (c.source_owner_id, 'source_owner', 'relay', c.relay_to_source_owner_upokt),
                               (c.source_owner_id, 'source_owner', 'global', c.global_to_source_owner_upokt),
                               (c.application_id, 'application', 'relay', c.relay_to_application_upokt),
                               (c.application_id, 'application', 'global', c.global_to_application_upokt),
                               ('all', 'stakers', 'relay', c.relay_to_stakers_upokt)) f(address, role, family, amt)
    WHERE by_service AND c.supplier_id = ANY(suppliers) AND (c.height BETWEEN rg.lo1 AND rg.hi1 OR c.height BETWEEN rg.lo2 AND rg.hi2)
      AND (f.amt > 0 OR f.role = 'stakers')
  )
  SELECT ${s}._bucket(bucket, x.block_time, sp.f), ${s}._bucket_end(bucket, x.block_time, sp.t), CASE WHEN by_supplier THEN x.supplier_id ELSE 'all' END,
         CASE WHEN by_service THEN x.service_id ELSE 'all' END, x.address, x.role, CASE WHEN by_reason THEN x.family ELSE 'all' END,
         sum(x.amount_upokt)::numeric, sum(x.transfer_count)::bigint
  FROM x GROUP BY 1, 2, 3, 4, 5, 6, 7
  ), res(bucket_start, bucket_end, supplier_id, service_id, recipient_id, role, family, amount_upokt, transfer_count) AS (
  -- every requested id gets its row or series, 0 where it had no activity (not in the sparse output)
  SELECT * FROM res0
  UNION ALL
  SELECT ${s}._bucket(bucket, fb, sp.f), ${s}._bucket_end(bucket, fb, sp.t), u.id, 'all', 'all', 'all', 'all', 0::numeric, 0::bigint
  FROM (SELECT DISTINCT unnest(suppliers) id) u
  WHERE u.id IS NOT NULL AND fill_empty_buckets AND by_supplier AND fb IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM res0 r0 WHERE r0.supplier_id = u.id)
  UNION ALL
  -- the group total of a list with no activity at all: one zero row
  SELECT ${s}._bucket(bucket, fb, sp.f), ${s}._bucket_end(bucket, fb, sp.t), 'all', 'all', 'all', 'all', 'all', 0::numeric, 0::bigint
  WHERE fill_empty_buckets AND NOT by_supplier AND fb IS NOT NULL AND cardinality(suppliers) > 0 AND NOT EXISTS (SELECT 1 FROM res0)
  )
  SELECT r.* FROM res r WHERE bucket IS NULL OR NOT fill_empty_buckets OR r.bucket_start <= sp.t_last
  UNION ALL
  SELECT b.bucket_start, b.bucket_end, k.supplier_id, k.service_id, k.recipient_id, k.role, k.family, CASE WHEN k.amount_upokt_na THEN NULL ELSE 0 END, CASE WHEN k.transfer_count_na THEN NULL ELSE 0 END
  FROM ${s}._covered_buckets(bucket, sp.f, sp.t_last, cv.covered) b
  CROSS JOIN (SELECT r.supplier_id, r.service_id, r.recipient_id, r.role, r.family, bool_and(r.amount_upokt IS NULL) amount_upokt_na, bool_and(r.transfer_count IS NULL) transfer_count_na FROM res r GROUP BY r.supplier_id, r.service_id, r.recipient_id, r.role, r.family) k
  WHERE bucket IS NOT NULL AND fill_empty_buckets
    AND NOT EXISTS (SELECT 1 FROM res r WHERE r.bucket_start = b.bucket_start AND coalesce(r.supplier_id, chr(1)) = coalesce(k.supplier_id, chr(1)) AND coalesce(r.service_id, chr(1)) = coalesce(k.service_id, chr(1)) AND coalesce(r.recipient_id, chr(1)) = coalesce(k.recipient_id, chr(1)) AND coalesce(r.role, chr(1)) = coalesce(k.role, chr(1)) AND coalesce(r.family, chr(1)) = coalesce(k.family, chr(1)))
  ) q ORDER BY 1 DESC, 3, 4, 5, 6, 7;
END $$;

-- Income of any address. The rollup follows the breakdown: daily_income_by_address (none), daily_income_by_address_supplier /
-- monthly_income_by_address_supplier (by supplier), daily_income_by_address_service / monthly_income_by_address_service (by service).
-- Supplier AND service at once: whole months from monthly_income_by_address_supplier_service, everything else from the base.
-- suppliers (with by_supplier) keeps only the income those suppliers generated, read by index
-- instead of filtering the result (the legacy_* functions). capped = false lifts _validate's per-bucket range caps, for
-- the legacy_* functions: the live functions they replace take any range. p_covered / p_span_from / p_first / p_last /
-- p_covered_to: get_income's coverage (covered(): the covered set, outside which no bucket is zero-filled, the requested
-- range_start, the span bounds). Unordered: get_income orders.
CREATE OR REPLACE FUNCTION ${s}._income(addresses text[], range_start timestamptz, range_end timestamptz,
  bucket text DEFAULT NULL, by_reason boolean DEFAULT false, by_supplier boolean DEFAULT false,
  by_service boolean DEFAULT false, by_address boolean DEFAULT true,
  fill_empty_buckets boolean DEFAULT false, suppliers text[] DEFAULT NULL, capped boolean DEFAULT true,
  p_covered tstzmultirange DEFAULT NULL, p_span_from timestamptz DEFAULT NULL,
  p_first timestamptz DEFAULT NULL, p_last timestamptz DEFAULT NULL, p_covered_to timestamptz DEFAULT NULL)
RETURNS TABLE(bucket_start timestamptz, bucket_end timestamptz, address text, role text, family text, supplier_id text, service_id text,
  amount_upokt numeric, transfer_count bigint)
LANGUAGE plpgsql STABLE SET enable_mergejoin = off SET plan_cache_mode = force_custom_plan AS $$
DECLARE rg record; sp record; m1 date; m2 date; use_month boolean; use_month_svc boolean; fb timestamptz;
  mw1 timestamptz; mw2 timestamptz; use_month_triple boolean; hm1 bigint; hm2 bigint;
BEGIN
  PERFORM ${s}._validate(addresses, '', range_start, range_end, CASE WHEN capped THEN bucket END);
  sp := ${s}._span(range_start, range_end, p_first, p_last, p_covered_to);
  IF bucket IS NULL AND p_span_from IS NOT NULL THEN sp.f := p_span_from; END IF;
  rg := ${s}._ranges(range_start, range_end, bucket, by_supplier AND by_service);
  -- whole months inside the rollup days [d1, d2], only when the series needs no days
  m1 := CASE WHEN rg.d1 = date_trunc('month', rg.d1)::date THEN rg.d1 ELSE (date_trunc('month', rg.d1) + interval '1 month')::date END;
  m2 := (date_trunc('month', rg.d2 + 1) - interval '1 month')::date;  -- last month that ends <= d2
  use_month := by_supplier AND NOT by_service AND coalesce(bucket, 'month') IN ('month', 'year')
               AND rg.d1 <= rg.d2 AND m1 <= m2;
  use_month_svc := by_service AND NOT by_supplier AND coalesce(bucket, 'month') IN ('month', 'year')
                   AND rg.d1 <= rg.d2 AND m1 <= m2;
  -- supplier AND service: whole UTC months [mw1, mw2) of the range from monthly_income_by_address_supplier_service, the
  -- rest (and the staker rows, which have neither) from the base; an open end, or an edge month that holds no written
  -- settlement outside the range, is whole too
  mw1 := CASE WHEN range_start IS NULL THEN '-infinity'
              WHEN range_start = date_trunc('month', range_start, 'UTC') THEN range_start
              WHEN NOT EXISTS (SELECT 1 FROM ${s}.settlement_blocks sb
                               WHERE sb.block_time >= date_trunc('month', range_start, 'UTC') AND sb.block_time < range_start)
                THEN date_trunc('month', range_start, 'UTC')
              ELSE date_trunc('month', range_start, 'UTC') + interval '1 month' END;
  mw2 := CASE WHEN range_end IS NULL THEN 'infinity'
              WHEN range_end = date_trunc('month', range_end, 'UTC') THEN range_end
              WHEN NOT EXISTS (SELECT 1 FROM ${s}.settlement_blocks sb
                               WHERE sb.block_time >= range_end
                                 AND sb.block_time < date_trunc('month', range_end, 'UTC') + interval '1 month')
                THEN date_trunc('month', range_end, 'UTC') + interval '1 month'
              ELSE date_trunc('month', range_end, 'UTC') END;
  use_month_triple := by_supplier AND by_service AND coalesce(bucket, 'month') IN ('month', 'year') AND mw1 < mw2
                      AND coalesce(current_setting('money.no_rollup', true), 'off') <> 'on';
  IF use_month_triple THEN
    -- the base reads the heights before and after the whole months, and inside them only the staker rows
    SELECT coalesce(max(sb.height), -1) INTO hm1 FROM ${s}.settlement_blocks sb WHERE sb.block_time < mw1;
    SELECT coalesce(min(sb.height), 9223372036854775807) INTO hm2 FROM ${s}.settlement_blocks sb WHERE sb.block_time >= mw2;
    PERFORM ${s}._require_current_rollups(greatest((mw1 AT TIME ZONE 'UTC')::date, (SELECT min(day) FROM ${s}.settlement_blocks)),
                                          least((mw2 AT TIME ZONE 'UTC')::date - 1, (SELECT max(day) FROM ${s}.settlement_blocks)));
  END IF;
  fb := CASE WHEN fill_empty_buckets THEN ${s}._first_bucket(bucket, sp.f, sp.t_last, p_covered) END;
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
    WHERE (by_supplier OR by_service) AND d.role IN (${STAKER_ROLES_SQL}) AND suppliers IS NULL
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
  SELECT ${s}._bucket(bucket, fb, sp.f), ${s}._bucket_end(bucket, fb, sp.t), u.id, 'all', 'all', 'all', 'all', 0::numeric, 0::bigint
  FROM (SELECT DISTINCT unnest(addresses) id) u
  WHERE u.id IS NOT NULL AND fill_empty_buckets AND by_address AND fb IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM res0 r0 WHERE r0.address = u.id)
  UNION ALL
  -- the group total of a list with no activity at all: one zero row
  SELECT ${s}._bucket(bucket, fb, sp.f), ${s}._bucket_end(bucket, fb, sp.t), 'all', 'all', 'all', 'all', 'all', 0::numeric, 0::bigint
  WHERE fill_empty_buckets AND NOT by_address AND fb IS NOT NULL AND cardinality(addresses) > 0 AND NOT EXISTS (SELECT 1 FROM res0)
  )
  SELECT r.* FROM res r WHERE bucket IS NULL OR NOT fill_empty_buckets OR r.bucket_start <= sp.t_last
  UNION ALL
  SELECT b.bucket_start, b.bucket_end, k.address, k.role, k.family, k.supplier_id, k.service_id, CASE WHEN k.amount_upokt_na THEN NULL ELSE 0 END, CASE WHEN k.transfer_count_na THEN NULL ELSE 0 END
  FROM ${s}._covered_buckets(bucket, sp.f, sp.t_last, p_covered) b
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
  amount_upokt numeric, transfer_count bigint, covered_from timestamptz,
  covered_to timestamptz, covered_gaps jsonb)
LANGUAGE plpgsql STABLE SET plan_cache_mode = force_custom_plan AS $$
DECLARE cv record;
BEGIN
  PERFORM ${s}._validate(addresses, 'addresses', range_start, range_end, bucket);
${covered(null)}
  RETURN QUERY SELECT i.*, cv.covered_from, cv.covered_to, cv.gaps
    FROM ${s}._income(addresses, range_start, range_end, bucket, by_reason, by_supplier, by_service, by_address,
                      fill_empty_buckets, p_covered => cv.covered, p_span_from => coalesce(cv.requested_from, cv.covered_from),
                      p_first => cv.first_settled, p_last => cv.last_settled, p_covered_to => cv.covered_to) i ORDER BY 1 DESC, 3, 4, 5, 6, 7;
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
  delegated_stake_max_upokt numeric, covered_from timestamptz,
  covered_to timestamptz, covered_gaps jsonb)
LANGUAGE plpgsql STABLE SET enable_mergejoin = off SET plan_cache_mode = force_custom_plan AS $$
DECLARE sp record; lo bigint; hi bigint; all_validators boolean := validators IS NULL; cv record; fb timestamptz;
BEGIN
  -- NULL validators: every validator
  PERFORM ${s}._validate(validators, CASE WHEN validators IS NULL THEN '' ELSE 'validators' END, range_start, range_end, bucket);
${covered("settled")}
  SELECT min(sb.height), max(sb.height) INTO lo, hi FROM ${s}.settlement_blocks sb
  WHERE (range_start IS NULL OR sb.block_time >= range_start) AND (range_end IS NULL OR sb.block_time < range_end);
  fb := CASE WHEN fill_empty_buckets THEN ${s}._first_bucket(bucket, sp.f, sp.t_last, cv.covered) END;
  RETURN QUERY SELECT q.*, cv.covered_from, cv.covered_to, cv.gaps FROM (
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
    SELECT ${s}._bucket(bucket, fb, sp.f), ${s}._bucket_end(bucket, fb, sp.t), u.id, 0::numeric, 0::bigint, 0::numeric,
           0::numeric, 0::numeric, 0::bigint, 0::bigint, NULL::numeric, NULL::numeric, NULL::numeric
    FROM (SELECT DISTINCT unnest(validators) id) u
    WHERE u.id IS NOT NULL AND fill_empty_buckets AND by_validator AND fb IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM ${s}.validator_distributions v WHERE v.validator_operator = u.id AND v.height BETWEEN lo AND hi)
    UNION ALL
    -- the group total of a list with no distribution at all: one zero row
    SELECT ${s}._bucket(bucket, fb, sp.f), ${s}._bucket_end(bucket, fb, sp.t), 'all', 0::numeric, 0::bigint, 0::numeric,
           0::numeric, 0::numeric, 0::bigint, 0::bigint, NULL::numeric, NULL::numeric, NULL::numeric
    WHERE fill_empty_buckets AND NOT by_validator AND fb IS NOT NULL AND (all_validators OR cardinality(validators) > 0)
      AND NOT EXISTS (SELECT 1 FROM ${s}.validator_distributions v
                      WHERE (all_validators OR v.validator_operator = ANY(validators)) AND v.height BETWEEN lo AND hi)
  )
  SELECT r.* FROM res r WHERE bucket IS NULL OR NOT fill_empty_buckets OR r.bucket_start <= sp.t_last
  UNION ALL
  -- an empty cell: nothing was distributed, so 0, and no stake was seen (NULL)
  SELECT b.bucket_start, b.bucket_end, k.validator_operator, 0::numeric, 0::bigint, 0::numeric, 0::numeric, 0::numeric,
         0::bigint, 0::bigint, NULL::numeric, NULL::numeric, NULL::numeric
  FROM ${s}._covered_buckets(bucket, sp.f, sp.t_last, cv.covered) b
  CROSS JOIN (SELECT DISTINCT r.validator_operator FROM res r) k
  WHERE bucket IS NOT NULL AND fill_empty_buckets
    AND NOT EXISTS (SELECT 1 FROM res r WHERE r.bucket_start = b.bucket_start AND r.validator_operator = k.validator_operator)
  ) q ORDER BY 1 DESC, 3;
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
  replayed_count bigint, covered_from timestamptz,
  covered_to timestamptz, covered_gaps jsonb)
LANGUAGE plpgsql STABLE SET enable_mergejoin = off SET plan_cache_mode = force_custom_plan AS $$
DECLARE rg record; sp record; all_delegators boolean := delegators IS NULL; cv record; fb timestamptz;
BEGIN
  -- NULL delegators: every delegator; validators keeps the income from those validators (their delegators)
  PERFORM ${s}._validate(delegators, CASE WHEN delegators IS NULL THEN '' ELSE 'delegators' END, range_start, range_end, bucket);
  IF validators IS NOT NULL THEN PERFORM ${s}._validate(validators, 'validators', NULL, NULL, NULL); END IF;
${covered("settled")}
  rg := ${s}._ranges(range_start, range_end, bucket);
  fb := CASE WHEN fill_empty_buckets THEN ${s}._first_bucket(bucket, sp.f, sp.t_last, cv.covered) END;
  RETURN QUERY SELECT q.*, cv.covered_from, cv.covered_to, cv.gaps FROM (
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
  SELECT ${s}._bucket(bucket, fb, sp.f), ${s}._bucket_end(bucket, fb, sp.t), u.id, 'all', 0::numeric, 0::bigint
  FROM (SELECT DISTINCT unnest(delegators) id) u
  WHERE u.id IS NOT NULL AND fill_empty_buckets AND by_delegator AND fb IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM res0 r0 WHERE r0.delegator = u.id)
  UNION ALL
  -- the group total of a list with no activity at all: one zero row
  SELECT ${s}._bucket(bucket, fb, sp.f), ${s}._bucket_end(bucket, fb, sp.t), 'all', 'all', 0::numeric, 0::bigint
  WHERE fill_empty_buckets AND NOT by_delegator AND fb IS NOT NULL AND (all_delegators OR cardinality(delegators) > 0) AND NOT EXISTS (SELECT 1 FROM res0)
  )
  SELECT r.* FROM res r WHERE bucket IS NULL OR NOT fill_empty_buckets OR r.bucket_start <= sp.t_last
  UNION ALL
  SELECT b.bucket_start, b.bucket_end, k.delegator, k.validator_operator, CASE WHEN k.amount_upokt_na THEN NULL ELSE 0 END, 0::bigint
  FROM ${s}._covered_buckets(bucket, sp.f, sp.t_last, cv.covered) b
  CROSS JOIN (SELECT r.delegator, r.validator_operator, bool_and(r.amount_upokt IS NULL) amount_upokt_na FROM res r GROUP BY r.delegator, r.validator_operator) k
  WHERE bucket IS NOT NULL AND fill_empty_buckets
    AND NOT EXISTS (SELECT 1 FROM res r WHERE r.bucket_start = b.bucket_start AND coalesce(r.delegator, chr(1)) = coalesce(k.delegator, chr(1)) AND coalesce(r.validator_operator, chr(1)) = coalesce(k.validator_operator, chr(1)))
  ) q ORDER BY 1 DESC, 3, 4;
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
-- Unordered: get_supply_flows orders.
CREATE OR REPLACE FUNCTION ${s}._supply_flows(range_start timestamptz, range_end timestamptz, bucket text DEFAULT NULL,
  by_role boolean DEFAULT false, fill_empty_buckets boolean DEFAULT false, p_covered tstzmultirange DEFAULT NULL,
  p_span_from timestamptz DEFAULT NULL,
  p_first timestamptz DEFAULT NULL, p_last timestamptz DEFAULT NULL, p_covered_to timestamptz DEFAULT NULL)
RETURNS TABLE(bucket_start timestamptz, bucket_end timestamptz, flow text, role text, amount_upokt numeric)
LANGUAGE plpgsql STABLE SET enable_mergejoin = off SET plan_cache_mode = force_custom_plan AS $$
DECLARE rg record; sp record; fb timestamptz;
BEGIN
  sp := ${s}._span(range_start, range_end, p_first, p_last, p_covered_to);
  IF bucket IS NULL AND p_span_from IS NOT NULL THEN sp.f := p_span_from; END IF;
  rg := ${s}._ranges(range_start, range_end, bucket);
  fb := CASE WHEN fill_empty_buckets THEN ${s}._first_bucket(bucket, sp.f, sp.t_last, p_covered) END;
  RETURN QUERY SELECT q.* FROM (
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
  FROM ${s}._covered_buckets(bucket, sp.f, sp.t_last, p_covered) b
  CROSS JOIN (SELECT r.flow, r.role, bool_and(r.amount_upokt IS NULL) amount_upokt_na FROM res r GROUP BY r.flow, r.role) k
  WHERE bucket IS NOT NULL AND fill_empty_buckets
    AND NOT EXISTS (SELECT 1 FROM res r WHERE r.bucket_start = b.bucket_start AND coalesce(r.flow, chr(1)) = coalesce(k.flow, chr(1)) AND coalesce(r.role, chr(1)) = coalesce(k.role, chr(1)))
  ) q;
END $$;

-- The API entry point: _supply_flows over the covered part of the range, with the range on every row. legacy mint / burn
-- read _supply_flows with the coverage they already have.
CREATE OR REPLACE FUNCTION ${s}.get_supply_flows(range_start timestamptz, range_end timestamptz, bucket text DEFAULT NULL,
  by_role boolean DEFAULT false, fill_empty_buckets boolean DEFAULT false)
RETURNS TABLE(bucket_start timestamptz, bucket_end timestamptz, flow text, role text, amount_upokt numeric, covered_from timestamptz,
  covered_to timestamptz, covered_gaps jsonb)
LANGUAGE plpgsql STABLE SET plan_cache_mode = force_custom_plan AS $$
DECLARE cv record;
BEGIN
  PERFORM ${s}._validate(NULL, '', range_start, range_end, bucket);
${covered(null)}
  RETURN QUERY SELECT f.*, cv.covered_from, cv.covered_to, cv.gaps
    FROM ${s}._supply_flows(range_start, range_end, bucket, by_role, fill_empty_buckets, cv.covered,
                           coalesce(cv.requested_from, cv.covered_from),
                           cv.first_settled, cv.last_settled, cv.covered_to) f
    ORDER BY 1 DESC, 3, 4;
END $$;

-- Supplier penalties: expired and discarded claims, and slashes. Base only: they are rare. A discarded
-- claim has no amount_upokt or relay counts on chain: NULL, not 0.
-- operator_scope ever: every supplier that shared revenue with the operators at any time (_operator_suppliers_ever),
-- for the slashes of the suppliers an operator ran before.
CREATE OR REPLACE FUNCTION ${s}.get_supplier_penalties(suppliers text[], range_start timestamptz, range_end timestamptz,
  bucket text DEFAULT NULL, by_service boolean DEFAULT false, by_supplier boolean DEFAULT true,
  owners text[] DEFAULT NULL, fill_empty_buckets boolean DEFAULT false, operators text[] DEFAULT NULL,
  operator_scope text DEFAULT 'now')
RETURNS TABLE(bucket_start timestamptz, bucket_end timestamptz, supplier_id text, service_id text, kind text, reason text, events bigint, claimed_upokt numeric,
  slashed_upokt numeric, relays numeric, estimated_relays numeric, compute_units numeric, estimated_compute_units numeric, covered_from timestamptz,
  covered_to timestamptz, covered_gaps jsonb)
LANGUAGE plpgsql STABLE SET enable_mergejoin = off SET plan_cache_mode = force_custom_plan AS $$
DECLARE rg record; sp record; all_suppliers boolean; cv record; fb timestamptz; ids text[];
BEGIN
${OPERATOR_SCOPE_CHECK}
  -- NULL (no suppliers, owners or operators): every supplier
${scopedSupplierIds(s, "suppliers", false, "range_start", "range_end", "  ", "bucket")}
  suppliers := ids;
  all_suppliers := suppliers IS NULL;
${covered("settled")}
  rg := ${s}._ranges(range_start, range_end, bucket, true);
  fb := CASE WHEN fill_empty_buckets THEN ${s}._first_bucket(bucket, sp.f, sp.t_last, cv.covered) END;
  RETURN QUERY SELECT q.*, cv.covered_from, cv.covered_to, cv.gaps FROM (
  WITH res0(bucket_start, bucket_end, supplier_id, service_id, kind, reason, events, claimed_upokt, slashed_upokt, relays, estimated_relays, compute_units, estimated_compute_units) AS (
  WITH x AS (
    SELECT e.height, e.supplier_id, e.service_id, 'expired'::text kind, e.reason, e.claimed_upokt, NULL::bigint slashed,
           e.relays, e.estimated_relays, e.claimed_compute_units, e.estimated_compute_units
    FROM ${s}.claim_expirations e WHERE (all_suppliers OR e.supplier_id = ANY(suppliers)) AND e.height BETWEEN rg.lo1 AND rg.hi1
    UNION ALL
    SELECT e.height, e.supplier_id, e.service_id, 'discarded', left(e.error, 60), NULL::bigint, NULL::bigint, NULL::bigint, NULL::bigint,
           NULL::bigint, NULL::bigint
    FROM ${s}.claim_discards e WHERE (all_suppliers OR e.supplier_id = ANY(suppliers)) AND e.height BETWEEN rg.lo1 AND rg.hi1
    UNION ALL
    -- the chain slashes every expired claim, whatever the expiration reason: the slash takes its claim's reason
    SELECT s.height, s.supplier_id, s.service_id, 'slashed', coalesce(e.reason, 'unknown'), NULL::bigint, s.penalty_upokt,
           NULL::bigint, NULL::bigint, NULL::bigint, NULL::bigint
    FROM ${s}.supplier_slashes s
    LEFT JOIN ${s}.claim_expirations e ON e.height = s.height AND e.supplier_id = s.supplier_id
      AND e.application_id = s.application_id AND e.service_id = s.service_id AND e.session_end = s.session_end
    WHERE (all_suppliers OR s.supplier_id = ANY(suppliers)) AND s.height BETWEEN rg.lo1 AND rg.hi1
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
  SELECT ${s}._bucket(bucket, fb, sp.f), ${s}._bucket_end(bucket, fb, sp.t), u.id, 'all', 'all', 'all', 0::bigint, 0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric
  FROM (SELECT DISTINCT unnest(suppliers) id) u
  WHERE u.id IS NOT NULL AND fill_empty_buckets AND by_supplier AND fb IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM res0 r0 WHERE r0.supplier_id = u.id)
  UNION ALL
  -- the group total of a list with no activity at all: one zero row
  SELECT ${s}._bucket(bucket, fb, sp.f), ${s}._bucket_end(bucket, fb, sp.t), 'all', 'all', 'all', 'all', 0::bigint, 0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric, 0::numeric
  WHERE fill_empty_buckets AND NOT by_supplier AND fb IS NOT NULL AND (all_suppliers OR cardinality(suppliers) > 0) AND NOT EXISTS (SELECT 1 FROM res0)
  )
  SELECT r.* FROM res r WHERE bucket IS NULL OR NOT fill_empty_buckets OR r.bucket_start <= sp.t_last
  UNION ALL
  SELECT b.bucket_start, b.bucket_end, k.supplier_id, k.service_id, k.kind, k.reason, CASE WHEN k.events_na THEN NULL ELSE 0 END, CASE WHEN k.claimed_upokt_na THEN NULL ELSE 0 END, CASE WHEN k.slashed_upokt_na THEN NULL ELSE 0 END, CASE WHEN k.relays_na THEN NULL ELSE 0 END, CASE WHEN k.estimated_relays_na THEN NULL ELSE 0 END, CASE WHEN k.compute_units_na THEN NULL ELSE 0 END, CASE WHEN k.estimated_compute_units_na THEN NULL ELSE 0 END
  FROM ${s}._covered_buckets(bucket, sp.f, sp.t_last, cv.covered) b
  CROSS JOIN (SELECT r.supplier_id, r.service_id, r.kind, r.reason, bool_and(r.events IS NULL) events_na, bool_and(r.claimed_upokt IS NULL) claimed_upokt_na, bool_and(r.slashed_upokt IS NULL) slashed_upokt_na, bool_and(r.relays IS NULL) relays_na, bool_and(r.estimated_relays IS NULL) estimated_relays_na, bool_and(r.compute_units IS NULL) compute_units_na, bool_and(r.estimated_compute_units IS NULL) estimated_compute_units_na FROM res r GROUP BY r.supplier_id, r.service_id, r.kind, r.reason) k
  WHERE bucket IS NOT NULL AND fill_empty_buckets
    AND NOT EXISTS (SELECT 1 FROM res r WHERE r.bucket_start = b.bucket_start AND coalesce(r.supplier_id, chr(1)) = coalesce(k.supplier_id, chr(1)) AND coalesce(r.service_id, chr(1)) = coalesce(k.service_id, chr(1)) AND coalesce(r.kind, chr(1)) = coalesce(k.kind, chr(1)) AND coalesce(r.reason, chr(1)) = coalesce(k.reason, chr(1)))
  ) q ORDER BY 1 DESC, 3, 4, 5, 6;
END $$;

-- Service: the total usage of a set of services (a service owner resolves its own through services.owner_id).
-- Pass services, top_by_settled, row_limit, or services with one of them: top_by_settled = N picks the N services (among services, when given) with the most settled_upokt in
-- the whole range (ties by service_id), and a series then covers those N; rank_by_settled is their place (1 = most),
-- NULL when the caller names the services. Rows come ordered by rank, then bucket. row_offset skips that many services
-- of the ranking first (NULL = 0), so top_by_settled is a page of it and rank_by_settled stays the place in the whole
-- ranking; total_services is the number of services ranked (those with a settled claim in the range, whatever its
-- amount: the rollups hold settlements only; among services when given), on every row of a top_by_settled call (NULL
-- without one). With neither services nor top_by_settled, by_service => false is the network total: every service
-- summed in one row per bucket.
-- row_limit in place of top_by_settled ranks the same services by order_by (default estimated_compute_units) in order_dir
-- (default desc; NULLs last, ties by service_id COLLATE "C"), kept to those whose lower(service_id || ' ' || name)
-- contains lower(search_text) (not search: SubQuery's query service rewrites an argument of that name into a
-- full-text query): a page of row_limit services (at most 200, or 20 with a bucket) from row_offset, in that order,
-- with rank_by_settled NULL and total_services counting the services after search_text.
-- compare_start (no bucket; needs range_start) and compare_end (default range_start, never after it) add
-- previous_estimated_compute_units, the estimated compute units of the same services in [compare_start, compare_end)
-- (0 when none), and change = (estimated_compute_units - previous) / previous, 1 when previous is 0, the rule of
-- services_performance_between_times; both are NULL when the money tables do not cover all of that window.
-- with_details fills name (the live Service row's; NULL on the 'all' row), staked_suppliers and staked_applications:
-- the Staked suppliers and applications configured for the service now, as services_performance_between_times counts
-- them. The 'all' row sums them over its services (for the network total, those with usage in the range), so an actor
-- configured for several services counts once per service: the service configs network-analytics' Suppliers tab sums
-- (and divides by the distinct staked suppliers). They take 100-400 ms on mainnet (replica, 2026-10-16), so other
-- calls leave them NULL.
CREATE OR REPLACE FUNCTION ${s}.get_service_usage(services text[], range_start timestamptz, range_end timestamptz,
  bucket text DEFAULT NULL, top_by_settled int DEFAULT NULL, by_service boolean DEFAULT true,
  fill_empty_buckets boolean DEFAULT false, row_offset int DEFAULT NULL, row_limit int DEFAULT NULL,
  order_by text DEFAULT NULL, order_dir text DEFAULT NULL, search_text text DEFAULT NULL, compare_start timestamptz DEFAULT NULL,
  compare_end timestamptz DEFAULT NULL, with_details boolean DEFAULT false)
RETURNS TABLE(bucket_start timestamptz, bucket_end timestamptz, service_id text, claimed_upokt numeric, settled_upokt numeric,
  overservicing_loss_upokt numeric, relays numeric, estimated_relays numeric, compute_units numeric,
  estimated_compute_units numeric, claims bigint, rank_by_settled int, total_services int, name text,
  staked_suppliers bigint, staked_applications bigint, previous_estimated_compute_units numeric, change numeric,
  covered_from timestamptz, covered_to timestamptz, covered_gaps jsonb)
LANGUAGE plpgsql STABLE SET enable_mergejoin = off SET plan_cache_mode = force_custom_plan AS $$
DECLARE rg record; rp record; sp record; cv record; fb timestamptz; all_services boolean; ranked int; used text[];
  d_ids text[]; d_names text[]; d_suppliers bigint[]; d_applications bigint[]; cp record; prev_ok boolean := false;
  ob text := coalesce(order_by, 'estimated_compute_units'); asc_order boolean := coalesce(order_dir, 'desc') = 'asc';
BEGIN
  IF services IS NULL AND top_by_settled IS NULL AND row_limit IS NULL AND by_service THEN
    RAISE EXCEPTION 'pass services, top_by_settled, or both (the top among those services), or row_limit (a page of them in order_by); or by_service => false for the network total';
  END IF;
  IF top_by_settled IS NOT NULL AND (top_by_settled < 1 OR top_by_settled > 200) THEN
    RAISE EXCEPTION 'top_by_settled must be between 1 and 200 (is %)', top_by_settled;
  END IF;
  IF top_by_settled IS NOT NULL AND row_limit IS NOT NULL THEN
    RAISE EXCEPTION 'pass top_by_settled or row_limit, not both (row_limit with order_by => ''settled_upokt'' is the same ranking)';
  END IF;
  IF row_limit IS NOT NULL AND (row_limit < 1 OR row_limit > CASE WHEN bucket IS NULL THEN 200 ELSE 20 END) THEN
    RAISE EXCEPTION 'row_limit must be between 1 and 200, or 20 with a bucket (one series per service) (is %)', row_limit;
  END IF;
  IF row_offset IS NOT NULL AND (row_offset < 0 OR row_offset > 10000000) THEN
    RAISE EXCEPTION 'row_offset must be between 0 and 10000000 (has %)', row_offset;
  END IF;
  IF row_offset IS NOT NULL AND top_by_settled IS NULL AND row_limit IS NULL THEN
    RAISE EXCEPTION 'row_offset pages the ranking: pass top_by_settled or row_limit (the page size) with it';
  END IF;
  IF (order_by IS NOT NULL OR order_dir IS NOT NULL OR search_text IS NOT NULL) AND row_limit IS NULL THEN
    RAISE EXCEPTION 'order_by, order_dir and search_text page the ranking: pass row_limit with them (top_by_settled ranks by settled_upokt, descending)';
  END IF;
  IF ob NOT IN ('estimated_compute_units', 'estimated_relays', 'relays', 'compute_units', 'settled_upokt', 'claimed_upokt',
                'service_id', 'name', 'staked_suppliers', 'change') THEN
    RAISE EXCEPTION 'order_by must be estimated_compute_units, estimated_relays, relays, compute_units, settled_upokt, claimed_upokt, service_id, name, staked_suppliers or change (is %)', order_by;
  END IF;
  IF order_dir NOT IN ('asc', 'desc') THEN
    RAISE EXCEPTION 'order_dir must be asc or desc (is %)', order_dir;
  END IF;
  IF compare_end IS NOT NULL AND compare_start IS NULL THEN
    RAISE EXCEPTION 'compare_end needs compare_start';
  END IF;
  IF compare_start IS NOT NULL THEN
    IF bucket IS NOT NULL THEN
      RAISE EXCEPTION 'compare_start compares the whole range: pass it without bucket';
    END IF;
    IF range_start IS NULL THEN
      RAISE EXCEPTION 'compare_start compares with the window before range_start: pass range_start';
    END IF;
    compare_end := coalesce(compare_end, range_start);
    IF compare_start >= compare_end OR compare_end > range_start THEN
      RAISE EXCEPTION 'compare_start must be before compare_end, and compare_end (default range_start) not after range_start';
    END IF;
  END IF;
  IF ob = 'change' AND compare_start IS NULL THEN
    RAISE EXCEPTION 'order_by change needs compare_start';
  END IF;
  PERFORM ${s}._validate(services, CASE WHEN services IS NULL THEN '' ELSE 'services' END, range_start, range_end, bucket);
  -- the network total: no service list, every service summed (by_service is false here)
  all_services := services IS NULL AND top_by_settled IS NULL AND row_limit IS NULL;
${covered("settled")}
  IF compare_start IS NOT NULL THEN
    rp := ${s}._ranges(compare_start, compare_end, NULL);
    -- the previous window counts only where the money tables cover all of it: elsewhere previous and change are NULL,
    -- not a 0 read from history that was never written
    cp := ${s}._coverage(compare_start, compare_end);
    prev_ok := cp.covered @> tstzrange(compare_start, compare_end);
  ELSIF row_limit IS NOT NULL OR with_details THEN
    -- read (with no rows) by the ranking and the query with details
    SELECT NULL::date d1, NULL::date d2, NULL::bigint lo1, NULL::bigint hi1, NULL::bigint lo2, NULL::bigint hi2 INTO rp;
  END IF;
  IF top_by_settled IS NOT NULL THEN
    rg := ${s}._ranges(range_start, range_end, NULL);
    SELECT coalesce(array_agg(p.service_id ORDER BY p.rn), '{}'), max(p.ranked) INTO services, ranked FROM (
      SELECT g.service_id, g.rn, g.ranked FROM (
        SELECT t.service_id, row_number() OVER (ORDER BY sum(t.settled_upokt) DESC, t.service_id COLLATE "C") rn,
               (count(*) OVER ())::int ranked
        FROM (
          SELECT d.service_id, d.settled_upokt FROM ${s}.daily_claims_by_application_service d
          WHERE d.day BETWEEN rg.d1 AND rg.d2 AND (services IS NULL OR d.service_id = ANY(services))
          UNION ALL
          SELECT c.service_id, c.settled_upokt FROM ${s}.settlement_claims_by_application_service c
          WHERE (c.height BETWEEN rg.lo1 AND rg.hi1 OR c.height BETWEEN rg.lo2 AND rg.hi2)
            AND (services IS NULL OR c.service_id = ANY(services))) t
        GROUP BY t.service_id) g
      ORDER BY g.rn LIMIT top_by_settled OFFSET coalesce(row_offset, 0)) p;
  ELSIF row_limit IS NOT NULL THEN
    rg := ${s}._ranges(range_start, range_end, NULL);
    SELECT coalesce(array_agg(p.service_id ORDER BY p.rn), '{}'), max(p.ranked) INTO services, ranked FROM (
      SELECT g.service_id, g.rn, g.ranked FROM (
        SELECT k.service_id, row_number() OVER (ORDER BY
                 CASE WHEN asc_order THEN k.n END ASC NULLS LAST, CASE WHEN NOT asc_order THEN k.n END DESC NULLS LAST,
                 CASE WHEN asc_order THEN k.t END ASC NULLS LAST, CASE WHEN NOT asc_order THEN k.t END DESC NULLS LAST,
                 k.service_id COLLATE "C") rn,
               (count(*) OVER ())::int ranked
        FROM (
          SELECT u.service_id,
                 CASE ob WHEN 'estimated_compute_units' THEN u.estimated_compute_units WHEN 'estimated_relays' THEN u.estimated_relays
                         WHEN 'relays' THEN u.relays WHEN 'compute_units' THEN u.compute_units WHEN 'settled_upokt' THEN u.settled_upokt
                         WHEN 'claimed_upokt' THEN u.claimed_upokt WHEN 'staked_suppliers' THEN coalesce(st.staked_suppliers, 0)
                         WHEN 'change' THEN CASE WHEN prev_ok THEN ${usageChange("u.estimated_compute_units", "coalesce(pv.estimated_compute_units, 0)")} END END n,
                 CASE ob WHEN 'service_id' THEN u.service_id WHEN 'name' THEN lower(sv.name) END COLLATE "C" t
          FROM (${serviceUsageSums(s, "rg", "services IS NULL OR $.service_id = ANY(services)")}) u
          LEFT JOIN ${s}.services sv ON sv.id = u.service_id AND upper_inf(sv._block_range)
          LEFT JOIN (${serviceUsageSums(s, "rp", "ob = 'change' AND prev_ok AND (services IS NULL OR $.service_id = ANY(services))")}) pv
            ON pv.service_id = u.service_id
          LEFT JOIN (${stakedCounts(s, "ob = 'staked_suppliers' AND (services IS NULL OR $.service_id = ANY(services))")}) st
            ON st.service_id = u.service_id
          WHERE search_text IS NULL OR strpos(lower(u.service_id || ' ' || coalesce(sv.name, '')), lower(search_text)) > 0) k) g
      ORDER BY g.rn LIMIT row_limit OFFSET coalesce(row_offset, 0)) p;
  END IF;
  rg := ${s}._ranges(range_start, range_end, bucket);
  IF with_details THEN
    -- the network total's staked counts sum over the services with usage in the range
    IF all_services THEN
      SELECT array_agg(u.service_id) INTO used FROM (${serviceUsageSums(s, "rg", "true")}) u;
    ELSE
      used := services;
    END IF;
    SELECT array_agg(v.id), array_agg(sv.name), array_agg(coalesce(st.staked_suppliers, 0)),
           array_agg(coalesce(st.staked_applications, 0))
    INTO d_ids, d_names, d_suppliers, d_applications
    FROM (SELECT DISTINCT unnest(used) id) v
    LEFT JOIN ${s}.services sv ON sv.id = v.id AND upper_inf(sv._block_range)
    LEFT JOIN (${stakedCounts(s, "$.service_id = ANY(used)")}) st ON st.service_id = v.id;
  END IF;
  fb := CASE WHEN fill_empty_buckets THEN ${s}._first_bucket(bucket, sp.f, sp.t_last, cv.covered) END;
  -- the old calls (no compare_start, no with_details) run the same query as before, with the new columns NULL
  IF compare_start IS NULL AND NOT with_details THEN
    RETURN QUERY SELECT q.*, NULL::text, NULL::bigint, NULL::bigint, NULL::numeric, NULL::numeric, cv.covered_from, cv.covered_to,
      cv.gaps FROM (
${usageRows}
    ) q ORDER BY 12, CASE WHEN row_limit IS NOT NULL THEN array_position(services, q.service_id) END, 1 DESC, 3;
    RETURN;
  END IF;
  RETURN QUERY
  WITH pv AS (
    ${serviceUsageSums(s, "rp", "prev_ok AND (all_services OR $.service_id = ANY(services))")}
  ), x(service_id, name, staked_suppliers, staked_applications, previous_estimated_compute_units) AS (
    -- with_details: the names and staked counts read above (the entity tables are read only then)
    SELECT v.id, d.name, d.staked_suppliers, d.staked_applications,
           CASE WHEN prev_ok THEN coalesce(pv.estimated_compute_units, 0) END
    FROM (SELECT DISTINCT unnest(services) id) v
    LEFT JOIN unnest(d_ids, d_names, d_suppliers, d_applications) d(id, name, staked_suppliers, staked_applications) ON d.id = v.id
    LEFT JOIN pv ON pv.service_id = v.id
    WHERE by_service
    UNION ALL
    SELECT 'all', NULL, CASE WHEN with_details THEN coalesce((SELECT sum(u.n) FROM unnest(d_suppliers) u(n)), 0)::bigint END,
           CASE WHEN with_details THEN coalesce((SELECT sum(u.n) FROM unnest(d_applications) u(n)), 0)::bigint END,
           CASE WHEN prev_ok THEN coalesce((SELECT sum(pv.estimated_compute_units) FROM pv), 0) END
    WHERE NOT by_service
  )
  SELECT q.*, x.name, x.staked_suppliers, x.staked_applications, x.previous_estimated_compute_units,
         CASE WHEN prev_ok THEN ${usageChange("q.estimated_compute_units", "x.previous_estimated_compute_units")} END,
         cv.covered_from, cv.covered_to, cv.gaps FROM (
${usageRows}
  ) q LEFT JOIN x ON x.service_id = q.service_id
  ORDER BY CASE WHEN top_by_settled IS NOT NULL OR row_limit IS NOT NULL THEN array_position(services, q.service_id) END,
           q.bucket_start DESC, q.service_id;
END $$;

-- Applications unstaked by the chain because their stake fell below the minimum
-- (EventApplicationUnbondingBegin.reason = APPLICATION_UNBONDING_REASON_BELOW_MIN_STAKE = 1, stored as the
-- proto enum number). applications NULL = every application.
CREATE OR REPLACE FUNCTION ${s}.get_app_auto_unstakes(applications text[], range_start timestamptz, range_end timestamptz,
  bucket text DEFAULT NULL, by_application boolean DEFAULT true,
  fill_empty_buckets boolean DEFAULT false)
RETURNS TABLE(bucket_start timestamptz, bucket_end timestamptz, application_id text, unstakes bigint, covered_from timestamptz,
  covered_to timestamptz, covered_gaps jsonb)
LANGUAGE plpgsql STABLE SET enable_mergejoin = off SET plan_cache_mode = force_custom_plan AS $$
DECLARE rg record; sp record; cv record; fb timestamptz;
BEGIN
  PERFORM ${s}._validate(applications, CASE WHEN applications IS NULL THEN '' ELSE 'applications' END,
                         range_start, range_end, bucket);
${covered("blocks", true)}
  rg := ${s}._block_heights(range_start, range_end);
  fb := CASE WHEN fill_empty_buckets THEN ${s}._first_bucket(bucket, sp.f, sp.t_last, cv.covered) END;
  RETURN QUERY SELECT q.*, cv.covered_from, cv.covered_to, cv.gaps FROM (
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
  SELECT ${s}._bucket(bucket, fb, sp.f), ${s}._bucket_end(bucket, fb, sp.t), u.id, 0::bigint
  FROM (SELECT DISTINCT unnest(applications) id) u
  WHERE u.id IS NOT NULL AND fill_empty_buckets AND by_application AND fb IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM res0 r0 WHERE r0.application_id = u.id)
  UNION ALL
  -- the group total of a list with no activity at all: one zero row
  SELECT ${s}._bucket(bucket, fb, sp.f), ${s}._bucket_end(bucket, fb, sp.t), 'all', 0::bigint
  WHERE fill_empty_buckets AND NOT by_application AND fb IS NOT NULL AND cardinality(applications) > 0 AND NOT EXISTS (SELECT 1 FROM res0)
  )
  SELECT r.* FROM res r WHERE bucket IS NULL OR NOT fill_empty_buckets OR r.bucket_start <= sp.t_last
  UNION ALL
  SELECT b.bucket_start, b.bucket_end, k.application_id, CASE WHEN k.unstakes_na THEN NULL ELSE 0 END
  FROM ${s}._covered_buckets(bucket, sp.f, sp.t_last, cv.covered) b
  CROSS JOIN (SELECT r.application_id, bool_and(r.unstakes IS NULL) unstakes_na FROM res r GROUP BY r.application_id) k
  WHERE bucket IS NOT NULL AND fill_empty_buckets
    AND NOT EXISTS (SELECT 1 FROM res r WHERE r.bucket_start = b.bucket_start AND coalesce(r.application_id, chr(1)) = coalesce(k.application_id, chr(1)))
  ) q ORDER BY 1 DESC, 3;
END $$;

-- Proofs per supplier: the claims it settled with and without a proof, the proofs it submitted, and how many the
-- chain validated or found invalid, the invalid ones counted per failure reason ({} when there are none). A claim
-- needs a proof only when the chain asks for one (probabilistic, or above the threshold). Each count is by the
-- block of its own event: a proof submitted in one bucket is often validated in the next, so submitted minus
-- validated minus invalid is the pending count only over a range that holds both events. Settled claims read
-- the daily rollup for whole days and claim_settlements at the edges, like get_supplier_earnings.
CREATE OR REPLACE FUNCTION ${s}.get_supplier_proofs(suppliers text[], range_start timestamptz, range_end timestamptz,
  bucket text DEFAULT NULL, by_service boolean DEFAULT false, by_supplier boolean DEFAULT true,
  owners text[] DEFAULT NULL, fill_empty_buckets boolean DEFAULT false, operators text[] DEFAULT NULL)
RETURNS TABLE(bucket_start timestamptz, bucket_end timestamptz, supplier_id text, service_id text,
  claims_settled_with_proof bigint, claims_settled_without_proof bigint,
  proofs_submitted bigint, proofs_validated bigint, proofs_invalid bigint, invalid_by_reason jsonb, covered_from timestamptz,
  covered_to timestamptz, covered_gaps jsonb)
LANGUAGE plpgsql STABLE SET enable_mergejoin = off SET plan_cache_mode = force_custom_plan AS $$
DECLARE rg record; rc record; sp record; all_suppliers boolean; cv record; fb timestamptz;
BEGIN
  -- NULL (no suppliers, owners or operators): every supplier
  suppliers := ${s}._supplier_ids(suppliers, owners, operators, false, range_start, range_end, bucket);
  all_suppliers := suppliers IS NULL;
${covered("blocks")}
  rg := ${s}._block_heights(range_start, range_end);
  rc := ${s}._ranges(range_start, range_end, bucket);
  fb := CASE WHEN fill_empty_buckets THEN ${s}._first_bucket(bucket, sp.f, sp.t_last, cv.covered) END;
  RETURN QUERY SELECT q.*, cv.covered_from, cv.covered_to, cv.gaps FROM (
  WITH res0(bucket_start, bucket_end, supplier_id, service_id, claims_settled_with_proof, claims_settled_without_proof, proofs_submitted, proofs_validated, proofs_invalid, invalid_by_reason) AS (
  WITH x AS (
    -- without by_service the smaller daily_claims_by_supplier is enough, as in get_supplier_earnings: the by-application
    -- one was 881k rows for an owner of 1037 suppliers over 30 days (2.4 s on mainnet, 2026-10-08)
    SELECT d.day::timestamp AT TIME ZONE 'UTC' block_time, d.supplier_id sup, ''::text svc,
           d.claims_with_proof with_proof, d.claim_count - d.claims_with_proof without_proof,
           0 submitted, 0 validated, 0 invalid, NULL::text reason
    FROM ${s}.daily_claims_by_supplier d
    WHERE NOT by_service AND (all_suppliers OR d.supplier_id = ANY(suppliers)) AND d.day BETWEEN rc.d1 AND rc.d2
    UNION ALL
    SELECT d.day::timestamp AT TIME ZONE 'UTC' block_time, d.supplier_id sup, d.service_id svc,
           d.claims_with_proof with_proof, d.claim_count - d.claims_with_proof without_proof,
           0 submitted, 0 validated, 0 invalid, NULL::text reason
    FROM ${s}.daily_claims_by_supplier_application_service d
    WHERE by_service AND (all_suppliers OR d.supplier_id = ANY(suppliers)) AND d.day BETWEEN rc.d1 AND rc.d2
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
  SELECT ${s}._bucket(bucket, fb, sp.f), ${s}._bucket_end(bucket, fb, sp.t), u.id, 'all', 0::bigint, 0::bigint, 0::bigint, 0::bigint, 0::bigint, '{}'::jsonb
  FROM (SELECT DISTINCT unnest(suppliers) id) u
  WHERE u.id IS NOT NULL AND fill_empty_buckets AND by_supplier AND fb IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM res0 r0 WHERE r0.supplier_id = u.id)
  UNION ALL
  -- the group total of a list with no activity at all: one zero row
  SELECT ${s}._bucket(bucket, fb, sp.f), ${s}._bucket_end(bucket, fb, sp.t), 'all', 'all', 0::bigint, 0::bigint, 0::bigint, 0::bigint, 0::bigint, '{}'::jsonb
  WHERE fill_empty_buckets AND NOT by_supplier AND fb IS NOT NULL AND (all_suppliers OR cardinality(suppliers) > 0) AND NOT EXISTS (SELECT 1 FROM res0)
  )
  SELECT r.* FROM res r WHERE bucket IS NULL OR NOT fill_empty_buckets OR r.bucket_start <= sp.t_last
  UNION ALL
  SELECT b.bucket_start, b.bucket_end, k.supplier_id, k.service_id, CASE WHEN k.claims_settled_with_proof_na THEN NULL ELSE 0 END, CASE WHEN k.claims_settled_without_proof_na THEN NULL ELSE 0 END, CASE WHEN k.proofs_submitted_na THEN NULL ELSE 0 END, CASE WHEN k.proofs_validated_na THEN NULL ELSE 0 END, CASE WHEN k.proofs_invalid_na THEN NULL ELSE 0 END, CASE WHEN k.invalid_by_reason_na THEN NULL ELSE '{}'::jsonb END
  FROM ${s}._covered_buckets(bucket, sp.f, sp.t_last, cv.covered) b
  CROSS JOIN (SELECT r.supplier_id, r.service_id, bool_and(r.claims_settled_with_proof IS NULL) claims_settled_with_proof_na, bool_and(r.claims_settled_without_proof IS NULL) claims_settled_without_proof_na, bool_and(r.proofs_submitted IS NULL) proofs_submitted_na, bool_and(r.proofs_validated IS NULL) proofs_validated_na, bool_and(r.proofs_invalid IS NULL) proofs_invalid_na, bool_and(r.invalid_by_reason IS NULL) invalid_by_reason_na FROM res r GROUP BY r.supplier_id, r.service_id) k
  WHERE bucket IS NOT NULL AND fill_empty_buckets
    AND NOT EXISTS (SELECT 1 FROM res r WHERE r.bucket_start = b.bucket_start AND coalesce(r.supplier_id, chr(1)) = coalesce(k.supplier_id, chr(1)) AND coalesce(r.service_id, chr(1)) = coalesce(k.service_id, chr(1)))
  ) q ORDER BY 1 DESC, 3, 4;
END $$;

-- Governance parameter history: only versions whose value differs from the previous version of the same
-- param (a module update rewrites every key; most rewrites change nothing). shared
-- session_grid_anchor_height 0 means the genesis grid, i.e. 1 (poktroll x/shared/types/session.go), so
-- 0 <-> 1 is not a change. active_at is NULL on versions written before that field existed.
CREATE OR REPLACE FUNCTION ${s}.get_param_history(namespaces text[], keys text[], range_start timestamptz,
  range_end timestamptz)
RETURNS TABLE(namespace text, key text, height bigint, block_time timestamptz, active_at bigint, value text, previous_value text, covered_from timestamptz,
  covered_to timestamptz, covered_gaps jsonb)
LANGUAGE plpgsql STABLE SET plan_cache_mode = force_custom_plan AS $$
DECLARE rg record; cv record;
BEGIN
  PERFORM ${s}._validate(NULL, '', range_start, range_end, NULL);
${covered(null, true)}
  rg := ${s}._block_heights(range_start, range_end);
  RETURN QUERY SELECT q.*, cv.covered_from, cv.covered_to, cv.gaps FROM (
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
  ) q ORDER BY 3 DESC, 1, 2;
END $$;

-- Compatibility: the signatures and JSON of the live functions, BETWEEN inclusive on UTC timestamps. They were named
-- money_* before; a database written by that version still has them.
DROP FUNCTION IF EXISTS ${s}.money_rewards_by_addresses_and_time(text[], timestamp, timestamp);
DROP FUNCTION IF EXISTS ${s}.money_rewards_by_addresses_and_time_group_by_date(text[], timestamp, timestamp, text);
DROP FUNCTION IF EXISTS ${s}.money_rewards_by_addresses_and_time_group_by_address_and_date(text[], timestamp, timestamp, text);
DROP FUNCTION IF EXISTS ${s}.money_rewards_of_addresses_by_suppliers_and_time(text[], text[], timestamp, timestamp);
DROP FUNCTION IF EXISTS ${s}.money_rewards_by_suppliers_and_time_group_by_address_and_date(text[], text[], timestamp, timestamp, text);
DROP FUNCTION IF EXISTS ${s}.money_mint_breakdown_between_dates(timestamp, timestamp);

-- The live functions take any range and any date_trunc unit: a NULL end or start_date > end_date matches nothing
-- (BETWEEN), and no unit caps the range. So the legacy_* functions read _income with capped = false, which lifts the
-- per-bucket range caps of _validate, and answer an empty range as the live ones. The rewards series:
-- hour, day, week, month and year come from _income; quarter, decade, century and millennium from its months; any other
-- unit date_trunc takes (minute, second, ...) per settlement height from the base tables. suppliers NULL = income from
-- any supplier and the stakers; a list = only what those suppliers' claims paid.
CREATE OR REPLACE FUNCTION ${s}._legacy_series(addresses text[], suppliers text[], start_date timestamp, end_date timestamp,
  trunc_interval text)
RETURNS TABLE(address text, date_truncated timestamp, amount_upokt numeric)
LANGUAGE plpgsql STABLE SET plan_cache_mode = force_custom_plan AS $$
DECLARE
  f timestamptz := start_date AT TIME ZONE 'UTC';
  t timestamptz := (end_date + interval '1 microsecond') AT TIME ZONE 'UTC';
  u text := lower(trunc_interval);
  h1 timestamptz; h2 timestamptz; e1 boolean; e2 boolean; lo bigint; hi bigint;
BEGIN
  IF start_date IS NULL OR end_date IS NULL OR start_date > end_date THEN
    RETURN;
  END IF;
  -- date_trunc's aliases (days, hrs, mon, y, qtr, ...) take the path of the unit they mean: one probe timestamp truncates
  -- differently under each unit. An invalid unit keeps its text, so it still raises only when a row is truncated.
  IF u IS NOT NULL THEN
    BEGIN
      SELECT x INTO u FROM unnest(ARRAY['microseconds', 'milliseconds', 'second', 'minute', 'hour', 'day', 'week', 'month',
        'quarter', 'year', 'decade', 'century', 'millennium']) x
      WHERE date_trunc(x, timestamp '2134-08-17 20:38:40.123456') = date_trunc(trunc_interval, timestamp '2134-08-17 20:38:40.123456');
    EXCEPTION WHEN invalid_parameter_value OR feature_not_supported THEN
      u := lower(trunc_interval);
    END;
  END IF;
  IF u = 'hour' AND suppliers IS NOT NULL THEN
    -- hourly_income_by_address_supplier has exactly this grain (address, hour, supplier): the whole hours inside the
    -- range from it, the partial hours at its edges from the base tables through _income
    h1 := date_trunc('hour', f, 'UTC');
    h2 := date_trunc('hour', t, 'UTC');
    IF h1 < f THEN h1 := h1 + interval '1 hour'; END IF;  -- first whole hour
    IF h1 >= h2 THEN h1 := t; h2 := t; END IF;  -- no whole hour: everything from the base
    IF h1 < h2 THEN
      PERFORM ${s}._require_current_rollups((h1 AT TIME ZONE 'UTC')::date, ((h2 - interval '1 microsecond') AT TIME ZONE 'UTC')::date);
    END IF;
    -- an edge with no settlement is skipped (end_date is inclusive, so a whole-hour range leaves a 1 µs tail)
    e1 := f < h1 AND EXISTS (SELECT 1 FROM ${s}.settlement_blocks sb WHERE sb.block_time >= f AND sb.block_time < h1);
    e2 := h2 < t AND EXISTS (SELECT 1 FROM ${s}.settlement_blocks sb WHERE sb.block_time >= h2 AND sb.block_time < t);
    RETURN QUERY
    SELECT x.address, x.hour AT TIME ZONE 'UTC', sum(x.amount_upokt)::numeric
    FROM (SELECT h.address, h.hour, h.amount_upokt FROM ${s}.hourly_income_by_address_supplier h
          WHERE h.address = ANY(addresses) AND h.hour >= h1 AND h.hour < h2 AND h.supplier_id = ANY(suppliers)
          UNION ALL
          SELECT i.address, i.bucket_start, i.amount_upokt
          FROM ${s}._income(addresses, f, h1, 'hour', false, true, fill_empty_buckets => false, suppliers => suppliers, capped => false) i
          WHERE e1
          UNION ALL
          SELECT i.address, i.bucket_start, i.amount_upokt
          FROM ${s}._income(addresses, h2, t, 'hour', false, true, fill_empty_buckets => false, suppliers => suppliers, capped => false) i
          WHERE e2) x
    GROUP BY 1, 2;
  ELSIF u IS NULL OR u IN ('hour', 'day', 'week', 'month', 'year', 'quarter', 'decade', 'century', 'millennium') THEN
    RETURN QUERY
    SELECT i.address,
           CASE WHEN u IS NULL THEN NULL
                WHEN u IN ('hour', 'day', 'week', 'month', 'year') THEN i.bucket_start AT TIME ZONE 'UTC'
                ELSE date_trunc(u, i.bucket_start AT TIME ZONE 'UTC') END,
           sum(i.amount_upokt)::numeric
    FROM ${s}._income(addresses, f, t, CASE WHEN u IN ('hour', 'day', 'week', 'month', 'year') THEN u WHEN u IS NOT NULL THEN 'month' END,
                      false, suppliers IS NOT NULL, fill_empty_buckets => false, suppliers => suppliers, capped => false) i
    GROUP BY 1, 2;
  ELSE
    -- an invalid unit raises date_trunc's own error, as in the live function (only when a row is truncated)
    SELECT min(sb.height), max(sb.height) INTO lo, hi FROM ${s}.settlement_blocks sb WHERE sb.block_time >= f AND sb.block_time < t;
    RETURN QUERY
    SELECT v.address, date_trunc(trunc_interval, sb.block_time AT TIME ZONE 'UTC'), sum(v.amount_upokt)::numeric
    FROM ${s}.v_income_base v JOIN ${s}.settlement_blocks sb ON sb.height = v.height
    WHERE v.address = ANY(addresses) AND v.height BETWEEN lo AND hi
      AND (suppliers IS NULL OR nullif(v.supplier_id, '') = ANY(suppliers))
    GROUP BY 1, 2;
  END IF;
END $$;


-- The range of a legacy_* call ([start_date, end_date], inclusive) as the catalog's twins report it, with end_date as
-- requested_to and covered_to; start_from is the start_date to read with (moved up to covered_from, 'infinity' when
-- nothing is covered, which every legacy_* function reads as an empty range); empty = a well-formed range that nothing
-- covered overlaps, whose data is null in every legacy_* function (not a zero: nothing was read). end_to is the end_date to
-- read with: no later than covered_to (inclusive). A range that matches
-- nothing (NULL bound, start after end) reports no coverage (covered_from / covered_to NULL, gaps []).
CREATE OR REPLACE FUNCTION ${s}._legacy_range(start_date timestamp, end_date timestamp, OUT range json, OUT start_from timestamp,
  OUT empty boolean, OUT end_to timestamp)
LANGUAGE plpgsql STABLE SET plan_cache_mode = force_custom_plan AS $$
DECLARE cv record;
BEGIN
  IF start_date IS NULL OR end_date IS NULL OR start_date > end_date THEN
    -- matches nothing, as in the live function: no coverage to report, and the live function's empty answer
    range := ${s}._range_of(start_date AT TIME ZONE 'UTC', end_date AT TIME ZONE 'UTC', NULL, NULL, '[]', true);
    start_from := start_date; empty := false; end_to := end_date;
    RETURN;
  END IF;
  cv := ${s}._coverage(start_date AT TIME ZONE 'UTC', (end_date + interval '1 microsecond') AT TIME ZONE 'UTC');
  -- covered_to back to end_date's inclusive sense
  range := ${s}._range_of(start_date AT TIME ZONE 'UTC', end_date AT TIME ZONE 'UTC', cv.covered_from,
                         cv.covered_to - interval '1 microsecond', cv.gaps, true);
  start_from := CASE WHEN cv.empty THEN 'infinity' ELSE cv.data_from AT TIME ZONE 'UTC' END;
  empty := cv.empty;
  end_to := CASE WHEN cv.empty THEN end_date ELSE least(end_date, (cv.covered_to - interval '1 microsecond') AT TIME ZONE 'UTC') END;
END $$;

-- The two scalar ones returned numeric before: dropped first, a return type CREATE OR REPLACE cannot change.
DO $$
DECLARE f regprocedure;
BEGIN
  FOR f IN SELECT p.oid::regprocedure FROM pg_proc p
           WHERE p.pronamespace = '${s}'::regnamespace AND p.prorettype = 'numeric'::regtype
             AND p.proname IN ('legacy_rewards_by_addresses_and_time', 'legacy_rewards_of_addresses_by_suppliers_and_time') LOOP
    EXECUTE format('DROP FUNCTION %s', f);
  END LOOP;
END $$;

-- data: the total as a JSON string ("201156529", as GraphQL gave the live numeric: a BigFloat string, no double
-- rounding); NULL when nothing covered overlaps the range (a covered range with no income is "0")
CREATE OR REPLACE FUNCTION ${s}.legacy_rewards_by_addresses_and_time(addresses text[], start_date timestamp,
  end_date timestamp)
RETURNS json LANGUAGE sql STABLE AS $$
  SELECT json_build_object('range', l.range, 'data', CASE WHEN NOT l.empty THEN
    (SELECT coalesce(sum(i.amount_upokt), 0)::text FROM ${s}._legacy_series(addresses, NULL, l.start_from, l.end_to, NULL) i) END)
  FROM ${s}._legacy_range(start_date, end_date) l
$$;

CREATE OR REPLACE FUNCTION ${s}.legacy_rewards_by_addresses_and_time_group_by_date(addresses text[], start_date timestamp,
  end_date timestamp, trunc_interval text)
RETURNS json LANGUAGE sql STABLE AS $$
  SELECT json_build_object('range', l.range, 'data', (
    SELECT json_agg(json_build_object('date_truncated', t, 'total_amount', a) ORDER BY t)
    FROM (SELECT i.date_truncated t, sum(i.amount_upokt)::numeric a
          FROM ${s}._legacy_series(addresses, NULL, l.start_from, l.end_to, trunc_interval) i GROUP BY 1) s))
  FROM ${s}._legacy_range(start_date, end_date) l
$$;

CREATE OR REPLACE FUNCTION ${s}.legacy_rewards_by_addresses_and_time_group_by_address_and_date(addresses text[],
  start_date timestamp, end_date timestamp, trunc_interval text)
RETURNS json LANGUAGE sql STABLE AS $$
  SELECT json_build_object('range', l.range, 'data', (
    SELECT json_agg(json_build_object('address', i.address, 'date_truncated', i.date_truncated, 'total_amount', i.amount_upokt)
                    ORDER BY i.date_truncated)
    FROM ${s}._legacy_series(addresses, NULL, l.start_from, l.end_to, trunc_interval) i))
  FROM ${s}._legacy_range(start_date, end_date) l
$$;

CREATE OR REPLACE FUNCTION ${s}.legacy_rewards_of_addresses_by_suppliers_and_time(addresses text[],
  supplier_addresses text[], start_date timestamp, end_date timestamp)
RETURNS json LANGUAGE sql STABLE AS $$
  SELECT json_build_object('range', l.range, 'data', CASE WHEN NOT l.empty THEN
    (SELECT coalesce(sum(i.amount_upokt), 0)::text
     FROM ${s}._legacy_series(addresses, coalesce(supplier_addresses, '{}'), l.start_from, l.end_to, NULL) i) END)
  FROM ${s}._legacy_range(start_date, end_date) l
$$;

CREATE OR REPLACE FUNCTION ${s}.legacy_rewards_by_suppliers_and_time_group_by_address_and_date(addresses text[],
  supplier_addresses text[], start_date timestamp, end_date timestamp, trunc_interval text)
RETURNS json LANGUAGE sql STABLE AS $$
  SELECT json_build_object('range', l.range, 'data', (
    SELECT json_agg(json_build_object('address', i.address, 'date_truncated', i.date_truncated, 'total_amount', i.amount_upokt)
                    ORDER BY i.date_truncated)
    FROM ${s}._legacy_series(addresses, coalesce(supplier_addresses, '{}'), l.start_from, l.end_to, trunc_interval) i))
  FROM ${s}._legacy_range(start_date, end_date) l
$$;

-- inflation is the whole global mint (every role, = TLM_GLOBAL_MINT_INFLATION), reimbursement the application's escrow to
-- the DAO, mint_burn the relay mint: the same JSON as the live function since #94 (md5 equal on mainnet over 24 h, 7 d
-- and 30 d, and on beta month by month, 2026-10-05), except at beta heights 153513, 153573, 153633 and 153693, whose 32
-- claims each carry a 1 upokt escrow here and none in the indexer's event_claim_settleds.mints (128 upokt in March 2026).
-- The chain did mint them (block_results of beta 153513: 32 reimbursement requests of 1 upokt and a 32 upokt coinbase),
-- so this function matches the chain there and the live one undercounts.
CREATE OR REPLACE FUNCTION ${s}.legacy_mint_breakdown_between_dates(start_date timestamp, end_date timestamp)
RETURNS json LANGUAGE plpgsql STABLE SET plan_cache_mode = force_custom_plan AS $$
DECLARE l record;
BEGIN
  l := ${s}._legacy_range(start_date, end_date);
  IF l.empty THEN RETURN json_build_object('range', l.range, 'data', NULL); END IF;
  IF l.start_from IS NULL OR l.end_to IS NULL OR l.start_from > l.end_to THEN
    RETURN json_build_object('range', l.range, 'data', json_build_object('reimbursement', 0, 'inflation', 0, 'mint_burn', 0));
  END IF;
  RETURN (SELECT json_build_object('range', l.range, 'data', json_build_object(
    'reimbursement', coalesce(sum(f.amount_upokt) FILTER (WHERE f.flow = 'reimbursement'), 0),
    'inflation', coalesce(sum(f.amount_upokt) FILTER (WHERE f.flow = 'global_mint'), 0),
    'mint_burn', coalesce(sum(f.amount_upokt) FILTER (WHERE f.flow = 'mint_equals_burn'), 0)))
  FROM ${s}._supply_flows(l.start_from AT TIME ZONE 'UTC', (l.end_to + interval '1 microsecond') AT TIME ZONE 'UTC') f);
END $$;

-- burn_mint: what the applications burned for the claims settled in the range (_supply_flows' burn).
CREATE OR REPLACE FUNCTION ${s}.legacy_burn_breakdown_between_dates(start_date timestamp, end_date timestamp)
RETURNS json LANGUAGE plpgsql STABLE SET plan_cache_mode = force_custom_plan AS $$
DECLARE l record;
BEGIN
  l := ${s}._legacy_range(start_date, end_date);
  IF l.empty THEN RETURN json_build_object('range', l.range, 'data', NULL); END IF;
  IF l.start_from IS NULL OR l.end_to IS NULL OR l.start_from > l.end_to THEN
    RETURN json_build_object('range', l.range, 'data', json_build_object('burn_mint', 0));
  END IF;
  RETURN (SELECT json_build_object('range', l.range, 'data',
                   json_build_object('burn_mint', coalesce(sum(f.amount_upokt) FILTER (WHERE f.flow = 'burn'), 0)))
  FROM ${s}._supply_flows(l.start_from AT TIME ZONE 'UTC', (l.end_to + interval '1 microsecond') AT TIME ZONE 'UTC') f);
END $$;

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

-- One element per service the suppliers are configured for now or settled claims on in the range (as the live
-- function), with those claims (zeros for an empty range, as the live function); services ordered by id.
CREATE OR REPLACE FUNCTION ${s}.legacy_rewards_by_suppliers_and_time_group_by_service(operator_addresses text[],
  start_ts timestamp, end_ts timestamp)
RETURNS jsonb LANGUAGE plpgsql STABLE SET plan_cache_mode = force_custom_plan AS $$
DECLARE
  l record := ${s}._legacy_range(start_ts, end_ts);
  f timestamptz := l.start_from AT TIME ZONE 'UTC';
  t timestamptz := (l.end_to + interval '1 microsecond') AT TIME ZONE 'UTC';
BEGIN
  IF l.empty THEN RETURN jsonb_build_object('range', l.range, 'data', NULL); END IF;
  IF l.start_from IS NULL OR l.end_to IS NULL OR l.start_from > l.end_to THEN
    RETURN jsonb_build_object('range', l.range, 'data', (SELECT jsonb_agg(jsonb_build_object('service_id', sv.service_id, 'relays', 0, 'estimated_relays', 0,
                     'computed_units', 0, 'estimated_computed_units', 0, 'gross_rewards', 0) ORDER BY sv.service_id)
            FROM (SELECT DISTINCT ssc.service_id FROM ${s}.supplier_service_configs ssc
                  WHERE ssc.supplier_id = ANY(operator_addresses) AND upper_inf(ssc._block_range)) sv));
  END IF;
  RETURN jsonb_build_object('range', l.range, 'data', (
    WITH c AS (SELECT * FROM ${s}._legacy_claims_by_service(operator_addresses, f, t))
    SELECT jsonb_agg(jsonb_build_object(
             'service_id', sv.service_id,
             'relays', coalesce(c.relays, 0),
             'estimated_relays', coalesce(c.estimated_relays, 0),
             'computed_units', coalesce(c.compute_units, 0),
             'estimated_computed_units', coalesce(c.estimated_compute_units, 0),
             'gross_rewards', coalesce(c.settled_upokt, 0)) ORDER BY sv.service_id)
    FROM (SELECT ssc.service_id FROM ${s}.supplier_service_configs ssc
          WHERE ssc.supplier_id = ANY(operator_addresses) AND upper_inf(ssc._block_range)
          UNION
          SELECT c.service_id FROM c) sv
    LEFT JOIN c ON c.service_id = sv.service_id));
END $$;

-- One element per service of the staked suppliers whose current configuration shares revenue with the addresses (as the
-- live function). net_rewards is what the addresses received from that service's claims, as the live function. The claim
-- columns (gross_rewards, relays, computed_units and their estimates) differ on purpose: the live function adds a claim
-- once per transfer that paid one of the addresses (relay and global mint, and each address of the list), here each claim
-- that paid them counts once. Measured on mainnet: pokt1m0yk72fcvut72ujrs7hyf4mzgahe4c9ya429eh on 2026-10-03 got 27
-- transfers from 20 claims (948613-finalize_block-3067 pays it twice): relays 577,473 live, 289,472 per claim; gross
-- 553,512,909 live, 277,061,678 per claim; net 209,138,830 in both.
-- The claims come from daily_claims_paid_by_address_service for each whole day of the range whose every settlement it
-- holds (settlement_blocks.claims_paid_rollup), and from v_claims_paid for the rest: the edges, and each day with a
-- settlement it does not hold. The rollup counts a claim once per address: for a list, a claim that paid k >= 2 of its
-- addresses is in k rows, and k - 1 of them are taken back (corr). The corrections count a claim's listed shareholders
-- only, so each rollup day one of the list's addresses was paid in any other role than shareholder (rev_share) or staker
-- (STAKER_ROLES, which no claim pays) is read from the claims instead: today the DAO, a service owner, an application, and
-- a role added later falls there too instead of counting twice. The days read from the claims go as runs of consecutive
-- settlement days (a day without settlements does not break a run), each one height range: a list with the DAO, paid
-- every day, is one range for the whole span, and then no correction is computed at all. The k - 1 come per
-- supplier and month, or day, where every claim of the supplier paid each listed
-- shareholder it paid at all (a relay leg on every claim: its income rollups count one per claim and address), and per
-- claim where not. Measured on mainnet (2026-10-09, 7 rev-share addresses of
-- overlapping fleets): over 30 days 4,601 supplier-days paid two or more of them, all of that kind; over 238 days 261 of
-- 32,733 were not (1,648 claims).
-- jit = off: the main query is estimated at ~3-4.5M (the corrections' joins, planned for any list), past
-- jit_optimize_above_cost and jit_inline_above_cost, and JIT compiled 265 functions with inlining and optimization for
-- 1.4-1.8 s of a call whose execution took 17 ms (mainnet replica, 2026-10-10, 30 days: one address 1.5 s -> 0.14 s,
-- nodefleet's 7 wallets 2.8 s -> 0.82 s).
CREATE OR REPLACE FUNCTION ${s}.legacy_rewards_by_addresses_and_time_group_by_service(addresses text[],
  start_ts timestamp, end_ts timestamp)
RETURNS jsonb LANGUAGE plpgsql STABLE SET plan_cache_mode = force_custom_plan SET jit = off AS $$
DECLARE
  l record := ${s}._legacy_range(start_ts, end_ts);
  f timestamptz := l.start_from AT TIME ZONE 'UTC';
  t timestamptz := (l.end_to + interval '1 microsecond') AT TIME ZONE 'UTC';
  rg record; ud date[]; ulo bigint[]; uhi bigint[]; sups text[]; svcs text[]; la text[]; mm date[]; dd date[];
BEGIN
  IF l.empty THEN RETURN jsonb_build_object('range', l.range, 'data', NULL); END IF;
  -- resolved once: inside the query a filter would call it for every row it scans
  sups := ${s}._operator_suppliers(addresses);
  svcs := ARRAY(SELECT DISTINCT ssc.service_id FROM ${s}.supplier_service_configs ssc
                WHERE ssc.supplier_id = ANY(sups) AND upper_inf(ssc._block_range));
  IF l.start_from IS NULL OR l.end_to IS NULL OR l.start_from > l.end_to THEN
    RETURN jsonb_build_object('range', l.range, 'data', (
      SELECT jsonb_agg(jsonb_build_object('service_id', sv, 'relays', 0, 'estimated_relays', 0, 'computed_units', 0,
                       'estimated_computed_units', 0, 'gross_rewards', 0, 'net_rewards', 0) ORDER BY sv)
      FROM unnest(svcs) sv));
  END IF;
  la := ARRAY(SELECT DISTINCT a FROM unnest(addresses) a WHERE a IS NOT NULL);
  -- a range over a settlement written with an older rollup version raises here, for a list as for one address; a list
  -- raised there before reading the rollup too, in _income (net below), which reads the rollups for any list
  rg := ${s}._ranges(f, t, NULL);
  -- the rollup days with a settlement the rollup does not hold, and for a list each day one of its addresses was paid
  -- in a role other than shareholder or staker (the corrections below count a claim's listed shareholders only): read
  -- from the claims, with every settlement of those days
  ud := ARRAY(SELECT sb.day FROM ${s}.settlement_blocks sb WHERE sb.day BETWEEN rg.d1 AND rg.d2 AND NOT sb.claims_paid_rollup
              UNION
              SELECT d.day FROM ${s}.daily_income_by_address d
              WHERE cardinality(la) > 1 AND d.address = ANY(la) AND d.day BETWEEN rg.d1 AND rg.d2
                AND d.role NOT IN ('rev_share', ${STAKER_ROLES_SQL}));
  -- ...as runs of consecutive settlement days, each the height range of its settlements (days follow heights): a day's
  -- rank among the settlement days less its rank among the days of ud is constant along a run
  SELECT array_agg(lo ORDER BY lo), array_agg(hi ORDER BY lo) INTO ulo, uhi
  FROM (SELECT min(x.height) lo, max(x.height) hi
        FROM (SELECT y.height, y.fallback,
                     dense_rank() OVER (ORDER BY y.day) - dense_rank() OVER (PARTITION BY y.fallback ORDER BY y.day) run
              FROM (SELECT sb.height, sb.day, sb.day = ANY(ud) fallback
                    FROM ${s}.settlement_blocks sb WHERE sb.day BETWEEN rg.d1 AND rg.d2) y) x
        WHERE x.fallback GROUP BY x.run) r;
  -- the corrections only when a rollup day is left to read from the rollup
  IF cardinality(la) > 1 AND rg.d1 <= rg.d2
     AND EXISTS (SELECT 1 FROM ${s}.settlement_blocks sb WHERE sb.day BETWEEN rg.d1 AND rg.d2 AND sb.day <> ALL(ud)) THEN
    -- the corrections by month (mm): each month whose every settlement is in the rollup days, outside ud (which holds the
    -- days with a height the claims rollup does not hold) and held by monthly_claims_by_supplier_service;
    -- by day (dd): the other rollup days outside ud
    mm := ARRAY(SELECT m::date FROM generate_series(date_trunc('month', rg.d1::timestamp), date_trunc('month', rg.d2::timestamp), interval '1 month') m
                WHERE NOT EXISTS (SELECT 1 FROM ${s}.settlement_blocks sb
                                  WHERE sb.day >= m AND sb.day < m + interval '1 month' AND NOT sb.monthly_claims_rollup)
                  AND NOT EXISTS (SELECT 1 FROM unnest(ud) u WHERE u >= m AND u < m + interval '1 month')
                  AND NOT EXISTS (SELECT 1 FROM ${s}.settlement_blocks sb WHERE sb.day >= m AND sb.day < rg.d1)
                  AND NOT EXISTS (SELECT 1 FROM ${s}.settlement_blocks sb WHERE sb.day > rg.d2 AND sb.day < m + interval '1 month'));
    dd := ARRAY(SELECT g::date FROM generate_series(rg.d1::timestamp, rg.d2::timestamp, interval '1 day') g
                WHERE date_trunc('month', g)::date <> ALL(mm) AND g::date <> ALL(ud));
  END IF;
  RETURN jsonb_build_object('range', l.range, 'data', (
    WITH services AS (
      SELECT sv.service_id FROM unnest(svcs) sv(service_id)
    ), paid AS (
      -- the claims that paid the addresses, each once; one set of heights per branch, so each reaches the view's indexes
      SELECT p.height, p.event_idx FROM ${s}.v_claims_paid p WHERE p.address = ANY(addresses) AND p.height BETWEEN rg.lo1 AND rg.hi1
      UNION
      SELECT p.height, p.event_idx FROM ${s}.v_claims_paid p WHERE p.address = ANY(addresses) AND p.height BETWEEN rg.lo2 AND rg.hi2
      UNION
      -- one scan per run of days read from the claims (LATERAL: each run's range reaches the view's indexes)
      SELECT p.height, p.event_idx FROM unnest(ulo, uhi) u(lo, hi)
      CROSS JOIN LATERAL (SELECT p.height, p.event_idx FROM ${s}.v_claims_paid p
                          WHERE p.address = ANY(addresses) AND p.height BETWEEN u.lo AND u.hi) p
    ), mk AS (
      -- the supplier-months whose claims paid k >= 2 of the list as shareholders (rn: its relay legs, one per claim and
      -- address)
      SELECT m.supplier_id, m.month, count(DISTINCT m.address) k, array_agg(m.transfer_count) FILTER (WHERE m.family = 'relay') rn
      FROM ${s}.monthly_income_by_address_supplier m
      WHERE m.address = ANY(la) AND m.role = 'rev_share' AND (mm IS NOT NULL OR dd IS NOT NULL)
        AND m.month >= date_trunc('month', rg.d1::timestamp)::date AND m.month <= rg.d2
      GROUP BY 1, 2 HAVING count(DISTINCT m.address) >= 2
    ), mn AS (
      SELECT s.supplier_id, s.month, sum(s.claim_count) n
      FROM mk JOIN ${s}.monthly_claims_by_supplier_service s USING (supplier_id, month)
      WHERE mk.month = ANY(mm) GROUP BY 1, 2
    ), mg AS (
      -- whole by month when every claim of the month paid each of them
      SELECT g.supplier_id, g.month, g.k, coalesce(g.month = ANY(mm) AND cardinality(g.rn) = g.k AND n.n = ALL(g.rn), false) clean
      FROM mk g LEFT JOIN mn n USING (supplier_id, month)
    ), dg AS (
      -- the other ones by day: its days the rollup holds outside the whole months, or every day of a month not whole
      SELECT g.supplier_id, g.day, g.k, coalesce(cardinality(g.rn) = g.k AND c.claim_count = ALL(g.rn), false) clean
      FROM (SELECT d.supplier_id, d.day, count(DISTINCT d.address) k, array_agg(d.transfer_count) FILTER (WHERE d.family = 'relay') rn
            FROM mg JOIN ${s}.daily_income_by_address_supplier d
              ON d.supplier_id = mg.supplier_id AND d.day >= mg.month AND d.day < (mg.month + interval '1 month')::date
            WHERE NOT mg.clean AND d.address = ANY(la) AND d.role = 'rev_share' AND (d.day = ANY(dd) OR mg.month = ANY(mm))
            GROUP BY 1, 2 HAVING count(DISTINCT d.address) >= 2) g
      JOIN ${s}.daily_claims_by_supplier c USING (supplier_id, day)
    ), corr AS (
      SELECT s.service_id, (g.k - 1)::numeric * s.settled_upokt settled_upokt, (g.k - 1)::numeric * s.relays relays,
             (g.k - 1)::numeric * s.estimated_relays estimated_relays, (g.k - 1)::numeric * s.claimed_compute_units claimed_compute_units,
             (g.k - 1)::numeric * s.estimated_compute_units estimated_compute_units
      FROM mg g JOIN ${s}.monthly_claims_by_supplier_service s ON s.supplier_id = g.supplier_id AND s.month = g.month
      WHERE g.clean
      UNION ALL
      SELECT s.service_id, (g.k - 1)::numeric * s.settled_upokt, (g.k - 1)::numeric * s.relays, (g.k - 1)::numeric * s.estimated_relays,
             (g.k - 1)::numeric * s.claimed_compute_units, (g.k - 1)::numeric * s.estimated_compute_units
      FROM dg g JOIN ${s}.daily_claims_by_supplier_application_service s ON s.supplier_id = g.supplier_id AND s.day = g.day
      WHERE g.clean
      UNION ALL
      -- per claim: k, its listed shareholders
      SELECT c.service_id, (x.k - 1)::numeric * c.settled_upokt, (x.k - 1)::numeric * c.relays, (x.k - 1)::numeric * c.estimated_relays,
             (x.k - 1)::numeric * c.claimed_compute_units, (x.k - 1)::numeric * c.estimated_compute_units
      FROM dg g JOIN ${s}.settlement_blocks sb ON sb.day = g.day
      JOIN ${s}.claim_settlements c ON c.supplier_id = g.supplier_id AND c.height = sb.height
      CROSS JOIN LATERAL (SELECT count(DISTINCT sp.recipient_id) k FROM ${s}.shareholder_payouts sp
                          WHERE sp.height = c.height AND sp.event_idx = c.event_idx AND sp.recipient_id = ANY(la)
                            AND (sp.relay_upokt > 0 OR sp.global_upokt > 0)) x
      WHERE NOT g.clean AND x.k >= 2
    ), claims AS (
      SELECT x.service_id, sum(x.settled_upokt)::numeric settled_upokt, sum(x.relays)::numeric relays,
             sum(x.estimated_relays)::numeric estimated_relays, sum(x.claimed_compute_units)::numeric compute_units,
             sum(x.estimated_compute_units)::numeric estimated_compute_units
      FROM (SELECT c.service_id, c.settled_upokt, c.relays, c.estimated_relays, c.claimed_compute_units, c.estimated_compute_units
            FROM paid p JOIN ${s}.claim_settlements c ON c.height = p.height AND c.event_idx = p.event_idx
            UNION ALL
            SELECT r.service_id, r.settled_upokt, r.relays, r.estimated_relays, r.claimed_compute_units, r.estimated_compute_units
            FROM ${s}.daily_claims_paid_by_address_service r
            -- not a row left at zero claims (a subtraction deletes those only at the keys it touched)
            WHERE r.address = ANY(la) AND r.day BETWEEN rg.d1 AND rg.d2 AND r.day <> ALL(ud) AND r.claim_count > 0
            UNION ALL
            SELECT x.service_id, -x.settled_upokt, -x.relays, -x.estimated_relays, -x.claimed_compute_units, -x.estimated_compute_units
            FROM corr x) x
      GROUP BY 1
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
    LEFT JOIN net n ON n.service_id = sv.service_id));
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

-- <function>_json for every catalog function that returns rows: the same arguments and defaults, and every row (one
-- page of row_limit for the functions that page with before_*) in one jsonb array, in the function's row order, from one execution. Numbers come as JSON strings (amounts reach 2^53, past
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
  -- blocks: the function covers the indexer's own tables (covered(..., true) in its body), and so does its twin's range
  FOR f IN SELECT p.proname, pg_get_function_arguments(p.oid) args,
                  (SELECT string_agg(format('%I => %I', n, n), ', ' ORDER BY i)
                   FROM unnest(p.proargnames[1:p.pronargs]) WITH ORDINALITY a(n, i)) call,
                  position('._coverage(range_start, range_end, true)' in p.prosrc) > 0 blocks
           FROM pg_proc p
           WHERE p.pronamespace = '${s}'::regnamespace AND p.proname = ANY(${CATALOG_SQL}) LOOP
    EXECUTE format('CREATE FUNCTION ${s}.%I(%s) RETURNS jsonb LANGUAGE sql STABLE AS $f$
      WITH r AS (SELECT * FROM ${s}.%I(%s) WITH ORDINALITY r)
      SELECT jsonb_build_object(
        ''range'', coalesce(
          (SELECT ${s}._range_of(range_start, range_end, r.covered_from, r.covered_to, r.covered_gaps, false)::jsonb
           FROM r ORDER BY r.ordinality LIMIT 1),
          ${s}._range_json(range_start, range_end, %s)),
        ''data'', (SELECT coalesce(jsonb_agg((SELECT jsonb_object_agg(e.k, CASE jsonb_typeof(e.v)
                     WHEN ''number'' THEN to_jsonb(e.v #>> ''{}'')
                     WHEN ''array'' THEN ${s}._json_strings(e.v) WHEN ''object'' THEN ${s}._json_strings(e.v)
                     ELSE e.v END)
                   FROM jsonb_each(to_jsonb(r) - ''ordinality'' - ''covered_from'' - ''covered_to'' - ''covered_gaps'') e(k, v))
                   ORDER BY r.ordinality), ''[]''::jsonb) FROM r %s)) $f$', f.proname || '_json', f.args, f.proname, f.call,
      f.blocks::text,
      -- these answer one row of NULLs when only gaps are left: it carries them to the range, it is no data
      CASE f.proname WHEN 'get_tx_counts' THEN 'WHERE r.msg_type IS NOT NULL'
                     WHEN 'get_staked_suppliers_by_service' THEN 'WHERE r.service_id IS NOT NULL'
                     WHEN 'get_supply' THEN 'WHERE r.height IS NOT NULL'
                     WHEN 'get_supply_composition' THEN 'WHERE r.height IS NOT NULL'
                     WHEN 'get_network_claims' THEN 'WHERE r.bucket_start IS NOT NULL'
                     WHEN 'get_domain_staked_suppliers' THEN 'WHERE r.day IS NOT NULL'
                     WHEN 'get_supplier_session_funnel' THEN 'WHERE r.bucket_start IS NOT NULL'
                     WHEN 'get_network_sessions' THEN 'WHERE r.bucket_start IS NOT NULL'
                     WHEN 'get_supplier_session_list' THEN 'WHERE r.session_id IS NOT NULL'
                     WHEN 'get_session_rosters' THEN 'WHERE r.session_id IS NOT NULL' ELSE '' END);
  END LOOP;
END $$;
${blockTimeColumnsSql(s)}
`;
}

// PostGraphile computed columns: the block time of a row that carries a height, now that the block relations are
// gone (pnf-explorer /txs, /tx, the account view: one request less a page). Transaction.blockTime,
// NativeTransfer.blockTime, Balance.lastUpdatedTime, checked through subql-query 2.22.2 in lists, by id and with
// blockHeight. One idx_blocks_id probe per row (3-12 µs on mainnet, 2026-10-14); NULL while the block row is not
// written yet. A function with a table-row argument depends on the table's row type: SubQuery's migration adds and
// drops columns around it, but its dropTable (no CASCADE) fails while the function exists, so removing one of these
// entities from schema.graphql needs its function dropped first. Created only where the tables exist (the catalog's
// test schema has none of them). @omit filter: the field is not in the entity's filter (connection-filter makes computed
// columns filterable by default), since a filter on a block time reads the whole table; not sortable either (no
// @sortable), checked through subql-query 2.22.2 introspection.
const BLOCK_TIME_COLUMNS: [string, string, string, string][] = [
  ["transactions_block_time", "transactions", "block_id", "Time of the block that includes the transaction (UTC); null until that block is written."],
  ["native_transfers_block_time", "native_transfers", "block_id", "Time of the block that includes the transfer (UTC); null until that block is written."],
  ["balances_last_updated_time", "balances", "last_updated_block_id", "Time of the block where the balance last changed (UTC); null until that block is written."],
];
export const blockTimeColumnsSql = (s: string): string =>
  BLOCK_TIME_COLUMNS.map(
    ([fn, table, column, what]) => `DO $do$
BEGIN
  IF to_regclass('${s}.${table}') IS NOT NULL AND to_regclass('${s}.blocks') IS NOT NULL THEN
    EXECUTE $f$CREATE OR REPLACE FUNCTION ${s}.${fn}(r ${s}.${table}) RETURNS timestamptz LANGUAGE sql STABLE AS $b$
      SELECT bl.timestamp AT TIME ZONE 'UTC' FROM ${s}.blocks bl WHERE bl.id = r.${column} LIMIT 1
    $b$$f$;
    EXECUTE $f$COMMENT ON FUNCTION ${s}.${fn}(${s}.${table}) IS E'@omit filter\n${what}'$f$;
  END IF;
END $do$;`
  ).join("\n");
