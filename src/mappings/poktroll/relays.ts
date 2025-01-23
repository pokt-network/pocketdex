import {
  CosmosEvent,
  CosmosMessage,
} from "@subql/types-cosmos";
import { claimExpirationReasonFromJSON } from "../../client/poktroll/tokenomics/event";
import {
  ClaimExpirationReason,
  EventClaimExpired,
  EventClaimSettled,
  EventClaimUpdated,
  EventProofUpdated,
  MsgCreateClaim as MsgCreateClaimEntity,
  MsgSubmitProof as MsgSubmitProofEntity,
  ProofRequirementReason,
  Relay,
} from "../../types";
import { CoinSDKType } from "../../types/proto-interfaces/cosmos/base/v1beta1/coin";
import {
  MsgCreateClaim,
  MsgSubmitProof,
} from "../../types/proto-interfaces/poktroll/proof/tx";
import {
  ClaimSDKType,
  proofRequirementReasonFromJSON,
  ProofRequirementReasonSDKType,
  ProofSDKType,
} from "../../types/proto-interfaces/poktroll/proof/types";
import { ClaimExpirationReasonSDKType } from "../../types/proto-interfaces/poktroll/tokenomics/event";
import { RelayStatus } from "../constants";
import {
  getEventId,
  getRelayId,
  messageId,
} from "../utils/ids";
import { stringify } from "../utils/json";

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
    claimed: CoinSDKType = {};

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

    if (attribute.key === "num_claimed_computed_units") {
      numClaimedComputedUnits = BigInt(parseAttribute(attribute.value));
    }

    if (attribute.key === "num_estimated_computed_units") {
      numEstimatedComputedUnits = BigInt(parseAttribute(attribute.value));
    }

    if (attribute.key === "claimed") {
      claimed = JSON.parse(attribute.value as string);
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
  };
}

// TODO: update this to work with BatchMessage handler
// handleMsgCreateClaim, referenced in project.ts
export async function handleMsgCreateClaim(msg: CosmosMessage<MsgCreateClaim>): Promise<void> {
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
    rootHash: stringify(rootHash),
  };

  await Promise.all([
    MsgCreateClaimEntity.create({
      id: messageId(msg),
      ...shared,
      transactionId: msg.tx.hash,
      blockId: msg.block.block.id,
    }),
    Relay.create({
      id,
      ...shared,
      status: RelayStatus.PENDING,
      msgCreateClaimId: messageId(msg),
    }).save(),
  ]);
}

// TODO: update this to work with BatchMessage handler
// handleMsgSubmitProof, referenced in project.ts
export async function handleMsgSubmitProof(msg: CosmosMessage<MsgSubmitProof>): Promise<void> {
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

  await Promise.all([
    MsgSubmitProofEntity.create({
      id: msgId,
      ...shared,
      proof: stringify(proof),
      transactionId: msg.tx.hash,
      blockId: msg.block.block.id,
    }).save(),
    store.bulkUpdate("Relay", [{
      ...shared,
      id: getRelayId({
        applicationId,
        supplierId: supplierOperatorAddress,
        serviceId,
        sessionId,
      }),
      status: RelayStatus.PENDING,
      msgSubmitProofId: msgId,
    }] as Array<Relay>, [...Object.keys(shared), "id", "status", "msgSubmitProofId"]),
  ]);
}

