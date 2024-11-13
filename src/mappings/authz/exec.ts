import util from "util";
import {CosmosMessage} from "@subql/types-cosmos";
import allModuleTypes from "../../cosmjs/proto";
import { AuthzExec, AuthzMsgExec, Message } from "../../types";
import { _handleUpdateParam } from "../poktroll/params";
import { AuthzExecMsg } from "../types";
import { attemptHandling, messageId, stringify, unprocessedEventHandler } from "../utils";

// This is required for the binary reader to work. It expects TextEncoder and TextDecoder to be set in globalThis.
globalThis.TextEncoder = util.TextEncoder;
globalThis.TextDecoder = util.TextDecoder;

export async function handleAuthzExec(msg: CosmosMessage<AuthzExecMsg>): Promise<void> {
  await attemptHandling(msg, _handleAuthzExec, unprocessedEventHandler);
}

async function _handleAuthzExec(msg: CosmosMessage<AuthzExecMsg>): Promise<void> {
  logger.info(`[handleAuthzExec] (tx ${msg.tx.hash}): indexing message ${msg.idx + 1} / ${msg.tx.decodedTx.body.messages.length}`);
  logger.debug(`[handleAuthzExec] (msg.msg): ${stringify(msg.msg, undefined, 2)}`);

  const authzExecId = messageId(msg);
  const typeUrl = msg.msg.typeUrl;
  const decodedAuthzMsg = msg.msg.decodedMsg;
  const grantee = decodedAuthzMsg.grantee;
  const msgs = decodedAuthzMsg.msgs;

  await Message.create({
    id: authzExecId,
    typeUrl,
    json: stringify(msg.msg.decodedMsg),
    transactionId: msg.tx.hash,
    blockId: msg.block.block.id,
  }).save();

  await AuthzExec.create({
    id: authzExecId,
    grantee,
    messageId: authzExecId,
    transactionId: msg.tx.hash,
    blockId: msg.block.block.id,
  }).save();

  for (const [i, encodedMsg] of msgs.entries()) {
    //_handleUpdateParam will return the decoded message if it is a param update
    // otherwise it will return undefined.
    //_handleUpdateParam will decode and save the message using its specific entity
    let decodedMsg: unknown = await _handleUpdateParam(encodedMsg, msg.block.block.id)

    if (!decodedMsg) {
      for (const [typeUrl, msgType] of allModuleTypes) {

        if (typeUrl === encodedMsg.typeUrl) {
          const bytes = new Uint8Array(Object.values(encodedMsg.value));

          decodedMsg = msgType.decode(bytes);
          break
        }
      }
    }

    if (decodedMsg) {
      logger.debug(`[handleAuthzExec] msgType: ${typeUrl}, decodedMsg: ${stringify(decodedMsg, undefined, 2)}`);
      const subMsgId = `${authzExecId}-${i}`;

      // Create primitive message entity for sub-message
      await Message.create({
        id: subMsgId,
        typeUrl,
        json: stringify(decodedMsg),
        transactionId: msg.tx.hash,
        blockId: msg.block.block.id,
      }).save();

      /* NB: Create AuthzMsgExec entity to join AuthzExec and Messages
             without requiring a foreign key in Message type.
       */
      await AuthzMsgExec.create({
        id: subMsgId,
        authzExecId,
        messageId: subMsgId,
      }).save();
    }
  }
}

