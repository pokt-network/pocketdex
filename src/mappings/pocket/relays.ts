import { toHex } from "@cosmjs/encoding";
import {
  CosmosEvent,
  CosmosMessage,
} from "@subql/types-cosmos";
import { omit } from "lodash";
import { claimExpirationReasonFromJSON } from "../../client/pocket/tokenomics/event";
import {
  ClaimExpirationReason,
  ClaimProofStatus,
  Coin,
  EventSupplierSlashed,
  ProofRequirementReason,
  RelayStatus,
  SettlementOpReason,
  Supplier,
} from "../../types";
import { EventApplicationOverservicedProps } from "../../types/models/EventApplicationOverserviced";
import { EventApplicationReimbursementRequestProps } from "../../types/models/EventApplicationReimbursementRequest";
import { EventClaimExpiredProps } from "../../types/models/EventClaimExpired";
import { EventClaimSettledProps } from "../../types/models/EventClaimSettled";
import { EventClaimUpdatedProps } from "../../types/models/EventClaimUpdated";
import { EventProofUpdatedProps } from "../../types/models/EventProofUpdated";
import { EventProofValidityCheckedProps } from "../../types/models/EventProofValidityChecked";
import { ModToAcctTransferProps } from "../../types/models/ModToAcctTransfer";
import { MsgCreateClaimProps } from "../../types/models/MsgCreateClaim";
import { MsgSubmitProofProps } from "../../types/models/MsgSubmitProof";
import { RelayProps } from "../../types/models/Relay";
import { CoinSDKType } from "../../types/proto-interfaces/cosmos/base/v1beta1/coin";
import {
  MsgCreateClaim,
  MsgSubmitProof,
} from "../../types/proto-interfaces/pocket/proof/tx";
import {
  ClaimProofStatusSDKType,
  ClaimSDKType,
  proofRequirementReasonFromJSON,
  ProofRequirementReasonSDKType,
  ProofSDKType,
} from "../../types/proto-interfaces/pocket/proof/types";
import { ClaimExpirationReasonSDKType } from "../../types/proto-interfaces/pocket/tokenomics/event";
import {
  ClaimSettlementResultSDKType,
  settlementOpReasonFromJSON,
  SettlementOpReasonSDKType,
} from "../../types/proto-interfaces/pocket/tokenomics/types";
import { optimizedBulkCreate } from "../utils/db";
import {
  getBlockId,
  getEventId,
  getRelayId,
  messageId,
} from "../utils/ids";
import {
  parseJson,
  stringify,
} from "../utils/json";

// this can return undefined because older events do not have this attribute
function getClaimProofStatusFromSDK(item: typeof ClaimProofStatusSDKType | string | number): ClaimProofStatus | undefined {
  if (!item) return undefined;

  switch (item) {
    case 0:
    case ClaimProofStatusSDKType.PENDING_VALIDATION:
    case "PENDING_VALIDATION":
      return ClaimProofStatus.PENDING_VALIDATION;
    case 1:
    case ClaimProofStatusSDKType.VALIDATED:
    case "VALIDATED":
      return ClaimProofStatus.VALIDATED;
    case 2:
    case ClaimProofStatusSDKType.INVALID:
    case "INVALID":
      return ClaimProofStatus.INVALID;
    default:
      throw new Error(`Unknown ClaimProofStatus=${item}`);
  }
}

// eslint-disable-next-line complexity
function getSettlementOpReasonFromSDK(item: typeof SettlementOpReasonSDKType | number | string): SettlementOpReason {
  switch (item) {
    case "UNSPECIFIED":
    case SettlementOpReasonSDKType.UNSPECIFIED:
      return SettlementOpReason.UNSPECIFIED;

    case "TLM_RELAY_BURN_EQUALS_MINT_SUPPLIER_STAKE_MINT":
    case SettlementOpReasonSDKType.TLM_RELAY_BURN_EQUALS_MINT_SUPPLIER_STAKE_MINT:
      return SettlementOpReason.TLM_RELAY_BURN_EQUALS_MINT_SUPPLIER_STAKE_MINT;

    case "TLM_RELAY_BURN_EQUALS_MINT_APPLICATION_STAKE_BURN":
    case SettlementOpReasonSDKType.TLM_RELAY_BURN_EQUALS_MINT_APPLICATION_STAKE_BURN:
      return SettlementOpReason.TLM_RELAY_BURN_EQUALS_MINT_APPLICATION_STAKE_BURN;

    case "TLM_GLOBAL_MINT_INFLATION":
    case SettlementOpReasonSDKType.TLM_GLOBAL_MINT_INFLATION:
      return SettlementOpReason.TLM_GLOBAL_MINT_INFLATION;

    case "TLM_RELAY_BURN_EQUALS_MINT_SUPPLIER_SHAREHOLDER_REWARD_DISTRIBUTION":
    case SettlementOpReasonSDKType.TLM_RELAY_BURN_EQUALS_MINT_SUPPLIER_SHAREHOLDER_REWARD_DISTRIBUTION:
      return SettlementOpReason.TLM_RELAY_BURN_EQUALS_MINT_SUPPLIER_SHAREHOLDER_RD;

    case "TLM_GLOBAL_MINT_DAO_REWARD_DISTRIBUTION":
    case SettlementOpReasonSDKType.TLM_GLOBAL_MINT_DAO_REWARD_DISTRIBUTION:
      return SettlementOpReason.TLM_GLOBAL_MINT_DAO_REWARD_DISTRIBUTION;

    case "TLM_GLOBAL_MINT_PROPOSER_REWARD_DISTRIBUTION":
    case SettlementOpReasonSDKType.TLM_GLOBAL_MINT_PROPOSER_REWARD_DISTRIBUTION:
      return SettlementOpReason.TLM_GLOBAL_MINT_PROPOSER_REWARD_DISTRIBUTION;

    case "TLM_GLOBAL_MINT_SUPPLIER_SHAREHOLDER_REWARD_DISTRIBUTION":
    case SettlementOpReasonSDKType.TLM_GLOBAL_MINT_SUPPLIER_SHAREHOLDER_REWARD_DISTRIBUTION:
      return SettlementOpReason.TLM_GLOBAL_MINT_SUPPLIER_SHAREHOLDER_REWARD_DISTRIBUTION;

    case "TLM_GLOBAL_MINT_SOURCE_OWNER_REWARD_DISTRIBUTION":
    case SettlementOpReasonSDKType.TLM_GLOBAL_MINT_SOURCE_OWNER_REWARD_DISTRIBUTION:
      return SettlementOpReason.TLM_GLOBAL_MINT_SOURCE_OWNER_REWARD_DISTRIBUTION;

    case "TLM_GLOBAL_MINT_APPLICATION_REWARD_DISTRIBUTION":
    case SettlementOpReasonSDKType.TLM_GLOBAL_MINT_APPLICATION_REWARD_DISTRIBUTION:
      return SettlementOpReason.TLM_GLOBAL_MINT_APPLICATION_REWARD_DISTRIBUTION;

    case "TLM_GLOBAL_MINT_REIMBURSEMENT_REQUEST_ESCROW_DAO_TRANSFER":
    case SettlementOpReasonSDKType.TLM_GLOBAL_MINT_REIMBURSEMENT_REQUEST_ESCROW_DAO_TRANSFER:
      return SettlementOpReason.TLM_GLOBAL_MINT_REIMBURSEMENT_REQUEST_ESCROW_DAO_TRANSFER;

    case "UNSPECIFIED_TLM_SUPPLIER_SLASH_MODULE_TRANSFER":
    case SettlementOpReasonSDKType.UNSPECIFIED_TLM_SUPPLIER_SLASH_MODULE_TRANSFER:
      return SettlementOpReason.UNSPECIFIED_TLM_SUPPLIER_SLASH_MODULE_TRANSFER;

    case "UNSPECIFIED_TLM_SUPPLIER_SLASH_STAKE_BURN":
    case SettlementOpReasonSDKType.UNSPECIFIED_TLM_SUPPLIER_SLASH_STAKE_BURN:
      return SettlementOpReason.UNSPECIFIED_TLM_SUPPLIER_SLASH_STAKE_BURN;

    case "TLM_GLOBAL_MINT_SUPPLIER_SHAREHOLDER_REWARD_MODULE_TRANSFER":
    case SettlementOpReasonSDKType.TLM_GLOBAL_MINT_SUPPLIER_SHAREHOLDER_REWARD_MODULE_TRANSFER:
      return SettlementOpReason.TLM_GLOBAL_MINT_SUPPLIER_SHAREHOLDER_REWARD_MODULE_TRANSFER;

    case "TLM_GLOBAL_MINT_REIMBURSEMENT_REQUEST_ESCROW_MODULE_TRANSFER":
    case SettlementOpReasonSDKType.TLM_GLOBAL_MINT_REIMBURSEMENT_REQUEST_ESCROW_MODULE_TRANSFER:
      return SettlementOpReason.TLM_GLOBAL_MINT_REIMBURSEMENT_REQUEST_ESCROW_MODULE_TRANSFER;

    default:
      throw new Error(`Unknown SettlementOpReason=${item}`);
  }
}

