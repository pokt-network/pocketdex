import {
  CosmosEvent,
  CosmosMessage,
} from "@subql/types-cosmos";
import {
  EventGatewayUnbondingBegin,
  EventGatewayUnbondingEnd, EventGatewayUnstaked,
  Gateway,
  MsgStakeGateway as MsgStakeGatewayEntity,
  MsgUnstakeGateway as MsgUnstakeGatewayEntity,
  StakeStatus,
} from "../../types";
import {
  MsgStakeGateway,
  MsgUnstakeGateway,
} from "../../types/proto-interfaces/pocket/gateway/tx";
import { GatewaySDKType } from "../../types/proto-interfaces/pocket/gateway/types";
import {
  getBlockId,
  getEventId,
  messageId,
} from "../utils/ids";
import { fetchAllApplicationGatewayByGatewayId } from "./pagination";


async function _handleGatewayMsgStake(
  msg: CosmosMessage<MsgStakeGateway>,
) {
  // logger.debug(`[handleGatewayMsgStake] (msg.msg): ${stringify(msg.msg, undefined, 2)}`);

  if (!msg.msg.decodedMsg.stake) {
    throw new Error(`[handleGatewayMsgStake] stake not provided in msg`);
  }

  const stake = {
    amount: msg.msg.decodedMsg.stake.amount,
    denom: msg.msg.decodedMsg.stake.denom,
  };

  const gateway = Gateway.create({
    id: msg.msg.decodedMsg.address,
    stakeAmount: BigInt(stake.amount),
    stakeDenom: stake.denom,
    accountId: msg.msg.decodedMsg.address,
    stakeStatus: StakeStatus.Staked,
  });

  const msgId = messageId(msg);

  await Promise.all([
    MsgStakeGatewayEntity.create({
      id: msgId,
      gatewayId: msg.msg.decodedMsg.address,
      stakeAmount: BigInt(stake.amount),
      stakeDenom: stake.denom,
      blockId: getBlockId(msg.block),
      transactionId: msg.tx.hash,
      messageId: msgId,
    }).save(),
    gateway.save(),
  ]);
}

// This is being used to get the ApplicationGateway IDs by the Gateway ID
// that is being unstaked to remove those ApplicationGateway records
async function getUndelegatesForUnstakedGateway(gatewayId: string): Promise<Array<string>> {
  const applicationGateways = await fetchAllApplicationGatewayByGatewayId(gatewayId);

  return applicationGateways.map(applicationGateway => applicationGateway.id);
}

async function _handleGatewayMsgUnstake(
  msg: CosmosMessage<MsgUnstakeGateway>,
) {
  const gateway = await Gateway.get(msg.msg.decodedMsg.address);

  if (!gateway) {
    throw new Error(`[handleGatewayMsgUnstake] gateway not found with address: ${msg.msg.decodedMsg.address}`);
  }

  gateway.stakeStatus = StakeStatus.Unstaking;
  gateway.unstakingBeginBlockId = getBlockId(msg.block);

  const msgId = messageId(msg);

  await Promise.all([
    gateway.save(),
    MsgUnstakeGatewayEntity.create({
      id: msgId,
      transactionId: msg.tx.hash,
      blockId: getBlockId(msg.block),
      gatewayId: msg.msg.decodedMsg.address,
      messageId: msgId,
    }).save(),
  ]);
}

/*
  TODO(@Alann27): remove this event handler when we are sure beta and alpha are using
    EventGatewayUnbondingBegin, EventGatewayUnbondingEnd and EventGatewayUnbondingCanceled
*/
async function _handleGatewayUnstakeEvent(
  event: CosmosEvent,
) {
  const gatewayStringified = event.event.attributes.find(attribute => attribute.key === "gateway")?.value as unknown as string;

  if (!gatewayStringified) {
    throw new Error(`[handleGatewayUnstakeEvent] gateway not provided in event`);
  }

  const gatewayAddress = JSON.parse(gatewayStringified).address;

  if (!gatewayAddress) {
    throw new Error(`[handleGatewayUnstakeEvent] address not provided in gateway event`);
  }

  const [gateway, undelegates] = await Promise.all([
    Gateway.get(gatewayAddress),
    getUndelegatesForUnstakedGateway(gatewayAddress)
  ]);

  if (!gateway) {
    throw new Error(`[handleGatewayMsgUnstake] gateway not found with address: ${gatewayAddress}`);
  }

  gateway.unstakingEndBlockId = getBlockId(event.block);
  gateway.stakeStatus = StakeStatus.Unstaked;

  const eventId = getEventId(event);


  await Promise.all([
    EventGatewayUnstaked.create({
      id: eventId,
      gatewayId: gatewayAddress,
      blockId: getBlockId(event.block),
      transactionId: event.tx.hash,
      eventId,
    }).save(),
    gateway.save(),
    store.bulkRemove("ApplicationGateway", undelegates),
  ]);
}

