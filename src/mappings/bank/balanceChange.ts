import { CosmosEvent } from "@subql/types-cosmos";
import { findIndex } from "lodash";
import { parseCoins } from "../../cosmjs/utils";
import {
  Balance,
  EventAttribute,
} from "../../types";
import { AccountProps } from "../../types/models/Account";
import type { BalanceProps } from "../../types/models/Balance";
import { ModuleAccountProps } from "../../types/models/ModuleAccount";
import {
  fetchPaginatedRecords,
  getSequelize,
  getStoreModel,
  optimizedBulkCreate,
} from "../utils/db";
import {
  generateDeterministicUUID,
  getBlockId,
} from "../utils/ids";

export interface EnforceAccountExistenceParams {
  account: AccountProps,
  module?: ModuleAccountProps
}

/**
 * Ensures that the provided accounts and module accounts are persisted in the database
 * without get duplicate records due to the Historical Tracking feature from SubQuery.
 *
 * @param {Array<{account: AccountProps, module?: ModuleAccountProps}>} accounts - An array of objects including account information and optional module account information.
 * @return {Promise<void>} A promise that resolves when the operation is complete.
 */
export async function enforceAccountsExists(accounts: Array<EnforceAccountExistenceParams>): Promise<void> {
  if (accounts.length === 0) return;

  const moduleAccountRecords = accounts.filter(r => !!r.module);

  await Promise.all([
    optimizedBulkCreate("Account", accounts, "omit" ,r => {
      return {
        id: r.account.id,
        chainId: r.account.chainId,
        __id: generateDeterministicUUID(r.account.id),
        __block_range: [store.context.getHistoricalUnit(), null],
      };
    }),
    optimizedBulkCreate("ModuleAccount", moduleAccountRecords, 'omit', r => ({
      ...r.module as ModuleAccountProps,
      __id: generateDeterministicUUID(r.account.id),
      __block_range: [store.context.getHistoricalUnit(), null],
    })),
  ]);
}

// TODO: figure out a way to run a atomic update that modify the balance.amount without the need of load it.
// export async function updateAccountBalance(address: string, denom: string, offset: bigint, blockId: bigint): Promise<void> {
//   const id = getBalanceId(address, denom);
//
//   let balance = await Balance.get(id);
//
//   if (!balance) {
//     balance = Balance.create({
//       id: getBalanceId(address, denom),
//       accountId: address,
//       denom,
//       amount: offset,
//       lastUpdatedBlockId: blockId,
//     });
//   } else {
//     balance.amount = balance.amount + offset;
//     balance.lastUpdatedBlockId = blockId;
//   }
//
//   await balance.save();
// }

// TODO: re-work fee handling because this does not look like the best way.
// async function saveNativeFeesEvent(event: CosmosEvent) {
//   if (!event.tx) {
//     if (event.kind !== CosmosEventKind.Transaction && event.kind !== CosmosEventKind.Message) {
//       return;
//     }
//     logger.warn(`[saveNativeFeesEvent] (block=${event.block.header.height} event=${event.idx}): transaction not found, but it should...`);
//     return;
//   }
//   const transaction = await Transaction.get(event.tx.hash);
//   if (!transaction) {
//     logger.warn(`[saveNativeFeesEvent] (tx ${event.tx.hash}): transaction not found, but it should...`);
//     return;
//   }
//
//   const { fees, signerAddress } = transaction as Transaction;
//   if (!signerAddress) {
//     logger.warn(`[saveNativeFeesEvent] (block=${event.block.header.height} tx=${event.tx.hash} event=${event.idx} kind=${event.kind}): signerAddress not found, but it should...`);
//     return;
//   }
//
//   const fee = fees.length > 0 ? fees[0] : null;
//   const feeAmountStr = fee ? fee.amount : 0;
//   const feeAmount = BigInt(0) - BigInt(feeAmountStr);
//   const feeDenom = fee ? fee.denom : "";
//   await saveNativeBalanceEvent(`${event.tx.hash}-fee`, signerAddress as string, feeAmount, feeDenom, event);
// }

