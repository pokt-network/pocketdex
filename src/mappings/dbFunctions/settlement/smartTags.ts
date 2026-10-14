// PostGraphile smart tags for the settlement money layer. The GraphQL API exposes the catalog functions and the
// legacy_* ones: the tables and the view behind them and the internal helpers are hidden with @omit. Without it
// PostGraphile would publish a collection (with filters and aggregates) for every table, which lets one query scan a whole table.
//
// The catalog functions that return rows, those named in DESCRIPTIONS (get_*, money_coverage), are tagged
// @simpleCollections only, so GraphQL exposes each as a plain list (getIncomeList, ...). As a connection it fails in
// subql-query 2.22.2: its historical plugin adds "alias._block_range @> height" to every function connection, and the
// catalog rows have no _block_range (.local/ab/money/graphql_audit/REPORT.md). A list has no totalCount and no
// pages: the query service's --query-limit caps its rows, and tilt sets it to 1000 (the default, 100, cuts silently).
//
// Runs on every indexer start, after the tables and functions exist. SubQuery may rewrite the comment of
// an entity table it manages (delegations) on a schema migration; the next start puts @omit back.

export const OMITTED_TABLES = [
  "settlement_blocks",
  "settlement_gaps",
  "money_progress",
  "settlement_history_findings",
  "settlement_replay_snapshots",
  "claim_settlements",
  "shareholder_payouts",
  "staker_payouts",
  "validator_distributions",
  "delegator_validator_payouts",
  "claim_expirations",
  "claim_discards",
  "supplier_slashes",
  "daily_claims_by_application_service",
  "daily_claims_by_supplier",
  "daily_claims_by_supplier_application_service",
  "daily_income_by_address",
  "settlement_income_by_address",
  "settlement_supply_flows",
  "settlement_claims_by_application_service",
  "monthly_income_by_address_service",
  "monthly_income_by_address_supplier",
  "monthly_income_by_address_supplier_service",
  "daily_income_by_address_supplier",
  "daily_income_by_address_service",
  "daily_validator_rewards",
  "daily_delegator_rewards_by_validator",
  "hourly_income_by_address_supplier",
  "daily_claims_paid_by_address_service",
  "monthly_claims_by_supplier_service",
  "rollup_bounds_fill",
  // the Delegation entity (src/mappings/pocket/validator.ts)
  "delegations",
];

// SubQuery entities (and two raw tables) that no consumer queries through GraphQL: hidden to keep the API to what
// is used (.local/consumers/CONSUMERS-SUMMARY.md §2.2, a scan of 12 consumer repos, then their builds against this
// schema). Kept visible on purpose: MsgCreateClaim and MsgSubmitProof (pnf-explorer filters through them) and the
// entities pokt-data-agent's LLM registry names. SubQuery keeps its @foreignKey tags in these table comments, so @omit is
// added in front of the comment instead of replacing it.
export const UNUSED_ENTITY_TABLES = [
  "genesis_balances",
  "genesis_files",
  "supply_denoms",
  "module_accounts",
  "events",
  "messages",
  "authz_execs",
  "authz_msg_execs",
  "msg_create_validators",
  "validator_commissions",
  "validator_rewards",
  "msg_stake_application_services",
  "msg_unstake_applications",
  "msg_transfer_applications",
  "event_transfer_begins",
  "event_transfer_ends",
  "event_transfer_errors",
  "event_supplier_service_config_activateds",
  "msg_add_services",
  "msg_unstake_gateways",
  "event_gateway_unstakeds",
  "event_claim_updateds",
  "event_proof_updateds",
  "event_proof_validity_checkeds",
  "event_application_reimbursement_requests",
  "msg_import_morse_claimable_accounts",
  "msg_claim_morse_accounts",
  "msg_recover_morse_accounts",
  "msg_claim_morse_applications",
  "msg_claim_morse_application_services",
  "msg_claim_morse_suppliers",
  "msg_claim_morse_supplier_services",
  "staked_apps_by_block_and_services",
  "staked_suppliers_by_block_and_services",
];

