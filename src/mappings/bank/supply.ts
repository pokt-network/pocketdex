import type {
  Coin,
  CosmosBlock,
} from "@subql/types-cosmos";
import type { QueryTotalSupplyResponse } from "cosmjs-types/cosmos/bank/v1beta1/query";
import {
  BlockSupply,
  Supply,
} from "../../types";

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
    // logger.debug(`[handleTotalSupply]: initialResponse=${stringify(initialResponse, undefined, 2)}`);
    finalSupply.push(...initialResponse.supply);
    paginationKey = initialResponse.pagination?.nextKey;

    // Continue fetching if there is a nextKey
    while (paginationKey && paginationKey.length > 0) {
      // logger.debug(`[handleTotalSupply]: loading more supply pages pagination.nextKey=${JSON.stringify(paginationKey, undefined, 2)}`);
      const response = await queryClient.bank.totalSupply(paginationKey);
      finalSupply.push(...response.supply);
      paginationKey = response.pagination?.nextKey;
    }
    // logger.debug(`[handleTotalSupply]: all_total_supply=${JSON.stringify(finalSupply, undefined, 2)}`);
  } catch (error) {
    logger.error(`[handleTotalSupply] errored: ${error}`);
  }

  return finalSupply;
}

export async function _handleSupply(block: CosmosBlock): Promise<void> {
  const totalSupply = await queryTotalSupply();
  if (totalSupply.length === 0) {
    logger.warn(`[_handleSupply]: no total supply found`);
    return;
  }

  for (const supply of totalSupply) {
    // get the current blockSupply create on block handler to been able to access the assigned previous supply id
    // that will allow us to compare the amount and create a new on if needed.
    const blockSupplyId = getSupplyId(supply.denom, block.header.height);
    const latestBlockSupply = await BlockSupply.get(blockSupplyId);
    if (!latestBlockSupply) {
      logger.warn(`[_handleSupply]: no BlockSupply found id=${blockSupplyId}`);
      continue;
    }

    const latestDenomSupply = await Supply.get(latestBlockSupply.supplyId);
    if (!latestDenomSupply) {
      logger.warn(`[_handleSupply]: no total supply found id=${latestBlockSupply.supplyId}`);
      continue;
    }

    if (latestDenomSupply.amount.toString() !== supply.amount) {
      const newSupply = getSupplyRecord(supply, block);
      await newSupply.save();
      latestBlockSupply.supplyId = newSupply.id;
      await latestBlockSupply.save();
      break;
    }
  }
}