function parseAttribute(attribute: unknown): string {
  return (attribute as string).replaceAll("\"", "");
}

// eslint-disable-next-line complexity
function getAttributes(attributes: CosmosEvent["event"]["attributes"]) {

  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  let proof: ProofSDKType = {},
    expirationReason: ClaimExpirationReason = ClaimExpirationReason.EXPIRATION_REASON_UNSPECIFIED,
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    claim: ClaimSDKType = {},
    proofRequirement: ProofRequirementReason = ProofRequirementReason.NOT_REQUIRED,
    numRelays = BigInt(0),
    numClaimedComputedUnits = BigInt(0),
    numEstimatedComputedUnits = BigInt(0),
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    claimed: CoinSDKType = {},
    failureReason = "",
    proofValidationStatus: ClaimProofStatus | undefined,
    settlementResult: ClaimSettlementResultSDKType | null = null,
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    proofMissingPenalty: CoinSDKType = {};

  for (const attribute of attributes) {
    if (attribute.key === "proof") {
      proof = JSON.parse(attribute.value as string);
    }

    if (attribute.key === "claim") {
      claim = JSON.parse(attribute.value as string);
    }

    if (attribute.key === "num_relays") {
      numRelays = BigInt(parseAttribute(attribute.value));
    }

    // in older versions this is the key to get the number of claimed compute units
    if (attribute.key === "num_compute_units") {
      numClaimedComputedUnits = BigInt(parseAttribute(attribute.value));
    }

    if (attribute.key === "num_claimed_compute_units") {
      numClaimedComputedUnits = BigInt(parseAttribute(attribute.value));
    }

    if (attribute.key === "num_estimated_compute_units") {
      numEstimatedComputedUnits = BigInt(parseAttribute(attribute.value));
    }

    if (attribute.key === "claimed_upokt") {
      claimed = JSON.parse(attribute.value as string);
    }

    if (attribute.key === "settlement_result") {
      settlementResult = JSON.parse(attribute.value as string);
    }

    if (attribute.key === "proof_missing_penalty") {
      proofMissingPenalty = JSON.parse(attribute.value as string);
    }

    if (attribute.key === "failure_reason") {
      failureReason = attribute.value as string;
    }

    if (attribute.key === "proof_status") {
      proofValidationStatus = getClaimProofStatusFromSDK(parseAttribute(attribute.value as string));
    }

    if (attribute.key === "proof_requirement") {
      switch (proofRequirementReasonFromJSON(parseAttribute(attribute.value))) {
        case ProofRequirementReasonSDKType.THRESHOLD:
          proofRequirement = ProofRequirementReason.THRESHOLD;
          break;
        case ProofRequirementReasonSDKType.NOT_REQUIRED:
          proofRequirement = ProofRequirementReason.NOT_REQUIRED;
          break;
        case ProofRequirementReasonSDKType.PROBABILISTIC:
          proofRequirement = ProofRequirementReason.PROBABILISTIC;
          break;
        default: {
          throw new Error(`Unknown ProofRequirementReason: ${attribute.value}`);
        }
      }
    }

    if (attribute.key === "expiration_reason") {
      switch (claimExpirationReasonFromJSON(parseAttribute(attribute.value))) {
        case ClaimExpirationReasonSDKType.EXPIRATION_REASON_UNSPECIFIED:
          expirationReason = ClaimExpirationReason.EXPIRATION_REASON_UNSPECIFIED;
          break;
        case ClaimExpirationReasonSDKType.PROOF_INVALID:
          expirationReason = ClaimExpirationReason.PROOF_INVALID;
          break;
        case ClaimExpirationReasonSDKType.PROOF_MISSING:
          expirationReason = ClaimExpirationReason.PROOF_MISSING;
          break;
        default: {
          throw new Error(`Unknown ClaimExpirationReason: ${attribute.value}`);
        }
      }
    }
  }

  return {
    claim,
    proof,
    numRelays,
    numClaimedComputedUnits,
    numEstimatedComputedUnits,
    claimed,
    proofRequirement,
    expirationReason,
    proofMissingPenalty,
    failureReason,
    proofValidationStatus,
    settlementResult,
  };
}