const OMITTED_FUNCTIONS = [
  "_validate",
  "_ranges",
  "_bucket",
  "_bucket_end",
  "_buckets",
  "_span",
  "_block_heights",
  "_income",
  "_coverage",
  "_range_json",
  "_legacy_range",
  "_range_of",
  "_supply_flows",
  "_covered_buckets",
  "_first_bucket",
  "_require_current_rollups",
  "_json_strings",
  "_legacy_claims_by_service",
  "_legacy_series",
  "_operator_suppliers",
  "_supplier_ids",
  // writers of the money tables, which GraphQL would publish as mutations (scripts/fill_claims_paid.sql and
  // scripts/fill_monthly_claims.sql run them)
  "fill_claims_paid_day",
  "fill_monthly_claims_month",
  // the bounds fill's helpers (bounds.ts; its driver and throttle are procedures, which GraphQL does not publish)
  "_writer_lock",
  "_fill_rollup_bounds_unit",
  "_fill_rollup_bounds_by_key",
  "_replica_lag",
];

// The legacy_* functions (functions.ts): what each replaces, for its GraphQL description. GraphQL publishes them as
// legacyRewardsByAddressesAndTime, ...; a consumer switches by renaming the field it calls and reading .data of the
// {range, data} it returns (the two totals were a number, now under data).
const LEGACY_REPLACES: Record<string, string> = {
  legacy_rewards_by_addresses_and_time: "get_rewards_by_addresses_and_time (getRewardsByAddressesAndTime)",
  legacy_rewards_by_addresses_and_time_group_by_date:
    "get_rewards_by_addresses_and_time_group_by_date (getRewardsByAddressesAndTimeGroupByDate)",
  legacy_rewards_by_addresses_and_time_group_by_address_and_date:
    "get_rewards_by_addresses_and_time_group_by_address_and_date (getRewardsByAddressesAndTimeGroupByAddressAndDate)",
  legacy_rewards_of_addresses_by_suppliers_and_time:
    "get_rewards_of_addresses_by_suppliers_and_time (getRewardsOfAddressesBySuppliersAndTime)",
  legacy_rewards_by_suppliers_and_time_group_by_address_and_date:
    "get_rewards_by_suppliers_and_time_group_by_address_and_date (getRewardsBySuppliersAndTimeGroupByAddressAndDate)",
  legacy_rewards_by_suppliers_and_time_group_by_service:
    "get_rewards_by_suppliers_and_time_group_by_service (getRewardsBySuppliersAndTimeGroupByService)",
  legacy_rewards_by_addresses_and_time_group_by_service:
    "get_rewards_by_addresses_and_time_group_by_service (getRewardsByAddressesAndTimeGroupByService)",
  legacy_mint_breakdown_between_dates: "get_mint_breakdown_between_dates (getMintBreakdownBetweenDates)",
  legacy_burn_breakdown_between_dates: "get_burn_breakdown_between_dates (getBurnBreakdownBetweenDates)",
};
const LEGACY_SAME =
  "Same arguments, the same ranges and date_trunc units accepted (any length; an empty, inverted or half-NULL range answers as the live function, which matches nothing), read from the settlement money tables. Returns {range, data} where the live function returns its JSON (a number for the two totals): data has that JSON over the covered part of the range, and range = {requested_from, requested_to (end_date), covered_from, covered_to, gaps: [{from, to}]}. covered_from is the block at money_progress.from_height (where the money tables start: the first height the money step of the indexer processed, or lower where the history job has walked; the first indexed block for the functions over indexer tables), covered_to the block at money_progress.height (the last height the money step processed; it does not move while a POCKETDEX_MONEY_FROM_HEIGHT override skips heights) (inclusive, as end_date), both clipped to the range; the data is read only inside them, and a settlement gap (heights not written) reads nothing. 'Not covered' is told ONLY by covered_from / covered_to null: then data is null in every legacy_ function. data null alone means nothing for the series functions, which answer null (json_agg of nothing) also over a covered range with no rows, as the live functions do. The two totals give data as a JSON string ('201156529', as GraphQL gave the live numeric), '0' over a covered range with no income. A range the live function matches nothing for (a NULL bound, start after end) reports no coverage (covered null, gaps []) and the live function's empty answer. range.end_inclusive is true: requested_to and covered_to are inclusive like end_date; gaps are half-open. Differs only where said here.";
