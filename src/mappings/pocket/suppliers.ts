import { toHex } from "@cosmjs/encoding";
import {
  CosmosEvent,
  CosmosMessage,
} from "@subql/types-cosmos";
import { get, orderBy } from "lodash";
import { Coin } from "../../client/cosmos/base/v1beta1/coin";
import { parseCoins } from "../../cosmjs/utils";
import {
  MorseSupplierClaimSignerType,
  StakeStatus,
  Supplier,
  SupplierEndpoint,
  SupplierRevShare,
  SupplierServiceConfig,
  SupplierUnbondingReason,
} from "../../types";
import { EventSupplierServiceConfigActivatedProps } from "../../types/models/EventSupplierServiceConfigActivated";
import { EventSupplierSlashedProps } from "../../types/models/EventSupplierSlashed";
import { EventSupplierUnbondingBeginProps } from "../../types/models/EventSupplierUnbondingBegin";
import { EventSupplierUnbondingEndProps } from "../../types/models/EventSupplierUnbondingEnd";
import { MsgClaimMorseSupplierProps } from "../../types/models/MsgClaimMorseSupplier";
import { MsgStakeSupplierProps } from "../../types/models/MsgStakeSupplier";
import { MsgUnstakeSupplierProps } from "../../types/models/MsgUnstakeSupplier";
import { SupplierProps } from "../../types/models/Supplier";
import { SupplierServiceConfigProps } from "../../types/models/SupplierServiceConfig";
import { CoinSDKType } from "../../types/proto-interfaces/cosmos/base/v1beta1/coin";
import { MorseSupplierClaimSignerTypeSDKType } from "../../types/proto-interfaces/pocket/migration/morse_onchain";
import { MsgClaimMorseSupplier } from "../../types/proto-interfaces/pocket/migration/tx";
import { SupplierSDKType } from "../../types/proto-interfaces/pocket/shared/supplier";
import {
  supplierUnbondingReasonFromJSON,
  SupplierUnbondingReasonSDKType,
} from "../../types/proto-interfaces/pocket/supplier/event";
import {
  MsgStakeSupplier,
  MsgUnstakeSupplier,
} from "../../types/proto-interfaces/pocket/supplier/tx";
import {
  fetchPaginatedRecords,
  getSequelize,
  getStoreModel,
  optimizedBulkCreate
} from "../utils/db";
import {
  getBlockId,
  getEventId,
  getStakeServiceId,
  messageId,
} from "../utils/ids";
import { parseAttribute } from "../utils/json";
import {
  filterEventsByTxStatus,
  filterMsgByTxStatus,
  getDenomAndAmount,
  isEventOfFinalizedBlockKind
} from "../utils/primitives";
import {
  Ed25519,
  pubKeyToAddress,
} from "../utils/pub_key";
import { getAttributes, getClaimProofStatusFromSDK } from "./relays";

function getMorseSupplierClaimSignerType(item: typeof MorseSupplierClaimSignerTypeSDKType | string | number): MorseSupplierClaimSignerType {
  switch (item) {
    case 0:
    case "MORSE_SUPPLIER_CLAIM_SIGNER_TYPE_UNSPECIFIED":
    case MorseSupplierClaimSignerTypeSDKType.MORSE_SUPPLIER_CLAIM_SIGNER_TYPE_UNSPECIFIED:
      return MorseSupplierClaimSignerType.MORSE_SUPPLIER_CLAIM_SIGNER_TYPE_UNSPECIFIED
    case 1:
    case "MORSE_SUPPLIER_CLAIM_SIGNER_TYPE_CUSTODIAL_SIGNED_BY_NODE_ADDR":
    case MorseSupplierClaimSignerTypeSDKType.MORSE_SUPPLIER_CLAIM_SIGNER_TYPE_CUSTODIAL_SIGNED_BY_NODE_ADDR:
      return MorseSupplierClaimSignerType.MORSE_SUPPLIER_CLAIM_CUSTODIAL_SIGNED_BY_NODE_ADDR
    case 2:
    case "MORSE_SUPPLIER_CLAIM_SIGNER_TYPE_NON_CUSTODIAL_SIGNED_BY_NODE_ADDR":
    case MorseSupplierClaimSignerTypeSDKType.MORSE_SUPPLIER_CLAIM_SIGNER_TYPE_NON_CUSTODIAL_SIGNED_BY_NODE_ADDR:
      return MorseSupplierClaimSignerType.MORSE_SUPPLIER_CLAIM_NON_CUSTODIAL_SIGNED_BY_NODE_ADDR
    case 3:
    case "MORSE_SUPPLIER_CLAIM_SIGNER_TYPE_NON_CUSTODIAL_SIGNED_BY_OWNER":
    case MorseSupplierClaimSignerTypeSDKType.MORSE_SUPPLIER_CLAIM_SIGNER_TYPE_NON_CUSTODIAL_SIGNED_BY_OWNER:
      return MorseSupplierClaimSignerType.MORSE_SUPPLIER_CLAIM_NON_CUSTODIAL_SIGNED_BY_OWNER
    default:
      throw new Error(`Unknown MorseSupplierClaimSignerType=${item}`)
  }
}