function _handleMsgCreateClaim(msg: CosmosMessage<MsgCreateClaim>): [MsgCreateClaimProps, RelayProps] {
  const { rootHash, sessionHeader, supplierOperatorAddress } = msg.msg.decodedMsg;
  const applicationId = sessionHeader?.applicationAddress || "";
  const serviceId = sessionHeader?.serviceId || "";
  const sessionId = sessionHeader?.sessionId || "";

  const id = getRelayId({
    applicationId,
    supplierId: supplierOperatorAddress,
    serviceId,
    sessionId,
  });

  const shared = {
    supplierId: supplierOperatorAddress,
    applicationId,
    serviceId,
    sessionId,
    sessionStartHeight: BigInt(sessionHeader?.sessionStartBlockHeight?.toString() || 0),
    sessionEndHeight: BigInt(sessionHeader?.sessionEndBlockHeight?.toString() || 0),
    // todo: convert uint8array that come as uint8map to hex string
    rootHash: toHex(rootHash),
  };

  return [
    {
      id: messageId(msg),
      ...shared,
      transactionId: msg.tx.hash,
      blockId: getBlockId(msg.block),
    },
    {
      id,
      ...shared,
      status: RelayStatus.Pending,
      msgCreateClaimId: messageId(msg),
    },
  ];
}

function _handleMsgSubmitProof(msg: CosmosMessage<MsgSubmitProof>): [MsgSubmitProofProps, RelayProps] {
  const { /*proof,*/ sessionHeader, supplierOperatorAddress } = msg.msg.decodedMsg;

  const applicationId = sessionHeader?.applicationAddress || "";
  const serviceId = sessionHeader?.serviceId || "";
  const sessionId = sessionHeader?.sessionId || "";
  const msgId = messageId(msg);

  const shared = {
    applicationId,
    supplierId: supplierOperatorAddress,
    sessionId,
    serviceId,
    sessionEndHeight: BigInt(sessionHeader?.sessionEndBlockHeight?.toString() || 0),
    sessionStartHeight: BigInt(sessionHeader?.sessionStartBlockHeight?.toString() || 0),
  };

  return [
    {
      id: msgId,
      ...shared,
      // proof: stringify(proof),
      // some proof payloads are way bigger than what jsonb allows on a database.
      proof: "",
      transactionId: msg.tx.hash,
      blockId: getBlockId(msg.block),
    },
    {
      ...shared,
      id: getRelayId({
        applicationId,
        supplierId: supplierOperatorAddress,
        serviceId,
        sessionId,
      }),
      status: RelayStatus.Pending,
      msgSubmitProofId: msgId,
    },
  ];
}

function _handleEventClaimSettled(event: CosmosEvent): [EventClaimSettledProps, RelayProps, Array<ModToAcctTransferProps>] {
  const {
    claim,
    claimed,
    numClaimedComputedUnits,
    numEstimatedComputedUnits,
    numRelays,
    proofRequirement,
    settlementResult,
  } = getAttributes(event.event.attributes);

  const { proof_validation_status, root_hash, session_header, supplier_operator_address } = claim;

  const shared = {
    supplierId: supplier_operator_address,
    applicationId: session_header?.application_address || "",
    serviceId: session_header?.service_id || "",
    sessionId: session_header?.session_id || "",
    sessionStartHeight: BigInt(session_header?.session_start_block_height?.toString() || 0),
    sessionEndHeight: BigInt(session_header?.session_end_block_height?.toString() || 0),
    rootHash: "", //stringify(root_hash),
    numRelays,
    numClaimedComputedUnits,
    numEstimatedComputedUnits,
    claimedDenom: claimed?.denom || "",
    claimedAmount: BigInt(claimed?.amount || "0"),
    proofValidationStatus: getClaimProofStatusFromSDK(proof_validation_status),
  } as const;

  const eventId = getEventId(event);
  const blockId = getBlockId(event.block);
  const relayId = getRelayId({
    applicationId: session_header?.application_address || "",
    supplierId: supplier_operator_address,
    serviceId: session_header?.service_id || "",
    sessionId: session_header?.session_id || "",
  });

  return [
    {
      ...shared,
      transactionId: event.tx?.hash,
      blockId: blockId,
      id: eventId,
      proofRequirement,
      mints: settlementResult?.mints?.map(mint => ({
        opReason: settlementOpReasonFromJSON(mint.op_reason),
        destinationModule: mint.DestinationModule,
        amount: BigInt(mint.coin.amount),
        denom: mint.coin.denom,
      })) || [],
      burns: settlementResult?.burns?.map(burn => ({
        opReason: settlementOpReasonFromJSON(burn.op_reason),
        destinationModule: burn.DestinationModule,
        amount: BigInt(burn.coin.amount),
        denom: burn.coin.denom,
      })) || [],
      modToModTransfers: settlementResult?.mod_to_mod_transfers?.map((item) => ({
        opReason: settlementOpReasonFromJSON(item.op_reason),
        senderModule: item.SenderModule,
        recipientModule: item.RecipientModule,
        amount: BigInt(item.coin.amount),
        denom: item.coin.denom,
      })) || [],
    },
    {
      ...shared,
      id: relayId,
      status: RelayStatus.Success,
      eventClaimSettledId: getEventId(event),
    },
    settlementResult?.mod_to_acct_transfers?.map((item, index) => ({
      id: `${eventId}-${index}`,
      relayId,
      blockId,
      eventClaimSettledId: eventId,
      senderModule: item.SenderModule,
      recipientId: item.RecipientAddress,
      amount: BigInt(item.coin.amount),
      denom: item.coin.denom,
      opReason: getSettlementOpReasonFromSDK(item.op_reason),
    })) || [],
  ];
}

function _handleEventClaimExpired(event: CosmosEvent): [EventClaimExpiredProps, RelayProps] {
  const {
    claim,
    claimed,
    expirationReason,
    numClaimedComputedUnits,
    numEstimatedComputedUnits,
    numRelays,
  } = getAttributes(event.event.attributes);

  const { proof_validation_status, root_hash, session_header, supplier_operator_address } = claim;

  const shared = {
    supplierId: supplier_operator_address,
    applicationId: session_header?.application_address || "",
    serviceId: session_header?.service_id || "",
    sessionId: session_header?.session_id || "",
    sessionStartHeight: BigInt(session_header?.session_start_block_height?.toString() || 0),
    sessionEndHeight: BigInt(session_header?.session_end_block_height?.toString() || 0),
    rootHash: "", //stringify(root_hash),
    numRelays,
    numClaimedComputedUnits,
    numEstimatedComputedUnits,
    claimedDenom: claimed?.denom || "",
    claimedAmount: BigInt(claimed?.amount || "0"),
    proofValidationStatus: getClaimProofStatusFromSDK(proof_validation_status),
  } as const;

  return [
    {
      ...shared,
      id: getEventId(event),
      expirationReason,
      transactionId: event.tx?.hash,
      blockId: getBlockId(event.block),
    },
    {
      ...shared,
      id: getRelayId({
        applicationId: session_header?.application_address || "",
        supplierId: supplier_operator_address,
        serviceId: session_header?.service_id || "",
        sessionId: session_header?.session_id || "",
      }),
      eventClaimExpiredId: getEventId(event),
      status: RelayStatus.Fail,
    },
  ];
}

