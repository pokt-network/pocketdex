import { toHex } from "@cosmjs/encoding";
import { CosmosEvent, CosmosMessage } from "@subql/types-cosmos";
import { omit } from "lodash";
import { claimExpirationReasonFromJSON } from "../../client/poktroll/tokenomics/event";
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
import { MsgCreateClaim, MsgSubmitProof } from "../../types/proto-interfaces/poktroll/proof/tx";
import {
  ClaimProofStatusSDKType,
  ClaimSDKType,
  proofRequirementReasonFromJSON,
  ProofRequirementReasonSDKType,
  ProofSDKType,
} from "../../types/proto-interfaces/poktroll/proof/types";
import { ClaimExpirationReasonSDKType } from "../../types/proto-interfaces/poktroll/tokenomics/event";
import {
  ClaimSettlementResultSDKType,
  settlementOpReasonFromJSON,
  SettlementOpReasonSDKType,
} from "../../types/proto-interfaces/poktroll/tokenomics/types";
import { optimizedBulkCreate } from "../utils/db";
import { getBlockId, getEventId, getRelayId, messageId } from "../utils/ids";
import { parseJson, stringify } from "../utils/json";

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
      return SettlementOpReason.TLM_RELAY_BURN_EQUALS_MINT_SUPPLIER_STAKE_MINT

    case "TLM_RELAY_BURN_EQUALS_MINT_APPLICATION_STAKE_BURN":
    case SettlementOpReasonSDKType.TLM_RELAY_BURN_EQUALS_MINT_APPLICATION_STAKE_BURN:
      return SettlementOpReason.TLM_RELAY_BURN_EQUALS_MINT_APPLICATION_STAKE_BURN

    case "TLM_GLOBAL_MINT_INFLATION":
    case SettlementOpReasonSDKType.TLM_GLOBAL_MINT_INFLATION:
      return SettlementOpReason.TLM_GLOBAL_MINT_INFLATION

    case "TLM_RELAY_BURN_EQUALS_MINT_SUPPLIER_SHAREHOLDER_REWARD_DISTRIBUTION":
    case SettlementOpReasonSDKType.TLM_RELAY_BURN_EQUALS_MINT_SUPPLIER_SHAREHOLDER_REWARD_DISTRIBUTION:
      return SettlementOpReason.TLM_RELAY_BURN_EQUALS_MINT_SUPPLIER_SHAREHOLDER_RD

    case "TLM_GLOBAL_MINT_DAO_REWARD_DISTRIBUTION":
    case SettlementOpReasonSDKType.TLM_GLOBAL_MINT_DAO_REWARD_DISTRIBUTION:
      return SettlementOpReason.TLM_GLOBAL_MINT_DAO_REWARD_DISTRIBUTION

    case "TLM_GLOBAL_MINT_PROPOSER_REWARD_DISTRIBUTION":
    case SettlementOpReasonSDKType.TLM_GLOBAL_MINT_PROPOSER_REWARD_DISTRIBUTION:
      return SettlementOpReason.TLM_GLOBAL_MINT_PROPOSER_REWARD_DISTRIBUTION

    case "TLM_GLOBAL_MINT_SUPPLIER_SHAREHOLDER_REWARD_DISTRIBUTION":
    case SettlementOpReasonSDKType.TLM_GLOBAL_MINT_SUPPLIER_SHAREHOLDER_REWARD_DISTRIBUTION:
      return SettlementOpReason.TLM_GLOBAL_MINT_SUPPLIER_SHAREHOLDER_REWARD_DISTRIBUTION

    case "TLM_GLOBAL_MINT_SOURCE_OWNER_REWARD_DISTRIBUTION":
    case SettlementOpReasonSDKType.TLM_GLOBAL_MINT_SOURCE_OWNER_REWARD_DISTRIBUTION:
      return SettlementOpReason.TLM_GLOBAL_MINT_SOURCE_OWNER_REWARD_DISTRIBUTION

    case "TLM_GLOBAL_MINT_APPLICATION_REWARD_DISTRIBUTION":
    case SettlementOpReasonSDKType.TLM_GLOBAL_MINT_APPLICATION_REWARD_DISTRIBUTION:
      return SettlementOpReason.TLM_GLOBAL_MINT_APPLICATION_REWARD_DISTRIBUTION

    case "TLM_GLOBAL_MINT_REIMBURSEMENT_REQUEST_ESCROW_DAO_TRANSFER":
    case SettlementOpReasonSDKType.TLM_GLOBAL_MINT_REIMBURSEMENT_REQUEST_ESCROW_DAO_TRANSFER:
      return SettlementOpReason.TLM_GLOBAL_MINT_REIMBURSEMENT_REQUEST_ESCROW_DAO_TRANSFER

    case "UNSPECIFIED_TLM_SUPPLIER_SLASH_MODULE_TRANSFER":
    case SettlementOpReasonSDKType.UNSPECIFIED_TLM_SUPPLIER_SLASH_MODULE_TRANSFER:
      return SettlementOpReason.UNSPECIFIED_TLM_SUPPLIER_SLASH_MODULE_TRANSFER

    case "UNSPECIFIED_TLM_SUPPLIER_SLASH_STAKE_BURN":
    case SettlementOpReasonSDKType.UNSPECIFIED_TLM_SUPPLIER_SLASH_STAKE_BURN:
      return SettlementOpReason.UNSPECIFIED_TLM_SUPPLIER_SLASH_STAKE_BURN

    case "TLM_GLOBAL_MINT_SUPPLIER_SHAREHOLDER_REWARD_MODULE_TRANSFER":
    case SettlementOpReasonSDKType.TLM_GLOBAL_MINT_SUPPLIER_SHAREHOLDER_REWARD_MODULE_TRANSFER:
      return SettlementOpReason.TLM_GLOBAL_MINT_SUPPLIER_SHAREHOLDER_REWARD_MODULE_TRANSFER

    case "TLM_GLOBAL_MINT_REIMBURSEMENT_REQUEST_ESCROW_MODULE_TRANSFER":
    case SettlementOpReasonSDKType.TLM_GLOBAL_MINT_REIMBURSEMENT_REQUEST_ESCROW_MODULE_TRANSFER:
      return SettlementOpReason.TLM_GLOBAL_MINT_REIMBURSEMENT_REQUEST_ESCROW_MODULE_TRANSFER

    default:
      throw new Error(`Unknown SettlementOpReason=${item}`)
  }
}

