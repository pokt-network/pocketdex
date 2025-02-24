import {
  CosmosEvent,
  CosmosEventKind,
  CosmosMessage,
} from "@subql/types-cosmos";
import { findIndex } from "lodash";
import { parseCoins } from "../../cosmjs/utils";
import {
  Balance,
  EventAttribute,
} from "../../types";
import { AccountProps } from "../../types/models/Account";
import { ModuleAccountProps } from "../../types/models/ModuleAccount";
import { NativeBalanceChangeProps } from "../../types/models/NativeBalanceChange";
import { optimizedBulkCreate } from "../utils/db";
import {
  generateDeterministicUUID,
  getBalanceId,
  getBlockId,
  getBlockIdAsString,
  getEventId,
  messageId,
} from "../utils/ids";
import { isEventOfMessageKind } from "../utils/primitives";

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
    optimizedBulkCreate("Account", accounts, r => {
      return {
        id: r.account.id,
        chainId: r.account.chainId,
        __id: generateDeterministicUUID(r.account.id),
        __block_range: [store.context.getHistoricalUnit(), null],
      };
    }),
    optimizedBulkCreate("ModuleAccount", moduleAccountRecords, r => ({
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

export function generateNativeBalanceChangeId(event: CosmosEvent): string {
  switch (event.kind) {
    case CosmosEventKind.Transaction:
      return `${event.tx?.hash}-event-${event.idx}`;
    case CosmosEventKind.Message:
      return `${messageId(event.msg as CosmosMessage)}-event-${event.idx}`;
    case CosmosEventKind.BeginBlock:
    case CosmosEventKind.EndBlock:
    case CosmosEventKind.FinalizeBlock:
      return `${getBlockIdAsString(event.block)}-${event.idx}`;
    default:
      throw new Error(`Unknown event kind=${event.kind}`);
  }
}

export async function handleNativeBalanceChangesForAddressAndDenom(address: string, denom: string, changes: Array<NativeBalanceChangeProps>, blockId: ReturnType<typeof getBlockId>): Promise<void> {
  const id = getBalanceId(address, denom);
  // get latest balance
  let balance = await Balance.get(id);
  if (!balance) {
    balance = Balance.create({
      id: getBalanceId(address, denom),
      accountId: address,
      denom,
      amount: BigInt(0),
      lastUpdatedBlockId: blockId,
    });
  } else {
    balance.lastUpdatedBlockId = blockId;
  }

  // apply all the changes on this block
  for (const change of changes) {
    balance.amount += BigInt(change.balanceOffset);
  }

  // save once per address-denom
  await balance.save();
}


export function getBalanceChanges(events: CosmosEvent[], blockId: ReturnType<typeof getBlockId>): {
  nativeBalanceChanges: Array<NativeBalanceChangeProps>,
  addressDenomMap: Record<string, Array<NativeBalanceChangeProps>>,
  uniqueAddressSet: Set<string>,
} {
  const addressDenomMap: Record<string, Array<NativeBalanceChangeProps>> = {};
  const uniqueAddressSet = new Set<string>();
  const nativeBalanceChanges: Array<NativeBalanceChangeProps> = [];

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
    const id = generateNativeBalanceChangeId(event);

    const mapId = `${address}-${coin.denom}`;
    if (!addressDenomMap[mapId]) addressDenomMap[mapId] = [];

    const nativeBalanceChange = {
      id,
      balanceOffset: amount.valueOf(),
      denom: coin.denom,
      accountId: address,
      eventId: getEventId(event),
      blockId: blockId,
      transactionId: event.tx?.hash || undefined,
      messageId: isEventOfMessageKind(event) ? messageId(event.msg as CosmosMessage) : undefined,
    };
    nativeBalanceChanges.push(nativeBalanceChange);
    addressDenomMap[mapId].push(nativeBalanceChange);
  }

  return {
    nativeBalanceChanges,
    addressDenomMap,
    uniqueAddressSet,
  };
}
