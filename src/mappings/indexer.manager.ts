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
  isEventOfFinalizedBlockKind,
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
    "poktroll.proof.EventProofValidityChecked",
    "poktroll.tokenomics.EventApplicationOverserviced",
    "poktroll.tokenomics.EventApplicationReimbursementRequest"
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
async function indexService(msgByType: MessageByType, eventByType: EventByType): Promise<void> {
  const eventTypes = [
    "poktroll.service.EventRelayMiningDifficultyUpdated",
  ];
  const msgTypes = [
    "/poktroll.service.MsgAddService",
  ];

  await indexStakeEntity([
    ...msgTypes.map(type => msgByType[type]).flat(),
    ...eventTypes.map(type => eventByType[type]).flat()
  ], {
    "/poktroll.service.MsgAddService": "service.id",
    "poktroll.service.EventRelayMiningDifficultyUpdated": (attributes) => {
      for (const attribute of attributes) {
        if (attribute.key === "service_id") {
          return JSON.parse(attribute.value as string).service_id
        }
      }

      return null
    }
  })
}

// any application msg or event
async function indexApplications(msgByType: MessageByType, eventByType: EventByType): Promise<void> {
  const msgTypes = [
    "/poktroll.application.MsgDelegateToGateway",
    "/poktroll.application.MsgUndelegateFromGateway",
    "/poktroll.application.MsgUnstakeApplication",
    "/poktroll.application.MsgStakeApplication",
    "/poktroll.application.MsgTransferApplication",
  ];
  const eventTypes = [
    "poktroll.application.EventTransferBegin",
    "poktroll.application.EventTransferEnd",
    "poktroll.application.EventTransferError",
    "poktroll.application.EventApplicationUnbondingBegin",
    "poktroll.application.EventApplicationUnbondingEnd",
  ];

  const getIdOfTransferEvents = (attributes: CosmosEvent['event']["attributes"]) => {
    return attributes.find(({key}) => key === "source_address")?.value as string
  }

  const getIdOfBondingEvents = (attributes: CosmosEvent['event']["attributes"]) => {
    for (const {key, value} of attributes) {
      if (key !== "application") continue

      return JSON.parse(value as string).address
    }

    return null
  }

  await indexStakeEntity([
    ...msgTypes.map(type => msgByType[type]).flat(),
    ...eventTypes.map(type => eventByType[type]).flat()
  ],
  {
    "/poktroll.application.MsgDelegateToGateway": "appAddress",
    "/poktroll.application.MsgUndelegateFromGateway": "appAddress",
    "/poktroll.application.MsgUnstakeApplication": "address",
    "/poktroll.application.MsgStakeApplication": "address",
    "/poktroll.application.MsgTransferApplication": "sourceAddress",
    "poktroll.application.EventTransferBegin": getIdOfTransferEvents,
    "poktroll.application.EventTransferEnd": (attributes) => {
      // here we need to return two ids (id of the source and id of the destination app)
      // to group the data of those two apps
      const ids: Array<string> = []

      for (const {key, value} of attributes) {
        if (key === 'source_address' || key === 'destination_address') {
          // the source address is surrounded by quotes
          ids.push((value as string).replaceAll("\"", ""))
        }

        if (ids.length === 2) break
      }

      return ids
    },
    "poktroll.application.EventTransferError": getIdOfTransferEvents,
    "poktroll.application.EventApplicationUnbondingBegin": getIdOfBondingEvents,
    "poktroll.application.EventApplicationUnbondingEnd": getIdOfBondingEvents,
  })
}

// any gateway msg or event
async function indexGateway(msgByType: MessageByType, eventByType: EventByType): Promise<void> {
  const msgTypes = [
    "/poktroll.gateway.MsgUnstakeGateway",
    "/poktroll.gateway.MsgStakeGateway",
  ];
  const eventTypes = [
    "poktroll.gateway.EventGatewayUnstaked",
    "poktroll.gateway.EventGatewayUnbondingBegin",
    "poktroll.gateway.EventGatewayUnbondingEnd",
  ];

  const getIdOfUnbondingEvents = (attributes: CosmosEvent["event"]["attributes"]) => {
    for (const {key, value} of attributes) {
      if (key !== "gateway") continue
      return JSON.parse(value as string).address
    }
    return null
  }

  await indexStakeEntity([
    ...msgTypes.map(type => msgByType[type]).flat(),
    ...eventTypes.map(type => eventByType[type]).flat()
  ],
  {
    "/poktroll.gateway.MsgStakeGateway": "address",
    "/poktroll.gateway.MsgUnstakeGateway": "address",
    "poktroll.gateway.EventGatewayUnstaked": getIdOfUnbondingEvents,
    "poktroll.gateway.EventGatewayUnbondingBegin": getIdOfUnbondingEvents,
    "poktroll.gateway.EventGatewayUnbondingEnd": getIdOfUnbondingEvents,

  })
}

