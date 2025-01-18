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
  pick,
} from "lodash";
import {
  Block,
  BlockHeader,
  BlockId,
  BlockLastCommit,
  BlockMetadata,
  BlockSupply,
  SupplyDenom,
} from "../types";
import { EventProps } from "../types/models/Event";
import { MessageProps } from "../types/models/Message";
import { TransactionProps } from "../types/models/Transaction";
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
} from "./utils/handlers";
import { messageId } from "./utils/ids";
import { stringify } from "./utils/json";
import {
  getEventKind,
  primitivesFromTx,
} from "./utils/primitives";
import { pubKeyToAddress } from "./utils/pub_key";

export async function handleBlock(block: CosmosBlock): Promise<void> {
  await attemptHandling(block, _handleBlock, _handleBlockError);
}

export async function handleTransactions(txs: CosmosTransaction[]): Promise<void> {
  await store.bulkCreate("Transaction", txs.map(tx => _handleTransaction(tx)));
  // restore attempt handling for batches
  // await attemptHandling(tx, _handleTransaction, _handleTransactionError);
}

export async function handleMessages(msgs: CosmosMessage[]): Promise<void> {
  await store.bulkCreate("Message", msgs.map(msg => _handleMessage(msg)));
  // restore attempt handling for batches
  // await attemptHandling(msg, _handleMessage, _handleMessageError);
}

export async function handleEvents(events: CosmosEvent[]): Promise<void> {
  await store.bulkCreate("Event", events.map(evt => _handleEvent(evt)));
  // restore attempt handling for batches
  // await attemptHandling(event, _handleEvent, unprocessedEventHandler);
}

async function _handleBlock(block: CosmosBlock): Promise<void> {
  logger.info(`[handleBlock] (block.header.height): indexing block ${block.block.header.height}`);
  const start = Date.now();
  await cache.set("startTime", start);

  const { header: { chainId, height, time }, id } = block.block;
  const timestamp = new Date(time.getTime());

  // // TODO: ADD A WAY TO LOAD MORE (PAGINATION)
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
  const processedBlock = processBlockJson(
    // just pick whatever we need to process/convert to avoid waste time on other CosmosBlock properties.
    pick(block, ["blockId", "block", "header"]) as CosmosBlock,
    PREFIX,
  ) as ConvertedBlockJson;

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

function _handleTransaction(tx: CosmosTransaction): TransactionProps {
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

  const feeAmount = !isNil(tx.decodedTx.authInfo.fee) ? tx.decodedTx.authInfo.fee.amount : [];

  return {
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
  };
}

function _handleMessage(msg: CosmosMessage): MessageProps {
  delete msg.msg?.decodedMsg?.wasmByteCode;
  const json = stringify(msg.msg.decodedMsg);
  return {
    id: messageId(msg),
    typeUrl: msg.msg.typeUrl,
    json,
    // timeline,
    transactionId: msg.tx.hash,
    blockId: msg.block.block.id,
  };
}

function _handleEvent(event: CosmosEvent): EventProps {
  let id;
  if (event.tx) {
    id = `${messageId(event)}-${event.idx}`;
  } else {
    id = `${event.block.block.id}-${event.idx}`;
  }

  // NB: sanitize attribute values (may contain non-text characters)
  const sanitize = (value: unknown): string => {
    // avoid stringify a string
    if (isString(value)) return value;
    // otherwise return it as a stringifies object
    return stringify(value);
  };
  const attributes = event.event.attributes.map((attribute) => {
    const { key, value } = attribute;
    return { key: key as string, value: sanitize(value) };
  });

  return {
    id,
    type: event.event.type,
    kind: getEventKind(event),
    attributes,
    transactionId: event.tx?.hash,
    blockId: event.block.block.id,
  };
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function _handleBlockError(err: Error, _: CosmosBlock): Promise<void> {
  // NB: we won't have persisted any related entities yet.
  await trackUnprocessed(err, {});
}

async function _handleTransactionError(err: Error, tx: CosmosTransaction): Promise<void> {
  await trackUnprocessed(err, primitivesFromTx(tx));
}
