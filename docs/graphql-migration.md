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
- **New**: 39 catalog functions (61 fields, counting `get...List` and `get...Json`) for everything that used to be
  summed or filtered through events and relations. There are also 9 `legacy*` functions that return what the old
  reward functions returned, a `blockTime` / `lastUpdatedTime` column on `transactions`, `nativeTransfers` and
  `balances`, and `validators.delegatorShares`. All are live now, except `getTxCountsList` / `getTxCountsJson`, which
  arrive on 2026-10-19.
- **Unchanged**: the 19 basic entities, as lists and lookups by key with their own columns, filters, `orderBy`,
  `first` / `offset`, `totalCount` and `blockHeight`; 15 old functions; `_metadata`.
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

### Old functions

These 15 functions keep their arguments, their return type and the keys of their output. A client still calls
them. They will move to the catalog later; there is no date yet. Some now read precomputed tables and answer faster.

| Function | Arguments | What it returns |
|---|---|---|
| `getAmountOfBlocksAndSuppliersByTimes` | startDate, endDate | Returns aggregated data of blocks and suppliers staked by service for a given time range. |
| `getClaimProofsDataByTime` | startTs, endTs, truncInterval | Returns aggregated claim and proof statistics over time intervals for all suppliers. |
| `getComputeUnitsToTokensMultiplierEvolution` | startDate, endDate, truncInterval | Returns the evolution of the shared compute_units_to_tokens_multiplier param over time intervals, |
| `getDaoBalanceAtHeight` | height | Returns the DAO balance at a specific block height. |
| `getLatestBlocksByDay` | startDate, endDate | Returns the latest block for each day within the specified date range. |
| `getMissingValidatorBlocks` | fromId, validatorAddress | Returns block IDs where a specific validator was missing from the signature set. |
| `getOverservicedByAddressesAndTime` | addresses, startTs, endTs, truncInterval | Overservice of the Staked suppliers that share revenue with the addresses (an address in the rev_share of a live service config): the application overservicing events (event_application_overserviceds) of those suppliers, per time bucket. |
| `getProducedBlocksByValidator` | fromId, validatorAddress | Returns block IDs produced (proposed) by a specific validator starting from a given block ID. |
| `getRelaysByServicePerPointJson` | startTimestamp, endTimestamp, truncInterval | Relays per service and time bucket between two block times, from the per-block relay totals of the claims. |
| `getRewardsByDate` | startDate, endDate, truncInterval | Network totals per time bucket between two block times, from the per-block relay totals of the claims. |
| `getRewardsByDomainsAndTimeGroupByService` | domains, startTs, endTs | Rewards of the suppliers that serve the given endpoint domains, per service, from the daily domain summaries. |
| `getSuppliersStakedAndBlocksByPointJson` | startTimestamp, endTimestamp, truncInterval | Staked suppliers per service and time bucket between two block times, from the per-block staked-supplier counts. |
| `getSupplyCompositionBetweenDates` | startDate, endDate, truncInterval | Returns detailed supply composition including network supply, unmigrated supply, and breakdown by account type over time intervals. |
| `getTotalSupplyBetweenDates` | startDate, endDate | Returns a snapshot of total supply metrics including network supply, unmigrated supply, and total supply for the latest block in the date range. |
| `getTotalSupplyByDay` | startDate, endDate | The upokt supply at the last block of each day, with the Morse balances still to claim at that block. |

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
`beforeId`, or `beforeServiceId`) and repeat until a page comes back short.

Every function and argument is described in the schema (introspection, GraphiQL). The table gives the first sentence
of each description. All are live now, except `getTxCountsList` / `getTxCountsJson`, which arrive on 2026-10-19.

