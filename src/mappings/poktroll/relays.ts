import { CosmosEvent, CosmosMessage } from "@subql/types-cosmos";
import { getEventId, getRelayId, messageId, stringify } from "../utils";
import { MsgCreateClaim, MsgSubmitProof } from "../../types/proto-interfaces/poktroll/proof/tx";
import {
  ClaimExpirationReason,
  EventClaimCreated,
  EventClaimExpired,
  EventClaimSettled,
  EventClaimUpdated,
  EventProofSubmitted,
  EventProofUpdated,
  MsgCreateClaim as MsgCreateClaimEntity,
  MsgSubmitProof as MsgSubmitProofEntity,
  ProofRequirementReason,
  Relay
} from "../../types";
import {
  ClaimSDKType,
  proofRequirementReasonFromJSON,
  ProofRequirementReasonSDKType,
  ProofSDKType,
} from "../../types/proto-interfaces/poktroll/proof/types";
import { CoinSDKType } from "../../types/proto-interfaces/cosmos/base/v1beta1/coin";
import { claimExpirationReasonFromJSON } from "../../client/poktroll/tokenomics/event";
import { ClaimExpirationReasonSDKType } from "../../types/proto-interfaces/poktroll/tokenomics/event";

function parseAttribute(attribute: unknown): string {
  return (attribute as string).replaceAll('"', '')
}
export async function handleEventClaimSettled(event: CosmosEvent): Promise<void> {
  logger.debug(`[handleEventClaimSettled] event.attributes: ${stringify(event.event.attributes, undefined,2 )}`);

  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  let claim: ClaimSDKType = {}, proofRequirement: ProofRequirementReason = ProofRequirementReason.NOT_REQUIRED, numRelays = BigInt(0), numClaimedComputedUnits = BigInt(0), numEstimatedComputedUnits = BigInt(0), claimed: CoinSDKType = {};

  for (const attribute of event.event.attributes) {
    if (attribute.key === 'claim') {
      claim = JSON.parse(attribute.value as string)
    }

    if (attribute.key === 'num_relays') {
      numRelays = BigInt(parseAttribute(attribute.value))
    }

    if (attribute.key === 'num_claimed_computed_units') {
      numClaimedComputedUnits = BigInt(parseAttribute(attribute.value))
    }

    if (attribute.key === 'num_estimated_computed_units') {
      numEstimatedComputedUnits = BigInt(parseAttribute(attribute.value))
    }

    if (attribute.key === 'claimed') {
      claimed = JSON.parse(attribute.value as string)
    }

    if (attribute.key === 'proof_requirement') {
      switch (proofRequirementReasonFromJSON(parseAttribute(attribute.value))) {
        case ProofRequirementReasonSDKType.THRESHOLD:
          proofRequirement = ProofRequirementReason.THRESHOLD
          break;
        case ProofRequirementReasonSDKType.NOT_REQUIRED:
          proofRequirement = ProofRequirementReason.NOT_REQUIRED
          break;
        case ProofRequirementReasonSDKType.PROBABILISTIC:
          proofRequirement = ProofRequirementReason.PROBABILISTIC
          break;
        default: {
          throw new Error(`Unknown ProofRequirementReason: ${attribute.value}`)
        }
      }
    }
  }

  const {session_header, supplier_operator_address, root_hash} = claim

  const id = getRelayId({
    applicationId: session_header?.application_address || '',
    supplierId: supplier_operator_address,
    serviceId: session_header?.service_id || '',
    sessionId: session_header?.session_id || '',
  });

  const shared = {
    supplierId: supplier_operator_address,
    applicationId: session_header?.application_address || '',
    serviceId: session_header?.service_id || '',
    sessionId: session_header?.session_id || '',
    sessionStartHeight: BigInt(session_header?.session_start_block_height?.toString() || 0),
    sessionEndHeight: BigInt(session_header?.session_end_block_height?.toString() || 0),
    rootHash: stringify(root_hash),
    numRelays,
    numClaimedComputedUnits,
    numEstimatedComputedUnits,
    claimed: {
      amount: claimed?.amount || '',
      denom: claimed?.denom || '',
    },
    transactionId: event.tx?.hash,
    blockId: event.block.block.id,
  } as const

  const relay = await Relay.get(id)

  await Promise.all([
    Relay.create({
      ...relay,
      ...shared,
      id,
      status: 1,
      eventClaimSettledId: getEventId(event),
    }).save(),
    EventClaimSettled.create({
      ...shared,
      id: getEventId(event),
      proofRequirement
    }).save()
  ])
}

