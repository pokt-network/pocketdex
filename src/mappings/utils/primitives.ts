import {
  CosmosEvent,
  CosmosEventKind,
  CosmosMessage,
  CosmosTransaction,
} from "@subql/types-cosmos";
import {
  EventKind,
  TxStatus,
} from "../../types";

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

export function hasValidAmountAttribute(event: CosmosEvent): boolean {
  // any event that has an amount but the amount is empty will return false
  return !event.event.attributes.some(attribute => attribute.key === "amount" && !attribute.value);
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
  return event.kind === CosmosEventKind.BeginBlock || event.kind === CosmosEventKind.EndBlock || isEventOfFinalizedBlockKind(event);
}

export function isEventOfFinalizedBlockKind(event: CosmosEvent): boolean {
  return event.kind === CosmosEventKind.FinalizeBlock;
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

export function isMsgValidatorRelated(typeUrl: string): boolean {
  switch (typeUrl) {
    case "/cosmos.staking.v1beta1.MsgCreateValidator":
    case "/cosmos.staking.v1beta1.MsgEditValidator":
    case "/cosmos.staking.v1beta1.MsgDelegate": // todo: ask bryan about the typeUrl below this (including this one):
    case "/cosmos.staking.v1beta1.MsgUndelegate":
    case "/cosmos.staking.v1beta1.MsgBeginRedelegate":
    case "/cosmos.slashing.v1beta1.MsgUnjail":
    case "/cosmos.distribution.v1beta1.MsgWithdrawValidatorCommission":
    case "/cosmos.distribution.v1beta1.MsgSetWithdrawAddress":
      return true;
    default:
      return false;
  }
}

export function getTxStatus(tx: CosmosTransaction): TxStatus {
  return tx.tx.code === 0 ? TxStatus.Success : TxStatus.Error;
}

// Here we are filtering the events by the transaction code, including as success block events
export function filterEventsByTxStatus(events: Array<CosmosEvent>): {
  success: Array<CosmosEvent>;
  error: Array<CosmosEvent>;
} {
  const success: Array<CosmosEvent> = [];
  const error: Array<CosmosEvent> = [];

  for (const event of events) {
    if (!event.tx || event.tx.tx.code === 0) {
      success.push(event);
    } else {
      error.push(event);
    }
  }

  return { success, error };
}

// Here we are filtering the messages by the transaction code
export function filterMsgByTxStatus(messages: Array<CosmosMessage>): {
  success: Array<CosmosMessage>;
  error: Array<CosmosMessage>;
} {
  const success: Array<CosmosMessage> = [];
  const error: Array<CosmosMessage> = [];

  for (const message of messages) {
    if (message.tx.tx.code === 0) {
      success.push(message);
    } else {
      error.push(message);
    }
  }

  return { success, error };
}
