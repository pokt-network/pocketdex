import { getDbSchema, getSequelize } from "../utils/db";
import { getLatestBlocksByDayFn } from "./blocks";
import { getClaimProofsDataByDelegatorsAndTimeFn, getClaimProofsDataByTimeFn } from "./claimProofs";
import { getDaoBalanceAtHeightFn } from "./dao";
import { getDataByDelegatorAddressesAndBlocksFn } from "./dataByDelegatorAddressesAndBlocks";
import {
  getDataByDelegatorAddressesAndTimesFn,
} from "./dataByDelegatorAddressesAndTimes";
import {
  createDomainServiceDailyRewardsTableFn,
  getPerformanceIndexSqls,
  refreshDomainServiceDailyRewardsFn,
} from "./domainRewards";
import { createModToAcctTransfersTableFn } from "./modToAcctTransfers";
import { getOverservicedsByDelegatorAddressesAndTimesFn } from "./overserviced";
import { getComputeUnitsToTokensMultiplierEvolutionFn } from "./params";
import { getRelaysByServicePerPointJsonFn } from "./relaysByServicePerPoint";
import { createNeededExtensions, updateBlockReportsFn, updateBlockReportsRangeFn } from "./reports";
import {
  updateStakedAppsDataOnBlockFn,
  updateUnstakedAppsDataOnBlockFn,
  updateUnstakingAppsDataOnBlockFn,
  upsertAppsByBlockAndServiceFn,
} from "./reports/apps";
import { updateStakedGatewaysDataOnBlockFn, updateUnstakedGatewaysDataOnBlockFn } from "./reports/gateways";
import { updateRelaysDataOnBlockFn, upsertRelaysByBlockAndServiceFn } from "./reports/relays";
import {
  updateStakedSuppliersDataOnBlockFn,
  updateUnstakedSuppliersDataOnBlockFn,
  updateUnstakingSuppliersDataOnBlockFn, upsertSuppliersByBlockAndServiceFn,
} from "./reports/suppliers";
import { updateTookOnBlocksFn } from "./reports/took";
import { updateTxsDataOnBlockFn } from "./reports/txs";
import { updateStakedValidatorsDataOnBlockFn, updateUnstakingValidatorsDataOnBlockFn } from "./reports/validators";
import { getRewardsByDate, getRewardsByDomainsAndTimesGroupByServiceFn, getSupplierStatsByDomainsFn } from "./rewards";
import {
  getRewardsByAddressesAndTime,
  getRewardsByAddressesAndTimeGroupByDate,
  getRewardsByAddressesAndTimeGroupByDateAndAddress,
  getRewardsBySuppliersAndTime,
  getRewardsBySuppliersAndTimeGroupByDateAndAddress,
} from "./rewardsByAddressesAndTime";
import { getRewardsByDelegatorAddressesAndTimesGroupByServiceFn } from "./rewardsByServicesAddressesAndTime";
import { getAmountOfBlocksAndSuppliersByTimesFn, servicesPerformanceBetweenTimesFn } from "./servicePerformance";
import { getSuppliersStakedAndBlocksByPointJsonFn } from "./supplierStakedAndBlocksPoints";
import {
  getBurnBreakdownBetweenDatesFn,
  getMintBreakdownBetweenDatesFn,
  getSupplyCompositionBetweenDatesFn,
  getTotalSupplyBetweenDatesFn,
  getTotalSupplyByDay,
} from "./supply";
import { getMissingValidatorBlocksFn, getProducedBlocksByValidatorFn } from "./validators";

const functionsCreatedCacheKey = 'functionsCreated';

async function createFunctions(schema: string,...fn: Array<
  (schema: string) => string
>): Promise<void> {
  const sequelize = getSequelize("Block")

  const query = `
  ${fn.map(fn => fn(schema)).join('\n')}
  `;

  await sequelize.query(query)
}

