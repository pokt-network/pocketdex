import { CosmosEvent, CosmosMessage } from "@subql/types-cosmos";
import { omit, orderBy } from "lodash";
import {
  MsgAddService as MsgAddServiceEntity,
  Service,
} from "../../types";
import { EventRelayMiningDifficultyUpdatedProps } from "../../types/models/EventRelayMiningDifficultyUpdated";
import { MsgAddService } from "../../types/proto-interfaces/poktroll/service/tx";
import {
  getBlockId,
  getEventId,
  messageId,
} from "../utils/ids";

async function _handleMsgAddService(
  msg: CosmosMessage<MsgAddService>,
) {
  const { ownerAddress, service: { computeUnitsPerRelay, id, name } } = msg.msg.decodedMsg;

  const units = BigInt(computeUnitsPerRelay.toString());
  const msgId = messageId(msg);

  await Promise.all([
    Service.create({
      id,
      computeUnitsPerRelay: units,
      name,
      ownerId: ownerAddress,
    }).save(),
    MsgAddServiceEntity.create({
      id: msgId,
      name,
      ownerId: ownerAddress,
      serviceId: id,
      computeUnitsPerRelay: units,
      blockId: getBlockId(msg.block),
      transactionId: msg.tx.hash,
      messageId: msgId,
    }).save(),
  ]);
}

// we are returning the idx because we need it to get the latest event per service
// to update the relay mining difficulty of the service entity
function _handleEventRelayMiningDifficultyUpdated(event: CosmosEvent): EventRelayMiningDifficultyUpdatedProps & {idx: number} {
  let serviceId = '',
    prevTargetHashHexEncoded = '',
    newTargetHashHexEncoded = '',
    prevNumRelaysEma: bigint | null = null,
    newNumRelaysEma: bigint | null = null;

  for (const attribute of event.event.attributes) {
    const value = (attribute.value as string).replaceAll('"', '')

    if (attribute.key === "service_id") {
      serviceId = value
    }

    if (attribute.key === "prev_target_hash_hex_encoded") {
      prevTargetHashHexEncoded = value
    }

    if (attribute.key === "new_target_hash_hex_encoded") {
      newTargetHashHexEncoded = value
    }

    if (attribute.key === "prev_num_relays_ema") {
      prevNumRelaysEma = BigInt(value)
    }

    if (attribute.key === "new_num_relays_ema") {
      newNumRelaysEma = BigInt(value)
    }
  }

  if (!serviceId) {
    throw new Error(`[handleEventRelayMiningDifficultyUpdated] serviceId not found in event`);
  }

  if (!prevTargetHashHexEncoded) {
    throw new Error(`[handleEventRelayMiningDifficultyUpdated] prevTargetHashHexEncoded not found in event`);
  }

  if (!newTargetHashHexEncoded) {
    throw new Error(`[handleEventRelayMiningDifficultyUpdated] newTargetHashHexEncoded not found in event`);
  }

  if (!prevNumRelaysEma) {
    throw new Error(`[handleEventRelayMiningDifficultyUpdated] prevNumRelaysEma not found in event`);
  }

  if (!newNumRelaysEma) {
    throw new Error(`[handleEventRelayMiningDifficultyUpdated] newNumRelaysEma not found in event`);
  }

  const eventId = getEventId(event)

  return {
    id: eventId,
    serviceId,
    prevTargetHashHexEncoded,
    newTargetHashHexEncoded,
    prevNumRelaysEma,
    newNumRelaysEma,
    blockId: getBlockId(event.block),
    eventId: eventId,
    idx: event.idx
  }
}

async function _updateRelayMiningDifficultyOfService(relayMiningDifficultyUpdatedProps: EventRelayMiningDifficultyUpdatedProps) {
  const service = await Service.get(relayMiningDifficultyUpdatedProps.serviceId)

  if (!service) {
    throw new Error(`[handleEventRelayMiningDifficultyUpdated] service not found for id ${relayMiningDifficultyUpdatedProps.serviceId}`)
  }

  service.prevTargetHashHexEncoded = relayMiningDifficultyUpdatedProps.prevTargetHashHexEncoded
  service.newTargetHashHexEncoded = relayMiningDifficultyUpdatedProps.newTargetHashHexEncoded
  service.prevNumRelaysEma = relayMiningDifficultyUpdatedProps.prevNumRelaysEma
  service.newNumRelaysEma = relayMiningDifficultyUpdatedProps.newNumRelaysEma

  await service.save()
}

export async function handleMsgAddService(messages: Array<CosmosMessage<MsgAddService>>): Promise<void> {
  await Promise.all(messages.map(_handleMsgAddService));
}

export async function handleEventRelayMiningDifficultyUpdated(events: Array<CosmosEvent>): Promise<void> {
  const relayMiningDifficultyUpdatedEvents = events.map(_handleEventRelayMiningDifficultyUpdated)
  const eventsWithoutIdx: Array<EventRelayMiningDifficultyUpdatedProps> = []

  const eventsGroupedByServiceId = relayMiningDifficultyUpdatedEvents.reduce((acc, event) => {
    const serviceId = event.serviceId

    if (!acc[serviceId]) {
      acc[serviceId] = []
    }

    acc[serviceId].push(event)
    eventsWithoutIdx.push(omit(event, 'idx'))

    return acc
  }, {} as Record<string, Array<EventRelayMiningDifficultyUpdatedProps>>)


  await Promise.all([
    store.bulkCreate("EventRelayMiningDifficultyUpdated", eventsWithoutIdx),
    Object.values(eventsGroupedByServiceId).map(async (eventsOfService) => {
      const sortedEvents = orderBy(eventsOfService, ['idx'], ['asc'])

      await _updateRelayMiningDifficultyOfService(sortedEvents.at(-1)!)
    })
  ])
}
