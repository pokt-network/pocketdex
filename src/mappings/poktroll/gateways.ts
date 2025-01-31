import {
  CosmosEvent,
  CosmosMessage,
  CosmosTransaction,
} from "@subql/types-cosmos";
import {
  EventGatewayUnstaked as EventGatewayUnstakedEntity,
  Gateway,
  MsgStakeGateway as MsgStakeGatewayEntity,
  MsgUnstakeGateway as MsgUnstakeGatewayEntity,
  StakeStatus,
} from "../../types";
import {
  MsgStakeGateway,
  MsgUnstakeGateway,
} from "../../types/proto-interfaces/poktroll/gateway/tx";
import {
  getBlockId,
  getEventId,
  messageId,
} from "../utils/ids";


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


async function _handleGatewayUnstakeEvent(
  event: CosmosEvent,
) {
  const tx = event.tx as CosmosTransaction;

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

  gateway.unstakingEndBlockId = getBlockId(event.block);
  gateway.stakeStatus = StakeStatus.Unstaked;

  const eventId = getEventId(event);

  await Promise.all([
    EventGatewayUnstakedEntity.create({
      id: eventId,
      gatewayId: gatewayAddress,
      blockId: getBlockId(event.block),
      transactionId: tx.hash,
      eventId,
    }).save(),
    gateway.save(),
  ]);
}


// TODO: update this to work with BatchMessage handler
// handleGatewayMsgStake, referenced in project.ts
export async function handleGatewayMsgStake(msg: CosmosMessage<MsgStakeGateway>): Promise<void> {
  await _handleGatewayMsgStake(msg);
}

// TODO: update this to work with BatchMessage handler
// handleGatewayMsgStake, referenced in project.ts
export async function handleGatewayMsgUnstake(msg: CosmosMessage<MsgUnstakeGateway>): Promise<void> {
  await _handleGatewayMsgUnstake(msg);
}

// TODO: update this to work with BatchMessage handler
// handleGatewayMsgStake, referenced in project.ts
export async function handleGatewayUnstakeEvent(event: CosmosEvent): Promise<void> {
  await _handleGatewayUnstakeEvent(event);
}