function getSupplierUnbondingReasonFromSDK(item: typeof SupplierUnbondingReasonSDKType | string | number): SupplierUnbondingReason {
  switch (item) {
    case 0:
    case SupplierUnbondingReasonSDKType.SUPPLIER_UNBONDING_REASON_UNSPECIFIED:
    case "SUPPLIER_UNBONDING_REASON_UNSPECIFIED":
      return SupplierUnbondingReason.UNSPECIFIED
    case 1:
    case SupplierUnbondingReasonSDKType.SUPPLIER_UNBONDING_REASON_VOLUNTARY:
    case "SUPPLIER_UNBONDING_REASON_VOLUNTARY":
      return SupplierUnbondingReason.VOLUNTARY
    case 2:
    case SupplierUnbondingReasonSDKType.SUPPLIER_UNBONDING_REASON_BELOW_MIN_STAKE:
    case "SUPPLIER_UNBONDING_REASON_BELOW_MIN_STAKE":
      return SupplierUnbondingReason.BELOW_MIN_STAKE
    case 3:
    case SupplierUnbondingReasonSDKType.SUPPLIER_UNBONDING_REASON_MIGRATION:
    case "SUPPLIER_UNBONDING_REASON_MIGRATION":
      return SupplierUnbondingReason.MIGRATION
    default:
      throw new Error(`Unknown SupplierUnbondingReason=${item}`)
  }
}

function _handleClaimSupplier(
  msg: CosmosMessage<MsgClaimMorseSupplier>,
  record: Record<string, {
    supplier?: SupplierProps,
    services?: Record<string, SupplierServiceConfigProps>,
  }>
): {
  supplier: SupplierProps,
  msgClaimSupplier: MsgClaimMorseSupplierProps,
  services: Array<SupplierServiceConfigProps>,
  servicesToRemove: Array<string>,
} {
  let stakeCoin: Coin | null = null, balanceCoin: Coin | null = null, claimSignerType: string | null = null;

  for (const event of msg.tx.tx.events) {
    if (event.type === 'pocket.migration.EventMorseSupplierClaimed') {
      for (const attribute of event.attributes) {
        if (attribute.key === 'claim_signer_type') {
          claimSignerType = (attribute.value as string).replaceAll("\"", "");
        }

        if (attribute.key === 'claimed_balance') {
          const coin: CoinSDKType = getDenomAndAmount(attribute.value as string);

          balanceCoin = {
            denom: coin.denom,
            amount: coin.amount,
          }
        }

        if (attribute.key === 'claimed_supplier_stake') {
          const coin: CoinSDKType = getDenomAndAmount(attribute.value as string);

          stakeCoin = {
            denom: coin.denom,
            amount: coin.amount,
          }
        }
      }
    }
  }

  if (!stakeCoin) {
    throw new Error(`[handleMsgClaimMorseSupplier] stake coin not found in event`);
  }

  if (!balanceCoin) {
    throw new Error(`[handleMsgClaimMorseSupplier] balance coin not found in event`);
  }

  const {
    services: rawServices,
    shannonOperatorAddress: operatorAddress,
    shannonOwnerAddress: ownerAddress,
  } = msg.msg.decodedMsg;

  const msgId = messageId(msg);

  return {
    supplier: {
      id: operatorAddress,
      operatorId: operatorAddress,
      ownerId: ownerAddress,
      stakeAmount: (
        BigInt(stakeCoin.amount) +
        BigInt(record[operatorAddress]?.supplier?.stakeAmount?.toString() || '0')
      ),
      stakeDenom: stakeCoin.denom,
      stakeStatus: StakeStatus.Staked,
      unstakingEndHeight: undefined,
      unstakingEndBlockId: undefined,
      unstakingBeginBlockId: undefined,
      unstakingReason: undefined,
    },
    msgClaimSupplier: {
      id: msgId,
      supplierId: msg.msg.decodedMsg.shannonOperatorAddress,
      shannonSigningAddress: msg.msg.decodedMsg.shannonSigningAddress,
      shannonOwnerAddress: msg.msg.decodedMsg.shannonOwnerAddress,
      shannonOperatorAddress: msg.msg.decodedMsg.shannonOperatorAddress,
      morsePublicKey: toHex(msg.msg.decodedMsg.morsePublicKey),
      morseSrcAddress: pubKeyToAddress(
        Ed25519,
        msg.msg.decodedMsg.morsePublicKey,
        undefined,
        true
      ),
      morseSignature: toHex(msg.msg.decodedMsg.morseSignature),
      stakeAmount: BigInt(stakeCoin.amount),
      stakeDenom: stakeCoin.denom,
      balanceAmount: BigInt(balanceCoin.amount),
      balanceDenom: balanceCoin.denom,
      blockId: getBlockId(msg.block),
      transactionId: msg.tx.hash,
      messageId: msgId,
      morseNodeAddress: msg.msg.decodedMsg.morseNodeAddress,
      signerIsOutputAddress: msg.msg.decodedMsg.signerIsOutputAddress,
      claimSignerType: claimSignerType ? getMorseSupplierClaimSignerType(claimSignerType) : undefined,
    },
    ...getServices(
      rawServices,
      operatorAddress,
      Object.keys(record[operatorAddress]?.services || {})
    )
  }
}

function _handleEventSupplierServiceConfigActivated(
  event: CosmosEvent,
  record: Record<string, {
    supplier?: SupplierProps,
    services?: Record<string, SupplierServiceConfigProps>,
  }>
): {
  services: Array<SupplierServiceConfigProps>,
  serviceConfigEvent: EventSupplierServiceConfigActivatedProps,
} {
  let activationHeight: bigint | null = null, operatorAddress: string | undefined, serviceId: string | undefined;

  for (const {key, value} of event.event.attributes) {
    if (key === "activation_height") {
      activationHeight = BigInt((value as string).replaceAll('"', ''));
    }

    if (key === "supplier") {
      operatorAddress = (JSON.parse(value as unknown as string) as SupplierSDKType).operator_address;
    }

    if (key === "operator_address") {
      operatorAddress = (value as string).replaceAll('"', '');
    }
  }

  if (!activationHeight) {
    throw new Error(`[handleEventSupplierServiceConfigActivated] activation_height not found in event`);
  }

  if (!operatorAddress) {
    throw new Error(`[handleEventSupplierServiceConfigActivated] operatorAddress not found in event`);
  }

  let services: Array<SupplierServiceConfigProps> = []

  if (serviceId) {
    const service = record[operatorAddress]?.services?.[getStakeServiceId(operatorAddress, serviceId)];

    if (service) {
      services = [
        service
      ]
    }
  }

  if (services.length === 0) {
    services = Object.values(record[operatorAddress]?.services || {});
  }

  const eventId = getEventId(event);

  return {
    services: services
      .filter((service) => !service.activatedAtId)
      .map((service) => {
        service.activatedAtId = activationHeight;
        service.activatedEventId = eventId;
        return service;
      }),
    serviceConfigEvent: {
      id: eventId,
      eventId: eventId,
      blockId: getBlockId(event.block),
    }
  }
}

