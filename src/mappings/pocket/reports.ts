import { CosmosBlock } from "@subql/types-cosmos";
import { updateBlockReportsFnName } from "../dbFunctions/reports";
import { getDbSchema, getSequelize } from "../utils/db";
import { upsertSuppliersByBlockAndServicesFnName } from "../dbFunctions/reports/suppliers";
import { upsertAppsByBlockAndServicesFnName } from "../dbFunctions/reports/apps";
import { upsertRelaysByBlockAndServicesFnName } from "../dbFunctions/reports/relays";

export async function handleAddBlockReports(block: CosmosBlock): Promise<void> {
  logger.info(`[handleAddBlockReports] Generating block #${block.header.height} reports...`);

  const sequelize = getSequelize('Block')
  const dbSchema = getDbSchema()

  const defaultOptions = {
    // whe need to run it in the subql transaction, otherwise it will not find the block, and the function will do nothing
    transaction: store.context.transaction,
    // to avoid sequelize try to format the results; this function returns a void, so this is not needed
    raw: true,
    // runs directly in the write pool
    useMaster: true,
  }

  // we can run those functions in parallel because they do not modify the same records
  await Promise.all([
    // mutate current block
    sequelize.query(
      `SELECT ${dbSchema}.${updateBlockReportsFnName}(${block.header.height}::bigint);`,
      defaultOptions
    ),
    // insert new records of suppliers by services and block
    sequelize.query(
      `SELECT ${dbSchema}.${upsertSuppliersByBlockAndServicesFnName}(${block.header.height}::bigint);`,
      defaultOptions
    ),
    // insert new records of apps by services and block
    sequelize.query(
      `SELECT ${dbSchema}.${upsertAppsByBlockAndServicesFnName}(${block.header.height}::bigint);`,
      defaultOptions
    ),
    // insert new records of relays by services and block
    sequelize.query(
      `SELECT ${dbSchema}.${upsertRelaysByBlockAndServicesFnName}(${block.header.height}::bigint);`,
      defaultOptions
    ),
  ])
}
