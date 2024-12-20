import {
  CosmosEvent,
  CosmosMessage,
} from "@subql/types-cosmos";
import { applicationUnbondingReasonFromJSON } from "../../client/poktroll/application/event";
import {
  Application,
  ApplicationGateway,
  ApplicationService,
  EventApplicationUnbondingBegin as EventApplicationUnbondingBeginEntity,
  EventApplicationUnbondingEnd as EventApplicationUnbondingEndEntity,
  EventTransferBegin as EventTransferBeginEntity,
  EventTransferEnd as EventTransferEndEntity,
  EventTransferError as EventTransferErrorEntity,
  MsgDelegateToGateway as MsgDelegateToGatewayEntity,
  MsgStakeApplication as MsgStakeApplicationEntity,
  MsgTransferApplication as MsgTransferApplicationEntity,
  MsgUndelegateFromGateway as MsgUndelegateFromGatewayEntity,
  MsgUnstakeApplication as MsgUnstakeApplicationEntity,
} from "../../types";
import { ApplicationGatewayProps } from "../../types/models/ApplicationGateway";
import { ApplicationServiceProps } from "../../types/models/ApplicationService";
import { MsgStakeApplicationServiceProps } from "../../types/models/MsgStakeApplicationService";
import { EventTransferBegin } from "../../types/proto-interfaces/poktroll/application/event";
import {
  MsgDelegateToGateway,
  MsgStakeApplication,
  MsgTransferApplication,
  MsgUndelegateFromGateway,
  MsgUnstakeApplication,
} from "../../types/proto-interfaces/poktroll/application/tx";
import { ApplicationSDKType } from "../../types/proto-interfaces/poktroll/application/types";
import {
  ApplicationUnbondingReason,
  StakeStatus,
} from "../constants";
import {
  attemptHandling,
  unprocessedEventHandler,
  unprocessedMsgHandler,
} from "../utils/handlers";
import {
  getAppDelegatedToGatewayId,
  getEventId,
  getMsgStakeServiceId,
  getStakeServiceId,
  messageId,
} from "../utils/ids";
import { stringify } from "../utils/json";

export async function handleAppMsgStake(
  msg: CosmosMessage<MsgStakeApplication>,
): Promise<void> {
  await attemptHandling(msg, _handleAppMsgStake, unprocessedMsgHandler);
}

export async function handleDelegateToGatewayMsg(
  msg: CosmosMessage<MsgDelegateToGateway>,
): Promise<void> {
  await attemptHandling(msg, _handleDelegateToGatewayMsg, unprocessedMsgHandler);
}

export async function handleUndelegateFromGatewayMsg(
  msg: CosmosMessage<MsgUndelegateFromGateway>,
): Promise<void> {
  await attemptHandling(msg, _handleUndelegateFromGatewayMsg, unprocessedMsgHandler);
}

export async function handleUnstakeApplicationMsg(
  msg: CosmosMessage<MsgUnstakeApplication>,
): Promise<void> {
  await attemptHandling(msg, _handleUnstakeApplicationMsg, unprocessedMsgHandler);
}

export async function handleTransferApplicationMsg(
  msg: CosmosMessage<MsgTransferApplication>,
): Promise<void> {
  await attemptHandling(msg, _handleTransferApplicationMsg, unprocessedMsgHandler);
}

export async function handleTransferApplicationBeginEvent(
  event: CosmosEvent,
): Promise<void> {
  await attemptHandling(event, _handleTransferApplicationBeginEvent, unprocessedEventHandler);
}

export async function handleTransferApplicationEndEvent(
  event: CosmosEvent,
): Promise<void> {
  await attemptHandling(event, _handleTransferApplicationEndEvent, unprocessedEventHandler);
}

export async function handleTransferApplicationErrorEvent(
  event: CosmosEvent,
): Promise<void> {
  await attemptHandling(event, _handleTransferApplicationErrorEvent, unprocessedEventHandler);
}

export async function handleApplicationUnbondingEndEvent(
  event: CosmosEvent,
): Promise<void> {
  await attemptHandling(event, _handleApplicationUnbondingEndEvent, unprocessedEventHandler);
}

export async function handleApplicationUnbondingBeginEvent(
  event: CosmosEvent,
): Promise<void> {
  await attemptHandling(event, _handleApplicationUnbondingBeginEvent, unprocessedEventHandler);
}

