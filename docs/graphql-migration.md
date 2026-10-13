# Migrating to the closed GraphQL schema

The pocketdex GraphQL API (https://data.pocket.network/graphql, https://data.beta.pocket.network/graphql) is being
reduced to a small, documented surface:

- The basic entities stay as plain lists: filters on their own columns, `orderBy`, `first` / `offset`, `totalCount`,
  and the lookup by key (`block(id:)`, `supplier(id:)`, ...).
- Relations go: no nested entities (`supplier { serviceConfigs { ... } }`), no filters through a relation
  (`serviceConfigs: { some: ... }`), no `node` / `nodeId` / `...ByNodeId`.
- Aggregates go: no `aggregates`, no `groupedAggregates`.
- Event, message and internal tables are hidden.
- Anything that combines or sums rows is a function. Every function and argument is described in the schema
  (introspection).

Functions that return rows come as `<name>List` (paged with `first` / `offset`, at most 1000 rows) and, where they read
a time range, as `<name>Json` too: `{range, data}` with every row in one call and the part of the range the data covers.
Amounts are in upokt. In `...Json` every number is a string.

## Replacements

| Today | Use instead |
|---|---|
| `suppliers(filter: {ownerId ...}) { totalCount aggregates { sum { stakeAmount } } }` | `getSupplierFleetList(owners: [...], bySupplier: false)` |
| `suppliers(filter: {serviceConfigs: {some: {revShare: {contains: ...}}}})` | `getSupplierFleetList(operators: [...])`: the Staked suppliers that share revenue with them |
| `getSupplierStatsByDomains(pDomains: [...])` | `getSupplierFleetList(domains: [...], stakeStatuses: ["Staked"], bySupplier: false)` |
| `supplierServiceConfigs(filter: {serviceId, supplier: {stakeStatus}})` | `getSupplierFleetList(services: [...], stakeStatuses: ["Staked"])` |
| `applicationServices(filter: {serviceId, application: {stakeStatus}})`, nested `applicationServices { totalCount }` | `getApplicationFleetList(services: [...])`, its `serviceCount` / `gatewayCount` |
| per-service counts of suppliers and applications | `getServiceSummaryList(services: [...])` |
| `eventClaimSettleds`, `eventClaimExpireds` (one row per claim) | `getClaimsList` / `getClaimsJson` (suppliers, owners, operators, applications, services; keyset paging with `beforeHeight` / `beforeEventIdx`) |
| `eventClaimSettleds` sums and `groupedAggregates` | `getSupplierEarningsJson`, `getApplicationSpendJson`, `getGatewaySpendJson`, `getServiceUsageJson` |
| `eventClaimSettleds(orderBy: BLOCK_ID_DESC, first: 1) { blockId }` | `lastSettledHeight` in the rows of `getSupplierEarnings*`, `getApplicationSpend*`, `getGatewaySpend*` |
| polling for a new settlement | `getLastSettlement { height blockTime }` |
| `msgCreateClaims` | `getCreatedClaimsList(suppliers: [...])` (up to 20 suppliers) |
| `msgSubmitProofs` counts, `eventProofValidityCheckeds` | `getSupplierProofsJson` |
| `msgStakeSuppliers`, `msgUnstakeSuppliers`, `event*UnbondingBegins/Ends`, `eventSupplierSlasheds` (and the application and gateway ones) | `getActorLifecycleList(kind: "supplier" \| "application" \| "gateway", ...)` |
| slash and expiration totals | `getSupplierPenaltiesJson` |
| `blocks { aggregates { sum average ... } }` | `getBlockStatsList` / `getBlockStatsJson` |
| `eventRelayMiningDifficultyUpdateds`, `service.relayMiningDifficultyUpdatedEvents` | `getRelayMiningDifficultyList(services: [...])`; the current value of one service is its newest row (`rowLimit: 1`) |
| `domainServiceDailyRewards { groupedAggregates(groupBy: DOMAIN) }` | `getSupplierDomainsList` |
| `morseClaimableAccounts { groupedAggregates(groupBy: CLAIMED) }` | `getMorseClaimSummaryList`; the accounts stay as `morseClaimableAccounts` |
| `modToAcctTransfers`, `modToAcctTransfersSummarizeds` | `getIncomeJson`, `getSupplierEarningsJson`, `getSupplierDistributionJson` |
| `getRewardsByAddressesAndTime*`, `getRewardsBySuppliersAndTime*`, `getMintBreakdownBetweenDates*` and the other functions over the raw transfers table | the `legacy*` function of the same name (`get` becomes `legacy`): same arguments, the old JSON under `data` |
| `transactions(filter: {nativeTransfersExist ...})` and the other message filters | `transactions(filter: {amountOfMessages: {contains: [{type: "/cosmos.bank.v1beta1.MsgSend"}]}})` |
| a nested entity (`supplier { stakeAmount }` inside another list) | a second query on that entity: `suppliers(filter: {id: {in: [...]}})` |

## Timeline

1. Now: the functions above are live next to the current schema. Move to them.
2. Later, announced on this page with a date: relations, aggregates and the hidden tables are removed from the schema.
   Clients still using them will get `Cannot query field` errors.