export async function handleEventClaimExpired(event: CosmosEvent): Promise<void> {
  logger.debug(`[handleEventClaimExpired] event.attributes: ${stringify(event.event.attributes, undefined,2 )}`);

  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  let claim: ClaimSDKType = {}, expirationReason: ClaimExpirationReason = ClaimExpirationReason.EXPIRATION_REASON_UNSPECIFIED, numRelays = BigInt(0), numClaimedComputedUnits = BigInt(0), numEstimatedComputedUnits = BigInt(0), claimed: CoinSDKType = {};

  for (const attribute of event.event.attributes) {
    if (attribute.key === 'claim') {
      claim = JSON.parse(attribute.value as string)
    }

    if (attribute.key === 'num_relays') {
      numRelays = BigInt(parseAttribute(attribute.value))
    }

    if (attribute.key === 'num_claimed_computed_units') {
      numClaimedComputedUnits = BigInt(parseAttribute(attribute.value))
    }

    if (attribute.key === 'num_estimated_computed_units') {
      numEstimatedComputedUnits = BigInt(parseAttribute(attribute.value))
    }

    if (attribute.key === 'claimed') {
      claimed = JSON.parse(attribute.value as string)
    }

    if (attribute.key === 'proof_requirement') {
      switch (claimExpirationReasonFromJSON(parseAttribute(attribute.value))) {
        case ClaimExpirationReasonSDKType.EXPIRATION_REASON_UNSPECIFIED:
          expirationReason = ClaimExpirationReason.EXPIRATION_REASON_UNSPECIFIED
          break;
        case ClaimExpirationReasonSDKType.PROOF_INVALID:
          expirationReason = ClaimExpirationReason.PROOF_INVALID
          break;
        case ClaimExpirationReasonSDKType.PROOF_MISSING:
          expirationReason = ClaimExpirationReason.PROOF_MISSING
          break;
        default: {
          throw new Error(`Unknown ClaimExpirationReason: ${attribute.value}`)
        }
      }
    }
  }

  const {root_hash, session_header, supplier_operator_address} = claim

  const id = getRelayId({
    applicationId: session_header?.application_address || '',
    supplierId: supplier_operator_address,
    serviceId: session_header?.service_id || '',
    sessionId: session_header?.session_id || '',
  });

  const shared = {
    supplierId: supplier_operator_address,
    applicationId: session_header?.application_address || '',
    serviceId: session_header?.service_id || '',
    sessionId: session_header?.session_id || '',
    sessionStartHeight: BigInt(session_header?.session_start_block_height?.toString() || 0),
    sessionEndHeight: BigInt(session_header?.session_end_block_height?.toString() || 0),
    rootHash: stringify(root_hash),
    numRelays,
    numClaimedComputedUnits,
    numEstimatedComputedUnits,
    claimed: {
      amount: claimed?.amount || '',
      denom: claimed?.denom || '',
    },
    transactionId: event.tx?.hash,
    blockId: event.block.block.id,
  } as const

  const relay = await Relay.get(id)

  await Promise.all([
    Relay.create({
      ...relay,
      ...shared,
      id,
      eventClaimExpiredId: getEventId(event),
      status: 2
    }).save(),
    EventClaimExpired.create({
      ...shared,
      id: getEventId(event),
      expirationReason,
    }).save()
  ])
}

