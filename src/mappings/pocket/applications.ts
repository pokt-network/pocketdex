import { toHex } from "@cosmjs/encoding";
import {
  CosmosEvent,
  CosmosMessage,
} from "@subql/types-cosmos";
import { get, orderBy } from "lodash";
import { Coin } from "../../client/cosmos/base/v1beta1/coin";
import {
  ApplicationUnbondingReason as ApplicationUnbondingReasonSDKType,
  applicationUnbondingReasonFromJSON,
} from "../../client/pocket/application/event";
import {
  Application,
  ApplicationGateway, ApplicationService,
  ApplicationUnbondingReason,
  Param,
  StakeStatus,
} from "../../types";
import { ApplicationProps } from "../../types/models/Application";
import { ApplicationGatewayProps } from "../../types/models/ApplicationGateway";
import { ApplicationServiceProps } from "../../types/models/ApplicationService";
import { EventApplicationUnbondingBeginProps } from "../../types/models/EventApplicationUnbondingBegin";
import { EventApplicationUnbondingEndProps } from "../../types/models/EventApplicationUnbondingEnd";
import { EventTransferBeginProps } from "../../types/models/EventTransferBegin";
import { EventTransferEndProps } from "../../types/models/EventTransferEnd";
import { EventTransferErrorProps } from "../../types/models/EventTransferError";
import { MsgClaimMorseApplicationProps } from "../../types/models/MsgClaimMorseApplication";
import { MsgDelegateToGatewayProps } from "../../types/models/MsgDelegateToGateway";
import { MsgStakeApplicationProps } from "../../types/models/MsgStakeApplication";
import { MsgTransferApplicationProps } from "../../types/models/MsgTransferApplication";
import { MsgUndelegateFromGatewayProps } from "../../types/models/MsgUndelegateFromGateway";
import { MsgUnstakeApplicationProps } from "../../types/models/MsgUnstakeApplication";
import { CoinSDKType } from "../../types/proto-interfaces/cosmos/base/v1beta1/coin";
import { EventTransferBegin } from "../../types/proto-interfaces/pocket/application/event";
import {
  MsgDelegateToGateway,
  MsgStakeApplication,
  MsgTransferApplication,
  MsgUndelegateFromGateway,
  MsgUnstakeApplication,
} from "../../types/proto-interfaces/pocket/application/tx";
import { ApplicationSDKType } from "../../types/proto-interfaces/pocket/application/types";
import { MsgClaimMorseApplication } from "../../types/proto-interfaces/pocket/migration/tx";
import { ClaimSDKType } from "../../types/proto-interfaces/pocket/proof/types";
import { AuthzExecMsg } from "../types";
import { EventByType, MessageByType } from "../types/common";
import { GetIdFromEventAttribute, RecordGetId } from "../types/stake";
import {
  fetchPaginatedRecords,
  getSequelize,
  getStoreModel,
  optimizedBulkCreate,
} from "../utils/db";
import {
  getAppDelegatedToGatewayId,
  getBlockId,
  getEventId,
  getStakeServiceId,
  messageId,
} from "../utils/ids";
import { parseAttribute, parseJson } from "../utils/json";
import {
  filterEventsByTxStatus, filterMsgByTxStatus,
  getDenomAndAmount, isEventOfFinalizedBlockKind,
} from "../utils/primitives";
import {
  Ed25519,
  pubKeyToAddress,
} from "../utils/pub_key";
import { _handleUpdateParam } from "./params";

function getAppUnbondingReasonFromSDK(item: ApplicationUnbondingReasonSDKType | string | number): ApplicationUnbondingReason {
  switch (item) {
    case 0:
    case ApplicationUnbondingReasonSDKType.APPLICATION_UNBONDING_REASON_ELECTIVE:
    case "APPLICATION_UNBONDING_REASON_ELECTIVE":{
      return ApplicationUnbondingReason.ELECTIVE
    }
    case 1:
    case ApplicationUnbondingReasonSDKType.APPLICATION_UNBONDING_REASON_BELOW_MIN_STAKE:
    case "APPLICATION_UNBONDING_REASON_BELOW_MIN_STAKE":{
      return ApplicationUnbondingReason.BELOW_MINIMUM_STAKE
    }
    case 2:
    case ApplicationUnbondingReasonSDKType.APPLICATION_UNBONDING_REASON_MIGRATION:
    case "APPLICATION_UNBONDING_REASON_MIGRATION":{
      return ApplicationUnbondingReason.MIGRATION
    }
    default:
      throw new Error(`Unknown ApplicationUnbondingReason=${item}`)
  }
}

function getServices(
  rawServices: MsgStakeApplication['services'],
  address: string,
  existingServicesId: Array<string>
) {
  // to compare with the current services and know which one to remove
  const servicesId: Array<string> = [];
  // services to save
  const services: Array<ApplicationServiceProps> = [];

  for (const { serviceId } of rawServices) {
    servicesId.push(serviceId);

    services.push({
      id: getStakeServiceId(address, serviceId),
      serviceId,
      applicationId: address,
    });
  }

  const servicesToRemove: Array<string> = [];

  for (const serviceId of existingServicesId) {
    if (!servicesId.includes(serviceId)) {
      servicesToRemove.push(serviceId);
    }
  }

  return {
    servicesToRemove,
    services,
  }
}

function _handleAppMsgStake(
  msg: CosmosMessage<MsgStakeApplication>,
  record: Record<string, {
    application?: ApplicationProps,
    services?: Record<string, ApplicationServiceProps>,
    gateways?: Record<string, ApplicationGatewayProps>,
  }>
): {
  application: ApplicationProps,
  msgStakeApplication: MsgStakeApplicationProps,
  services: Array<ApplicationServiceProps>,
  servicesToRemove: Array<string>,
} {
  if (!msg.msg.decodedMsg.stake) {
    throw new Error(`[handleAppMsgStake] stake not provided in msg`);
  }

  const { address, services: rawServices, stake } = msg.msg.decodedMsg;

  const msgId = messageId(msg);

  const prevApp = record[address]?.application;

  return {
    application: {
      id: address,
      accountId: address,
      stakeAmount: BigInt(stake.amount),
      stakeDenom: stake.denom,
      stakeStatus: StakeStatus.Staked,
      transferringToId: prevApp?.transferringToId,
      transferEndHeight: prevApp?.transferEndHeight,
      unstakingEndHeight: undefined,
      unstakingEndBlockId: undefined,
      unstakingBeginBlockId: undefined,
      unstakingReason: undefined,
    },
    msgStakeApplication: {
      id: msgId,
      transactionId: msg.tx.hash,
      blockId: getBlockId(msg.block),
      applicationId: address,
      messageId: msgId,
      stakeAmount: BigInt(stake.amount),
      stakeDenom: stake.denom,
    },
    ...getServices(
      rawServices,
      address,
      Object.keys(record[address]?.services || {})
    )
  }
}