async function _handleAppMsgStake(
  msg: CosmosMessage<MsgStakeApplication>,
): Promise<void> {
  logger.debug(`[handleAppMsgStake] (msg.msg): ${stringify(msg.msg, undefined, 2)}`);

  const msgId = messageId(msg);
  const { address, stake } = msg.msg.decodedMsg;

  const stakeAmount = BigInt(stake?.amount || "0");
  const stakeDenom = stake?.denom || "";

  const appMsgStake = MsgStakeApplicationEntity.create({
    id: msgId,
    transactionId: msg.tx.hash,
    blockId: msg.block.block.id,
    applicationId: address,
    messageId: msgId,
    stakeAmount,
    stakeDenom,
  });

  const application = Application.create({
    id: address,
    accountId: address,
    stakeAmount,
    stakeDenom,
    stakeStatus: StakeStatus.Staked,
  });

  const servicesId: Array<string> = [];
  // used to create the services that came in the stake message
  const appMsgStakeServices: Array<MsgStakeApplicationServiceProps> = [];
  // used to have the services that are currently configured for the application
  const newApplicationServices: Array<ApplicationServiceProps> = [];

  for (const { serviceId } of msg.msg.decodedMsg.services) {
    servicesId.push(serviceId);

    appMsgStakeServices.push({
      id: getMsgStakeServiceId(msgId, serviceId),
      serviceId,
      stakeMsgId: msgId,
    });

    newApplicationServices.push({
      id: getStakeServiceId(address, serviceId),
      serviceId,
      applicationId: address,
    });
  }

  const currentAppServices = await ApplicationService.getByApplicationId(address, {});

  const servicesToRemove: Array<string> = [];

  if (currentAppServices && currentAppServices.length > 0) {
    for (const service of currentAppServices) {
      if (!servicesId.includes(service.serviceId)) {
        servicesToRemove.push(service.id);
      }
    }
  }

  const promises: Array<Promise<void>> = [
    appMsgStake.save(),
    application.save(),
    store.bulkCreate("MsgStakeApplicationService", appMsgStakeServices),
    store.bulkCreate("ApplicationService", newApplicationServices),
  ];

  if (servicesToRemove.length > 0) {
    promises.push(store.bulkRemove("ApplicationService", servicesToRemove));
  }

  await Promise.all(promises);
}

async function _handleDelegateToGatewayMsg(
  msg: CosmosMessage<MsgDelegateToGateway>,
) {
  logger.debug(`[handleDelegateToGatewayMsg] (msg.msg): ${stringify(msg.msg, undefined, 2)})`);

  const msgId = messageId(msg);

  await Promise.all([
    ApplicationGateway.create({
      id: getAppDelegatedToGatewayId(
        msg.msg.decodedMsg.appAddress,
        msg.msg.decodedMsg.gatewayAddress,
      ),
      gatewayId: msg.msg.decodedMsg.gatewayAddress,
      applicationId: msg.msg.decodedMsg.appAddress,
    }).save(),
    MsgDelegateToGatewayEntity.create({
      id: msgId,
      applicationId: msg.msg.decodedMsg.appAddress,
      gatewayId: msg.msg.decodedMsg.gatewayAddress,
      transactionId: msg.tx.hash,
      blockId: msg.block.block.id,
      messageId: msgId,
    }).save(),
  ]);
}

async function _handleUndelegateFromGatewayMsg(
  msg: CosmosMessage<MsgUndelegateFromGateway>,
) {
  logger.debug(`[handleUndelegateFromGatewayMsg] (msg.msg): ${stringify(msg.msg, undefined, 2)}`);

  const msgId = messageId(msg);

  await Promise.all([
    ApplicationGateway.remove(
      getAppDelegatedToGatewayId(
        msg.msg.decodedMsg.appAddress,
        msg.msg.decodedMsg.gatewayAddress,
      ),
    ),
    MsgUndelegateFromGatewayEntity.create({
      id: msgId,
      applicationId: msg.msg.decodedMsg.appAddress,
      gatewayId: msg.msg.decodedMsg.gatewayAddress,
      transactionId: msg.tx.hash,
      blockId: msg.block.block.id,
      messageId: msgId,
    }).save(),
  ]);
}

