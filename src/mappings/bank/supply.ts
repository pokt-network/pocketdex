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
import getQueryClient from "../utils/query_client";

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

export async function queryTotalSupply(block: CosmosBlock): Promise<Coin[]> {
  logger.debug(`[handleSupply] querying total supply`);
  const finalSupply: Coin[] = [];
  let paginationKey: Uint8Array | undefined;

  // Here we force the use of a private property, breaking TypeScript limitation, due to the need of call a total supply
  // rpc query of cosmosjs that is not exposed on the implemented client by SubQuery team.
  // To avoid this, we need to move to implement our own rpc client and also use `unsafe` parameter which I prefer to avoid.
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  const queryClient = getQueryClient(block.header.height);

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

  logger.debug(`[handleTotalSupply]: total supply query done!`);

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
  const [supplyDenoms, totalSupply] = await Promise.all([
    fetchAllSupplyDenom(),
    // TODO: (@jorgecuesta) we should update supply handling with proper msg/event once it is implemented on pocket
    queryTotalSupply(block)
  ]);

  const denominationsSaved = supplyDenoms.map(supplyDenom => supplyDenom.id)

  // here we need to create the denoms that are not saved in the database
  if (totalSupply.some(supply => !denominationsSaved.includes(supply.denom))) {
    const supplyDenomsToSave = totalSupply.filter(supply => !denominationsSaved.includes(supply.denom)).map(supply => SupplyDenom.create({id: supply.denom}));

    await store.bulkCreate(
      "SupplyDenom",
      supplyDenomsToSave
    );

    supplyDenoms.push(...supplyDenomsToSave);
  }

  const supplyIdHeight = block.header.height === 1 ? block.header.height : block.header.height - 1;

  const blockSuppliesMap: Map<string, BlockSupplyProps> = new Map();

  for (const supplyDenom of supplyDenoms) {
    const blockSupply = await BlockSupply.get(
      getSupplyId(supplyDenom.id, supplyIdHeight),
    );

    const blockSupplyId = getSupplyId(supplyDenom.id, block.header.height);

    // normally this should not be null,
    // but if you start syncing from a greater height than genesis, probably will not exist
    const supplyId = blockSupply ? blockSupply.supplyId : blockSupplyId;

    const blockSupplyProps = {
      id: blockSupplyId,
      blockId: getBlockId(block),
      supplyId,
    };
    blockSuppliesMap.set(blockSupplyId, blockSupplyProps);
  }

  if (totalSupply.length === 0) {
    throw new Error(`[handleSupply]: query.totalSupply returned 0 records, block.header.height=${block.header.height}`);
  }

  const promises: Promise<void>[] = [];

  for (const supply of totalSupply) {
    // get the current blockSupply create on block handler to been able to access the assigned previous supply id
    // that will allow us to compare the amount and create a new on if needed.
    const blockSupplyId = getSupplyId(supply.denom, block.header.height);
    const latestBlockSupply = blockSuppliesMap.get(blockSupplyId);
    if (!latestBlockSupply) {
      throw new Error(`[handleSupply]: BlockSupply not found for id=${blockSupplyId}`);
    }

    let latestDenomSupply = await Supply.get(latestBlockSupply.supplyId);

    if (!latestDenomSupply) {
      // same as before, in case it does not exist before, we start here.
      latestDenomSupply = Supply.create(getSupplyRecord(supply, block));
      await latestDenomSupply.save();
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
