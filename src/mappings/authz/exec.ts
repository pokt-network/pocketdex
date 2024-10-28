import util from "util";
import { BinaryReader } from "@bufbuild/protobuf/wire";
import {CosmosMessage} from "@subql/types-cosmos";
import { MsgUpdateParams as MsgUpdateAuthParams } from "cosmjs-types/cosmos/auth/v1beta1/tx";
import { MsgUpdateParams as MsgUpdateBankParams } from "cosmjs-types/cosmos/bank/v1beta1/tx";
import { MsgUpdateParams as MsgUpdateConsensusParams } from "cosmjs-types/cosmos/consensus/v1/tx";
import { MsgUpdateParams as MsgUpdateDistributionParams } from "cosmjs-types/cosmos/distribution/v1beta1/tx";
import { MsgUpdateParams as MsgUpdateGovParams } from "cosmjs-types/cosmos/gov/v1/tx";
import { MsgUpdateParams as MsgUpdateMintParams } from "cosmjs-types/cosmos/mint/v1beta1/tx";
import { MsgUpdateParams as MsgUpdateSlashingParams } from "cosmjs-types/cosmos/slashing/v1beta1/tx";
import { MsgUpdateParams as MsgUpdateStakingParams } from "cosmjs-types/cosmos/staking/v1beta1/tx";
import { MsgUpdateParam as MsgUpdateApplicationParam,MsgUpdateParams as MsgUpdateApplicationParams } from "../../client/poktroll/application/tx";
import { MsgUpdateParam as MsgUpdateGatewayParam, MsgUpdateParams as MsgUpdateGatewayParams } from "../../client/poktroll/gateway/tx";
import {
  MsgUpdateParam as MsgUpdateProofParam,
  MsgUpdateParams as MsgUpdateProofParams,
} from "../../client/poktroll/proof/tx";
import { MsgUpdateParam as MsgUpdateServiceParam,MsgUpdateParams as MsgUpdateServiceParams } from "../../client/poktroll/service/tx";
import { MsgUpdateParams as MsgUpdateSessionParams } from "../../client/poktroll/session/tx";
import { MsgUpdateParam as MsgUpdateSharedParam, MsgUpdateParams as MsgUpdateSharedParams } from "../../client/poktroll/shared/tx";
import { MsgUpdateParam as MsgUpdateSupplierParam,MsgUpdateParams as MsgUpdateSupplierParams } from "../../client/poktroll/supplier/tx";
import { MsgUpdateParam as MsgUpdateTokenomicsParam, MsgUpdateParams as MsgUpdateTokenomicsParams } from "../../client/poktroll/tokenomics/tx";
import allModuleTypes from "../../cosmjs/proto";
import { AuthzExec, AuthzExecMessage, Message } from "../../types";
import { AppParamProps } from "../../types/models/AppParam";
import { AuthzExecMsg, EncodedMsg } from "../types";
import { attemptHandling, getParamId, messageId, stringify, unprocessedEventHandler } from "../utils";

// This is required for the binary reader to work. It expects TextEncoder and TextDecoder to be set in globalThis.
globalThis.TextEncoder = util.TextEncoder;
globalThis.TextDecoder = util.TextDecoder;

