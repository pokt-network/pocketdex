import { getDbSchema, getSequelize } from "../utils/db";
import { getDataByDelegatorAddressesAndBlocksFn } from "./dataByDelegatorAddressesAndBlocks";
import {
  getDataByDelegatorAddressesAndTimesFn,
} from "./dataByDelegatorAddressesAndTimes";
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
import { getRewardsByDate } from "./rewards";
import {
  getRewardsByAddressesAndTime,
  getRewardsByAddressesAndTimeGroupByDate,
  getRewardsByAddressesAndTimeGroupByDateAndAddress,
  getRewardsBySuppliersAndTime,
  getRewardsBySuppliersAndTimeGroupByDateAndAddress,
} from "./rewardsByAddressesAndTime";
import { getRewardsByDelegatorAddressesAndTimesGroupByServiceFn } from "./rewardsByServicesAddressesAndTime";
import { getSuppliersStakedAndBlocksByPointJsonFn } from "./supplierStakedAndBlocksPoints";
import { getTotalSupplyByDay } from "./supply";

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

export async function createDbFunctions(): Promise<void> {
  const wereFunctionsCreated = await cache.get(functionsCreatedCacheKey)

  if (wereFunctionsCreated) return

  logger.debug('[createDbFunctions] creating db functions: get_relays_by_service_per_point_json, get_suppliers_staked_and_blocks_by_point_json')

  const schema = getDbSchema()

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
    getRewardsByDate,
    getRewardsBySuppliersAndTime,
    getRewardsBySuppliersAndTimeGroupByDateAndAddress,
    getTotalSupplyByDay,
  )

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

  logger.info(`[createDbFunctions] db functions were saved successfully to schema=${schema}.`)

  await cache.set(functionsCreatedCacheKey, true)
}
