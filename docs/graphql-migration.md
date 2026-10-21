# data.pocket.network GraphQL API: before and after the schema closure

This document lists every change to the pocketdex GraphQL API (https://data.pocket.network/graphql and
https://data.beta.pocket.network/graphql) between:

- **Before**: the API as it was on 2026-10-02, before the function catalog was added: pocketdex 4227989, rebuilt
  from that release's code over a copy of the production schema.
- **After**: the API at the end of Monday 2026-10-19 (UTC), once the schema is closed. Beta changes first, then mainnet.

Part of the change is already live: the catalog and `legacy*` functions, the 1000-row lists, and 34 lists hidden on
2026-10-04. The rest happens on 2026-10-19. Each section says which part is which.

A client that still asks for something removed gets `Cannot query field "<name>" on type "<type>"` and no data.

## Summary

- **Limits.** A list returns up to 1000 rows instead of 100 (live since 2026-10-04). From 2026-10-19, a query has 10
  seconds instead of 30, may select at most 150 fields and use at most 20 aliases, and its fields can nest at most 5
  levels.
- **New**: 52 catalog functions (83 fields, counting `get...List` and `get...Json`) for everything that used to be
  summed or filtered through events and relations, and for what the old functions answered; 13 of them come with a
  later release (see "Timeline"). There are also 9 `legacy*` functions that return what the old
  reward functions returned, a `blockTime` / `lastUpdatedTime` column on `transactions`, `nativeTransfers` and
  `balances`, and `validators.delegatorShares`. All are live now, except `getTxCountsList` / `getTxCountsJson`, which
  arrive on 2026-10-19.
- **Unchanged**: the 19 basic entities, as lists and lookups by key with their own columns, filters, `orderBy`,
  `first` / `offset`, `totalCount` and `blockHeight`; 14 old functions, now deprecated, each with a catalog
  replacement; `_metadata`.
- **Removed**: relations between entities, aggregates (`sum`, `average`, `distinctCount`, ...), 60 event, message and
  internal lists (34 of them already hidden since 2026-10-04), and 19 old functions (14 on beta). Each has a
  replacement in the tables below, except the few listed under "Removed with no replacement".

## Limits

| Setting | Before (2026-10-02) | After (2026-10-19) | When a query goes over it |
|---|---|---|---|
| Time per query | 30 s (beta 20 s since 2026-10-03) | 10 s | The query is cancelled (`canceling statement due to statement timeout`) |
| Fields per query (complexity) | none | 150 | `Sorry, too complicated query! Current <n> is over 150 that is the max allowed complexity.` |
| Nesting | none | 5 levels of fields (depth 4) | `Query is too deep. Maximum depth allowed is 4.` |
| Aliases per request | none | 20 | `Alias limit exceeded` |
| Rows per list | 100 | 1000 (live since 2026-10-04; beta 2026-10-03) | No error: `first` above the limit returns the limit. A list without `first` returns the limit too |
| Aggregates | on | off | `Cannot query field` |

How each limit counts:

- **Complexity** is the number of fields the query selects, counted where they are written. `first` does not multiply
  it, and every alias counts. `{ blocks(first: 2000) { nodes { id } } }` costs 3. Every response carries its cost
  in the `query-complexity` header. Introspection fields cost nothing.
- **Depth**: the top field is level 0, and a field may sit at most 4 levels below it.
  `{ suppliers { nodes { id } } }` uses 2. Without relations, an entity list needs at most 3
  (`suppliers { edges { node { id } } }`). Functions return rows or JSON, so they are always shallow. An operation
  named `IntrospectionQuery`, the name GraphiQL and code generators use, is exempt from the depth limit.
- **Time**: the limit is the database's `statement_timeout` for each statement of the request. A function that
  cannot finish in 10 s must be called with a shorter range or a coarser bucket.

## Unchanged

### Entities

Each entity is a list (`suppliers`) and a lookup by key (`supplier(id:)`). A list takes `filter` on its own columns,
`orderBy` on its own columns, `first` / `offset` (or `before` / `after` cursors), `distinct` and `blockHeight` (the
rows as they were at that height). It returns `nodes`, `edges`, `pageInfo` and `totalCount`. Their columns are the same
as before, plus the four columns under "New". After the closure they have no relation fields; see "Inside the
entities".

| List | Lookup by key | Columns |
|---|---|---|
| `accounts` | `account(id:)` | `id`, `chainId`, `moduleId` |
| `balances` | `balance(id:)` | `id`, `accountId`, `denom`, `amount`, `lastUpdatedBlockId`, `lastUpdatedTime` |
| `blocks` | `block(id:)` | `id`, `chainId`, `hash`, `timestamp`, `proposerAddress`, `metadataId`, `size`, `totalComputedUnits`, `totalRelays`, `failedTxs`, `successfulTxs`, `totalTxs`, `stakedSuppliers`, `stakedSuppliersTokens`, `unstakingSuppliers`, `unstakingSuppliersTokens`, `timeToBlock`, `unstakedSuppliers`, `unstakedSuppliersTokens`, `stakedApps`, `stakedAppsTokens`, `unstakingApps`, `unstakingAppsTokens`, `unstakedApps`, `unstakedAppsTokens`, `stakedGateways`, `stakedGatewaysTokens`, `unstakedGateways`, `unstakedGatewaysTokens`, `stakedValidators`, `stakedValidatorsTokens`, `unstakingValidators`, `unstakingValidatorsTokens`, `totalEstimatedComputedUnits`, `totalEstimatedRelays` |
| `blockMetadata` | `blockMetadatum(id:)` | `id`, `blockId`, `header`, `lastCommit` |
| `blockSupplies` | `blockSupply(id:)` | `id`, `blockId`, `supplyId` |
| `supplies` | `supply(id:)` | `id`, `denom`, `amount` |
| `transactions` | `transaction(id:)` | `id`, `blockId`, `gasUsed`, `gasWanted`, `fees`, `memo`, `status`, `log`, `code`, `idx`, `codespace`, `timeoutHeight`, `signerAddress`, `isMultisig`, `multisig`, `amountOfMessages`, `amountSentByDenom`, `blockTime` |
| `nativeTransfers` | `nativeTransfer(id:)` | `id`, `senderId`, `recipientId`, `amounts`, `denom`, `status`, `eventId`, `messageId`, `transactionId`, `blockId`, `blockTime` |
| `params` | `param(id:)` | `id`, `namespace`, `key`, `value`, `blockId`, `activeAt` |
| `services` | `service(id:)` | `id`, `name`, `computeUnitsPerRelay`, `ownerId`, `prevTargetHashHexEncoded`, `newTargetHashHexEncoded`, `prevNumRelaysEma`, `newNumRelaysEma` |
| `suppliers` | `supplier(id:)` | `id`, `operatorId`, `ownerId`, `stakeAmount`, `stakeDenom`, `stakeStatus`, `unstakingBeginBlockId`, `unstakingReason`, `unstakingEndHeight`, `unstakingEndBlockId` |
| `supplierServiceConfigs` | `supplierServiceConfig(id:)` | `id`, `supplierId`, `serviceId`, `revShare`, `endpoints`, `activatedAtId`, `activatedEventId`, `domains` |
| `applications` | `application(id:)` | `id`, `accountId`, `stakeAmount`, `stakeDenom`, `stakeStatus`, `unstakingBeginBlockId`, `unstakingEndHeight`, `unstakingReason`, `unstakingEndBlockId`, `transferredFromAtId`, `sourceApplicationId`, `destinationApplicationId`, `transferBeginBlockId`, `transferEndBlockId`, `transferringToId`, `transferEndHeight` |
| `applicationServices` | `applicationService(id:)` | `id`, `applicationId`, `serviceId` |
| `applicationGateways` | `applicationGateway(id:)` | `id`, `gatewayId`, `applicationId` |
| `gateways` | `gateway(id:)` | `id`, `accountId`, `stakeAmount`, `stakeDenom`, `stakeStatus`, `unstakingBeginBlockId`, `unstakingEndHeight`, `unstakingEndBlockId` |
| `validators` | `validator(id:)` | `id`, `ed25519Id`, `signerId`, `signerPoktPrefixId`, `delegatorId`, `description`, `commission`, `minSelfDelegation`, `stakeDenom`, `stakeAmount`, `stakeStatus`, `transactionId`, `createMsgId`, `delegatorShares` |
| `authzs` | `authz(id:)` | `id`, `granterId`, `granteeId`, `type`, `msg`, `expiration`, `eventId`, `blockId` |
| `morseClaimableAccounts` | `morseClaimableAccount(id:)` | `id`, `msgImportMorseClaimableAccountsId`, `unstakedBalanceAmount`, `supplierStakeAmount`, `applicationStakeAmount`, `morseOutputAddress`, `unstakingTime`, `shannonDestAddress`, `claimedAtId`, `claimed`, `transactionId`, `claimedMsgId`, `unstakedBalanceDenom`, `supplierStakeDenom`, `applicationStakeDenom` |

`node(nodeId:)`, the `nodeId` field and the `...ByNodeId` lookups stay because the query service cannot hide them. Do
not build on them.

`aggregates { keys }` and `groupedAggregates(groupBy: [...]) { keys }` stay in the schema because the query service
keeps them even with aggregates off. `aggregates { keys }` is always `null`. `groupedAggregates(groupBy:) { keys }`
returns the distinct combinations of the grouped columns, with no counts or sums.

`_metadata` and `_metadatas` stay: indexer height, chain, versions.

### Old functions (deprecated)

These 14 functions keep their arguments, their return type and the keys of their output, and a client can still call
them. Each is marked `@deprecated` in the schema, with its replacement. They stay until a removal date that will be
announced later. Some now read precomputed tables and answer faster.

The replacements take `[rangeStart, rangeEnd)` with an explicit zone; the old functions took an inclusive end without
a zone (`2026-10-20 23:59:59.999` there is `2026-10-21T00:00:00Z` here). Within that window they answer the same,
except where the notes say otherwise (checked against mainnet on 2026-10-20).

| Function | Arguments | Use instead | Notes |
|---|---|---|---|
| `getAmountOfBlocksAndSuppliersByTimes` | startDate, endDate | `getStakedSuppliersByServiceList` / `Json` | Full days come from a daily rollup; a day the rollup does not hold yet is a gap in `gaps`, not a zero |
| `getClaimProofsDataByTime` | startTs, endTs, truncInterval | `getNetworkClaimsList` / `Json` | Its `proof_*` are `settled_*`. Heights the per-block claims table does not hold yet are a gap, not zeros (the old function read the raw tables then; on mainnet the table holds every height) |
| `getComputeUnitsToTokensMultiplierEvolution` | startDate, endDate, truncInterval | `getParamHistoryList(namespaces: ["shared"], keys: ["compute_units_to_tokens_multiplier"])` | One row per change of value, not per time bucket: the value at a bucket's last block is the newest change at or before it |
| `getDaoBalanceAtHeight` | height | `balances(blockHeight: "<height>", filter: {accountId: {equalTo: "<DAO address>"}, denom: {equalTo: "upokt"}})` | The DAO address is the `tokenomics` `dao_reward_address` param at that height (`params(blockHeight:)`) |
| `getLatestBlocksByDay` | startDate, endDate | `getBlockStatsJson(bucket: "day")`, then `blocks(filter: {id: {in: [...]}})` | `last_height` of each day is that day's latest block; the block rows need the second query |
| `getMissingValidatorBlocks` | fromId, validatorAddress | `getValidatorBlocksList(kind: "missed")` | Newest first, `rowLimit` rows a call (default 100, up to 1000), paged with `beforeHeight`; the old function returned every id, oldest first |
| `getOverservicedByAddressesAndTime` | addresses, startTs, endTs, truncInterval | `getOverservicedList` / `Json` (`operators`) | The events' own amounts. `getSupplierEarnings*` `overservicing_loss_upokt` comes from the settlements and differs from them by about 1 ppm |
| `getProducedBlocksByValidator` | fromId, validatorAddress | `getValidatorBlocksList(kind: "produced")` | As `getMissingValidatorBlocks` |
| `getRelaysByServicePerPointJson` | startTimestamp, endTimestamp, truncInterval | `getServiceUsageJson` with a `bucket` | |
| `getRewardsByDate` | startDate, endDate, truncInterval | `getNetworkRewardsList` / `Json` | |
| `getRewardsByDomainsAndTimeGroupByService` | domains, startTs, endTs | `getDomainServiceRewardsList` / `Json` | Days: the old function read the dates of `startTs` to `endTs`, both included; the new one reads the UTC days that start inside the range, so pass the first midnight and the midnight after the last day (a start in the middle of a day leaves that day out). `staked_suppliers`: with one domain the same number; with several, the distinct suppliers across them (a supplier on two of the domains counts once), where the old function returned one of the domains' counts. It is null for several domains on a day whose supplier sets are not written yet |
| `getSupplyCompositionBetweenDates` | startDate, endDate, truncInterval | `getSupplyCompositionList` / `Json`; the totals in `getSupplyList` / `Json`; one block in `getSupplyCompositionAtList` | `bucket` is day, week, month or year |
| `getTotalSupplyBetweenDates` | startDate, endDate | `getSupplyList` / `Json` with `bucket: null` | One row at the range's last block with an upokt supply |
| `getTotalSupplyByDay` | startDate, endDate | `getSupplyList` / `Json` (`bucket: "day"`) | |

## New

### Columns

`transactions.blockTime`, `nativeTransfers.blockTime` and `balances.lastUpdatedTime`: the time of the row's block, so a
client no longer needs `transaction { block { timestamp } }`. `validators.delegatorShares`: the validator's delegator
shares, as the chain reports them (since 2026-10-03).

### Catalog functions

Functions that return rows come as `<name>List`: a plain list of rows, with no `nodes` or `totalCount`
(`{ getLastSettlement { height blockTime } }`). They are paged with `first` / `offset` (at most 1000 rows) and can be
filtered on their columns. Where they sum over a time range, they also come as `<name>Json`, which returns
`{range, data}`: every row in one call, plus the part of the range the data covers (`covered_from`, `covered_to`,
`gaps`). Amounts are in upokt. In `...Json` every number is a string, so no client loses precision.

Time ranges are `[rangeStart, rangeEnd)`, timestamptz with an explicit zone (`2026-10-01T00:00:00Z`). `bucket` is
`hour` (up to 7 days), `day` (up to 92 days), `week` (up to 366 days), `month` or `year`, in UTC.

Six functions list rows one by one, newest first: `getClaims*`, `getActorLifecycle*`, `getRelayMiningDifficulty*`,
`getCreatedClaims*`, `getMorseClaims*` and `getNativeTransfers*`. They return at most `rowLimit` rows (default 100,
up to 1000). To get the next page, pass the last row's keys as `before*` (`beforeHeight` with `beforeEventIdx` or
`beforeId`, or `beforeServiceId`) and repeat until a page comes back short. `getValidatorBlocksList` pages the same
way, with `beforeHeight`.

