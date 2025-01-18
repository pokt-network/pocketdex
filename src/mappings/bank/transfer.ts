import {
  CosmosEvent,
  CosmosMessage,
  CosmosTransaction,
} from "@subql/types-cosmos";
import { NativeTransfer } from "../../types";
import { NativeTransferMsg } from "../types";
import {
  attemptHandling,
  unprocessedEventHandler,
} from "../utils/handlers";
import {
  getEventId,
  messageId,
} from "../utils/ids";
import { stringify } from "../utils/json";
import { isEventOfMessageKind } from "../utils/primitives";

export async function handleNativeTransfer(event: CosmosEvent): Promise<void> {
  await attemptHandling(event, _handleNativeTransfer, unprocessedEventHandler);
}

async function _handleNativeTransfer(event: CosmosEvent): Promise<void> {
  if (!isEventOfMessageKind(event)) {
    logger.warn(`[handleNativeTransfer] Native transfer event of kind=${event.kind} is not supported. Please use a Message event.`);
    return;
  }

  const msg = event.msg as CosmosMessage<NativeTransferMsg>;
  const tx = event.tx as CosmosTransaction;
  const fromAddress = msg.msg?.decodedMsg?.fromAddress;
  const toAddress = msg.msg?.decodedMsg?.toAddress;
  const amounts = msg.msg?.decodedMsg?.amount;

  const id = getEventId(event);
  const txHash = tx.hash;

  if (!fromAddress || !amounts || !toAddress) {
    logger.warn(`[handleNativeTransfer] (block=${event.block.header.height} tx=${tx.hash} event=${event.idx} kind=${event.kind}): cannot index event (event.event): ${stringify(event.event, undefined, 2)}`);
    return;
  }

  // workaround: assuming one denomination per transfer message
  const denom = amounts[0].denom;
  const transferEntity = NativeTransfer.create({
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
    blockId: event.block.block.id,
  });

  await transferEntity.save();
}
