import {
  CosmosEvent,
  CosmosMessage,
} from "@subql/types-cosmos";
import {NativeTransfer} from "../../types";
import {NativeTransferMsg} from "../types";
import {
  attemptHandling,
  messageId,
  stringify,
  unprocessedEventHandler,
} from "../utils";

export async function handleNativeTransfer(event: CosmosEvent): Promise<void> {
  await attemptHandling(event, _handleNativeTransfer, unprocessedEventHandler);
}

async function _handleNativeTransfer(event: CosmosEvent): Promise<void> {
  const msg: CosmosMessage<NativeTransferMsg> = event.msg;
  logger.info(`[handleNativeTransfer] (tx ${msg.tx.hash}): indexing message ${msg.idx + 1} / ${msg.tx.decodedTx.body.messages.length}`);
  logger.debug(`[handleNativeTransfer] (msg.msg): ${stringify(msg.msg, undefined, 2)}`);
  // const timeline = getTimeline(event);

  const fromAddress = msg.msg?.decodedMsg?.fromAddress;
  const toAddress = msg.msg?.decodedMsg?.toAddress;
  const amounts = msg.msg?.decodedMsg?.amount;

  if (!fromAddress || !amounts || !toAddress) {
    logger.warn(`[handleNativeTransfer] (tx ${event.tx.hash}): cannot index event (event.event): ${stringify(event.event, undefined, 2)}`);
    return;
  }

  // workaround: assuming one denomination per transfer message
  const denom = amounts[0].denom;
  const id = messageId(msg);
  const transferEntity = NativeTransfer.create({
    id,
    toAddress,
    fromAddress,
    amounts,
    denom,
    // timeline,
    messageId: id,
    transactionId: msg.tx.hash,
    blockId: msg.block.block.id,
  });

  await transferEntity.save();
}
