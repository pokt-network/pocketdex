import { toHex } from "@cosmjs/encoding";
import { CosmosEvent, CosmosMessage, CosmosTransaction } from "@subql/types-cosmos";
import { Coin } from "../../client/cosmos/base/v1beta1/coin";
import {
  ApplicationUnbondingReason as ApplicationUnbondingReasonSDKType,
  applicationUnbondingReasonFromJSON,
} from "../../client/pocket/application/event";
import {
  Application,
  ApplicationGateway, ApplicationUnbondingReason,
  EventApplicationUnbondingBegin as EventApplicationUnbondingBeginEntity,
  EventApplicationUnbondingEnd as EventApplicationUnbondingEndEntity,
  EventTransferBegin as EventTransferBeginEntity,
  EventTransferEnd as EventTransferEndEntity,
  EventTransferError as EventTransferErrorEntity,
  MsgDelegateToGateway as MsgDelegateToGatewayEntity,
  MsgTransferApplication as MsgTransferApplicationEntity,
  MsgUndelegateFromGateway as MsgUndelegateFromGatewayEntity,
  MsgUnstakeApplication as MsgUnstakeApplicationEntity,
  StakeStatus,
} from "../../types";
import { ApplicationProps } from "../../types/models/Application";
import { ApplicationGatewayProps } from "../../types/models/ApplicationGateway";
import { ApplicationServiceProps } from "../../types/models/ApplicationService";
import { MsgClaimMorseApplicationProps } from "../../types/models/MsgClaimMorseApplication";
import { MsgClaimMorseApplicationServiceProps } from "../../types/models/MsgClaimMorseApplicationService";
import { MsgStakeApplicationProps } from "../../types/models/MsgStakeApplication";
import { MsgStakeApplicationServiceProps } from "../../types/models/MsgStakeApplicationService";
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
import {ApplicationServiceConfig as ApplicationServiceConfigType} from "../../types/proto-interfaces/pocket/shared/service"
import { getSequelize, getStoreModel, optimizedBulkCreate } from "../utils/db";
import {
  getAppDelegatedToGatewayId,
  getBlockId,
  getEventId,
  getMsgStakeServiceId,
  getStakeServiceId,
  messageId,
} from "../utils/ids";
import { Ed25519, pubKeyToAddress } from "../utils/pub_key";
import { updateMorseClaimableAccounts } from "./migration";
import { fetchAllApplicationGatewayByApplicationId, fetchAllApplicationServiceByApplicationId } from "./pagination";

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

interface StakeApplicationProps {
  address: string;
  stakeAmount: bigint;
  stakeDenom: string;
  msgId: string;
  services: Array<ApplicationServiceConfigType>;
  serviceMsgIdKey: 'claimMsgId' | 'stakeMsgId'
}

type ClaimOrStake<T extends StakeApplicationProps['serviceMsgIdKey']> = T extends 'claimMsgId' ? MsgClaimMorseApplicationServiceProps : MsgStakeApplicationServiceProps

async function _stakeApplication<T extends StakeApplicationProps['serviceMsgIdKey']>({
  address,
  msgId,
  serviceMsgIdKey,
  services,
  stakeAmount,
  stakeDenom
}: StakeApplicationProps): Promise<[
  ApplicationProps,
  Array<ClaimOrStake<T>>,
  Array<ApplicationServiceProps>,
]> {
  // we need to get application already saved in case it is being transferred
  // because if we overwrite the application, we will lose the transfer information
  const prevApp = await Application.get(address);

  const application: ApplicationProps = {
    id: address,
    accountId: address,
    stakeAmount,
    stakeDenom,
    stakeStatus: StakeStatus.Staked,
    transferringToId: prevApp?.transferringToId,
    transferEndHeight: prevApp?.transferEndHeight,
  };

  // used to create the services that came in the stake message
  const appMsgStakeServices: Array<ClaimOrStake<T>> = [];
  // used to have the services that are currently configured for the application
  const newApplicationServices: Array<ApplicationServiceProps> = [];

  for (const { serviceId } of services) {
    appMsgStakeServices.push({
      id: getMsgStakeServiceId(msgId, serviceId),
      serviceId,
      [serviceMsgIdKey]: msgId,
    } as ClaimOrStake<T>);

    newApplicationServices.push({
      id: getStakeServiceId(address, serviceId),
      serviceId,
      applicationId: address,
    });
  }

  return [
    application,
    appMsgStakeServices,
    newApplicationServices,
  ];
}