| Function | Arguments | What it returns |
|---|---|---|
| `getActiveAccountsList` | sinceTimes | Accounts active since each time of since_times (up to 20, timestamptz with an explicit zone): accounts = the live upokt balances last updated in a block at or after the time (null when beyond_tip: no indexed block that late yet); height = the newest block before the time (an account counts when its last update is above it). |
| `getActorLifecycleJson` / `getActorLifecycleList` | kind, addresses, rangeStart, rangeEnd, owners, operators, events, rowLimit, beforeHeight, beforeId, operatorScope | Stake history of suppliers, applications or gateways, one row per event, newest first (by height, then id): stake (stake_upokt, owner_id for suppliers) and unstake messages with their transaction_id, unbonding_begin and unbonding_end (reason, unbonding_end_height, session_end_height; reason as the actor entity's unstakingReason names it: VOLUNTARY, BELOW_MIN_STAKE, MIGRATION or UNSPECIFIED for suppliers, ELECTIVE, BELOW_MINIMUM_STAKE or MIGRATION for applications (UNRECOGNIZED on an unbonding_end whose reason the indexer did not recognize), NULL for gateways), and for suppliers each slash (service, application, session, penalty_upokt, previous_stake_upokt, stake_upokt after it, proof_validation_status). |
| `getAppAutoUnstakesJson` / `getAppAutoUnstakesList` | applications, rangeStart, rangeEnd, bucket, byApplication, fillEmptyBuckets | Applications the chain unstaked because their stake fell below the minimum; applications NULL = every application. |
| `getApplicationFleetList` | applications, services, gateways, stakeStatuses, byApplication, rowLimit, rowOffset | Applications now: the current version of the applications listed (up to 200), kept to those with a live service row for one of services and to those delegating to one of gateways now (all combined; none = every application), and to stake_statuses (Staked, Unstaking, Unstaked; NULL = all). |
| `getApplicationSpendJson` / `getApplicationSpendList` | applications, rangeStart, rangeEnd, bucket, byService, bySupplier, byApplication, fillEmptyBuckets | Application spend: what applications paid (burned_upokt), overserviced work they did not pay, reimbursements, relays, compute units, claims and the first and last settlement height of those claims (NULL where not known yet); by_service, by_supplier, by_application. |
| `getBlockMetadataList` | height, hash | A block's metadata record, given by height or by hash (exactly one; the hash in any case): block_height, and the CometBFT block_id, header and last_commit as JSON, as the indexer received them; no row for a block it has no record for. |
| `getBlockStatsJson` / `getBlockStatsList` | rangeStart, rangeEnd, bucket | Block statistics per bucket: blocks and the first and last height, transactions (total, successful, failed), relays and compute units (claimed and estimated) as the indexer reports them per block, the time between blocks in milliseconds (average, minimum, maximum; a block whose previous one is not indexed is left out of the average and minimum) and the average block size in bytes. |
| `getBlockSuppliesList` | height, hash | Supply at a block, given by height or by hash (exactly one; the hash in any case): one row per denomination with its amount in that denomination's own base unit (upokt for upokt, mact for mact; not converted), as the indexer recorded it for that block; no row for a block it has no supply for. |
| `getClaimsJson` / `getClaimsList` | suppliers, rangeStart, rangeEnd, owners, operators, applications, services, statuses, rowLimit, beforeHeight, beforeEventIdx, operatorScope | Claims one by one, newest first (by height, then event_idx): settled ones with their amounts, relays, compute units and whether a proof backed them, and expired ones with their expiration_reason (PROOF_MISSING, PROOF_INVALID; NULL amounts that only a settlement has). |
| `getCreatedClaimsCountList` | suppliers, rangeStart, rangeEnd, fromSessionEndHeight | Created claims (MsgCreateClaim) counted per supplier, for up to 20 suppliers, in [range_start, range_end) (timestamptz with an explicit zone; NULL = the whole history): one row per requested supplier with claims (0 when it made none) and the first and last height counted; from_session_end_height counts only the claims of sessions that end at or after that height, as get_created_claims lists them. |
| `getCreatedClaimsJson` / `getCreatedClaimsList` | suppliers, rangeStart, rangeEnd, rowLimit, beforeHeight, beforeId, fromSessionEndHeight | Claims created (MsgCreateClaim) by up to 20 suppliers, newest first (by height, then id), whether or not they settled yet: application, service, session_id, session_end_height, relays, compute units and claimed_upokt as claimed, and the transaction_id. |
| `getDelegatorIncomeJson` / `getDelegatorIncomeList` | delegators, rangeStart, rangeEnd, bucket, byValidator, byDelegator, fillEmptyBuckets, validators | Delegator income: what delegators received, and by_validator from which validator, with replayed_count = the contributions replayed from the delegations snapshot (288,180 to batched_vrd); delegators NULL = every delegator; validators keeps the income from those validators (their delegators); by_delegator. |
| `getGatewayDelegationsList` | gateways, atHeight, rowLimit, afterGatewayId, afterApplicationId | Gateways and the applications delegating to them at a height (at_height NULL = the last height the indexer processed; every row carries the height read in height, to pass as at_height on the next pages): for the gateways listed (up to 200), each gateway's stake (gateway_stake_upokt, gateway_stake_status) and each delegated application's stake_upokt, stake_status and service_ids, all as of that height. |
| `getGatewayFleetList` | gateways, stakeStatuses, byGateway | Gateways now: the current version of the gateways listed (up to 200; NULL = every gateway), kept to stake_statuses (Staked, Unstaking, Unstaked; NULL = all). |
| `getGatewaySpendJson` / `getGatewaySpendList` | gateways, rangeStart, rangeEnd, bucket, byApplication, byService, byGateway, fillEmptyBuckets | Gateway spend: what the applications delegated to each gateway spent, by the delegation in force at each settlement height, with the first and last settlement height of those claims (NULL where not known yet); by_application, by_service, by_gateway. |
| `getHeightAt` | atTime | The last indexed block at or before at_time (a timestamptz with an explicit zone, 2026-10-01T00:00:00Z): its height and block_time; null when no indexed block is that early. |
| `getIncomeJson` / `getIncomeList` | addresses, rangeStart, rangeEnd, bucket, byReason, bySupplier, byService, byAddress, fillEmptyBuckets | Income of any address (shareholder, DAO, service owner, application, validator, delegator) by role; by_reason (in the family column: relay / global), by_supplier (the supplier that generated it), by_service, by_address. |
| `getLastSettlement` | - | The last settlement the money tables hold: the highest height they wrote (a height with settlement events, which may have no settled claim) up to what the indexer has processed, and its block time; null before the first one. |
| `getMorseClaimSummaryList` | - | Morse migration now: the Morse accounts imported for claiming on Shannon, one row for the claimed ones and one for the unclaimed: accounts, and the sums of their liquid balance (unstaked_balance_upokt) and of the supplier and application stakes they carry. |
| `getMorseClaimsJson` / `getMorseClaimsList` | morseAddresses, shannonAddresses, rangeStart, rangeEnd, kinds, rowLimit, beforeHeight, beforeId | Morse claims one by one, newest first (by height, then id): kind = account (a Morse account's balance claimed to a Shannon address), application or supplier (a Morse actor's stake and balance claimed as a Shannon one; for a supplier shannon_dest_address is where the chain records the claim (the claimed account's destination: the supplier address before poktroll v0.1.20, then the address the stake was minted to), with its operator, morse_node_address, claim_signer_type and the service_ids it claimed; for an application the service_ids), recover (a balance the authority recovered to shannon_dest_address; is_admin). |
| `getNativeTransfersJson` / `getNativeTransfersList` | addresses, direction, rangeStart, rangeEnd, rowLimit, beforeHeight, beforeId | Native transfers (MsgSend) of the addresses listed (up to 200), newest first (by height, then id): the sender, recipient, denom and amounts ([{denom, amount}], amounts as strings), the transfer's status, its block_time, and its transaction's transaction_id, tx_code (0 = success), tx_codespace, tx_fees ([{denom, amount}]), tx_signer_address and tx_memo. |
| `getParamHistoryJson` / `getParamHistoryList` | namespaces, keys, rangeStart, rangeEnd | Governance parameter history: each version whose value differs from the previous one, with previous_value; namespaces / keys NULL = all. |
| `getRelayMiningDifficultyJson` / `getRelayMiningDifficultyList` | services, rangeStart, rangeEnd, rowLimit, beforeHeight, beforeServiceId, rowOffset | Relay mining difficulty history of the services listed (up to 200): each update newest first (by height, then service_id), with the relays EMA and the target hash before and after it. |
| `getServiceSummaryList` | services, owners | Services now: per service, the suppliers with a live service config for it and how many of them are Staked, and the applications with a live service row for it and how many are Staked; and its relay mining difficulty now, from its newest difficulty update: num_relays_ema, target_hash_hex and difficulty_updated_height (NULL when it never had one; get_relay_mining_difficulty lists the updates). |
| `getServiceUsageJson` / `getServiceUsageList` | services, rangeStart, rangeEnd, bucket, topBySettled, byService, fillEmptyBuckets, rowOffset, rowLimit, orderDir, searchText, compareStart, compareEnd, withDetails | Service usage: claimed and settled upokt, relays, compute units and claims per service; services, or top_by_settled = N for the N services that settled the most (rank_by_settled); by_service. |
| `getStakedDomainServicesList` | rowLimit, afterDomain, afterServiceId | Live service configs of the Staked suppliers now, counted per (endpoint root domain, service): configs = the configs whose endpoints are on the domain (each config once, as get_staked_supplier_services gives its domains; a config with no domain is counted under domain '' (an empty string), so configs summed over the rows is never below total_configs). |
| `getStakedSupplierServicesList` | services, rowLimit, afterSupplierId, afterServiceId | Live service configs of the Staked suppliers now, one row per (supplier, service): the supplier's owner_id and stake_upokt, the service, the endpoint root domains of that config, and activated_at_height (the height from which the chain serves the config; a config waiting for its session start has a height above the current block). |
| `getStakedSuppliersList` | rowLimit, afterSupplierId, stakeStatuses, atHeight | The Staked suppliers (stake_statuses: those statuses, default Staked) at a height (at_height NULL = the last height the indexer processed; every row carries the height read in height: pass it as at_height on the next pages so the whole walk reads one state), one row each: owner_id, operator_id, stake_upokt, and the service_ids and endpoint root domains of their service configs at that height (empty arrays when they have none; a supplier not Staked with no config at the height gets the configs closed at its last closing, which can take seconds a page; a Staked one with none gets empty arrays). |
| `getSupplierConfigHistoryList` | supplierId, services, rowLimit, afterServiceId, afterFirstHeight | Service configs of one supplier over time (supplier_id; services keeps those, up to 200), one row per stretch of heights in which a config declared the same content: a row starts at the config's first height, after a gap (the supplier unstaked, or dropped the service and took it back) and when its rev_share or endpoints change; restakes and activations that change nothing add no row. |
| `getSupplierDistributionJson` / `getSupplierDistributionList` | suppliers, rangeStart, rangeEnd, bucket, byReason, bySupplier, owners, fillEmptyBuckets, operators | Supplier distribution: how what a supplier generated was paid out (each shareholder, the DAO, the service owner; stakers in one row); by_reason (in the family column: relay / global), by_supplier; owners or operators (the Staked suppliers whose service configs share revenue with them now) in place of suppliers. |
| `getSupplierDomainsList` | rangeStart, rangeEnd, top | Supplier domains (the root domains of the endpoints suppliers stake with) ranked by what their suppliers claimed: claimed_upokt, relays and compute units summed over the UTC days that start inside [range_start, range_end) (NULL = every day; first_day and last_day = the days found), with staked_suppliers = the Staked suppliers that have a live service config on the domain now and staked_upokt = their stake. |
| `getSupplierEarningsJson` / `getSupplierEarningsList` | suppliers, rangeStart, rangeEnd, bucket, byService, byApplication, bySupplier, owners, fillEmptyBuckets, operators, services | Supplier earnings: claimed and settled upokt, overservicing loss, relays, compute units, settled claims (with and without a proof) and the first and last settlement height of those claims (NULL where not known yet); suppliers NULL = every supplier, or owners = the suppliers they own now, or operators = the Staked suppliers whose service configs share revenue with them now; services (up to 200) keeps the claims of those services; by_service, by_application, by_supplier. |
| `getSupplierFleetList` | suppliers, owners, operators, domains, services, stakeStatuses, bySupplier, operatorScope, maxStakeUpokt, rowLimit, afterStakeUpokt, afterSupplierId, rowOffset | Supplier fleet now: the current version of the suppliers of one list (suppliers, up to 200; owners = the suppliers they own now; operators = the Staked suppliers whose service configs share revenue with them now (operator_scope ever = every supplier any of whose service configs shared revenue with them at any time, in any stake status: filter with stake_statuses; ever requires operators; ever reads an index of the rev_share wallets once it covers every height (indexed from genesis, or backfilled): ~25 ms for 7 wallets shared by 4,092 suppliers on mainnet; before that it takes seconds for a large operator); domains (up to 200) = the suppliers with a live service config with an endpoint on one of them; '' = a live config with no domain, the '' row of get_staked_domain_services), or of every supplier when none is given. |
| `getSupplierPenaltiesJson` / `getSupplierPenaltiesList` | suppliers, rangeStart, rangeEnd, bucket, byService, bySupplier, owners, fillEmptyBuckets, operators, operatorScope | Supplier penalties: expired claims by reason, discarded claims and slashes with their amount; suppliers NULL = every supplier; by_service, by_supplier; owners or operators (the Staked suppliers whose service configs share revenue with them now; operator_scope ever = every supplier any of whose service configs shared revenue with them at any time, in any stake status; ever reads an index of the rev_share wallets once it covers every height (indexed from genesis, or backfilled): ~25 ms for 7 wallets shared by 4,092 suppliers on mainnet; before that it takes seconds for a large operator) in place of suppliers. |
| `getSupplierProofsJson` / `getSupplierProofsList` | suppliers, rangeStart, rangeEnd, bucket, byService, bySupplier, owners, fillEmptyBuckets, operators | Supplier proofs: claims settled with and without a proof, proofs submitted, validated and invalid (by reason), each counted in the block of its own event; suppliers NULL = every supplier; owners or operators (the Staked suppliers whose service configs share revenue with them now) in place of suppliers. |
| `getSupplyFlowsJson` / `getSupplyFlowsList` | rangeStart, rangeEnd, bucket, byRole, fillEmptyBuckets | Network supply flows: burn, relay mint (mint_equals_burn), mint_ratio_unminted, overservicing loss, global mint and reimbursement, each by receiving role (by_role), plus slashes. |
| `getTxCountsJson` / `getTxCountsList` | rangeStart, rangeEnd, msgTypes, statuses | Transactions per message type and status over a range, from a daily rollup, without counting the transactions table: msg_type is a message type URL (a transaction counts once under each type it holds, so the types do not add up to '*') or '*' for every transaction; status is success (code 0) or failed. |
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
| `stakedSuppliersByBlockAndServices` | `getSuppliersStakedAndBlocksByPointJson`; now, `getServiceSummaryList` |
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
| `servicesPerformanceBetweenTimes` | `getServiceUsageJson` with `rangeStart` / `rangeEnd` the current window and `compareStart` the start of the previous one |
| `getRewardsByDomainsAndTimeGroupByServiceV2` (mainnet only) | `getRewardsByDomainsAndTimeGroupByService`, which stays. V2 already fails today (`column reference "domains" is ambiguous`). For its `suppliers_count`, use `getSupplierFleetList(domains: [...], bySupplier: false)` |

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
