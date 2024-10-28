import { CosmosMessage } from "@subql/types-cosmos";
import { AddServiceMsg, Service } from "../../types";
import { MsgAddService } from "../../types/proto-interfaces/poktroll/service/tx";
import { attemptHandling, messageId, stringify, unprocessedMsgHandler } from "../utils";

export async function handleMsgAddService(
  msg: CosmosMessage<MsgAddService>
): Promise<void> {
  await attemptHandling(msg, _handleMsgAddService, unprocessedMsgHandler);
}

async function _handleMsgAddService(
  msg: CosmosMessage<MsgAddService>
) {
  logger.debug(`[handleMsgAddService] (msg.msg): ${stringify(msg.msg, undefined, 2)}`);

  // TODO(@Alann27): the owner can change the ownerAddress inside the service field?
  const {ownerAddress, service: {computeUnitsPerRelay, id, name, ownerAddress: owner}} = msg.msg.decodedMsg

  await Promise.all([
    Service.create({
      id,
      // TODO(@Alann27): change this to bigInt?
      computeUnitsPerRelay: Number(computeUnitsPerRelay.toString()),
      name,
      // TODO(@Alann27): see which one is correct
      ownerId: ownerAddress || owner,
    }).save(),
    AddServiceMsg.create({
      id: messageId(msg),
      name,
      ownerId: ownerAddress || owner,
      serviceId: id,
      computeUnitsPerRelay: Number(computeUnitsPerRelay.toString()),
    }).save()
  ])
}