function _handleSupplierUnbondingBeginEvent(
  event: CosmosEvent,
  record: Record<string, {
    supplier?: SupplierProps,
    services?: Record<string, SupplierServiceConfigProps>,
  }>
): {
  supplier: SupplierProps,
  unbondingBeginEvent: EventSupplierUnbondingBeginProps,
} {
  let unbondingHeight: bigint | null = null, sessionEndHeight: bigint | null = null, operatorAddress: string | undefined, reason: null | number = null;

  for (const attribute of event.event.attributes) {
    if (attribute.key === "supplier") {
      operatorAddress = (JSON.parse(attribute.value as string) as SupplierSDKType).operator_address;
      continue
    }

    const parsedValue = (attribute.value as string).replaceAll('"', '');

    if (attribute.key === "unbonding_end_height") {
      unbondingHeight = BigInt(parsedValue);
    }

    if (attribute.key === "session_end_height") {
      sessionEndHeight = BigInt(parsedValue);
    }

    if (attribute.key === "reason") {
      reason = supplierUnbondingReasonFromJSON(parsedValue);
    }

    if (attribute.key === "operator_address") {
      operatorAddress = parsedValue;
    }
  }

  if (!operatorAddress) {
    throw new Error(`[handleSupplierUnbondingBeginEvent] operatorAddress not provided in event`);
  }

  const supplier = record [operatorAddress]?.supplier

  if (!supplier) {
    throw new Error(`[handleSupplierUnbondingBeginEvent] supplier not found for operator address ${operatorAddress}`);
  }

  const eventId = getEventId(event);

  return {
    supplier: {
      ...supplier,
      ...(unbondingHeight && {
        unstakingEndHeight: unbondingHeight,
      }),
      ...(reason && {
        unstakingReason: getSupplierUnbondingReasonFromSDK(reason)
      })
    },
    unbondingBeginEvent: {
      id: eventId,
      unbondingEndHeight: unbondingHeight || BigInt(0),
      sessionEndHeight: sessionEndHeight || BigInt(0),
      supplierId: operatorAddress,
      blockId: getBlockId(event.block),
      reason: reason !== null ? getSupplierUnbondingReasonFromSDK(reason) : SupplierUnbondingReason.UNSPECIFIED,
      eventId,
    }
  }
}

function _handleSupplierUnbondingEndEvent(
  event: CosmosEvent,
  record: Record<string, {
    supplier?: SupplierProps,
    services?: Record<string, SupplierServiceConfigProps>,
  }>
): {
  supplier: SupplierProps,
  servicesToRemove: Array<string>,
  unbondingEndEvent: EventSupplierUnbondingEndProps,
} {
  let unbondingHeight: bigint | null = null, sessionEndHeight: bigint | null = null, operatorAddress: string | undefined, reason: null | number = null;

  for (const attribute of event.event.attributes) {
    if (attribute.key === "supplier") {
      operatorAddress = (JSON.parse(attribute.value as string) as SupplierSDKType).operator_address;
      continue
    }

    const parsedValue = (attribute.value as string).replaceAll('"', '');

    if (attribute.key === "unbonding_end_height") {
      unbondingHeight = BigInt(parsedValue);
    }

    if (attribute.key === "session_end_height") {
      sessionEndHeight = BigInt(parsedValue);
    }

    if (attribute.key === "reason") {
      reason = supplierUnbondingReasonFromJSON(parsedValue);
    }

    if (attribute.key === "operator_address") {
      operatorAddress = parsedValue;
    }
  }

  if (!operatorAddress) {
    throw new Error(`[handleSupplierUnbondingEndEvent] operatorAddress not provided in event`);
  }

  const supplierAndServices = record[operatorAddress]
  const supplier = supplierAndServices?.supplier

  if (!supplier) {
    throw new Error(`[handleSupplierUnbondingEndEvent] supplier not found for operator address ${operatorAddress}`);
  }

  supplier.stakeStatus = StakeStatus.Unstaked;

  const eventId = getEventId(event);

  return {
    supplier: {
      ...supplier,
      ...(unbondingHeight && {
        unstakingEndBlockId: unbondingHeight,
      }),
      ...(reason && {
        unstakingReason: getSupplierUnbondingReasonFromSDK(reason)
      })
    },
    unbondingEndEvent: {
      id: eventId,
      unbondingEndHeight: unbondingHeight || BigInt(0),
      sessionEndHeight: sessionEndHeight || BigInt(0),
      reason: reason !== null ? getSupplierUnbondingReasonFromSDK(reason) : SupplierUnbondingReason.UNSPECIFIED,
      blockId: getBlockId(event.block),
      supplierId: operatorAddress,
      eventId,
    },
    servicesToRemove: Object.keys(supplierAndServices?.services || {})
  }
}

