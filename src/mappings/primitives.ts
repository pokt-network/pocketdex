import { sha256 } from "@cosmjs/crypto";
import { toBech32 } from "@cosmjs/encoding";
import {
  CosmosBlock,
  CosmosEvent,
  CosmosMessage,
  CosmosTransaction,
} from "@subql/types-cosmos";
import {
  isEmpty,
  isNil,
  isString,
} from "lodash";
import {
  Block,
  Event,
  EventAttribute,
  Message,
  Transaction,
} from "../types";
import { PREFIX, TxStatus } from "./constants";
import {
  attemptHandling,
  messageId,
  primitivesFromTx,
  stringify,
  trackUnprocessed,
  unprocessedEventHandler,
  unprocessedMsgHandler,
} from "./utils";

export async function handleBlock(block: CosmosBlock): Promise<void> {
  await attemptHandling(block, _handleBlock, _handleBlockError);
}

export async function handleTransaction(tx: CosmosTransaction): Promise<void> {
  await attemptHandling(tx, _handleTransaction, _handleTransactionError);
}

export async function handleMessage(msg: CosmosMessage): Promise<void> {
  await attemptHandling(msg, _handleMessage, unprocessedMsgHandler);
}

export async function handleEvent(event: CosmosEvent): Promise<void> {
  await attemptHandling(event, _handleEvent, unprocessedEventHandler);
}

async function _handleBlock(block: CosmosBlock): Promise<void> {
  logger.info(`[handleBlock] (block.header.height): indexing block ${block.block.header.height}`);

  const { header: { chainId, height, time }, id } = block.block;
  const timestamp = new Date(time.getTime());

  const blockEntity = Block.create({
    id,
    chainId,
    height: BigInt(height),
    timestamp,
  });

  await blockEntity.save();
}

async function _handleTransaction(tx: CosmosTransaction): Promise<void> {
  let status = tx.tx.code === 0 ? TxStatus.Success : TxStatus.Error;

  // const timeline = BigInt((tx.block.block.header.height * 100000) + tx.idx);

  let signerAddress;
  if (isEmpty(tx.decodedTx.authInfo.signerInfos) || isNil(tx.decodedTx.authInfo.signerInfos[0]?.publicKey)) {
    status = TxStatus.Error;
    logger.error(`[handleTransaction] (block ${tx.block.block.header.height}): hash=${tx.hash} missing signerInfos public key`);
  } else {
    // Apply sha256 to the public key to get the address bytes
    const addressBytes = sha256(tx.decodedTx.authInfo.signerInfos[0]?.publicKey?.value).slice(0, 20);
    // Encode the raw address to Bech32
    signerAddress = toBech32(PREFIX, addressBytes);
  }

  logger.debug(`[handleTransaction] (block ${tx.block.block.header.height}): indexing transaction ${tx.idx + 1} / ${tx.block.txs.length} status=${status} signer=${signerAddress}`);
  logger.debug(`[handleTransaction] (tx.decodedTx): ${stringify(tx.decodedTx, undefined, 2)}`);
  if (!isNil(tx.tx.log)) logger.debug(`[handleTransaction] (tx.tx.log): ${tx.tx.log}`);

  const feeAmount = !isNil(tx.decodedTx.authInfo.fee) ? tx.decodedTx.authInfo.fee.amount : [];

  const txEntity = Transaction.create({
    id: tx.hash,
    // timeline,
    blockId: tx.block.block.id,
    gasUsed: tx.tx.gasUsed,
    gasWanted: tx.tx.gasWanted,
    memo: tx.decodedTx.body.memo,
    timeoutHeight: tx.decodedTx.body.timeoutHeight,
    fees: feeAmount,
    log: tx.tx.log || "",
    status,
    signerAddress,
  });
  await txEntity.save();
}

async function _handleMessage(msg: CosmosMessage): Promise<void> {
  logger.debug(`[handleMessage] (tx ${msg.tx.hash}): indexing message ${msg.idx + 1} / ${msg.tx.decodedTx.body.messages.length}`);
  logger.debug(`[handleMessage] (msg.msg): ${stringify(msg.msg, undefined, 2)}`);
  // const timeline = getTimeline(msg);

  delete msg.msg?.decodedMsg?.wasmByteCode;
  const json = stringify(msg.msg.decodedMsg);
  const msgEntity = Message.create({
    id: messageId(msg),
    typeUrl: msg.msg.typeUrl,
    json,
    // timeline,
    transactionId: msg.tx.hash,
    blockId: msg.block.block.id,
  });

  await msgEntity.save();
}

async function _handleEvent(event: CosmosEvent): Promise<void> {
  // TODO: generate an ID that will match on the event.event.type source depending on what type is.
  if (!isEmpty(event.tx?.hash)) {
    logger.debug(`[handleEvent] (tx ${event.tx.hash}): indexing event ${event.idx + 1} / ${event.tx.tx.events.length}`);
  } else {
    logger.debug(`[handleEvent]: indexing event ${event.idx + 1}${event.tx ? ` / ${event.tx.tx.events.length}` : ''}`);
  }

  let id;
  if (event.tx) {
    id = `${messageId(event)}-${event.idx}`;
  } else {
    id = `${event.block.blockId}-${event.idx}`;
  }

  // NB: sanitize attribute values (may contain non-text characters)
  const sanitize = (value: unknown): string => {
    // avoid stringify an string
    if (isString(value)) return value;
    // otherwise return it as a stringifies object
    return stringify(value);
  };
  const attributes = event.event.attributes.map((attribute) => {
    const { key, value } = attribute;
    return { key, value: sanitize(value) };
  });

  logger.debug(`[handleEvent] (event.event): ${stringify(event.event, undefined, 2)}`);
  logger.debug(`[handleEvent] (event.log): ${stringify(event.log, undefined, 2)}`);
  logger.debug(`[handleEvent] (event.attributes): ${stringify(attributes, undefined, 2)}`);

  const eventEntity = Event.create({
    id,
    type: event.event.type,
    // sourceId: event
    transactionId: event.tx?.hash,
    blockId: event.block.block.id,
  });
  await eventEntity.save();

  for (const [i, attribute] of Object.entries(attributes)) {
    const attrId = `${id}-${i}`;
    const { key, value } = attribute;
    await EventAttribute.create({
      id: attrId,
      key: key as string,
      value,
      eventId: eventEntity.id,
    }).save();
  }
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function _handleBlockError(err: Error, _: CosmosBlock): Promise<void> {
  // NB: we won't have persisted any related entities yet.
  await trackUnprocessed(err, {});
}

async function _handleTransactionError(err: Error, tx: CosmosTransaction): Promise<void> {
  await trackUnprocessed(err, primitivesFromTx(tx));
}