async function _handleAppMsgStake(
  msg: CosmosMessage<MsgStakeApplication>,
): Promise<[
  MsgStakeApplicationProps,
  ApplicationProps,
  Array<MsgStakeApplicationServiceProps>,
  Array<ApplicationServiceProps>,
]> {

  const msgId = messageId(msg);
  const { address, stake } = msg.msg.decodedMsg;

  const stakeAmount = BigInt(stake?.amount || "0");
  const stakeDenom = stake?.denom || "";

  const appMsgStake = {
    id: msgId,
    transactionId: msg.tx.hash,
    blockId: getBlockId(msg.block),
    applicationId: address,
    messageId: msgId,
    stakeAmount,
    stakeDenom,
  };

  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  return [
    appMsgStake,
    ...await _stakeApplication({
      address,
      msgId,
      services: msg.msg.decodedMsg.services,
      stakeAmount,
      stakeDenom,
      serviceMsgIdKey: 'stakeMsgId'
    }),
  ];
}
async function _handleMsgClaimMorseApplication(
  msg: CosmosMessage<MsgClaimMorseApplication>,
): Promise<[
  MsgClaimMorseApplicationProps,
  ApplicationProps,
  Array<MsgClaimMorseApplicationServiceProps>,
  Array<ApplicationServiceProps>,
]> {

  const msgId = messageId(msg);
  const { shannonDestAddress, } = msg.msg.decodedMsg;

  let stakeCoin: Coin | null = null, balanceCoin: Coin | null = null, app: ApplicationSDKType | null = null;

  for (const event of msg.tx.tx.events) {
    if (event.type === 'pocket.migration.EventMorseApplicationClaimed') {
      for (const attribute of event.attributes) {
        if (attribute.key === 'claimed_balance') {
          const coin: CoinSDKType = JSON.parse(attribute.value as string);

          balanceCoin = {
            denom: coin.denom,
            amount: coin.amount,
          }
        }

        if (attribute.key === 'claimed_application_stake') {
          const coin: CoinSDKType = JSON.parse(attribute.value as string);

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

  const stakeAmount = BigInt(stakeCoin.amount);
  const stakeDenom = stakeCoin.denom;

  const msgClaimMorseApplication: MsgClaimMorseApplicationProps = {
    id: msgId,
    transactionId: msg.tx.hash,
    blockId: getBlockId(msg.block),
    applicationId: shannonDestAddress,
    messageId: msgId,
    stakeAmount: stakeAmount,
    stakeDenom,
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
  };

  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  return [
    msgClaimMorseApplication,
    ...await _stakeApplication({
      address: shannonDestAddress,
      msgId,
      services: [msg.msg.decodedMsg.serviceConfig!],
      stakeAmount: BigInt(app.stake.amount),
      stakeDenom: app.stake.denom,
      serviceMsgIdKey: 'claimMsgId'
    }),
  ];
}

async function _handleDelegateToGatewayMsg(
  msg: CosmosMessage<MsgDelegateToGateway>,
) {
  // logger.debug(`[handleDelegateToGatewayMsg] (msg.msg): ${stringify(msg.msg, undefined, 2)})`);

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
      blockId: getBlockId(msg.block),
      messageId: msgId,
    }).save(),
  ]);
}

async function _handleUndelegateFromGatewayMsg(
  msg: CosmosMessage<MsgUndelegateFromGateway>,
) {
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
      blockId: getBlockId(msg.block),
      messageId: msgId,
    }).save(),
  ]);
}

