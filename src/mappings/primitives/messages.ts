import { CosmosMessage } from "@subql/types-cosmos";
import { MessageProps } from "../../types/models/Message";
import { optimizedBulkCreate } from "../utils/db";
import {
  getBlockId,
  messageId,
} from "../utils/ids";
import { stringify } from "../utils/json";

function _handleMessage(msg: CosmosMessage): MessageProps {
  delete msg.msg?.decodedMsg?.wasmByteCode;
  return {
    id: messageId(msg),
    typeUrl: msg.msg.typeUrl,
    json: stringify(msg.msg.decodedMsg),
    transactionId: msg.tx.hash,
    blockId: getBlockId(msg.block),
  };
}

// handleMessages, referenced in project.ts, handles messages and store as is in case we need to use them on a migration
export async function handleMessages(msgs: CosmosMessage[]): Promise<void> {
  // Process Messages using the _handleMessage function
  await optimizedBulkCreate("Message", msgs, _handleMessage);
}