async function _handleUnstakeApplicationMsg(
  msg: CosmosMessage<MsgUnstakeApplication>,
) {
  logger.debug(`[handleUnstakeApplicationMsg] (msg.msg): ${stringify(msg.msg, undefined, 2)}`);

  const application = await Application.get(msg.msg.decodedMsg.address);

  if (!application) {
    throw new Error(`[handleUnstakeApplicationMsg] application not found for address ${msg.msg.decodedMsg.address}`);
  }

  application.stakeStatus = StakeStatus.Unstaking;
  application.unstakingBeginBlockId = msg.block.block.id;

  const msgId = messageId(msg);

  await Promise.all([
    application.save(),
    MsgUnstakeApplicationEntity.create({
      id: msgId,
      applicationId: msg.msg.decodedMsg.address,
      transactionId: msg.tx.hash,
      blockId: msg.block.block.id,
      messageId: msgId,
    }).save(),
  ]);
}

async function _handleTransferApplicationMsg(
  msg: CosmosMessage<MsgTransferApplication>,
) {
  logger.debug(`[handleTransferApplicationMsg] (msg.msg): ${stringify(msg.msg, undefined, 2)}`);

  const application = await Application.get(msg.msg.decodedMsg.sourceAddress);

  if (!application) {
    throw new Error(`[handleTransferApplicationMsg] source application not found for address ${msg.msg.decodedMsg.sourceAddress}`);
  }

  application.transferringToId = msg.msg.decodedMsg.destinationAddress;

  const msgId = messageId(msg);

  await Promise.all([
    application.save(),
    MsgTransferApplicationEntity.create({
      id: msgId,
      sourceApplicationId: msg.msg.decodedMsg.sourceAddress,
      destinationApplicationId: msg.msg.decodedMsg.destinationAddress,
      transactionId: msg.tx.hash,
      blockId: msg.block.block.id,
      messageId: msgId,
    }).save(),
  ]);
}

async function _handleTransferApplicationBeginEvent(
  event: CosmosEvent,
) {
  logger.debug(`[handleTransferApplicationBeginEvent] (event.msg): ${stringify(event.msg, undefined, 2)}`);
  const msg: CosmosMessage<EventTransferBegin> = event.msg;

  const transferEndHeight = event.event.attributes.find(attribute => attribute.key === "transfer_end_height")?.value as string;

  if (!transferEndHeight) {
    throw new Error(`[handleTransferApplicationBeginEvent] transferEndHeight not found`);
  }

  const application = await Application.get(msg.msg.decodedMsg.sourceAddress);

  if (!application) {
    throw new Error(`[handleTransferApplicationBeginEvent] application not found`);
  }

  application.transferEndHeight = BigInt((transferEndHeight as unknown as string).replaceAll("\"", ""));

  const eventId = getEventId(event);

  await Promise.all([
    application.save(),
    EventTransferBeginEntity.create({
      id: eventId,
      sourceId: msg.msg.decodedMsg.sourceAddress,
      destinationId: msg.msg.decodedMsg.destinationAddress,
      transactionId: event.tx.hash,
      blockId: event.block.block.id,
      eventId,
    }).save(),
  ]);
}