async function _handleUnstakeApplicationMsg(
  msg: CosmosMessage<MsgUnstakeApplication>,
) {
  const application = await Application.get(msg.msg.decodedMsg.address);

  if (!application) {
    throw new Error(`[handleUnstakeApplicationMsg] application not found for address ${msg.msg.decodedMsg.address}`);
  }

  application.stakeStatus = StakeStatus.Unstaking;
  application.unstakingBeginBlockId = getBlockId(msg.block);

  const msgId = messageId(msg);

  await Promise.all([
    application.save(),
    MsgUnstakeApplicationEntity.create({
      id: msgId,
      applicationId: msg.msg.decodedMsg.address,
      transactionId: msg.tx.hash,
      blockId: getBlockId(msg.block),
      messageId: msgId,
    }).save(),
  ]);
}

async function _handleTransferApplicationMsg(
  msg: CosmosMessage<MsgTransferApplication>,
) {
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
      blockId: getBlockId(msg.block),
      messageId: msgId,
    }).save(),
  ]);
}

async function _handleTransferApplicationBeginEvent(
  event: CosmosEvent,
) {
  const msg = event.msg as CosmosMessage<EventTransferBegin>;
  const tx = event.tx as CosmosTransaction;

  const transferEndHeight = event.event.attributes.find(attribute => attribute.key === "transfer_end_height")?.value as string;

  if (!transferEndHeight) {
    throw new Error(`[handleTransferApplicationBeginEvent] transferEndHeight not found`);
  }

  const application = await Application.get(msg.msg.decodedMsg.sourceAddress);

  if (!application) {
    throw new Error(`[handleTransferApplicationBeginEvent] application not found for address ${msg.msg.decodedMsg.sourceAddress}`);
  }

  application.transferEndHeight = BigInt((transferEndHeight as unknown as string).replaceAll("\"", ""));

  const eventId = getEventId(event);

  await Promise.all([
    application.save(),
    EventTransferBeginEntity.create({
      id: eventId,
      sourceId: msg.msg.decodedMsg.sourceAddress,
      destinationId: msg.msg.decodedMsg.destinationAddress,
      transactionId: tx.hash,
      blockId: getBlockId(event.block),
      eventId,
    }).save(),
  ]);
}

async function _handleTransferApplicationEndEvent(
  event: CosmosEvent,
) {
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

  const prevUnstakingEndBlockId = sourceApplication.unstakingEndBlockId?.valueOf();
  sourceApplication.transferringToId = undefined;
  sourceApplication.transferEndHeight = undefined;
  sourceApplication.transferEndBlockId = getBlockId(event.block);
  sourceApplication.stakeStatus = StakeStatus.Unstaked;
  sourceApplication.unstakingReason = ApplicationUnbondingReason.TRANSFER;
  sourceApplication.unstakingEndBlockId = getBlockId(event.block);

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
    transferredFromAtId: getBlockId(event.block),
    unstakingEndBlockId: prevUnstakingEndBlockId,
    unstakingBeginBlockId: sourceApplication.unstakingBeginBlockId,
  });

  const appDelegatedToGateways: Array<ApplicationGatewayProps> = delegatee_gateway_addresses.map(gateway => ({
    id: getAppDelegatedToGatewayId(destinationApplication.id, gateway),
    applicationId: destinationApplication.id,
    gatewayId: gateway,
  }));

  const sourceApplicationServices = await fetchAllApplicationServiceByApplicationId(sourceAddress);
  const sourceApplicationGateways = await fetchAllApplicationGatewayByApplicationId(sourceAddress);
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
      blockId: getBlockId(event.block),
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
      blockId: getBlockId(event.block),
      eventId,
    }).save(),
  ]);
}