// What else differs from the live function's JSON.
const BY_SERVICE_ORDER = "Elements are ordered by service_id; the live function leaves their order to its plan.";
const LEGACY_DIFFERS: Record<string, string> = {
  legacy_rewards_by_suppliers_and_time_group_by_service: BY_SERVICE_ORDER,
  legacy_rewards_by_addresses_and_time_group_by_service: `${BY_SERVICE_ORDER} gross_rewards, relays, estimated_relays, computed_units and estimated_computed_units count each claim that paid the addresses once: the live function adds a claim once per transfer (relay and global mint, and each address of the list), 2x and more. service_id and net_rewards are the same.`,
  legacy_mint_breakdown_between_dates:
    "At beta heights 153513 to 153693, reimbursement and inflation include 128 upokt the chain minted (a 1 upokt escrow per claim) that the live function misses.",
};

// What each catalog function answers, for its GraphQL description (COMMENT ON FUNCTION) and its _json twin's.
const DESCRIPTIONS: Record<string, string> = {
  money_coverage:
    "Coverage: the settlement heights written in the range, the heights the chain settled there that are missing, and the recorded gaps.",
  get_application_spend:
    "Application spend: what applications paid (burned_upokt), overserviced work they did not pay, reimbursements, relays, compute units, claims and the first and last settlement height of those claims (NULL where not known yet); by_service, by_supplier, by_application.",
  get_gateway_spend:
    "Gateway spend: what the applications delegated to each gateway spent, by the delegation in force at each settlement height, with the first and last settlement height of those claims (NULL where not known yet); by_application, by_service, by_gateway.",
  get_supplier_earnings:
    "Supplier earnings: claimed and settled upokt, overservicing loss, relays, compute units, settled claims (with and without a proof) and the first and last settlement height of those claims (NULL where not known yet); suppliers NULL = every supplier, or owners = the suppliers they own now, or operators = the Staked suppliers whose service configs share revenue with them now; by_service, by_application, by_supplier.",
  get_supplier_distribution:
    "Supplier distribution: how what a supplier generated was paid out (each shareholder, the DAO, the service owner; stakers in one row); by_reason (in the family column: relay / global), by_supplier; owners or operators (the Staked suppliers whose service configs share revenue with them now) in place of suppliers.",
  get_income:
    "Income of any address (shareholder, DAO, service owner, application, validator, delegator) by role; by_reason (in the family column: relay / global), by_supplier (the supplier that generated it), by_service, by_address.",
  get_validator_rewards:
    "Validator rewards: commission (NULL when no distribution had one; with commission_unknown_count > 0 it is the sum of the known ones only, a partial sum), self-delegation, what went to delegators, the distributions and how many were replayed, and the delegated stake seen per validator (average, minimum, maximum; for an APR; NULL with by_validator false, which mixes validators); validators NULL = every validator; by_validator.",
  get_delegator_income:
    "Delegator income: what delegators received, and by_validator from which validator, with replayed_count = the contributions replayed from the delegations snapshot (288,180 to batched_vrd); delegators NULL = every delegator; validators keeps the income from those validators (their delegators); by_delegator.",
  get_supply_flows:
    "Network supply flows: burn, relay mint (mint_equals_burn), mint_ratio_unminted, overservicing loss, global mint and reimbursement, each by receiving role (by_role), plus slashes. Mainnet 690,685 to 716,533: one supplier paid a shareholder twice (poktroll v0.1.29 to v0.1.33), and the supplier role of mint_equals_burn and global_mint includes that overpayment (about 39 POKT), which came from the supplier module, not from the mint.",
  get_supplier_penalties:
    "Supplier penalties: expired claims by reason, discarded claims and slashes with their amount; suppliers NULL = every supplier; by_service, by_supplier; owners or operators (the Staked suppliers whose service configs share revenue with them now) in place of suppliers.",
  get_service_usage:
    "Service usage: claimed and settled upokt, relays, compute units and claims per service; services, or top_by_settled = N for the N services that settled the most (rank_by_settled); by_service.",
  get_app_auto_unstakes:
    "Applications the chain unstaked because their stake fell below the minimum; applications NULL = every application.",
  get_supplier_proofs:
    "Supplier proofs: claims settled with and without a proof, proofs submitted, validated and invalid (by reason), each counted in the block of its own event; suppliers NULL = every supplier; owners or operators (the Staked suppliers whose service configs share revenue with them now) in place of suppliers.",
  get_claims:
    "Claims one by one, newest first (by height, then event_idx): settled ones with their amounts, relays, compute units and whether a proof backed them, and expired ones with their expiration_reason (PROOF_MISSING, PROOF_INVALID; NULL amounts that only a settlement has). statuses = settled, expired (NULL = both). Filters, combined: suppliers (up to 200) or owners = the suppliers they own now or operators = the Staked suppliers whose service configs share revenue with them now (none = every supplier); applications and services (up to 200 each). row_limit (default 100, at most 1000) rows per call; for the next page pass the last row's height and event_idx as before_height and before_event_idx. supplier_owner_id is the owner the settlement recorded (NULL for expired claims and where the event did not carry it).",
  get_actor_lifecycle:
    "Stake history of suppliers, applications or gateways, one row per event, newest first (by height, then id): stake (stake_upokt, owner_id for suppliers) and unstake messages with their transaction_id, unbonding_begin and unbonding_end (reason, unbonding_end_height, session_end_height; reason as the actor entity's unstakingReason names it: VOLUNTARY, BELOW_MIN_STAKE, MIGRATION or UNSPECIFIED for suppliers, ELECTIVE, BELOW_MINIMUM_STAKE or MIGRATION for applications (UNRECOGNIZED on an unbonding_end whose reason the indexer did not recognize), NULL for gateways), and for suppliers each slash (service, application, session, penalty_upokt, previous_stake_upokt, stake_upokt after it, proof_validation_status). kind = supplier, application or gateway; addresses = those actors (up to 200), or for suppliers owners = the suppliers they own now or operators = the Staked suppliers whose service configs share revenue with them now; one list is required. events = stake, unstake, unbonding_begin, unbonding_end, slash (NULL = all). row_limit (default 100, at most 1000) rows per call; for the next page pass the last row's height and id as before_height and before_id. Covers the indexed blocks.",
  get_block_stats:
    "Block statistics per bucket: blocks and the first and last height, transactions (total, successful, failed), relays and compute units (claimed and estimated) as the indexer reports them per block, the time between blocks in milliseconds (average, minimum, maximum; a block whose previous one is not indexed is left out of the average and minimum) and the average block size in bytes. Covers the indexed blocks; NULL range = the whole chain.",
  get_relay_mining_difficulty:
    "Relay mining difficulty history of the services listed (up to 200): each update newest first (by height, then service_id), with the relays EMA and the target hash before and after it. The current difficulty of a service is its newest row (row_limit 1 with that one service). row_limit (default 100, at most 1000) rows per call; for the next page pass the last row's height and service_id as before_height and before_service_id. Covers the indexed blocks.",
  get_created_claims:
    "Claims created (MsgCreateClaim) by up to 20 suppliers, newest first (by height, then id), whether or not they settled yet: application, service, session_id, session_end_height, relays, compute units and claimed_upokt as claimed, and the transaction_id. For settled and expired claims use get_claims. row_limit (default 100, at most 1000) rows per call; for the next page pass the last row's height and id as before_height and before_id. Covers the indexed blocks.",
  get_param_history:
    "Governance parameter history: each version whose value differs from the previous one, with previous_value; namespaces / keys NULL = all.",
};