function _handleMsgClaimMorseApplication(
  msg: CosmosMessage<MsgClaimMorseApplication>,
  record: Record<string, {
    application?: ApplicationProps,
    services?: Record<string, ApplicationServiceProps>,
    gateways?: Record<string, ApplicationGatewayProps>,
  }>
): {
  application: ApplicationProps,
  msgClaimMorseApplication: MsgClaimMorseApplicationProps,
  services: Array<ApplicationServiceProps>,
  servicesToRemove: Array<string>,
} {
  const msgId = messageId(msg);
  const { shannonDestAddress } = msg.msg.decodedMsg;

  let stakeCoin: Coin | null = null, balanceCoin: Coin | null = null, app: ApplicationSDKType | null = null;

  for (const event of msg.tx.tx.events) {
    if (event.type === 'pocket.migration.EventMorseApplicationClaimed') {
      for (const attribute of event.attributes) {
        if (attribute.key === 'claimed_balance') {
          const coin: CoinSDKType = getDenomAndAmount(attribute.value as string);
          balanceCoin = {
            denom: coin.denom,
            amount: coin.amount,
          }
        }

        if (attribute.key === 'claimed_application_stake') {
          const coin: CoinSDKType = getDenomAndAmount(attribute.value as string);
          stakeCoin = {
            denom: coin.denom,
            amount: coin.amount,
          }
        }

        if (attribute.key === 'application') {
          app = JSON.parse(attribute.value as string);
        }
      }
    }
  }

  if (!stakeCoin) {
    throw new Error(`[handleMsgClaimMorseApplication] stake coin not found in event`);
  }

  if (!balanceCoin) {
    throw new Error(`[handleMsgClaimMorseApplication] balance coin not found in event`);
  }

  if (!app) {
    throw new Error(`[handleMsgClaimMorseApplication] app not found in event`);
  }

  if (!app.stake) {
    throw new Error(`[handleMsgClaimMorseApplication] app stake not found in event`);
  }

  const prevApp = record[shannonDestAddress]?.application;

  return {
    application: {
      id: shannonDestAddress,
      accountId: shannonDestAddress,
      stakeAmount: (
        BigInt(stakeCoin.amount) +
        BigInt(record[shannonDestAddress]?.application?.stakeAmount?.toString() || '0')
      ),
      stakeDenom: stakeCoin.denom,
      stakeStatus: StakeStatus.Staked,
      transferringToId: prevApp?.transferringToId,
      transferEndHeight: prevApp?.transferEndHeight,
      unstakingEndHeight: undefined,
      unstakingEndBlockId: undefined,
      unstakingBeginBlockId: undefined,
      unstakingReason: undefined,
    },
    msgClaimMorseApplication: {
      id: msgId,
      transactionId: msg.tx.hash,
      blockId: getBlockId(msg.block),
      applicationId: shannonDestAddress,
      messageId: msgId,
      stakeAmount: BigInt(stakeCoin.amount),
      stakeDenom: stakeCoin.denom,
      balanceAmount: BigInt(balanceCoin.amount),
      balanceDenom: balanceCoin.denom,
      shannonDestAddress,
      shannonSigningAddress: msg.msg.decodedMsg.shannonSigningAddress,
      morseSignature: toHex(msg.msg.decodedMsg.morseSignature),
      morsePublicKey: toHex(msg.msg.decodedMsg.morsePublicKey),
      morseSrcAddress: pubKeyToAddress(
        Ed25519,
        msg.msg.decodedMsg.morsePublicKey,
        undefined,
        true
      ),
    },
    ...getServices(
      [msg.msg.decodedMsg.serviceConfig!],
      shannonDestAddress,
      Object.keys(record[shannonDestAddress]?.services || {})
    )
  }
}

function _handleUnstakeApplicationMsg(
  msg: CosmosMessage<MsgUnstakeApplication>,
  record: Record<string, {
    application?: ApplicationProps,
    services?: Record<string, ApplicationServiceProps>,
    gateways?: Record<string, ApplicationGatewayProps>,
  }>
): {
  application: ApplicationProps,
  msgUnstakeApplication: MsgUnstakeApplicationProps
} {
  const { address } = msg.msg.decodedMsg;

  const application = record[address]?.application;

  if (!application) {
    throw new Error(`[handleUnstakeApplicationMsg] application not found for address ${address}`);
  }

  const msgId = messageId(msg);

  return {
    application: {
      ...application,
      stakeStatus: StakeStatus.Unstaking,
      unstakingBeginBlockId: getBlockId(msg.block)
    },
    msgUnstakeApplication: {
      id: msgId,
      applicationId: address,
      transactionId: msg.tx.hash,
      blockId: getBlockId(msg.block),
      messageId: msgId,
    }
  }
}

function _handleDelegateToGatewayMsg(
  msg: CosmosMessage<MsgDelegateToGateway>,
  record: Record<string, {
    application?: ApplicationProps,
    services?: Record<string, ApplicationServiceProps>,
    gateways?: Record<string, ApplicationGatewayProps>,
  }>
): {
  gateway: ApplicationGatewayProps,
  msgDelegateToGateway: MsgDelegateToGatewayProps
} {
  const msgId = messageId(msg);

  return {
    gateway: {
      id: getAppDelegatedToGatewayId(
        msg.msg.decodedMsg.appAddress,
        msg.msg.decodedMsg.gatewayAddress,
      ),
      gatewayId: msg.msg.decodedMsg.gatewayAddress,
      applicationId: msg.msg.decodedMsg.appAddress,
    },
    msgDelegateToGateway: {
      id: msgId,
      applicationId: msg.msg.decodedMsg.appAddress,
      gatewayId: msg.msg.decodedMsg.gatewayAddress,
      transactionId: msg.tx.hash,
      blockId: getBlockId(msg.block),
      messageId: msgId,
    }
  }
}

function _handleUndelegateFromGatewayMsg(
  msg: CosmosMessage<MsgUndelegateFromGateway>,
  record: Record<string, {
    application?: ApplicationProps,
    services?: Record<string, ApplicationServiceProps>,
    gateways?: Record<string, ApplicationGatewayProps>,
  }>
): {
  gatewayToRemove: string,
  msgUndelegateFromGateway: MsgUndelegateFromGatewayProps
} {
  const msgId = messageId(msg);

  return {
    gatewayToRemove: getAppDelegatedToGatewayId(
      msg.msg.decodedMsg.appAddress,
      msg.msg.decodedMsg.gatewayAddress,
    ),
    msgUndelegateFromGateway: {
      id: msgId,
      applicationId: msg.msg.decodedMsg.appAddress,
      gatewayId: msg.msg.decodedMsg.gatewayAddress,
      transactionId: msg.tx.hash,
      blockId: getBlockId(msg.block),
      messageId: msgId,
    }
  }
}

function _handleTransferApplicationMsg(
  msg: CosmosMessage<MsgTransferApplication>,
  record: Record<string, {
    application?: ApplicationProps,
    services?: Record<string, ApplicationServiceProps>,
    gateways?: Record<string, ApplicationGatewayProps>,
  }>
): {
  application: ApplicationProps,
  msgTransferApplication: MsgTransferApplicationProps
} {
  const application = record[msg.msg.decodedMsg.sourceAddress]?.application;

  if (!application) {
    throw new Error(`[handleTransferApplicationMsg] source application not found for address ${msg.msg.decodedMsg.sourceAddress}`);
  }

  const msgId = messageId(msg);

  return {
    application: {
      ...application,
      transferringToId: msg.msg.decodedMsg.destinationAddress,
    },
    msgTransferApplication: {
      id: msgId,
      sourceApplicationId: msg.msg.decodedMsg.sourceAddress,
      destinationApplicationId: msg.msg.decodedMsg.destinationAddress,
      transactionId: msg.tx.hash,
      blockId: getBlockId(msg.block),
      messageId: msgId,
    }
  }
}

function _handleTransferApplicationBeginEvent(
  event: CosmosEvent,
  record: Record<string, {
    application?: ApplicationProps,
    services?: Record<string, ApplicationServiceProps>,
    gateways?: Record<string, ApplicationGatewayProps>,
  }>
): {
  application: ApplicationProps,
  transferBeginEvent: EventTransferBeginProps,
} {
  const msg = event.msg as CosmosMessage<EventTransferBegin>;

  const transferEndHeight = event.event.attributes.find(attribute => attribute.key === "transfer_end_height")?.value as string;

  if (!transferEndHeight) {
    throw new Error(`[handleTransferApplicationBeginEvent] transferEndHeight not found`);
  }

  const application = record[msg.msg.decodedMsg.sourceAddress]?.application;

  if (!application) {
    throw new Error(`[handleTransferApplicationBeginEvent] application not found for address ${msg.msg.decodedMsg.sourceAddress}`);
  }

  const eventId = getEventId(event);

  return {
    application: {
      ...application,
      transferEndHeight: BigInt((transferEndHeight as unknown as string).replaceAll("\"", "")),
    },
    transferBeginEvent: {
      id: eventId,
      sourceId: msg.msg.decodedMsg.sourceAddress,
      destinationId: msg.msg.decodedMsg.destinationAddress,
      transactionId: event.tx.hash,
      blockId: getBlockId(event.block),
      eventId,
    }
  }
}

