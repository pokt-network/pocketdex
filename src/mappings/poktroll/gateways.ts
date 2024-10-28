import { CosmosEvent, CosmosMessage } from "@subql/types-cosmos";
import { Gateway, GatewayStakeMsg, GatewayUnstakedEvent, GatewayUnstakeMsg, StakeStatus } from "../../types";
import { MsgStakeGateway, MsgUnstakeGateway } from "../../types/proto-interfaces/poktroll/gateway/tx";
import {
  attemptHandling,
  getEventId,
  messageId,
  stringify,
  unprocessedEventHandler,
  unprocessedMsgHandler,
} from "../utils";

export async function handleGatewayMsgStake(msg: CosmosMessage<MsgStakeGateway>): Promise<void> {
  await attemptHandling(msg, _handleGatewayMsgStake, unprocessedMsgHandler)
}

export async function handleGatewayMsgUnstake(msg: CosmosMessage<MsgUnstakeGateway>): Promise<void> {
  await attemptHandling(msg, _handleGatewayMsgUnstake, unprocessedMsgHandler)
}

export async function handleGatewayUnstakeEvent(event: CosmosEvent): Promise<void> {
  await attemptHandling(event, _handleGatewayUnstakeEvent, unprocessedEventHandler);
}

async function _handleGatewayMsgStake(
  msg: CosmosMessage<MsgStakeGateway>
) {
  logger.info(`[handleGatewayMsgStake] (msg.msg): ${stringify(msg.msg, undefined, 2)}`);

  if (!msg.msg.decodedMsg.stake) {
    throw new Error(`[handleGatewayMsgStake] stake not provided in msg`)
  }

  const stake = {
    amount: msg.msg.decodedMsg.stake.amount,
    denom: msg.msg.decodedMsg.stake.denom,
  }

  const gateway = Gateway.create({
    id: msg.msg.decodedMsg.address,
    stake,
    accountId: msg.msg.decodedMsg.address,
    status: StakeStatus.Staked,
    unbondingStartBlockId: undefined,
    unbondedAtBlockId: undefined
  })

  await Promise.all([
    GatewayStakeMsg.create({
      id: messageId(msg),
      gatewayId: msg.msg.decodedMsg.address,
      stake,
      blockId: msg.block.block.id,
      transactionId: msg.tx.hash
    }).save(),
    gateway.save()
  ])
}

async function _handleGatewayMsgUnstake(
  msg: CosmosMessage<MsgUnstakeGateway>
) {
  logger.info(`[handleGatewayMsgUnstake] (msg.msg): ${stringify(msg.msg, undefined, 2)}`);
  const gateway = await Gateway.get(msg.msg.decodedMsg.address)

  if (!gateway) {
    throw new Error(`[handleGatewayMsgUnstake] gateway not found with address: ${msg.msg.decodedMsg.address}`);
  }

  gateway.status = StakeStatus.Unstaking
  gateway.unbondingStartBlockId = msg.block.block.id

  await Promise.all([
    gateway.save(),
    GatewayUnstakeMsg.create({
      id: messageId(msg),
      transactionId: msg.tx.hash,
      blockId: msg.block.block.id,
      gatewayId: msg.msg.decodedMsg.address
    }).save()
  ])
}


async function _handleGatewayUnstakeEvent(
  event: CosmosEvent
) {
  logger.info(`[handleGatewayUnstakeEvent] (event.event): ${stringify(event.event, undefined, 2)}`);

  const gatewayStringified = event.event.attributes.find(attribute => attribute.key === "gateway")?.value as unknown as string

  if (!gatewayStringified) {
    throw new Error(`[handleGatewayUnstakeEvent] gateway not provided in event`);
  }

  const gatewayAddress = JSON.parse(gatewayStringified).address

  if (!gatewayAddress) {
    throw new Error(`[handleGatewayUnstakeEvent] address not provided in gateway event`);
  }

  const gateway = await Gateway.get(gatewayAddress)

  if (!gateway) {
    throw new Error(`[handleGatewayMsgUnstake] gateway not found with address: ${gatewayAddress}`);
  }

  gateway.unbondedAtBlockId = event.block.block.id
  gateway.status = StakeStatus.Unstaked

  await Promise.all([
    GatewayUnstakedEvent.create({
      id: getEventId(event),
      gatewayId: gatewayAddress,
      blockId: event.block.block.id,
      transactionId: event.tx.hash
    }).save(),
    gateway.save()
  ])
}