function _handleEventClaimUpdated(event: CosmosEvent): [EventClaimUpdatedProps, RelayProps] {
  const {
    claim,
    claimed,
    numClaimedComputedUnits,
    numEstimatedComputedUnits,
    numRelays,
  } = getAttributes(event.event.attributes);

  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  const { proof_validation_status, root_hash, session_header, supplier_operator_address } = claim;

  const relayId = getRelayId({
    applicationId: session_header?.application_address || "",
    supplierId: supplier_operator_address,
    serviceId: session_header?.service_id || "",
    sessionId: session_header?.session_id || "",
  });

  const shared = {
    supplierId: supplier_operator_address,
    applicationId: session_header?.application_address || "",
    serviceId: session_header?.service_id || "",
    sessionId: session_header?.session_id || "",
    sessionStartHeight: BigInt(session_header?.session_start_block_height?.toString() || 0),
    sessionEndHeight: BigInt(session_header?.session_end_block_height?.toString() || 0),
    rootHash: "", //stringify(root_hash),
    numRelays,
    numClaimedComputedUnits,
    numEstimatedComputedUnits,
    claimedDenom: claimed?.denom || "",
    claimedAmount: BigInt(claimed?.amount || "0"),
    ...(proof_validation_status && {
      proofValidationStatus: getClaimProofStatusFromSDK(proof_validation_status),
    }),
  } as const;

  return [
    {
      ...shared,
      id: getEventId(event),
      relayId,
      transactionId: event.tx?.hash,
      blockId: getBlockId(event.block),
    },
    {
      ...shared,
      id: relayId,
      status: RelayStatus.Pending,
    },
  ];
}

function _handleEventProofUpdated(event: CosmosEvent): [EventProofUpdatedProps, RelayProps] {
  const {
    claim,
    claimed,
    numClaimedComputedUnits,
    numEstimatedComputedUnits,
    numRelays,
    proof,
  } = getAttributes(event.event.attributes);

  const { proof_validation_status, root_hash, session_header, supplier_operator_address } = claim;

  const shared = {
    supplierId: supplier_operator_address,
    applicationId: session_header?.application_address || "",
    serviceId: session_header?.service_id || "",
    sessionId: session_header?.session_id || "",
    sessionStartHeight: BigInt(session_header?.session_start_block_height?.toString() || 0),
    sessionEndHeight: BigInt(session_header?.session_end_block_height?.toString() || 0),
    rootHash: "", //stringify(root_hash),
    numRelays,
    numClaimedComputedUnits,
    numEstimatedComputedUnits,
    claimedDenom: claimed?.denom || "",
    claimedAmount: BigInt(claimed?.amount || "0"),
    ...(proof_validation_status && {
      proofValidationStatus: getClaimProofStatusFromSDK(proof_validation_status),
    }),
  } as const;


  const id = getRelayId({
    applicationId: session_header?.application_address || "",
    supplierId: supplier_operator_address,
    serviceId: session_header?.service_id || "",
    sessionId: session_header?.session_id || "",
  });

  return [
    {
      id: getEventId(event),
      ...shared,
      closestMerkleProof: proof ? stringify(proof.closest_merkle_proof) : undefined,
      relayId: id,
      transactionId: event.tx?.hash,
      blockId: getBlockId(event.block),
    },
    {
      ...shared,
      id,
      status: RelayStatus.Pending,
    },
  ];
}

function _handleEventApplicationOverserviced(event: CosmosEvent): EventApplicationOverservicedProps {
  let expectedBurn: Coin | null = null, effectiveBurn: Coin | null = null, applicationAddress = "",
    supplierAddress = "";

  for (const attribute of event.event.attributes) {
    if (attribute.key === "application_addr") {
      applicationAddress = parseAttribute(attribute.value);
    }

    if (attribute.key === "supplier_operator_addr") {
      supplierAddress = parseAttribute(attribute.value as string);
    }

    if (attribute.key === "expected_burn") {
      expectedBurn = parseJson(attribute.value as string);
    }

    if (attribute.key === "effective_burn") {
      effectiveBurn = parseJson(attribute.value as string);
    }
  }

  if (!applicationAddress) {
    throw new Error(`[handleEventApplicationOverserviced] applicationAddress not found in event`);
  }

  if (!supplierAddress) {
    throw new Error(`[handleEventApplicationOverserviced] supplierAddress not found in event`);
  }

  if (!expectedBurn) {
    throw new Error(`[handleEventApplicationOverserviced] expectedBurn not found in event`);
  }

  if (!effectiveBurn) {
    throw new Error(`[handleEventApplicationOverserviced] effectiveBurn not found in event`);
  }

  return {
    id: getEventId(event),
    applicationId: applicationAddress,
    supplierId: supplierAddress,
    expectedBurn: BigInt(expectedBurn.amount),
    expectedBurnDenom: expectedBurn.denom,
    effectiveBurn: BigInt(effectiveBurn.amount),
    effectiveBurnDenom: effectiveBurn.denom,
    blockId: getBlockId(event.block),
    eventId: getEventId(event),
  };
}

function _handleEventApplicationReimbursementRequest(event: CosmosEvent): EventApplicationReimbursementRequestProps {
  let applicationAddress = "", supplierAddress = "", serviceId = "", sessionId = "", coin: CoinSDKType | null = null;

  for (const { key, value } of event.event.attributes) {
    if (key === "amount") {
      coin = parseJson(value as string);
      continue;
    }

    const parsedValue = parseAttribute(value);

    if (key === "application_addr") {
      applicationAddress = parsedValue;
    }

    if (key === "supplier_operator_addr") {
      supplierAddress = parsedValue;
    }

    if (key === "service_id") {
      serviceId = parsedValue;
    }

    if (key === "session_id") {
      sessionId = parsedValue;
    }
  }

  if (!coin) {
    throw new Error(`[handleEventApplicationReimbursementRequest] coin not found in event`);
  }

  return {
    id: getEventId(event),
    applicationId: applicationAddress,
    supplierId: supplierAddress,
    serviceId,
    sessionId,
    amount: BigInt(coin.amount),
    denom: coin.denom,
    blockId: getBlockId(event.block),
    eventId: getEventId(event),
  };
}