async function _handleApplicationUnbondingBeginEvent(
  event: CosmosEvent,
) {
  const msg = event.msg as CosmosMessage<MsgUnstakeApplication>;

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

  const application = await Application.get(msg.msg.decodedMsg.address);

  if (!application) {
    throw new Error(`[handleApplicationUnbondingBeginEvent] application not found for operator address ${msg.msg.decodedMsg.address}`);
  }

  application.unstakingEndHeight = unstakingEndHeight;
  // comes form the event and parsing it using applicationUnbondingReasonFromJSON function
  application.unstakingReason = getAppUnbondingReasonFromSDK(reason);

  const eventId = getEventId(event);

  await Promise.all([
    application.save(),
    EventApplicationUnbondingBeginEntity.create({
      id: eventId,
      applicationId: msg.msg.decodedMsg.address,
      blockId: getBlockId(event.block),
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

  const application = await Application.get(applicationSdk.address);

  if (!application) {
    throw new Error(`[handleApplicationUnbondingEndEvent] application not found for address ${applicationSdk.address}`);
  }

  application.unstakingEndBlockId = getBlockId(event.block);
  application.stakeStatus = StakeStatus.Unstaked;
  application.unstakingReason = getAppUnbondingReasonFromSDK(reason);

  const applicationServices = (await fetchAllApplicationServiceByApplicationId(applicationSdk.address)).map(item => item.id);

  const eventId = getEventId(event);

  await Promise.all([
    EventApplicationUnbondingEndEntity.create({
      id: eventId,
      blockId: getBlockId(event.block),
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

export async function handleAppMsgStake(
  messages: Array<CosmosMessage<MsgStakeApplication>>,
): Promise<void> {
  const ApplicationServiceModel = getStoreModel("ApplicationService");
  const sequelize = getSequelize("ApplicationService");
  const blockHeight = store.context.getHistoricalUnit();
  const stakeMsgs: Array<MsgStakeApplicationProps> = [];
  const applications: Array<ApplicationProps> = [];
  const stakeAppService: Array<MsgStakeApplicationServiceProps> = [];
  const appService: Array<ApplicationServiceProps> = [];
  const appServices = new Map<string, Set<string>>();
  const markDeleteOr: Array<unknown> = [];

  for (const msg of messages) {
    // it needs to query db to know the current app <> service relations that need to remove
    const r = await _handleAppMsgStake(msg);
    const address = msg.msg.decodedMsg.address;
    msg.msg.decodedMsg.services.forEach(service => {
      if (!appServices.has(address)) {
        appServices.set(address, new Set(service.serviceId));
      } else {
        appServices.get(address)?.add(service.serviceId);
      }
    });

    stakeMsgs.push(r[0]);
    applications.push(r[1]);
    stakeAppService.push(...r[2]);
    appService.push(...r[3]);
  }

  for (const [address, services] of appServices) {
    markDeleteOr.push({
      [Symbol.for("and")]: [
        // apps
        { application_id: address },
        // does not match the current stake services
        { service_id: { [Symbol.for("notIn")]: Array.from(services) } },
      ],
    });
  }

  await Promise.all([
    store.bulkCreate("Application", applications),
    store.bulkCreate("ApplicationService", appService),
    optimizedBulkCreate("MsgStakeApplication", stakeMsgs),
    optimizedBulkCreate("MsgStakeApplicationService", stakeAppService),
    ApplicationServiceModel.model.update(
      // mark as deleted (close the block range)
      {
        __block_range: sequelize.fn(
          "int8range",
          sequelize.fn("lower", sequelize.col("_block_range")),
          blockHeight,
        ),
      },
      {
        hooks: false,
        where: {
          [Symbol.for("or")]: markDeleteOr,
          // in the range
          __block_range: { [Symbol.for("contains")]: blockHeight },
        },
        transaction: store.context.transaction,
      },
    ),
  ]);
}

export async function handleMsgClaimMorseApplication(
  messages: Array<CosmosMessage<MsgClaimMorseApplication>>,
): Promise<void> {
  const ApplicationServiceModel = getStoreModel("ApplicationService");
  const sequelize = getSequelize("ApplicationService");
  const blockHeight = store.context.getHistoricalUnit();
  const claimMsgs: Array<MsgClaimMorseApplicationProps> = [];
  const applications: Array<ApplicationProps> = [];
  const claimAppService: Array<MsgClaimMorseApplicationServiceProps> = [];
  const appService: Array<ApplicationServiceProps> = [];
  const appServices = new Map<string, Set<string>>();
  const markDeleteOr: Array<unknown> = [];

  for (const msg of messages) {
    // it needs to query db to know the current app <> service relations that need to remove
    const r = await _handleMsgClaimMorseApplication(msg);

    const {serviceConfig, shannonDestAddress: address } = msg.msg.decodedMsg;

    if (serviceConfig) {
      if (!appServices.has(address)) {
        appServices.set(address, new Set(serviceConfig.serviceId));
      } else {
        appServices.get(address)?.add(serviceConfig.serviceId);
      }
    }

    claimMsgs.push(r[0]);
    applications.push(r[1]);
    claimAppService.push(...r[2]);
    appService.push(...r[3]);
  }

  for (const [address, services] of appServices) {
    markDeleteOr.push({
      [Symbol.for("and")]: [
        // apps
        { application_id: address },
        // does not match the current stake services
        { service_id: { [Symbol.for("notIn")]: Array.from(services) } },
      ],
    });
  }

  await Promise.all([
    store.bulkCreate("Application", applications),
    store.bulkCreate("ApplicationService", appService),
    optimizedBulkCreate("MsgClaimMorseApplication", claimMsgs),
    optimizedBulkCreate("MsgClaimMorseApplicationService", claimAppService),
    ApplicationServiceModel.model.update(
      // mark as deleted (close the block range)
      {
        __block_range: sequelize.fn(
          "int8range",
          sequelize.fn("lower", sequelize.col("_block_range")),
          blockHeight,
        ),
      },
      {
        hooks: false,
        where: {
          [Symbol.for("or")]: markDeleteOr,
          // in the range
          __block_range: { [Symbol.for("contains")]: blockHeight },
        },
        transaction: store.context.transaction,
      },
    ),
    updateMorseClaimableAccounts(
      messages.map((msg) => ({
        publicKey: msg.msg.decodedMsg.morsePublicKey,
        destinationAddress: msg.msg.decodedMsg.shannonDestAddress,
      }))
    )
  ]);
}

export async function handleDelegateToGatewayMsg(
  messages: Array<CosmosMessage<MsgDelegateToGateway>>,
): Promise<void> {
  await Promise.all(messages.map(_handleDelegateToGatewayMsg));
}

export async function handleUndelegateFromGatewayMsg(
  messages: Array<CosmosMessage<MsgUndelegateFromGateway>>,
): Promise<void> {
  await Promise.all(messages.map(_handleUndelegateFromGatewayMsg));
}

export async function handleUnstakeApplicationMsg(
  messages: Array<CosmosMessage<MsgUnstakeApplication>>,
): Promise<void> {
  await Promise.all(messages.map(_handleUnstakeApplicationMsg));
}

export async function handleTransferApplicationMsg(
  messages: Array<CosmosMessage<MsgTransferApplication>>,
): Promise<void> {
  await Promise.all(messages.map(_handleTransferApplicationMsg));
}

export async function handleTransferApplicationBeginEvent(
  events: Array<CosmosEvent>,
): Promise<void> {
  await Promise.all(events.map(_handleTransferApplicationBeginEvent));
}

export async function handleTransferApplicationEndEvent(
  events: Array<CosmosEvent>,
): Promise<void> {
  await Promise.all(events.map(_handleTransferApplicationEndEvent));
}

export async function handleTransferApplicationErrorEvent(
  events: Array<CosmosEvent>,
): Promise<void> {
  await Promise.all(events.map(_handleTransferApplicationErrorEvent));
}

export async function handleApplicationUnbondingEndEvent(
  events: Array<CosmosEvent>,
): Promise<void> {
  await Promise.all(events.map(_handleApplicationUnbondingEndEvent));
}

export async function handleApplicationUnbondingBeginEvent(
  events: Array<CosmosEvent>,
): Promise<void> {
  await Promise.all(events.map(_handleApplicationUnbondingBeginEvent));
}
