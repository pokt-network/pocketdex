import {
  CosmosEvent,
  CosmosMessage,
} from "@subql/types-cosmos";
import {
  EventGatewayUnstaked as EventGatewayUnstakedEntity,
  Gateway,
  MsgStakeGateway as MsgStakeGatewayEntity,
  MsgUnstakeGateway as MsgUnstakeGatewayEntity,
} from "../../types";
import {
  MsgStakeGateway,
  MsgUnstakeGateway,
} from "../../types/proto-interfaces/poktroll/gateway/tx";
import { StakeStatus } from "../constants";
import {
  attemptHandling,
  unprocessedEventHandler,
  unprocessedMsgHandler,
} from "../utils/handlers";
import {
  getEventId,
  messageId,
} from "../utils/ids";
import { stringify } from "../utils/json";

export async function handleGatewayMsgStake(msg: CosmosMessage<MsgStakeGateway>): Promise<void> {
  await attemptHandling(msg, _handleGatewayMsgStake, unprocessedMsgHandler);
}

export async function handleGatewayMsgUnstake(msg: CosmosMessage<MsgUnstakeGateway>): Promise<void> {
  await attemptHandling(msg, _handleGatewayMsgUnstake, unprocessedMsgHandler);
}

export async function handleGatewayUnstakeEvent(event: CosmosEvent): Promise<void> {
  await attemptHandling(event, _handleGatewayUnstakeEvent, unprocessedEventHandler);
}

async function _handleGatewayMsgStake(
  msg: CosmosMessage<MsgStakeGateway>,
) {
  logger.debug(`[handleGatewayMsgStake] (msg.msg): ${stringify(msg.msg, undefined, 2)}`);

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
      blockId: msg.block.block.id,
      transactionId: msg.tx.hash,
      messageId: msgId,
    }).save(),
    gateway.save(),
  ]);
}

async function _handleGatewayMsgUnstake(
  msg: CosmosMessage<MsgUnstakeGateway>,
) {
  logger.debug(`[handleGatewayMsgUnstake] (msg.msg): ${stringify(msg.msg, undefined, 2)}`);
  const gateway = await Gateway.get(msg.msg.decodedMsg.address);

  if (!gateway) {
    throw new Error(`[handleGatewayMsgUnstake] gateway not found with address: ${msg.msg.decodedMsg.address}`);
  }

  gateway.stakeStatus = StakeStatus.Unstaking;
  gateway.unstakingBeginBlockId = msg.block.block.id;

  const msgId = messageId(msg);

  await Promise.all([
    gateway.save(),
    MsgUnstakeGatewayEntity.create({
      id: msgId,
      transactionId: msg.tx.hash,
      blockId: msg.block.block.id,
      gatewayId: msg.msg.decodedMsg.address,
      messageId: msgId,
    }).save(),
  ]);
}


async function _handleGatewayUnstakeEvent(
  event: CosmosEvent,
) {
  logger.debug(`[handleGatewayUnstakeEvent] (event.event): ${stringify(event.event, undefined, 2)}`);

  const gatewayStringified = event.event.attributes.find(attribute => attribute.key === "gateway")?.value as unknown as string;

  if (!gatewayStringified) {
    throw new Error(`[handleGatewayUnstakeEvent] gateway not provided in event`);
  }

  const gatewayAddress = JSON.parse(gatewayStringified).address;

  if (!gatewayAddress) {
    throw new Error(`[handleGatewayUnstakeEvent] address not provided in gateway event`);
  }

  const gateway = await Gateway.get(gatewayAddress);

  if (!gateway) {
    throw new Error(`[handleGatewayMsgUnstake] gateway not found with address: ${gatewayAddress}`);
  }

  gateway.unstakingEndBlockId = event.block.block.id;
  gateway.stakeStatus = StakeStatus.Unstaked;

  const eventId = getEventId(event);

  await Promise.all([
    EventGatewayUnstakedEntity.create({
      id: eventId,
      gatewayId: gatewayAddress,
      blockId: event.block.block.id,
      transactionId: event.tx.hash,
      eventId,
    }).save(),
    gateway.save(),
  ]);
}
