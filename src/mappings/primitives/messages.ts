import { CosmosMessage } from "@subql/types-cosmos";
import { MessageProps } from "../../types/models/Message";
import {
  getBlockIdAsString,
  messageId,
} from "../utils/ids";
import { stringify } from "../utils/json";

function _handleMessage(msg: CosmosMessage): MessageProps {
  delete msg.msg?.decodedMsg?.wasmByteCode;
  const json = stringify(msg.msg.decodedMsg);
  return {
    id: messageId(msg),
    typeUrl: msg.msg.typeUrl,
    json,
    transactionId: msg.tx.hash,
    blockId: getBlockIdAsString(msg.block),
  };
}

// handleMessages, referenced in project.ts, handles messages and store as is in case we need to use them on a migration
export async function handleMessages(msgs: CosmosMessage[]): Promise<void> {
  await store.bulkCreate("Message", msgs.map(msg => _handleMessage(msg)));
}