async function _handleTransferApplicationEndEvent(
  event: CosmosEvent,
) {
  logger.debug(`[handleTransferApplicationEndEvent] (event.event): ${stringify(event.event, undefined, 2)}`);

  let sourceAddress = event.event.attributes.find(attribute => attribute.key === "source_address")?.value as unknown as string;

  if (!sourceAddress) {
    throw new Error(`[handleTransferApplicationEndEvent] event.event.attributes not found`);
  }

  // the source address is surrounded by quotes
  sourceAddress = sourceAddress.replaceAll("\"", "");

  const sourceApplication = await Application.get(sourceAddress);

  if (!sourceApplication) {
    throw new Error(`[handleTransferApplicationMsg] source application not found for address ${sourceAddress}`);
  }

  sourceApplication.transferringToId = undefined;
  sourceApplication.transferEndHeight = undefined;
  sourceApplication.transferEndBlockId = event.block.block.id;
  sourceApplication.stakeStatus = StakeStatus.Unstaked;
  sourceApplication.unstakingReason = ApplicationUnbondingReason.TRANSFERRED;
  sourceApplication.unstakingEndBlockId = event.block.block.id;

  const destinationAppStringified = event.event.attributes.find(attribute => attribute.key === "destination_application")?.value as string;

  if (!destinationAppStringified) {
    throw new Error(`[handleTransferApplicationMsg] destination application not in event`);
  }

  const destinationApp: Required<ApplicationSDKType> = JSON.parse(destinationAppStringified);

  sourceApplication.destinationApplicationId = destinationApp.address;

  const { delegatee_gateway_addresses, service_configs } = destinationApp;
  const stake = destinationApp.stake as Required<typeof destinationApp.stake>;

  const destinationApplication = Application.create({
    id: destinationApp.address,
    accountId: destinationApp.address,
    stakeAmount: BigInt(stake.amount),
    stakeDenom: stake.denom,
    stakeStatus: StakeStatus.Staked,
    sourceApplicationId: sourceAddress,
    transferredFromAtId: event.block.block.id,
    unstakingEndBlockId: sourceApplication.unstakingEndBlockId,
    unstakingBeginBlockId: sourceApplication.unstakingBeginBlockId,
  });

  const appDelegatedToGateways: Array<ApplicationGatewayProps> = delegatee_gateway_addresses.map(gateway => ({
    id: getAppDelegatedToGatewayId(destinationApplication.id, gateway),
    applicationId: destinationApplication.id,
    gatewayId: gateway,
  }));

  const sourceApplicationServices = await ApplicationService.getByApplicationId(sourceAddress, {}) || [];
  const sourceApplicationGateways = await ApplicationGateway.getByApplicationId(sourceAddress, {}) || [];
  const newApplicationServices: Array<ApplicationServiceProps> = service_configs?.map(service => ({
    id: getStakeServiceId(destinationApp.address, service.service_id),
    serviceId: service.service_id,
    applicationId: destinationApp.address,
  })) || [];

  const eventId = getEventId(event);

  await Promise.all([
    sourceApplication.save(),
    destinationApplication.save(),
    EventTransferEndEntity.create({
      id: eventId,
      sourceId: sourceAddress,
      destinationId: destinationApp.address,
      blockId: event.block.block.id,
      eventId,
    }).save(),
    store.bulkCreate("ApplicationService", newApplicationServices),
    store.bulkCreate("ApplicationGateway", appDelegatedToGateways),
    store.bulkRemove("ApplicationService", sourceApplicationServices.map(service => service.id)),
    store.bulkRemove("ApplicationGateway", sourceApplicationGateways.map(item => item.id)),
  ]);
}

async function _handleTransferApplicationErrorEvent(
  event: CosmosEvent,
) {
  logger.debug(`[handleTransferApplicationErrorEvent] (event.event): ${stringify(event.event, undefined, 2)}`);

  let sourceAddress = "", destinationAddress = "", error = "";

  for (const attribute of event.event.attributes) {
    if (attribute.key === "source_address") {
      sourceAddress = (attribute.value as unknown as string).replaceAll("\"", "");
    }

    if (attribute.key === "destination_address") {
      destinationAddress = (attribute.value as unknown as string).replaceAll("\"", "");
    }

    if (attribute.key === "error") {
      error = (attribute.value as unknown as string).replaceAll("\"", "");
    }
  }

  if (!sourceAddress) {
    throw new Error(`[handleTransferApplicationEndEvent] source_address not found in event`);
  }

  if (!destinationAddress) {
    throw new Error(`[handleTransferApplicationErrorEvent] destination_address not found in event`);
  }

  if (!error) {
    throw new Error(`[handleTransferApplicationErrorEvent] error not found in event`);
  }

  const application = await Application.get(sourceAddress);

  if (!application) {
    throw new Error(`[handleTransferApplicationErrorEvent] application not found for address ${sourceAddress}`);
  }

  application.transferringToId = undefined;
  application.transferEndHeight = undefined;

  const eventId = getEventId(event);

  await Promise.all([
    application.save(),
    EventTransferErrorEntity.create({
      id: eventId,
      sourceId: sourceAddress,
      destinationId: destinationAddress,
      error: error,
      blockId: event.block.block.id,
      eventId,
    }).save(),
  ]);
}

