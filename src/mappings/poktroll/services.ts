import { CosmosMessage } from "@subql/types-cosmos";
import {
  MsgAddService as MsgAddServiceEntity,
  Service,
} from "../../types";
import { MsgAddService } from "../../types/proto-interfaces/poktroll/service/tx";
import {
  getBlockId,
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

export async function handleMsgAddService(messages: Array<CosmosMessage<MsgAddService>>): Promise<void> {
  await Promise.all(messages.map(_handleMsgAddService));
}