function parseAttribute(attribute: unknown): string {
  return (attribute as string).replaceAll("\"", "");
}

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
    failureReason = '',
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

    if (attribute.key === 'failure_reason') {
      failureReason = attribute.value as string
    }

    if (attribute.key === 'proof_status') {
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
  const { proof, sessionHeader, supplierOperatorAddress } = msg.msg.decodedMsg;

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
      proof: stringify(proof),
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
    rootHash: stringify(root_hash),
    numRelays,
    numClaimedComputedUnits,
    numEstimatedComputedUnits,
    claimedDenom: claimed?.denom || "",
    claimedAmount: BigInt(claimed?.amount || "0"),
    proofValidationStatus: getClaimProofStatusFromSDK(proof_validation_status),
  } as const;

  const eventId = getEventId(event)
  const blockId = getBlockId(event.block)
  const relayId = getRelayId({
    applicationId: session_header?.application_address || "",
    supplierId: supplier_operator_address,
    serviceId: session_header?.service_id || "",
    sessionId: session_header?.session_id || "",
  })

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
      })) || []
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
    })) || []
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
    rootHash: stringify(root_hash),
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
    rootHash: stringify(root_hash),
    numRelays,
    numClaimedComputedUnits,
    numEstimatedComputedUnits,
    claimedDenom: claimed?.denom || "",
    claimedAmount: BigInt(claimed?.amount || "0"),
    ...(proof_validation_status && {
      proofValidationStatus: getClaimProofStatusFromSDK(proof_validation_status),
    })
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
    rootHash: stringify(root_hash),
    numRelays,
    numClaimedComputedUnits,
    numEstimatedComputedUnits,
    claimedDenom: claimed?.denom || "",
    claimedAmount: BigInt(claimed?.amount || "0"),
    ...(proof_validation_status && {
      proofValidationStatus: getClaimProofStatusFromSDK(proof_validation_status),
    })
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
  let expectedBurn: Coin | null = null, effectiveBurn: Coin | null = null, applicationAddress = '', supplierAddress = '';

  for (const attribute of event.event.attributes) {
    if (attribute.key === "application_addr") {
      applicationAddress = (attribute.value as string).replaceAll('"', '');
    }

    if (attribute.key === "supplier_operator_addr") {
      supplierAddress = (attribute.value as string).replaceAll('"', '');
    }

    if (attribute.key === "expected_burn") {
      expectedBurn = parseJson(attribute.value as string);
    }

    if (attribute.key === "effective_burn") {
      effectiveBurn = parseJson(attribute.value as string);
    }
  }

  if (!applicationAddress) {
    logger.info(`[handleEventApplicationOverserviced] attributes=${stringify(event.event.attributes, undefined, 2)}`);
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
  }
}

