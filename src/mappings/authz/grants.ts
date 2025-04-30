import { CosmosEvent, CosmosMessage } from "@subql/types-cosmos";
import { GenericAuthorization } from "cosmjs-types/cosmos/authz/v1beta1/authz";
import { MsgGrant } from "cosmjs-types/cosmos/authz/v1beta1/tx";
import { AuthzProps } from "../../types/models/Authz";
import { getAuthzId, getBlockId, getEventId } from "../utils/ids";
import { isEventOfFinalizedBlockKind, isEventOfMessageKind } from "../utils/primitives";

function parseAttribute(attribute: unknown): string {
  return (attribute as string).replaceAll("\"", "");
}

function _handleEventGrant(event: CosmosEvent): AuthzProps {
  let granter: string | null = null;
  let grantee: string | null = null;
  let msgTypeUrl: string | null = null;

  for (const attribute of event.event.attributes) {
    if (attribute.key === "granter") {
      granter = parseAttribute(attribute.value);
    } else if (attribute.key === "grantee") {
      grantee = parseAttribute(attribute.value);
    } else if (attribute.key === "msg_type_url") {
      msgTypeUrl = parseAttribute(attribute.value);
    }
  }

  if (!granter) {
    throw new Error(`[handleEventGrant] granter not found in event`);
  }

  if (!grantee) {
    throw new Error(`[handleEventGrant] grantee not found in event`);
  }

  if (!msgTypeUrl) {
    throw new Error(`[handleEventGrant] msgTypeUrl not found in event`);
  }

  return {
    id: getAuthzId(
      granter,
      msgTypeUrl,
      grantee,
    ),
    eventId: getEventId(event),
    granterId: granter,
    granteeId: grantee,
    msg: msgTypeUrl,
    type: "cosmos.authz.v1beta1.EventGrant",
    blockId: getBlockId(event.block),
  };
}

function _handleMsgGrant(msg: CosmosMessage<MsgGrant>): AuthzProps {
  const {grant, grantee, granter} = msg.msg.decodedMsg;

  const msgType = GenericAuthorization.decode(grant.authorization!.value).msg
  const expiration = grant.expiration ? new Date(Number(grant.expiration.seconds) * 1000 + Math.floor(grant.expiration.nanos / 1_000_000)) : undefined
  const event = msg.block.events.find(e => e.event.type === '' && isEventOfMessageKind(e) && e.tx.hash === msg.tx.hash)!


  return {
    id: getAuthzId(
      granter,
      msgType,
      grantee,
    ),
    type: grant.authorization!.typeUrl,
    msg: msgType,
    blockId: getBlockId(msg.block),
    granterId: granter,
    granteeId: grantee,
    eventId: getEventId(event),
    expiration,
  }
}

export async function handleEventGrant(events: CosmosEvent[]): Promise<void> {
  // only handle the events that are finalized because the non-finalized events are being indexed in the /cosmos.authz.v1beta1.MsgGrant msg handler
  await store.bulkCreate("AuthzEventGrant", events.filter(isEventOfFinalizedBlockKind).map(_handleEventGrant));
}

export async function handleMsgGrant(messages: CosmosMessage[]): Promise<void> {
  await store.bulkCreate("Authz", messages.map(_handleMsgGrant));
}