async function _handleOldEventSupplierSlashed(event: CosmosEvent) {
  let slashingCoin: CoinSDKType | null = null, operatorAddress = "";

  for (const attribute of event.event.attributes) {
    if (attribute.key === "slashing_amount") {
      slashingCoin = JSON.parse(attribute.value as string);
    }

    if (attribute.key === "supplier_operator_addr") {
      operatorAddress = parseAttribute(attribute.value);
    }
  }

  if (!slashingCoin) {
    throw new Error(`[handleEventSupplierSlashed] slashingCoin not found in event`);
  }

  if (!operatorAddress) {
    throw new Error(`[handleEventSupplierSlashed] operatorAddress not found in event`);
  }

  const supplier = await Supplier.get(operatorAddress);

  if (!supplier) {
    throw new Error(`[handleEventSupplierSlashed] supplier not found for operator address ${operatorAddress}`);
  }

  supplier.stakeAmount -= BigInt(slashingCoin.amount);

  await Promise.all([
    supplier.save(),
    EventSupplierSlashed.create({
      id: getEventId(event),
      supplierId: operatorAddress,
      blockId: getBlockId(event.block),
      eventId: getEventId(event),
      proofMissingPenalty: BigInt(slashingCoin.amount),
      proofMissingPenaltyDenom: slashingCoin.denom,
      previousStakeAmount: supplier.stakeAmount,
      afterStakeAmount: supplier.stakeAmount,
      // in alpha this event does not have the values below, so we are setting them to empty values for now
      applicationId: "",
      serviceId: "",
      sessionId: "",
      sessionStartHeight: BigInt(0),
      sessionEndHeight: BigInt(0),
    }).save(),
  ]);
}

async function _handleEventSupplierSlashed(event: CosmosEvent) {
  const {
    claim,
    proofMissingPenalty,
  } = getAttributes(event.event.attributes);

  if (!claim) {
    logger.warn(`[handleEventSupplierSlashed] claim not found in event, trying to handle with previous version`);
    await _handleOldEventSupplierSlashed(event);
    return;
  }

  if (!claim.session_header) {
    logger.warn(`[handleEventSupplierSlashed] session_header not found in event, trying to handle with previous version`);
    await _handleOldEventSupplierSlashed(event);
    return;
  }

  const supplier = await Supplier.get(claim.supplier_operator_address);

  if (!supplier) {
    throw new Error(`[handleEventSupplierSlashed] supplier not found for address: ${claim.supplier_operator_address}`);
  }

  const previousStakeAmount = supplier.stakeAmount.valueOf();
  supplier.stakeAmount -= BigInt(proofMissingPenalty.amount);

  await Promise.all([
    supplier.save(),
    EventSupplierSlashed.create({
      id: getEventId(event),
      supplierId: claim.supplier_operator_address,
      // TODO: Create entity for session header
      applicationId: claim.session_header.application_address,
      serviceId: claim.session_header.service_id,
      sessionId: claim.session_header.session_id,
      sessionEndHeight: claim.session_header.session_end_block_height,
      sessionStartHeight: claim.session_header.session_start_block_height,
      blockId: getBlockId(event.block),
      eventId: getEventId(event),
      proofMissingPenalty: BigInt(proofMissingPenalty.amount),
      proofMissingPenaltyDenom: proofMissingPenalty.denom,
      previousStakeAmount,
      afterStakeAmount: supplier.stakeAmount,
      proofValidationStatus: getClaimProofStatusFromSDK(claim.proof_validation_status),
    }).save(),
  ]);
}

// TODO: research this because was wrongly code in relation to the event entity
//  https://github.com/pokt-network/poktroll/blob/feb68848d0fe969f1997b87520170741711cf4d4/proto/pocket/proof/event.proto
// CHANGE HERE: https://github.com/pokt-network/poktroll/commit/feb68848d0fe969f1997b87520170741711cf4d4#diff-6348a0a7ee0a1fdb26be2ea8d8bbc295adaef0d8f49d870cc7b281f9b822b029L38-L50
/*
2025-06-19T23:19:46.428Z <sandbox> ERROR [handleEventProofValidityChecked] session_header not found in event: [{"key":"block_height","value":"\"139799\""},{"key":"claim","value":"{\"supplier_operator_address\":\"pokt1y4gu4aevj2x4g06x0uup5f6wh70wvc4a2c3q00\",\"session_header\":{\"application_address\":\"pokt1pf3wvd7v5g5qk56j37uqqsq8t8vnhms5zghpfm\",\"service_id\":\"bsc\",\"session_id\":\"cbf85a4a4a3a7fe3ddd8f77fc316752db97320de1b3d22fd75e0092b580f1fae\",\"session_start_block_height\":\"139781\",\"session_end_block_height\":\"139790\"},\"root_hash\":\"/YSrkcbr14WsSb/uPjGDQc6Grl5crURTr71lguQt2lUAAAAAAAXk+AAAAAAAAAG0\",\"proof_validation_status\":\"VALIDATED\"}"},{"key":"failure_reason","value":"\"\""},{"key":"mode","value":"EndBlock"}]
2025-06-19T23:19:46.428Z <sandbox> ERROR [handleEventProofValidityChecked] session_header not found in event: [{"key":"block_height","value":"\"139799\""},{"key":"claim","value":"{\"supplier_operator_address\":\"pokt1hyp7vstqndzzn8snlfv553e8uaand6097eq4yu\",\"session_header\":{\"application_address\":\"pokt1hufj6cdgu83dluput6klhmh54vtrgtl3drttva\",\"service_id\":\"poly\",\"session_id\":\"0948127d639ada32098404d478a2aad663ce42f5c34bd81d241dae893229fad0\",\"session_start_block_height\":\"139781\",\"session_end_block_height\":\"139790\"},\"root_hash\":\"pMXV5Oe4ApIjH5BUnkC8uakU6AG1+3DldxNqsxXMf6AAAAAAAAvOTgAAAAAAAAHq\",\"proof_validation_status\":\"VALIDATED\"}"},{"key":"failure_reason","value":"\"\""},{"key":"mode","value":"EndBlock"}]
2025-06-19T23:19:46.428Z <sandbox> ERROR [handleEventProofValidityChecked] session_header not found in event: [{"key":"block_height","value":"\"139799\""},{"key":"claim","value":"{\"supplier_operator_address\":\"pokt15ve3yszw3jvnczud7eld3uvktd3xe39tstrux6\",\"session_header\":{\"application_address\":\"pokt1hufj6cdgu83dluput6klhmh54vtrgtl3drttva\",\"service_id\":\"poly\",\"session_id\":\"0948127d639ada32098404d478a2aad663ce42f5c34bd81d241dae893229fad0\",\"session_start_block_height\":\"139781\",\"session_end_block_height\":\"139790\"},\"root_hash\":\"Mof2xnkaUKpH5i1bkz2jKzoHQl8hmt8SwHiW18YMYB4AAAAAAAqmPgAAAAAAAAG6\",\"proof_validation_status\":\"VALIDATED\"}"},{"key":"failure_reason","value":"\"\""},{"key":"mode","value":"EndBlock"}]
2025-06-19T23:19:46.429Z <sandbox> ERROR [handleEventProofValidityChecked] session_header not found in event: [{"key":"block_height","value":"\"139799\""},{"key":"claim","value":"{\"supplier_operator_address\":\"pokt1mh4lue0ypers4lvw3wp0lxhlgxugt5yreafgcz\",\"session_header\":{\"application_address\":\"pokt1hufj6cdgu83dluput6klhmh54vtrgtl3drttva\",\"service_id\":\"poly\",\"session_id\":\"0948127d639ada32098404d478a2aad663ce42f5c34bd81d241dae893229fad0\",\"session_start_block_height\":\"139781\",\"session_end_block_height\":\"139790\"},\"root_hash\":\"d9pwEzom0s1v0/h9dg7v7cjQz484R0wMalMLsRSCpaYAAAAAAA1ZDgAAAAAAAAIq\",\"proof_validation_status\":\"VALIDATED\"}"},{"key":"failure_reason","value":"\"\""},{"key":"mode","value":"EndBlock"}]
2025-06-19T23:19:46.429Z <sandbox> ERROR [handleEventProofValidityChecked] session_header not found in event: [{"key":"block_height","value":"\"139799\""},{"key":"claim","value":"{\"supplier_operator_address\":\"pokt16kux02e9eh3tpvl3xsf06tcvkmzvjt0we6m40s\",\"session_header\":{\"application_address\":\"pokt1hufj6cdgu83dluput6klhmh54vtrgtl3drttva\",\"service_id\":\"poly\",\"session_id\":\"0948127d639ada32098404d478a2aad663ce42f5c34bd81d241dae893229fad0\",\"session_start_block_height\":\"139781\",\"session_end_block_height\":\"139790\"},\"root_hash\":\"zUPG6hw93XmF5Euwuo6kPT3vAdT44cUKT+zwkzMkYpsAAAAAAA7dowAAAAAAAAJp\",\"proof_validation_status\":\"VALIDATED\"}"},{"key":"failure_reason","value":"\"\""},{"key":"mode","value":"EndBlock"}]
 */