const COMMON = `'Arguments: range_start, range_end = the range [start, end), timestamptz with an explicit zone (2026-10-01T00:00:00Z); NULL = the whole history. bucket = NULL (one total per row) or hour (up to 7 days), day (up to 92 days), week (up to 366 days), month or year, in UTC. by_* = split by that column (otherwise it says all); the by_<entity> of the ids asked about is true by default (false = one total for the list). fill_empty_buckets (default false) = only rows with data: an absent bucket, series or id is 0; true = every bucket of every series and every requested id, 0 where nothing happened, which adds considerable latency on large answers. NULL in a column = it does not apply to that row.'`;
const ROWS_NOTE = `'Rows newest first (then by the text columns), paged by GraphQL (first / offset) up to the query limit (1000); for larger answers use the _json variant. Each row carries covered_from, covered_to and covered_gaps: the part of the range the answer covers and the settlement gaps inside, as the range of the _json variant. An answer with no rows carries none of it: to tell a range that is not covered from one where nothing happened, call the _json variant.'`;
const JSON_NOTE = `'Returns {range, data}. data = every row of the function of the same name as one JSON array (without covered_from / covered_to / covered_gaps), in its row order, in one call with no row limit: for answers above 1000 rows. Keys are the snake_case column names; numbers (amounts, counts) are JSON strings, as in the list variant, so no client loses precision. range = {requested_from, requested_to, covered_from, covered_to, gaps: [{from, to}], end_inclusive: false}: covered_from is the block at money_progress.from_height (where the money tables start: the first height the money step of the indexer processed, or lower where the history job has walked; the first indexed block for the functions over indexer tables), covered_to the block at money_progress.height (the last height the money step processed; it does not move while a POCKETDEX_MONEY_FROM_HEIGHT override skips heights) + 1 µs, both clipped to the range, so [covered_from, covered_to) is half-open like the range (end_inclusive false); gaps the settlement heights not written (settlement_gaps) that overlap the range, as the half-open time between the covered heights around them: they read as nothing, and with fill_empty_buckets only buckets that intersect what is covered get a zero row. covered_from and covered_to are null when nothing in the range is covered, and data is then []. The data is read only inside [covered_from, covered_to).'`;

