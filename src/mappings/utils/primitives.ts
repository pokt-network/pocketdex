import {
  CosmosBlock,
  CosmosEvent,
  CosmosMessage,
  CosmosTransaction,
} from "@subql/types-cosmos";

export type Primitive = CosmosEvent | CosmosMessage | CosmosTransaction | CosmosBlock;

export interface Primitives {
  event?: CosmosEvent;
  msg?: CosmosMessage;
  tx?: CosmosTransaction;
  block?: CosmosBlock;
}

export function primitivesFromTx(tx: CosmosTransaction): Primitives {
  return { block: tx.block, tx: tx };
}

export function primitivesFromMsg(msg: CosmosMessage): Primitives {
  return { block: msg.block, tx: msg.tx };
}

export function primitivesFromEvent(event: CosmosEvent): Primitives {
  return { block: event.block, tx: event.tx };
}
