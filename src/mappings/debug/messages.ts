import { CosmosMessage } from "@subql/types-cosmos";

export async function debugMessage(msgs: CosmosMessage[]): Promise<void> {
  logger.info(`[debugEvent] Debugging batch messages #${msgs[0].block.header.height} count=${msgs.length}`);
  await Promise.resolve();
}
