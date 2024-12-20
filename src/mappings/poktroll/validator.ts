import { toBase64 } from "@cosmjs/encoding";
import { CosmosMessage } from "@subql/types-cosmos";
import type { MsgCreateValidator } from "cosmjs-types/cosmos/staking/v1beta1/tx";
import { isNil } from "lodash";
import { Validator } from "../../types";
import { MsgCreateValidator as MsgCreateValidatorEntity } from "../../types/models/MsgCreateValidator";
import { VALIDATOR_PREFIX } from "../constants";
import {
  attemptHandling,
  unprocessedMsgHandler,
} from "../utils/handlers";
import { messageId } from "../utils/ids";
import { stringify } from "../utils/json";
import {
  Ed25519,
  pubKeyToAddress,
  Secp256k1,
} from "../utils/pub_key";

export async function handleValidatorMsgCreate(
  msg: CosmosMessage<MsgCreateValidator>,
): Promise<void> {
  await attemptHandling(msg, _handleValidatorMsgCreate, unprocessedMsgHandler);
}

async function _handleValidatorMsgCreate(
  msg: CosmosMessage<MsgCreateValidator>,
): Promise<void> {
  logger.debug(`[handleValidatorMsgCreate] (msg.msg): ${stringify(msg.msg, undefined, 2)}`);
  const msgId = messageId(msg);
  const createValMsg = msg.msg.decodedMsg;
  const signer = msg.tx.decodedTx.authInfo.signerInfos[0];

  if (isNil(signer) || isNil(signer.publicKey)) {
    throw new Error("Signer is nil");
  }

  if (isNil(createValMsg.pubkey)) {
    throw new Error("Pubkey is nil");
  }

  const signerAddress = pubKeyToAddress(Secp256k1, signer.publicKey.value, VALIDATOR_PREFIX);

  const msgCreateValidator = MsgCreateValidatorEntity.create({
    id: msgId,
    pubkey: {
      type: createValMsg.pubkey?.typeUrl,
      key: toBase64(createValMsg.pubkey?.value),
    },
    address: pubKeyToAddress(Ed25519, createValMsg.pubkey?.value, VALIDATOR_PREFIX),
    signerId: signerAddress,
    description: createValMsg.description,
    commission: createValMsg.commission,
    minSelfDelegation: parseInt(createValMsg.minSelfDelegation, 10),
    denom: createValMsg.value.denom,
    stakeAmount: BigInt(createValMsg.value.amount),
    messageId: msgId,
    transactionId: msg.tx.hash,
    blockId: msg.block.block.id,
  });

  const validator = Validator.create({
    id: msgCreateValidator.address,
    signerId: msgCreateValidator.signerId,
    description: msgCreateValidator.description,
    commission: msgCreateValidator.commission,
    minSelfDelegation: msgCreateValidator.minSelfDelegation,
    denom: msgCreateValidator.denom,
    stakeAmount: msgCreateValidator.stakeAmount,
    transactionId: msgCreateValidator.transactionId,
    blockId: msgCreateValidator.blockId,
    createMsgId: msgCreateValidator.id,
  });

  await Promise.all([
    validator.save(),
    msgCreateValidator.save(),
  ]);
}