// The catalog functions that list rows one by one (the ones with a before_height input argument; proargnames also holds
// the output columns, hence [1:pronargs]): newest first by height, at most row_limit a call, paged by a keyset.
const KEYSET_NOTE = `'Rows newest first by height, then by event_idx, id or service_id (the key named in before_*), at most row_limit (default 100, up to 1000) per call: page with the keys of the last row in before_*, not with first / offset. Each row carries covered_from, covered_to and covered_gaps: the part of the range the answer covers and the settlement gaps inside, as the range of the _json variant. An answer with no rows carries none of it: to tell a range that is not covered from one where nothing happened, call the _json variant.'`;
const KEYSET_JSON_NOTE = `'Returns {range, data}: data = the rows of the function of the same name (at most row_limit; page with before_*) as one JSON array without covered_from / covered_to / covered_gaps, numbers as JSON strings; range = {requested_from, requested_to, covered_from, covered_to, gaps: [{from, to}], end_inclusive: false}, the part of the range the data covers.'`;

const LAST_SETTLEMENT = `'The last settlement the money tables hold: the highest height they wrote (a height with settlement events, which may have no settled claim) up to what the indexer has processed, and its block time; null before the first one. Poll it (two small reads) and refetch recent catalog data whenever it changes. It moves forward when a new settlement is written. A history fill or gap repair below it does not move it, nor does covered_to, which follows the blocks. After the indexer rewinds (rare) it goes back, then forward again as those heights are rewritten.'`;

