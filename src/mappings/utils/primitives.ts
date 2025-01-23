import {
  CosmosEvent,
  CosmosEventKind,
} from "@subql/types-cosmos";
import { EventKind } from "../../types";

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

export function isEventOfTransactionKind(event: CosmosEvent): boolean {
  return event.kind === CosmosEventKind.Transaction;
}

export function isEventOfMessageOrTransactionKind(event: CosmosEvent): boolean {
  return isEventOfMessageKind(event) || isEventOfTransactionKind(event);
}

export function isEventOfBlockKind(event: CosmosEvent): boolean {
  return event.kind === CosmosEventKind.BeginBlock || event.kind === CosmosEventKind.EndBlock || event.kind === CosmosEventKind.FinalizeBlock;
}

// on block 1, all the events at finalizeBlock, for example,
// have index: false and a lot of values that do not make sense.
// we need to ask poktroll devs about this, until that we will keep this
export function getNonFirstBlockEvents(events: Array<CosmosEvent>): Array<CosmosEvent> {
  const height = events[0].block.block.header.height;
  // on block 1, all the events at finalizeBlock, for example,
  // have index: false and a lot of values that do not make sense.
  return height > 1 ? events : events.filter(evt => isEventOfMessageOrTransactionKind(evt));
}
