import { CosmosEvent } from "@subql/types-cosmos";

export async function debugEvent(event: CosmosEvent[]): Promise<void> {
  logger.info(`[debugEvent] Debugging batch events #${event[0].block.header.height} kind=${event[0].kind} count=${event.length}`);
  await Promise.resolve();
}
