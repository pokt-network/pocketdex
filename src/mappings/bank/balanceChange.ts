import crypto from "crypto";
import {
  CosmosEvent,
  CosmosEventKind,
  CosmosMessage,
} from "@subql/types-cosmos";
import { findIndex } from "lodash";
import { parseCoins } from "../../cosmjs/utils";
import { Balance, EventAttribute } from "../../types";
import { AccountProps } from "../../types/models/Account";
import { ModuleAccountProps } from "../../types/models/ModuleAccount";
import { NativeBalanceChangeProps } from "../../types/models/NativeBalanceChange";
import {
  getBalanceId, getBlockId,
  getBlockIdAsString, getEventId,
  messageId,
} from "../utils/ids";
import { isEventOfMessageKind } from "../utils/primitives";

export interface EnforceAccountExistenceParams {
  account: AccountProps,
  module?: ModuleAccountProps
}

// always the same to ensure we get consistent results
const namespace = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";

/**
 * Generates a deterministic UUID-like string using SHA-1.
 * We need to generate deterministic uuid v4 based on bench32 address to set under the historical `__id` column to avoid
 * historical duplicates for accounts.
 * We are trying to ensure accounts' existence without duplicating them on each block
 *
 * @param {string} name - The input data to hash deterministically.
 * @returns {string} - The generated UUID.
 */
function generateDeterministicUUID(name: string): string {
  // Validate namespace (must be 36 characters long)
  if (!namespace || namespace.length !== 36) {
    throw new Error("Namespace must be a valid UUID (36 characters long).");
  }

  // Remove dashes from the namespace UUID and convert to bytes
  const namespaceBytes = Buffer.from(namespace.replace(/-/g, ""), "hex");

  // Hash the namespace and name together using SHA-256 for deterministic behavior
  const hash = crypto.createHash("sha256");
  hash.update(namespaceBytes);
  hash.update(name);
  const hashedData = hash.digest();

  // Use the first 16 bytes of the hash for the UUID
  const randomBytes = hashedData.slice(0, 16);

  // Set version to 4 (0100XXXX)
  randomBytes[6] = (randomBytes[6] & 0x0f) | 0x40;

  // Set variant to RFC 4122 (10XXXXXX)
  randomBytes[8] = (randomBytes[8] & 0x3f) | 0x80;

  // Format the bytes into UUID v4 string structure
  return [
    randomBytes.toString("hex", 0, 4),
    randomBytes.toString("hex", 4, 6),
    randomBytes.toString("hex", 6, 8),
    randomBytes.toString("hex", 8, 10),
    randomBytes.toString("hex", 10, 16),
  ].join("-");
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

  const AccountModel = store.modelProvider.getModel("Account");
  const ModuleAccountModel = store.modelProvider.getModel("ModuleAccount");

  const accountRecords = accounts.map(r => {
    return {
      id: r.account.id,
      chainId: r.account.chainId,
      __id: generateDeterministicUUID(r.account.id),
      __block_range: [store.context.getHistoricalUnit(), null],
    };
  });
  const moduleAccountRecords = accounts
    .filter(r => !!r.module)
    .map(r => ({
      ...r.module as ModuleAccountProps,
      __id: generateDeterministicUUID(r.account.id),
      __block_range: [store.context.getHistoricalUnit(), null],
    }));

  const promises: Array<Promise<unknown>> = [
    AccountModel.model.bulkCreate(
      accountRecords,
      {
        transaction: store.context.transaction,
        ignoreDuplicates: true,
      },
    ),
  ];

  if (moduleAccountRecords.length > 0) {
    promises.push(
      ModuleAccountModel.model.bulkCreate(
        moduleAccountRecords,
        {
          transaction: store.context.transaction,
          ignoreDuplicates: true,
        },
      ),
    );
  }

  await Promise.all(promises);
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
}  {
  const addressDenomMap: Record<string, Array<NativeBalanceChangeProps>> = {};
  const uniqueAddressSet = new Set<string>();
  const nativeBalanceChanges: Array<NativeBalanceChangeProps> = [];

  for (const event of events) {
    // const isFailedTx = event.tx && event.tx.tx.code !== 0;
    // let amountStr: string, address: string
    //
    // if (isFailedTx && event.event.type) {
    //
    // }

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
  }
}

// async function handleNativeBalanceChange(
//   events: CosmosEvent[],
//   key: string,
// ): Promise<void> {
//   const chainId = events[0].block.block.header.chainId;
//   const blockId = getBlockId(events[0].block);
//
//   const uniqueAddressSet = new Set<string>();
//   const balanceChangeEvents: NativeBalanceChangeProps[] = [];
//
//   for (const event of events) {
//     for (const [i, attribute] of Object.entries(event.event.attributes)) {
//       if (attribute.key !== key) continue;
//
//       const address = attribute.value as string;
//
//       const amountStr = event.event.attributes[parseInt(i) + 1]?.value as string;
//
//       uniqueAddressSet.add(address);
//
//       const coin = parseCoins(amountStr)[0];
//       const coins = BigInt(coin.amount);
//       const amount = key === "spender" ? BigInt(0) - coins : coins;
//       const id = generateNativeBalanceChangeId(event);
//
//       balanceChangeEvents.push({
//         id,
//         balanceOffset: amount.valueOf(),
//         denom: coin.denom,
//         accountId: address,
//         eventId: getEventId(event),
//         blockId: blockId,
//         transactionId: event.tx?.hash || undefined,
//         messageId: isEventOfMessageKind(event) ? messageId(event.msg as CosmosMessage) : undefined,
//       });
//
//       // this should be doable once we can run atomic updates and avoid the await inside the for
//       await updateAccountBalance(address, coin.denom, amount.valueOf(), blockId);
//     }
//   }
//
//   const uniqueAddresses = Array.from(uniqueAddressSet);
//
//   await Promise.all([
//     // Replace this once we determine with Subquery teams why the bulkCreate is duplicating record
//     // (open&close blockRange) when there are no changes to the record.
//     ...(uniqueAddresses.map(address => enforceAccountExistence(address, chainId))),
//     // Upsert account if not exists (id + chain)
//     // store.bulkCreate(
//     //   "Account",
//     //   uniqueAddresses.map((address) => ({
//     //     id: address,
//     //     chainId,
//     //   })),
//     // ),
//     // Create all the entries for native balance change
//     store.bulkCreate("NativeBalanceChange", balanceChangeEvents),
//     // TODO: this need to be replaced with an atomic update of the Balance.amount once we figure out how.
//     // ...updateAccountPromises,
//   ]);
// }
