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
  logger.info(`[handleMsgAddService] (msg.msg): ${stringify(msg.msg, undefined, 2)}`);

  const {ownerAddress, service: {computeUnitsPerRelay, id, name}} = msg.msg.decodedMsg

  const units = BigInt(computeUnitsPerRelay.toString())

  await Promise.all([
    Service.create({
      id,
      computeUnitsPerRelay: units,
      name,
      ownerId: ownerAddress,
    }).save(),
    AddServiceMsg.create({
      id: messageId(msg),
      name,
      ownerId: ownerAddress,
      serviceId: id,
      computeUnitsPerRelay: units,
      blockId: msg.block.block.id,
      transactionId: msg.tx.hash,
    }).save()
  ])
}