// this is used to group more than one entity that are updated in the same handler
// for example, when a EventTransferEnd is emitted, two appliations are updated
function groupConnectedComponents(arrays: string[][]): string[][] {
  const adjacencyList = new Map<string, Set<string>>();

  // Build adjacency list
  for (const group of arrays) {
    for (const item of group) {
      if (!adjacencyList.has(item)) {
        adjacencyList.set(item, new Set());
      }
      for (const other of group) {
        if (item !== other) {
          adjacencyList.get(item)!.add(other);
        }
      }
    }
  }

  const visited = new Set<string>();
  const result: string[][] = [];

  // DFS function to traverse components
  function dfs(node: string, component: string[]) {
    if (visited.has(node)) return;
    visited.add(node);
    component.push(node);
    for (const neighbor of adjacencyList.get(node) || []) {
      dfs(neighbor, component);
    }
  }

  // Find all connected components
  for (const node of adjacencyList.keys()) {
    if (!visited.has(node)) {
      const component: string[] = [];
      dfs(node, component);
      result.push(component.sort()); // Sort for consistency
    }
  }

  return result;
}

type GetIdFromEventAttribute = (attributes: CosmosEvent["event"]["attributes"]) => string | Array<string>;

/*
This function is used to call handlers in order to avoid updating the same entity twice or more at the same time
  data is an array of cosmos events or messages
  getEntityIdArg is a record of string or function that returns a string,
    for messages it is the path of the decodedMsg to get the entity id
    for events it is a function that receives the attributes and returns the entity id
*/
async function indexStakeEntity(data: Array<CosmosEvent | CosmosMessage>, getEntityIdArg: Record<string, string | GetIdFromEventAttribute>) {
  // this is to handle events where more than one stake entity is updated
  // like in _handleTransferApplicationEndEvent handler
  const entitiesUpdatedAtSameDatum: Array<Array<string>> = [];
  const dataByEntityId: Record<string, {
    finalizedEvents: Array<CosmosEvent>,
    // rank here is used to mark messages as 0 and events as 1 to sort ascending
    // prioritizing messages over events (that are not finalized events)
    nonFinalizedData: Array<(CosmosEvent | CosmosMessage) & {rank: 1 | 0}>
  }> = {}


  for (const datum of data) {
    // if event in datum them is a cosmos event
    if ('event' in datum) {
      const getEntityId = getEntityIdArg[datum.event.type] as GetIdFromEventAttribute

      if (!getEntityId) throw new Error(`getIdFromEventAttribute not found for event type ${datum.event.type}`)
      let entityId = getEntityId(datum.event.attributes)

      if (Array.isArray(entityId)) {
        entitiesUpdatedAtSameDatum.push(entityId)
        // we are only taking the first one because later we will get the data for every entity in this group
        // it is redundant to save the data for every entity in this group
        entityId = entityId.at(0)!
      }

      // some events have their attributes values in double quotes
      // so we need to remove them, it is better to remove them here instead of in the handler
      entityId = entityId.replaceAll('"', '')

      if (!dataByEntityId[entityId]) {
        dataByEntityId[entityId] = {
          finalizedEvents: [],
          nonFinalizedData: [],
        }
      }

      const isFinalizedBlockEvent = isEventOfFinalizedBlockKind(datum)

      dataByEntityId[entityId][isFinalizedBlockEvent ? 'finalizedEvents' : 'nonFinalizedData'].push({
        ...datum,
          rank: 1,
      })
    } else {
      const entityIdPath = getEntityIdArg[datum.msg.typeUrl] as string
      if (!entityIdPath) throw new Error(`getIdFromEventAttribute not found for msg type ${datum.msg.typeUrl}`)

      const entityId = get(datum.msg.decodedMsg, entityIdPath)

      if (!dataByEntityId[entityId]) {
        dataByEntityId[entityId] = {
          finalizedEvents: [],
          nonFinalizedData: [],
        }
      }

      dataByEntityId[entityId].nonFinalizedData.push({
        ...datum,
        rank: 0
      })
    }
  }

  // this is to group entities that were updated in the same event/msg
  for (const groupedConnectedEntities of groupConnectedComponents(entitiesUpdatedAtSameDatum)) {
    const id = groupedConnectedEntities.join('-')

    const finalizedEvents: Array<CosmosEvent> = []
    const nonFinalizedData: Array<(CosmosEvent | CosmosMessage) & {rank: 1|0}> = []

    for (const entity of groupedConnectedEntities) {
      const data = dataByEntityId[entity]
      if (!data) continue

      finalizedEvents.push(...data.finalizedEvents)
      nonFinalizedData.push(...data.nonFinalizedData)
      delete dataByEntityId[entity]
    }

    dataByEntityId[id] = {
      finalizedEvents,
      nonFinalizedData
    }
  }

  await Promise.all(
    Object.entries(dataByEntityId).map(async ([id,data]) => {
      const finalizedEvents = orderBy(data.finalizedEvents, ['idx'], ['asc'])
      const nonFinalizedData = orderBy(data.nonFinalizedData, ['tx.idx', 'rank', 'idx'], ['asc', 'asc', 'asc'])

      for (const nonFinalizedDatum of nonFinalizedData) {
        if ('event' in nonFinalizedDatum) {
          await EventHandlers[nonFinalizedDatum.event.type]([nonFinalizedDatum])
        } else {
          await MsgHandlers[nonFinalizedDatum.msg.typeUrl]([nonFinalizedDatum])
        }
      }

      for (const finalizedEvent of finalizedEvents) {
        await EventHandlers[finalizedEvent.event.type]([finalizedEvent])
      }
    })
  )
}