const msgUpdateParamsMap: Record<string, {
  decode(bytes: BinaryReader | Uint8Array | any): unknown
  toJSON(obj: unknown): unknown
}> = {
  '/poktroll.application.MsgUpdateParam': MsgUpdateApplicationParam,
  '/poktroll.application.MsgUpdateParams': MsgUpdateApplicationParams,
  '/poktroll.service.MsgUpdateParam': MsgUpdateServiceParam,
  '/poktroll.service.MsgUpdateParams': MsgUpdateServiceParams,
  '/poktroll.supplier.MsgUpdateParam': MsgUpdateSupplierParam,
  '/poktroll.supplier.MsgUpdateParams': MsgUpdateSupplierParams,
  '/poktroll.gateway.MsgUpdateParam': MsgUpdateGatewayParam,
  '/poktroll.gateway.MsgUpdateParams': MsgUpdateGatewayParams,
  '/poktroll.proof.MsgUpdateParam': MsgUpdateProofParam,
  '/poktroll.proof.MsgUpdateParams': MsgUpdateProofParams,
  '/poktroll.shared.MsgUpdateParam': MsgUpdateSharedParam,
  '/poktroll.shared.MsgUpdateParams': MsgUpdateSharedParams,
  '/poktroll.tokenomics.MsgUpdateParam': MsgUpdateTokenomicsParam,
  '/poktroll.tokenomics.MsgUpdateParams': MsgUpdateTokenomicsParams,
  '/poktroll.session.MsgUpdateParams': MsgUpdateSessionParams,
  "/cosmos.auth.v1beta1.MsgUpdateParams": MsgUpdateAuthParams,
  "/cosmos.bank.v1beta1.MsgUpdateParams": MsgUpdateBankParams,
  "/cosmos.distribution.v1beta1.MsgUpdateParams": MsgUpdateDistributionParams,
  "/cosmos.mint.v1beta1.MsgUpdateParams": MsgUpdateMintParams,
  "/cosmos.slashing.v1beta1.MsgUpdateParams": MsgUpdateSlashingParams,
  "/cosmos.staking.v1beta1.MsgUpdateParams": MsgUpdateStakingParams,
  "/cosmos.consensus.v1.MsgUpdateParams": MsgUpdateConsensusParams,
  "/cosmos.gov.v1.MsgUpdateParams": MsgUpdateGovParams,
}

export async function handleAuthzExec(msg: CosmosMessage<AuthzExecMsg>): Promise<void> {
  await attemptHandling(msg, _handleAuthzExec, unprocessedEventHandler);
}

async function _handleAuthzExec(msg: CosmosMessage<AuthzExecMsg>): Promise<void> {
  logger.info(`[handleAuthzExec] (tx ${msg.tx.hash}): indexing message ${msg.idx + 1} / ${msg.tx.decodedTx.body.messages.length}`);
  logger.info(`[handleAuthzExec] (msg.msg): ${stringify(msg.msg, undefined, 2)}`);

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
    let decodedMsg: unknown;

    if (encodedMsg.typeUrl in msgUpdateParamsMap) {
      decodedMsg = await _handleUpdateParam(encodedMsg, msg.block.block.id)
    } else {
      for (const [typeUrl, msgType] of allModuleTypes) {

        if (typeUrl === encodedMsg.typeUrl) {
          const bytes = new Uint8Array(Object.values(encodedMsg.value));

          decodedMsg = msgType.decode(bytes);
        }
      }
    }

    if (decodedMsg) {
      logger.info(`[handleAuthzExec] msgType: ${typeUrl}, decodedMsg: ${stringify(decodedMsg, undefined, 2)}`);
      const subMsgId = `${authzExecId}-${i}`;

      // Create primitive message entity for sub-message
      await Message.create({
        id: subMsgId,
        typeUrl,
        json: stringify(decodedMsg),
        transactionId: msg.tx.hash,
        blockId: msg.block.block.id,
      }).save();

      /* NB: Create AuthzExecMessage entity to join AuthzExec and Messages
             without requiring a foreign key in Message type.
       */
      await AuthzExecMessage.create({
        id: subMsgId,
        authzExecId,
        messageId: subMsgId,
      }).save();
    }
  }
}

