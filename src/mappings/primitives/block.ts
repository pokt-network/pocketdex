import { CosmosBlock } from "@subql/types-cosmos";
import { pick } from "lodash";
import {
  Block,
  BlockHeader,
  BlockId,
  BlockLastCommit,
  BlockMetadata,
} from "../../types";
import { PREFIX } from "../constants";
import {
  ConvertedBlockJson,
  processBlockJson,
} from "../utils/block_parser";
import { getBlockByteSize } from "../utils/block_size";
import { getBlockId } from "../utils/ids";

export async function handleBlock(block: CosmosBlock): Promise<void> {
  logger.info(`[handleBlock] (block.header.height): indexing block ${block.block.header.height}`);
  const start = Date.now();
  await cache.set("startTime", start);

  const id = getBlockId(block);
  const { header: { chainId, time } } = block.block;
  const timestamp = new Date(time.getTime());

  // CosmosBlock has hash and addresses as Uint8array which is not the expected value on the graphql schema/db model,
  // so here we get a parsed version of its data that match the expected values base on words ending
  const processedBlock = processBlockJson(
    // pick whatever we need to process/convert to avoid wasting time on other CosmosBlock properties.
    pick(block, ["blockId", "block", "header"]) as CosmosBlock,
    PREFIX,
  ) as ConvertedBlockJson;

  const blockMetadata = BlockMetadata.create({
    id,
    blockId: processedBlock.blockId as unknown as BlockId,
    header: processedBlock.header as unknown as BlockHeader,
    lastCommit: processedBlock.block.lastCommit as unknown as BlockLastCommit,
  });

  const size = getBlockByteSize(block);

  const blockEntity = Block.create({
    id,
    chainId,
    hash: block.block.id,
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

  await Promise.all([
    blockEntity.save(),
    blockMetadata.save(),
  ]);
}





