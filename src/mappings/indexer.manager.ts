import {
  CosmosBlock,
  CosmosEvent,
  CosmosMessage,
} from "@subql/types-cosmos";
import {
  findIndex,
  get,
  orderBy,
} from "lodash";
import { parseCoins } from "../cosmjs/utils";
import { EventAttribute } from "../types";
import { NativeBalanceChangeProps } from "../types/models/NativeBalanceChange";
import {
  CoinReceiveType,
  CoinSpentType,
  enforceAccountsExistence,
  generateNativeBalanceChangeId,
  handleModuleAccounts,
  handleNativeBalanceChangesForAddressAndDenom,
  handleSupply,
} from "./bank";
import { PREFIX } from "./constants";
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
import {
  getBlockId,
  getEventId,
  messageId,
} from "./utils/ids";
import { stringify } from "./utils/json";
import {
  hasValidAmountAttribute,
  isEventOfMessageKind,
} from "./utils/primitives";

function handleByType(typeUrl: string | Array<string>, byTypeMap: MessageByType | EventByType, byTypeHandlers: typeof MsgHandlers | typeof EventHandlers): Array<Promise<void>> {
  const promises = [];
  const types = [];

  if (!Array.isArray(typeUrl)) {
    types.push(typeUrl);
  } else {
    types.push(...typeUrl);
  }

  for (const type of types) {
    const docs = byTypeMap[type];
    if (docs.length > 0) {
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
  const msg = msgByType[typeUrl];
  const addressMsgMap: Record<string, Array<CosmosMessage>> = {};

  if (msg.length === 0) {
    return;
  }

  msg.forEach((msg) => {
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
  await handleGenesis(block);

  // primitives
  const primitiveHandlers: Array<Promise<void>> = [
    handleBlock(block),
    handleSupply(block),
    handleTransactions(block.transactions),
    handleMessages(block.messages),
  ];

  if (events.length > 0) {
    primitiveHandlers.push(handleEvents(events));
  }

  await Promise.all(primitiveHandlers);
}

// anything that modifies balances
async function indexBalances(block: CosmosBlock, msgByType: MessageByType, eventByType: EventByType): Promise<void> {
  // reconstruct account balances for non-module accounts
  const uniqueAddressSet = new Set<string>();
  const addressDenomMap: Record<string, Array<NativeBalanceChangeProps>> = {};
  const nativeBalanceChanges: Array<NativeBalanceChangeProps> = [];
  const balanceModificationEvents = [...eventByType[CoinReceiveType] ?? [], ...eventByType[CoinSpentType] ?? []];
  const blockId = getBlockId(block);

  balanceModificationEvents.forEach((event) => {
    const keyIndex = findIndex((event.event.attributes as Array<EventAttribute>), (attr) => attr.key === "receiver" || attr.key === "spender");

    if (keyIndex === -1) {
      throw new Error(
        `Event ${event.event.type} does not have a receiver or spender attribute`,
      );
    }

    const attribute = event.event.attributes[keyIndex];

    const address = attribute.value as string;

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
  });

  const promises: Array<Promise<void>> = [];

  for (const [addressDenom, changes] of Object.entries(addressDenomMap)) {
    const [address, denom] = addressDenom.split("-");
    promises.push(handleNativeBalanceChangesForAddressAndDenom(address, denom, changes, blockId));
  }

  const msgTypes = [
    "/cosmos.bank.v1beta1.MsgSend",
  ];

  promises.push(
    // create a native transfer entity
    ...handleByType(msgTypes, msgByType, MsgHandlers),
    // track native balance changes
    store.bulkCreate("NativeBalanceChange", nativeBalanceChanges),
    // ensure accounts exists in bulk
    enforceAccountsExistence(Array.from(uniqueAddressSet).map(address => ({
      account: {
        id: address,
        chainId,
        firstBlockId: getBlockId(block),
      },
    }))),
  );

  await Promise.all(promises);
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
    ...handleByType(msgTypes, msgByType, MsgHandlers),
    ...handleByType(eventTypes, eventByType, EventHandlers),
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
    ...handleByType(msgTypes, msgByType, MsgHandlers),
    ...handleByType(eventTypes, eventByType, EventHandlers),
  ]);
}

// any message or event related to Params
async function indexParams(msgByType: MessageByType): Promise<void> {
  await Promise.all(
    handleByType("/cosmos.authz.v1beta1.MsgExec", msgByType, MsgHandlers),
  );
}

// any service msg or event
async function indexService(msgByType: MessageByType): Promise<void> {
  await Promise.all(
    handleByType("/poktroll.service.MsgAddService", msgByType, MsgHandlers),
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
    // handle possible edge case where same entity receive on same block multiple stake msgs
    handleStakeMsgs(
      "/poktroll.application.MsgStakeApplication",
      "address",
      msgByType,
    ),
    // any other non-stake msgs/events
    ...handleByType(msgTypes, msgByType, MsgHandlers),
    ...handleByType(eventTypes, eventByType, EventHandlers),
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

  await Promise.all([
    // handle possible edge case where same entity receive on same block multiple stake msgs
    handleStakeMsgs(
      "/poktroll.gateway.MsgStakeGateway",
      "address",
      msgByType,
    ),
    // any other non-stake msgs/events
    ...handleByType(msgTypes, msgByType, MsgHandlers),
    ...handleByType(eventTypes, eventByType, EventHandlers),
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

  await Promise.all([
    // handle possible edge case where same entity receive on same block multiple stake msgs
    handleStakeMsgs(
      "/poktroll.supplier.MsgStakeSupplier",
      "operatorAddress",
      msgByType,
    ),
    // any other non-stake msgs/events
    ...handleByType(msgTypes, msgByType, MsgHandlers),
    ...handleByType(eventTypes, eventByType, EventHandlers),
  ]);
}

// any message or event related to stake (supplier, gateway, application, service)
async function indexStake(msgByType: MessageByType, eventByType: EventByType): Promise<void> {
  await Promise.all([
    indexApplications(msgByType, eventByType),
    indexGateway(msgByType, eventByType),
    indexSupplier(msgByType, eventByType),
  ]);
}

// any report call
async function generateReports(): Promise<void> {
  return Promise.resolve();
}

// indexingHandler, referenced in project.ts
export async function indexingHandler(block: CosmosBlock): Promise<void> {
  logger.info(`start indexing block=${block.block.header.height}`)
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

    const isModuleAccount = !evt.event.attributes.some(
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
  // "coin_received", "coin_spent" are special cases that we need to take care carefully in the most fast and accurate
  // way
  const eventHandlersSet = new Set([...Object.keys(EventHandlers), CoinReceiveType, CoinSpentType]);
  // ensure every key as an empty array
  eventHandlersSet.forEach((type) => eventsByType[type] = []);
  filteredEvents.forEach((event) => {
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

  await indexPrimitives(block, filteredEvents);

  await Promise.all([
    indexBalances(block, msgsByType as MessageByType, eventsByType),
    indexParams(msgsByType as MessageByType),
    indexService(msgsByType as MessageByType),
    indexValidators(msgsByType as MessageByType, eventsByType),
    indexStake(msgsByType as MessageByType, eventsByType),
    indexRelays(msgsByType as MessageByType, eventsByType),
  ]);

  await generateReports();
}

// TODO: use below cli command to verify random account balances at random block in order to know if we are
//  properly reconstructing the balances.
//  CLI: poktrolld query bank balance [address] upokt --node=https://testnet-validated-validator-rpc.poktroll.com