// The published functions over the current state of the entity tables, and get_supplier_domains (whose rows are the
// domain rewards' own days, outside the money coverage): a plain list each, with no _json twin. Their GraphQL
// description: what + STATE_ROWS_NOTE + the columns.
const STATE_DESCRIPTIONS: Record<string, string> = {
  get_supplier_fleet:
    "Supplier fleet now: the current version of the suppliers of one list (suppliers, up to 200; owners = the suppliers they own now; operators = the Staked suppliers whose service configs share revenue with them now; domains (up to 200) = the suppliers with a live service config with an endpoint on one of them), or of every supplier when none is given. services keeps those with a live config for one of them (combined with the list). stake_statuses keeps those statuses (Staked, Unstaking, Unstaked; NULL = all). by_supplier (default true) = one row per supplier: owner_id, stake_status, stake_upokt and service_count (the services it has a live config for), largest stake first; false = one row for the whole fleet (supplier_id and stake_status say all; owner_id and service_count are NULL): stake_upokt summed and supplier_count, zeros when the fleet is empty.",
  get_service_summary:
    "Services now: per service, the suppliers with a live service config for it and how many of them are Staked, and the applications with a live service row for it and how many are Staked. services = those (up to 200); NULL = every service with a supplier config or an application.",
  get_application_fleet:
    "Applications now: the current version of the applications listed (up to 200), kept to those with a live service row for one of services and to those delegating to one of gateways now (all combined; none = every application), and to stake_statuses (Staked, Unstaking, Unstaked; NULL = all). by_application (default true) = one row per application: stake_status, stake_upokt, service_count and gateway_count (its services and gateways now), largest stake first; false = one row for all (application_id and stake_status say all; the counts are NULL): stake_upokt summed and application_count.",
  get_supplier_domains:
    "Supplier domains (the root domains of the endpoints suppliers stake with) ranked by what their suppliers claimed: claimed_upokt, relays and compute units summed over the UTC days that start inside [range_start, range_end) (NULL = every day; first_day and last_day = the days found), with staked_suppliers = the Staked suppliers that have a live service config on the domain now and staked_upokt = their stake. top = the first N domains (NULL = all).",
  get_morse_claim_summary:
    "Morse migration now: the Morse accounts imported for claiming on Shannon, one row for the claimed ones and one for the unclaimed: accounts, and the sums of their liquid balance (unstaked_balance_upokt) and of the supplier and application stakes they carry. The accounts one by one: morseClaimableAccounts.",
};
export const STATE_FUNCTIONS = Object.keys(STATE_DESCRIPTIONS);
const STATE_ROWS_NOTE = `'Rows paged by GraphQL (first / offset) up to the query limit (1000); page in this order for longer answers. Amounts in upokt.'`;

