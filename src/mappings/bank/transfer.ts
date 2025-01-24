import {
  CosmosMessage,
  CosmosTransaction,
} from "@subql/types-cosmos";
import { NativeTransferProps } from "../../types/models/NativeTransfer";
import { NativeTransferMsg } from "../types";
import {
  getBlockIdAsString,
  messageId,
} from "../utils/ids";
import { getTxStatus } from "../utils/primitives";

function _handleNativeTransfer(msg: CosmosMessage<NativeTransferMsg>): NativeTransferProps {
  const tx = msg.tx as CosmosTransaction;
  const fromAddress = msg.msg?.decodedMsg?.fromAddress;
  const toAddress = msg.msg?.decodedMsg?.toAddress;
  const amounts = msg.msg?.decodedMsg?.amount;

  const id = messageId(msg);
  const txHash = tx.hash;

  if (!fromAddress || !amounts || !toAddress) {
    throw new Error(`[handleNativeTransfer] (block=${msg.block.header.height} tx=${tx.hash} msg=${id}): cannot index msg`);
  }

  // workaround: assuming one denomination per transfer message
  const denom = amounts[0].denom;
  return {
    id,
    senderId: toAddress,
    recipientId: fromAddress,
    amounts,
    denom,
    status: getTxStatus(tx),
    eventId: id,
    // on event kind message the message is guaranteed
    messageId: messageId(msg),
    // on event kind message or transaction, the transaction is guaranteed
    transactionId: txHash,
    blockId: getBlockIdAsString(msg.block),
  };
}

// handleNativeTransfer, referenced in project.ts, handles native transfer events
export async function handleNativeTransfer(messages: CosmosMessage[]): Promise<void> {
  await store.bulkCreate("NativeTransfer", messages.map(_handleNativeTransfer));
}
