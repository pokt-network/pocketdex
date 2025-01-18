import {
  CosmosBlock,
  CosmosEvent,
  CosmosEventKind,
  CosmosMessage,
  CosmosTransaction,
} from "@subql/types-cosmos";
import { EventKind } from "../../types";

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

export function getEventKind(event: CosmosEvent): EventKind {
  let kind: EventKind;

  switch (event.kind) {
    case CosmosEventKind.Message:
      kind = EventKind.Message;
      break;
    case CosmosEventKind.Transaction:
      kind = EventKind.Transaction;
      break;
    case CosmosEventKind.BeginBlock:
      kind = EventKind.BeginBlock;
      break;
    case CosmosEventKind.EndBlock:
      kind = EventKind.EndBlock;
      break;
    case CosmosEventKind.FinalizeBlock:
      kind = EventKind.FinalizeBlock;
      break;
    default:
      throw new Error(`Unknown event kind=${event.kind}`);
  }

  return kind;
}

export function isEventOfMessageKind(event: CosmosEvent): boolean {
  return event.kind === CosmosEventKind.Message;
}
