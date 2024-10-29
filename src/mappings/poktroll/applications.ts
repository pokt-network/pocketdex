import { CosmosEvent, CosmosMessage } from "@subql/types-cosmos";
import {
  Application,
  ApplicationDelegatedToGateway,
  ApplicationService,
  ApplicationUnbondingReason,
  AppMsgStake,
  AppMsgUnstake,
  EventApplicationUnbondingBegin,
  EventApplicationUnbondingEnd,
  MsgDelegateToGateway as MsgDelegateToGatewayEntity,
  MsgTransferApplication as MsgTransferApplicationEntity,
  MsgUndelegateToGateway as MsgUndelegateToGatewayEntity,
  StakeStatus,
  TransferApplicationBeginEvent,
  TransferApplicationEndEvent,
  TransferApplicationErrorEvent,
} from "../../types";
import { ApplicationDelegatedToGatewayProps } from "../../types/models/ApplicationDelegatedToGateway";
import { ApplicationServiceProps } from "../../types/models/ApplicationService";
import { AppMsgStakeServiceProps } from "../../types/models/AppMsgStakeService";
import {
  ApplicationUnbondingReason as ApplicationUnbondingReasonSDK,
  applicationUnbondingReasonFromJSON,
  EventTransferBegin,
} from "../../types/proto-interfaces/poktroll/application/event";
import {
  MsgDelegateToGateway,
  MsgStakeApplication,
  MsgTransferApplication,
  MsgUndelegateFromGateway,
  MsgUnstakeApplication,
} from "../../types/proto-interfaces/poktroll/application/tx";
import { ApplicationSDKType } from "../../types/proto-interfaces/poktroll/application/types";
import {
  attemptHandling,
  getAppDelegatedToGatewayId,
  getEventId,
  getMsgStakeServiceId,
  getStakeServiceId,
  messageId,
  stringify,
  unprocessedEventHandler,
  unprocessedMsgHandler,
} from "../utils";

export async function handleAppMsgStake(
  msg: CosmosMessage<MsgStakeApplication>,
): Promise<void> {
  await attemptHandling(msg, _handleAppMsgStake, unprocessedMsgHandler)
}

export async function handleDelegateToGatewayMsg(
  msg: CosmosMessage<MsgDelegateToGateway>,
): Promise<void> {
  await attemptHandling(msg, _handleDelegateToGatewayMsg, unprocessedMsgHandler)
}

export async function handleUndelegateFromGatewayMsg(
  msg: CosmosMessage<MsgUndelegateFromGateway>,
): Promise<void> {
  await attemptHandling(msg, _handleUndelegateFromGatewayMsg, unprocessedMsgHandler)
}

export async function handleUnstakeApplicationMsg(
  msg: CosmosMessage<MsgUnstakeApplication>,
): Promise<void> {
  await attemptHandling(msg, _handleUnstakeApplicationMsg, unprocessedMsgHandler)
}

export async function handleTransferApplicationMsg(
  msg: CosmosMessage<MsgTransferApplication>,
): Promise<void> {
  await attemptHandling(msg, _handleTransferApplicationMsg, unprocessedMsgHandler)
}

export async function handleTransferApplicationBeginEvent(
  event: CosmosEvent
): Promise<void> {
  await attemptHandling(event, _handleTransferApplicationBeginEvent, unprocessedEventHandler);
}

export async function handleTransferApplicationEndEvent(
  event: CosmosEvent
): Promise<void> {
  await attemptHandling(event, _handleTransferApplicationEndEvent, unprocessedEventHandler);
}

export async function handleTransferApplicationErrorEvent(
  event: CosmosEvent
): Promise<void> {
  await attemptHandling(event, _handleTransferApplicationErrorEvent, unprocessedEventHandler);
}

export async function handleApplicationUnbondingEndEvent(
  event: CosmosEvent
): Promise<void> {
  await attemptHandling(event, _handleApplicationUnbondingEndEvent, unprocessedEventHandler);
}