function getServices(
  rawServices: MsgStakeSupplier['services'],
  operatorAddress: string,
  existingServicesId: Array<string>
) {
  // to compare with the current services and know which one to remove
  const servicesId: Array<string> = [];
  // services to save
  const services: Array<SupplierServiceConfigProps> = [];

  for (const { endpoints, revShare, serviceId } of rawServices) {
    servicesId.push(serviceId);

    const endpointsArr: Array<SupplierEndpoint> = endpoints.map((endpoint) => ({
      url: endpoint.url,
      rpcType: endpoint.rpcType,
      configs: endpoint.configs,
    }));

    const revShareArr: Array<SupplierRevShare> = revShare.map((revShare) => ({
      address: revShare.address,
      revSharePercentage: revShare.revSharePercentage.toString(),
    }));

    services.push({
      id: getStakeServiceId(operatorAddress, serviceId),
      serviceId,
      supplierId: operatorAddress,
      endpoints: endpointsArr,
      revShare: revShareArr,
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

function _handleSupplierStakeMsg(
  msg: CosmosMessage<MsgStakeSupplier>,
  record: Record<string, {
    supplier?: SupplierProps,
    services?: Record<string, SupplierServiceConfigProps>,
  }>
): {
  supplier: SupplierProps,
  msgStakeSupplier: MsgStakeSupplierProps,
  services: Array<SupplierServiceConfigProps>,
  servicesToRemove: Array<string>,
} {
  // the MsgStakeSupplier can come without the stake field, so we need to get the previous stake
  let stake = msg.msg.decodedMsg.stake;

  if (!stake) {
    const previousSupplier = record[msg.msg.decodedMsg.operatorAddress]?.supplier;

    if (!previousSupplier) {
      throw new Error(`[handleSupplierStakeMsg] previous supplier not found for operator address ${msg.msg.decodedMsg.operatorAddress}`);
    }

    stake = {
      amount: previousSupplier.stakeAmount.toString(),
      denom: previousSupplier.stakeDenom,
    }
  }

  if (!stake) {
    throw new Error(`[handleSupplierStakeMsg] stake not provided in msg`);
  }

  const {operatorAddress, ownerAddress, services: rawServices, signer} = msg.msg.decodedMsg;

  const msgId = messageId(msg);

  return {
    supplier: {
      id: operatorAddress,
      operatorId: operatorAddress,
      ownerId: ownerAddress,
      stakeAmount: BigInt(stake.amount),
      stakeDenom: stake.denom,
      stakeStatus: StakeStatus.Staked,
      unstakingEndHeight: undefined,
      unstakingEndBlockId: undefined,
      unstakingBeginBlockId: undefined,
      unstakingReason: undefined,
    },
    msgStakeSupplier: {
      id: msgId,
      signerId: signer,
      supplierId: operatorAddress,
      ownerId: ownerAddress,
      stakeAmount: BigInt(stake.amount),
      stakeDenom: stake.denom,
      blockId: getBlockId(msg.block),
      transactionId: msg.tx.hash,
      messageId: msgId,
    },
    ...getServices(
      rawServices,
      operatorAddress,
      Object.keys(record[operatorAddress]?.services || {})
    )
  }
}

function _handleUnstakeSupplierMsg(
  msg: CosmosMessage<MsgUnstakeSupplier>,
  record: Record<string, {
    supplier?: SupplierProps,
    services?: Record<string, SupplierServiceConfigProps>,
  }>
): {
  supplier: SupplierProps,
  unstakedMsg: MsgUnstakeSupplierProps
} {
  const {operatorAddress, signer} = msg.msg.decodedMsg;

  const supplier = record[operatorAddress]?.supplier;

  if (!supplier) {
    throw new Error(`[handleUnstakeSupplierMsg] supplier not found for operator address ${msg.msg.decodedMsg.operatorAddress}`);
  }

  const msgId = messageId(msg);

  supplier.stakeStatus = StakeStatus.Unstaking;
  supplier.unstakingBeginBlockId = getBlockId(msg.block);

  return {
    supplier: {
      ...supplier,
      stakeStatus: StakeStatus.Unstaking,
      unstakingBeginBlockId: getBlockId(msg.block)
    },
    unstakedMsg: {
      id: msgId,
      signerId: signer,
      supplierId: operatorAddress,
      blockId: getBlockId(msg.block),
      transactionId: msg.tx.hash,
      messageId: msgId,
    }
  }
}

// V2 handler for EventSupplierSlashed (batch processing - used in indexSupplier)
function _getValuesOldEventSupplierSlashed(event: CosmosEvent) {
  let slashingCoin: CoinSDKType | null = null, operatorAddress = "";

  for (const attribute of event.event.attributes) {
    if (attribute.key === "slashing_amount") {
      slashingCoin = getDenomAndAmount(attribute.value as string);
    }

    if (attribute.key === "proof_missing_penalty") {
      const coins = parseCoins(parseAttribute(attribute.value));
      if (!coins.length) {
        throw new Error(`[handleEventSupplierSlashed] event attribute key=${attribute.key} value=${attribute.value} is not a valid coin`);
      }
    }

    if (attribute.key === "supplier_operator_addr" || attribute.key === "supplier_operator_address") {
      operatorAddress = parseAttribute(attribute.value);
    }
  }

  return {
    proofMissingPenalty: slashingCoin,
    operatorAddress,
    proofValidationStatus: undefined,
    application: "",
    service: "",
    session: "",
    sessionStartHeight: BigInt(0),
    sessionEndHeight: BigInt(0),
  }
}

function _getValuesEventSupplierSlashed(event: CosmosEvent) {
  const {
    claim,
    proofMissingPenalty,
  } = getAttributes(event.event.attributes);

  if (!claim || !claim.session_header || Object.keys(claim).length === 0) {
    logger.warn(`[handleEventSupplierSlashed] claim not found in event, trying to handle with previous version`);
    return _getValuesOldEventSupplierSlashed(event);
  }

  return {
    operatorAddress: claim.supplier_operator_address,
    application: claim.session_header.application_address,
    service: claim.session_header.service_id,
    session: claim.session_header.session_id || "",
    sessionEndHeight: BigInt(claim.session_header.session_end_block_height || "0"),
    sessionStartHeight: BigInt(claim.session_header.session_start_block_height || "0"),
    proofMissingPenalty,
    proofValidationStatus: getClaimProofStatusFromSDK(claim.proof_validation_status),
  }
}

export function _handleEventSupplierSlashed(
  event: CosmosEvent,
  record: Record<string, {
    supplier?: SupplierProps,
    services?: Record<string, SupplierServiceConfigProps>,
  }>
): {
  supplier: SupplierProps,
  slashingEvent: EventSupplierSlashedProps,
} {
  const {
    application,
    operatorAddress,
    proofMissingPenalty,
    proofValidationStatus,
    service,
    session,
    sessionEndHeight,
    sessionStartHeight,
  } = _getValuesEventSupplierSlashed(event);

  if (!operatorAddress) {
    throw new Error(`[handleEventSupplierSlashed] operatorAddress not found in event`);
  }

  if (!proofMissingPenalty) {
    throw new Error(`[handleEventSupplierSlashed] proofMissingPenalty not found in event`);
  }

  const currentSupplier = record[operatorAddress]?.supplier;

  if (!currentSupplier) {
    throw new Error(`[handleEventSupplierSlashed] supplier not found for address: ${operatorAddress}`);
  }

  const previousStakeAmount = currentSupplier.stakeAmount.valueOf();
  const afterStakeAmount = currentSupplier.stakeAmount - BigInt(proofMissingPenalty.amount);

  return {
    supplier: {
      ...currentSupplier,
      stakeAmount: afterStakeAmount,
    },
    slashingEvent: {
      id: getEventId(event),
      supplierId: operatorAddress,
      applicationId: application,
      serviceId: service,
      sessionId: session || "",
      sessionEndHeight,
      sessionStartHeight,
      blockId: getBlockId(event.block),
      eventId: getEventId(event),
      proofMissingPenalty: BigInt(proofMissingPenalty.amount),
      proofMissingPenaltyDenom: proofMissingPenalty.denom,
      previousStakeAmount,
      afterStakeAmount,
      proofValidationStatus: proofValidationStatus,
    }
  }
}

// Type definitions for indexSupplier
type GetIdFromEventAttribute = (attributes: CosmosEvent["event"]["attributes"]) => string | Array<string> | null;
type RecordGetId = Record<string, string | GetIdFromEventAttribute>;

interface MessageByType {
  [key: string]: Array<CosmosMessage>
}

interface EventByType {
  [key: string]: Array<CosmosEvent>
}

interface SupplierRecord {
  supplier?: SupplierProps;
  services?: Record<string, SupplierServiceConfigProps>;
}

// Helper: Get record ID getters configuration
function getSupplierRecordIdGetters(): RecordGetId {
  const eventGetId = (attributes: CosmosEvent["event"]["attributes"]) => {
    for (const attribute of attributes) {
      if (attribute.key === "supplier") {
        return JSON.parse(attribute.value as string).operator_address;
      }

      if (attribute.key === "operator_address") {
        return (attribute.value as string).replaceAll('"', '');
      }
    }

    return null;
  };

  const slashingGetId = (attributes: CosmosEvent["event"]["attributes"]) => {
    for (const attribute of attributes) {
      if (attribute.key === "supplier_operator_addr" || attribute.key === "supplier_operator_address") {
        return (attribute.value as string).replaceAll('"', '');
      }

      if (attribute.key === "claim") {
        return JSON.parse(attribute.value as string).supplier_operator_address;
      }

      if (attribute.key === "supplier_operator_address") {
        return (attribute.value as string).replaceAll('"', '');
      }
    }

    return null;
  };

  return {
    "/pocket.supplier.MsgUnstakeSupplier": "operatorAddress",
    "/pocket.supplier.MsgStakeSupplier": "operatorAddress",
    "/pocket.migration.MsgClaimMorseSupplier": "shannonOperatorAddress",
    "pocket.supplier.EventSupplierUnbondingBegin": eventGetId,
    "pocket.supplier.EventSupplierUnbondingEnd": eventGetId,
    "pocket.supplier.EventSupplierServiceConfigActivated": eventGetId,
    "pocket.tokenomics.EventSupplierSlashed": slashingGetId,
  };
}

// Helper: Collect supplier IDs from events and messages
function collectSupplierIds(
  eventsAndMessages: Array<CosmosEvent | CosmosMessage>,
  recordId: RecordGetId
): {
  suppliers: Array<string>;
  suppliersToFetchServices: Array<string>;
} {
  const suppliers: Array<string> = [];
  const suppliersToFetchServices: Array<string> = [];

  for (const eventOrMsg of eventsAndMessages) {
    if ('event' in eventOrMsg) {
      const getEntityId = recordId[eventOrMsg.event.type] as GetIdFromEventAttribute;
      const ids = getEntityId(eventOrMsg.event.attributes);

      if ([
        "pocket.tokenomics.EventSupplierSlashed",
        "pocket.supplier.EventSupplierUnbondingBegin",
        "pocket.supplier.EventSupplierUnbondingEnd",
      ].includes(eventOrMsg.event.type)) {
        if (typeof ids === "string") {
          suppliers.push(ids);
        } else if (ids) {
          suppliers.push(...ids);
        }
      }

      if (eventOrMsg.event.type === "pocket.supplier.EventSupplierServiceConfigActivated") {
        if (typeof ids === "string") {
          suppliersToFetchServices.push(ids);
        } else if (ids) {
          suppliersToFetchServices.push(...ids);
        }
      }
    } else {
      const entityIdPath = recordId[eventOrMsg.msg.typeUrl] as string;

      if ([
        "/pocket.supplier.MsgUnstakeSupplier",
        "/pocket.supplier.MsgStakeSupplier",
        "/pocket.migration.MsgClaimMorseSupplier",
      ].includes(eventOrMsg.msg.typeUrl)) {
        const id = get(eventOrMsg.msg.decodedMsg, entityIdPath);
        suppliers.push(id);

        if (eventOrMsg.msg.typeUrl !== "/pocket.supplier.MsgUnstakeSupplier") {
          suppliersToFetchServices.push(id);
        }
      }
    }
  }

  return { suppliers, suppliersToFetchServices };
}

// Helper: Fetch and prepare supplier records
async function fetchSupplierData(
  suppliers: Array<string>,
  suppliersToFetchServices: Array<string>
): Promise<Record<string, SupplierRecord>> {
  const [fetchedSuppliers, fetchedServices] = await Promise.all([
    fetchPaginatedRecords<Supplier>({
      fetchFn: (options) => Supplier.getByFields(
        [['id', 'in', Array.from(new Set(suppliers))]],
        options
      )
    }),
    fetchPaginatedRecords<SupplierServiceConfig>({
      fetchFn: (options) => SupplierServiceConfig.getByFields(
        [['supplierId', 'in', Array.from(new Set(suppliersToFetchServices))]],
        options
      )
    })
  ]);

  const record: Record<string, SupplierRecord> = {};

  for (const supplier of fetchedSuppliers) {
    record[supplier.id] = {
      supplier: supplier,
      services: {}
    };
  }

  for (const service of fetchedServices) {
    if (!record[service.supplierId]) {
      record[service.supplierId] = { services: {} };
    }

    if (!record[service.supplierId].services) {
      record[service.supplierId].services = {};
    }

    record[service.supplierId].services![service.id] = service;
  }

  return record;
}

// Helper: Process all events and messages
function processSupplierEventsAndMessages(
  eventsAndMessages: Array<CosmosEvent | CosmosMessage>,
  record: Record<string, SupplierRecord>,
  recordId: RecordGetId
): {
  suppliersToClose: Array<string>;
  servicesToClose: Array<string>;
  stakeMsgs: Array<MsgStakeSupplierProps>;
  claimMsgs: Array<MsgClaimMorseSupplierProps>;
  unstakeMsgs: Array<MsgUnstakeSupplierProps>;
  serviceConfigActivatedEvents: Array<EventSupplierServiceConfigActivatedProps>;
  slashingEvents: Array<EventSupplierSlashedProps>;
  unbondingBeginEvents: Array<EventSupplierUnbondingBeginProps>;
  unbondingEndEvents: Array<EventSupplierUnbondingEndProps>;
} {
  const suppliersToClose: Array<string> = Object.keys(record).filter(id => record[id].supplier);
  const servicesToClose: Array<string> = [];
  const stakeMsgs: Array<MsgStakeSupplierProps> = [];
  const claimMsgs: Array<MsgClaimMorseSupplierProps> = [];
  const unstakeMsgs: Array<MsgUnstakeSupplierProps> = [];
  const serviceConfigActivatedEvents: Array<EventSupplierServiceConfigActivatedProps> = [];
  const slashingEvents: Array<EventSupplierSlashedProps> = [];
  const unbondingBeginEvents: Array<EventSupplierUnbondingBeginProps> = [];
  const unbondingEndEvents: Array<EventSupplierUnbondingEndProps> = [];

  for (const eventOrMsg of eventsAndMessages) {
    if ('event' in eventOrMsg) {
      if (eventOrMsg.event.type === "pocket.supplier.EventSupplierServiceConfigActivated") {
        const { serviceConfigEvent, services } = _handleEventSupplierServiceConfigActivated(eventOrMsg, record);
        const getId = recordId[eventOrMsg.event.type] as GetIdFromEventAttribute;
        const operator = getId(eventOrMsg.event.attributes) as string;

        for (const service of services) {
          record[operator].services![service.id] = service;
          servicesToClose.push(service.id);
        }

        serviceConfigActivatedEvents.push(serviceConfigEvent);
      }

      if (eventOrMsg.event.type === "pocket.tokenomics.EventSupplierSlashed") {
        const { slashingEvent, supplier } = _handleEventSupplierSlashed(eventOrMsg, record);
        slashingEvents.push(slashingEvent);
        record[supplier.id].supplier = supplier;
      }

      if (eventOrMsg.event.type === "pocket.supplier.EventSupplierUnbondingBegin") {
        const { supplier, unbondingBeginEvent } = _handleSupplierUnbondingBeginEvent(eventOrMsg, record);
        record[supplier.id].supplier = supplier;
        unbondingBeginEvents.push(unbondingBeginEvent);
      }

      if (eventOrMsg.event.type === "pocket.supplier.EventSupplierUnbondingEnd") {
        const { servicesToRemove, supplier, unbondingEndEvent } = _handleSupplierUnbondingEndEvent(eventOrMsg, record);

        for (const serviceId of servicesToRemove) {
          delete record[supplier.id].services![serviceId];
          servicesToClose.push(serviceId);
        }

        record[supplier.id].supplier = supplier;
        unbondingEndEvents.push(unbondingEndEvent);
      }
    } else {
      if (eventOrMsg.msg.typeUrl === "/pocket.supplier.MsgStakeSupplier") {
        const { msgStakeSupplier, services, servicesToRemove, supplier } = _handleSupplierStakeMsg(
          eventOrMsg as CosmosMessage<MsgStakeSupplier>,
          record
        );

        stakeMsgs.push(msgStakeSupplier);

        if (!record[supplier.id]) {
          record[supplier.id] = { services: {} };
        }

        record[supplier.id].supplier = supplier;

        for (const serviceId of servicesToRemove) {
          delete record[supplier.id].services![serviceId];
          servicesToClose.push(serviceId);
        }

        for (const service of services) {
          record[supplier.id].services![service.id] = service;
          servicesToClose.push(service.id);
        }
      }

      if (eventOrMsg.msg.typeUrl === "/pocket.migration.MsgClaimMorseSupplier") {
        const { msgClaimSupplier, services, servicesToRemove, supplier } = _handleClaimSupplier(eventOrMsg, record);

        claimMsgs.push(msgClaimSupplier);

        if (!record[supplier.id]) {
          record[supplier.id] = { services: {} };
        }

        record[supplier.id].supplier = supplier;

        for (const serviceId of servicesToRemove) {
          delete record[supplier.id].services![serviceId];
          servicesToClose.push(serviceId);
        }

        for (const service of services) {
          record[supplier.id].services![service.id] = service;
          servicesToClose.push(service.id);
        }
      }

      if (eventOrMsg.msg.typeUrl === "/pocket.supplier.MsgUnstakeSupplier") {
        const { supplier, unstakedMsg } = _handleUnstakeSupplierMsg(eventOrMsg, record);
        record[supplier.id].supplier = supplier;
        unstakeMsgs.push(unstakedMsg);
      }
    }
  }

  return {
    suppliersToClose,
    servicesToClose,
    stakeMsgs,
    claimMsgs,
    unstakeMsgs,
    serviceConfigActivatedEvents,
    slashingEvents,
    unbondingBeginEvents,
    unbondingEndEvents
  };
}

// Helper: Build lists of items to save
function buildSupplierSaveLists(record: Record<string, SupplierRecord>): {
  suppliersToSave: Array<SupplierProps>;
  servicesToSave: Array<SupplierServiceConfigProps>;
} {
  const suppliersToSave: Array<SupplierProps> = [];
  const servicesToSave: Array<SupplierServiceConfigProps> = [];

  for (const { services, supplier } of Object.values(record)) {
    if (supplier) {
      suppliersToSave.push(supplier);
    }

    if (services) {
      servicesToSave.push(...Object.values(services));
    }
  }

  return { suppliersToSave, servicesToSave };
}

// Main function: Index supplier data
export async function indexSupplier(msgByType: MessageByType, eventByType: EventByType): Promise<void> {
  const msgTypes = [
    "/pocket.supplier.MsgUnstakeSupplier",
    "/pocket.migration.MsgClaimMorseSupplier",
    "/pocket.supplier.MsgStakeSupplier",
  ];

  const eventTypes = [
    "pocket.supplier.EventSupplierUnbondingBegin",
    "pocket.supplier.EventSupplierUnbondingEnd",
    "pocket.supplier.EventSupplierServiceConfigActivated",
    "pocket.tokenomics.EventSupplierSlashed"
  ];

  const recordId = getSupplierRecordIdGetters();

  const eventsAndMessages = sortEventsAndMsgs([
    ...msgTypes.map(type => msgByType[type]).flat(),
    ...eventTypes.map(type => eventByType[type]).flat()
  ]);

  const { suppliers, suppliersToFetchServices } = collectSupplierIds(eventsAndMessages, recordId);
  const record = await fetchSupplierData(suppliers, suppliersToFetchServices);

  const {
    claimMsgs,
    serviceConfigActivatedEvents,
    servicesToClose,
    slashingEvents,
    stakeMsgs,
    suppliersToClose,
    unbondingBeginEvents,
    unbondingEndEvents,
    unstakeMsgs
  } = processSupplierEventsAndMessages(eventsAndMessages, record, recordId);

  const { servicesToSave, suppliersToSave } = buildSupplierSaveLists(record);

  await performSupplierDatabaseOperations({
    suppliersToSave,
    servicesToSave,
    suppliersToClose,
    servicesToClose,
    stakeMsgs,
    claimMsgs,
    unstakeMsgs,
    serviceConfigActivatedEvents,
    slashingEvents,
    unbondingBeginEvents,
    unbondingEndEvents
  });
}

// Helper: Perform database operations (delete, close, save)
// eslint-disable-next-line complexity
async function performSupplierDatabaseOperations(data: {
  suppliersToSave: Array<SupplierProps>;
  servicesToSave: Array<SupplierServiceConfigProps>;
  suppliersToClose: Array<string>;
  servicesToClose: Array<string>;
  stakeMsgs: Array<MsgStakeSupplierProps>;
  claimMsgs: Array<MsgClaimMorseSupplierProps>;
  unstakeMsgs: Array<MsgUnstakeSupplierProps>;
  serviceConfigActivatedEvents: Array<EventSupplierServiceConfigActivatedProps>;
  slashingEvents: Array<EventSupplierSlashedProps>;
  unbondingBeginEvents: Array<EventSupplierUnbondingBeginProps>;
  unbondingEndEvents: Array<EventSupplierUnbondingEndProps>;
}): Promise<void> {
  const block = store.context.getHistoricalUnit();

  const removeRecords = (model: string) => {
    const sequelize = getSequelize(model);
    return getStoreModel(model).model.destroy({
      where: sequelize.where(
        sequelize.fn("lower", sequelize.col("_block_range")),
        block
      ),
      transaction: store.context.transaction,
    });
  };

  const SupplierModel = getStoreModel("Supplier");
  const SupplierServiceConfigModel = getStoreModel("SupplierServiceConfig");

  // Delete records created at this block
  const deletePromises: Array<Promise<unknown>> = [];

  if (data.suppliersToSave.length > 0) deletePromises.push(removeRecords("Supplier"));
  if (data.servicesToSave.length > 0) deletePromises.push(removeRecords("SupplierServiceConfig"));
  if (data.stakeMsgs.length > 0) deletePromises.push(removeRecords("MsgStakeSupplier"));
  if (data.claimMsgs.length > 0) deletePromises.push(removeRecords("MsgClaimMorseSupplier"));
  if (data.unstakeMsgs.length > 0) deletePromises.push(removeRecords("MsgUnstakeSupplier"));
  if (data.serviceConfigActivatedEvents.length > 0) deletePromises.push(removeRecords("EventSupplierServiceConfigActivated"));
  if (data.slashingEvents.length > 0) deletePromises.push(removeRecords("EventSupplierSlashed"));
  if (data.unbondingBeginEvents.length > 0) deletePromises.push(removeRecords("EventSupplierUnbondingBegin"));
  if (data.unbondingEndEvents.length > 0) deletePromises.push(removeRecords("EventSupplierUnbondingEnd"));

  if (deletePromises.length > 0) {
    await Promise.all(deletePromises);
  }

  // Close block ranges
  const closePromises: Array<Promise<unknown>> = [];

  if (data.suppliersToClose.length > 0) {
    const supplierSequelize = getSequelize("Supplier");
    closePromises.push(
      SupplierModel.model.update(
        {
          __block_range: supplierSequelize.fn(
            "int8range",
            supplierSequelize.fn("lower", supplierSequelize.col("_block_range")),
            BigInt(block),
            '[)'
          ),
        },
        {
          where: {
            id: { [Symbol.for("in")]: data.suppliersToClose },
            __block_range: { [Symbol.for("contains")]: BigInt(block) },
          },
          hooks: false,
          transaction: store.context.transaction,
        }
      )
    );
  }

  if (data.servicesToClose.length > 0) {
    const servicesSequelize = getSequelize("SupplierServiceConfig");
    closePromises.push(
      SupplierServiceConfigModel.model.update(
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
            id: { [Symbol.for("in")]: data.servicesToClose },
            __block_range: { [Symbol.for("contains")]: BigInt(block) },
          },
          hooks: false,
          transaction: store.context.transaction,
        }
      )
    );
  }

  if (closePromises.length > 0) {
    await Promise.all(closePromises);
  }

  // Save new records
  const assignBlockRange = (doc: object) => ({ ...doc, __block_range: [block, null] });
  const savePromises: Array<Promise<unknown>> = [];

  if (data.suppliersToSave.length > 0) {
    savePromises.push(optimizedBulkCreate("Supplier", data.suppliersToSave, 'omit', assignBlockRange));
  }
  if (data.servicesToSave.length > 0) {
    savePromises.push(optimizedBulkCreate("SupplierServiceConfig", data.servicesToSave, 'omit',assignBlockRange));
  }
  if (data.stakeMsgs.length > 0) {
    savePromises.push(optimizedBulkCreate("MsgStakeSupplier", data.stakeMsgs, 'omit', assignBlockRange));
  }
  if (data.claimMsgs.length > 0) {
    savePromises.push(optimizedBulkCreate("MsgClaimMorseSupplier", data.claimMsgs, 'omit', assignBlockRange));
  }
  if (data.unstakeMsgs.length > 0) {
    savePromises.push(optimizedBulkCreate("MsgUnstakeSupplier", data.unstakeMsgs, 'omit', assignBlockRange));
  }
  if (data.serviceConfigActivatedEvents.length > 0) {
    savePromises.push(optimizedBulkCreate("EventSupplierServiceConfigActivated", data.serviceConfigActivatedEvents, 'omit', assignBlockRange));
  }
  if (data.unbondingBeginEvents.length > 0) {
    savePromises.push(optimizedBulkCreate("EventSupplierUnbondingBegin", data.unbondingBeginEvents, 'omit', assignBlockRange));
  }
  if (data.unbondingEndEvents.length > 0) {
    savePromises.push(optimizedBulkCreate("EventSupplierUnbondingEnd", data.unbondingEndEvents, 'omit', assignBlockRange));
  }
  if (data.slashingEvents.length > 0) {
    savePromises.push(optimizedBulkCreate("EventSupplierSlashed", data.slashingEvents, 'omit', assignBlockRange));
  }

  if (savePromises.length > 0) {
    await Promise.all(savePromises);
  }
}

// Helper: Sort events and messages by transaction order
function sortEventsAndMsgs(allData: Array<CosmosEvent | CosmosMessage>): Array<CosmosEvent | CosmosMessage> {
  const allEvents: Array<CosmosEvent> = [];
  const allMsgs: Array<CosmosMessage> = [];

  for (const datum of allData) {
    if ('event' in datum) {
      allEvents.push(datum);
    } else {
      allMsgs.push(datum);
    }
  }

  const { success: successfulEvents } = filterEventsByTxStatus(allEvents);
  const { success: successfulMsgs } = filterMsgByTxStatus(allMsgs);

  const finalizedEvents: Array<CosmosEvent> = [];
  const nonFinalizedData: Array<(CosmosEvent | CosmosMessage) & { rank: 0 | 1 }> = [];

  for (const datum of [...successfulEvents, ...successfulMsgs]) {
    if ('event' in datum && isEventOfFinalizedBlockKind(datum)) {
      finalizedEvents.push(datum);
    } else {
      nonFinalizedData.push({
        ...datum,
        rank: 'event' in datum ? 1 : 0
      });
    }
  }

  return [
    ...orderBy(nonFinalizedData, ['tx.idx', 'rank', 'idx'], ['asc', 'asc', 'asc']),
    ...orderBy(finalizedEvents, ['idx'], ['asc'])
  ];
}