async function _handleEventGatewayUnbondingBegin(event: CosmosEvent) {
  let unstakingEndHeight: bigint | null = null, sessionEndHeight: bigint | null = null, gatewaySdk: GatewaySDKType | null = null;

  for (const attribute of event.event.attributes) {
    if (attribute.key === "unbonding_end_height") {
      unstakingEndHeight = BigInt((attribute.value as unknown as string).replaceAll("\"", ""));
    }

    if (attribute.key === "session_end_height") {
      sessionEndHeight = BigInt((attribute.value as unknown as string).replaceAll("\"", ""));
    }

    if (attribute.key === "gateway") {
      gatewaySdk = JSON.parse(attribute.value as unknown as string);
    }
  }

  if (!unstakingEndHeight) {
    throw new Error(`[handleEventGatewayUnbondingBegin] unstakingEndHeight not found in event`);
  }

  if (!sessionEndHeight) {
    throw new Error(`[handleEventGatewayUnbondingBegin] sessionEndHeight not found in event`);
  }

  if (!gatewaySdk) {
    throw new Error(`[handleEventGatewayUnbondingBegin] gateway not found in event`);
  }

  const gateway = await Gateway.get(gatewaySdk.address);

  if (!gateway) {
    throw new Error(`[handleEventGatewayUnbondingBegin] gateway not found for address ${gatewaySdk.address}`);
  }

  gateway.unstakingEndHeight = unstakingEndHeight;

  const eventId = getEventId(event);

  await Promise.all([
    EventGatewayUnbondingBegin.create({
      id: eventId,
      unbondingEndHeight: unstakingEndHeight,
      sessionEndHeight,
      gatewayId: gateway.id,
      blockId: getBlockId(event.block),
      eventId,
      transactionId: event.tx.hash,
    }).save(),
    gateway.save(),
  ]);
}

async function _handleEventGatewayUnbondingEnd(event: CosmosEvent) {
  let unstakingEndHeight: bigint | null = null, sessionEndHeight: bigint | null = null, gatewaySdk: GatewaySDKType | null = null;

  for (const attribute of event.event.attributes) {
    if (attribute.key === "unbonding_end_height") {
      unstakingEndHeight = BigInt((attribute.value as unknown as string).replaceAll("\"", ""));
    }

    if (attribute.key === "session_end_height") {
      sessionEndHeight = BigInt((attribute.value as unknown as string).replaceAll("\"", ""));
    }

    if (attribute.key === "gateway") {
      gatewaySdk = JSON.parse(attribute.value as unknown as string);
    }
  }

  if (!unstakingEndHeight) {
    throw new Error(`[handleEventGatewayUnbondingEnd] unstakingEndHeight not found in event`);
  }

  if (!sessionEndHeight) {
    throw new Error(`[handleEventGatewayUnbondingEnd] sessionEndHeight not found in event`);
  }

  if (!gatewaySdk) {
    throw new Error(`[handleEventGatewayUnbondingEnd] gateway not found in event`);
  }

  const [gateway, undelegates] = await Promise.all([
    Gateway.get(gatewaySdk.address),
    getUndelegatesForUnstakedGateway(gatewaySdk.address)
  ]);

  if (!gateway) {
    throw new Error(`[handleEventGatewayUnbondingEnd] gateway not found for address ${gatewaySdk.address}`);
  }

  gateway.unstakingEndBlockId = unstakingEndHeight;
  gateway.stakeStatus = StakeStatus.Unstaked;

  const eventId = getEventId(event);

  await Promise.all([
    EventGatewayUnbondingEnd.create({
      id: eventId,
      unbondingEndHeight: unstakingEndHeight,
      sessionEndHeight,
      gatewayId: gateway.id,
      blockId: getBlockId(event.block),
      eventId,
    }).save(),
    gateway.save(),
    store.bulkRemove("ApplicationGateway", undelegates),
  ]);
}

export async function handleGatewayMsgStake(messages: Array<CosmosMessage<MsgStakeGateway>>): Promise<void> {
  await Promise.all(messages.map(_handleGatewayMsgStake));
}

export async function handleGatewayMsgUnstake(messages: Array<CosmosMessage<MsgUnstakeGateway>>): Promise<void> {
  await Promise.all(messages.map(_handleGatewayMsgUnstake));
}

export async function handleGatewayUnstakeEvent(events: Array<CosmosEvent>): Promise<void> {
  await Promise.all(events.map(_handleGatewayUnstakeEvent));
}

export async function handleEventGatewayUnbondingBegin(events: Array<CosmosEvent>): Promise<void> {
  await Promise.all(events.map(_handleEventGatewayUnbondingBegin));
}

export async function handleEventGatewayUnbondingEnd(events: Array<CosmosEvent>): Promise<void> {
  await Promise.all(events.map(_handleEventGatewayUnbondingEnd));
}
