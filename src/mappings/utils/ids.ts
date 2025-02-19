import crypto from "crypto";
import {
  CosmosBlock,
  CosmosEvent,
  CosmosMessage,
} from "@subql/types-cosmos";
import { FakeTxType } from "../types/genesis";

// We decide to make the block ID as the height, which is easier to follow on the graph/db
// in any case we save the id(hash) as another property
export function getBlockId(block: CosmosBlock): bigint {
  return BigInt(block.block.header.height);
}

// Relationship properties are still a string.
export function getBlockIdAsString(block: CosmosBlock): string {
  return getBlockId(block).toString();
}

// messageId returns the id of the message passed or
// that of the message which generated the event passed.
export function messageId(msg: CosmosMessage | CosmosEvent): string {
  return `${msg.tx?.hash}-${msg.idx}`;
}

// getEventId returns the id of the event passed.
// Use this to get the id of the events across the indexing process.
export function getEventId(event: CosmosEvent): string {
  return `${event.tx?.hash || getBlockIdAsString(event.block)}-${event.kind}-${event.idx}`;
}

// getBalanceId returns the id of the Balance entity using the address and denom passed.
// Use this to get the id of the Balance entities across the indexing process.
export function getBalanceId(address: string, denom: string): string {
  return `${address}-${denom}`;
}

// Returns the id of the param entity using the namespace, key, blockId passed.
export function getParamId(ns: string, key: string, blockId: bigint): string {
  return `${ns}-${key}-${blockId.toString()}`;
}

// Returns the id of the entity that establishes the relationship between the Gateway that the app is being delegated to.
export function getAppDelegatedToGatewayId(appAddress: string, gatewayAddress: string): string {
  return `${appAddress}-${gatewayAddress}`;
}

// Returns a string that satisfies the format of a transaction hash.
export function getGenesisFakeTxHash(entity: FakeTxType, index: number): string {
  const num = index + 1;
  let entityId: string;

  switch (entity) {
    case "app":
      entityId = "A";
      break;
    case "supplier":
      entityId = "B";
      break;
    case "gateway":
      entityId = "C";
      break;
    case "service":
      entityId = "D";
      break;
    case "validator":
      entityId = "E";
      break;
    default: {
      throw new Error("Not implemented");
    }
  }

  return `${"0".repeat(64 - num.toString().length - entityId.length)}${num}${entityId}`;
}

// Returns the id of the entity that establishes the relationship between the MsgStake and Service.
export function getMsgStakeServiceId(msgStakeId: string, serviceId: string): string {
  return `${msgStakeId}-${serviceId}`;
}

// Returns the id of the entity that establishes the relationship between the Entity staked and Service.
export function getStakeServiceId(entityStakedId: string, serviceId: string): string {
  return `${entityStakedId}-${serviceId}`;
}

// Returns the id of the relay for claim and proof
export function getRelayId({
                             applicationId,
                             serviceId,
                             sessionId,
                             supplierId,
                           }: {
  serviceId: string,
  applicationId: string,
  supplierId: string,
  sessionId: string,
}): string {
  return `${supplierId}-${applicationId}-${serviceId}-${sessionId}`;
}

// always the same to ensure we get consistent results
const namespace = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";

/**
 * Generates a deterministic UUID-like string using SHA-1.
 * We need to generate deterministic uuid v4 based on bench32 address to set under the historical `__id` column to avoid
 * historical duplicates for accounts.
 * We are trying to ensure accounts' existence without duplicating them on each block
 *
 * @param {string} name - The input data to hash deterministically.
 * @returns {string} - The generated UUID.
 */
export function generateDeterministicUUID(name: string): string {
  // Validate namespace (must be 36 characters long)
  if (!namespace || namespace.length !== 36) {
    throw new Error("Namespace must be a valid UUID (36 characters long).");
  }

  // Remove dashes from the namespace UUID and convert to bytes
  const namespaceBytes = Buffer.from(namespace.replace(/-/g, ""), "hex");

  // Hash the namespace and name together using SHA-256 for deterministic behavior
  const hash = crypto.createHash("sha256");
  hash.update(namespaceBytes);
  hash.update(name);
  const hashedData = hash.digest();

  // Use the first 16 bytes of the hash for the UUID
  const randomBytes = hashedData.slice(0, 16);

  // Set version to 4 (0100XXXX)
  randomBytes[6] = (randomBytes[6] & 0x0f) | 0x40;

  // Set variant to RFC 4122 (10XXXXXX)
  randomBytes[8] = (randomBytes[8] & 0x3f) | 0x80;

  // Format the bytes into UUID v4 string structure
  return [
    randomBytes.toString("hex", 0, 4),
    randomBytes.toString("hex", 4, 6),
    randomBytes.toString("hex", 6, 8),
    randomBytes.toString("hex", 8, 10),
    randomBytes.toString("hex", 10, 16),
  ].join("-");
}