// CREATE INDEX CONCURRENTLY cannot run inside a transaction, so each index is
// executed as a separate query with no transaction. Errors are logged but not
// re-thrown — the indexer should not crash over a missing optimization index.
async function createIndexesConcurrently(sqls: string[]): Promise<void> {
  const sequelize = getSequelize("Block")

  for (const sql of sqls) {
    try {
      await sequelize.query(sql, { transaction: null })
    } catch (e) {
      logger.warn(`[createDbFunctions] failed to create index (non-fatal): ${e}`)
    }
  }
}

export async function createDbFunctions(): Promise<void> {
  const wereFunctionsCreated = await cache.get(functionsCreatedCacheKey)

  if (wereFunctionsCreated) return

  logger.debug('[createDbFunctions] creating db functions')

  const schema = getDbSchema()
  // these are the function used to generate the aggregated data saved by block
  await createFunctions(
    schema,
    // Relays
    updateRelaysDataOnBlockFn,
    upsertRelaysByBlockAndServiceFn,
    // Suppliers
    updateStakedSuppliersDataOnBlockFn,
    updateUnstakingSuppliersDataOnBlockFn,
    updateUnstakedSuppliersDataOnBlockFn,
    upsertSuppliersByBlockAndServiceFn,
    // Apps
    updateStakedAppsDataOnBlockFn,
    updateUnstakingAppsDataOnBlockFn,
    updateUnstakedAppsDataOnBlockFn,
    upsertAppsByBlockAndServiceFn,
    // Gateways
    updateStakedGatewaysDataOnBlockFn,
    updateUnstakedGatewaysDataOnBlockFn,
    // Validators
    updateStakedValidatorsDataOnBlockFn,
    updateUnstakingValidatorsDataOnBlockFn,
    // Took
    updateTookOnBlocksFn,
    // Transactions
    updateTxsDataOnBlockFn,
    // Block
    updateBlockReportsFn,
    updateBlockReportsRangeFn,
    createNeededExtensions,
  )
  // create the domain_service_daily_rewards summary table and its refresh function
  await createFunctions(
    schema,
    createModToAcctTransfersTableFn,
    createDomainServiceDailyRewardsTableFn,
    refreshDomainServiceDailyRewardsFn,
  )
  // CONCURRENT indexes must run outside any transaction, one query each
  await createIndexesConcurrently(getPerformanceIndexSqls(schema))
  // this will create db functions that are used in the graphql api
  await createFunctions(
    schema,
    getRelaysByServicePerPointJsonFn,
    getSuppliersStakedAndBlocksByPointJsonFn,
    getDataByDelegatorAddressesAndTimesFn,
    getDataByDelegatorAddressesAndBlocksFn,
    getRewardsByAddressesAndTime,
    getRewardsByAddressesAndTimeGroupByDate,
    getRewardsByAddressesAndTimeGroupByDateAndAddress,
    getRewardsByDelegatorAddressesAndTimesGroupByServiceFn,
    getSupplierStatsByDomainsFn,
    getRewardsByDomainsAndTimesGroupByServiceFn,
    getRewardsByDate,
    getRewardsBySuppliersAndTime,
    getRewardsBySuppliersAndTimeGroupByDateAndAddress,
    getTotalSupplyByDay,
    // New analytics functions
    getAmountOfBlocksAndSuppliersByTimesFn,
    getClaimProofsDataByDelegatorsAndTimeFn,
    getClaimProofsDataByTimeFn,
    getLatestBlocksByDayFn,
    getMissingValidatorBlocksFn,
    getProducedBlocksByValidatorFn,
    servicesPerformanceBetweenTimesFn,
    getBurnBreakdownBetweenDatesFn,
    getDaoBalanceAtHeightFn,
    getMintBreakdownBetweenDatesFn,
    getSupplyCompositionBetweenDatesFn,
    getTotalSupplyBetweenDatesFn,
    getOverservicedsByDelegatorAddressesAndTimesFn,
    getComputeUnitsToTokensMultiplierEvolutionFn,
  )

  logger.info(`[createDbFunctions] db functions were saved successfully to schema=${schema}.`)

  await cache.set(functionsCreatedCacheKey, true)
}