export async function handleMsgCreateClaim(msg: CosmosMessage<MsgCreateClaim>): Promise<void> {
  logger.debug(`[handleMsgCreateClaim] msg.msg: ${stringify(msg.msg, undefined,2 )}`);

  const {rootHash, sessionHeader, supplierOperatorAddress} = msg.msg.decodedMsg;

  const applicationId = sessionHeader?.applicationAddress || '';
  const serviceId = sessionHeader?.serviceId || '';
  const sessionId = sessionHeader?.sessionId || '';

  const id = getRelayId({
    applicationId,
    supplierId: supplierOperatorAddress,
    serviceId,
    sessionId,
  });

  const shared  = {
    supplierId: supplierOperatorAddress,
    applicationId,
    serviceId,
    sessionId,
    sessionStartHeight: BigInt(sessionHeader?.sessionStartBlockHeight?.toString() || 0),
    sessionEndHeight: BigInt(sessionHeader?.sessionEndBlockHeight?.toString() || 0),
    rootHash: stringify(rootHash),
    transactionId: msg.tx.hash,
    blockId: msg.block.block.id,
  }

  await Promise.all([
    MsgCreateClaimEntity.create({
      id: messageId(msg),
      ...shared,
    }).save(),
    Relay.create({
      id,
      ...shared,
      status: 0,
      msgCreateClaimId: messageId(msg),
    }).save()
  ])
}

export async function handleEventClaimCreated(event: CosmosEvent): Promise<void> {
  logger.debug(`[handleEventClaimCreated] event.attributes: ${stringify(event.event.attributes, undefined,2 )}`);

  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  let claim: ClaimSDKType = {}, numRelays = BigInt(0), numClaimedComputedUnits = BigInt(0), numEstimatedComputedUnits = BigInt(0), claimed: CoinSDKType = {};

  for (const attribute of event.event.attributes) {
    if (attribute.key === 'claim') {
      claim = JSON.parse(attribute.value as string)
    }

    if (attribute.key === 'num_relays') {
      numRelays = BigInt(parseAttribute(attribute.value))
    }

    if (attribute.key === 'num_claimed_computed_units') {
      numClaimedComputedUnits = BigInt(parseAttribute(attribute.value))
    }

    if (attribute.key === 'num_estimated_computed_units') {
      numEstimatedComputedUnits = BigInt(parseAttribute(attribute.value))
    }

    if (attribute.key === 'claimed') {
      claimed = JSON.parse(attribute.value as string)
    }
  }

  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  const {root_hash, session_header, supplier_operator_address, } = claim

  const id = getRelayId({
    applicationId: session_header?.application_address || '',
    supplierId: supplier_operator_address,
    serviceId: session_header?.service_id || '',
    sessionId: session_header?.session_id || '',
  });

  const relay = await Relay.get(id)

  const shared = {
    supplierId: supplier_operator_address,
    applicationId: session_header?.application_address || '',
    serviceId: session_header?.service_id || '',
    sessionId: session_header?.session_id || '',
    sessionStartHeight: BigInt(session_header?.session_start_block_height?.toString() || 0),
    sessionEndHeight: BigInt(session_header?.session_end_block_height?.toString() || 0),
    rootHash: stringify(root_hash),
    numRelays,
    numClaimedComputedUnits,
    numEstimatedComputedUnits,
    claimed: {
      amount: claimed?.amount || '',
      denom: claimed?.denom || '',
    },
    transactionId: event.tx?.hash,
    blockId: event.block.block.id,
  }

  await Promise.all([
    Relay.create({
      ...relay,
      ...shared,
      id,
      status: 0,
      eventClaimCreatedId: getEventId(event),
    }).save(),
    EventClaimCreated.create({
      id: getEventId(event),
      ...shared,
    }).save()
  ])
}

