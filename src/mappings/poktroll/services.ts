import { CosmosMessage } from "@subql/types-cosmos";
import {
  MsgAddService as MsgAddServiceEntity,
  Service,
} from "../../types";
import { MsgAddService } from "../../types/proto-interfaces/poktroll/service/tx";
import {
  attemptHandling,
  unprocessedMsgHandler,
} from "../utils/handlers";
import { messageId } from "../utils/ids";
import { stringify } from "../utils/json";

export async function handleMsgAddService(
  msg: CosmosMessage<MsgAddService>,
): Promise<void> {
  await attemptHandling(msg, _handleMsgAddService, unprocessedMsgHandler);
}

async function _handleMsgAddService(
  msg: CosmosMessage<MsgAddService>,
) {
  logger.debug(`[handleMsgAddService] (msg.msg): ${stringify(msg.msg, undefined, 2)}`);

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
      blockId: msg.block.block.id,
      transactionId: msg.tx.hash,
      messageId: msgId,
    }).save(),
  ]);
}