// TODO: update this to work with BatchEvent handler
// handleEventClaimSettled, referenced in project.ts
export async function handleEventClaimSettled(event: CosmosEvent): Promise<void> {
  const {
    claim,
    claimed,
    numClaimedComputedUnits,
    numEstimatedComputedUnits,
    numRelays,
    proofRequirement,
  } = getAttributes(event.event.attributes);

  const { root_hash, session_header, supplier_operator_address } = claim;

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
  } as const;

  await Promise.all([
    store.bulkUpdate("Relay", [{
      ...shared,
      id: getRelayId({
        applicationId: session_header?.application_address || "",
        supplierId: supplier_operator_address,
        serviceId: session_header?.service_id || "",
        sessionId: session_header?.session_id || "",
      }),
      status: RelayStatus.SUCCESSFUL,
      eventClaimSettledId: getEventId(event),
    }] as Array<Relay>, [...Object.keys(shared), "id", "status", "eventClaimSettledId"]),
    EventClaimSettled.create({
      ...shared,
      transactionId: event.tx?.hash,
      blockId: event.block.block.id,
      id: getEventId(event),
      proofRequirement,
    }).save(),
  ]);
}

// TODO: update this to work with BatchEvent handler
// handleEventClaimExpired, referenced in project.ts
export async function handleEventClaimExpired(event: CosmosEvent): Promise<void> {
  const {
    claim,
    claimed,
    expirationReason,
    numClaimedComputedUnits,
    numEstimatedComputedUnits,
    numRelays,
  } = getAttributes(event.event.attributes);

  const { root_hash, session_header, supplier_operator_address } = claim;

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
  } as const;

  await Promise.all([
    store.bulkUpdate("Relay", [{
      ...shared,
      id: getRelayId({
        applicationId: session_header?.application_address || "",
        supplierId: supplier_operator_address,
        serviceId: session_header?.service_id || "",
        sessionId: session_header?.session_id || "",
      }),
      eventClaimExpiredId: getEventId(event),
      status: RelayStatus.FAILED,
    }] as Array<Relay>, [...Object.keys(shared), "id", "status", "eventClaimExpiredId"]),
    EventClaimExpired.create({
      ...shared,
      id: getEventId(event),
      expirationReason,
      transactionId: event.tx?.hash,
      blockId: event.block.block.id,
    }).save(),
  ]);
}

// TODO: update this to work with BatchEvent handler
// handleEventClaimUpdated, referenced in project.ts
export async function handleEventClaimUpdated(event: CosmosEvent): Promise<void> {
  const {
    claim,
    claimed,
    numClaimedComputedUnits,
    numEstimatedComputedUnits,
    numRelays,
  } = getAttributes(event.event.attributes);

  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  const { root_hash, session_header, supplier_operator_address } = claim;

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
  } as const;

  await Promise.all([
    store.bulkUpdate("Relay", [{
      ...shared,
      id: relayId,
      status: RelayStatus.PENDING,
    }] as Array<Relay>, [...Object.keys(shared), "id", "status"]),
    EventClaimUpdated.create({
      ...shared,
      id: getEventId(event),
      relayId,
      transactionId: event.tx?.hash,
      blockId: event.block.block.id,
    }).save(),
  ]);
}

// TODO: update this to work with BatchEvent handler
// handleEventProofUpdated, referenced in project.ts
export async function handleEventProofUpdated(event: CosmosEvent): Promise<void> {
  const {
    claim,
    claimed,
    numClaimedComputedUnits,
    numEstimatedComputedUnits,
    numRelays,
    proof,
  } = getAttributes(event.event.attributes);

  const { root_hash, session_header, supplier_operator_address } = claim;

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
  } as const;


  const id = getRelayId({
    applicationId: session_header?.application_address || "",
    supplierId: supplier_operator_address,
    serviceId: session_header?.service_id || "",
    sessionId: session_header?.session_id || "",
  });

  await Promise.all([
    EventProofUpdated.create({
      id: getEventId(event),
      ...shared,
      closestMerkleProof: proof ? stringify(proof.closest_merkle_proof) : undefined,
      relayId: id,
      transactionId: event.tx?.hash,
      blockId: event.block.block.id,
    }).save(),
    store.bulkUpdate("Relay", [{
      ...shared,
      id,
      status: RelayStatus.PENDING,
    }] as Array<Relay>, [...Object.keys(shared), "id", "status"]),
  ]);
}
