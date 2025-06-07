import { getSequelize } from "../utils/db";
import { getDataByDelegatorAddressesAndBlocksFn } from "./dataByDelegatorAddressesAndBlocks";
import {
  getDataByDelegatorAddressesAndTimesFn,
} from "./dataByDelegatorAddressesAndTimes";
import { getRelaysByServicePerPointJsonFn } from "./relaysByServicePerPoint";
import { getSuppliersStakedAndBlocksByPointJsonFn } from "./supplierStakedAndBlocksPoints";

const functionsCreatedCacheKey = 'functionsCreated';

export async function createDbFunctions(): Promise<void> {
  const wereFunctionsCreated = await cache.get(functionsCreatedCacheKey)

  if (wereFunctionsCreated) return

  logger.debug('[createDbFunctions] creating db functions: get_relays_by_service_per_point_json, get_suppliers_staked_and_blocks_by_point_json')

  const sequelize = getSequelize("Block")
  // here is the db schema, we need it to create the functions in that schema
  // @ts-ignore
  const schema = store.context.config?.dbSchema

  await sequelize.query(`
   ${getRelaysByServicePerPointJsonFn(schema)}
   ${getSuppliersStakedAndBlocksByPointJsonFn(schema)}
   ${getDataByDelegatorAddressesAndTimesFn(schema)}
   ${getDataByDelegatorAddressesAndBlocksFn(schema)}
  `)

  logger.info(`[createDbFunctions] db functions were saved successfully to schema=${schema}.`)

  await cache.set(functionsCreatedCacheKey, true)
}
