import {
  CosmosBlock,
  CosmosEvent,
  CosmosMessage,
} from "@subql/types-cosmos";
import {
  get,
  isNumber,
  orderBy,
} from "lodash";
import {
  CoinReceiveType,
  CoinSpentType,
  enforceAccountsExists,
  getBalanceChanges,
  handleModuleAccounts,
  handleNativeBalanceChangesForAddressAndDenom,
  handleSupply,
} from "./bank";
import { PREFIX } from "./constants";
import {
  ByTxStatus,
  EventHandlers,
  MsgHandlers,
} from "./handlers";
import { handleAddBlockReports } from "./poktroll/reports";
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
import { optimizedBulkCreate } from "./utils/db";
import { getBlockId } from "./utils/ids";
import { stringify } from "./utils/json";
import { profilerWrap } from "./utils/performance";
import {
  filterEventsByTxStatus,
  filterMsgByTxStatus,
  hasValidAmountAttribute,
} from "./utils/primitives";

function handleByType(typeUrl: string | Array<string>, byTypeMap: MessageByType | EventByType, byTypeHandlers: typeof MsgHandlers | typeof EventHandlers, byTxStatus: ByTxStatus): Array<Promise<void>> {
  const promises = [];
  const types = [];

  if (!Array.isArray(typeUrl)) {
    types.push(typeUrl);
  } else {
    types.push(...typeUrl);
  }

  for (const type of types) {
    let docs = byTypeMap[type];
    if (docs.length > 0) {
      if (byTxStatus !== ByTxStatus.All) {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        if ("event" in docs!.at(0)!) {
          const { error, success } = filterEventsByTxStatus(docs as Array<CosmosEvent>);
          docs = byTxStatus === ByTxStatus.Success ? success : error;
        } else {
          const { error, success } = filterMsgByTxStatus(docs as Array<CosmosMessage>);
          docs = byTxStatus === ByTxStatus.Success ? success : error;
        }
      }

      // NOTE: right now I don't reach a good idea on how to structure TypeScript to let it infer the right types
      //  for message or event maps
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore
      promises.push(byTypeHandlers[type](docs));
    }
  }

  return promises;
}

async function handleStakeMsgs(typeUrl: string, identityProperty: string, msgByType: MessageByType) {
  const { success: msgs } = filterMsgByTxStatus(msgByType[typeUrl]);
  const addressMsgMap: Record<string, Array<CosmosMessage>> = {};

  if (msgs.length === 0) {
    return;
  }

  msgs.forEach((msg) => {
    const identity = get(msg.msg.decodedMsg, identityProperty) as string;
    if (!addressMsgMap[identity]) addressMsgMap[identity] = [];
    addressMsgMap[identity].push(msg);
  });

  const nonRepeatedStake = [];
  const repeatedStakeAddresses = new Set<string>();
  for (const [identity, msgs] of Object.entries(addressMsgMap)) {
    if (msgs.length === 1) {
      nonRepeatedStake.push(...msgs);
    } else {
      repeatedStakeAddresses.add(identity);
    }
  }

  const promises: Array<Promise<void>> = [
    // call in parallel application stake handler for all non-repeated stake messages
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    MsgHandlers[typeUrl](nonRepeatedStake),
  ];

  for (const identity of repeatedStakeAddresses.values()) {
    const msgs = addressMsgMap[identity];
    msgs[0].tx.idx;
    msgs[0].idx;
    const sortedMsg = orderBy(msgs, ["tx.idx", "idx"], ["asc", "asc"]);
    promises.push(async function(msgs) {
      for (const msg of msgs) {
        // force pass one by one because they are at the same block and the same address,
        // so we need to enforce tx.idx + tx.msg.idx
        // otherwise the resultant state of Application entity could not reflect the right state on the network.
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        await MsgHandlers[typeUrl]([msg]);
      }
    }(sortedMsg));
  }

  await Promise.all(promises);
}

// anything primitive types
async function indexPrimitives(block: CosmosBlock, events: Array<CosmosEvent>) {
  await profilerWrap(handleGenesis, "indexPrimitives", "handleGenesis")(block);

  await Promise.all([
    profilerWrap(handleBlock, "indexPrimitives", "handleGenesis")(block),
    profilerWrap(handleSupply, "indexPrimitives", "handleSupply")(block),
    profilerWrap(handleTransactions, "indexPrimitives", "handleTransactions")(block.transactions),
    profilerWrap(handleMessages, "indexPrimitives", "handleMessages")(block.messages),
    profilerWrap(handleEvents, "indexPrimitives", "handleEvents")(events),
  ]);
}

