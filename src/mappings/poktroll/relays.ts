import { toHex } from "@cosmjs/encoding";
import {
  CosmosEvent,
  CosmosMessage,
} from "@subql/types-cosmos";
import { omit } from "lodash";
import { claimExpirationReasonFromJSON } from "../../client/poktroll/tokenomics/event";
import {
  ClaimExpirationReason,
  ProofRequirementReason,
  RelayStatus,
} from "../../types";
import { EventClaimExpiredProps } from "../../types/models/EventClaimExpired";
import { EventClaimSettledProps } from "../../types/models/EventClaimSettled";
import { EventClaimUpdatedProps } from "../../types/models/EventClaimUpdated";
import { EventProofUpdatedProps } from "../../types/models/EventProofUpdated";
import { MsgCreateClaimProps } from "../../types/models/MsgCreateClaim";
import { MsgSubmitProofProps } from "../../types/models/MsgSubmitProof";
import { RelayProps } from "../../types/models/Relay";
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
import { optimizedBulkCreate } from "../utils/db";
import {
  getBlockId,
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

function _handleEventClaimSettled(event: CosmosEvent): [EventClaimSettledProps, RelayProps] {
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

  return [
    {
      ...shared,
      transactionId: event.tx?.hash,
      blockId: getBlockId(event.block),
      id: getEventId(event),
      proofRequirement,
    },
    {
      ...shared,
      id: getRelayId({
        applicationId: session_header?.application_address || "",
        supplierId: supplier_operator_address,
        serviceId: session_header?.service_id || "",
        sessionId: session_header?.session_id || "",
      }),
      status: RelayStatus.Success,
      eventClaimSettledId: getEventId(event),
    },
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

  for (const event of events) {
    const [eventSettled, relay] = _handleEventClaimSettled(event);
    eventsSettled.push(eventSettled);
    relays.push(relay);
  }

  await Promise.all([
    optimizedBulkCreate("EventClaimSettled", eventsSettled),
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