function _handleTransferApplicationEndEvent(
  event: CosmosEvent,
  record: Record<string, {
    application?: ApplicationProps,
    services?: Record<string, ApplicationServiceProps>,
    gateways?: Record<string, ApplicationGatewayProps>,
  }>
): {
  sourceApplication: ApplicationProps,
  destinationApplication: ApplicationProps,
  transferEndEvent: EventTransferEndProps,
  destinationServices: Array<ApplicationServiceProps>,
  destinationGateways: Array<ApplicationGatewayProps>,
  sourceServicesToRemove: Array<string>,
  sourceGatewaysToRemove: Array<string>,
} {
  let sourceAddress = event.event.attributes.find(attribute => attribute.key === "source_address")?.value as unknown as string;

  if (!sourceAddress) {
    throw new Error(`[handleTransferApplicationEndEvent] event.event.attributes not found`);
  }

  // the source address is surrounded by quotes
  sourceAddress = sourceAddress.replaceAll("\"", "");

  const sourceApplication = record[sourceAddress]?.application;

  if (!sourceApplication) {
    throw new Error(`[handleTransferApplicationMsg] source application not found for address ${sourceAddress}`);
  }

  const prevUnstakingEndBlockId = sourceApplication.unstakingEndBlockId?.valueOf();

  const destinationAppStringified = event.event.attributes.find(attribute => attribute.key === "destination_application")?.value as string;

  if (!destinationAppStringified) {
    throw new Error(`[handleTransferApplicationMsg] destination application not in event`);
  }

  const destinationApp: Required<ApplicationSDKType> = JSON.parse(destinationAppStringified);

  const { delegatee_gateway_addresses, service_configs } = destinationApp;
  const stake = destinationApp.stake as Required<typeof destinationApp.stake>;

  const destinationApplication: ApplicationProps = {
    id: destinationApp.address,
    accountId: destinationApp.address,
    stakeAmount: BigInt(stake.amount),
    stakeDenom: stake.denom,
    stakeStatus: StakeStatus.Staked,
    sourceApplicationId: sourceAddress,
    transferredFromAtId: getBlockId(event.block),
    unstakingEndBlockId: prevUnstakingEndBlockId,
    unstakingBeginBlockId: sourceApplication.unstakingBeginBlockId,
  };

  const destinationGateways: Array<ApplicationGatewayProps> = delegatee_gateway_addresses.map(gateway => ({
    id: getAppDelegatedToGatewayId(destinationApplication.id, gateway),
    applicationId: destinationApplication.id,
    gatewayId: gateway,
  }));

  const destinationServices: Array<ApplicationServiceProps> = service_configs?.map(service => ({
    id: getStakeServiceId(destinationApp.address, service.service_id),
    serviceId: service.service_id,
    applicationId: destinationApp.address,
  })) || [];

  const eventId = getEventId(event);

  return {
    sourceApplication: {
      ...sourceApplication,
      transferringToId: undefined,
      transferEndHeight: undefined,
      transferEndBlockId: getBlockId(event.block),
      stakeStatus: StakeStatus.Unstaked,
      unstakingReason: ApplicationUnbondingReason.TRANSFER,
      unstakingEndBlockId: getBlockId(event.block),
      destinationApplicationId: destinationApp.address,
    },
    destinationApplication,
    transferEndEvent: {
      id: eventId,
      sourceId: sourceAddress,
      destinationId: destinationApp.address,
      blockId: getBlockId(event.block),
      eventId,
    },
    destinationServices,
    destinationGateways,
    sourceServicesToRemove: Object.keys(record[sourceAddress]?.services || {}),
    sourceGatewaysToRemove: Object.keys(record[sourceAddress]?.gateways || {}),
  }
}

function _handleTransferApplicationErrorEvent(
  event: CosmosEvent,
  record: Record<string, {
    application?: ApplicationProps,
    services?: Record<string, ApplicationServiceProps>,
    gateways?: Record<string, ApplicationGatewayProps>,
  }>
): {
  application: ApplicationProps,
  transferErrorEvent: EventTransferErrorProps,
} {
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

  const application = record[sourceAddress]?.application;

  if (!application) {
    throw new Error(`[handleTransferApplicationErrorEvent] application not found for address ${sourceAddress}`);
  }

  const eventId = getEventId(event);

  return {
    application: {
      ...application,
      transferringToId: undefined,
      transferEndHeight: undefined,
    },
    transferErrorEvent: {
      id: eventId,
      sourceId: sourceAddress,
      destinationId: destinationAddress,
      error: error,
      blockId: getBlockId(event.block),
      eventId,
    }
  }
}

function _handleApplicationUnbondingBeginEvent(
  event: CosmosEvent,
  record: Record<string, {
    application?: ApplicationProps,
    services?: Record<string, ApplicationServiceProps>,
    gateways?: Record<string, ApplicationGatewayProps>,
  }>
): {
  application: ApplicationProps,
  unbondingBeginEvent: EventApplicationUnbondingBeginProps,
} {
  const msg = event.msg as CosmosMessage<MsgUnstakeApplication>;

  let address = msg ? msg.msg.decodedMsg.address : "";

  let unstakingEndHeight = BigInt(0), sessionEndHeight = BigInt(0), reason: number | null = null;

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

    if (!msg && attribute.key === "application") {
      // now this is a block event?
      const application: ApplicationSDKType = parseJson(attribute.value as unknown as string);
      address = application.address;
    }
  }

  if (unstakingEndHeight === BigInt(0)) {
    throw new Error(`[handleApplicationUnbondingBeginEvent] unbondingEndHeight not found in event`);
  }

  if (sessionEndHeight === BigInt(0)) {
    throw new Error(`[handleApplicationUnbondingBeginEvent] sessionEndHeight not found in event`);
  }

  if (reason === null) {
    throw new Error(`[handleApplicationUnbondingBeginEvent] reason not found in event`);
  }

  if (address === "") {
    throw new Error(`[handleApplicationUnbondingBeginEvent] address not found in event`);
  }

  const application = record[address]?.application;

  if (!application) {
    throw new Error(`[handleApplicationUnbondingBeginEvent] application not found for operator address ${address}`);
  }

  const eventId = getEventId(event);

  return {
    application: {
      ...application,
      unstakingEndHeight: unstakingEndHeight,
      unstakingReason: getAppUnbondingReasonFromSDK(reason),
    },
    unbondingBeginEvent: {
      id: eventId,
      applicationId: address,
      blockId: getBlockId(event.block),
      unstakingEndHeight,
      sessionEndHeight,
      reason,
      eventId,
    }
  }
}

function _handleApplicationUnbondingEndEvent(
  event: CosmosEvent,
  record: Record<string, {
    application?: ApplicationProps,
    services?: Record<string, ApplicationServiceProps>,
    gateways?: Record<string, ApplicationGatewayProps>,
  }>
): {
  application: ApplicationProps,
  unbondingEndEvent: EventApplicationUnbondingEndProps,
  servicesToRemove: Array<string>,
} {
  let unstakingEndHeight = BigInt(0), sessionEndHeight = BigInt(0), reason: number | null = null,
    applicationSdk: ApplicationSDKType | undefined;

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

  if (unstakingEndHeight === BigInt(0)) {
    throw new Error(`[handleApplicationUnbondingEndEvent] unbondingEndHeight not found in event`);
  }

  if (sessionEndHeight === BigInt(0)) {
    throw new Error(`[handleApplicationUnbondingEndEvent] sessionEndHeight not found in event`);
  }

  if (reason === null) {
    throw new Error(`[handleApplicationUnbondingEndEvent] reason not found in event`);
  }

  if (!applicationSdk) {
    throw new Error(`[handleApplicationUnbondingEndEvent] application not found in event`);
  }

  const application = record[applicationSdk.address]?.application;

  if (!application) {
    throw new Error(`[handleApplicationUnbondingEndEvent] application not found for address ${applicationSdk.address}`);
  }

  const eventId = getEventId(event);

  return {
    application: {
      ...application,
      unstakingEndBlockId: getBlockId(event.block),
      stakeStatus: StakeStatus.Unstaked,
      unstakingReason: getAppUnbondingReasonFromSDK(reason),
    },
    unbondingEndEvent: {
      id: eventId,
      blockId: getBlockId(event.block),
      sessionEndHeight,
      unstakingEndHeight,
      reason,
      applicationId: applicationSdk.address,
      eventId,
    },
    servicesToRemove: Object.keys(record[applicationSdk.address]?.services || {}),
  }
}