function getEntityParamName(typeUrl: string): string {
  switch (typeUrl) {
    case '/poktroll.application.MsgUpdateParams':
    case '/poktroll.application.MsgUpdateParam':
      return 'AppParam';
    case '/cosmos.auth.v1beta1.MsgUpdateParams':
      return 'AuthParam';
    case '/cosmos.bank.v1beta1.MsgUpdateParams':
      return 'BankParam';
    case '/cosmos.distribution.v1beta1.MsgUpdateParams':
      return 'DistributionParam';
    case '/poktroll.gateway.MsgUpdateParams':
    case '/poktroll.gateway.MsgUpdateParam':
      return 'GatewayParam';
    case '/cosmos.gov.v1.MsgUpdateParams':
      return 'GovParam';
    case '/cosmos.mint.v1beta1.MsgUpdateParams':
      return 'MintParam';
    case '/poktroll.proof.MsgUpdateParams':
    case '/poktroll.proof.MsgUpdateParam':
      return 'ProofParam';
    case '/poktroll.service.MsgUpdateParams':
    case '/poktroll.service.MsgUpdateParam':
      return 'ServiceParam';
    case '/poktroll.session.MsgUpdateParams':
      return 'SessionParam';
    case '/poktroll.shared.MsgUpdateParams':
    case '/poktroll.shared.MsgUpdateParam':
      return 'SharedParam';
    case '/cosmos.slashing.v1beta1.MsgUpdateParams':
      return 'SlashingParam';
    case '/cosmos.staking.v1beta1.MsgUpdateParams':
      return 'StakingParam';
    case '/poktroll.supplier.MsgUpdateParams':
    case '/poktroll.supplier.MsgUpdateParam':
      return 'SupplierParam';
    case '/poktroll.tokenomics.MsgUpdateParams':
    case '/poktroll.tokenomics.MsgUpdateParam':
      return 'TokenomicsParam';
    case '/cosmos.consensus.v1.MsgUpdateParams':
      return 'ConsensusParam';
    default:
      throw new Error(`Unknown typeUrl: ${typeUrl}`);
  }
}

function camelToSnake(str: string): string {
  return str.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

async function _handleUpdateParam(encodedMsg: EncodedMsg, blockId: string): Promise<unknown> {
  const entityName = getEntityParamName(encodedMsg.typeUrl);
  const entities: Array<AppParamProps> = []

  const parseEncodedMsg = msgUpdateParamsMap[encodedMsg.typeUrl]
  const uintArray = new Uint8Array(Object.values(encodedMsg.value))
  let decodedMsg: unknown

  logger.info(`[handleUpdateParam] MsgAppUpdateParams: ${MsgUpdateApplicationParams}, MsgGovUpdateParams: ${MsgUpdateGovParams}`)

  if (encodedMsg.typeUrl.startsWith('/poktroll')) {
    decodedMsg = parseEncodedMsg.decode(
      new BinaryReader(
        uintArray,
        (bytes) => {
          return Buffer.from(bytes).toString("utf-8");
        })
    );
  } else {
    decodedMsg = parseEncodedMsg.decode(
      uintArray
    );
  }

  const decodedJsonMsg = parseEncodedMsg.toJSON(decodedMsg) as any;

  logger.info(`[handleUpdateParam] decodedMsg: ${stringify(decodedMsg, undefined, 2)}, decodedJsonMsg: ${stringify(decodedJsonMsg, undefined, 2)}`)

  if (encodedMsg.typeUrl.endsWith("MsgUpdateParams")) {
    for (const [key, value] of Object.entries(decodedJsonMsg.params)) {
      // we need to convert the key to snake case. Or shall we do save it in camel case?
      const snakeKey = camelToSnake(key);
      entities.push({
        id: getParamId(snakeKey, blockId),
        key: snakeKey,
        value: typeof value === 'object' ? stringify(value) : (value || "").toString(),
        blockId
      })
    }
  } else {
    for (const key of Object.keys(decodedJsonMsg)) {
      const value = decodedJsonMsg[key];
      if (key.startsWith('as')) {
        const snakeKey = camelToSnake(decodedJsonMsg.name);
        entities.push({
          id: getParamId(snakeKey, blockId),
          key: snakeKey,
          value: typeof value === 'object' ? stringify(value) : (value || "").toString(),
          blockId,
        })
      }
    }
  }

  await store.bulkCreate(entityName, entities)

  return decodedMsg
}
