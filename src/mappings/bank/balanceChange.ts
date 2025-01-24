import {
  CosmosEvent,
  CosmosEventKind,
  CosmosMessage,
} from "@subql/types-cosmos";
import { parseCoins } from "../../cosmjs/utils";
import {
  Account,
  Balance,
} from "../../types";
import { NativeBalanceChangeProps } from "../../types/models/NativeBalanceChange";
import {
  getBalanceId,
  getBlockIdAsString,
  getEventId,
  messageId,
} from "../utils/ids";
import {
  getNonFirstBlockEvents,
  hasValidAmountAttribute,
  isEventOfMessageKind,
} from "../utils/primitives";

export async function enforceAccountExistence(address: string, chainId: string): Promise<void> {
  const account = await Account.get(address);
  if (account) return;
  await Account.create({ id: address, chainId }).save();
}


// TODO: figure out a way to run a atomic update that modify the balance.amount without the need of load it.
export async function updateAccountBalance(address: string, denom: string, offset: bigint, blockId: string): Promise<void> {
  const id = getBalanceId(address, denom);
  // let balance = await cache.get(id);
  let balance = await Balance.get(id);

  if (!balance) {
    balance = Balance.create({
      id: getBalanceId(address, denom),
      accountId: address,
      denom,
      amount: offset,
      lastUpdatedBlockId: blockId,
    });
  } else {
    balance.amount = balance.amount + offset;
    balance.lastUpdatedBlockId = blockId;
  }

  await balance.save();
  // await cache.set(id, balance);
}

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

function generateNativeBalanceChangeId(event: CosmosEvent): string {
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

async function handleNativeBalanceChange(
  events: CosmosEvent[],
  key: string,
): Promise<void> {
  const chainId = events[0].block.block.header.chainId;
  const blockId = getBlockIdAsString(events[0].block);

  const uniqueAddressSet = new Set<string>();
  const balanceChangeEvents: NativeBalanceChangeProps[] = [];

  for (const event of events) {
    for (const [i, attribute] of Object.entries(event.event.attributes)) {
      if (attribute.key !== key) continue;

      const address = attribute.value as string;

      const amountStr = event.event.attributes[parseInt(i) + 1]?.value as string;

      uniqueAddressSet.add(address);

      const coin = parseCoins(amountStr)[0];
      const coins = BigInt(coin.amount);
      const amount = key === "spender" ? BigInt(0) - coins : coins;
      const id = generateNativeBalanceChangeId(event);

      balanceChangeEvents.push({
        id,
        balanceOffset: amount.valueOf(),
        denom: coin.denom,
        accountId: address,
        eventId: getEventId(event),
        blockId: blockId,
        transactionId: event.tx?.hash || undefined,
        messageId: isEventOfMessageKind(event) ? messageId(event.msg as CosmosMessage) : undefined,
      });

      // this should be doable once we can run atomic updates and avoid the await inside the for
      await updateAccountBalance(address, coin.denom, amount.valueOf(), blockId);
    }
  }

  const uniqueAddresses = Array.from(uniqueAddressSet);

  await Promise.all([
    // Replace this once we determine with Subquery teams why the bulkCreate is duplicating record
    // (open&close blockRange) when there are no changes to the record.
    ...(uniqueAddresses.map(address => enforceAccountExistence(address, chainId))),
    // Upsert account if not exists (id + chain)
    // store.bulkCreate(
    //   "Account",
    //   uniqueAddresses.map((address) => ({
    //     id: address,
    //     chainId,
    //   })),
    // ),
    // Create all the entries for native balance change
    store.bulkCreate("NativeBalanceChange", balanceChangeEvents),
    // TODO: this need to be replaced with an atomic update of the Balance.amount once we figure out how.
    // ...updateAccountPromises,
  ]);
}

// handleNativeBalanceDecrement, referenced in project.ts, handles events about a decrease on an account balance.
export async function handleNativeBalanceDecrement(events: CosmosEvent[]): Promise<void> {
  const filteredEvents = getNonFirstBlockEvents(events).filter(hasValidAmountAttribute);
  if (filteredEvents.length === 0) return;
  await handleNativeBalanceChange(filteredEvents, "spender");
}

// handleNativeBalanceDecrement, referenced in project.ts, handles events about an increase on an account balance.
export async function handleNativeBalanceIncrement(events: CosmosEvent[]): Promise<void> {
  const filteredEvents = getNonFirstBlockEvents(events).filter(hasValidAmountAttribute);
  if (filteredEvents.length === 0) return;
  await handleNativeBalanceChange(getNonFirstBlockEvents(filteredEvents), "receiver");
}