export const globalInflationRateCacheKey = 'globalInflationRate'

// this is to have in cache of the global inflation per claim used to calculate the burn of the apps
async function getGlobalInflationRate(): Promise<number> {
  const globalInflationRate = await cache.get(globalInflationRateCacheKey)

  if (globalInflationRate) return globalInflationRate

  let currentGlobalInflationRateParam = await Param.get('tokenomics-global_inflation_per_claim')

  if (!currentGlobalInflationRateParam) {
    // @ts-ignore
    currentGlobalInflationRateParam = {
      value: '0.01'
    }
    // throw new Error(`[getGlobalInflationRate] tokenomics-global_inflation_per_claim param not found`)
  }

  const currentGlobalInflationRate = Number(currentGlobalInflationRateParam!.value.toString())

  await cache.set(globalInflationRateCacheKey, currentGlobalInflationRate)

  return currentGlobalInflationRate
}

function _handleEventClaimSettled(
  event: CosmosEvent,
  record: Record<string, {
    application?: ApplicationProps,
    services?: Record<string, ApplicationServiceProps>,
    gateways?: Record<string, ApplicationGatewayProps>,
  }>
): ApplicationProps {
  let claimed: CoinSDKType | undefined, appAddress: string | undefined;

  for (const attribute of event.event.attributes) {
    if (attribute.key === "claimed_upokt") {
      claimed = getDenomAndAmount(attribute.value as string);
    }

    if (attribute.key === "application_address") {
      appAddress = parseAttribute(attribute.value)
    }

    if (attribute.key === "claim") {
      appAddress = (JSON.parse(attribute.value as string) as ClaimSDKType)?.session_header?.application_address || '';
    }
  }

  if (!claimed) {
    throw new Error(`[handleEventClaimSettled for apps] claimed_upokt not found in event`);
  }

  if (!appAddress) {
    throw new Error(`[handleEventClaimSettled for apps] application not found in event`);
  }

  const application = record[appAddress]?.application;

  if (!application) {
    throw new Error(`[handleEventClaimSettled for apps] application not found for address ${appAddress}`);
  }

  const newStakeAmount = BigInt(application.stakeAmount.toString()) - BigInt(claimed.amount)

  if (appAddress === 'pokt1sflq0twpgkch8sehp2cek97qsh5ew30haevnp8' && event.block.block.header.height.toString() === '96845') {
    logger.info(`[handleEventClaimSettled for apps] burning ${claimed.amount} for app ${appAddress}, new stake amount is ${newStakeAmount}`)
  }

  if (Number(newStakeAmount.toString()) < 0) {
    throw new Error(`[handleEventClaimSettled for apps] stake amount cannot be negative`);
  }

  return {
    ...application,
    stakeAmount: newStakeAmount,
  }
}

function _handleEventApplicationReimbursementRequest(
  event: CosmosEvent,
  record: Record<string, {
    application?: ApplicationProps,
    services?: Record<string, ApplicationServiceProps>,
    gateways?: Record<string, ApplicationGatewayProps>,
  }>
): ApplicationProps {
  let coin: CoinSDKType | undefined, appAddress: string | undefined;

  for (const attribute of event.event.attributes) {
    if (attribute.key === "amount") {
      coin = getDenomAndAmount(attribute.value as string);
    }

    if (attribute.key === "application_addr") {
      appAddress = parseAttribute(attribute.value)
    }
  }

  if (!coin) {
    throw new Error(`[handleEventClaimSettled for apps] claimed_upokt not found in event`);
  }

  if (!appAddress) {
    throw new Error(`[handleEventClaimSettled for apps] application not found in event`);
  }

  const application = record[appAddress]?.application;

  if (!application) {
    throw new Error(`[handleEventClaimSettled for apps] application not found for address ${appAddress}`);
  }

  const newStakeAmount = BigInt(application.stakeAmount.toString()) - BigInt(coin.amount)

  if (appAddress === 'pokt1sflq0twpgkch8sehp2cek97qsh5ew30haevnp8' && event.block.block.header.height.toString() === '96845') {
    logger.info(`[handleEventApplicationReimbursementRequest for apps] adding ${coin.amount} for app ${appAddress}, new stake amount is ${newStakeAmount}`)
  }

  return {
    ...application,
    stakeAmount: newStakeAmount,
  }
}

async function _handleEventApplicationOverserviced(
  event: CosmosEvent,
  record: Record<string, {
    application?: ApplicationProps,
    services?: Record<string, ApplicationServiceProps>,
    gateways?: Record<string, ApplicationGatewayProps>,
  }>
): Promise<ApplicationProps> {
  let effective: CoinSDKType | undefined, expected: CoinSDKType | undefined, appAddress: string | undefined;

  for (const attribute of event.event.attributes) {
    if (attribute.key === "effective_burn") {
      effective = getDenomAndAmount(attribute.value as string);
    }

    if (attribute.key === "expected_burn") {
      expected = getDenomAndAmount(attribute.value as string);
    }

    if (attribute.key === "application_addr") {
      appAddress = parseAttribute(attribute.value)
    }
  }

  if (!effective) {
    throw new Error(`[handleEventApplicationOverserviced for apps] effective_burn not found in event`);
  }

  if (!expected) {
    throw new Error(`[handleEventApplicationOverserviced for apps] expected_burn not found in event`);
  }

  if (!appAddress) {
    throw new Error(`[handleEventClaimSettled for apps] application not found in event`);
  }

  const application = record[appAddress]?.application;

  if (!application) {
    throw new Error(`[handleEventClaimSettled for apps] application not found for address ${appAddress}`);
  }

  const globalInflationRate = await getGlobalInflationRate()

  const claimedAmount = Math.floor(Number(expected.amount) / (1 + globalInflationRate))

  // here we are adding the claimedAmount because we will subtract it from the EventClaimSettled event
  const newStakeAmount = BigInt(application.stakeAmount.toString()) + BigInt(claimedAmount) - BigInt(effective.amount)

  if (Number(newStakeAmount.toString()) < 0) {
    throw new Error(`[handleEventClaimSettled for apps] stake amount cannot be negative`);
  }

  if (appAddress === 'pokt1sflq0twpgkch8sehp2cek97qsh5ew30haevnp8' && event.block.block.header.height.toString() === '96845') {
    logger.info(`\n\n[handleEventApplicationOverserviced for apps] expected: ${expected.amount}, effective: ${effective.amount}, global inflation: ${globalInflationRate}, claimed: ${claimedAmount} for app ${appAddress}, new stake amount is ${newStakeAmount}`)
  }

  return {
    ...application,
    stakeAmount: newStakeAmount,
  }
}

async function _handleAuthzExec(msg: CosmosMessage<AuthzExecMsg>) {
  for (const message of msg.msg.decodedMsg.msgs.values()) {
    if (message.typeUrl.includes('MsgUpdateParam')) {
      const paramResult = _handleUpdateParam(message, getBlockId(msg.block));

      if (paramResult) {
        for (const param of paramResult.params) {
          if (param.id === 'tokenomics-global_inflation_per_claim') {
            logger.info(`[handleAuthzExec] global inflation rate updated to ${param.value}`)
            await cache.set(globalInflationRateCacheKey, Number(param.value))
          }
        }
      }
    }
  }
}

