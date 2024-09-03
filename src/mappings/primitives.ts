import {createHash} from "crypto";
import {toBech32} from "@cosmjs/encoding";
import {
  CosmosBlock,
  CosmosEvent,
  CosmosMessage,
  CosmosTransaction,
} from "@subql/types-cosmos";
import {
  isEmpty,
  isString,
} from "lodash";
import {
  Block,
  Event,
  EventAttribute,
  Message,
  Transaction,
  TxStatus,
} from "../types";
import {
  attemptHandling,
  messageId,
  parseJson,
  primitivesFromMsg,
  primitivesFromTx,
  stringify,
  trackUnprocessed,
  unprocessedEventHandler,
} from "./utils";

export async function handleBlock(block: CosmosBlock): Promise<void> {
  await attemptHandling(block, _handleBlock, _handleBlockError);
}

export async function handleTransaction(tx: CosmosTransaction): Promise<void> {
  await attemptHandling(tx, _handleTransaction, _handleTransactionError);
}

export async function handleMessage(msg: CosmosMessage): Promise<void> {
  await attemptHandling(msg, _handleMessage, _handleMessageError);
}

export async function handleEvent(event: CosmosEvent): Promise<void> {
  await attemptHandling(event, _handleEvent, unprocessedEventHandler);
}

async function _handleBlock(block: CosmosBlock): Promise<void> {
  logger.info(`[handleBlock] (block.header.height): indexing block ${block.block.header.height}`);

  const {header: {chainId, height, time}, id} = block.block;
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
  logger.info(`[handleTransaction] (block ${tx.block.block.header.height}): indexing transaction ${tx.idx + 1} / ${tx.block.txs.length}`);
  logger.debug(`[handleTransaction] (tx.tx.log): ${tx.tx.log}`);

  let status = TxStatus.Error;
  if (tx.tx.log) {
    try {
      parseJson(tx.tx.log);
      status = TxStatus.Success;
    } catch {
      // NB: assume tx failed
    }
  }

  // const timeline = BigInt((tx.block.block.header.height * 100000) + tx.idx);
  const pubKey: Uint8Array | undefined = tx.decodedTx.authInfo.signerInfos[0]?.publicKey?.value;
  let signerAddress;
  if (typeof (pubKey) !== "undefined") {
    // TODO: check key type and handle respectively
    // NB: ripemd160(sha256(pubKey)) only works for secp256k1 keys
    const ripemd160 = createHash("ripemd160");
    const sha256 = createHash("sha256");
    // TODO: understand why!!!
    // NB: pubKey has 2 "extra" bytes at the beginning as compared to the
    // base64-decoded representation/ of the same key when imported to
    // fetchd (`fetchd keys add --recover`) and shown (`fetchd keys show`).
    sha256.update(pubKey.slice(2));
    ripemd160.update(sha256.digest());
    signerAddress = toBech32(PREFIX, ripemd160.digest());
  }

  const feeAmount = typeof (tx.decodedTx.authInfo.fee) !== "undefined" ?
    tx.decodedTx.authInfo.fee.amount : [];

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
  if (msg.tx.hash === "E5F4CAB95F9DF7642E89067FA3F736F37FA8DC06CAD0D40AC1BD16525836387C") {
    try {
      logger.info(`[handleMessage] (try) ${stringify(msg)}`);
    } catch (e) {
      logger.error(e, `[handleMessage] (catch) ${msg}`);
    }
  }
  logger.info(`[handleMessage] (tx ${msg.tx.hash}): indexing message ${msg.idx + 1} / ${msg.tx.decodedTx.body.messages.length}`);
  logger.debug(`[handleMessage] (msg.msg): ${stringify(msg.msg)}`);
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
  if (!isEmpty(event.tx.hash)) {
    logger.info(`[handleEvent] (tx ${event.tx.hash}): indexing event ${event.idx + 1} / ${event.tx.tx.events.length}`);
  } else {
    logger.info(`[handleEvent]: indexing event ${event.idx + 1} / ${event.tx.tx.events.length}`);
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
    const {key, value} = attribute;
    return {key, value: sanitize(value)};
  });

  logger.debug(`[handleEvent] (event.event): ${stringify(event.event, undefined, 2)}`);
  logger.debug(`[handleEvent] (event.log): ${stringify(event.log, undefined, 2)}`);
  logger.debug(`[handleEvent] (event.attributes): ${stringify(attributes, undefined, 2)}`);

  const eventEntity = Event.create({
    id,
    type: event.event.type,
    // sourceId: event
    // transactionId: event.tx.hash,
    blockId: event.block.block.id,
  });
  await eventEntity.save();

  for (const [i, attribute] of Object.entries(attributes)) {
    const attrId = `${id}-${i}`;
    const {key, value} = attribute;
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

async function _handleMessageError(err: Error, msg: CosmosMessage): Promise<void> {
  await trackUnprocessed(err, primitivesFromMsg(msg));
}