export async function handleApplicationUnbondingBeginEvent(
  event: CosmosEvent
): Promise<void> {
  await attemptHandling(event, _handleApplicationUnbondingBeginEvent, unprocessedEventHandler);
}

async function _handleAppMsgStake(
  msg: CosmosMessage<MsgStakeApplication>,
): Promise<void> {
  logger.debug(`[handleAppMsgStake] (msg.msg): ${stringify(msg.msg, undefined, 2)}`);

  const msgId = messageId(msg)
  const {address, stake,} = msg.msg.decodedMsg

  const stakeCoin = {
    amount: stake?.amount || '',
    denom: stake?.denom || '',
  }

  const appMsgStake =  AppMsgStake.create({
    id: msgId,
    stake: stakeCoin,
    transactionId: msg.tx.hash,
    blockId: msg.block.block.id,
    applicationId: address,
  });

  const application = Application.create({
    id: address,
    accountId: address,
    stake: stakeCoin,
    status: StakeStatus.Staked,
    unbondingStartBlockId: undefined,
    unbondedAtBlockId: undefined,
  })

  const servicesId: Array<string> = []
  const appMsgStakeServices: Array<AppMsgStakeServiceProps> = []
  const newApplicationServices: Array<ApplicationServiceProps> = []

  for (const {serviceId} of msg.msg.decodedMsg.services) {
    servicesId.push(serviceId)

    appMsgStakeServices.push({
      id: getMsgStakeServiceId(msgId, serviceId),
      serviceId,
      appStakeMsgId: msgId,
    })

    newApplicationServices.push({
      id: getStakeServiceId(address, serviceId),
      serviceId,
      applicationId: address,
    })
  }

  const currentAppServices = await ApplicationService.getByApplicationId(address, {})

  const servicesToRemove: Array<string> = []

  if (currentAppServices && currentAppServices.length > 0) {
    for (const service of currentAppServices) {
      if (!servicesId.includes(service.serviceId)) {
        servicesToRemove.push(service.id)
      }
    }
  }

  const promises: Array<Promise<void>> = [
    appMsgStake.save(),
    application.save(),
    store.bulkCreate('AppMsgStakeService', appMsgStakeServices),
    store.bulkCreate('ApplicationService', newApplicationServices),
  ]

  if (servicesToRemove.length > 0) {
    promises.push(store.bulkRemove('ApplicationService', servicesToRemove))
  }

  await Promise.all(promises)
}

async function _handleDelegateToGatewayMsg(
  msg: CosmosMessage<MsgDelegateToGateway>,
) {
  logger.debug(`[handleDelegateToGatewayMsg] (msg.msg): ${stringify(msg.msg, undefined, 2)})`)

  await Promise.all([
    ApplicationDelegatedToGateway.create({
      id: getAppDelegatedToGatewayId(
        msg.msg.decodedMsg.appAddress,
        msg.msg.decodedMsg.gatewayAddress
      ),
      gatewayId: msg.msg.decodedMsg.gatewayAddress,
      applicationId: msg.msg.decodedMsg.appAddress,
    }).save(),
    MsgDelegateToGatewayEntity.create({
      id: messageId(msg),
      applicationId: msg.msg.decodedMsg.appAddress,
      gatewayId: msg.msg.decodedMsg.gatewayAddress,
      transactionId: msg.tx.hash,
      blockId: msg.block.block.id,
    }).save()
  ])
}

async function _handleUndelegateFromGatewayMsg(
  msg: CosmosMessage<MsgUndelegateFromGateway>,
) {
  logger.debug(`[handleUndelegateFromGatewayMsg] (msg.msg): ${stringify(msg.msg, undefined, 2)}`)

  await Promise.all([
    ApplicationDelegatedToGateway.remove(
      getAppDelegatedToGatewayId(
        msg.msg.decodedMsg.appAddress,
        msg.msg.decodedMsg.gatewayAddress
      )
    ),
    MsgUndelegateToGatewayEntity.create({
      id: messageId(msg),
      applicationId: msg.msg.decodedMsg.appAddress,
      gatewayId: msg.msg.decodedMsg.gatewayAddress,
      transactionId: msg.tx.hash,
      blockId: msg.block.block.id,
    }).save()
  ])
}