function _handleEventProofValidityChecked(event: CosmosEvent): [EventProofValidityCheckedProps, Partial<RelayProps>] {
  const { claim, failureReason, proof, proofValidationStatus } = getAttributes(event.event.attributes);

  if (proof) {
    // Beta https://shannon-testnet-grove-rpc.beta.poktroll.com/block_results?height=69007
    // {"type":"pocket.proof.EventProofValidityChecked","attributes":[{"key":"block_height","value":"\"69007\"","index":true},{"key":"failure_reason","value":"\"\"","index":true},{"key":"proof","value":"{\"supplier_operator_address\":\"pokt1hgldzstydutfc7qjwe6wqz3h6qc6fgfasaadrf\",\"session_header\":{\"application_address\":\"pokt1vey0k90uc62msvs0hlnc6ml4v9jdlnu7cuz8ur\",\"service_id\":\"ink\",\"session_id\":\"103ab2c9d75b7b58acb5bef65fde81af94dfb54d1044f86d245721c2f6c0a894\",\"session_start_block_height\":\"68991\",\"session_end_block_height\":\"69000\"},\"closest_merkle_proof\":\"/4d/AwEBH1NwYXJzZUNvbXBhY3RNZXJrbGVDbG9zZXN0UHJvb2YB/4AAAQYBBFBhdGgBCgABC0ZsaXBwZWRCaXRzAf+CAAEFRGVwdGgBCgABC0Nsb3Nlc3RQYXRoAQoAARBDbG9zZXN0VmFsdWVIYXNoAQoAAQxDbG9zZXN0UHJvb2YB/4QAAAAX/4ECAQEJW11bXXVpbnQ4Af+CAAEKAAB8/4MDAQEYU3BhcnNlQ29tcGFjdE1lcmtsZVByb29mAf+EAAEFAQlTaWRlTm9kZXMB/4IAARVOb25NZW1iZXJzaGlwTGVhZkRhdGEBCgABB0JpdE1hc2sBCgABDE51bVNpZGVOb2RlcwEEAAELU2libGluZ0RhdGEBCgAAAP4FYP+AASAHWYXJ+5AvOJBiazqy16A/BVakgxGKQfaD2t5rWGbKzAIBBAEgAgHHN+2AHmKFKwuNM8y23/HoO3wN4/qgc9DjcqdgxHYB/gPSCo0ECvUCCnwKK3Bva3QxdmV5MGs5MHVjNjJtc3ZzMGhsbmM2bWw0djlqZGxudTdjdXo4dXISA2luaxpAMTAzYWIyYzlkNzViN2I1OGFjYjViZWY2NWZkZTgxYWY5NGRmYjU0ZDEwNDRmODZkMjQ1NzIxYzJmNmMwYTg5NCD/mgQoiJsEEscBAAAAAuVoCWCYBYBRE9uuSCyeJvllw/kk0lHeUfEIg5Cfz/6SAzB03nRoFOB6IOxOKJYh4IN3YEO/VYUSKsz1Rn7raQ7Wy4Jk03MDffHXNUjDZnqf9MYEn7IoJpav8Q62XCozxacDGU2uy3q+R8uHS15lpdYFOw2hEOUHw4lgMBN4b0aM0Dw1JUAAmQYRhP7P66ZoQeWFHT65tLI2DiYV5YnEjDCAEQI8EFgtdmB5ZVDOCUEgPW8ciF7ADsTmgzi/7DOwU1IsFxorcG9rdDFoZ2xkenN0eWR1dGZjN3Fqd2U2d3F6M2g2cWM2ZmdmYXNhYWRyZhKSAQoEUE9TVBIwCgxDb250ZW50LVR5cGUSIAoMQ29udGVudC1UeXBlEhBhcHBsaWNhdGlvbi9qc29uGiBodHRwczovL3JtMDAwMWJldGEua2Fsb3JpdXMudGVjaCI2eyJqc29ucnBjIjoiMi4wIiwibWV0aG9kIjoiZXRoX2Jsb2NrTnVtYmVyIiwiaWQiOjEwMDJ9Eq8DCsABCnwKK3Bva3QxdmV5MGs5MHVjNjJtc3ZzMGhsbmM2bWw0djlqZGxudTdjdXo4dXISA2luaxpAMTAzYWIyYzlkNzViN2I1OGFjYjViZWY2NWZkZTgxYWY5NGRmYjU0ZDEwNDRmODZkMjQ1NzIxYzJmNmMwYTg5NCD/mgQoiJsEEkAuF55hkHYmvCAeWorQHMZGWNOe+/5ukJOF/xy/s2CXZWgf7xDsQnefnCO6BnbddXxmCDYUk82fXUeRcKysZO/uEukBCMgBEiYKDkNvbnRlbnQtTGVuZ3RoEhQKDkNvbnRlbnQtTGVuZ3RoEgI0OBIwCgxDb250ZW50LVR5cGUSIAoMQ29udGVudC1UeXBlEhBhcHBsaWNhdGlvbi9qc29uEi0KBERhdGUSJQoERGF0ZRIdTW9uLCAxNiBKdW4gMjAyNSAxNjoyMTowMSBHTVQSKQoGU2VydmVyEh8KBlNlcnZlchIVTWljcm9zb2Z0LU5ldENvcmUvMi4wGjB7Impzb25ycGMiOiIyLjAiLCJpZCI6MTAwMiwicmVzdWx0IjoiMHhmZDJlNDEifQoAAAAAAAAEXgAAAAAAAAABAQEEMDjD8hPN/RkhBfg/cSpHPRZCsJeJNel/NXSiAUtFU9WDAAAAAAAACLwAAAAAAAAAAjAbVpUgnmzmD32Zlmd2t9pt+pE5nRjqAAe7iL3uuCFpOQAAAAAAAAReAAAAAAAAAAEwgmgC3lhSJrInz5gLLfcE+oQCV9NsaBZ7sk5dHEB/LRkAAAAAAAAaNAAAAAAAAAAGMDkxD6/8mOEcZVRDjPyjP8H9rf6cN6Unon/i/AfzHas7AAAAAAAAEXgAAAAAAAAABAIBAAEIAXEBeTPzYmmhAagtG8mJLOyAfYNOjZKrufQm3+n1pAr3Vv8AAAAAAAAEXgAAAAAAAAABo8ms5nlJBQMQp2R3fIfe2dMuyzQKxRM6lIP1YOfUYb8AAAAAAAAEXgAAAAAAAAABAAAAAAAACLwAAAAAAAAAAgAA\"}","index":true},{"key":"proof_status","value":"\"VALIDATED\"","index":true},{"key":"mode","value":"EndBlock","index":true}]}
    if (!proof.session_header) {
      logger.error(`[handleEventProofValidityChecked] session_header not found in event: ${stringify(event.event.attributes)}`);
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore
      return [];
      // throw new Error(`[handleEventProofValidityChecked] session_header not found in event`);
    }

    if (!proofValidationStatus) {
      logger.error(`[handleEventProofValidityChecked] proofValidationStatus not found in event: ${stringify(event.event.attributes)}`);
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore
      return [];
      // throw new Error(`[handleEventProofValidityChecked] proofValidationStatus not found in event`);
    }

    if (!failureReason) {
      logger.error(`[handleEventProofValidityChecked] failureReason not found in event: ${stringify(event.event.attributes)}`);
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore
      return [];
      // throw new Error(`[handleEventProofValidityChecked] failureReason not found in event`);
    }

    return [
      {
        id: getEventId(event),
        blockId: getBlockId(event.block),
        supplierId: proof.supplier_operator_address,
        applicationId: proof.session_header.application_address,
        serviceId: proof.session_header.service_id,
        sessionId: proof.session_header.session_id,
        sessionStartHeight: BigInt(proof.session_header.session_start_block_height.toString()),
        sessionEndHeight: BigInt(proof.session_header.session_end_block_height.toString()),
        proofValidationStatus: proofValidationStatus,
        failureReason: failureReason,
        eventId: getEventId(event),
      },
      {
        id: getRelayId({
          applicationId: proof.session_header.application_address,
          supplierId: proof.supplier_operator_address,
          serviceId: proof.session_header.service_id,
          sessionId: proof.session_header.session_id,
        }),
        proofValidationStatus: proofValidationStatus,
      },
    ];
  } else if (claim) {
    // Mainnet https://shannon-grove-rpc.mainnet.poktroll.com/block_results?height=138947
    // {"type":"pocket.proof.EventProofValidityChecked","attributes":[{"key":"block_height","value":"\"138947\"","index":true},{"key":"claim","value":"{\"supplier_operator_address\":\"pokt14aw9dp74x3rucl4lraesjw04f6ec28dw60q0u7\",\"session_header\":{\"application_address\":\"pokt19xeme2s0756y7j5gpwa2sy5wg7pw6n5wjxegxa\",\"service_id\":\"op\",\"session_id\":\"f6751b0defdf87a127ecb09b0d84e09222aec9af3e73554b733d523068d4efa4\",\"session_start_block_height\":\"138931\",\"session_end_block_height\":\"138940\"},\"root_hash\":\"7TZnv2qEk1NYLw6QiSVu0Jnc6TESw6KvmjYyIryQE/oAAAAAAAmg0AAAAAAAAAFd\",\"proof_validation_status\":\"VALIDATED\"}","index":true},{"key":"failure_reason","value":"\"\"","index":true},{"key":"mode","value":"EndBlock","index":true}]}
    /*const x = {
      "supplier_operator_address": "pokt14aw9dp74x3rucl4lraesjw04f6ec28dw60q0u7",
      "session_header": {
        "application_address": "pokt19xeme2s0756y7j5gpwa2sy5wg7pw6n5wjxegxa",
        "service_id": "op",
        "session_id": "f6751b0defdf87a127ecb09b0d84e09222aec9af3e73554b733d523068d4efa4",
        "session_start_block_height": "138931",
        "session_end_block_height": "138940",
      },
      "root_hash": "7TZnv2qEk1NYLw6QiSVu0Jnc6TESw6KvmjYyIryQE/oAAAAAAAmg0AAAAAAAAAFd",
      "proof_validation_status": "VALIDATED",
    };*/
    if (!claim.session_header) {
      logger.error(`[handleEventProofValidityChecked] session_header not found in event: ${stringify(event.event.attributes)}`);
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore
      return [];
      // throw new Error(`[handleEventProofValidityChecked] session_header not found in event`);
    }

    if (!claim.proof_validation_status) {
      logger.error(`[handleEventProofValidityChecked] proofValidationStatus not found in event: ${stringify(event.event.attributes)}`);
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore
      return [];
      // throw new Error(`[handleEventProofValidityChecked] proofValidationStatus not found in event`);
    }

    if (!failureReason) {
      logger.error(`[handleEventProofValidityChecked] failureReason not found in event: ${stringify(event.event.attributes)}`);
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore
      return [];
      // throw new Error(`[handleEventProofValidityChecked] failureReason not found in event`);
    }

    return [
      {
        id: getEventId(event),
        blockId: getBlockId(event.block),
        supplierId: claim.supplier_operator_address,
        applicationId: claim.session_header.application_address,
        serviceId: claim.session_header.service_id,
        sessionId: claim.session_header.session_id,
        sessionStartHeight: BigInt(claim.session_header.session_start_block_height.toString()),
        sessionEndHeight: BigInt(claim.session_header.session_end_block_height.toString()),
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        proofValidationStatus: getClaimProofStatusFromSDK(claim.proof_validation_status)!,
        failureReason: failureReason,
        eventId: getEventId(event),
      },
      {
        id: getRelayId({
          applicationId: claim.session_header.application_address,
          supplierId: claim.supplier_operator_address,
          serviceId: claim.session_header.service_id,
          sessionId: claim.session_header.session_id,
        }),
        proofValidationStatus: proofValidationStatus,
      },
    ];
  } else {
    logger.error(`[handleEventProofValidityChecked] proof|claim not found in event: ${stringify(event.event.attributes)}`);
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    return [];
  }
}

