import {
  CosmosBlock,
  CosmosEvent,
} from "@subql/types-cosmos";
import {
  handleModuleAccounts,
  handleSupply,
} from "./bank";
import {
  CACHE_MODULE_ADDRESS,
  PREFIX,
} from "./constants";
import {
  EventHandlers,
  MsgHandlers,
} from "./handlers";
import {
  handleBlock,
  handleEvents,
  handleGenesis,
  handleMessages,
  handleTransactions,
} from "./primitives";
import {
  EventByType,
  MessageByType,
} from "./types/common";
import { stringify } from "./utils/json";
import {
  hasValidAmountAttribute,
  isEventOfMessageOrTransactionKind,
} from "./utils/primitives";

// anything primitive types
async function indexPrimitives(block: CosmosBlock) {
  await Promise.all([
    handleGenesis(block),
    // we need this because it will fill CACHE_MODULE_ADDRESS that is used to filter primitive events
    handleModuleAccounts(block),
  ]);

  const moduleAccounts = new Set((await cache.get(CACHE_MODULE_ADDRESS) ?? []));

  const isValidPrimitiveEvent = (evt: CosmosEvent): boolean => {
    const isHeightOneAndOfMessageOrTransactionKind =
      block.block.header.height === 1 || isEventOfMessageOrTransactionKind(evt);
    const hasValidAmountAndNotMessageType =
      hasValidAmountAttribute(evt) && evt.event.type !== "message";
    const isNotFromModuleAccounts =
      !evt.event.attributes.some(
        (attr) =>
          (attr.value as string).startsWith(PREFIX) &&
          moduleAccounts.has(attr.value as string),
      );

    return (
      isHeightOneAndOfMessageOrTransactionKind ||
      (hasValidAmountAndNotMessageType && isNotFromModuleAccounts)
    );
  };

  // Apply the composed filter
  const filteredEvents = block.events.filter(isValidPrimitiveEvent);

  // primitives
  const primitiveHandlers: Array<Promise<void>> = [
    handleBlock(block),
    handleSupply(block),
    handleTransactions(block.transactions),
    handleMessages(block.messages),
  ];

  if (filteredEvents.length > 0) {
    primitiveHandlers.push(handleEvents(filteredEvents));
  }

  await Promise.all(primitiveHandlers);
}

// anything that modifies balances
async function indexBalances(msgsByType: MessageByType, eventByType: EventByType): Promise<void> {
  const promises: Promise<void>[] = [];

  const nativeTransferMsgs = msgsByType["/cosmos.bank.v1beta1.MsgSend"];
  if (nativeTransferMsgs.length > 0) {
    promises.push(MsgHandlers["/cosmos.bank.v1beta1.MsgSend"](nativeTransferMsgs));
  }

  const coinReceivedEvents = eventByType.coin_received;
  if (coinReceivedEvents.length > 0) {
    promises.push(EventHandlers.coin_received(coinReceivedEvents));
  }

  const coinSpentEvents = eventByType.coin_spent;
  if (coinSpentEvents.length > 0) {
    promises.push(EventHandlers.coin_spent(coinSpentEvents));
  }

  await Promise.all(promises);
}

// any validator messages or events
async function indexValidators(msgByType: MessageByType): Promise<void> {
  const promises: Promise<void>[] = [];
  const createValidatorMsgs = msgByType["/cosmos.staking.v1beta1.MsgCreateValidator"];
  if (createValidatorMsgs.length > 0) {
    promises.push(MsgHandlers["/cosmos.staking.v1beta1.MsgCreateValidator"](createValidatorMsgs));
  }
  await Promise.all(promises);
}

// any message or event related to relays
async function indexRelays(): Promise<void> {
  return Promise.resolve();
}

// any message or event related to Params
async function indexParams(): Promise<void> {
  return Promise.resolve();
}

// any message or event related to stake (supplier, gateway, application, service)
async function indexStake(): Promise<void> {
  // NOTE: edge case: check if the same entity element creates multiple messages of the same time, to take the last one
  // as the final network state.
  // the messages and events should be created, but the Entity record needs to reflect the last one?
  // possible solution: group by entity and address, so if we have multiple, they will run serially, we need to sort them by tx.index
  return Promise.resolve();
}

// any report call
async function generateReports(): Promise<void> {
  return Promise.resolve();
}

// indexingHandler, referenced in project.ts
export async function indexingHandler(block: CosmosBlock): Promise<void> {
  // generate msg map by type base on the MsgHandlers declared at src/mappings/handlers.ts
  const msgsByType: Partial<MessageByType> = {};
  const msgHandlersSet = new Set(Object.keys(MsgHandlers));
  // ensure every key as an empty array
  msgHandlersSet.forEach((typeUrl) => msgsByType[typeUrl] = []);
  block.messages.forEach((msg) => {
    const typeUrl = msg.msg.typeUrl;
    if (!msgHandlersSet.has(typeUrl)) return;
    msgsByType[typeUrl]?.push(msg);
  });

  // generate events map by type base on the EventHandlers declared at src/mappings/handlers.ts
  const eventsByType: EventByType = {};
  const eventHandlersSet = new Set(Object.keys(EventHandlers));
  // ensure every key as an empty array
  eventHandlersSet.forEach((type) => eventsByType[type] = []);
  block.events.forEach((event) => {
    const type = event.event.type;
    if (!eventHandlersSet.has(type)) return;
    eventsByType[type]?.push(event);
  });

  const jsonArrayCounter = (_: string, value: unknown) => {
    if (value instanceof Array) {
      return value.length;
    }
    return value;
  };
  logger.debug(`[indexingHandler] msgsByType=${stringify(msgsByType, jsonArrayCounter, 0)}`);
  logger.debug(`[indexingHandler] eventsByType=${stringify(eventsByType, jsonArrayCounter, 0)}`);

  await indexPrimitives(block);

  await indexBalances(msgsByType as MessageByType, eventsByType);

  await Promise.all([
    indexValidators(msgsByType as MessageByType),
    indexRelays(),
    indexParams(),
    indexStake(),
  ]);

  await generateReports();
}