export const CoinReceiveType = "coin_received";
export const CoinSpentType = "coin_spent";

function chunkArray<T>(arr: T[], size: number): T[][] {
  if (size <= 0) throw new Error("size must be > 0");
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

export async function updateBalances(
  addressDenomEntries: Array<[string, bigint]>,
  blockId: ReturnType<typeof getBlockId>
): Promise<void> {
  const ids = addressDenomEntries.map(([id]) => id)

  const batches = chunkArray(ids, 1000);

  const balances = [];

  for (const batch of batches) {
    const balancesBatch = await fetchPaginatedRecords<Balance>({
      fetchFn: (options) => Balance.getByFields(
        [
          ["id", "in", batch],
        ],
        options,
      ),
    });
    balances.push(...balancesBatch);
  }

  const currentBalancesMap: Record<string, bigint> = balances.reduce((acc, record) => ({
    ...acc,
    [record.id]: record.amount,
  }), {});

  const balancesToSaveWithOptimize: Array<BalanceProps> = []

  for (const [id, change] of addressDenomEntries) {
    const [address, denom] = id.split('-')
    const balance = (currentBalancesMap[id] || BigInt(0)) + change

    const props: BalanceProps = {
      id,
      accountId: address,
      denom,
      amount: balance,
      lastUpdatedBlockId: blockId,
    }

    balancesToSaveWithOptimize.push(props)
  }

  const BalanceModel = getStoreModel('Balance')
  const sequelize = getSequelize("Balance")

  const blockHeight = store.context.getHistoricalUnit()

  if (Object.keys(currentBalancesMap).length > 0) {
    // remove existing records of changes for this block
    // if they exist before saving records
    await BalanceModel.model.destroy({
      where: {
        // @ts-ignore
        last_updated_block_id: blockId,
      },
      transaction: store.context.transaction,
    })

    await BalanceModel.model.update(
      {
        __block_range: sequelize.fn(
          "int8range",
          sequelize.fn("lower", sequelize.col("_block_range")),
          blockId,
          '[)'
        ),
      },
      {
        hooks: false,
        where: {
          id: { [Symbol.for("in")]: Object.keys(currentBalancesMap) },
          __block_range: { [Symbol.for("contains")]: blockId },
        },
        transaction: store.context.transaction,
      }
    )
  }

  if (balancesToSaveWithOptimize.length > 0) {
    await optimizedBulkCreate(
      "Balance",
      balancesToSaveWithOptimize,
      // we are omitting this here because we are deleting the old records before
      'omit',
      (doc) => ({
        ...doc,
        __block_range: [blockHeight, null],
      })
    )
  }
}

export function getBalanceChanges(events: CosmosEvent[]): {
  addressDenomMap: Record<string, bigint>,
  uniqueAddressSet: Set<string>,
} {
  const addressDenomMap: Record<string, bigint> = {};
  const uniqueAddressSet = new Set<string>();

  for (const event of events) {
    const keyIndex = findIndex((event.event.attributes as Array<EventAttribute>), (attr) => attr.key === "receiver" || attr.key === "spender");

    if (keyIndex === -1) {
      throw new Error(
        `Event ${event.event.type} does not have a receiver or spender attribute`,
      );
    }

    const attribute = event.event.attributes[keyIndex];

    const address = attribute.value as string;

    const amountIndex = findIndex((event.event.attributes as Array<EventAttribute>), (attr) => attr.key === "amount");

    if (amountIndex === -1) {
      throw new Error(
        `Event ${event.event.type} does not have an amount attribute`,
      );
    }

    const amountStr = event.event.attributes[keyIndex + 1]?.value as string;

    uniqueAddressSet.add(address);

    const coin = parseCoins(amountStr)[0];
    const coins = BigInt(coin.amount);
    const amount = attribute.key === "spender" ? BigInt(0) - coins : coins;

    const mapId = `${address}-${coin.denom}`;

    if (!addressDenomMap[mapId]) addressDenomMap[mapId] = BigInt(0);

    addressDenomMap[mapId] += amount
  }

  return {
    addressDenomMap,
    uniqueAddressSet,
  };
}
