import {
  CosmosEvent,
  CosmosMessage,
} from "@subql/types-cosmos";
import isEmpty from "lodash/isEmpty";
import { claimProofStatusFromJSON } from "../../client/pocket/proof/types";
import { claimExpirationReasonFromJSON } from "../../client/pocket/tokenomics/event";
import {
  ClaimExpirationReason,
  ClaimProofStatus,
  Coin,
  EventSupplierSlashed,
  ProofRequirementReason,
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
import { ClaimExpirationReasonSDKType, } from "../../types/proto-interfaces/pocket/tokenomics/event";
import {
  ClaimSettlementResultSDKType,
  settlementOpReasonFromJSON,
  SettlementOpReasonSDKType,
} from "../../types/proto-interfaces/pocket/tokenomics/types";
import { optimizedBulkCreate } from "../utils/db";
import { getBlockId, getEventId, messageId } from "../utils/ids";
import { stringify } from "../utils/json";
import { getDenomAndAmount } from "../utils/primitives";

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
    failureReason: string | null = null,
    proofValidationStatus: ClaimProofStatus | undefined,
    settlementResult: ClaimSettlementResultSDKType | null = null,
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    proofMissingPenalty: CoinSDKType = {};

  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  const newClaim: ClaimSDKType = { session_header: {}}

  for (const attribute of attributes) {
    if (attribute.key === "proof") {
      proof = JSON.parse(attribute.value as string);
    }

    if (attribute.key === "claim") {
      claim = JSON.parse(attribute.value as string);
    }

    if (attribute.key === "supplier_operator_address") {
      newClaim.supplier_operator_address = parseAttribute(attribute.value);
    }

    if (attribute.key === "service_id") {
      newClaim.session_header!.service_id = parseAttribute(attribute.value);
    }

    if (attribute.key === "application_address") {
      newClaim.session_header!.application_address = parseAttribute(attribute.value);
    }

    if (attribute.key === "session_end_block_height") {
      newClaim.session_header!.session_end_block_height = BigInt(parseAttribute(attribute.value));
      newClaim.session_header!.session_start_block_height = BigInt(0);
      newClaim.session_header!.session_id = "";
    }

    if (attribute.key === "claim_proof_status_int") {
      newClaim.proof_validation_status = claimProofStatusFromJSON(Number(parseAttribute(attribute.value as string)))
      proofValidationStatus = getClaimProofStatusFromSDK(newClaim.proof_validation_status);
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
      claimed = getDenomAndAmount(attribute.value as string);
    }

    if (attribute.key === "settlement_result") {
      settlementResult = JSON.parse(attribute.value as string);
    }

    if (attribute.key === "proof_missing_penalty") {
      proofMissingPenalty = getDenomAndAmount(attribute.value as string);
    }

    if (attribute.key === 'failure_reason') {
      failureReason = parseAttribute(attribute.value as string)
    }

    if (attribute.key === "proof_status") {
      proofValidationStatus = getClaimProofStatusFromSDK(parseAttribute(attribute.value as string));
    }

    if (["proof_requirement_int", "proof_requirement"].includes(attribute.key as string)) {
      const parsed = parseAttribute(attribute.value as string);

      const value = attribute.key === "proof_requirement_int" ? parseInt(parsed) : parsed;

      switch (proofRequirementReasonFromJSON(value)) {
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

  if (isEmpty(claim) && Object.keys(newClaim).length > 1) {
    claim = newClaim;
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

function _handleMsgCreateClaim(msg: CosmosMessage<MsgCreateClaim>): MsgCreateClaimProps {
  const { sessionHeader, supplierOperatorAddress, } = msg.msg.decodedMsg;
  const applicationId = sessionHeader?.applicationAddress || "";
  const serviceId = sessionHeader?.serviceId || "";
  const sessionId = sessionHeader?.sessionId || "";

  const eventClaimCreated = msg.tx.tx.events.find(event => event.type === "pocket.proof.EventClaimCreated");

  if (!eventClaimCreated) {
    throw new Error(`EventClaimCreated not found for msg MsgCreateClaim ${msg.idx} ${msg.tx.hash} ${msg.block.block.header.height}`);
  }

  const {
    claimed,
    numClaimedComputedUnits,
    numEstimatedComputedUnits,
    numRelays
  } = getAttributes(eventClaimCreated.attributes)

  return {
    id: messageId(msg),
    transactionId: msg.tx.hash,
    blockId: getBlockId(msg.block),
    supplierId: supplierOperatorAddress,
    applicationId,
    serviceId,
    sessionId,
    numRelays,
    numClaimedComputedUnits,
    numEstimatedComputedUnits,
    claimedDenom: claimed?.denom || "",
    claimedAmount: BigInt(claimed?.amount || "0"),
    sessionStartHeight: BigInt(sessionHeader?.sessionStartBlockHeight?.toString() || 0),
    sessionEndHeight: BigInt(sessionHeader?.sessionEndBlockHeight?.toString() || 0),
    rootHash: undefined,
  }
}

function _handleMsgSubmitProof(msg: CosmosMessage<MsgSubmitProof>): MsgSubmitProofProps {
  const { sessionHeader, supplierOperatorAddress } = msg.msg.decodedMsg;

  const applicationId = sessionHeader?.applicationAddress || "";
  const serviceId = sessionHeader?.serviceId || "";
  const sessionId = sessionHeader?.sessionId || "";
  const msgId = messageId(msg);

  return {
    id: msgId,
    transactionId: msg.tx.hash,
    blockId: getBlockId(msg.block),
    applicationId,
    supplierId: supplierOperatorAddress,
    sessionId,
    serviceId,
    sessionEndHeight: BigInt(sessionHeader?.sessionEndBlockHeight?.toString() || 0),
    sessionStartHeight: BigInt(sessionHeader?.sessionStartBlockHeight?.toString() || 0),
    proof: undefined,
  }
}

function _handleEventClaimSettled(event: CosmosEvent): [EventClaimSettledProps, Array<ModToAcctTransferProps>] {
  const {
    claim,
    claimed,
    numClaimedComputedUnits,
    numEstimatedComputedUnits,
    numRelays,
    proofRequirement,
    settlementResult,
  } = getAttributes(event.event.attributes);

  const { proof_validation_status, session_header, supplier_operator_address } = claim;

  const eventId = getEventId(event)
  const blockId = getBlockId(event.block)

  let modToAcctTransfers: Array<ModToAcctTransferProps> = []

  if (settlementResult?.mod_to_acct_transfers) {
    modToAcctTransfers = settlementResult.mod_to_acct_transfers.map((item, index) => ({
      id: `${eventId}-${index}`,
      blockId,
      eventClaimSettledId: eventId,
      senderModule: item.SenderModule,
      recipientId: item.RecipientAddress,
      amount: BigInt(item.coin.amount),
      denom: item.coin.denom,
      opReason: getSettlementOpReasonFromSDK(item.op_reason),
      relayId: '',
    })) || []
  }

  return [
    {
      supplierId: supplier_operator_address,
      applicationId: session_header?.application_address || "",
      serviceId: session_header?.service_id || "",
      sessionId: session_header?.session_id || "",
      sessionStartHeight: BigInt(session_header?.session_start_block_height?.toString() || 0),
      sessionEndHeight: BigInt(session_header?.session_end_block_height?.toString() || 0),
      numRelays,
      numClaimedComputedUnits,
      numEstimatedComputedUnits,
      claimedDenom: claimed?.denom || "",
      claimedAmount: BigInt(claimed?.amount || "0"),
      proofValidationStatus: getClaimProofStatusFromSDK(proof_validation_status),
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
      rootHash: undefined,
    },
    modToAcctTransfers,
  ];
}

function _handleEventClaimExpired(event: CosmosEvent): EventClaimExpiredProps {
  const {
    claim,
    claimed,
    expirationReason,
    numClaimedComputedUnits,
    numEstimatedComputedUnits,
    numRelays,
  } = getAttributes(event.event.attributes);

  const { proof_validation_status, session_header, supplier_operator_address } = claim;

  return {
    supplierId: supplier_operator_address,
    applicationId: session_header?.application_address || "",
    serviceId: session_header?.service_id || "",
    sessionId: session_header?.session_id || "",
    sessionStartHeight: BigInt(session_header?.session_start_block_height?.toString() || 0),
    sessionEndHeight: BigInt(session_header?.session_end_block_height?.toString() || 0),
    numRelays,
    numClaimedComputedUnits,
    numEstimatedComputedUnits,
    claimedDenom: claimed?.denom || "",
    claimedAmount: BigInt(claimed?.amount || "0"),
    proofValidationStatus: getClaimProofStatusFromSDK(proof_validation_status),
    id: getEventId(event),
    expirationReason,
    transactionId: event.tx?.hash,
    blockId: getBlockId(event.block),
    rootHash: undefined,
  }
}

function _handleEventClaimUpdated(event: CosmosEvent): EventClaimUpdatedProps {
  const {
    claim,
    claimed,
    numClaimedComputedUnits,
    numEstimatedComputedUnits,
    numRelays,
  } = getAttributes(event.event.attributes);

  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  const { proof_validation_status, session_header, supplier_operator_address } = claim;

  return {
    id: getEventId(event),
    transactionId: event.tx?.hash,
    blockId: getBlockId(event.block),
    supplierId: supplier_operator_address,
    applicationId: session_header?.application_address || "",
    serviceId: session_header?.service_id || "",
    sessionId: session_header?.session_id || "",
    sessionStartHeight: BigInt(session_header?.session_start_block_height?.toString() || 0),
    sessionEndHeight: BigInt(session_header?.session_end_block_height?.toString() || 0),
    numRelays,
    numClaimedComputedUnits,
    numEstimatedComputedUnits,
    claimedDenom: claimed?.denom || "",
    claimedAmount: BigInt(claimed?.amount || "0"),
    ...(proof_validation_status && {
      proofValidationStatus: getClaimProofStatusFromSDK(proof_validation_status),
    }),
    relayId: undefined,
    rootHash: undefined,
  }
}

function _handleEventProofUpdated(event: CosmosEvent): EventProofUpdatedProps {
  const {
    claim,
    claimed,
    numClaimedComputedUnits,
    numEstimatedComputedUnits,
    numRelays,
  } = getAttributes(event.event.attributes);

  const { proof_validation_status, session_header, supplier_operator_address } = claim;

  return {
    id: getEventId(event),
    transactionId: event.tx?.hash,
    blockId: getBlockId(event.block),
    supplierId: supplier_operator_address,
    applicationId: session_header?.application_address || "",
    serviceId: session_header?.service_id || "",
    sessionId: session_header?.session_id || "",
    sessionStartHeight: BigInt(session_header?.session_start_block_height?.toString() || 0),
    sessionEndHeight: BigInt(session_header?.session_end_block_height?.toString() || 0),
    numRelays,
    numClaimedComputedUnits,
    numEstimatedComputedUnits,
    claimedDenom: claimed?.denom || "",
    claimedAmount: BigInt(claimed?.amount || "0"),
    ...(proof_validation_status && {
      proofValidationStatus: getClaimProofStatusFromSDK(proof_validation_status),
    }),
    closestMerkleProof: undefined,
    relayId: undefined,
    rootHash: undefined,
  }
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
      expectedBurn = getDenomAndAmount(attribute.value as string);
    }

    if (attribute.key === "effective_burn") {
      effectiveBurn = getDenomAndAmount(attribute.value as string);
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
      coin = getDenomAndAmount(value as string);
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
      slashingCoin = getDenomAndAmount(attribute.value as string);
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

  if (!claim || !claim.session_header || Object.keys(claim).length === 0) {
    logger.warn(`[handleEventSupplierSlashed] claim not found in event, trying to handle with previous version`);
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
      sessionId: claim.session_header.session_id || "",
      sessionEndHeight: BigInt(claim.session_header.session_end_block_height || "0"),
      sessionStartHeight: BigInt(claim.session_header.session_start_block_height || "0"),
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

function _handleEventProofValidityChecked(event: CosmosEvent): EventProofValidityCheckedProps {
  // in the current proto files of this event, proof does not come, but in the older version of this event it comes.
  const { claim, failureReason, proof, proofValidationStatus} = getAttributes(event.event.attributes);

  const sessionHeader = proof?.session_header || claim?.session_header;

  if (!sessionHeader) {
    throw new Error(`[handleEventProofValidityChecked] session_header not found in event ${stringify(event.event.attributes)}`);
  }

  const supplierOperatorAddress = proof?.supplier_operator_address || claim?.supplier_operator_address;

  if (!supplierOperatorAddress) {
    throw new Error(`[handleEventProofValidityChecked] supplier_operator_address not found in event ${stringify(event.event.attributes)}`);
  }

  const validationStatus = proofValidationStatus || getClaimProofStatusFromSDK(parseAttribute(claim?.proof_validation_status));

  if (!validationStatus) {
    logger.error(`[handleEventProofValidityChecked] proofValidationStatus not found in event: ${stringify(event.event.attributes)}`);
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    return [];
    // throw new Error(`[handleEventProofValidityChecked] proofValidationStatus not found in event`);
  }

  if (failureReason === null) {
    logger.error(`[handleEventProofValidityChecked] failureReason not found in event: ${stringify(event.event.attributes)}`);
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    return [];
    // throw new Error(`[handleEventProofValidityChecked] failureReason not found in event`);
  }

  return {
    id: getEventId(event),
    blockId: getBlockId(event.block),
    supplierId: supplierOperatorAddress,
    applicationId: sessionHeader.application_address,
    serviceId: sessionHeader.service_id,
    sessionId: sessionHeader.session_id,
    sessionStartHeight: BigInt(sessionHeader.session_start_block_height?.toString() || "0"),
    sessionEndHeight: BigInt(sessionHeader.session_end_block_height.toString()),
    proofValidationStatus: validationStatus,
    failureReason: failureReason,
    eventId: getEventId(event),
  }
}

export async function handleMsgCreateClaim(messages: Array<CosmosMessage<MsgCreateClaim>>): Promise<void> {
  await optimizedBulkCreate("MsgCreateClaim", messages.map(_handleMsgCreateClaim))
}

export async function handleMsgSubmitProof(messages: Array<CosmosMessage<MsgSubmitProof>>): Promise<void> {
  await optimizedBulkCreate("MsgSubmitProof", messages.map(_handleMsgSubmitProof))
}

export async function handleEventClaimExpired(events: Array<CosmosEvent>): Promise<void> {
  await optimizedBulkCreate("EventClaimExpired", events.map(_handleEventClaimExpired))
}

export async function handleEventClaimSettled(events: Array<CosmosEvent>): Promise<void> {
  const eventsSettled = [];
  const modToAcctTransfersToSave = [];

  for (const event of events) {
    const [eventSettled, modToAcctTransfers] = _handleEventClaimSettled(event);
    eventsSettled.push(eventSettled);

    if (modToAcctTransfers.length) {
      modToAcctTransfersToSave.push(...modToAcctTransfers);
    }
  }

  await Promise.all([
    optimizedBulkCreate("EventClaimSettled", eventsSettled),
    optimizedBulkCreate("ModToAcctTransfer", modToAcctTransfersToSave),
  ]);
}

export async function handleEventClaimUpdated(events: Array<CosmosEvent>): Promise<void> {
  await optimizedBulkCreate("EventClaimUpdated", events.map(_handleEventClaimUpdated))
}

export async function handleEventProofUpdated(events: Array<CosmosEvent>): Promise<void> {
  await optimizedBulkCreate("EventProofUpdated", events.map(_handleEventProofUpdated))
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
  await optimizedBulkCreate("EventProofValidityChecked", events.map(_handleEventProofValidityChecked))
}