Six functions answer about sessions: which suppliers the chain selected for each session (its roster) and how each of
them ended once the session settled (`getSupplierSessionFunnel*`, `getSupplierSessionList*`, `getSessionRosters*`,
`getNetworkSessions*`, `getApplicationSessions*`, and `getActiveSessionsList` for the sessions running now). The rosters
are computed by the indexer as poktroll's session hydrator does, which reproduces the chain from poktroll v0.1.33 on;
they start with the release and its backfill of 60 days, and every range reports what they cover. The supplier functions
take one selector: `suppliers` (up to 200), `owners`, `operators` or `domains` (up to 200).

Every function and argument is described in the schema (introspection, GraphiQL). The table gives the first sentence
of each description. All are live now, except `getTxCountsList` / `getTxCountsJson`, which arrive on 2026-10-19, and the
catalog versions of the old functions, which come with a later release (item 4 of "Timeline").

| Function | Arguments | What it returns |
|---|---|---|
| `getActiveAccountsList` | sinceTimes | Accounts active since each time of since_times (up to 20, timestamptz with an explicit zone): accounts = the live upokt balances last updated in a block at or after the time (null when beyond_tip: no indexed block that late yet); height = the newest block before the time (an account counts when its last update is above it). |
| `getActiveSessionsList` | suppliers, services, byService, owners, operators, domains | Sessions running now (not settled yet), per service with by_service (services narrows them, up to 200): network_active = every active session of the service, oldest_start_height = the earliest start among them; with a selector (optional: suppliers up to 200, owners, operators or domains up to 200, as in getSupplierSessionFunnel), selected_active = those with at least one selected supplier in the roster and selected_seats = their seats in them (null without a selector). |
| `getActorLifecycleJson` / `getActorLifecycleList` | kind, addresses, rangeStart, rangeEnd, owners, operators, events, rowLimit, beforeHeight, beforeId, operatorScope | Stake history of suppliers, applications or gateways, one row per event, newest first (by height, then id): stake (stake_upokt, owner_id for suppliers) and unstake messages with their transaction_id, unbonding_begin and unbonding_end (reason, unbonding_end_height, session_end_height; reason as the actor entity's unstakingReason names it: VOLUNTARY, BELOW_MIN_STAKE, MIGRATION or UNSPECIFIED for suppliers, ELECTIVE, BELOW_MINIMUM_STAKE or MIGRATION for applications (UNRECOGNIZED on an unbonding_end whose reason the indexer did not recognize), NULL for gateways), and for suppliers each slash (service, application, session, penalty_upokt, previous_stake_upokt, stake_upokt after it, proof_validation_status). |
| `getAppAutoUnstakesJson` / `getAppAutoUnstakesList` | applications, rangeStart, rangeEnd, bucket, byApplication, fillEmptyBuckets | Applications the chain unstaked because their stake fell below the minimum; applications NULL = every application. |
| `getApplicationFleetList` | applications, services, gateways, stakeStatuses, byApplication, rowLimit, rowOffset | Applications now: the current version of the applications listed (up to 200), kept to those with a live service row for one of services and to those delegating to one of gateways now (all combined; none = every application), and to stake_statuses (Staked, Unstaking, Unstaked; NULL = all). |
| `getApplicationSessionsJson` / `getApplicationSessionsList` | rangeStart, rangeEnd, applications, services, bucket, byApplication, byService | Sessions of applications per bucket of session start (day, week, month or year; NULL = one total) and per application / service with by_application / by_service: sessions = the settled sessions, sessions_with_claim = those in which a member made a claim, sessions_no_work = those in which none did (the application sent no work), roster_seats and claimed_seats summed over them, paid_upokt = what they paid the suppliers' shareholders (V summed) and settled_upokt; active = the sessions not settled yet. |
| `getApplicationSpendJson` / `getApplicationSpendList` | applications, rangeStart, rangeEnd, bucket, byService, bySupplier, byApplication, fillEmptyBuckets | Application spend: what applications paid (burned_upokt), overserviced work they did not pay, reimbursements, relays, compute units, claims and the first and last settlement height of those claims (NULL where not known yet); by_service, by_supplier, by_application. |
| `getBlockMetadataList` | height, hash | A block's metadata record, given by height or by hash (exactly one; the hash in any case): block_height, and the CometBFT block_id, header and last_commit as JSON, as the indexer received them; no row for a block it has no record for. |
| `getBlockStatsJson` / `getBlockStatsList` | rangeStart, rangeEnd, bucket | Block statistics per bucket: blocks and the first and last height, transactions (total, successful, failed), relays and compute units (claimed and estimated) as the indexer reports them per block, the time between blocks in milliseconds (average, minimum, maximum; a block whose previous one is not indexed is left out of the average and minimum) and the average block size in bytes. |
| `getBlockSuppliesList` | height, hash | Supply at a block, given by height or by hash (exactly one; the hash in any case): one row per denomination with its amount in that denomination's own base unit (upokt for upokt, mact for mact; not converted), as the indexer recorded it for that block; no row for a block it has no supply for. |
| `getClaimsJson` / `getClaimsList` | suppliers, rangeStart, rangeEnd, owners, operators, applications, services, statuses, rowLimit, beforeHeight, beforeEventIdx, operatorScope | Claims one by one, newest first (by height, then event_idx): settled ones with their amounts, relays, compute units and whether a proof backed them, and expired ones with their expiration_reason (PROOF_MISSING, PROOF_INVALID; NULL amounts that only a settlement has). |
| `getCreatedClaimsCountList` | suppliers, rangeStart, rangeEnd, fromSessionEndHeight | Created claims (MsgCreateClaim) counted per supplier, for up to 20 suppliers, in [range_start, range_end) (timestamptz with an explicit zone; NULL = the whole history): one row per requested supplier with claims (0 when it made none) and the first and last height counted; from_session_end_height counts only the claims of sessions that end at or after that height, as get_created_claims lists them. |
| `getCreatedClaimsJson` / `getCreatedClaimsList` | suppliers, rangeStart, rangeEnd, rowLimit, beforeHeight, beforeId, fromSessionEndHeight | Claims created (MsgCreateClaim) by up to 20 suppliers, newest first (by height, then id), whether or not they settled yet: application, service, session_id, session_end_height, relays, compute units and claimed_upokt as claimed, and the transaction_id. |
| `getDelegatorIncomeJson` / `getDelegatorIncomeList` | delegators, rangeStart, rangeEnd, bucket, byValidator, byDelegator, fillEmptyBuckets, validators | Delegator income: what delegators received, and by_validator from which validator, with replayed_count = the contributions replayed from the delegations snapshot (288,180 to batched_vrd); delegators NULL = every delegator; validators keeps the income from those validators (their delegators); by_delegator. |
| `getDomainServiceRewardsJson` / `getDomainServiceRewardsList` | domains, rangeStart, rangeEnd | What the suppliers serving the domains (up to 200 endpoint root domains) earned per service, summed over the UTC days that start inside [range_start, range_end): relays, compute units, claimed_upokt (gross rewards), staked_suppliers on the service's last day read, first_day / last_day and the first and last height of those days. |
| `getDomainStakedSuppliersJson` / `getDomainStakedSuppliersList` | suppliers, domains, rangeStart, rangeEnd | The staked suppliers of the domains (up to 200 endpoint root domains) among a list of suppliers (up to 200), per UTC day that starts inside [range_start, range_end), domain and service: staked_suppliers = how many of the listed suppliers were staked on it that day, supplier_ids = which, and the day's first and last height counted. |
| `getGatewayDelegationsList` | gateways, atHeight, rowLimit, afterGatewayId, afterApplicationId | Gateways and the applications delegating to them at a height (at_height NULL = the last height the indexer processed; every row carries the height read in height, to pass as at_height on the next pages): for the gateways listed (up to 200), each gateway's stake (gateway_stake_upokt, gateway_stake_status) and each delegated application's stake_upokt, stake_status and service_ids, all as of that height. |
| `getGatewayFleetList` | gateways, stakeStatuses, byGateway | Gateways now: the current version of the gateways listed (up to 200; NULL = every gateway), kept to stake_statuses (Staked, Unstaking, Unstaked; NULL = all). |
| `getGatewaySpendJson` / `getGatewaySpendList` | gateways, rangeStart, rangeEnd, bucket, byApplication, byService, byGateway, fillEmptyBuckets | Gateway spend: what the applications delegated to each gateway spent, by the delegation in force at each settlement height, with the first and last settlement height of those claims (NULL where not known yet); by_application, by_service, by_gateway. |
| `getHeightAt` | atTime | The last indexed block at or before at_time (a timestamptz with an explicit zone, 2026-10-01T00:00:00Z): its height and block_time; null when no indexed block is that early. |
| `getIncomeJson` / `getIncomeList` | addresses, rangeStart, rangeEnd, bucket, byReason, bySupplier, byService, byAddress, fillEmptyBuckets | Income of any address (shareholder, DAO, service owner, application, validator, delegator) by role; by_reason (in the family column: relay / global), by_supplier (the supplier that generated it), by_service, by_address. |
| `getLastSettlement` | - | The last settlement the money tables hold: the highest height they wrote (a height with settlement events, which may have no settled claim) up to what the indexer has processed, and its block time; null before the first one. |
| `getMorseClaimsJson` / `getMorseClaimsList` | morseAddresses, shannonAddresses, rangeStart, rangeEnd, kinds, rowLimit, beforeHeight, beforeId | Morse claims one by one, newest first (by height, then id): kind = account (a Morse account's balance claimed to a Shannon address), application or supplier (a Morse actor's stake and balance claimed as a Shannon one; for a supplier shannon_dest_address is where the chain records the claim (the claimed account's destination: the supplier address before poktroll v0.1.20, then the address the stake was minted to), with its operator, morse_node_address, claim_signer_type and the service_ids it claimed; for an application the service_ids), recover (a balance the authority recovered to shannon_dest_address; is_admin). |
| `getMorseClaimSummaryList` | - | Morse migration now: the Morse accounts imported for claiming on Shannon, one row for the claimed ones and one for the unclaimed: accounts, and the sums of their liquid balance (unstaked_balance_upokt) and of the supplier and application stakes they carry. |
| `getNativeTransfersJson` / `getNativeTransfersList` | addresses, direction, rangeStart, rangeEnd, rowLimit, beforeHeight, beforeId | Native transfers (MsgSend) of the addresses listed (up to 200), newest first (by height, then id): the sender, recipient, denom and amounts ([{denom, amount}], amounts as strings), the transfer's status, its block_time, and its transaction's transaction_id, tx_code (0 = success), tx_codespace, tx_fees ([{denom, amount}]), tx_signer_address and tx_memo. |
| `getNetworkClaimsJson` / `getNetworkClaimsList` | rangeStart, rangeEnd, bucket | Network claims per bucket: claims created (claims, claimed_relays, claimed_compute_units, claimed_upokt and the estimated ones), settled (settled_*) and expired (expired_*), as getClaimProofsDataByTime gives them (its proof_* are the settled ones), with the first and last height summed. |
| `getNetworkRewardsJson` / `getNetworkRewardsList` | rangeStart, rangeEnd, bucket | Network totals of the settled claims per bucket, from the per-block relay totals: relays, estimated_relays, compute units (claimed and estimated) and claimed_upokt, as getRewardsByDate gives them, with the first and last height summed. |
| `getNetworkSessionsJson` / `getNetworkSessionsList` | rangeStart, rangeEnd, services, bucket, byService | The network's sessions per bucket of session start (day, week, month or year; NULL = one total) and per service with by_service (services narrows them, up to 200), from the daily rollup of the UTC days that start inside [range_start, range_end), by the block time of the session start: sessions (settled), with_claim, no_work (no member claimed: the application sent no work), roster_seats, avg_roster_size, avg_candidates (the suppliers a session chose from: the competition for a seat), the seats per final state, paid_upokt (V summed) and settled_upokt; active_now = the sessions running now. |
| `getOverservicedJson` / `getOverservicedList` | operators, rangeStart, rangeEnd, bucket | Overservicing of the Staked suppliers that share revenue with the operators now (up to 200 addresses in the rev_share of a live service config), per bucket: expected_burn_upokt and effective_burn_upokt summed over their application overservicing events, the events and the first and last height, as getOverservicedByAddressesAndTime gives them. |
| `getParamHistoryJson` / `getParamHistoryList` | namespaces, keys, rangeStart, rangeEnd | Governance parameter history: each version whose value differs from the previous one, with previous_value; namespaces / keys NULL = all. |
| `getRelayMiningDifficultyJson` / `getRelayMiningDifficultyList` | services, rangeStart, rangeEnd, rowLimit, beforeHeight, beforeServiceId, rowOffset | Relay mining difficulty history of the services listed (up to 200): each update newest first (by height, then service_id), with the relays EMA and the target hash before and after it. |
| `getServiceSummaryList` | services, owners | Services now: per service, the suppliers with a live service config for it and how many of them are Staked, and the applications with a live service row for it and how many are Staked; and its relay mining difficulty now, from its newest difficulty update: num_relays_ema, target_hash_hex and difficulty_updated_height (NULL when it never had one; get_relay_mining_difficulty lists the updates). |
| `getServiceUsageJson` / `getServiceUsageList` | services, rangeStart, rangeEnd, bucket, topBySettled, byService, fillEmptyBuckets, rowOffset, rowLimit, orderDir, searchText, compareStart, compareEnd, withDetails | Service usage: claimed and settled upokt, relays, compute units and claims per service; services, or top_by_settled = N for the N services that settled the most (rank_by_settled); by_service. |
| `getSessionRostersJson` / `getSessionRostersList` | rangeStart, rangeEnd, sessionIds, applications, services, rowLimit, beforeHeight, beforeSessionId | Session rosters one session per row, newest first (by start height, then session_id): the sessions that started in [range_start, range_end), or those named in session_ids (up to 200), narrowed by applications and services (up to 200 each): application, service, start and end heights, start_time, settled_height (null while active), candidates, roster_size, claimed, paid_upokt (V) and settled_upokt, and member_ids / member_states / member_paid_upokt = every member the chain selected, its state and what it was paid. |
| `getStakedDomainServicesList` | rowLimit, afterDomain, afterServiceId | Live service configs of the Staked suppliers now, counted per (endpoint root domain, service): configs = the configs whose endpoints are on the domain (each config once, as get_staked_supplier_services gives its domains; a config with no domain is counted under domain '' (an empty string), so configs summed over the rows is never below total_configs). |
| `getStakedSuppliersByServiceJson` / `getStakedSuppliersByServiceList` | rangeStart, rangeEnd, services | Staked suppliers per service over a range, from a daily rollup: blocks = the blocks with staked suppliers of the service, suppliers_staked = the staked suppliers summed over those blocks (divide by blocks for the average per block), as getAmountOfBlocksAndSuppliersByTimes gives them. |
| `getStakedSupplierServicesList` | services, rowLimit, afterSupplierId, afterServiceId | Live service configs of the Staked suppliers now, one row per (supplier, service): the supplier's owner_id and stake_upokt, the service, the endpoint root domains of that config, and activated_at_height (the height from which the chain serves the config; a config waiting for its session start has a height above the current block). |
| `getStakedSuppliersList` | rowLimit, afterSupplierId, stakeStatuses, atHeight | The Staked suppliers (stake_statuses: those statuses, default Staked) at a height (at_height NULL = the last height the indexer processed; every row carries the height read in height: pass it as at_height on the next pages so the whole walk reads one state), one row each: owner_id, operator_id, stake_upokt, and the service_ids and endpoint root domains of their service configs at that height (empty arrays when they have none; a supplier not Staked with no config at the height gets the configs closed at its last closing, which can take seconds a page; a Staked one with none gets empty arrays). |
| `getSupplierConfigHistoriesJson` | suppliers, services | Service configs over time of up to 200 suppliers (suppliers; services keeps those, up to 200) in one call: every row of getSupplierConfigHistoriesList, as one JSON array in its order (supplier_id, service_id, first_height), numbers as strings. |
| `getSupplierConfigHistoriesList` | suppliers, services, rowLimit, afterSupplierId, afterServiceId, afterFirstHeight | Service configs over time of up to 200 suppliers (suppliers; services keeps those, up to 200), one row per supplier and stretch of heights in which a config declared the same content, as getSupplierConfigHistoryList gives them for one supplier: supplier_id, service_id, first_height, last_height (NULL while declared now), rev_share sorted by address, endpoints and the endpoint root domains. |
| `getSupplierConfigHistoryList` | supplierId, services, rowLimit, afterServiceId, afterFirstHeight | Service configs of one supplier over time (supplier_id; services keeps those, up to 200), one row per stretch of heights in which a config declared the same content: a row starts at the config's first height, after a gap (the supplier unstaked, or dropped the service and took it back) and when its rev_share or endpoints change; restakes and activations that change nothing add no row. |
| `getSupplierDistributionJson` / `getSupplierDistributionList` | suppliers, rangeStart, rangeEnd, bucket, byReason, bySupplier, owners, fillEmptyBuckets, operators, byService | Supplier distribution: how what a supplier generated was paid out (each shareholder, the DAO, the service owner; stakers in one row); by_reason (in the family column: relay / global), by_supplier; owners or operators (the Staked suppliers whose service configs share revenue with them now) in place of suppliers. |
| `getSupplierDomainsList` | rangeStart, rangeEnd, top | Supplier domains (the root domains of the endpoints suppliers stake with) ranked by what their suppliers claimed: claimed_upokt, relays and compute units summed over the UTC days that start inside [range_start, range_end) (NULL = every day; first_day and last_day = the days found), with staked_suppliers = the Staked suppliers that have a live service config on the domain now and staked_upokt = their stake. |
| `getSupplierEarningsJson` / `getSupplierEarningsList` | suppliers, rangeStart, rangeEnd, bucket, byService, byApplication, bySupplier, owners, fillEmptyBuckets, operators, services | Supplier earnings: claimed and settled upokt, overservicing loss, relays, compute units, settled claims (with and without a proof) and the first and last settlement height of those claims (NULL where not known yet); suppliers NULL = every supplier, or owners = the suppliers they own now, or operators = the Staked suppliers whose service configs share revenue with them now; services (up to 200) keeps the claims of those services; by_service, by_application, by_supplier. |
| `getSupplierFleetList` | suppliers, owners, operators, domains, services, stakeStatuses, bySupplier, operatorScope, maxStakeUpokt, rowLimit, afterStakeUpokt, afterSupplierId, rowOffset | Supplier fleet now: the current version of the suppliers of one list (suppliers, up to 200; owners = the suppliers they own now; operators = the Staked suppliers whose service configs share revenue with them now (operator_scope ever = every supplier any of whose service configs shared revenue with them at any time, in any stake status: filter with stake_statuses; ever requires operators; ever reads an index of the rev_share wallets once it covers every height (indexed from genesis, or backfilled): ~25 ms for 7 wallets shared by 4,092 suppliers on mainnet; before that it takes seconds for a large operator); domains (up to 200) = the suppliers with a live service config with an endpoint on one of them; '' = a live config with no domain, the '' row of get_staked_domain_services), or of every supplier when none is given. |
| `getSupplierPenaltiesJson` / `getSupplierPenaltiesList` | suppliers, rangeStart, rangeEnd, bucket, byService, bySupplier, owners, fillEmptyBuckets, operators, operatorScope | Supplier penalties: expired claims by reason, discarded claims and slashes with their amount; suppliers NULL = every supplier; by_service, by_supplier; owners or operators (the Staked suppliers whose service configs share revenue with them now; operator_scope ever = every supplier any of whose service configs shared revenue with them at any time, in any stake status; ever reads an index of the rev_share wallets once it covers every height (indexed from genesis, or backfilled): ~25 ms for 7 wallets shared by 4,092 suppliers on mainnet; before that it takes seconds for a large operator) in place of suppliers. |
| `getSupplierProofsJson` / `getSupplierProofsList` | suppliers, rangeStart, rangeEnd, bucket, byService, bySupplier, owners, fillEmptyBuckets, operators | Supplier proofs: claims settled with and without a proof, proofs submitted, validated and invalid (by reason), each counted in the block of its own event; suppliers NULL = every supplier; owners or operators (the Staked suppliers whose service configs share revenue with them now) in place of suppliers. |
| `getSupplierSessionFunnelJson` / `getSupplierSessionFunnelList` | suppliers, rangeStart, rangeEnd, bucket, byService, bySupplier, owners, operators, domains, withSessions | What the selected suppliers made of the session seats the chain gave them, per bucket of session start and per service / supplier: seats per final state (paid, settled_zero, expired, discarded, slashed, idle_others_worked, idle_no_work, unresolved), paid_upokt (Y), equal_share_upokt (B = Σ V·X/K; F = Y / B), active seats, and sessions_with_selected, pool_upokt (V), roster_seats (K) and network_sessions for presence. One selector: suppliers (up to 200), owners, operators or domains (up to 200). |
| `getSupplierSessionListJson` / `getSupplierSessionListList` | suppliers, rangeStart, rangeEnd, services, states, rowLimit, beforeHeight, beforeSessionId, owners, operators, domains | Sessions of the selected suppliers one by one, newest first (by start height, then session_id): each session that started in [range_start, range_end) with at least one of them in the roster, with its application, service, heights, roster_size (K), candidates, claimed, paid_upokt (V) and settled_upokt, and the selected members, the state of each and what each was paid. |
| `getSupplierSessionsJson` / `getSupplierSessionsList` | suppliers, rangeStart, rangeEnd, bucket, byService | Sessions of a list of suppliers (up to 200): per bucket (and per service with by_service), the distinct sessions in which at least one of them settled a claim (three of the suppliers in one session count once), and settled_claims = their settled claims (three there), with the first and last settlement height. |
| `getSupplyCompositionAtList` | atHeight | Supply at one block, computed live: the last block at or below at_height (NULL = the latest) with an upokt supply, whose height and block_time every row carries; network_supply_upokt, unmigrated_upokt (the Morse balances not claimed at that block) and total_supply_upokt as get_supply gives them, repeated on each row; and one row per composition label (module account name, dao, wrapped, others) with its amount_upokt, as get_supply_composition. |
| `getSupplyCompositionJson` / `getSupplyCompositionList` | rangeStart, rangeEnd, bucket | Supply composition per bucket at the point get_supply reads (height, block_time): one row per label, the upokt balances at that block by module account name, dao (the tokenomics dao_reward_address at that block), wrapped (the bridge address) or others; as network_supply_composition of getSupplyCompositionBetweenDates. |
| `getSupplyFlowsJson` / `getSupplyFlowsList` | rangeStart, rangeEnd, bucket, byRole, fillEmptyBuckets | Network supply flows: burn, relay mint (mint_equals_burn), mint_ratio_unminted, overservicing loss, global mint and reimbursement, each by receiving role (by_role), plus slashes. |
| `getSupplyJson` / `getSupplyList` | rangeStart, rangeEnd, bucket | Supply per bucket at its point, the bucket's last block with an upokt supply inside the range (height, block_time): network_supply_upokt = the upokt supply recorded at that block, unmigrated_upokt = the Morse balances not claimed at that block (unstaked balance, supplier and application stake), total_supply_upokt = their sum; as getSupplyCompositionBetweenDates gives them. |
| `getTxCountsJson` / `getTxCountsList` | rangeStart, rangeEnd, msgTypes, statuses | Transactions per message type and status over a range, from a daily rollup, without counting the transactions table: msg_type is a message type URL (a transaction counts once under each type it holds, so the types do not add up to '*') or '*' for every transaction; status is success (code 0) or failed. |
| `getValidatorBlocksList` | validatorAddress, fromHeight, toHeight, kind, rowLimit, beforeHeight | Blocks a validator produced (kind produced, the default: the block proposer) or missed (kind missed: the block's last commit has no signature of it) from from_height to to_height (NULL = the latest), newest first, with block_time; validator_address is the consensus address in hex, as getProducedBlocksByValidator and getMissingValidatorBlocks took it. |
| `getValidatorRewardsJson` / `getValidatorRewardsList` | validators, rangeStart, rangeEnd, bucket, byValidator, fillEmptyBuckets | Validator rewards: commission (NULL when no distribution had one; with commission_unknown_count > 0 it is the sum of the known ones only, a partial sum), self-delegation, what went to delegators, the distributions and how many were replayed, and the delegated stake seen per validator (average, minimum, maximum; for an APR; NULL with by_validator false, which mixes validators); validators NULL = every validator; by_validator. |
| `moneyCoverageJson` / `moneyCoverageList` | rangeStart, rangeEnd | Coverage: the settlement heights written in the range, the heights the chain settled there that are missing, and the recorded gaps. |

### Legacy functions

Each replaces the old function with the same name (`get` becomes `legacy`). It takes the same arguments, and the old
JSON comes under `data`, next to `range`. They read the settlement tables instead of the raw transfers table.

| Function | Arguments | What it returns |
|---|---|---|
| `legacyBurnBreakdownBetweenDates` | startDate, endDate | Replaces get_burn_breakdown_between_dates (getBurnBreakdownBetweenDates). |
| `legacyMintBreakdownBetweenDates` | startDate, endDate | Replaces get_mint_breakdown_between_dates (getMintBreakdownBetweenDates). |
| `legacyRewardsByAddressesAndTime` | addresses, startDate, endDate | Replaces get_rewards_by_addresses_and_time (getRewardsByAddressesAndTime). |
| `legacyRewardsByAddressesAndTimeGroupByAddressAndDate` | addresses, startDate, endDate, truncInterval | Replaces get_rewards_by_addresses_and_time_group_by_address_and_date (getRewardsByAddressesAndTimeGroupByAddressAndDate). |
| `legacyRewardsByAddressesAndTimeGroupByDate` | addresses, startDate, endDate, truncInterval | Replaces get_rewards_by_addresses_and_time_group_by_date (getRewardsByAddressesAndTimeGroupByDate). |
| `legacyRewardsByAddressesAndTimeGroupByService` | addresses, startTs, endTs | Replaces get_rewards_by_addresses_and_time_group_by_service (getRewardsByAddressesAndTimeGroupByService). |
| `legacyRewardsBySuppliersAndTimeGroupByAddressAndDate` | addresses, supplierAddresses, startDate, endDate, truncInterval | Replaces get_rewards_by_suppliers_and_time_group_by_address_and_date (getRewardsBySuppliersAndTimeGroupByAddressAndDate). |
| `legacyRewardsBySuppliersAndTimeGroupByService` | operatorAddresses, startTs, endTs | Replaces get_rewards_by_suppliers_and_time_group_by_service (getRewardsBySuppliersAndTimeGroupByService). |
| `legacyRewardsOfAddressesBySuppliersAndTime` | addresses, supplierAddresses, startDate, endDate | Replaces get_rewards_of_addresses_by_suppliers_and_time (getRewardsOfAddressesBySuppliersAndTime). |

## What is removed, and what replaces it

Unless a heading says otherwise, these are removed on 2026-10-19.

### Lists removed on 2026-10-19

Each list below is removed together with its lookup by key (`eventClaimSettled(id:)`) and its `...ByNodeId`.

| Removed | Use instead |
|---|---|
| `eventClaimSettleds` (one row per claim) | `getClaimsList` / `getClaimsJson` (by suppliers, owners, operators, applications or services) |
| `eventClaimSettleds` sums and `groupedAggregates` | `getSupplierEarningsJson`, `getApplicationSpendJson`, `getGatewaySpendJson`, `getServiceUsageJson` |
| `eventClaimSettleds(orderBy: BLOCK_ID_DESC, first: 1) { blockId }` | `lastSettledHeight` in the rows of `getSupplierEarnings*`, `getApplicationSpend*` and `getGatewaySpend*`; `getLastSettlement { height blockTime }` for the network |
| `eventClaimExpireds` | `getClaimsList` / `getClaimsJson` with `statuses: ["expired"]`; totals in `getSupplierPenaltiesJson` |
| `eventSupplierSlasheds` | `getActorLifecycleList(kind: "supplier", events: ["slash"])`; totals in `getSupplierPenaltiesJson` |
| `eventSupplierUnbondingBegins`, `eventSupplierUnbondingEnds`, `msgStakeSuppliers`, `msgUnstakeSuppliers` | `getActorLifecycleList(kind: "supplier")` (events `stake`, `unstake`, `unbonding_begin`, `unbonding_end`) |
| `eventApplicationUnbondingBegins`, `eventApplicationUnbondingEnds`, `msgStakeApplications` | `getActorLifecycleList(kind: "application")` |
| `eventGatewayUnbondingBegins`, `eventGatewayUnbondingEnds`, `msgStakeGateways` | `getActorLifecycleList(kind: "gateway")` |
| `msgDelegateToGateways`, `msgUndelegateFromGateways` | `getActorLifecycleList(kind: "application" or "gateway", events: ["delegate", "undelegate"])`; the delegations at a height in `getGatewayDelegationsList` |
| `msgStakeSupplierServices` | `supplierServiceConfigs` now; `getSupplierConfigHistoryList` over time |
| `msgCreateClaims` | `getCreatedClaimsList` / `getCreatedClaimsJson` (up to 20 suppliers); counts in `getCreatedClaimsCountList` |
| `msgSubmitProofs` | `getSupplierProofsJson` |
| `eventApplicationOverserviceds` | `getApplicationSpendJson` (its overserviced columns) |
| `eventRelayMiningDifficultyUpdateds` | `getRelayMiningDifficultyList(services: [...])`; a service's current value is its newest row (`rowLimit: 1`) |
| `eventValidatorRewardDistributions` | `getValidatorRewardsJson`, `getDelegatorIncomeJson` |
| `modToAcctTransfers`, `modToAcctTransfersSummarizeds` | `getIncomeJson`, `getSupplierEarningsJson`, `getSupplierDistributionJson`, `getSupplyFlowsJson` |
| `relayByBlockAndServices` | `getServiceUsageJson` |
| `domainServiceDailyRewards` | `getSupplierDomainsList` |
| `relays` | Nothing: the table is empty (`totalCount` 0 on mainnet and beta, 2026-10-17) |

### Lists hidden since 2026-10-04

No client used these lists, so they were hidden when the catalog shipped. Each went together with its lookup by key.

| Removed | Use instead |
|---|---|
| `eventProofValidityCheckeds` | `getSupplierProofsJson` (`proofsValidated`, `proofsInvalid`, `invalidByReason`) |
| `eventClaimUpdateds`, `eventProofUpdateds` | `getClaimsList` (each claim as it settled or expired) and `getSupplierProofsJson` (`proofsSubmitted`); one row per update: none |
| `eventApplicationReimbursementRequests` | `getApplicationSpendJson` (`reimbursedUpokt`), `getSupplyFlowsJson` (flow `reimbursement`) |
| `eventSupplierServiceConfigActivateds` | `supplierServiceConfigs` (`activatedAtId`); over time, `getSupplierConfigHistoryList` (`firstHeight`, `lastHeight`) |
| `msgUnstakeApplications`, `msgUnstakeGateways`, `eventGatewayUnstakeds` | `getActorLifecycleList(kind: "application" or "gateway")` (events `unstake`, `unbonding_end`) |
| `msgStakeApplicationServices` | `applicationServices` |
| `msgAddServices` | `services` |
| `msgCreateValidators` | `validators` |
| `validatorRewards`, `validatorCommissions` | `getValidatorRewardsJson` (`commissionUpokt`, `selfDelegationUpokt`, `delegatorsUpokt`), `getDelegatorIncomeJson` |
| `msgClaimMorseAccounts`, `msgClaimMorseApplications`, `msgClaimMorseApplicationServices`, `msgClaimMorseSuppliers`, `msgClaimMorseSupplierServices`, `msgRecoverMorseAccounts` | `getMorseClaimsList` (kinds `account`, `application`, `supplier`, `recover`) |
| `msgImportMorseClaimableAccounts` | `morseClaimableAccounts` (the imported accounts); `getMorseClaimSummaryList` |
| `stakedSuppliersByBlockAndServices` | `getStakedSuppliersByServiceJson`; now, `getServiceSummaryList` |
| `stakedAppsByBlockAndServices` | `getServiceSummaryList` (`stakedApplications` per service now); per block: none |
| `supplyDenoms` | `supplies`, `getBlockSuppliesList` |
| `msgTransferApplications`, `eventTransferBegins`, `eventTransferEnds`, `eventTransferErrors` | The transfer columns of `applications` (`sourceApplicationId`, `destinationApplicationId`, `transferBeginBlockId`, `transferEndBlockId`, `transferEndHeight`); the transfer history: none |
| `events`, `messages`, `authzExecs`, `authzMsgExecs`, `genesisBalances`, `genesisFiles`, `moduleAccounts` | None: raw and internal tables. Message types per transaction: `transactions.amountOfMessages`; counts: `getTxCountsJson` |

### Functions

| Removed | Use instead |
|---|---|
| `getRewardsByAddressesAndTime`, `getRewardsByAddressesAndTimeGroupByDate`, `getRewardsByAddressesAndTimeGroupByAddressAndDate`, `getRewardsByAddressesAndTimeGroupByService`, `getRewardsBySuppliersAndTimeGroupByAddressAndDate`, `getRewardsBySuppliersAndTimeGroupByService`, `getRewardsOfAddressesBySuppliersAndTime`, `getMintBreakdownBetweenDates`, `getBurnBreakdownBetweenDates` | The `legacy*` function of the same name (`get` becomes `legacy`): same arguments, the old JSON under `data` |
| `getRewardsGroupByAddressAndDate` (mainnet only) | `legacyRewardsByAddressesAndTimeGroupByDate`: same arguments, one total per date. Per address and date: `legacyRewardsByAddressesAndTimeGroupByAddressAndDate` (the old function returned one row per address and date, without the address) |
| `getMintBreakdownBetweenDatesV2` (mainnet only) | `legacyMintBreakdownBetweenDates` (same arguments and keys) or `getSupplyFlowsJson`. Their numbers are not V2's: for 2026-10-15, V2 returned `reimbursement` 1,551,694 (twice 775,847) and `mint_burn` 0; both replacements return 775,847 and 588,351,758,852 |
| `getMonetaryBaseByDate` (mainnet only) | `getSupplyCompositionBetweenDates` with the same arguments: the old `amount` is the sum of the `others`, `wrapped` and `dao` entries of `network_supply_composition`, at the same block (equal at block 966,492) |
| `getSupplierStatsByDomains` | `getSupplierFleetList(domains: [...], stakeStatuses: ["Staked"], bySupplier: false)` (up to 200 domains a call) |
| `getClaimProofsDataByDelegatorsAndTime`, `getDataByDelegatorAddressesAndTimes`, `getDataByDelegatorAddressesAndTimesV2` (mainnet only), `getDataByDelegatorAddressesAndBlocks` | `getSupplierEarningsJson`, `getSupplierProofsJson` and `getSupplierPenaltiesJson` with `operators`. For heights instead of times, read each block's `timestamp` with `block(id:)` |
| `getSuppliersStakedAndBlocksByPointJson` (hidden with the release that adds the catalog versions of the old functions) | `getStakedSuppliersByServiceJson` per bucket range: blocks and suppliers_staked per service (its `tokens` has no replacement) |
| `servicesPerformanceBetweenTimes` | `getServiceUsageJson` with `rangeStart` / `rangeEnd` the current window and `compareStart` the start of the previous one |
| `getRewardsByDomainsAndTimeGroupByServiceV2` (mainnet only) | `getDomainServiceRewardsJson` (`getRewardsByDomainsAndTimeGroupByService` stays, deprecated). V2 already fails today (`column reference "domains" is ambiguous`). For its `suppliers_count`, use `getSupplierFleetList(domains: [...], bySupplier: false)` |

### Inside the entities

| Removed | Use instead |
|---|---|
| A related entity (`supplier { owner { ... } }`, `transaction { block { ... } }`) | The id column (`ownerId`, `blockId`), then a second query: `accounts(filter: {id: {in: [...]}})` |
| The rows of another entity (`supplier { serviceConfigs { ... } }`, `application { applicationServices { totalCount } }`) | A query on that entity by its id column: `supplierServiceConfigs(filter: {supplierId: {in: [...]}})`; counts in `getSupplierFleetList`, `getApplicationFleetList` (`serviceCount`, `gatewayCount`) and `getServiceSummaryList` |
| The "many to many" fields (`accountsBySupplierOwnerIdAndOperatorId`, ...) | Two queries through the id columns |
| A filter through a relation (`suppliers(filter: {serviceConfigs: {some: {serviceId: ...}}})`), and the `...Exist` filters | `getSupplierFleetList(services: [...])`, `getSupplierFleetList(operators: [...])` (the suppliers whose rev_share includes them), `getApplicationFleetList(services: [...])`; otherwise two queries |
| `transactions(filter: {nativeTransfersExist ...})` and the other filters through messages | `transactions(filter: {amountOfMessages: {contains: [{type: "/cosmos.bank.v1beta1.MsgSend"}]}})`; counts by type in `getTxCountsJson` |
| `orderBy` on a related column or on an aggregate (`ACCOUNT_BY_OWNER_ID__ID_ASC`, `..._SUM_..._ASC`) | `orderBy` on the entity's own columns |
| `aggregates { sum average min max distinctCount stddev... variance... }`, and the same inside `groupedAggregates` | The function for that sum: `getBlockStatsJson` (blocks), `getSupplierFleetList(..., bySupplier: false)` (supplier stake per owner, operator, domain or service), `getMorseClaimSummaryList` (Morse accounts claimed and unclaimed), `getServiceSummaryList`, `getTxCountsJson` (transactions) |

## Removed with no replacement

- `relays`: its table is empty on both networks.
- Generic aggregates: there is no way to sum, average or count distinct values over an arbitrary column of an
  arbitrary filter. The functions above cover the sums that clients used, and `totalCount` still counts the rows of
  any filter.
- Raw and internal lists hidden on 2026-10-04: `events`, `messages`, `authzExecs`, `authzMsgExecs`, `genesisBalances`,
  `genesisFiles` and `moduleAccounts`.
- Histories with no row-by-row replacement: claim and proof updates (`eventClaimUpdateds`, `eventProofUpdateds`),
  application transfers (`eventTransfer*`, `msgTransferApplications`), and staked applications per block and service
  (`stakedAppsByBlockAndServices`). Their current state and totals are available as listed above.

If you need something on this list, open an issue in https://github.com/pokt-network/pocketdex.

## Timeline

1. 2026-10-04 (live): lists return up to 1000 rows; the first catalog and `legacy*` functions and the new time
   columns appear; the 34 lists under "Lists hidden since 2026-10-04" are removed. Releases from then to 2026-10-16
   add the rest of the catalog (`getClaims*`, `getActorLifecycle*`, `getSupplierFleetList`, `getServiceSummaryList`,
   ... on 2026-10-14).
2. 2026-10-14 (live): what goes on 2026-10-19 is marked `@deprecated` in the schema, with its replacement in the
   reason. The marks cover the lists, the functions and the relations to one entity (`supplier { owner }`).
   Introspection, GraphiQL and generated clients show them. Relations to many rows, aggregates and filters through a
   relation cannot be marked.
3. Monday 2026-10-19 (UTC), beta then mainnet, finished by the end of the day: the removals and the new limits take
   effect. `getTxCountsList` / `getTxCountsJson` appear; until their backfill runs, the full days they do not hold
   yet come back as `gaps`, not as zeros.
4. A later release: the catalog versions of the old functions appear (`getStakedSuppliersByService*`, `getSupply*`,
   `getSupplyComposition*`, `getSupplyCompositionAtList`, `getNetworkRewards*`, `getNetworkClaims*`,
   `getOverserviced*`, `getDomainServiceRewards*`, `getValidatorBlocksList`), the reads for one provider's suppliers
   (`getSupplierSessions*`, `getDomainStakedSuppliers*`, `getSupplierConfigHistoriesList` / `Json`, and `byService` on
   `getSupplierDistribution*`), the 14 old functions above are marked
   `@deprecated` with them, and `getSuppliersStakedAndBlocksByPointJson` is hidden. The old functions stay until a
   removal date announced later.
