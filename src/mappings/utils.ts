import { createHash } from "crypto";
import {
  CosmosBlock,
  CosmosEvent,
  CosmosMessage,
  CosmosTransaction,
} from "@subql/types-cosmos";
import { default as JSONBig } from "json-bigint";
import {
  Account,
  Balance,
  UnprocessedEntity,
} from "../types";

export type Primitive = CosmosEvent | CosmosMessage | CosmosTransaction | CosmosBlock;

export interface Primitives {
  event?: CosmosEvent;
  msg?: CosmosMessage;
  tx?: CosmosTransaction;
  block?: CosmosBlock;
}

export function parseJson<T>(str: string, reviver?: (this: unknown, key: string, value: unknown) => unknown): T {
  return JSONBig.parse(str, reviver) as T;
}

export function stringify(value: unknown, replacer?: (this: unknown, key: string, value: unknown) => unknown, space?: string | number): string {
  return JSONBig.stringify(value, replacer || undefined, space);
}

// messageId returns the id of the message passed or
// that of the message which generated the event passed.
export function messageId(msg: CosmosMessage | CosmosEvent): string {
  return `${msg.tx.hash}-${msg.idx}`;
}

// getEventId returns the id of the event passed.
// Use this to get the id of the events across the indexing process.
export function getEventId(event: CosmosEvent): string {
  return `${event.tx?.hash || event.block.blockId}-${event.idx}`;
}

export async function checkBalancesAccount(address: string, chainId: string): Promise<void> {
  let accountEntity = await Account.get(address);
  if (typeof (accountEntity) === "undefined") {
    accountEntity = Account.create({ id: address, chainId });
    await accountEntity.save();
  }
}

export function getTimeline(entity: CosmosMessage | CosmosEvent): bigint {
  const K2 = 100, K1 = K2 * 1000;
  const txIndex = entity.tx.idx;
  const blockHeight = entity.block.block.header.height;
  // check if the entity is an Event or a Message and set msgIndex appropriately
  const msgIndex = (<CosmosEvent>entity).msg?.idx === undefined ?
    (<CosmosMessage>entity).idx : (<CosmosEvent>entity).msg.idx;
  const timeline = (K1 * blockHeight) + (K2 * txIndex) + msgIndex;
  return BigInt(timeline);
}

export async function attemptHandling(
  input: Primitive,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handlerFn: (primitive: any) => Promise<void>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  errorFn: (Error: Error, Primitive: any) => Promise<void> | void,
): Promise<void> {
  try {
    await handlerFn(input);
  } catch (error: unknown) {
    await errorFn(error as Error, input);
  }
}

export async function unprocessedEventHandler(err: Error, event: CosmosEvent): Promise<void> {
  await trackUnprocessed(err, primitivesFromEvent(event));
}

export async function unprocessedMsgHandler(err: Error, msg: CosmosMessage): Promise<void> {
  await trackUnprocessed(err, primitivesFromMsg(msg));
}

export function primitivesFromTx(tx: CosmosTransaction): Primitives {
  return { block: tx.block, tx: tx };
}

export function primitivesFromMsg(msg: CosmosMessage): Primitives {
  return { block: msg.block, tx: msg.tx };
}

export function primitivesFromEvent(event: CosmosEvent): Primitives {
  return { block: event.block, tx: event.tx };
}

export async function trackUnprocessed(error: Error, primitives: Primitives): Promise<void> {
  logger.warn(`[trackUnprocessable] (error.message): ${error.message}`);
  logger.warn(`[trackUnprocessable] (error.stack): ${error.stack}`);
  // NB: failsafe try/catch
  try {
    const { block, event, msg, tx } = primitives;
    const sha256 = createHash("sha256");
    // NB: use error stack if no primitives available (i.e. block handler).
    const hashInput = event ?
      (event.tx ? messageId(event) : `${event.block.blockId}-${event.idx}`) : msg ?
        // messageId(event) : msg ?
        messageId(msg) : tx ?
          tx.hash : block ?
            block.block.id : error.stack;
    sha256.write(hashInput);
    sha256.end();
    // NB: ID is a base64 encoded representation of the sha256 of either:
    // 1. the conventional ID of the "highest-level" primitive available or
    // 2. the error stacktrace, if none are available (i.e., handle block error)
    const id = sha256.read().toString("base64");
    const eventId = event ? messageId(event) : undefined;
    const _messageId = event ? messageId(event) : undefined;
    const transactionId = tx ? tx.hash : undefined;
    const blockId = block ? block.block.id : "";

    const unprocessedEntity = UnprocessedEntity.create({
      id,
      error: error.stack || "",
      eventId,
      messageId: _messageId,
      transactionId,
      blockId: blockId,
    });
    return await unprocessedEntity.save();
  } catch {
    logger.error("[trackUnprocessable] (ERROR): unable to persist unprocessable entity");
    logger.error(`[trackUnprocessable] (ERROR | stack): ${error.stack}`);
  }
}

// Returns the id of the entity that establishes the relationship between the MsgStake and Service.
export function getMsgStakeServiceId(msgStakeId: string, serviceId: string): string {
  return `${msgStakeId}-${serviceId}`;
}

// Returns the id of the entity that establishes the relationship between the Entity staked and Service.
export function getStakeServiceId(entityStakedId: string, serviceId: string): string {
  return `${entityStakedId}-${serviceId}`;
}

// getBalanceId returns the id of the Balance entity using the address and denom passed.
// Use this to get the id of the Balance entities across the indexing process.
export function getBalanceId(address: string, denom: string): string {
  return `${address}-${denom}`;
}

// Returns the id of the entity that establishes the relationship between the Gateway that the app is being delegated to.
export function getAppDelegatedToGatewayId(appAddress: string, gatewayAddress: string): string {
  return `${appAddress}-${gatewayAddress}`;
}

// Returns a string that satisfies the format of a transaction hash.
export function getGenesisFakeTxHash(entity: 'app' | 'supplier' | 'gateway' | 'service', index: number): string {
  const num = index + 1;
  let entityId: string

  switch (entity) {
    case 'app':
      entityId = 'A';
      break
    case 'supplier':
      entityId = 'B';
      break
    case "gateway":
      entityId = 'C';
      break
    case 'service':
      entityId = 'D';
      break;
    default: {
      throw new Error('Not implemented');
    }
  }

  return `${'0'.repeat(64 - num.toString().length - entityId.length)}${num}${entityId}`;
}

export async function updateAccountBalance(address: string, denom: string, offset: bigint, blockId: string): Promise<void> {
  let balance = await Balance.get(getBalanceId(address, denom));

  if (!balance) {
    balance = Balance.create({
      id: getBalanceId(address, denom),
      accountId: address,
      denom,
      amount: offset,
      lastUpdatedBlockId: blockId,
    })
  } else {
    balance.amount = balance.amount + offset;
    balance.lastUpdatedBlockId = blockId;
  }

  await balance.save();

  logger.debug(`[updateAccountBalance] (address): ${address}, (denom): ${denom}, (offset): ${offset}, (newBalance): ${balance?.amount}`);
}

// Returns the id of the param entity using the key and blockId passed.
export function getParamId(key: string, blockId: string): string {
  return `${key}-${blockId}`;
}