function _handleEventApplicationReimbursementRequest(event: CosmosEvent): EventApplicationReimbursementRequestProps {
  let applicationAddress = '', supplierAddress = '', serviceId = '', sessionId = '', coin: CoinSDKType | null = null

  for (const {key, value} of event.event.attributes) {
    if (key === 'amount') {
      coin = parseJson(value as string)
      continue
    }

    const parsedValue = parseAttribute(value)

    if (key === 'application_addr') {
      applicationAddress = parsedValue
    }

    if (key === 'supplier_operator_addr') {
      supplierAddress = parsedValue
    }

    if (key === 'service_id') {
      serviceId = parsedValue
    }

    if (key === 'session_id') {
      sessionId = parsedValue
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
  }
}

async function _handleEventSupplierSlashed(event: CosmosEvent) {
  const {
    claim,
    proofMissingPenalty
  } = getAttributes(event.event.attributes);

  if (!claim) {
    throw new Error(`[handleEventSupplierSlashed] claim not found in event`);
  }

  if (!claim.session_header) {
    throw new Error(`[handleEventSupplierSlashed] session_header not found in event`);
  }

  const supplier = await Supplier.get(claim.supplier_operator_address)

  if (!supplier) {
    throw new Error(`[handleEventSupplierSlashed] supplier not found for address: ${claim.supplier_operator_address}`)
  }

  const previousStakeAmount = supplier.stakeAmount.valueOf()
  supplier.stakeAmount -= BigInt(proofMissingPenalty.amount)

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
  ])
}

function _handleEventProofValidityChecked(event: CosmosEvent): [EventProofValidityCheckedProps, Partial<RelayProps>] {
  const {failureReason, proof, proofValidationStatus} = getAttributes(event.event.attributes)

  if (!proof) {
    throw new Error(`[handleEventProofValidityChecked] proof not found in event`);
  }

  if (!proof.session_header) {
    throw new Error(`[handleEventProofValidityChecked] session_header not found in event`);
  }

  if (!proofValidationStatus) {
    throw new Error(`[handleEventProofValidityChecked] proofValidationStatus not found in event`);
  }

  if (!failureReason) {
    throw new Error(`[handleEventProofValidityChecked] failureReason not found in event`);
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
    }
  ]
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
  const modToAcctTransfersToSave = []

  for (const event of events) {
    const [eventSettled, relay, modToAcctTransfers] = _handleEventClaimSettled(event);
    eventsSettled.push(eventSettled);
    relays.push(relay);
    if (modToAcctTransfers.length) {
      modToAcctTransfersToSave.push(...modToAcctTransfers)
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

  await optimizedBulkCreate("EventApplicationOverserviced", eventsUpdated)
}

export async function handleEventApplicationReimbursementRequest(events: Array<CosmosEvent>): Promise<void> {
  const eventsUpdated = events.map(_handleEventApplicationReimbursementRequest);

  await optimizedBulkCreate("EventApplicationReimbursementRequest", eventsUpdated)
}

export async function handleEventSupplierSlashed(events: Array<CosmosEvent>): Promise<void> {
  await Promise.all(events.map(_handleEventSupplierSlashed))
}

export async function handleEventProofValidityChecked(events: Array<CosmosEvent>): Promise<void> {
  const eventsUpdated = [];
  const relays = [];

  for (const event of events) {
    const [eventUpdated, relay] = _handleEventProofValidityChecked(event);
    eventsUpdated.push(eventUpdated);
    relays.push(relay);
  }

  await Promise.all([
    optimizedBulkCreate("EventProofValidityChecked", eventsUpdated),
    _updateRelays(relays as Array<RelayProps>),
  ]);
}
