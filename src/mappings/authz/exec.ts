import util from "util";
import { CosmosMessage } from "@subql/types-cosmos";
import allModuleTypes from "../../cosmjs/proto";
import { AuthzExecProps } from "../../types/models/AuthzExec";
import { AuthzMsgExecProps } from "../../types/models/AuthzMsgExec";
import { MessageProps } from "../../types/models/Message";
import { ParamProps } from "../../types/models/Param";
import { _handleUpdateParam } from "../poktroll/params";
import { AuthzExecMsg } from "../types";
import { messageId } from "../utils/ids";
import { stringify } from "../utils/json";

// This is required for the binary reader to work. It expects TextEncoder and TextDecoder to be set in globalThis.
globalThis.TextEncoder = util.TextEncoder;
globalThis.TextDecoder = util.TextDecoder;

type HandleAuthzExecResult = {
  messages: Array<MessageProps>;
  authzExec: Array<AuthzExecProps>;
  authzExecMsgs: Array<AuthzMsgExecProps>;
  params: Array<ParamProps>;
}

function _handleAuthzExec(msg: CosmosMessage<AuthzExecMsg>): HandleAuthzExecResult {
  logger.info(`[handleAuthzExec] (tx ${msg.tx.hash}): indexing message ${msg.idx + 1} / ${msg.tx.decodedTx.body.messages.length}`);

  const result: HandleAuthzExecResult = {
    messages: [],
    authzExec: [],
    authzExecMsgs: [],
    params: [],
  };

  const authzExecId = messageId(msg);
  const typeUrl = msg.msg.typeUrl;
  const decodedAuthzMsg = msg.msg.decodedMsg;
  const grantee = decodedAuthzMsg.grantee;
  const msgs = decodedAuthzMsg.msgs;

  result.messages.push({
    id: authzExecId,
    typeUrl,
    json: stringify(msg.msg.decodedMsg),
    transactionId: msg.tx.hash,
    blockId: msg.block.block.id,
  });

  result.authzExec.push({
    id: authzExecId,
    grantee,
    messageId: authzExecId,
    transactionId: msg.tx.hash,
    blockId: msg.block.block.id,
  });

  for (const [i, encodedMsg] of msgs.entries()) {
    // _handleUpdateParam will return the decoded message if it is a param update,
    // otherwise it will return undefined.
    // _handleUpdateParam will decode and save the message using its specific entity
    const paramResult = _handleUpdateParam(encodedMsg, msg.block.block.id);

    let decodedMsg: unknown;

    if (!paramResult) {
      for (const [typeUrl, msgType] of allModuleTypes) {

        if (typeUrl === encodedMsg.typeUrl) {
          const bytes = new Uint8Array(Object.values(encodedMsg.value));

          decodedMsg = msgType.decode(bytes);
          break;
        }
      }
    } else {
      decodedMsg = paramResult.decodedMsg;
      result.params.push(...paramResult.params);
    }

    if (decodedMsg) {
      const subMsgId = `${authzExecId}-${i}`;

      // Create a primitive message entity for a sub-message
      result.messages.push({
        id: subMsgId,
        typeUrl,
        json: stringify(decodedMsg),
        transactionId: msg.tx.hash,
        blockId: msg.block.block.id,
      });

      // Create AuthzMsgExec entity to join AuthzExec and Messages without requiring a foreign key in the Message type.
      result.authzExecMsgs.push({
        id: subMsgId,
        authzExecId,
        messageId: subMsgId,
      });
    }
  }

  return result;
}

// handleAuthzExec, referenced in project.ts, handles messages that modify params of any entity
export async function handleAuthzExec(messages: CosmosMessage<AuthzExecMsg>[]): Promise<void> {
  const allResults: HandleAuthzExecResult = {
    messages: [],
    authzExec: [],
    authzExecMsgs: [],
    params: [],
  };

  // merge all the documents to write
  for (const msg of messages) {
    const r = _handleAuthzExec(msg);
    if (r.messages.length > 0) {
      allResults.messages.push(...r.messages);
    }
    if (r.authzExec.length > 0) {
      allResults.authzExec.push(...r.authzExec);
    }
    if (r.authzExecMsgs.length > 0) {
      allResults.authzExecMsgs.push(...r.authzExecMsgs);
    }
    if (r.params.length > 0) {
      allResults.params.push(...r.params);
    }
  }

  await Promise.all([
    store.bulkCreate("Message", allResults.messages),
    store.bulkCreate("AuthzExec", allResults.authzExec),
    store.bulkCreate("AuthzMsgExec", allResults.authzExecMsgs),
    store.bulkCreate("Param", allResults.params),
  ]);
}