// anything that modifies balances
async function indexBalances(block: CosmosBlock, msgByType: MessageByType, eventByType: EventByType): Promise<void> {
  // reconstruct account balances for non-module accounts
  const balanceModificationEvents = [
    ...eventByType[CoinReceiveType] ?? [],
    ...eventByType[CoinSpentType] ?? [],
  ];

  const blockId = getBlockId(block);

  const { addressDenomMap, nativeBalanceChanges, uniqueAddressSet } = getBalanceChanges(
    balanceModificationEvents,
    blockId,
  );

  for (const [addressDenom, changes] of Object.entries(addressDenomMap)) {
    const [address, denom] = addressDenom.split("-");
    await handleNativeBalanceChangesForAddressAndDenom(address, denom, changes, blockId);
  }

  const msgTypes = [
    "/cosmos.bank.v1beta1.MsgSend",
  ];

  await Promise.all([
    // create a native transfer entity
    ...handleByType(msgTypes, msgByType, MsgHandlers, ByTxStatus.All),
    // track native balance changes
    optimizedBulkCreate("NativeBalanceChange", nativeBalanceChanges),
    // ensure accounts exists in bulk
    enforceAccountsExists(Array.from(uniqueAddressSet).map(address => ({
      account: {
        id: address,
        chainId: block.header.chainId,
        firstBlockId: getBlockId(block),
      },
    }))),
  ]);
}

// any validator messages or events
async function indexValidators(msgByType: MessageByType, eventByType: EventByType): Promise<void> {
  const msgTypes = [
    "/cosmos.staking.v1beta1.MsgCreateValidator",
    "/poktroll.proof.MsgSubmitProof",
  ];
  const eventTypes = [
    "rewards",
    "commission",
  ];

  await Promise.all([
    ...handleByType(msgTypes, msgByType, MsgHandlers, ByTxStatus.Success),
    ...handleByType(eventTypes, eventByType, EventHandlers, ByTxStatus.All),
  ]);
}

// any message or event related to relays
async function indexRelays(msgByType: MessageByType, eventByType: EventByType): Promise<void> {
  const msgTypes = [
    "/poktroll.proof.MsgCreateClaim",
    "/poktroll.proof.MsgSubmitProof",
  ];
  // {
  // "type":"poktroll.tokenomics.EventClaimSettled",
  // "attributes":[
  // {
  // "key":"claim",
  // "value": "{
  // \"supplier_operator_address\":\"pokt1l2glz2ptdlqp6p5jgr2jjvq72lj8lkckfyc05h\",
  // \"session_header\":{
  //   \"application_address\":\"pokt1uu0wqxnmlywzvctx83kv86awzgsu992vd6qmhx\",
  //   \"service_id\":\"proto-anvil\",
  //   \"session_id\":\"0006481aec235c313136702eb9870feb7b05a3debc87f9903948dda75b5f4e4d\",
  //   \"session_start_block_height\":\"50121\",
  //   \"session_end_block_height\":\"50130\"
  //  },
  //  \"root_hash\":\"A0JoronhJtrW2XLT7cQABtIyjL3x/PoLtYK40gyREfgAAAAAAAAABQAAAAAAAAAB\"
  //  }",
  // "index":true
  // }
  const eventTypes = [
    "poktroll.tokenomics.EventClaimSettled",
    "poktroll.tokenomics.EventClaimExpired",
    "poktroll.proof.EventClaimUpdated",
    "poktroll.proof.EventProofUpdated",
    // todo: handle this events
    //  poktroll.tokenomics.EventApplicationReimbursementRequest
  ];

  await Promise.all([
    ...handleByType(msgTypes, msgByType, MsgHandlers, ByTxStatus.Success),
    ...handleByType(eventTypes, eventByType, EventHandlers, ByTxStatus.Success),
  ]);
}

// any message or event related to Params
async function indexParams(msgByType: MessageByType): Promise<void> {
  await Promise.all(
    handleByType("/cosmos.authz.v1beta1.MsgExec", msgByType, MsgHandlers, ByTxStatus.Success),
  );
}

