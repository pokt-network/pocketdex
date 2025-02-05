import type {
  Coin,
  CosmosBlock,
} from "@subql/types-cosmos";
import type { QueryTotalSupplyResponse } from "cosmjs-types/cosmos/bank/v1beta1/query";
import {
  BlockSupply,
  Supply,
  SupplyDenom,
} from "../../types";
import { BlockSupplyProps } from "../../types/models/BlockSupply";
import { fetchPaginatedRecords } from "../utils/db";
import { getBlockId } from "../utils/ids";
import { stringify } from "../utils/json";

export const getSupplyId = function(denom: string, height: number): string {
  return `${denom}@${height}`;
};

export const getSupplyRecord = function(supply: Coin, block: CosmosBlock): Supply {
  return Supply.create({
    id: getSupplyId(supply.denom, block.header.height),
    denom: supply.denom,
    amount: BigInt(supply.amount),
  });
};

export async function queryTotalSupply(): Promise<Coin[]> {
  const finalSupply: Coin[] = [];
  let paginationKey: Uint8Array | undefined;

  try {
    // Here we force the use of a private property, breaking TypeScript limitation, due to the need of call a total supply
    // rpc query of cosmosjs that is not exposed on the implemented client by SubQuery team.
    // To avoid this, we need to move to implement our own rpc client and also use `unsafe` parameter which I prefer to avoid.
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    const queryClient = api.forceGetQueryClient();

    // Initial call to get the first set of results
    const initialResponse: QueryTotalSupplyResponse = await queryClient.bank.totalSupply() as unknown as QueryTotalSupplyResponse;
    logger.debug(`[handleTotalSupply]: initialResponse=${stringify(initialResponse, undefined, 2)}`);
    finalSupply.push(...initialResponse.supply);
    paginationKey = initialResponse.pagination?.nextKey;

    // Continue fetching if there is a nextKey
    while (paginationKey && paginationKey.length > 0) {
      logger.debug(`[handleTotalSupply]: loading more supply pages pagination.nextKey=${stringify(paginationKey, undefined, 2)}`);
      const response = await queryClient.bank.totalSupply(paginationKey);
      finalSupply.push(...response.supply);
      paginationKey = response.pagination?.nextKey;
    }
    logger.debug(`[handleTotalSupply]: all_total_supply=${stringify(finalSupply, undefined, 2)}`);
  } catch (error) {
    logger.error(`[handleTotalSupply] errored: ${error}`);
  }

  return finalSupply;
}

export async function fetchAllSupplyDenom(): Promise<SupplyDenom[]> {
  return fetchPaginatedRecords({
    fetchFn: (options) => SupplyDenom.getByFields([], options),
    initialOptions: {
      // add order and direction to speedup if there is a way
      // orderBy: 'id', // Order results by ID
      // orderDirection: 'ASC', // Ascending order
    },
  });
}

// handleSupply, referenced in project.ts, handles supply information from block
export async function handleSupply(block: CosmosBlock): Promise<void> {
  const supplyDenom = await fetchAllSupplyDenom();
  const supplyIdHeight = block.header.height === 1 ? block.header.height : block.header.height - 1;

  const blockSuppliesMap: Map<string, BlockSupplyProps> = new Map();

  if (block.header.height > 1) {
    // on any block after genesis, we need to look up for the previous BlockSupply to copy the supply id of the
    // right one; then the claim/proof settlement or ibc txs will update to the right supply id if a new one
    // is created for this denom@block
    for (const supplyDenomItem of supplyDenom) {
      const blockSupply = await BlockSupply.get(
        getSupplyId(supplyDenomItem.id, supplyIdHeight),
      );
      if (!blockSupply) {
        logger.warn(`[handleBlock] (block.header.height): missing block supply for ${supplyDenomItem.id} at height ${supplyIdHeight}`);
        continue;
      }
      const blockSupplyId = getSupplyId(supplyDenomItem.id, block.header.height);
      const blockSupplyProps = {
        id: blockSupplyId,
        blockId: getBlockId(block),
        supplyId: blockSupply.supplyId,
      };
      blockSuppliesMap.set(blockSupplyId, blockSupplyProps);
    }
  } else {
    // create a base record for each supply denomination because is the first block.
    supplyDenom.forEach((supplyDenomItem) => {
      const blockSupplyId = getSupplyId(supplyDenomItem.id, block.header.height);
      const blockSupplyProps = {
        id: blockSupplyId,
        blockId: getBlockId(block),
        supplyId: getSupplyId(supplyDenomItem.id, supplyIdHeight),
      };
      blockSuppliesMap.set(blockSupplyId, blockSupplyProps);
    });
  }

  // TODO: (@jorgecuesta) we should update supply handling with proper msg/event once it is implemented on poktroll
  logger.debug(`[handleSupply] (block.header.height=${block.header.height}) querying total supply...`);
  const totalSupply = await queryTotalSupply();
  if (totalSupply.length === 0) {
    logger.warn(`[handleSupply]: no total supply found`);
    return;
  }

  const promises: Promise<void>[] = [];

  for (const supply of totalSupply) {
    // get the current blockSupply create on block handler to been able to access the assigned previous supply id
    // that will allow us to compare the amount and create a new on if needed.
    const blockSupplyId = getSupplyId(supply.denom, block.header.height);
    const latestBlockSupply = blockSuppliesMap.get(blockSupplyId);
    if (!latestBlockSupply) {
      logger.warn(`[handleSupply]: no BlockSupply found id=${blockSupplyId}`);
      continue;
    }

    const latestDenomSupply = await Supply.get(latestBlockSupply.supplyId);
    if (!latestDenomSupply) {
      logger.warn(`[handleSupply]: no total supply found id=${latestBlockSupply.supplyId}`);
      continue;
    }

    if (latestDenomSupply.amount.toString() !== supply.amount) {
      const newSupply = getSupplyRecord(supply, block);
      latestBlockSupply.supplyId = newSupply.id;
      promises.push(newSupply.save());
    }
  }

  promises.push(store.bulkCreate("BlockSupply", Array.from(blockSuppliesMap.values())));

  // until we refactor this to msg OR/AND an event, at least try to parallelize us as much as possible.
  await Promise.all(promises);
}