export async function handleEventClaimUpdated(event: CosmosEvent): Promise<void> {
  logger.debug(`[handleEventClaimUpdated] event.attributes: ${stringify(event.event.attributes, undefined,2 )}`);

  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  let claim: ClaimSDKType = {}, numRelays = BigInt(0), numClaimedComputedUnits = BigInt(0), numEstimatedComputedUnits = BigInt(0), claimed: CoinSDKType = {};

  for (const attribute of event.event.attributes) {
    if (attribute.key === 'claim') {
      claim = JSON.parse(attribute.value as string)
    }

    if (attribute.key === 'num_relays') {
      numRelays = BigInt(parseAttribute(attribute.value))
    }

    if (attribute.key === 'num_claimed_computed_units') {
      numClaimedComputedUnits = BigInt(parseAttribute(attribute.value))
    }

    if (attribute.key === 'num_estimated_computed_units') {
      numEstimatedComputedUnits = BigInt(parseAttribute(attribute.value))
    }

    if (attribute.key === 'claimed') {
      claimed = JSON.parse(attribute.value as string)
    }
  }

  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  const {root_hash, session_header, supplier_operator_address, } = claim

  const id = getRelayId({
    applicationId: session_header?.application_address || '',
    supplierId: supplier_operator_address,
    serviceId: session_header?.service_id || '',
    sessionId: session_header?.session_id || '',
  });

  const shared  = {
    supplierId: supplier_operator_address,
    applicationId: session_header?.application_address || '',
    serviceId: session_header?.service_id || '',
    sessionId: session_header?.session_id || '',
    sessionStartHeight: BigInt(session_header?.session_start_block_height?.toString() || 0),
    sessionEndHeight: BigInt(session_header?.session_end_block_height?.toString() || 0),
    rootHash: stringify(root_hash),
    numRelays,
    numClaimedComputedUnits,
    numEstimatedComputedUnits,
    claimed: {
      amount: claimed?.amount || '',
      denom: claimed?.denom || '',
    },
    transactionId: event.tx?.hash,
    blockId: event.block.block.id,
  } as const

  const relay = await Relay.get(id)

  await Promise.all([
    Relay.create({
      ...relay,
      ...shared,
      id,
      status: 0,
    }).save(),
    EventClaimUpdated.create({
      ...shared,
      id: getEventId(event),
      relayId: id,
    }).save()
  ])
}

export async function handleMsgSubmitProof(msg: CosmosMessage<MsgSubmitProof>): Promise<void> {
  logger.debug(`[handleMsgSubmitProof] msg.msg: ${stringify(msg.msg, undefined,2 )}`);

  const { proof, sessionHeader, supplierOperatorAddress,} = msg.msg.decodedMsg

  const applicationId = sessionHeader?.applicationAddress || '';
  const serviceId = sessionHeader?.serviceId || '';
  const sessionId = sessionHeader?.sessionId || '';

  const id = getRelayId({
    applicationId,
    supplierId: supplierOperatorAddress,
    serviceId,
    sessionId,
  });

  const shared = {
    id,
    applicationId,
    supplierId: supplierOperatorAddress,
    sessionId,
    serviceId,
    transactionId: msg.tx.hash,
    blockId: msg.block.block.id,
    sessionEndHeight: BigInt(sessionHeader?.sessionEndBlockHeight?.toString() || 0),
    sessionStartHeight: BigInt(sessionHeader?.sessionStartBlockHeight?.toString() || 0),
  }

  const relay = await Relay.get(id)

  await Promise.all([
    MsgSubmitProofEntity.create({
      ...shared,
      proof: stringify(proof),
    }).save(),
    Relay.create({
      ...relay,
      ...shared,
      id,
      status: 0,
      msgSubmitProofId: id,
    }).save()
  ])
}

