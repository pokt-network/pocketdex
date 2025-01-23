import {
  CosmosEvent,
  CosmosMessage,
  CosmosTransaction,
} from "@subql/types-cosmos";
import { NativeTransferProps } from "../../types/models/NativeTransfer";
import { NativeTransferMsg } from "../types";
import {
  getBlockIdAsString,
  getEventId,
  messageId,
} from "../utils/ids";
import { stringify } from "../utils/json";
import { isEventOfMessageKind } from "../utils/primitives";

function _handleNativeTransfer(event: CosmosEvent): NativeTransferProps {
  if (!isEventOfMessageKind(event) || event.msg?.msg?.typeUrl !== "/cosmos.bank.v1beta1.MsgSend") {
    throw new Error(`[handleNativeTransfer] Native transfer event of kind=${event.kind} type=${event.msg?.msg?.typeUrl} is not supported. Please use a Message event of type /cosmos.bank.v1beta1.MsgSend`);
  }

  const msg = event.msg as CosmosMessage<NativeTransferMsg>;
  const tx = event.tx as CosmosTransaction;
  const fromAddress = msg.msg?.decodedMsg?.fromAddress;
  const toAddress = msg.msg?.decodedMsg?.toAddress;
  const amounts = msg.msg?.decodedMsg?.amount;

  const id = getEventId(event);
  const txHash = tx.hash;

  if (!fromAddress || !amounts || !toAddress) {
    throw new Error(`[handleNativeTransfer] (block=${event.block.header.height} tx=${tx.hash} event=${event.idx} kind=${event.kind}): cannot index event (event.event): ${stringify(event.event, undefined, 2)}`);
  }

  // workaround: assuming one denomination per transfer message
  const denom = amounts[0].denom;
  return {
    id,
    senderId: toAddress,
    recipientId: fromAddress,
    amounts,
    denom,
    eventId: id,
    // on event kind message the message is guaranteed
    messageId: messageId(msg),
    // on event kind message or transaction, the transaction is guaranteed
    transactionId: txHash,
    blockId: getBlockIdAsString(event.block),
  };
}

// handleNativeTransfer, referenced in project.ts, handles native transfer events
export async function handleNativeTransfer(events: CosmosEvent[]): Promise<void> {
  await store.bulkCreate("NativeTransfer", events.map(_handleNativeTransfer));
}