async function _handleUnstakeApplicationMsg(
  msg: CosmosMessage<MsgUnstakeApplication>,
) {
  logger.debug(`[handleUnstakeApplicationMsg] (msg.msg): ${stringify(msg.msg, undefined, 2)}`)

  const application = await Application.get(msg.msg.decodedMsg.address)

  if (!application) {
    throw new Error(`[handleUnstakeApplicationMsg] application not found for address ${msg.msg.decodedMsg.address}`)
  }

  application.status = StakeStatus.Unstaking
  application.unbondingStartBlockId = msg.block.block.id

  await Promise.all([
    application.save(),
    AppMsgUnstake.create({
      id: messageId(msg),
      applicationId: msg.msg.decodedMsg.address,
      transactionId: msg.tx.hash,
      blockId: msg.block.block.id,
    }).save()
  ])
}

async function _handleTransferApplicationMsg(
  msg: CosmosMessage<MsgTransferApplication>,
) {
  logger.debug(`[handleTransferApplicationMsg] (msg.msg): ${stringify(msg.msg, undefined, 2)}`);

  const application = await Application.get(msg.msg.decodedMsg.sourceAddress)

  if (!application) {
    throw new Error(`[handleTransferApplicationMsg] source application not found for address ${msg.msg.decodedMsg.sourceAddress}`)
  }

  application.transferringToId = msg.msg.decodedMsg.destinationAddress

  await Promise.all([
    application.save(),
    MsgTransferApplicationEntity.create({
      id: messageId(msg),
      sourceApplicationId: msg.msg.decodedMsg.sourceAddress,
      destinationApplicationId: msg.msg.decodedMsg.destinationAddress,
      transactionId: msg.tx.hash,
      blockId: msg.block.block.id,
    }).save(),
  ])
}

async function _handleTransferApplicationBeginEvent(
  event: CosmosEvent
) {
  logger.debug(`[handleTransferApplicationBeginEvent] (event.msg): ${stringify(event.msg, undefined, 2)}`);
  const msg: CosmosMessage<EventTransferBegin> = event.msg

  const transferEndHeight = event.event.attributes.find(attribute => attribute.key === "transfer_end_height")?.value as string

  if (!transferEndHeight) {
    throw new Error(`[handleTransferApplicationBeginEvent] transferEndHeight not found`);
  }

  const application = await Application.get(msg.msg.decodedMsg.sourceAddress)

  if (!application) {
    throw new Error(`[handleTransferApplicationBeginEvent] application not found`);
  }

  application.transferEndsAtHeight = BigInt((transferEndHeight as unknown as string).replaceAll('"', ""))

  await Promise.all([
    application.save(),
    TransferApplicationBeginEvent.create({
      id: getEventId(event),
      sourceId: msg.msg.decodedMsg.sourceAddress,
      destinationId: msg.msg.decodedMsg.destinationAddress,
      transactionId: event.tx.hash,
      blockId: event.block.block.id
    }).save()
  ])
}