// any service msg or event
async function indexService(msgByType: MessageByType): Promise<void> {
  await Promise.all(
    handleByType("/poktroll.service.MsgAddService", msgByType, MsgHandlers, ByTxStatus.Success),
  );
}

// any application msg or event
async function indexApplications(msgByType: MessageByType, eventByType: EventByType): Promise<void> {
  const msgTypes = [
    "/poktroll.application.MsgDelegateToGateway",
    "/poktroll.application.MsgUndelegateFromGateway",
    "/poktroll.application.MsgUnstakeApplication",
    "/poktroll.application.MsgTransferApplication",
  ];
  const eventTypes = [
    "poktroll.application.EventTransferBegin",
    "poktroll.application.EventTransferEnd",
    "poktroll.application.EventTransferError",
    "poktroll.application.EventApplicationUnbondingBegin",
    "poktroll.application.EventApplicationUnbondingEnd",
  ];

  await Promise.all([
    handleStakeMsgs(
      "/poktroll.application.MsgStakeApplication",
      "address",
      msgByType,
    ),
    // handle possible edge case where same entity receive on same block multiple stake msgs
    ...handleByType(msgTypes, msgByType, MsgHandlers, ByTxStatus.Success),
    // any other non-stake msgs/events
    ...handleByType(eventTypes, eventByType, EventHandlers, ByTxStatus.Success),
  ]);
}

// any gateway msg or event
async function indexGateway(msgByType: MessageByType, eventByType: EventByType): Promise<void> {
  const msgTypes = [
    "/poktroll.gateway.MsgUnstakeGateway",
  ];
  const eventTypes = [
    "poktroll.gateway.EventGatewayUnstaked",
  ];

  await handleStakeMsgs(
    "/poktroll.gateway.MsgStakeGateway",
    "address",
    msgByType,
  );

  await Promise.all([
    // handle possible edge case where same entity receive on same block multiple stake msgs
    ...handleByType(msgTypes, msgByType, MsgHandlers, ByTxStatus.Success),
    // any other non-stake msgs/events
    ...handleByType(eventTypes, eventByType, EventHandlers, ByTxStatus.Success),
  ]);
}

// any supplier msg or event
async function indexSupplier(msgByType: MessageByType, eventByType: EventByType): Promise<void> {
  const msgTypes = [
    "/poktroll.supplier.MsgUnstakeSupplier",
  ];
  const eventTypes = [
    "poktroll.supplier.EventSupplierUnbondingBegin",
    "poktroll.supplier.EventSupplierUnbondingEnd",
  ];

  // handle possible edge case where same entity receive on same block multiple stake msgs
  await handleStakeMsgs(
    "/poktroll.supplier.MsgStakeSupplier",
    "operatorAddress",
    msgByType,
  );

  await Promise.all([
    ...handleByType(msgTypes, msgByType, MsgHandlers, ByTxStatus.Success),
    ...handleByType(eventTypes, eventByType, EventHandlers, ByTxStatus.Success),
  ]);
}

// any message or event related to stake (supplier, gateway, application, service)
async function indexStake(msgByType: MessageByType, eventByType: EventByType): Promise<void> {
  await Promise.all([
    indexApplications(msgByType, eventByType),
    indexGateway(msgByType, eventByType),
    indexSupplier(msgByType, eventByType),
  ])
}

// any report call
async function generateReports(block: CosmosBlock): Promise<void> {
  // for now this is the only thing we do, but later we may want to do this somehow else.
  await handleAddBlockReports(block);
}

function evaluateBlockHeightStop(height: number): void {
  // debugging env, that allow us to stop at certain block dynamically
  const stopAtHeight = Number(process.env.POCKETDEX_STOP_AT_BLOCK_HEIGHT);
  // we are able to process env variables thanks to the fork that modify sandbox to use `context: host`

  if (isNumber(stopAtHeight) && height > stopAtHeight) {
    throw new Error(`POCKETDEX_STOP_AT_BLOCK_HEIGHT=${process.env.POCKETDEX_STOP_AT_BLOCK_HEIGHT} reached`);
  }
}

