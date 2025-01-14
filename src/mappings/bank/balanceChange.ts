import { CosmosEvent } from "@subql/types-cosmos";
import { parseCoins } from "../../cosmjs/utils";
import {
  Account,
  Balance,
  NativeBalanceChange,
  Transaction,
} from "../../types";
import {
  attemptHandling,
  unprocessedEventHandler,
} from "../utils/handlers";
import {
  getBalanceId,
  getEventId,
  messageId,
} from "../utils/ids";

export async function updateAccountBalance(address: string, denom: string, offset: bigint, blockId: string): Promise<void> {
  let balance = await Balance.get(getBalanceId(address, denom));

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

  // logger.debug(`[updateAccountBalance] (address): ${address}, (denom): ${denom}, (offset): ${offset}, (newBalance): ${balance?.amount}`);
}

export async function checkBalancesAccount(address: string, chainId: string): Promise<void> {
  let accountEntity = await Account.get(address);
  if (typeof (accountEntity) === "undefined") {
    accountEntity = Account.create({ id: address, chainId });
    await accountEntity.save();
  }
}

export async function saveNativeBalanceEvent(id: string, address: string, amount: bigint, denom: string, event: CosmosEvent): Promise<void> {
  await checkBalancesAccount(address, event.block.block.header.chainId);

  const eventId = getEventId(event);

  const nativeBalanceChangeEntity = NativeBalanceChange.create({
    id,
    balanceOffset: amount.valueOf(),
    denom,
    accountId: address,
    eventId: eventId,
    blockId: event.block.block.id,
    transactionId: event.tx?.hash || undefined,
  });

  await nativeBalanceChangeEntity.save();
  await updateAccountBalance(address, denom, amount.valueOf(), event.block.block.id);
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function saveNativeFeesEvent(event: CosmosEvent) {
  const transaction = await Transaction.get(event.tx.hash);
  if (!transaction) {
    // TODO(@bryanchriswhite): add logging.
    return;
  }

  const { fees, signerAddress } = transaction as Transaction;
  if (!signerAddress) {
    // TODO(@bryanchriswhite): add logging.
    return;
  }

  const fee = fees.length > 0 ? fees[0] : null;
  const feeAmountStr = fee ? fee.amount : 0;
  const feeAmount = BigInt(0) - BigInt(feeAmountStr);
  const feeDenom = fee ? fee.denom : "";
  await saveNativeBalanceEvent(`${event.tx.hash}-fee`, signerAddress as string, feeAmount, feeDenom, event);
}

export async function handleNativeBalanceDecrement(event: CosmosEvent): Promise<void> {
  await attemptHandling(event, _handleNativeBalanceDecrement, unprocessedEventHandler);
}

export async function handleNativeBalanceIncrement(event: CosmosEvent): Promise<void> {
  await attemptHandling(event, _handleNativeBalanceIncrement, unprocessedEventHandler);
}

async function _handleNativeBalanceDecrement(event: CosmosEvent): Promise<void> {
  // logger.debug(`[handleNativeBalanceDecrement] (tx ${event.tx?.hash}): indexing event ${event.idx + 1} / ${event.tx?.tx?.events?.length}`);
  // logger.debug(`[handleNativeBalanceDecrement] (event.event): ${stringify(event.event, undefined, 2)}`);
  // logger.debug(`[handleNativeBalanceDecrement] (event.log): ${stringify(event.log, undefined, 2)}`);

  // sample event.event.attributes:
  // [
  //   {"key":"spender","value":"fetch1jv65s3grqf6v6jl3dp4t6c9t9rk99cd85zdctg"},
  //   {"key":"amount","value":"75462013217046121atestfet"},
  //   {"key":"spender","value":"fetch1wurz7uwmvchhc8x0yztc7220hxs9jxdjdsrqmn"},
  //   {"key":"amount","value":"100atestfet"}
  // ]
  const spendEvents = [];
  for (const [i, e] of Object.entries(event.event.attributes)) {
    if (e.key !== "spender") {
      continue;
    }
    const spender = e.value;
    const amountStr = event.event.attributes[parseInt(i) + 1].value as string;

    // NB: some events contain empty string amounts
    if (amountStr === "") {
      logger.warn(`empty string amount; block: ${event.block.block.header.height}; event idx: ${event.idx}; message typeUrl: ${event.msg?.msg?.typeUrl}; event type: ${event.event.type}`);
      return;
    }

    const coin = parseCoins(amountStr)[0];
    const amount = BigInt(0) - BigInt(coin.amount); // save a negative amount for a "spend" event
    spendEvents.push({ spender: spender, amount: amount, denom: coin.denom });
  }


  for (const [i, spendEvent] of Object.entries(spendEvents)) {
    let id;
    if (event.tx) {
      id = `${messageId(event)}-receive-${i}`;
    } else {
      id = `${event.block.blockId}-${i}`;
    }

    await saveNativeBalanceEvent(id, spendEvent.spender, spendEvent.amount, spendEvent.denom, event);
  }
  // TODO(@bryanchriswhite): fix...
  // await saveNativeFeesEvent(event);
}

async function _handleNativeBalanceIncrement(event: CosmosEvent): Promise<void> {
  // logger.debug(`[handleNativeBalanceIncrement] (tx ${event.tx?.hash}): indexing event ${event.idx + 1} / ${event.tx?.tx?.events?.length}`);
  // logger.debug(`[handleNativeBalanceIncrement] (event.event): ${stringify(event.event, undefined, 2)}`);
  // logger.debug(`[handleNativeBalanceIncrement] (event.log): ${stringify(event.log, undefined, 2)}`);

  // sample event.event.attributes:
  // [
  //   {"key":"receiver","value":"fetch1jv65s3grqf6v6jl3dp4t6c9t9rk99cd85zdctg"},
  //   {"key":"amount","value":"75462013217046121atestfet"},
  //   {"key":"receiver","value":"fetch1wurz7uwmvchhc8x0yztc7220hxs9jxdjdsrqmn"},
  //   {"key":"amount","value":"100atestfet"}
  // ]
  const receiveEvents = [];
  for (const [i, e] of Object.entries(event.event.attributes)) {
    if (e.key !== "receiver") {
      continue;
    }
    const receiver = e.value;
    const amountStr = event.event.attributes[parseInt(i) + 1].value as string;

    // NB: some events contain empty string amounts
    if (amountStr === "") {
      logger.warn(`empty string amount; block: ${event.block.block.header.height}; event idx: ${event.idx}; message typeUrl: ${event.msg?.msg?.typeUrl}; event type: ${event.event.type}`);
      return;
    }

    const coin = parseCoins(amountStr)[0];
    const amount = BigInt(coin.amount);
    receiveEvents.push({ receiver, amount, denom: coin.denom });
  }

  for (const [i, receiveEvent] of Object.entries(receiveEvents)) {
    let id;
    if (event.tx) {
      id = `${messageId(event)}-receive-${i}`;
    } else {
      id = `${event.block.blockId}-${i}`;
    }

    await saveNativeBalanceEvent(id, receiveEvent.receiver, receiveEvent.amount, receiveEvent.denom, event);
  }
  // TODO(@bryanchriswhite): fix...
  // await saveNativeFeesEvent(event);
}
