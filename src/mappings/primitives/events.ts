import {
  CosmosEvent,
  CosmosMessage,
} from "@subql/types-cosmos";
import { EventProps } from "../../types/models/Event";
import { optimizedBulkCreate } from "../utils/db";
import {
  getBlockId,
  getEventId,
  messageId,
} from "../utils/ids";
import { sanitize } from "../utils/json";
import {
  getEventKind,
  isEventOfMessageKind,
} from "../utils/primitives";


function _handleEvent(event: CosmosEvent): EventProps {
  const id = getEventId(event);
  const kind = getEventKind(event);
  const attributes = event.event.attributes.map((attribute) => {
    const { key, value } = attribute;
    // sanitize attribute values (may contain non-text characters)
    return { key: key as string, value: sanitize(value) };
  });
  const msgId = isEventOfMessageKind(event) ? messageId(event.msg as CosmosMessage) : undefined;
  const blockId = getBlockId(event.block);
  return {
    id,
    idx: event.idx,
    type: event.event.type,
    kind: kind,
    attributes: attributes,
    transactionId: event.tx?.hash,
    messageId: msgId,
    blockId: blockId,
  };
}

// handleEvents, referenced in project.ts, handles events and store as is in case we need to use them on a migration
export async function handleEvents(events: CosmosEvent[]): Promise<void> {
  // Process Events using the _handleEvent function
  await optimizedBulkCreate("Event", events, 'block_id', _handleEvent);
}
