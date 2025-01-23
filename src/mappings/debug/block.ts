import { CosmosBlock } from "@subql/types-cosmos";

export async function debugBlock(block: CosmosBlock): Promise<void> {
  logger.info(`[debugBlock] Debugging block #${block.block.header.height}`);
  await Promise.resolve();
}
