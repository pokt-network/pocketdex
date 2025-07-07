import { CosmosBlock } from "@subql/types-cosmos";
import { updateBlockReportsFnName } from "../dbFunctions/reports";
import { getDbSchema, getSequelize } from "../utils/db";

export async function handleAddBlockReports(block: CosmosBlock): Promise<void> {
  logger.info(`[handleAddBlockReports] Generating block #${block.header.height} reports...`);

  const sequelize = getSequelize('Block')
  const dbSchema = getDbSchema()

  const query = `SELECT ${dbSchema}.${updateBlockReportsFnName}(${block.header.height}::bigint)`

  await sequelize.query(
    query,
    {
      // whe need to run it in the subql transaction, otherwise it will not find the block, and the function will do nothing
      transaction: store.context.transaction,
      // to avoid sequelize try to format the results; this function returns a void, so this is not needed
      raw: true,
      // runs directly in the write pool
      useMaster: true,
    }
  );
}
