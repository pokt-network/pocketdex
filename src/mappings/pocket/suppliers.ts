import { toHex } from "@cosmjs/encoding";
import {
  CosmosEvent,
  CosmosMessage,
} from "@subql/types-cosmos";
import { get, orderBy, partition } from "lodash";
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
import { updateMorseClaimableAccounts } from "./migration";
import { parseAttribute } from "../utils/json";
import {
  filterEventsByTxStatus,
  filterMsgByTxStatus,
  getDenomAndAmount,
  getTxEventMsgIndex,
  heightOrZero,
  isEventOfFinalizedBlockKind,
  isTxEventOfMessage,
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

  // A tx can carry many claims: read only the events of this message (block_results of mainnet 158648).
  for (const event of msg.tx.tx.events.filter((txEvent) => isTxEventOfMessage(txEvent.attributes, msg))) {
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

// The pre-v0.1.27 event carries the supplier's service_config_history (snake_case JSON, activation heights as
// strings: block_results of mainnet 247741): activate only the services whose config activates at this height,
// not configs that were active already (e.g. from genesis). A config a restake cancelled before it activated
// still activates, with deactivation_height equal to its activation_height: it activates nothing and is not a
// miss. Without the history (absent or empty), every config of the supplier activates, as before.
function _legacyActivatedServices(
  operator: string,
  legacySupplier: SupplierSDKType | undefined,
  activationHeight: bigint,
  record: Record<string, SupplierRecord>
): Array<SupplierServiceConfigProps> {
  const history = legacySupplier?.service_config_history?.length ? legacySupplier.service_config_history : undefined;
  const activatedIds = new Set<string>(), cancelledIds = new Set<string>();

  for (const { activation_height, deactivation_height, service } of history || []) {
    if (!service?.service_id || heightOrZero(activation_height) !== activationHeight) continue;
    const id = getStakeServiceId(operator, service.service_id);
    (heightOrZero(deactivation_height) === activationHeight ? cancelledIds : activatedIds).add(id);
  }

  if (history && activatedIds.size === 0 && cancelledIds.size === 0) {
    logger.warn(`[SupplierServiceConfigActivationMiss] no history entry of supplier ${operator} activates at height ${activationHeight}`);
  }

  for (const id of activatedIds) {
    if (!record[operator]?.services?.[id]) {
      logger.warn(`[SupplierServiceConfigActivationMiss] no open config ${id} at activation height ${activationHeight}`);
    }
  }

  return Object.values(record[operator]?.services || {})
    .filter((service) => !history || activatedIds.has(service.id));
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
  let legacySupplier: SupplierSDKType | undefined;

  for (const {key, value} of event.event.attributes) {
    if (key === "activation_height") {
      activationHeight = BigInt((value as string).replaceAll('"', ''));
    }

    if (key === "supplier") {
      legacySupplier = JSON.parse(value as unknown as string) as SupplierSDKType;
      operatorAddress = legacySupplier.operator_address;
    }

    if (key === "operator_address") {
      operatorAddress = (value as string).replaceAll('"', '');
    }

    if (key === "service_id") {
      serviceId = (value as string).replaceAll('"', '');
    }
  }

  if (activationHeight === null) {
    throw new Error(`[handleEventSupplierServiceConfigActivated] activation_height not found in event`);
  }

  if (!operatorAddress) {
    throw new Error(`[handleEventSupplierServiceConfigActivated] operatorAddress not found in event`);
  }

  let services: Array<SupplierServiceConfigProps> = []

  // Since v0.1.27 the chain emits one event per activated service, with service_id. Before that it
  // emitted one event per supplier (with the whole supplier and no service_id), activating all of them.
  if (serviceId !== undefined) {
    const service = record[operatorAddress]?.services?.[getStakeServiceId(operatorAddress, serviceId)];

    if (service) {
      services = [
        service
      ]
    } else {
      // grep-able: the chain activated a config this index does not hold. A warning, not a throw: until the
      // data patch that follows this fix runs, production still holds inconsistent rows (duplicated configs,
      // configs of unbonded suppliers left open), and failing the block here would halt the indexer. It also
      // fires on normal chain behaviour (a config dropped by a restake before its activation keeps its
      // activation, with deactivation_height = activation_height), so it is not a count of index drift.
      logger.warn(`[SupplierServiceConfigActivationMiss] no open config for service ${serviceId} of supplier ${operatorAddress} at activation height ${activationHeight}`);
    }
  } else {
    services = _legacyActivatedServices(operatorAddress, legacySupplier, activationHeight, record);
  }

  const eventId = getEventId(event);

  return {
    services: services
      .filter((service) => service.activatedAtId === undefined || service.activatedAtId === null)
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
  // Unbonding completed: the chain returned the stake to the owner and dropped
  // the supplier from its store. Keeping the last known amount here leaves the
  // row claiming to be unstaked and holding stake at the same time, which any
  // consumer summing stakeAmount without filtering on stakeStatus reads as live
  // stake.
  supplier.stakeAmount = BigInt(0);

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

// SupplierServiceConfig keeps one row per supplier and service: the latest config the supplier declared,
// with activatedAt unset until the chain activates it. The chain keeps the previous config active until the
// next session start (poktroll x/supplier/keeper/msg_server_stake_supplier.go), which this entity does not
// represent: a restake replaces the row at the stake height, pending until its own activation.
// So when a BeginBlock activation of C1 and a stake replacing C1 with C2 land in one block, C1's row closes
// with activatedAt unset and no config row references that activation event; accepted under this model.
function getServices(
  rawServices: MsgStakeSupplier['services'],
  operatorAddress: string,
  existingServicesId: Array<string>
) {
  // A stake without services (e.g. a --stake-only top-up) keeps the supplier's configs as they are,
  // as the chain does (poktroll msg_server_stake_supplier.go: `if len(msg.Services) == 0 { return nil }`).
  if (rawServices.length === 0) {
    return { servicesToRemove: [], services: [] };
  }

  // to compare with the current services and know which one to remove
  const servicesId: Array<string> = [];
  // services to save
  const services: Array<SupplierServiceConfigProps> = [];

  for (const { endpoints, revShare, serviceId } of rawServices) {
    const id = getStakeServiceId(operatorAddress, serviceId);
    servicesId.push(id);

    const endpointsArr: Array<SupplierEndpoint> = endpoints.map((endpoint) => ({
      url: endpoint.url,
      rpcType: endpoint.rpcType,
      configs: endpoint.configs,
    }));

    // Extract unique root domains (last two hostname segments) from endpoint URLs.
    const domains: string[] = [...new Set(
      endpoints
        .map((ep) => {
          try {
            const parts = new URL(ep.url).hostname.split('.');
            return parts.length >= 2 ? parts.slice(-2).join('.') : parts[0];
          } catch {
            const match = ep.url.match(/https?:\/\/([^/:]+)/);
            if (!match) return null;
            const parts = match[1].split('.');
            return parts.length >= 2 ? parts.slice(-2).join('.') : match[1];
          }
        })
        .filter((d): d is string => d !== null)
    )];

    const revShareArr: Array<SupplierRevShare> = revShare.map((revShare) => ({
      address: revShare.address,
      revSharePercentage: revShare.revSharePercentage.toString(),
    }));

    services.push({
      id,
      serviceId,
      supplierId: operatorAddress,
      endpoints: endpointsArr,
      revShare: revShareArr,
      domains,
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
    // Not emitted before v0.1.34; afterStakeAmount is derived from stake - penalty.
    supplierStakeAfterSlash: undefined as CoinSDKType | undefined,
  }
}

function _getValuesEventSupplierSlashed(event: CosmosEvent) {
  const {
    claim,
    proofMissingPenalty,
    supplierStakeAfterSlash,
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
    supplierStakeAfterSlash,
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
    supplierStakeAfterSlash,
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

  // Prefer the chain-emitted post-slash stake (supplier_stake_after_slash, v0.1.34+);
  // fall back to deriving it from the indexer-tracked stake minus the penalty for
  // pre-upgrade events (also robust when tracked stake drifts on pruned nodes).
  const afterStakeAmount = supplierStakeAfterSlash
    ? BigInt(supplierStakeAfterSlash.amount)
    : currentSupplier.stakeAmount - BigInt(proofMissingPenalty.amount);

  // When the chain emits the post-slash stake, derive the pre-slash stake from it
  // (after + penalty, both chain-sourced) so that
  // previousStakeAmount - afterStakeAmount === proofMissingPenalty holds by
  // construction and does not drift with the indexer-tracked stake. Pre-upgrade
  // events fall back to the indexer-tracked stake.
  const previousStakeAmount = supplierStakeAfterSlash
    ? afterStakeAmount + BigInt(proofMissingPenalty.amount)
    : currentSupplier.stakeAmount.valueOf();

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
      const eventSuppliers: Array<string> = typeof ids === "string" ? [ids] : ids || [];

      if ([
        "pocket.tokenomics.EventSupplierSlashed",
        "pocket.supplier.EventSupplierUnbondingBegin",
        "pocket.supplier.EventSupplierUnbondingEnd",
      ].includes(eventOrMsg.event.type)) {
        suppliers.push(...eventSuppliers);

        // the end of the unbonding, and a begin below the minimum stake, close the supplier's configs, so they
        // must be loaded (the reason is not read here: loading them for another begin writes nothing)
        if (eventOrMsg.event.type !== "pocket.tokenomics.EventSupplierSlashed") {
          suppliersToFetchServices.push(...eventSuppliers);
        }
      }

      if (eventOrMsg.event.type === "pocket.supplier.EventSupplierServiceConfigActivated") {
        suppliersToFetchServices.push(...eventSuppliers);
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
        // the unstake closes the supplier's configs, so they are loaded for it too
        suppliersToFetchServices.push(id);
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

// The operator an EventSupplierUnbondingEnd names, read by the same getter collectSupplierIds uses.
function _unbondingEndOperator(attributes: CosmosEvent["event"]["attributes"], recordId: RecordGetId): string | undefined {
  const getId = recordId["pocket.supplier.EventSupplierUnbondingEnd"] as GetIdFromEventAttribute;
  const operator = getId(attributes);
  return typeof operator === "string" ? operator : undefined;
}

// A claim whose Morse unbonding already ended (or below the minimum stake) returns before staking anything
// and emits EventSupplierUnbondingEnd for its operator in its own tx (poktroll msg_server_claim_morse_supplier.go,
// short circuits #1 and #2). An operator already staked on Shannon keeps its supplier and configs. Keyed by tx
// and operator, so two claims in one tx do not cross-apply.
function _claimStakedNothingKey(
  msg: CosmosMessage,
  record: Record<string, SupplierRecord>,
  recordId: RecordGetId
): string | undefined {
  if (msg.msg.typeUrl !== "/pocket.migration.MsgClaimMorseSupplier") return undefined;

  const operator = (msg.msg.decodedMsg as MsgClaimMorseSupplier).shannonOperatorAddress;
  const unbondingEnd = msg.tx.tx.events.find(({ attributes, type }) =>
    type === "pocket.supplier.EventSupplierUnbondingEnd" && isTxEventOfMessage(attributes, msg)
    && _unbondingEndOperator(attributes, recordId) === operator);

  return unbondingEnd !== undefined && record[operator]?.supplier !== undefined
    ? _claimKey(msg.tx.hash, unbondingEnd.attributes, operator)
    : undefined;
}

function _claimKey(txHash: string | undefined, attributes: CosmosEvent["event"]["attributes"], operator: string): string {
  return `${txHash}:${getTxEventMsgIndex(attributes) ?? operator}`;
}

// The end of an unbonding unstakes the supplier and closes its configs, except the one of such a claim. The
// chain did emit that event, so it is recorded, even though it names a supplier that stays Staked; it is
// computed on a copy of that operator's record, and no supplier is reported as changed.
function _applyUnbondingEnd(
  event: CosmosEvent,
  record: Record<string, SupplierRecord>,
  recordId: RecordGetId,
  servicesToClose: Set<string>,
  claimsThatStakedNothing: Set<string>
): { unbondingEndEvent: EventSupplierUnbondingEndProps, changedSupplierId?: string } {
  const operator = _unbondingEndOperator(event.event.attributes, recordId);

  if (operator !== undefined && claimsThatStakedNothing.has(_claimKey(event.tx?.hash, event.event.attributes, operator))) {
    const supplier = record[operator]?.supplier;
    const copy: Record<string, SupplierRecord> = { [operator]: { supplier: supplier && { ...supplier }, services: {} } };
    return { unbondingEndEvent: _handleSupplierUnbondingEndEvent(event, copy).unbondingEndEvent };
  }

  const { servicesToRemove, supplier, unbondingEndEvent } = _handleSupplierUnbondingEndEvent(event, record);

  for (const serviceId of servicesToRemove) {
    delete record[supplier.id].services?.[serviceId];
    servicesToClose.add(serviceId);
  }

  record[supplier.id].supplier = supplier;
  return { unbondingEndEvent, changedSupplierId: supplier.id };
}

// SupplierServiceConfig holds what the supplier declared. An unstake withdraws all of it: the chain schedules every
// config to deactivate at the next session start (poktroll msg_server_unstake_supplier.go), so the rows close at
// the unstake height. An unbonding for falling below the minimum stake does the same (settle_pending_claims.go). A restake during the unbonding declares services again through the stake path; a stake-only
// one declares none, as the chain keeps the deactivated history. The end of the unbonding then finds nothing open.
function _closeDeclaredServices(supplierRecord: SupplierRecord, servicesToClose: Set<string>): void {
  for (const serviceId of Object.keys(supplierRecord.services || {})) {
    delete supplierRecord.services?.[serviceId];
    servicesToClose.add(serviceId);
  }
}

// Helper: Process all events and messages
function processSupplierEventsAndMessages(
  eventsAndMessages: Array<CosmosEvent | CosmosMessage>,
  record: Record<string, SupplierRecord>,
  recordId: RecordGetId
): {
  suppliersToClose: Array<string>;
  suppliersChanged: Set<string>;
  servicesToClose: Set<string>;
  stakeMsgs: Array<MsgStakeSupplierProps>;
  claimMsgs: Array<MsgClaimMorseSupplierProps>;
  unstakeMsgs: Array<MsgUnstakeSupplierProps>;
  serviceConfigActivatedEvents: Array<EventSupplierServiceConfigActivatedProps>;
  slashingEvents: Array<EventSupplierSlashedProps>;
  unbondingBeginEvents: Array<EventSupplierUnbondingBeginProps>;
  unbondingEndEvents: Array<EventSupplierUnbondingEndProps>;
} {
  const loadedSuppliers: Array<string> = Object.keys(record).filter(id => record[id].supplier);
  // A loaded supplier no handler changed (the operator of a Morse claim that staked nothing) is neither
  // closed nor saved again: it would get an identical new row.
  const suppliersChanged = new Set<string>();
  const servicesToClose = new Set<string>();
  const claimsThatStakedNothing = new Set<string>();
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
          servicesToClose.add(service.id);
        }

        serviceConfigActivatedEvents.push(serviceConfigEvent);
      }

      if (eventOrMsg.event.type === "pocket.tokenomics.EventSupplierSlashed") {
        const { slashingEvent, supplier } = _handleEventSupplierSlashed(eventOrMsg, record);
        slashingEvents.push(slashingEvent);
        record[supplier.id].supplier = supplier;
        suppliersChanged.add(supplier.id);
      }

      if (eventOrMsg.event.type === "pocket.supplier.EventSupplierUnbondingBegin") {
        const { supplier, unbondingBeginEvent } = _handleSupplierUnbondingBeginEvent(eventOrMsg, record);
        record[supplier.id].supplier = supplier;
        suppliersChanged.add(supplier.id);
        // falling below the minimum stake withdraws the declaration as an unstake does (poktroll
        // settle_pending_claims.go); a MIGRATION begin (a claim of an unbonding Morse supplier) deactivates nothing
        if (unbondingBeginEvent.reason === SupplierUnbondingReason.BELOW_MIN_STAKE) {
          _closeDeclaredServices(record[supplier.id], servicesToClose);
        }
        unbondingBeginEvents.push(unbondingBeginEvent);
      }

      if (eventOrMsg.event.type === "pocket.supplier.EventSupplierUnbondingEnd") {
        const { changedSupplierId, unbondingEndEvent } = _applyUnbondingEnd(
          eventOrMsg, record, recordId, servicesToClose, claimsThatStakedNothing
        );
        unbondingEndEvents.push(unbondingEndEvent);
        if (changedSupplierId !== undefined) suppliersChanged.add(changedSupplierId);
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
        suppliersChanged.add(supplier.id);

        for (const serviceId of servicesToRemove) {
          delete record[supplier.id].services![serviceId];
          servicesToClose.add(serviceId);
        }

        for (const service of services) {
          record[supplier.id].services![service.id] = service;
          servicesToClose.add(service.id);
        }
      }

      const stakedNothingKey = _claimStakedNothingKey(eventOrMsg, record, recordId);

      if (stakedNothingKey !== undefined) {
        claimMsgs.push(_handleClaimSupplier(eventOrMsg, record).msgClaimSupplier);
        claimsThatStakedNothing.add(stakedNothingKey);
      } else if (eventOrMsg.msg.typeUrl === "/pocket.migration.MsgClaimMorseSupplier") {
        const { msgClaimSupplier, services, servicesToRemove, supplier } = _handleClaimSupplier(eventOrMsg, record);

        claimMsgs.push(msgClaimSupplier);

        if (!record[supplier.id]) {
          record[supplier.id] = { services: {} };
        }

        record[supplier.id].supplier = supplier;
        suppliersChanged.add(supplier.id);

        for (const serviceId of servicesToRemove) {
          delete record[supplier.id].services![serviceId];
          servicesToClose.add(serviceId);
        }

        for (const service of services) {
          record[supplier.id].services![service.id] = service;
          servicesToClose.add(service.id);
        }
      }

      if (eventOrMsg.msg.typeUrl === "/pocket.supplier.MsgUnstakeSupplier") {
        const { supplier, unstakedMsg } = _handleUnstakeSupplierMsg(eventOrMsg, record);
        record[supplier.id].supplier = supplier;
        suppliersChanged.add(supplier.id);
        _closeDeclaredServices(record[supplier.id], servicesToClose);
        unstakeMsgs.push(unstakedMsg);
      }
    }
  }

  return {
    suppliersToClose: loadedSuppliers.filter((id) => suppliersChanged.has(id)),
    suppliersChanged,
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
function buildSupplierSaveLists(
  record: Record<string, SupplierRecord>,
  suppliersChanged: Set<string>,
  servicesToClose: Set<string>
): {
  suppliersToSave: Array<SupplierProps>;
  servicesToSave: Array<SupplierServiceConfigProps>;
} {
  const suppliersToSave: Array<SupplierProps> = [];
  const servicesToSave: Array<SupplierServiceConfigProps> = [];
  // Only the configs this block closed get a new row. A config fetched for an event that then
  // left it alone (an activation event for configs that are already activated) is still open,
  // and inserting it again would leave two open rows for the same id.

  for (const { services, supplier } of Object.values(record)) {
    if (supplier && suppliersChanged.has(supplier.id)) {
      suppliersToSave.push(supplier);
    }

    if (services) {
      servicesToSave.push(...Object.values(services).filter((service) => servicesToClose.has(service.id)));
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
    suppliersChanged,
    suppliersToClose,
    unbondingBeginEvents,
    unbondingEndEvents,
    unstakeMsgs
  } = processSupplierEventsAndMessages(eventsAndMessages, record, recordId);

  const { servicesToSave, suppliersToSave } = buildSupplierSaveLists(record, suppliersChanged, servicesToClose);

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
  servicesToClose: Set<string>;
  stakeMsgs: Array<MsgStakeSupplierProps>;
  claimMsgs: Array<MsgClaimMorseSupplierProps>;
  unstakeMsgs: Array<MsgUnstakeSupplierProps>;
  serviceConfigActivatedEvents: Array<EventSupplierServiceConfigActivatedProps>;
  slashingEvents: Array<EventSupplierSlashedProps>;
  unbondingBeginEvents: Array<EventSupplierUnbondingBeginProps>;
  unbondingEndEvents: Array<EventSupplierUnbondingEndProps>;
}): Promise<void> {
  const block = store.context.getHistoricalUnit();

  const removeRecords = (model: string, ids?: Array<string>) => {
    const sequelize = getSequelize(model);
    const createdAtBlock = sequelize.where(
      sequelize.fn("lower", sequelize.col("_block_range")),
      block
    );
    return getStoreModel(model).model.destroy({
      where: ids
        ? { [Symbol.for("and")]: [createdAtBlock, { id: { [Symbol.for("in")]: ids } }] }
        : createdAtBlock,
      transaction: store.context.transaction,
    });
  };

  const SupplierModel = getStoreModel("Supplier");
  const SupplierServiceConfigModel = getStoreModel("SupplierServiceConfig");

  // Delete records created at this block
  const deletePromises: Array<Promise<unknown>> = [];

  if (data.suppliersToSave.length > 0) {
    deletePromises.push(removeRecords("Supplier", data.suppliersToSave.map((supplier) => supplier.id)));
  }
  // Every config this block closes (re-inserted or not): a row created at this height and closed at it
  // would otherwise be left with an empty range. Rows of other configs created at this height by someone
  // else (e.g. handleGenesis at the genesis height, before indexSupplier runs) are left alone.
  if (data.servicesToClose.size > 0) {
    deletePromises.push(removeRecords("SupplierServiceConfig", [...data.servicesToClose]));
  }
  if (data.stakeMsgs.length > 0) {
    // genesis writes its MsgStakeSupplier rows at the genesis height too
    deletePromises.push(removeRecords("MsgStakeSupplier", data.stakeMsgs.map((msg) => msg.id)));
  }
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

  if (data.servicesToClose.size > 0) {
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
            id: { [Symbol.for("in")]: [...data.servicesToClose] },
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

  // Update MorseClaimableAccounts to mark them as claimed
  if (data.claimMsgs.length > 0) {
    savePromises.push(updateMorseClaimableAccounts(
      data.claimMsgs.map((msg) => ({
        morseAddress: msg.morseSrcAddress,
        destinationAddress: msg.shannonOwnerAddress,
        claimedMsgId: msg.messageId,
        transactionHash: msg.transactionId,
      }))
    ));
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

  // Finalize-block events carry mode=BeginBlock|EndBlock, unquoted, in every era (block_results of
  // mainnet 247741 and 947061); PreBlock events (e.g. an upgrade) carry no mode. The chain runs PreBlock,
  // BeginBlock, the txs, then EndBlock. The BeginBlock ones (the service config activations of the supplier
  // BeginBlocker) ran before the block's txs: a stake in the same block replaces configs they already
  // activated, and must not be stamped as activated by them.
  // An unknown mode is warned (grep-able) and kept after the txs, as before this ordering existed, rather
  // than halting the indexer on an encoding difference.
  const phases = finalizedEvents.map((event) => {
    const mode = event.event.attributes.find(({ key }) => key === "mode")?.value?.toString().replaceAll('"', '');

    if (mode !== undefined && mode !== "BeginBlock" && mode !== "EndBlock") {
      logger.warn(`[SupplierEventUnknownMode] finalize_block event ${event.event.type} at block ${event.block.block.header.height} has mode=${mode}; ordered after the txs`);
    }

    return { event, beforeTxs: mode === undefined || mode === "BeginBlock" };
  });
  // finalize_block_events lists PreBlock, BeginBlock then EndBlock events, so idx keeps PreBlock first
  const [beforeTxs, afterTxs] = partition(phases, ({ beforeTxs }) => beforeTxs);
  const beforeTxsEvents = beforeTxs.map(({ event }) => event);
  const endBlockEvents = afterTxs.map(({ event }) => event);

  return [
    ...orderBy(beforeTxsEvents, ['idx'], ['asc']),
    ...orderBy(nonFinalizedData, ['tx.idx', 'rank', 'idx'], ['asc', 'asc', 'asc']),
    ...orderBy(endBlockEvents, ['idx'], ['asc'])
  ];
}
