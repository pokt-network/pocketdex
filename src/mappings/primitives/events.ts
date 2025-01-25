import {
  CosmosEvent,
  CosmosMessage,
} from "@subql/types-cosmos";
import { EventProps } from "../../types/models/Event";
import { PREFIX } from "../constants";
import {
  getBlockIdAsString,
  getEventId,
  messageId,
} from "../utils/ids";
import { sanitize } from "../utils/json";
import {
  getEventKind,
  getNonFirstBlockEvents,
  hasValidAmountAttribute,
  isEventOfMessageKind,
} from "../utils/primitives";

function _handleEvent(event: CosmosEvent): EventProps {
  const attributes = event.event.attributes.map((attribute) => {
    const { key, value } = attribute;
    // sanitize attribute values (may contain non-text characters)
    return { key: key as string, value: sanitize(value) };
  });

  return {
    id: getEventId(event),
    type: event.event.type,
    kind: getEventKind(event),
    attributes,
    transactionId: event.tx?.hash,
    messageId: isEventOfMessageKind(event) ? messageId(event.msg as CosmosMessage) : undefined,
    blockId: getBlockIdAsString(event.block),
  };
}

// handleEvents, referenced in project.ts, handles events and store as is in case we need to use them on a migration
export async function handleEvents(events: CosmosEvent[]): Promise<void> {
  const moduleAccounts = new Set((await cache.get("moduleAccounts") ?? []));
  const filteredEvents = getNonFirstBlockEvents(events).filter(
    // event type message is not worth save
    evt => hasValidAmountAttribute(evt) && evt.event.type !== "message",
  ).filter(evt => !evt.event.attributes.some(attr => (attr.value as string).startsWith(PREFIX) && moduleAccounts.has(attr.value as string)));

  if (filteredEvents.length === 0) return;
  await store.bulkCreate(
    "Event",
    filteredEvents.map(evt => _handleEvent(evt)),
  );
}
