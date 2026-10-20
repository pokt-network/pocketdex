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
  "_operator_suppliers_ever",
  "_block_height_of",
  "_supplier_ids",
  // the transaction counts' helper and writers (txCounts.ts)
  "_tx_counts_of_blocks",
  "rebuild_tx_counts_daily",
  "refresh_tx_counts_daily",
  // the staked suppliers' and the supply's daily rollups: helpers and writers (stakedSuppliersDaily.ts, supplyDaily.ts)
  "_staked_suppliers_of_blocks",
  "rebuild_staked_suppliers_daily",
  "refresh_staked_suppliers_daily",
  "_supply_at",
  "_supply_height",
  "_supply_points",
  "_supply_gaps",
  "rebuild_supply_daily",
  "refresh_supply_daily",
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
export const LEGACY_REPLACES: Record<string, string> = {
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
    "Supplier earnings: claimed and settled upokt, overservicing loss, relays, compute units, settled claims (with and without a proof) and the first and last settlement height of those claims (NULL where not known yet); suppliers NULL = every supplier, or owners = the suppliers they own now, or operators = the Staked suppliers whose service configs share revenue with them now; services (up to 200) keeps the claims of those services; by_service, by_application, by_supplier. With by_application, gateway_ids = the application's gateways now (NULL without by_application).",
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
    "Supplier penalties: expired claims by reason, discarded claims and slashes with their amount; suppliers NULL = every supplier; by_service, by_supplier; owners or operators (the Staked suppliers whose service configs share revenue with them now; operator_scope ever = every supplier any of whose service configs shared revenue with them at any time, in any stake status; ever reads an index of the rev_share wallets once it covers every height (indexed from genesis, or backfilled): ~25 ms for 7 wallets shared by 4,092 suppliers on mainnet; before that it takes seconds for a large operator) in place of suppliers.",
  get_service_usage:
    "Service usage: claimed and settled upokt, relays, compute units and claims per service; services, or top_by_settled = N for the N services that settled the most (rank_by_settled); by_service. row_offset (with top_by_settled or row_limit, at most 10,000,000) skips that many services of the ranking first, so top_by_settled is a page of it; total_services = the services ranked (those with a settled claim in the range), on every row of a ranked call. Neither services nor top_by_settled with by_service false = the network total, every service summed. row_limit (at most 200, 20 with a bucket) in place of top_by_settled: a page of the services in order_by (estimated_compute_units (default), estimated_relays, relays, compute_units, settled_upokt, claimed_upokt, service_id, name, staked_suppliers or change) and order_dir (asc or desc (default); NULLs last, ties by service_id), kept to those whose id or name contains search_text (case-insensitive; total_services counts them). compare_start (needs range_start; no bucket) and compare_end (default range_start, never after it) add previous_estimated_compute_units (0 when none) and change = (estimated_compute_units - previous) / previous, 1 when previous is 0; both NULL when the money tables do not cover all of that window. with_details fills name, staked_suppliers and staked_applications (the Staked suppliers and applications configured for the service now; the 'all' row sums them over its services, the network total over the services with usage in the range, so an actor counts once per service); NULL without it (100-400 ms more on mainnet).",
  get_app_auto_unstakes:
    "Applications the chain unstaked because their stake fell below the minimum; applications NULL = every application.",
  get_supplier_proofs:
    "Supplier proofs: claims settled with and without a proof, proofs submitted, validated and invalid (by reason), each counted in the block of its own event; suppliers NULL = every supplier; owners or operators (the Staked suppliers whose service configs share revenue with them now) in place of suppliers.",
  get_claims:
    "Claims one by one, newest first (by height, then event_idx): settled ones with their amounts, relays, compute units and whether a proof backed them, and expired ones with their expiration_reason (PROOF_MISSING, PROOF_INVALID; NULL amounts that only a settlement has). statuses = settled, expired (NULL = both). Filters, combined: suppliers (up to 200) or owners = the suppliers they own now or operators = the Staked suppliers whose service configs share revenue with them now (operator_scope ever = every supplier any of whose service configs shared revenue with them at any time, in any stake status, with all its claims; ever reads an index of the rev_share wallets once it covers every height (indexed from genesis, or backfilled): ~25 ms for 7 wallets shared by 4,092 suppliers on mainnet; before that it takes seconds for a large operator) (none = every supplier); applications and services (up to 200 each). row_limit (default 100, at most 1000) rows per call; for the next page pass the last row's height and event_idx as before_height and before_event_idx. supplier_owner_id is the owner the settlement recorded (NULL for expired claims and where the event did not carry it). current_owner_id is the supplier's owner now (NULL when the supplier is not indexed).",
  get_actor_lifecycle:
    "Stake history of suppliers, applications or gateways, one row per event, newest first (by height, then id): stake (stake_upokt, owner_id for suppliers) and unstake messages with their transaction_id, unbonding_begin and unbonding_end (reason, unbonding_end_height, session_end_height; reason as the actor entity's unstakingReason names it: VOLUNTARY, BELOW_MIN_STAKE, MIGRATION or UNSPECIFIED for suppliers, ELECTIVE, BELOW_MINIMUM_STAKE or MIGRATION for applications (UNRECOGNIZED on an unbonding_end whose reason the indexer did not recognize), NULL for gateways), and for suppliers each slash (service, application, session, penalty_upokt, previous_stake_upokt, stake_upokt after it, proof_validation_status). For applications and gateways also delegate and undelegate (the delegations of one to the other: application_id and gateway_id). kind = supplier, application or gateway; addresses = those actors (up to 200), or for suppliers owners = the suppliers they own now or operators = the Staked suppliers whose service configs share revenue with them now (operator_scope ever = every supplier any of whose service configs shared revenue with them at any time, in any stake status, with all its events; ever reads an index of the rev_share wallets once it covers every height (indexed from genesis, or backfilled): ~25 ms for 7 wallets shared by 4,092 suppliers on mainnet; before that it takes seconds for a large operator); one list is required. events (NULL = all) = stake, unstake, unbonding_begin, unbonding_end and slash for suppliers; stake, unstake, unbonding_begin, unbonding_end, delegate and undelegate for applications and gateways. row_limit (default 100, at most 1000) rows per call; for the next page pass the last row's height and id as before_height and before_id. Covers the indexed blocks.",
  get_block_stats:
    "Block statistics per bucket: blocks and the first and last height, transactions (total, successful, failed), relays and compute units (claimed and estimated) as the indexer reports them per block, the time between blocks in milliseconds (average, minimum, maximum; a block whose previous one is not indexed is left out of the average and minimum) and the average block size in bytes. Covers the indexed blocks; NULL range = the whole chain.",
  get_tx_counts:
    "Transactions per message type and status over a range, from a daily rollup, without counting the transactions table: msg_type is a message type URL (a transaction counts once under each type it holds, so the types do not add up to '*') or '*' for every transaction; status is success (code 0) or failed. msg_types (up to 200, '*' included) and statuses (success, failed) filter; NULL = every row. The full UTC days come from the rollup, the partial days at the ends of the range from their blocks. first_height and last_height are the blocks the counts span. A full day with blocks the rollup does not hold yet is a gap (covered_gaps), not a zero; when nothing in the range is held, one row of NULLs carries the gaps (the _json twin leaves it out of data and puts the gaps in range). Covers the indexed blocks.",
  get_staked_suppliers_by_service:
    "Staked suppliers per service over a range, from a daily rollup: blocks = the blocks with staked suppliers of the service, suppliers_staked = the staked suppliers summed over those blocks (divide by blocks for the average per block), as getAmountOfBlocksAndSuppliersByTimes gives them. services (up to 200) filters; NULL = every service. The full UTC days come from the rollup, the partial days at the ends of the range from their blocks. first_height and last_height are the blocks the sums span. A full day with blocks the rollup does not hold yet is a gap (covered_gaps), not a zero; when nothing in the range is held, one row of NULLs carries the gaps (the _json twin leaves it out of data and puts the gaps in range). Covers the indexed blocks.",
  get_supply:
    "Supply per bucket at its point, the bucket's last block with an upokt supply inside the range (height, block_time): network_supply_upokt = the upokt supply recorded at that block, unmigrated_upokt = the Morse balances not claimed at that block (unstaked balance, supplier and application stake), total_supply_upokt = their sum; as getSupplyCompositionBetweenDates gives them. bucket = day (default), week, month or year (not NULL nor hour). Full UTC days come from a daily rollup, the partial days at the ends of the range are computed live. A full day the rollup does not hold yet is a gap (covered_gaps): its bucket has no row, never an earlier point; when no bucket has a row, one row of NULLs carries the gaps (the _json twin leaves it out of data). Covers the indexed blocks.",
  get_supply_composition:
    "Supply composition per bucket at the point get_supply reads (height, block_time): one row per label, the upokt balances at that block by module account name, dao (the tokenomics dao_reward_address at that block), wrapped (the bridge address) or others; as network_supply_composition of getSupplyCompositionBetweenDates. bucket = day (default), week, month or year. Full UTC days from a daily rollup, the partial days at the ends live; a full day the rollup does not hold yet is a gap (covered_gaps), as in get_supply. Covers the indexed blocks.",
  get_relay_mining_difficulty:
    "Relay mining difficulty history of the services listed (up to 200): each update newest first (by height, then service_id), with the relays EMA and the target hash before and after it. The current difficulty of a service is its newest row (row_limit 1 with that one service). row_limit (default 100, at most 1000) rows per call; for the next page pass the last row's height and service_id as before_height and before_service_id, or skip row_offset rows of the order (default 0, at most 10,000,000) for a page at any depth in one call. Covers the indexed blocks.",
  get_morse_claims:
    "Morse claims one by one, newest first (by height, then id): kind = account (a Morse account's balance claimed to a Shannon address), application or supplier (a Morse actor's stake and balance claimed as a Shannon one; for a supplier shannon_dest_address is where the chain records the claim (the claimed account's destination: the supplier address before poktroll v0.1.20, then the address the stake was minted to), with its operator, morse_node_address, claim_signer_type and the service_ids it claimed; for an application the service_ids), recover (a balance the authority recovered to shannon_dest_address; is_admin). Filters, combined: morse_addresses (up to 200, hex in any case), shannon_addresses (up to 200: the destination; for a supplier its owner or operator), kinds (NULL = all). row_limit (default 100, at most 1000) rows per call; for the next page pass the last row's height and id as before_height and before_id. Covers the indexed blocks. The accounts that can be claimed: the morseClaimableAccounts list; their totals: get_morse_claim_summary.",
  get_created_claims:
    "Claims created (MsgCreateClaim) by up to 20 suppliers, newest first (by height, then id), whether or not they settled yet: application, service, session_id, session_end_height, relays, compute units and claimed_upokt as claimed, and the transaction_id. from_session_end_height keeps the claims of sessions that end at or after that height (NULL = all). For settled and expired claims use get_claims. row_limit (default 100, at most 1000) rows per call; for the next page pass the last row's height and id as before_height and before_id. Covers the indexed blocks.",
  get_native_transfers:
    "Native transfers (MsgSend) of the addresses listed (up to 200), newest first (by height, then id): the sender, recipient, denom and amounts ([{denom, amount}], amounts as strings), the transfer's status, its block_time, and its transaction's transaction_id, tx_code (0 = success), tx_codespace, tx_fees ([{denom, amount}]), tx_signer_address and tx_memo. direction = sent (the sender is one of addresses), received (the recipient is) or NULL for both; a transfer between two of them comes once. row_limit (default 100, at most 1000) rows per call; for the next page pass the last row's height and id as before_height and before_id. Covers the indexed blocks.",
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

const HEIGHT_AT = `'The last indexed block at or before at_time (a timestamptz with an explicit zone, 2026-10-01T00:00:00Z): its height and block_time; null when no indexed block is that early. beyond_tip is true when at_time is after the newest indexed block: the answer is that block, and a later one may still come at or before at_time. A time inside a stretch with no indexed block answers the last block before it. For the height to ask about a time: the chain at that height, or the functions that take a height.'`;

// The published functions over the current state of the entity tables, and get_supplier_domains (whose rows are the
// domain rewards' own days, outside the money coverage): a plain list each, with no _json twin. Their GraphQL
// description: what + STATE_ROWS_NOTE + the columns.
const STATE_DESCRIPTIONS: Record<string, string> = {
  get_supplier_fleet:
    "Supplier fleet now: the current version of the suppliers of one list (suppliers, up to 200; owners = the suppliers they own now; operators = the Staked suppliers whose service configs share revenue with them now (operator_scope ever = every supplier any of whose service configs shared revenue with them at any time, in any stake status: filter with stake_statuses; ever requires operators; ever reads an index of the rev_share wallets once it covers every height (indexed from genesis, or backfilled): ~25 ms for 7 wallets shared by 4,092 suppliers on mainnet; before that it takes seconds for a large operator); domains (up to 200) = the suppliers with a live service config with an endpoint on one of them; '' = a live config with no domain, the '' row of get_staked_domain_services), or of every supplier when none is given. services keeps those with a live config for one of them (combined with the list; with domains, one live config must have both the service and an endpoint on the domain). stake_statuses keeps those statuses (Staked, Unstaking, Unstaked; NULL = all). by_supplier (default true) = one row per supplier: owner_id, stake_status, stake_upokt and service_count (the services it has a live config for), largest stake first; false = one row for the whole fleet (supplier_id and stake_status say all; owner_id and service_count are NULL): stake_upokt summed and supplier_count, zeros when the fleet is empty. max_stake_upokt keeps the stakes below it. With services, service_domains = the endpoint root domains of each supplier's live configs for those services (NULL without services). row_limit (up to 1000; NULL = every row) returns one page in this order: for the next, pass the last row's stake_upokt and supplier_id as after_stake_upokt and after_supplier_id; it counts services for that page only, much faster than every row. row_offset (default 0) skips that many rows of the order first, for a page at any depth.",
  get_service_summary:
    "Services now: per service, the suppliers with a live service config for it and how many of them are Staked, and the applications with a live service row for it and how many are Staked; and its relay mining difficulty now, from its newest difficulty update: num_relays_ema, target_hash_hex and difficulty_updated_height (NULL when it never had one; get_relay_mining_difficulty lists the updates). services = those (up to 200); NULL = every service. owners (up to 200) keeps the services those addresses own now. Every service has its row, zeros when it has no supplier config or application now.",
  get_application_fleet:
    "Applications now: the current version of the applications listed (up to 200), kept to those with a live service row for one of services and to those delegating to one of gateways now (all combined; none = every application), and to stake_statuses (Staked, Unstaking, Unstaked; NULL = all). by_application (default true) = one row per application: stake_status, stake_upokt, service_count and gateway_count (its services and gateways now), largest stake first; false = one row for all (application_id and stake_status say all; the counts are NULL): stake_upokt summed and application_count. row_limit (up to 1000; NULL = every row) and row_offset (default 0) return one page of the order, counting services and gateways for its rows only.",
  get_gateway_fleet:
    "Gateways now: the current version of the gateways listed (up to 200; NULL = every gateway), kept to stake_statuses (Staked, Unstaking, Unstaked; NULL = all). by_gateway (default true) = one row per gateway: stake_status, stake_upokt, delegated_applications (the applications delegating to it now, whatever their status), delegations_ever and undelegations_ever (the delegate and undelegate messages it received; a re-delegation counts again, and a delegation from the genesis state, which has no message, does not count), largest stake first; false = one row for all (gateway_id and stake_status say all): stake_upokt and the counts summed, and gateway_count.",
  get_gateway_delegations:
    "Gateways and the applications delegating to them at a height (at_height NULL = the last height the indexer processed; every row carries the height read in height, to pass as at_height on the next pages): for the gateways listed (up to 200), each gateway's stake (gateway_stake_upokt, gateway_stake_status) and each delegated application's stake_upokt, stake_status and service_ids, all as of that height. One row per (gateway, application); a gateway with no delegation at the height has one row with NULL application columns, and a gateway not staked yet at the height none. Ordered by gateway_id, then application_id; for the next page pass the last row's gateway_id and application_id as after_gateway_id and after_application_id (application_id NULL: after_gateway_id alone).",
  get_supplier_domains:
    "Supplier domains (the root domains of the endpoints suppliers stake with) ranked by what their suppliers claimed: claimed_upokt, relays and compute units summed over the UTC days that start inside [range_start, range_end) (NULL = every day; first_day and last_day = the days found), with staked_suppliers = the Staked suppliers that have a live service config on the domain now and staked_upokt = their stake. top = the first N domains (NULL = all).",
  get_created_claims_count:
    "Created claims (MsgCreateClaim) counted per supplier, for up to 20 suppliers, in [range_start, range_end) (timestamptz with an explicit zone; NULL = the whole history): one row per requested supplier with claims (0 when it made none) and the first and last height counted; from_session_end_height counts only the claims of sessions that end at or after that height, as get_created_claims lists them. Covers the indexed blocks: beyond_tip is true when the indexer has no block at or after range_end yet (range_end NULL: range_start), so the count may still grow and a 0 is not final. To list the claims themselves use get_created_claims.",
  get_staked_supplier_services:
    "Live service configs of the Staked suppliers now, one row per (supplier, service): the supplier's owner_id and stake_upokt, the service, the endpoint root domains of that config, and activated_at_height (the height from which the chain serves the config; a config waiting for its session start has a height above the current block). services keeps those services (up to 200; NULL = all). Ordered by supplier_id, then service_id; for the next page pass the last row's supplier_id and service_id as after_supplier_id and after_service_id.",
  get_staked_domain_services:
    "Live service configs of the Staked suppliers now, counted per (endpoint root domain, service): configs = the configs whose endpoints are on the domain (each config once, as get_staked_supplier_services gives its domains; a config with no domain is counted under domain '' (an empty string), so configs summed over the rows is never below total_configs). total_configs and total_suppliers repeat on every row of the first page (NULL on the next ones): every live config of the Staked suppliers and their distinct suppliers, to check a read is complete. Ordered by domain, then service_id; for the next page pass the last row's domain and service_id as after_domain and after_service_id.",
  get_staked_suppliers:
    "The Staked suppliers (stake_statuses: those statuses, default Staked) at a height (at_height NULL = the last height the indexer processed; every row carries the height read in height: pass it as at_height on the next pages so the whole walk reads one state), one row each: owner_id, operator_id, stake_upokt, and the service_ids and endpoint root domains of their service configs at that height (empty arrays when they have none; a supplier not Staked with no config at the height gets the configs closed at its last closing, which can take seconds a page; a Staked one with none gets empty arrays). Ordered by supplier_id; for the next page pass the last row's supplier_id as after_supplier_id. For a fleet by stake, with filters, use get_supplier_fleet.",
  get_supplier_config_history:
    "Service configs of one supplier over time (supplier_id; services keeps those, up to 200), one row per stretch of heights in which a config declared the same content: a row starts at the config's first height, after a gap (the supplier unstaked, or dropped the service and took it back) and when its rev_share or endpoints change; restakes and activations that change nothing add no row. first_height and last_height bound the stretch (last_height NULL while the supplier declares it now). rev_share is sorted by address (the chain stores it in the order of the stake message, which changes with no change of content); domains are the endpoint root domains. Configs are what the supplier declared, from its stake height; the chain activates them at the next session start. Ordered by service_id, then first_height; for the next page pass the last row's as after_service_id and after_first_height. Stake, unstake and unbonding events: get_actor_lifecycle.",
  get_block_supplies:
    "Supply at a block, given by height or by hash (exactly one; the hash in any case): one row per denomination with its amount in that denomination's own base unit (upokt for upokt, mact for mact; not converted), as the indexer recorded it for that block; no row for a block it has no supply for.",
  get_block_metadata:
    "A block's metadata record, given by height or by hash (exactly one; the hash in any case): block_height, and the CometBFT block_id, header and last_commit as JSON, as the indexer received them; no row for a block it has no record for.",
  get_active_accounts:
    "Accounts active since each time of since_times (up to 20, timestamptz with an explicit zone): accounts = the live upokt balances last updated in a block at or after the time (null when beyond_tip: no indexed block that late yet); height = the newest block before the time (an account counts when its last update is above it).",
  get_supply_composition_at:
    "Supply at one block, computed live: the last block at or below at_height (NULL = the latest) with an upokt supply, whose height and block_time every row carries; network_supply_upokt, unmigrated_upokt (the Morse balances not claimed at that block) and total_supply_upokt as get_supply gives them, repeated on each row; and one row per composition label (module account name, dao, wrapped, others) with its amount_upokt, as get_supply_composition.",
  get_morse_claim_summary:
    "Morse migration now: the Morse accounts imported for claiming on Shannon, one row for the claimed ones and one for the unclaimed: accounts, and the sums of their liquid balance (unstaked_balance_upokt) and of the supplier and application stakes they carry. The accounts one by one: morseClaimableAccounts.",
};
export const STATE_FUNCTIONS = Object.keys(STATE_DESCRIPTIONS);
const STATE_ROWS_NOTE = `'Rows paged by GraphQL (first / offset) up to the query limit (1000); page in this order for longer answers. Amounts in upokt.'`;
// get_block_supplies gives each denomination's amount in its own base unit: the rows note without the unit
const STATE_UNIT_FREE = ["get_block_supplies", "get_block_metadata"];
const STATE_ROWS_NOTE_NO_UNIT = `'Rows paged by GraphQL (first / offset) up to the query limit (1000); page in this order for longer answers.'`;
// the state functions that page by keyset only (an input argument named after_*, and row_limit 1000 by default;
// get_supplier_fleet, whose row_limit defaults to every row, says how it pages in its own description)
const STATE_KEYSET_NOTE = `'At most row_limit rows (default 1000, up to 1000) per call, in the order of the after_* keys: for the next page pass the last row''s keys as after_*, until a page comes back short; not first / offset. Amounts in upokt.'`;

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
    EXECUTE format('COMMENT ON FUNCTION %s IS %L', f, '@simpleCollections only' || E'\n' || what || ' '
      || CASE WHEN EXISTS (SELECT 1 FROM pg_proc p2, unnest(p2.proargnames[1:p2.pronargs]) a
                           WHERE p2.oid = f AND a LIKE 'after\\_%')
                     AND pg_get_function_arguments(f) LIKE '%row_limit integer DEFAULT 1000%' THEN ${STATE_KEYSET_NOTE}
                WHEN (SELECT p3.proname FROM pg_proc p3 WHERE p3.oid = f) = ANY(ARRAY[${STATE_UNIT_FREE.map((n) => `'${n}'`).join(", ")}]) THEN ${STATE_ROWS_NOTE_NO_UNIT}
                ELSE ${STATE_ROWS_NOTE} END
      || E'\nColumns: ' || pg_get_function_result(f));
  END LOOP;
  FOR f, what IN SELECT p.oid::regprocedure, d.what FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
           JOIN (VALUES ${legacy}) d(name, what) ON d.name = p.proname
           WHERE n.nspname = '${s}' AND p.prokind = 'f' LOOP
    EXECUTE format('COMMENT ON FUNCTION %s IS %L', f, what);
  END LOOP;
END $$;
COMMENT ON FUNCTION ${s}.get_last_settlement() IS ${LAST_SETTLEMENT};
COMMENT ON FUNCTION ${s}.get_height_at(timestamptz) IS ${HEIGHT_AT};
`;
}