export async function handleEventProofSubmitted(event: CosmosEvent): Promise<void> {
  logger.debug(`[EventProofSubmitted] event.attributes: ${stringify(event.event.attributes, undefined,2 )}`);

  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  let proof: ProofSDKType = {}, claim: ClaimSDKType = {}, numRelays = BigInt(0), numClaimedComputedUnits = BigInt(0), numEstimatedComputedUnits = BigInt(0), claimed: CoinSDKType = {};

  for (const attribute of event.event.attributes) {
    if (attribute.key === 'proof') {
      proof = JSON.parse(attribute.value as string)
    }

    if (attribute.key === 'claim') {
      claim = JSON.parse(attribute.value as string)
    }

    if (attribute.key === 'num_relays') {
      numRelays = BigInt(parseAttribute(attribute.value))
    }

    if (attribute.key === 'num_claimed_computed_units') {
      numClaimedComputedUnits = BigInt(parseAttribute(attribute.value))
    }

    if (attribute.key === 'num_estimated_computed_units') {
      numEstimatedComputedUnits = BigInt(parseAttribute(attribute.value))
    }

    if (attribute.key === 'claimed') {
      claimed = JSON.parse(attribute.value as string)
    }
  }

  const {root_hash, session_header, supplier_operator_address, } = claim

  const shared = {
    supplierId: supplier_operator_address,
    applicationId: session_header?.application_address || '',
    serviceId: session_header?.service_id || '',
    sessionId: session_header?.session_id || '',
    sessionStartHeight: BigInt(session_header?.session_start_block_height?.toString() || 0),
    sessionEndHeight: BigInt(session_header?.session_end_block_height?.toString() || 0),
    rootHash: stringify(root_hash),
    numRelays,
    numClaimedComputedUnits,
    numEstimatedComputedUnits,
    claimed: {
      amount: claimed?.amount || '',
      denom: claimed?.denom || '',
    },
    transactionId: event.tx?.hash,
    blockId: event.block.block.id,
  } as const

  const id = getRelayId({
    applicationId: session_header?.application_address || '',
    supplierId: supplier_operator_address,
    serviceId: session_header?.service_id || '',
    sessionId: session_header?.session_id || '',
  })

  const relay = await Relay.get(id)

  await Promise.all([
    EventProofSubmitted.create({
      id: getEventId(event),
      ...shared,
      closestMerkleProof: proof ? stringify(proof.closest_merkle_proof) : undefined,
    }).save(),
    Relay.create({
      id,
      ...relay,
      ...shared,
      status: 0,
      eventProofSubmittedId: getEventId(event),
    })
  ])
}

export async function handleEventProofUpdated(event: CosmosEvent): Promise<void> {
  logger.debug(`[EventProofSubmitted] event.attributes: ${stringify(event.event.attributes, undefined,2 )}`);

  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  let proof: ProofSDKType = {}, claim: ClaimSDKType = {}, numRelays = BigInt(0), numClaimedComputedUnits = BigInt(0), numEstimatedComputedUnits = BigInt(0), claimed: CoinSDKType = {};

  for (const attribute of event.event.attributes) {
    if (attribute.key === 'proof') {
      proof = JSON.parse(attribute.value as string)
    }

    if (attribute.key === 'claim') {
      claim = JSON.parse(attribute.value as string)
    }

    if (attribute.key === 'num_relays') {
      numRelays = BigInt(parseAttribute(attribute.value))
    }

    if (attribute.key === 'num_claimed_computed_units') {
      numClaimedComputedUnits = BigInt(parseAttribute(attribute.value))
    }

    if (attribute.key === 'num_estimated_computed_units') {
      numEstimatedComputedUnits = BigInt(parseAttribute(attribute.value))
    }

    if (attribute.key === 'claimed') {
      claimed = JSON.parse(attribute.value as string)
    }
  }

  const {root_hash, session_header, supplier_operator_address, } = claim

  const shared = {
    supplierId: supplier_operator_address,
    applicationId: session_header?.application_address || '',
    serviceId: session_header?.service_id || '',
    sessionId: session_header?.session_id || '',
    sessionStartHeight: BigInt(session_header?.session_start_block_height?.toString() || 0),
    sessionEndHeight: BigInt(session_header?.session_end_block_height?.toString() || 0),
    rootHash: stringify(root_hash),
    numRelays,
    numClaimedComputedUnits,
    numEstimatedComputedUnits,
    claimed: {
      amount: claimed?.amount || '',
      denom: claimed?.denom || '',
    },
    transactionId: event.tx?.hash,
    blockId: event.block.block.id,
  } as const


  const id = getRelayId({
    applicationId: session_header?.application_address || '',
    supplierId: supplier_operator_address,
    serviceId: session_header?.service_id || '',
    sessionId: session_header?.session_id || '',
  })

  const relay = await Relay.get(id)

  await Promise.all([
    EventProofUpdated.create({
      id: getEventId(event),
      ...shared,
      closestMerkleProof: proof ? stringify(proof.closest_merkle_proof) : undefined,
      relayId: id,
    }).save(),
    Relay.create({
      id,
      ...relay,
      ...shared,
      status: 0,
    })
  ])
}