// indexingHandler, referenced in project.ts
async function _indexingHandler(block: CosmosBlock): Promise<void> {
  evaluateBlockHeightStop(block.header.height);

  logger.info(`[indexer.manager] start indexing block=${block.block.header.height}`);
  // allow us to log an understanding which type/typeUrl we are still missing a handler.
  const unhandledMsgTypes = new Set<string>();
  const unhandledEventTypes = new Set<string>();

  const moduleAccounts = await handleModuleAccounts(block);
  // this prevents having to ask/validate for messy events on each handler.
  const isValidEvent = (evt: CosmosEvent): boolean => {
    // on any block
    // the value is not an account module
    // type != message (does not provide useful information)
    // key=amount with value="" (does not help at all because do not modify)
    // valid events on height 1

    // only tx or msg kind - anything else
    const isMessageType = evt.event.type === "message";
    // we don't care if is a message not mater anything else
    if (isMessageType) {
      return false;
    }
    const hasValidAmount = hasValidAmountAttribute(evt);

    if (!hasValidAmount) {
      return false;
    }
    const isModuleAccount = evt.event.attributes.some(
      (attr) =>
        (attr.value as string).startsWith(PREFIX) &&
        moduleAccounts.has(attr.value as string),
    );

    const isCoinReceived = evt.event.type === CoinReceiveType;
    const isCoinSpent = evt.event.type === CoinSpentType;
    // we track module account balances on our own so we don't need them
    return !(isModuleAccount && (isCoinReceived || isCoinSpent));
  };

  // Apply the composed filter
  const filteredEvents = block.events.filter(isValidEvent);

  // generate msg map by type base on the MsgHandlers declared at src/mappings/handlers.ts
  logger.info(`[indexer.manager] handling txs=${block.transactions.length} messages=${block.messages.length} events=${filteredEvents.length}`);

  const msgsByType: Partial<MessageByType> = {};
  const msgHandlersSet = new Set(Object.keys(MsgHandlers));
  // ensure every key as an empty array
  msgHandlersSet.forEach((typeUrl) => msgsByType[typeUrl] = []);
  block.messages.forEach((msg) => {
    const typeUrl = msg.msg.typeUrl;
    if (!msgHandlersSet.has(typeUrl)) {
      unhandledMsgTypes.add(typeUrl);
      return;
    }
    msgsByType[typeUrl]?.push(msg);
  });

  // generate events map by type base on the EventHandlers declared at src/mappings/handlers.ts
  const eventsByType: EventByType = {};
  // "coin_received", "coin_spent" are special cases that we need to take care carefully in the most fast and accurate
  // way
  const eventHandlersSet = new Set([...Object.keys(EventHandlers), CoinReceiveType, CoinSpentType]);
  // ensure every key as an empty array
  eventHandlersSet.forEach((type) => eventsByType[type] = []);
  filteredEvents.forEach((event) => {
    const type = event.event.type;
    if (!eventHandlersSet.has(type)) {
      unhandledEventTypes.add(type);
      return;
    }
    eventsByType[type]?.push(event);
  });

  const jsonArrayCounter = (_: string, value: unknown) => {
    if (value instanceof Array) {
      return value.length;
    }
    return value;
  };
  if (unhandledMsgTypes.size > 0) {
    logger.warn(`[indexer.manager] unhandledMsgTypes=${stringify(Array.from(unhandledMsgTypes))} msgsByType=${stringify(msgsByType, jsonArrayCounter, 0)}`);
  }
  if (unhandledEventTypes.size > 0) {
    logger.warn(`[indexer.manager] unhandledEventTypes=${stringify(Array.from(unhandledEventTypes))} eventsByType=${stringify(eventsByType, jsonArrayCounter, 0)}`);
  }

  await profilerWrap(indexPrimitives, "indexingHandler", "indexPrimitives")(block, filteredEvents);

  await Promise.all([
    profilerWrap(indexBalances, "indexingHandler", "indexBalances")(block, msgsByType as MessageByType, eventsByType),
    profilerWrap(indexParams, "indexingHandler", "indexParams")(msgsByType as MessageByType),
    profilerWrap(indexService, "indexingHandler", "indexService")(msgsByType as MessageByType),
    profilerWrap(indexValidators, "indexingHandler", "indexValidators")(msgsByType as MessageByType, eventsByType),
    profilerWrap(indexStake, "indexingHandler", "indexStake")(msgsByType as MessageByType, eventsByType),
    profilerWrap(indexRelays, "indexingHandler", "indexRelays")(msgsByType as MessageByType, eventsByType),
    profilerWrap(generateReports, "indexingHandler", "generateReports")(block),
  ])
}

export async function indexingHandler(block: CosmosBlock): Promise<void> {
  await profilerWrap(_indexingHandler, "all", "index.manager")(block);
}

