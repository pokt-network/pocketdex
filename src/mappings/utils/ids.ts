import {
  CosmosEvent,
  CosmosMessage,
} from "@subql/types-cosmos";
import { FakeTxType } from "../types/genesis";

// messageId returns the id of the message passed or
// that of the message which generated the event passed.
export function messageId(msg: CosmosMessage | CosmosEvent): string {
  return `${msg.tx.hash}-${msg.idx}`;
}

// getEventId returns the id of the event passed.
// Use this to get the id of the events across the indexing process.
export function getEventId(event: CosmosEvent): string {
  return `${event.tx?.hash || event.block.block.id}-${event.idx}`;
}

// getBalanceId returns the id of the Balance entity using the address and denom passed.
// Use this to get the id of the Balance entities across the indexing process.
export function getBalanceId(address: string, denom: string): string {
  return `${address}-${denom}`;
}

// Returns the id of the param entity using the key and blockId passed.
export function getParamId(key: string, blockId: string): string {
  return `${key}-${blockId}`;
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
supplierId
}: {
  serviceId: string,
  applicationId: string,
  supplierId: string,
  sessionId: string,
}): string {
  return `${supplierId}-${applicationId}-${serviceId}-${sessionId}`;
}