async function _handleTransferApplicationEndEvent(
  event: CosmosEvent
) {
  logger.debug(`[handleTransferApplicationEndEvent] (event.event): ${stringify(event.event, undefined, 2)}`);

  let sourceAddress = event.event.attributes.find(attribute => attribute.key === "source_address")?.value as unknown as string

  if (!sourceAddress) {
    throw new Error(`[handleTransferApplicationEndEvent] event.event.attributes not found`);
  }

  // the source address is surrounded by quotes
  sourceAddress = sourceAddress.replaceAll('"', "")

  const sourceApplication = await Application.get(sourceAddress)

  if (!sourceApplication) {
    throw new Error(`[handleTransferApplicationMsg] source application not found for address ${sourceAddress}`)
  }

  sourceApplication.transferringToId = undefined
  sourceApplication.transferEndsAtHeight = undefined
  sourceApplication.transferToEndedAtId = event.block.block.id
  sourceApplication.status = StakeStatus.Unstaked
  sourceApplication.unbondingReason = ApplicationUnbondingReason.TRANSFERRED
  sourceApplication.unbondedAtBlockId = event.block.block.id

  const destinationAppStringified = event.event.attributes.find(attribute => attribute.key === "destination_application")?.value as string

  if (!destinationAppStringified) {
    throw new Error(`[handleTransferApplicationMsg] destination application not in event`);
  }

  const destinationApp: Required<ApplicationSDKType> = JSON.parse(destinationAppStringified)

  sourceApplication.transferToId = destinationApp.address

  const {delegatee_gateway_addresses, service_configs,} = destinationApp
  const stake = destinationApp.stake as Required<typeof destinationApp.stake>

  const destinationApplication  = Application.create({
    id: destinationApp.address,
    accountId: destinationApp.address,
    stake: {
      amount: stake.amount,
      denom: stake.denom,
    },
    status: StakeStatus.Staked,
    transferFromId: sourceAddress,
    transferredFromAtId: event.block.block.id,
    unbondedAtBlockId: sourceApplication.unbondedAtBlockId,
    unbondingStartBlockId: sourceApplication.unbondingStartBlockId
  })

  const appDelegatedToGateways: Array<ApplicationDelegatedToGatewayProps> = delegatee_gateway_addresses.map(gateway => ({
    id: getAppDelegatedToGatewayId(destinationApplication.id, gateway),
    applicationId: destinationApplication.id,
    gatewayId: gateway,
  }))

  const sourceApplicationServices = await ApplicationService.getByApplicationId(sourceAddress, {}) || []
  const sourceApplicationGateways = await ApplicationDelegatedToGateway.getByApplicationId(sourceAddress, {}) || []
  const newApplicationServices: Array<ApplicationServiceProps> = service_configs?.map(service => ({
    id: getStakeServiceId(destinationApp.address, service.service_id),
    serviceId: service.service_id,
    applicationId: destinationApp.address,
  })) || []

  await Promise.all([
    sourceApplication.save(),
    destinationApplication.save(),
    TransferApplicationEndEvent.create({
      id: getEventId(event),
      sourceId: sourceAddress,
      destinationId: destinationApp.address,
      transactionId: event.tx?.hash,
      blockId: event.block.block.id
    }).save(),
    store.bulkCreate('ApplicationService', newApplicationServices),
    store.bulkCreate('ApplicationDelegatedToGateway', appDelegatedToGateways),
    store.bulkRemove('ApplicationService', sourceApplicationServices.map(service => service.id)),
    store.bulkRemove('ApplicationDelegatedToGateway', sourceApplicationGateways.map(item => item.id)),
  ])
}