interface ApplicationRecord {
  application?: ApplicationProps;
  services?: Record<string, ApplicationServiceProps>;
  gateways?: Record<string, ApplicationGatewayProps>;
}

// Helper: Get record ID getters for applications
function getApplicationRecordIdGetters(): RecordGetId {
  const eventGetId = (attributes: CosmosEvent["event"]["attributes"]) => {
    for (const attribute of attributes) {
      if (attribute.key === "application") {
        return JSON.parse(attribute.value as string).address
      }
    }

    return null
  }

  const getIdOfTransferEvents = (attributes: CosmosEvent['event']["attributes"]) => {
    return attributes.find(({key}) => key === "source_address")?.value as string
  }

  return {
    "/pocket.application.MsgDelegateToGateway": "appAddress",
    "/pocket.application.MsgUndelegateFromGateway": "appAddress",
    "/pocket.application.MsgUnstakeApplication": "address",
    "/pocket.application.MsgStakeApplication": "address",
    "/pocket.migration.MsgClaimMorseApplication": "shannonDestAddress",
    "/pocket.application.MsgTransferApplication": "sourceAddress",
    "pocket.application.EventTransferBegin": eventGetId,
    "pocket.application.EventTransferEnd": (attributes) => {
      const ids: Array<string> = []

      for (const {key, value} of attributes) {
        if (key === 'source_address' || key === 'destination_address') {
          ids.push((value as string).replaceAll("\"", ""))
        }

        if (ids.length === 2) break
      }

      return ids
    },
    "pocket.application.EventTransferError": getIdOfTransferEvents,
    "pocket.application.EventApplicationUnbondingBegin": eventGetId,
    "pocket.application.EventApplicationUnbondingEnd": eventGetId,
    "pocket.tokenomics.EventClaimSettled": (attributes) => {
      for (const attribute of attributes) {
        if (attribute.key === "application_address") {
          return parseAttribute(attribute.value)
        }

        if (attribute.key === "claim") {
          return (JSON.parse(attribute.value as string) as ClaimSDKType)?.session_header?.application_address || '';
        }
      }

      throw new Error(`[indexApplications] app address not found in event EventClaimSettled`)
    },
    "pocket.tokenomics.EventApplicationReimbursementRequest": attributes => {
      for (const attribute of attributes) {
        if (attribute.key === 'application_addr') {
          return parseAttribute(attribute.value)
        }
      }

      throw new Error(`[indexApplications] app address not found in event EventApplicationReimbursementRequest`)
    },
    "pocket.tokenomics.EventApplicationOverserviced": attributes => {
      for (const attribute of attributes) {
        if (attribute.key === 'application_addr') {
          return parseAttribute(attribute.value)
        }
      }

      throw new Error(`[indexApplications] app address not found in event EventApplicationReimbursementRequest`)
    },
  }
}

// Helper: Collect application IDs from events and messages
function collectApplicationIds(
  eventsAndMessages: Array<CosmosEvent | CosmosMessage>,
  recordId: RecordGetId
): {
  applications: Array<string>;
  applicationsToFetchServices: Array<string>;
  applicationsToFetchGateways: Array<string>;
} {
  const applications: Array<string> = []
  const applicationsToFetchServices: Array<string> = []
  const applicationsToFetchGateways: Array<string> = []

  for (const eventOrMsg of eventsAndMessages) {
    if ('event' in eventOrMsg) {
      const getEntityId = recordId[eventOrMsg.event.type] as GetIdFromEventAttribute
      const ids = getEntityId(eventOrMsg.event.attributes)

      if (typeof ids === "string") {
        applications.push(ids)
      } else {
        applications.push(...ids)
      }
    } else {
      const entityIdPath = recordId[eventOrMsg.msg.typeUrl] as string
      const id = get(eventOrMsg.msg.decodedMsg, entityIdPath)

      if ([
        "/pocket.application.MsgUnstakeApplication",
        "/pocket.application.MsgStakeApplication",
        "/pocket.migration.MsgClaimMorseApplication",
        "/pocket.application.MsgTransferApplication",
      ].includes(eventOrMsg.msg.typeUrl)) {
        applications.push(id)

        if ([
          "/pocket.application.MsgStakeApplication",
          "/pocket.migration.MsgClaimMorseApplication",
        ].includes(eventOrMsg.msg.typeUrl)) {
          applicationsToFetchServices.push(id)
        }
      }

      if ([
        "/pocket.application.MsgDelegateToGateway",
        "/pocket.application.MsgUndelegateFromGateway",
      ].includes(eventOrMsg.msg.typeUrl)) {
        applicationsToFetchGateways.push(id)
      }
    }
  }

  return { applications, applicationsToFetchServices, applicationsToFetchGateways }
}

// Helper: Fetch application data from database
async function fetchApplicationData(
  applications: Array<string>,
  applicationsToFetchServices: Array<string>,
  applicationsToFetchGateways: Array<string>
): Promise<Record<string, ApplicationRecord>> {
  const [fetchedApplications, fetchedServices, fetchedGateways] = await Promise.all([
    fetchPaginatedRecords<Application>({
      fetchFn: (options) => Application.getByFields(
        [
          ['id', 'in', Array.from(new Set(applications))],
        ],
        options
      )
    }),
    fetchPaginatedRecords<ApplicationService>({
      fetchFn: (options) => ApplicationService.getByFields(
        [
          ['applicationId', 'in', Array.from(new Set(applicationsToFetchServices))],
        ],
        options
      )
    }),
    fetchPaginatedRecords<ApplicationGateway>({
      fetchFn: (options) => ApplicationGateway.getByFields(
        [
          ['applicationId', 'in', Array.from(new Set(applicationsToFetchGateways))],
        ],
        options
      )
    }),
  ]);

  const record: Record<string, ApplicationRecord> = {}

  for (const application of fetchedApplications) {
    record[application.id] = {
      application: application,
      services: {},
      gateways: {}
    }
  }

  for (const service of fetchedServices) {
    if (!record[service.applicationId]) {
      record[service.applicationId] = {
        services: {},
        gateways: {}
      }
    }

    if (!record[service.applicationId].services) {
      record[service.applicationId].services = {}
    }

    record[service.applicationId].services![service.id] = service
  }

  for (const gateway of fetchedGateways) {
    if (!record[gateway.applicationId]) {
      record[gateway.applicationId] = {
        services: {},
        gateways: {}
      }
    }

    if (!record[gateway.applicationId].gateways) {
      record[gateway.applicationId].gateways = {}
    }

    record[gateway.applicationId].gateways![gateway.id] = gateway
  }

  return record
}