export function createSettlementSmartTagsFn(dbSchema: string): string {
  const s = dbSchema;
  // a missing table fails the start: a typo or a renamed table must not stay exposed in GraphQL
  const tables = OMITTED_TABLES.map((t) => `COMMENT ON TABLE ${s}.${t} IS E'@omit';`).join("\n");
  const functions = OMITTED_FUNCTIONS.map((f) => `'${f}'`).join(", ");
  const describe = Object.entries(DESCRIPTIONS)
    .map(([name, what]) => `('${name}', '${what.replace(/'/g, "''")}')`)
    .join(", ");
  const state = Object.entries(STATE_DESCRIPTIONS)
    .map(([name, what]) => `('${name}', '${what.replace(/'/g, "''")}')`)
    .join(", ");
  const unused = UNUSED_ENTITY_TABLES.map((t) => `'${t}'`).join(", ");
  const legacy = Object.entries(LEGACY_REPLACES)
    .map(([name, live]) => [name, `Replaces ${live}. ${LEGACY_SAME} ${LEGACY_DIFFERS[name] ?? ""}`.trim()])
    .map(([name, what]) => `('${name}', '${what.replace(/'/g, "''")}')`)
    .join(", ");
  return `
${tables}
COMMENT ON VIEW ${s}.v_income_base IS E'@omit';
COMMENT ON VIEW ${s}.v_claims_paid IS E'@omit';
DO $$
DECLARE t regclass; c text;
BEGIN
  FOR t, c IN SELECT k.oid::regclass, obj_description(k.oid, 'pg_class') FROM pg_class k
              WHERE k.relnamespace = '${s}'::regnamespace AND k.relname IN (${unused}) LOOP
    IF c IS NULL OR c !~ '(^|\n)@omit(\n|$)' THEN
      EXECUTE format('COMMENT ON TABLE %s IS %L', t, '@omit' || coalesce(E'\n' || nullif(c, ''), ''));
    END IF;
  END LOOP;
END $$;
-- every overload of each helper, whatever its signature
DO $$
DECLARE f regprocedure; what text; ks boolean;
BEGIN
  FOR f IN SELECT p.oid::regprocedure FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = '${s}' AND p.prokind = 'f' AND p.proname IN (${functions}) LOOP
    EXECUTE format('COMMENT ON FUNCTION %s IS %L', f, '@omit');
  END LOOP;
  FOR f, what, ks IN SELECT p.oid::regprocedure, d.what, 'before_height' = ANY(coalesce(p.proargnames[1:p.pronargs], '{}')) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           JOIN (VALUES ${describe}) d(name, what) ON d.name = p.proname
           WHERE n.nspname = '${s}' AND p.prokind = 'f' AND p.proretset LOOP
    EXECUTE format('COMMENT ON FUNCTION %s IS %L', f, '@simpleCollections only' || E'\n' || what || ' '
      || CASE WHEN ks THEN ${KEYSET_NOTE} ELSE ${ROWS_NOTE} END
      || E'\n' || ${COMMON} || E'\nColumns: ' || pg_get_function_result(f));
  END LOOP;
  FOR f, what, ks IN SELECT p.oid::regprocedure, d.what, 'before_height' = ANY(coalesce(p.proargnames[1:p.pronargs], '{}')) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           JOIN (VALUES ${describe}) d(name, what) ON d.name || '_json' = p.proname
           WHERE n.nspname = '${s}' AND p.prokind = 'f' LOOP
    EXECUTE format('COMMENT ON FUNCTION %s IS %L', f, what || ' '
      || CASE WHEN ks THEN ${KEYSET_JSON_NOTE} ELSE ${JSON_NOTE} END || E'\n' || ${COMMON}
      || E'\nEach element has the columns of ' || replace(f::text, '_json(', '(') || '.');
  END LOOP;
  FOR f, what IN SELECT p.oid::regprocedure, d.what FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           JOIN (VALUES ${state}) d(name, what) ON d.name = p.proname
           WHERE n.nspname = '${s}' AND p.prokind = 'f' AND p.proretset LOOP
    EXECUTE format('COMMENT ON FUNCTION %s IS %L', f, '@simpleCollections only' || E'\n' || what || ' ' || ${STATE_ROWS_NOTE}
      || E'\nColumns: ' || pg_get_function_result(f));
  END LOOP;
  FOR f, what IN SELECT p.oid::regprocedure, d.what FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           JOIN (VALUES ${legacy}) d(name, what) ON d.name = p.proname
           WHERE n.nspname = '${s}' AND p.prokind = 'f' LOOP
    EXECUTE format('COMMENT ON FUNCTION %s IS %L', f, what);
  END LOOP;
END $$;
COMMENT ON FUNCTION ${s}.get_last_settlement() IS ${LAST_SETTLEMENT};
`;
}
