import { CosmosTransaction } from "@subql/types-cosmos";

export async function debugTransaction(txs: CosmosTransaction[]): Promise<void> {
  logger.info(`[debugEvent] Debugging batch transactions #${txs[0].block.header.height} count=${txs.length}`);
  await Promise.resolve();
}