async function _handleTransferApplicationErrorEvent(
  event: CosmosEvent
) {
  logger.debug(`[handleTransferApplicationErrorEvent] (event.event): ${stringify(event.event, undefined, 2)}`);

  let sourceAddress = '', destinationAddress = '', error = ''

  for (const attribute of event.event.attributes) {
    if (attribute.key === "source_address") {
      sourceAddress = (attribute.value as unknown as string).replaceAll('"', "")
    }

    if (attribute.key === "destination_address") {
      destinationAddress = (attribute.value as unknown as string).replaceAll('"', "")
    }

    if (attribute.key === "error") {
      error = (attribute.value as unknown as string).replaceAll('"', "")
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

  const application = await Application.get(sourceAddress)

  if (!application) {
    throw new Error(`[handleTransferApplicationErrorEvent] application not found for address ${sourceAddress}`)
  }

  application.transferringToId = undefined
  application.transferEndsAtHeight = undefined

  await Promise.all([
    application.save(),
    TransferApplicationErrorEvent.create({
      id: getEventId(event),
      sourceId: sourceAddress,
      destinationId: destinationAddress,
      error: error,
      transactionId: event.tx?.hash,
      blockId: event.block.block.id
    }).save(),
  ])
}

async function _handleApplicationUnbondingBeginEvent(
  event: CosmosEvent
) {
  logger.debug(`[handleApplicationUnbondingBeginEvent] (event.event): ${stringify(event.event, undefined, 2)}`);

  const msg: CosmosMessage<MsgUnstakeApplication> = event.msg;

  let unbondingEndHeight: bigint, sessionEndHeight: bigint, reason: ApplicationUnbondingReason

  for (const attribute of event.event.attributes) {
    if (attribute.key === "unbonding_end_height") {
      unbondingEndHeight = BigInt((attribute.value as unknown as string).replaceAll('"', ""))
    }

    if (attribute.key === "session_end_height") {
      sessionEndHeight = BigInt((attribute.value as unknown as string).replaceAll('"', ""))
    }

    if (attribute.key === "reason") {
      reason = applicationUnbondingReasonFromJSON(attribute.value as unknown as string) === ApplicationUnbondingReasonSDK.ELECTIVE ? ApplicationUnbondingReason.ELECTIVE : ApplicationUnbondingReason.BELOW_MIN_STAKE
    }
  }

  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  if (!unbondingEndHeight) {
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
    throw new Error(`[handleApplicationUnbondingBeginEvent] application not found for operator address ${msg.msg.decodedMsg.address}`)
  }

  application.unbondingHeight = unbondingEndHeight
  application.unbondingReason = reason

  await Promise.all([
    application.save(),
    EventApplicationUnbondingBegin.create({
      id: getEventId(event),
      applicationId: msg.msg.decodedMsg.address,
      blockId: event.block.block.id,
      transactionId: event.tx?.hash,
      unbondingEndHeight,
      sessionEndHeight,
      reason,
    }).save(),
  ])
}

async function _handleApplicationUnbondingEndEvent(
  event: CosmosEvent
) {
  logger.debug(`[handleApplicationUnbondingEndEvent] (event.event): ${stringify(event.event, undefined, 2)}`);

  let unbondingEndHeight: bigint, sessionEndHeight: bigint, reason: ApplicationUnbondingReason, applicationSdk: ApplicationSDKType


  for (const attribute of event.event.attributes) {
    if (attribute.key === "unbonding_end_height") {
      unbondingEndHeight = BigInt((attribute.value as unknown as string).replaceAll('"', ""))
    }

    if (attribute.key === "session_end_height") {
      sessionEndHeight = BigInt((attribute.value as unknown as string).replaceAll('"', ""))
    }

    if (attribute.key === "reason") {
      reason = applicationUnbondingReasonFromJSON((attribute.value as unknown as string).replaceAll('"', "")) === ApplicationUnbondingReasonSDK.ELECTIVE ? ApplicationUnbondingReason.ELECTIVE : ApplicationUnbondingReason.BELOW_MIN_STAKE
    }

    if (attribute.key === "application") {
      applicationSdk = JSON.parse(attribute.value as unknown as string)
    }
  }

  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  if (!unbondingEndHeight) {
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
    throw new Error(`[handleApplicationUnbondingEndEvent] application not found for address ${applicationSdk.address}`)
  }

  application.unbondedAtBlockId = event.block.block.id
  application.status = StakeStatus.Unstaked
  application.unbondingReason = reason

  const applicationServices = (await ApplicationService.getByApplicationId(applicationSdk.address, {}) || []).map(item => item.id)

  await Promise.all([
    EventApplicationUnbondingEnd.create({
      id: getEventId(event),
      blockId: event.block.block.id,
      sessionEndHeight,
      unbondingEndHeight,
      reason,
      applicationId: applicationSdk.address,
      transactionId: event.tx?.hash
    }).save(),
    application.save(),
    store.bulkRemove('ApplicationService', applicationServices),
  ])
}
