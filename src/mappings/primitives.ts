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
  BlockHeader,
  BlockId,
  BlockLastCommit,
  BlockMetadata,
  BlockSupply,
  Event,
  EventAttribute,
  Message,
  SupplyDenom,
  Transaction,
} from "../types";
import {
  _handleSupply,
  getSupplyId,
} from "./bank/supply";
import {
  PREFIX,
  TxStatus,
} from "./constants";
import {
  ConvertedBlockJson,
  processBlockJson,
} from "./utils/block_parser";
import { getBlockByteSize } from "./utils/block_size";
import {
  attemptHandling,
  trackUnprocessed,
  unprocessedEventHandler,
  unprocessedMsgHandler,
} from "./utils/handlers";
import { messageId } from "./utils/ids";
import { stringify } from "./utils/json";
import { primitivesFromTx } from "./utils/primitives";
import { pubKeyToAddress } from "./utils/pub_key";
import { Entity } from "@subql/types-core";

export async function handleBlock(block: CosmosBlock): Promise<void> {
  if (block.block.header.height === 50134) {
    throw new Error("test");
  }
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

function isLastTransaction(tx: CosmosTransaction): boolean {
  return tx.idx === tx.block.txs.length - 1;
}

function isLastMessage(msg: CosmosMessage): boolean {
  return msg.idx === msg.tx.decodedTx.body.messages.length - 1;
}

function isLastTransactionEvent(event: CosmosEvent, totalTxEvents: number): boolean {
  // If idx is within the range of transaction-produced events, it's still transactional
  return event.idx + 1 === totalTxEvents;
}

function isLastEvent(event: CosmosEvent): boolean {
  logger.info(`[isLastEvent] Checking if is last event event.idx=${event.idx} event.tx.tx.events.length=${event.msg?.tx?.tx?.events?.length}`);
  // If `msg` is missing, the event order cannot rely on messages
  if (!event.msg) {
    logger.warn(`[isLastEvent] Cannot determine last event as 'msg' is null.`);
    return false;
  }

  // Transactional event: Safe to check the message event index
  if (!event.msg.tx) {
    logger.warn(`[isLastEvent] Cannot determine last event as 'msg.tx' is null.`);
    return false; // No events in this message to compare against
  }

  // Valid event: Compare index to the length of events for this message
  return event.idx === event.msg.tx.tx.events.length - 1;
}

export async function handleLastMessage(msg: CosmosMessage): Promise<void> {
  if (isLastMessage(msg) && isLastTransaction(msg.tx)) {
    logger.info(`Last message (${msg.msg.typeUrl}) in block ${msg.tx.block.header.height}`);
    await cache.set("isLastMessage", true);
  }
}

export async function handleLastEvent(event: CosmosEvent): Promise<void> {
  // we are assuming that event handler is called after messages one, like the block is first, then txs, and then
  // messages and then events.
  try {

    // 1. Retrieve the total number of events from the cache
    const totalEvents = await cache.get(`block:${event.block.header.height}:totalEvents`);
    logger.info(`[handleLastEvent] Processing event ${event.idx} of ${totalEvents} in block ${event.block.header.height}`);

    if (!totalEvents) {
      logger.error(`[handleLastEvent] Total events cache missing for block ${event.block.header.height}.`);
      return;
    }

    // 2. Check if this is a block-level event
    if (!event.msg) {
      logger.info(`[handleLastEvent] Block-level event detected: "${event.event?.type || "unknown"}".`);

      // Compare idx against total events to determine if this is the last block-level event
      if (event.idx + 1 === totalEvents) {
        logger.info(`[handleLastEvent] Last block-level event "${event.event?.type || "unknown"}".`);
        await cache.set("isLastEvent", true); // Mark the last event
      }
      return;
    }

    // 3. Transactional event: Ensure required structures exist
    const { msg } = event;
    if (!msg.tx) {
      logger.warn(`[handleLastEvent] Event (${event.event?.type || "unknown"}) has no associated transaction.`);
      return;
    }

    // 4. Handle transactional events (if applicable)
    const block = msg.tx.block;
    if (event.idx + 1 === totalEvents) {
      logger.info(`[handleLastEvent] Last transactional event "${event.event?.type || "unknown"}" in block ${block.header.height}.`);
      await cache.set("isLastEvent", true); // Mark the last event
    }
  } catch (error) {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    logger.error(`[handleLastEvent] Error processing event: ${error.message}`, error);
  }
}

async function readDocsAndBulkWrite(kind: string): Promise<void> {
  const docs = await cache.get(kind) as Array<Entity> | null | undefined;
  if (isNil(docs)) {
    logger.info(`[readDocsAndBulkWrite] There are no ${kind} data to process.`);
    return;
  }
  await store.bulkCreate(kind, docs);
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
export async function handleFinalizeBlock(evt: CosmosEvent): Promise<void> {
  const block = evt.block.block;
  try {
    const isLastEvent = (await cache.get("isLastEvent")) ?? false; // Default to false
    const isLastMessage = (await cache.get("isLastMessage")) ?? false;
    const startTime = (await cache.get("startTime")) ?? Date.now();
    const totalEvents = await cache.get(`block:${evt.block.header.height}:totalEvents`);

    logger.info(`%%%%%%%%%%%%%%%% ${block.header.height} isLastEvent=${isLastEvent} isLastMessage=${isLastMessage} isLastEvent=${isLastEvent} totalEvents=${totalEvents}`);

    // Identify a truly empty block (no transactions, no flags set)
    const isEmptyBlock = block.txs.length === 0 && !isLastEvent && !isLastMessage;

    if (isEmptyBlock) {
      // Finalize an empty block (e.g., save metadata or log the block as empty)
      // ...

      const endTime = Date.now();
      logger.info(`################# [handleFinalizeBlock] Empty block ${block.header.height} finalized in ${endTime - startTime}ms.`);
      return;
    }

    // Finalize non-empty blocks normally
    if (isLastEvent && isLastMessage) {
      logger.info(`@@@@@@@@@@@@@@@@@ [handleFinalizeBlock] Finalizing block ${block.header.height} with activity...`);

      // Perform finalization logic
      // bulk write all the docs in parallel (this should optimize the times)
      await Promise.all([
        readDocsAndBulkWrite("MsgCreateClaim"),
        readDocsAndBulkWrite("Relay"),
      ]);

      const end = Date.now();
      logger.info(`[handleFinalizeBlock] @@@@@@@@@@@@@@@@@ Non-empty block ${block.header.height} processed in ${end - startTime}ms.`);
    }
  } catch (error) {
    logger.error(`[handleFinalizeBlock] &&&&&&&&&&&&&& Error during finalization of block ${block.header.height}: ${error}`);
    throw error;
  }
}


async function _handleBlock(block: CosmosBlock): Promise<void> {
  logger.info(`[handleBlock] (block.header.height): indexing block ${block.block.header.height}`);
  const start = Date.now();
  await cache.set("startTime", start);
  // prevent them to be true from previous block
  await cache.set("isLastEvent", false);
  await cache.set("isLastMessage", false);

  const { header: { chainId, height, time }, id } = block.block;
  const timestamp = new Date(time.getTime());

  const totalTxEvents = block.txs.reduce((count, tx) => count + (tx.events?.length || 0), 0);
  await cache.set(`block:${block.header.height}:totalEvents`, totalTxEvents);

  // TODO: ADD A WAY TO LOAD MORE (PAGINATION)
  const supplyDenom = await SupplyDenom.getByFields([], { limit: 100 });
  const supplyIdHeight = block.header.height === 1 ? block.header.height : block.header.height - 1;

  const blockSupplies: BlockSupply[] = [];

  // TODO: (@jorgecuesta) we should move blockSupply and block metadata into separated functions for readability
  if (block.header.height > 1) {
    // on any block after genesis, we need to look up for the previous BlockSupply to copy the supply id of the
    // right one, then the claim/proof settlement or ibc txs will update to the right supply id if a new one
    // is created for this denom@block
    for (const supplyDenomItem of supplyDenom) {
      const blockSupply = await BlockSupply.get(getSupplyId(supplyDenomItem.id, supplyIdHeight));
      if (!blockSupply) {
        logger.warn(`[handleBlock] (block.header.height): missing block supply for ${supplyDenomItem.id} at height ${supplyIdHeight}`);
        continue;
      }
      blockSupplies.push(BlockSupply.create({
        id: getSupplyId(supplyDenomItem.id, block.header.height),
        blockId: block.block.id,
        supplyId: blockSupply.supplyId,
      }));
    }
    // create all the entries
    await store.bulkCreate("BlockSupply", blockSupplies);
  } else {
    // create a base record for each supply denomination because is the first block.
    await store.bulkCreate("BlockSupply", supplyDenom.map((supplyDenomItem) => {
      return {
        id: getSupplyId(supplyDenomItem.id, block.block.header.height),
        blockId: block.block.id,
        supplyId: getSupplyId(supplyDenomItem.id, supplyIdHeight),
      };
    }));
  }

  // CosmosBlock has hash and addresses as Uint8array which is not the expected value on the graphql schema/db model,
  // so here we get a parsed version of its data that match the expected values base on words ending
  const processedBlock = processBlockJson(block, PREFIX) as ConvertedBlockJson;

  const blockMetadata = BlockMetadata.create({
    id,
    blockId: processedBlock.blockId as unknown as BlockId,
    header: processedBlock.header as unknown as BlockHeader,
    lastCommit: processedBlock.block.lastCommit as unknown as BlockLastCommit,
  });

  await blockMetadata.save();

  const size = getBlockByteSize(block);

  const blockEntity = Block.create({
    id,
    chainId,
    height: BigInt(height),
    timestamp,
    // this is the HEX address that comes on the block
    proposerAddress: processedBlock.header.proposerAddress as string,
    size,
    metadataId: id,
    stakedSuppliers: 0,
    totalComputedUnits: BigInt(0),
    totalRelays: BigInt(0),
    failedTxs: 0,
    successfulTxs: 0,
    totalTxs: 0,
    stakedSuppliersTokens: BigInt(0),
    unstakingSuppliers: 0,
    unstakingSuppliersTokens: BigInt(0),
    timeToBlock: 0,
    unstakedSuppliers: 0,
    unstakedSuppliersTokens: BigInt(0),
    stakedApps: 0,
    stakedAppsTokens: BigInt(0),
    unstakingApps: 0,
    unstakingAppsTokens: BigInt(0),
    stakedGateways: 0,
    stakedGatewaysTokens: BigInt(0),
    unstakedGateways: 0,
    unstakedGatewaysTokens: BigInt(0),
    unstakedAppsTokens: BigInt(0),
    unstakedApps: 0,
  });

  await blockEntity.save();

  // We need to track the supply on every block, and this is the way we can do with the RPC, but on a future
  // it will be replaced by handling the claim/proof settle event.
  await _handleSupply(block);
}


async function _handleTransaction(tx: CosmosTransaction): Promise<void> {
  let status = tx.tx.code === 0 ? TxStatus.Success : TxStatus.Error;

  let signerAddress;
  if (isEmpty(tx.decodedTx.authInfo.signerInfos) || isNil(tx.decodedTx.authInfo.signerInfos[0]?.publicKey)) {
    status = TxStatus.Error;
    logger.error(`[handleTransaction] (block ${tx.block.block.header.height}): hash=${tx.hash} missing signerInfos public key`);
  } else {
    signerAddress = pubKeyToAddress(
      tx.decodedTx.authInfo.signerInfos[0]?.publicKey.typeUrl,
      tx.decodedTx.authInfo.signerInfos[0]?.publicKey.value,
      PREFIX,
    );
  }

  // logger.debug(`[handleTransaction] (block ${tx.block.block.header.height}): indexing transaction ${tx.idx + 1} / ${tx.block.txs.length} status=${status} signer=${signerAddress}`);
  // logger.debug(`[handleTransaction] (tx.decodedTx): ${stringify(tx.decodedTx, undefined, 2)}`);
  // if (!isNil(tx.tx.log)) // logger.debug(`[handleTransaction] (tx.tx.log): ${tx.tx.log}`);

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
    code: tx.tx.code,
    codespace: tx.tx.codespace,
  });
  await txEntity.save();
}

async function _handleMessage(msg: CosmosMessage): Promise<void> {
  // logger.debug(`[handleMessage] (tx ${msg.tx.hash}): indexing message ${msg.idx + 1} / ${msg.tx.decodedTx.body.messages.length}`);
  // logger.debug(`[handleMessage] (msg.msg): ${stringify(msg.msg, undefined, 2)}`);
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
    // logger.debug(`[handleEvent] (tx ${event.tx.hash}): indexing event ${event.idx + 1} / ${event.tx.tx.events.length}`);
  } else {
    // logger.debug(`[handleEvent]: indexing event ${event.idx + 1}${event.tx ? ` / ${event.tx.tx.events.length}` : ""}`);
  }

  let id;
  if (event.tx) {
    id = `${messageId(event)}-${event.idx}`;
  } else {
    id = `${event.block.block.id}-${event.idx}`;
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

  // logger.debug(`[handleEvent] (event.event): ${stringify(event.event, undefined, 2)}`);
  // logger.debug(`[handleEvent] (event.log): ${stringify(event.log, undefined, 2)}`);
  // logger.debug(`[handleEvent] (event.attributes): ${stringify(attributes, undefined, 2)}`);

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