// Helper: Process all events and messages
// eslint-disable-next-line complexity
async function processApplicationEventsAndMessages(
  eventsAndMessages: Array<CosmosEvent | CosmosMessage>,
  record: Record<string, ApplicationRecord>,
  recordId: RecordGetId
): Promise<{
  applicationsToClose: Array<string>;
  servicesToClose: Array<string>;
  gatewaysToClose: Array<string>;
  stakeApplicationMsgs: Array<MsgStakeApplicationProps>;
  claimApplicationMsgs: Array<MsgClaimMorseApplicationProps>;
  unstakeApplicationMsgs: Array<MsgUnstakeApplicationProps>;
  transferApplicationMsgs: Array<MsgTransferApplicationProps>;
  delegateToGatewayMsgs: Array<MsgDelegateToGatewayProps>;
  undelegateFromGatewayMsgs: Array<MsgUndelegateFromGatewayProps>;
  transferBeginEvents: Array<EventTransferBeginProps>;
  transferEndEvents: Array<EventTransferEndProps>;
  transferErrorEvents: Array<EventTransferErrorProps>;
  unbondingBeginEvents: Array<EventApplicationUnbondingBeginProps>;
  unbondingEndEvents: Array<EventApplicationUnbondingEndProps>;
}> {
  const applicationsToClose: Array<string> = Object.keys(record).filter(id => record[id].application);
  const servicesToClose: Array<string> = []
  const gatewaysToClose: Array<string> = []
  const stakeApplicationMsgs: Array<MsgStakeApplicationProps> = []
  const claimApplicationMsgs: Array<MsgClaimMorseApplicationProps> = []
  const unstakeApplicationMsgs: Array<MsgUnstakeApplicationProps> = []
  const transferApplicationMsgs: Array<MsgTransferApplicationProps> = []
  const delegateToGatewayMsgs: Array<MsgDelegateToGatewayProps> = []
  const undelegateFromGatewayMsgs: Array<MsgUndelegateFromGatewayProps> = []
  const transferBeginEvents: Array<EventTransferBeginProps> = []
  const transferEndEvents: Array<EventTransferEndProps> = []
  const transferErrorEvents: Array<EventTransferErrorProps> = []
  const unbondingBeginEvents: Array<EventApplicationUnbondingBeginProps> = []
  const unbondingEndEvents: Array<EventApplicationUnbondingEndProps> = []

  for (const eventOrMsg of eventsAndMessages) {
    if ('event' in eventOrMsg) {
      if (eventOrMsg.event.type === "pocket.tokenomics.EventClaimSettled") {
        const application = _handleEventClaimSettled(eventOrMsg, record)

        record[application.id].application = application
      }

      if (eventOrMsg.event.type === "pocket.tokenomics.EventApplicationReimbursementRequest") {
        const application = _handleEventApplicationReimbursementRequest(eventOrMsg, record)

        record[application.id].application = application
      }

      if (eventOrMsg.event.type === "pocket.tokenomics.EventApplicationOverserviced") {
        const application = await _handleEventApplicationOverserviced(eventOrMsg, record)

        record[application.id].application = application
      }

      if (eventOrMsg.event.type === "pocket.application.EventTransferBegin") {
        const {
          application,
          transferBeginEvent
        } = _handleTransferApplicationBeginEvent(
          eventOrMsg,
          record
        )

        const getId = recordId[eventOrMsg.event.type] as GetIdFromEventAttribute
        const appId = getId(eventOrMsg.event.attributes) as string

        record[appId].application = application
        transferBeginEvents.push(transferBeginEvent)
      }

      if (eventOrMsg.event.type === "pocket.application.EventTransferEnd") {
        const {
          destinationApplication,
          destinationGateways,
          destinationServices,
          sourceApplication,
          sourceGatewaysToRemove,
          sourceServicesToRemove,
          transferEndEvent,
        } = _handleTransferApplicationEndEvent(
          eventOrMsg,
          record
        )

        // Update source app
        record[sourceApplication.id].application = sourceApplication

        // Add destination app to record
        if (!record[destinationApplication.id]) {
          record[destinationApplication.id] = {
            services: {},
            gateways: {}
          }
        }
        record[destinationApplication.id].application = destinationApplication
        applicationsToClose.push(destinationApplication.id)

        // Handle services
        for (const serviceId of sourceServicesToRemove) {
          delete record[sourceApplication.id].services![serviceId]
          servicesToClose.push(serviceId)
        }

        for (const service of destinationServices) {
          if (!record[destinationApplication.id].services) {
            record[destinationApplication.id].services = {}
          }
          record[destinationApplication.id].services![service.id] = service
          servicesToClose.push(service.id)
        }

        // Handle gateways
        for (const gatewayId of sourceGatewaysToRemove) {
          delete record[sourceApplication.id].gateways![gatewayId]
          gatewaysToClose.push(gatewayId)
        }

        for (const gateway of destinationGateways) {
          if (!record[destinationApplication.id].gateways) {
            record[destinationApplication.id].gateways = {}
          }
          record[destinationApplication.id].gateways![gateway.id] = gateway
          gatewaysToClose.push(gateway.id)
        }

        transferEndEvents.push(transferEndEvent)
      }

      if (eventOrMsg.event.type === "pocket.application.EventTransferError") {
        const {
          application,
          transferErrorEvent
        } = _handleTransferApplicationErrorEvent(
          eventOrMsg,
          record
        )

        const getId = recordId[eventOrMsg.event.type] as GetIdFromEventAttribute
        const appId = getId(eventOrMsg.event.attributes) as string

        record[appId].application = application
        transferErrorEvents.push(transferErrorEvent)
      }

      if (eventOrMsg.event.type === "pocket.application.EventApplicationUnbondingBegin") {
        const {
          application,
          unbondingBeginEvent,
        } = _handleApplicationUnbondingBeginEvent(
          eventOrMsg,
          record
        )

        record[application.id].application = application
        unbondingBeginEvents.push(unbondingBeginEvent)
      }

      if (eventOrMsg.event.type === "pocket.application.EventApplicationUnbondingEnd") {
        const {
          application,
          servicesToRemove,
          unbondingEndEvent
        } = _handleApplicationUnbondingEndEvent(
          eventOrMsg,
          record
        )

        for (const serviceId of servicesToRemove) {
          delete record[application.id].services![serviceId]
          servicesToClose.push(serviceId)
        }

        record[application.id].application = application
        unbondingEndEvents.push(unbondingEndEvent)
      }
    } else {
      if (eventOrMsg.msg.typeUrl === "/cosmos.authz.v1beta1.MsgExec") {
        await _handleAuthzExec(eventOrMsg as CosmosMessage<AuthzExecMsg>)
      }

      if (eventOrMsg.msg.typeUrl === "/pocket.application.MsgStakeApplication") {
        const {
          application,
          msgStakeApplication,
          services,
          servicesToRemove,
        } = _handleAppMsgStake(
          eventOrMsg as CosmosMessage<MsgStakeApplication>,
          record
        )

        stakeApplicationMsgs.push(msgStakeApplication)

        if (!record[application.id]) {
          record[application.id] = {
            services: {},
            gateways: {}
          }
        }

        record[application.id].application = application

        for (const serviceId of servicesToRemove) {
          delete record[application.id].services![serviceId]
          servicesToClose.push(serviceId)
        }

        for (const service of services) {
          record[application.id].services![service.id] = service
          servicesToClose.push(service.id)
        }
      }

      if (eventOrMsg.msg.typeUrl === "/pocket.migration.MsgClaimMorseApplication") {
        const {
          application,
          msgClaimMorseApplication,
          services,
          servicesToRemove,
        } = _handleMsgClaimMorseApplication(
          eventOrMsg as CosmosMessage<MsgClaimMorseApplication>,
          record
        )

        claimApplicationMsgs.push(msgClaimMorseApplication)

        if (!record[application.id]) {
          record[application.id] = {
            services: {},
            gateways: {}
          }
        }

        record[application.id].application = application

        for (const serviceId of servicesToRemove) {
          delete record[application.id].services![serviceId]
          servicesToClose.push(serviceId)
        }

        for (const service of services) {
          record[application.id].services![service.id] = service
          servicesToClose.push(service.id)
        }
      }

      if (eventOrMsg.msg.typeUrl === "/pocket.application.MsgUnstakeApplication") {
        const {
          application,
          msgUnstakeApplication
        } = _handleUnstakeApplicationMsg(
          eventOrMsg as CosmosMessage<MsgUnstakeApplication>,
          record
        )

        record[application.id].application = application
        unstakeApplicationMsgs.push(msgUnstakeApplication)
      }

      if (eventOrMsg.msg.typeUrl === "/pocket.application.MsgTransferApplication") {
        const {
          application,
          msgTransferApplication
        } = _handleTransferApplicationMsg(
          eventOrMsg as CosmosMessage<MsgTransferApplication>,
          record
        )

        record[application.id].application = application
        transferApplicationMsgs.push(msgTransferApplication)
      }

      if (eventOrMsg.msg.typeUrl === "/pocket.application.MsgDelegateToGateway") {
        const {
          gateway,
          msgDelegateToGateway
        } = _handleDelegateToGatewayMsg(
          eventOrMsg as CosmosMessage<MsgDelegateToGateway>,
          record
        )

        const appAddress = (eventOrMsg as CosmosMessage<MsgDelegateToGateway>).msg.decodedMsg.appAddress

        if (!record[appAddress]) {
          record[appAddress] = {
            services: {},
            gateways: {}
          }
        }

        if (!record[appAddress].gateways) {
          record[appAddress].gateways = {}
        }

        record[appAddress].gateways![gateway.id] = gateway
        gatewaysToClose.push(gateway.id)
        delegateToGatewayMsgs.push(msgDelegateToGateway)
      }

      if (eventOrMsg.msg.typeUrl === "/pocket.application.MsgUndelegateFromGateway") {
        const {
          gatewayToRemove,
          msgUndelegateFromGateway
        } = _handleUndelegateFromGatewayMsg(
          eventOrMsg as CosmosMessage<MsgUndelegateFromGateway>,
          record
        )

        const appAddress = eventOrMsg.msg.decodedMsg.appAddress

        delete record[appAddress]?.gateways![gatewayToRemove]
        gatewaysToClose.push(gatewayToRemove)
        undelegateFromGatewayMsgs.push(msgUndelegateFromGateway)
      }
    }
  }

  return {
    applicationsToClose,
    servicesToClose,
    gatewaysToClose,
    stakeApplicationMsgs,
    claimApplicationMsgs,
    unstakeApplicationMsgs,
    transferApplicationMsgs,
    delegateToGatewayMsgs,
    undelegateFromGatewayMsgs,
    transferBeginEvents,
    transferEndEvents,
    transferErrorEvents,
    unbondingBeginEvents,
    unbondingEndEvents
  }
}

