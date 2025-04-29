import util from "util";
import { CosmosMessage } from "@subql/types-cosmos";
import allModuleTypes from "../../cosmjs/proto";
import { AuthzExecProps } from "../../types/models/AuthzExec";
import { AuthzMsgExecProps } from "../../types/models/AuthzMsgExec";
import { MessageProps } from "../../types/models/Message";
import { MorseClaimableAccountProps } from "../../types/models/MorseClaimableAccount";
import { MsgImportMorseClaimableAccountsProps } from "../../types/models/MsgImportMorseClaimableAccounts";
import { ParamProps } from "../../types/models/Param";
import { handleMsgImportMorseClaimableAccounts } from "../pocket/migration";
import { _handleUpdateParam } from "../pocket/params";
import { AuthzExecMsg } from "../types";
import {
  getBlockId,
  messageId,
} from "../utils/ids";
import { stringify } from "../utils/json";

// This is required for the binary reader to work. It expects TextEncoder and TextDecoder to be set in globalThis.
globalThis.TextEncoder = util.TextEncoder;
globalThis.TextDecoder = util.TextDecoder;

type HandleAuthzExecResult = {
  messages: Array<MessageProps>;
  authzExec: Array<AuthzExecProps>;
  authzExecMsgs: Array<AuthzMsgExecProps>;
  params: Array<ParamProps>;
  msgImportMorseClaimableAccounts: Array<MsgImportMorseClaimableAccountsProps>;
  morseClaimableAccount: Array<MorseClaimableAccountProps>;
}

function _handleAuthzExec(msg: CosmosMessage<AuthzExecMsg>): HandleAuthzExecResult {
  const blockId = getBlockId(msg.block);

  const result: HandleAuthzExecResult = {
    messages: [],
    authzExec: [],
    authzExecMsgs: [],
    params: [],
    msgImportMorseClaimableAccounts: [],
    morseClaimableAccount: [],
  };

  const authzExecId = messageId(msg);
  const typeUrl = msg.msg.typeUrl;
  const decodedAuthzMsg = msg.msg.decodedMsg;
  const grantee = decodedAuthzMsg.grantee;
  const msgs = decodedAuthzMsg.msgs;

  result.messages.push({
    id: authzExecId,
    idx: msg.idx,
    typeUrl,
    json: stringify(msg.msg.decodedMsg),
    transactionId: msg.tx.hash,
    blockId,
  });

  result.authzExec.push({
    id: authzExecId,
    grantee,
    messageId: authzExecId,
    transactionId: msg.tx.hash,
    blockId,
  });

  for (const [i, encodedMsg] of msgs.entries()) {

    let decodedMsg: unknown;

    if (encodedMsg.typeUrl === "/pocket.migration.MsgImportMorseClaimableAccounts") {
      const response = handleMsgImportMorseClaimableAccounts({
        encodedMsg,
        blockId,
        transactionId: msg.tx.hash,
        messageId: authzExecId,
      })

      decodedMsg = response.decodedMsg;
      result.morseClaimableAccount.push(...response.morseClaimableAccounts);
      result.msgImportMorseClaimableAccounts.push(response.msgImportMorseClaimableAccounts);
    } else {
      // _handleUpdateParam will return the decoded message if it is a param update,
      // otherwise it will return undefined.
      // _handleUpdateParam will decode and save the message using its specific entity
      const paramResult = _handleUpdateParam(encodedMsg, blockId);

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
    }

    if (decodedMsg) {
      const subMsgId = `${authzExecId}-${i}`;

      // Create a primitive message entity for a sub-message
      result.messages.push({
        id: subMsgId,
        idx: msg.idx,
        typeUrl,
        json: stringify(decodedMsg),
        transactionId: msg.tx.hash,
        blockId,
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
    msgImportMorseClaimableAccounts: [],
    morseClaimableAccount: [],
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
    if (r.msgImportMorseClaimableAccounts.length > 0) {
      allResults.msgImportMorseClaimableAccounts.push(...r.msgImportMorseClaimableAccounts);
    }
    if (r.morseClaimableAccount.length > 0) {
      allResults.morseClaimableAccount.push(...r.morseClaimableAccount);
    }
  }

  await Promise.all([
    store.bulkCreate("Message", allResults.messages),
    store.bulkCreate("AuthzExec", allResults.authzExec),
    store.bulkCreate("AuthzMsgExec", allResults.authzExecMsgs),
    store.bulkCreate("Param", allResults.params),
    store.bulkCreate("MsgImportMorseClaimableAccounts", allResults.msgImportMorseClaimableAccounts),
    store.bulkCreate("MorseClaimableAccount", allResults.morseClaimableAccount),
  ]);
}
