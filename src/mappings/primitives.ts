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
  BlockHeader,
  BlockId,
  BlockLastCommit,
  BlockMetadata,
  BlockSupply,
  SupplyDenom,
  Event,
  EventAttribute,
  Message,
  Transaction,
} from "../types";
import {
  _handleSupply,
  getSupplyId,
} from "./bank/supply";
import { PREFIX, TxStatus,
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

  const supplyDenom = await SupplyDenom.getByFields([], {});
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
    code: tx.tx.code,
    codespace: tx.tx.codespace,
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
    logger.debug(`[handleEvent]: indexing event ${event.idx + 1}${event.tx ? ` / ${event.tx.tx.events.length}` : ""}`);
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