// any supplier msg or event
async function indexSupplier(msgByType: MessageByType, eventByType: EventByType): Promise<void> {
  const msgTypes = [
    "/poktroll.supplier.MsgUnstakeSupplier",
    "/poktroll.supplier.MsgStakeSupplier",
  ];
  const eventTypes = [
    "poktroll.supplier.EventSupplierUnbondingBegin",
    "poktroll.supplier.EventSupplierUnbondingEnd",
    // this is here because it modifies the staked tokens of the supplier
    "poktroll.tokenomics.EventSupplierSlashed"
  ];


  const eventGetId = (attributes: CosmosEvent["event"]["attributes"]) => {
    for (const attribute of attributes) {
      if (attribute.key !== "supplier") continue
      return JSON.parse(attribute.value as string).operator_address
    }

    return null
  }

  await indexStakeEntity(
    [
      ...msgTypes.map(type => msgByType[type]).flat(),
      ...eventTypes.map(type => eventByType[type]).flat()
    ],
  {
    "/poktroll.supplier.MsgUnstakeSupplier": "operatorAddress",
    "/poktroll.supplier.MsgStakeSupplier": "operatorAddress",
    "poktroll.supplier.EventSupplierUnbondingBegin": eventGetId,
    "poktroll.supplier.EventSupplierUnbondingEnd": eventGetId,
    "poktroll.tokenomics.EventSupplierSlashed": (attributes) => {
      for (const attribute of attributes) {
        if (attribute.key === "claim") {
          return JSON.parse(attribute.value as string).supplier_operator_address
        }
      }

      return null
    }
  })
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
    profilerWrap(indexService, "indexingHandler", "indexService")(msgsByType as MessageByType, eventsByType),
    profilerWrap(indexValidators, "indexingHandler", "indexValidators")(msgsByType as MessageByType, eventsByType),
    profilerWrap(indexStake, "indexingHandler", "indexStake")(msgsByType as MessageByType, eventsByType),
    profilerWrap(indexRelays, "indexingHandler", "indexRelays")(msgsByType as MessageByType, eventsByType),
    profilerWrap(generateReports, "indexingHandler", "generateReports")(block),
  ])
}

export async function indexingHandler(block: CosmosBlock): Promise<void> {
  await profilerWrap(_indexingHandler, "all", "index.manager")(block);
}