// _updateRelays - we need to update relay documents without historical tracking get to involve.
async function _updateRelays(relays: Array<RelayProps>): Promise<void> {
  const promises: Promise<void>[] = [];
  const RelayModel = store.modelProvider.getModel("Relay");
  relays.forEach(relay => {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    promises.push(RelayModel.model.update(
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore
      omit(relay, "id"),
      {
        where: {
          id: relay.id,
        },
        transaction: store.context.transaction,
      },
    ));
  });
  await Promise.all(promises);
}

export async function handleMsgCreateClaim(messages: Array<CosmosMessage<MsgCreateClaim>>): Promise<void> {
  const claimMsgs = [];
  const relays = [];

  for (const msg of messages) {
    const [claimMsg, relay] = _handleMsgCreateClaim(msg);
    claimMsgs.push(claimMsg);
    relays.push(relay);
  }

  await Promise.all([
    optimizedBulkCreate("MsgCreateClaim", claimMsgs),
    // on msg claim is the first time a Relay entity record is created.
    optimizedBulkCreate("Relay", relays),
  ]);
}

export async function handleMsgSubmitProof(messages: Array<CosmosMessage<MsgSubmitProof>>): Promise<void> {
  const proofMsgs = [];
  const relays = [];

  for (const msg of messages) {
    const [proofMsg, relay] = _handleMsgSubmitProof(msg);
    proofMsgs.push(proofMsg);
    relays.push(relay);
  }

  await Promise.all([
    optimizedBulkCreate("MsgSubmitProof", proofMsgs),
    _updateRelays(relays),
  ]);
}

