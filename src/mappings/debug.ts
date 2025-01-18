import {
  CosmosBlock,
  CosmosEvent,
  CosmosMessage,
  CosmosTransaction,
} from "@subql/types-cosmos";

// the handlers below are to use as you need to debug, log, inspect or whatever you need.
// preventing the need to modify the project structure or any other handler.

export async function debugBlock(block: CosmosBlock): Promise<void> {
  logger.info(`[debugBlock] Debugging block #${block.block.header.height}`);
  await Promise.resolve();
}

export async function debugTransaction(txs: CosmosTransaction[]): Promise<void> {
  logger.info(`[debugEvent] Debugging batch transactions #${txs[0].block.header.height} count=${txs.length}`);
  await Promise.resolve();
}

export async function debugMessage(msgs: CosmosMessage[]): Promise<void> {
  logger.info(`[debugEvent] Debugging batch messages #${msgs[0].block.header.height} count=${msgs.length}`);
  await Promise.resolve();
}

export async function debugEvent(event: CosmosEvent[]): Promise<void> {
  logger.info(`[debugEvent] Debugging batch events #${event[0].block.header.height} kind=${event[0].kind} count=${event.length}`);
  await Promise.resolve();
}