// Helper: Build lists of items to save
function buildApplicationSaveLists(record: Record<string, ApplicationRecord>): {
  applicationsToSave: Array<ApplicationProps>;
  servicesToSave: Array<ApplicationServiceProps>;
  gatewaysToSave: Array<ApplicationGatewayProps>;
} {
  const applicationsToSave: Array<ApplicationProps> = []
  const servicesToSave: Array<ApplicationServiceProps> = []
  const gatewaysToSave: Array<ApplicationGatewayProps> = []

  for (const {application, gateways, services} of Object.values(record)) {
    if (application) {
      applicationsToSave.push(application)
    }

    if (services) {
      servicesToSave.push(...Object.values(services))
    }

    if (gateways) {
      gatewaysToSave.push(...Object.values(gateways))
    }
  }

  return { applicationsToSave, servicesToSave, gatewaysToSave }
}

// Helper: Perform database operations (delete, close, save)
// eslint-disable-next-line complexity
async function performApplicationDatabaseOperations(data: {
  applicationsToSave: Array<ApplicationProps>;
  servicesToSave: Array<ApplicationServiceProps>;
  gatewaysToSave: Array<ApplicationGatewayProps>;
  applicationsToClose: Array<string>;
  servicesToClose: Array<string>;
  gatewaysToClose: Array<string>;
  stakeApplicationMsgs: Array<MsgStakeApplicationProps>;
  claimApplicationMsgs: Array<MsgClaimMorseApplicationProps>;
  unstakeApplicationMsgs: Array<MsgUnstakeApplicationProps>;
  transferApplicationMsgs: Array<MsgTransferApplicationProps>;
  delegateToGatewayMsgs: Array<MsgDelegateToGatewayProps>;
  undelegateFromGatewayMsgs: Array<MsgUndelegateFromGatewayProps>;
  transferBeginEvents: Array<EventTransferBeginProps>;
  transferEndEvents: Array<EventTransferEndProps>;
  transferErrorEvents: Array<EventTransferErrorProps>;
  unbondingBeginEvents: Array<EventApplicationUnbondingBeginProps>;
  unbondingEndEvents: Array<EventApplicationUnbondingEndProps>;
}): Promise<void> {
  const block = store.context.getHistoricalUnit()

  const removeRecords = (model: string) => {
    const sequelize = getSequelize(model)
    return getStoreModel(model).model.destroy({
      where: sequelize.where(
        sequelize.fn("lower", sequelize.col("_block_range")),
        block
      ),
      transaction: store.context.transaction,
    })
  }

  const ApplicationModel = getStoreModel("Application")
  const ApplicationServiceModel = getStoreModel("ApplicationService")
  const ApplicationGatewayModel = getStoreModel("ApplicationGateway")

  // Delete records created at this block
  const deletePromises: Array<Promise<unknown>> = []

  if (data.applicationsToSave.length > 0) deletePromises.push(removeRecords("Application"))
  if (data.servicesToSave.length > 0) deletePromises.push(removeRecords("ApplicationService"))
  if (data.gatewaysToSave.length > 0) deletePromises.push(removeRecords("ApplicationGateway"))
  if (data.stakeApplicationMsgs.length > 0) deletePromises.push(removeRecords("MsgStakeApplication"))
  if (data.claimApplicationMsgs.length > 0) deletePromises.push(removeRecords("MsgClaimMorseApplication"))
  if (data.unstakeApplicationMsgs.length > 0) deletePromises.push(removeRecords("MsgUnstakeApplication"))
  if (data.transferApplicationMsgs.length > 0) deletePromises.push(removeRecords("MsgTransferApplication"))
  if (data.delegateToGatewayMsgs.length > 0) deletePromises.push(removeRecords("MsgDelegateToGateway"))
  if (data.undelegateFromGatewayMsgs.length > 0) deletePromises.push(removeRecords("MsgUndelegateFromGateway"))
  if (data.transferBeginEvents.length > 0) deletePromises.push(removeRecords("EventTransferBegin"))
  if (data.transferEndEvents.length > 0) deletePromises.push(removeRecords("EventTransferEnd"))
  if (data.transferErrorEvents.length > 0) deletePromises.push(removeRecords("EventTransferError"))
  if (data.unbondingBeginEvents.length > 0) deletePromises.push(removeRecords("EventApplicationUnbondingBegin"))
  if (data.unbondingEndEvents.length > 0) deletePromises.push(removeRecords("EventApplicationUnbondingEnd"))

  if (deletePromises.length > 0) {
    await Promise.all(deletePromises)
  }

  // Close existing records
  const closePromises: Array<Promise<unknown>> = []

  if (data.applicationsToClose.length > 0) {
    const applicationSequelize = getSequelize("Application")

    closePromises.push(
      ApplicationModel.model.update(
        {
          __block_range: applicationSequelize.fn(
            "int8range",
            applicationSequelize.fn("lower", applicationSequelize.col("_block_range")),
            BigInt(block),
            '[)'
          ),
        },
        {
          where: {
            id: {
              [Symbol.for("in")]: data.applicationsToClose
            },
            __block_range: { [Symbol.for("contains")]: BigInt(block) },
          },
          hooks: false,
          transaction: store.context.transaction,
        }
      )
    )
  }

  if (data.servicesToClose.length > 0) {
    const servicesSequelize = getSequelize("ApplicationService")
    closePromises.push(
      ApplicationServiceModel.model.update(
        {
          __block_range: servicesSequelize.fn(
            "int8range",
            servicesSequelize.fn("lower", servicesSequelize.col("_block_range")),
            BigInt(block),
            '[)'
          ),
        },
        {
          where: {
            id: {
              [Symbol.for("in")]: data.servicesToClose
            },
            __block_range: { [Symbol.for("contains")]: BigInt(block) },
          },
          hooks: false,
          transaction: store.context.transaction,
        }
      )
    )
  }

  if (data.gatewaysToClose.length > 0) {
    const gatewaysSequelize = getSequelize("ApplicationGateway")
    closePromises.push(
      ApplicationGatewayModel.model.update(
        {
          __block_range: gatewaysSequelize.fn(
            "int8range",
            gatewaysSequelize.fn("lower", gatewaysSequelize.col("_block_range")),
            BigInt(block),
            '[)'
          ),
        },
        {
          where: {
            id: {
              [Symbol.for("in")]: data.gatewaysToClose
            },
            __block_range: { [Symbol.for("contains")]: BigInt(block) },
          },
          hooks: false,
          transaction: store.context.transaction,
        }
      )
    )
  }

  if (closePromises.length > 0) {
    await Promise.all(closePromises)
  }

  // Save new records
  const assignBlockRange = (doc: object) => ({
    ...doc,
    __block_range: [block, null],
  })
  const savePromises: Array<Promise<unknown>> = []

  if (data.applicationsToSave.length > 0) {
    savePromises.push(
      optimizedBulkCreate(
        "Application",
        data.applicationsToSave,
        assignBlockRange,
      )
    )
  }

  if (data.servicesToSave.length > 0) {
    savePromises.push(
      optimizedBulkCreate(
        "ApplicationService",
        data.servicesToSave,
        assignBlockRange,
      )
    )
  }

  if (data.gatewaysToSave.length > 0) {
    savePromises.push(
      optimizedBulkCreate(
        "ApplicationGateway",
        data.gatewaysToSave,
        assignBlockRange,
      )
    )
  }

  if (data.stakeApplicationMsgs.length > 0) {
    savePromises.push(
      optimizedBulkCreate(
        "MsgStakeApplication",
        data.stakeApplicationMsgs,
        assignBlockRange,
      )
    )
  }

  if (data.claimApplicationMsgs.length > 0) {
    savePromises.push(
      optimizedBulkCreate(
        "MsgClaimMorseApplication",
        data.claimApplicationMsgs,
        assignBlockRange,
      )
    )
  }

  if (data.unstakeApplicationMsgs.length > 0) {
    savePromises.push(
      optimizedBulkCreate(
        "MsgUnstakeApplication",
        data.unstakeApplicationMsgs,
        assignBlockRange,
      )
    )
  }

  if (data.transferApplicationMsgs.length > 0) {
    savePromises.push(
      optimizedBulkCreate(
        "MsgTransferApplication",
        data.transferApplicationMsgs,
        assignBlockRange,
      )
    )
  }

  if (data.delegateToGatewayMsgs.length > 0) {
    savePromises.push(
      optimizedBulkCreate(
        "MsgDelegateToGateway",
        data.delegateToGatewayMsgs,
        assignBlockRange,
      )
    )
  }

  if (data.undelegateFromGatewayMsgs.length > 0) {
    savePromises.push(
      optimizedBulkCreate(
        "MsgUndelegateFromGateway",
        data.undelegateFromGatewayMsgs,
        assignBlockRange,
      )
    )
  }

  if (data.transferBeginEvents.length > 0) {
    savePromises.push(
      optimizedBulkCreate(
        "EventTransferBegin",
        data.transferBeginEvents,
        assignBlockRange,
      )
    )
  }

  if (data.transferEndEvents.length > 0) {
    savePromises.push(
      optimizedBulkCreate(
        "EventTransferEnd",
        data.transferEndEvents,
        assignBlockRange,
      )
    )
  }

  if (data.transferErrorEvents.length > 0) {
    savePromises.push(
      optimizedBulkCreate(
        "EventTransferError",
        data.transferErrorEvents,
        assignBlockRange,
      )
    )
  }

  if (data.unbondingBeginEvents.length > 0) {
    savePromises.push(
      optimizedBulkCreate(
        "EventApplicationUnbondingBegin",
        data.unbondingBeginEvents,
        assignBlockRange,
      )
    )
  }

  if (data.unbondingEndEvents.length > 0) {
    savePromises.push(
      optimizedBulkCreate(
        "EventApplicationUnbondingEnd",
        data.unbondingEndEvents,
        assignBlockRange,
      )
    )
  }

  if (savePromises.length > 0) {
    await Promise.all(savePromises)
  }
}