async function _handleApplicationUnbondingBeginEvent(
  event: CosmosEvent,
) {
  logger.debug(`[handleApplicationUnbondingBeginEvent] (event.event): ${stringify(event.event, undefined, 2)}`);

  const msg: CosmosMessage<MsgUnstakeApplication> = event.msg;

  let unstakingEndHeight = BigInt(0), sessionEndHeight: bigint, reason: number;

  for (const attribute of event.event.attributes) {
    if (attribute.key === "unbonding_end_height") {
      unstakingEndHeight = BigInt((attribute.value as unknown as string).replaceAll("\"", ""));
    }

    if (attribute.key === "session_end_height") {
      sessionEndHeight = BigInt((attribute.value as unknown as string).replaceAll("\"", ""));
    }

    if (attribute.key === "reason") {
      reason = applicationUnbondingReasonFromJSON((attribute.value as unknown as string).replaceAll("\"", ""));
    }
  }

  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  if (unstakingEndHeight === BigInt(0)) {
    throw new Error(`[handleApplicationUnbondingBeginEvent] unbondingEndHeight not found in event`);
  }

  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  if (!sessionEndHeight) {
    throw new Error(`[handleApplicationUnbondingBeginEvent] sessionEndHeight not found in event`);
  }

  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  if (!reason) {
    throw new Error(`[handleApplicationUnbondingBeginEvent] reason not found in event`);
  }

  const application = await Application.get(msg.msg.decodedMsg.address);

  if (!application) {
    throw new Error(`[handleApplicationUnbondingBeginEvent] application not found for operator address ${msg.msg.decodedMsg.address}`);
  }

  application.unstakingEndHeight = unstakingEndHeight;
  // comes form the event and parsing it using applicationUnbondingReasonFromJSON function
  application.unstakingReason = reason;

  const eventId = getEventId(event);

  await Promise.all([
    application.save(),
    EventApplicationUnbondingBeginEntity.create({
      id: eventId,
      applicationId: msg.msg.decodedMsg.address,
      blockId: event.block.block.id,
      unstakingEndHeight,
      sessionEndHeight,
      reason,
      eventId,
    }).save(),
  ]);
}

async function _handleApplicationUnbondingEndEvent(
  event: CosmosEvent,
) {
  logger.debug(`[handleApplicationUnbondingEndEvent] (event.event): ${stringify(event.event, undefined, 2)}`);

  let unstakingEndHeight: bigint, sessionEndHeight: bigint, reason: number, applicationSdk: ApplicationSDKType;


  for (const attribute of event.event.attributes) {
    if (attribute.key === "unbonding_end_height") {
      unstakingEndHeight = BigInt((attribute.value as unknown as string).replaceAll("\"", ""));
    }

    if (attribute.key === "session_end_height") {
      sessionEndHeight = BigInt((attribute.value as unknown as string).replaceAll("\"", ""));
    }

    if (attribute.key === "reason") {
      reason = applicationUnbondingReasonFromJSON((attribute.value as unknown as string).replaceAll("\"", ""));
    }

    if (attribute.key === "application") {
      applicationSdk = JSON.parse(attribute.value as unknown as string);
    }
  }

  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  if (!unstakingEndHeight) {
    throw new Error(`[handleApplicationUnbondingEndEvent] unbondingEndHeight not found in event`);
  }

  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  if (!sessionEndHeight) {
    throw new Error(`[handleApplicationUnbondingEndEvent] sessionEndHeight not found in event`);
  }

  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  if (!reason) {
    throw new Error(`[handleApplicationUnbondingEndEvent] reason not found in event`);
  }

  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  if (!applicationSdk) {
    throw new Error(`[handleApplicationUnbondingEndEvent] application not found in event`);
  }

  const application = await Application.get(applicationSdk.address);

  if (!application) {
    throw new Error(`[handleApplicationUnbondingEndEvent] application not found for address ${applicationSdk.address}`);
  }

  application.unstakingEndBlockId = event.block.block.id;
  application.stakeStatus = StakeStatus.Unstaked;
  application.unstakingReason = reason;

  const applicationServices = (await ApplicationService.getByApplicationId(applicationSdk.address, {}) || []).map(item => item.id);

  const eventId = getEventId(event);

  await Promise.all([
    EventApplicationUnbondingEndEntity.create({
      id: eventId,
      blockId: event.block.block.id,
      sessionEndHeight,
      unstakingEndHeight,
      reason,
      applicationId: applicationSdk.address,
      eventId,
    }).save(),
    application.save(),
    store.bulkRemove("ApplicationService", applicationServices),
  ]);
}