export async function handleEventClaimExpired(events: Array<CosmosEvent>): Promise<void> {
  const eventsExpired = [];
  const relays = [];

  for (const event of events) {
    const [eventExpired, relay] = _handleEventClaimExpired(event);
    eventsExpired.push(eventExpired);
    relays.push(relay);
  }

  await Promise.all([
    optimizedBulkCreate("EventClaimExpired", eventsExpired),
    _updateRelays(relays),
  ]);
}

export async function handleEventClaimSettled(events: Array<CosmosEvent>): Promise<void> {
  const eventsSettled = [];
  const relays = [];
  const modToAcctTransfersToSave = [];

  for (const event of events) {
    const [eventSettled, relay, modToAcctTransfers] = _handleEventClaimSettled(event);
    eventsSettled.push(eventSettled);
    relays.push(relay);
    if (modToAcctTransfers.length) {
      modToAcctTransfersToSave.push(...modToAcctTransfers);
    }
  }

  await Promise.all([
    optimizedBulkCreate("EventClaimSettled", eventsSettled),
    optimizedBulkCreate("ModToAcctTransfer", modToAcctTransfersToSave),
    _updateRelays(relays),
  ]);
}

export async function handleEventClaimUpdated(events: Array<CosmosEvent>): Promise<void> {
  const eventsUpdated = [];
  const relays = [];

  for (const event of events) {
    const [eventUpdated, relay] = _handleEventClaimUpdated(event);
    eventsUpdated.push(eventUpdated);
    relays.push(relay);
  }

  await Promise.all([
    optimizedBulkCreate("EventClaimUpdated", eventsUpdated),
    _updateRelays(relays),
  ]);
}

export async function handleEventProofUpdated(events: Array<CosmosEvent>): Promise<void> {
  const eventsUpdated = [];
  const relays = [];

  for (const event of events) {
    const [eventUpdated, relay] = _handleEventProofUpdated(event);
    eventsUpdated.push(eventUpdated);
    relays.push(relay);
  }

  await Promise.all([
    optimizedBulkCreate("EventProofUpdated", eventsUpdated),
    _updateRelays(relays),
  ]);
}

export async function handleEventApplicationOverserviced(events: Array<CosmosEvent>): Promise<void> {
  const eventsUpdated = events.map(_handleEventApplicationOverserviced);

  await optimizedBulkCreate("EventApplicationOverserviced", eventsUpdated);
}

export async function handleEventApplicationReimbursementRequest(events: Array<CosmosEvent>): Promise<void> {
  const eventsUpdated = events.map(_handleEventApplicationReimbursementRequest);

  await optimizedBulkCreate("EventApplicationReimbursementRequest", eventsUpdated);
}

export async function handleEventSupplierSlashed(events: Array<CosmosEvent>): Promise<void> {
  await Promise.all(events.map(_handleEventSupplierSlashed));
}

export async function handleEventProofValidityChecked(events: Array<CosmosEvent>): Promise<void> {
  const eventsUpdated = [];
  const relays = [];

  for (const event of events) {
    const [eventUpdated, relay] = _handleEventProofValidityChecked(event);
    if (eventUpdated) {
      eventsUpdated.push(eventUpdated);
    }
    if (relay) {
      relays.push(relay);
    }
  }

  await Promise.all([
    optimizedBulkCreate("EventProofValidityChecked", eventsUpdated),
    _updateRelays(relays as Array<RelayProps>),
  ]);
}