export async function indexApplications(msgByType: MessageByType, eventByType: EventByType): Promise<void> {
  const msgTypes = [
    "/pocket.application.MsgDelegateToGateway",
    "/pocket.application.MsgUndelegateFromGateway",
    "/pocket.application.MsgUnstakeApplication",
    "/pocket.application.MsgStakeApplication",
    "/pocket.migration.MsgClaimMorseApplication",
    "/pocket.application.MsgTransferApplication",
    // we want to handle this in case there is an update for the global inflation per claim param
    "/cosmos.authz.v1beta1.MsgExec"
  ];

  const eventTypes = [
    "pocket.application.EventTransferBegin",
    "pocket.application.EventTransferEnd",
    "pocket.application.EventTransferError",
    "pocket.application.EventApplicationUnbondingBegin",
    "pocket.application.EventApplicationUnbondingEnd",
    "pocket.tokenomics.EventClaimSettled",
    "pocket.tokenomics.EventApplicationReimbursementRequest",
    "pocket.tokenomics.EventApplicationOverserviced",
  ];

  const recordId = getApplicationRecordIdGetters();

  const eventsAndMessages = sortEventsAndMsgs([
    ...msgTypes.map(type => msgByType[type]).flat(),
    ...eventTypes.map(type => eventByType[type]).flat()
  ]);

  const { applications, applicationsToFetchGateways, applicationsToFetchServices } = collectApplicationIds(eventsAndMessages, recordId);
  const record = await fetchApplicationData(applications, applicationsToFetchServices, applicationsToFetchGateways);

  const {
    applicationsToClose,
    claimApplicationMsgs,
    delegateToGatewayMsgs,
    gatewaysToClose,
    servicesToClose,
    stakeApplicationMsgs,
    transferApplicationMsgs,
    transferBeginEvents,
    transferEndEvents,
    transferErrorEvents,
    unbondingBeginEvents,
    unbondingEndEvents,
    undelegateFromGatewayMsgs,
    unstakeApplicationMsgs
  } = await processApplicationEventsAndMessages(eventsAndMessages, record, recordId);

  const { applicationsToSave, gatewaysToSave, servicesToSave } = buildApplicationSaveLists(record);

  await performApplicationDatabaseOperations({
    applicationsToSave,
    servicesToSave,
    gatewaysToSave,
    applicationsToClose,
    servicesToClose,
    gatewaysToClose,
    stakeApplicationMsgs,
    claimApplicationMsgs,
    unstakeApplicationMsgs,
    transferApplicationMsgs,
    delegateToGatewayMsgs,
    undelegateFromGatewayMsgs,
    transferBeginEvents,
    transferEndEvents,
    transferErrorEvents,
    unbondingBeginEvents,
    unbondingEndEvents
  });
}


function sortEventsAndMsgs(allData: Array<CosmosEvent | CosmosMessage>): Array<CosmosEvent | CosmosMessage> {
  const allEvents: Array<CosmosEvent> = [], allMsgs: Array<CosmosMessage> = [];

  for (const datum of allData) {
    if ('event' in datum) {
      allEvents.push(datum)
    } else {
      allMsgs.push(datum)
    }
  }

  const {success: successfulEvents} = filterEventsByTxStatus(allEvents)

  const {success: successfulMsgs} = filterMsgByTxStatus(allMsgs)

  const finalizedEvents: Array<CosmosEvent> = []
  const nonFinalizedData: Array<CosmosEvent | CosmosMessage & {rank: 0 | 1}> = []

  for (const datum of [...successfulEvents, ...successfulMsgs]) {
    if ('event' in datum && isEventOfFinalizedBlockKind(datum)) {
      finalizedEvents.push(datum)
    } else {
      nonFinalizedData.push({
        ...datum,
        rank: 'event' in datum ? 1 : 0
      })
    }
  }

  return [
    ...orderBy(nonFinalizedData, ['tx.idx', 'rank', 'idx'], ['asc', 'asc', 'asc']),
    ...orderBy(finalizedEvents, ['idx'], ['asc'])
  ]
}
