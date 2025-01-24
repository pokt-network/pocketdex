import { toBase64 } from "@cosmjs/encoding";
import { CosmosMessage } from "@subql/types-cosmos";
import type { MsgCreateValidator } from "cosmjs-types/cosmos/staking/v1beta1/tx";
import { isNil } from "lodash";
import {
  StakeStatus,
  Validator,
} from "../../types";
import { MsgCreateValidator as MsgCreateValidatorEntity } from "../../types/models/MsgCreateValidator";
import { enforceAccountExistence } from "../bank";
import {
  PREFIX,
  VALIDATOR_PREFIX,
} from "../constants";
import { messageId } from "../utils/ids";
import {
  Ed25519,
  pubKeyToAddress,
  Secp256k1,
} from "../utils/pub_key";


async function _handleValidatorMsgCreate(msg: CosmosMessage<MsgCreateValidator>): Promise<void> {
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
  const poktSignerAddress = pubKeyToAddress(Secp256k1, signer.publicKey.value, PREFIX);

  const msgCreateValidator = MsgCreateValidatorEntity.create({
    id: msgId,
    pubkey: {
      type: createValMsg.pubkey?.typeUrl,
      key: toBase64(createValMsg.pubkey?.value),
    },
    address: pubKeyToAddress(Ed25519, createValMsg.pubkey?.value, VALIDATOR_PREFIX),
    signerId: signerAddress,
    signerPoktPrefixId: poktSignerAddress,
    description: createValMsg.description,
    commission: createValMsg.commission,
    minSelfDelegation: parseInt(createValMsg.minSelfDelegation, 10),
    stakeDenom: createValMsg.value.denom,
    stakeAmount: BigInt(createValMsg.value.amount),
    messageId: msgId,
    transactionId: msg.tx.hash,
    blockId: msg.block.block.id,
  });

  const validator = Validator.create({
    id: msgCreateValidator.address,
    signerId: msgCreateValidator.signerId,
    signerPoktPrefixId: poktSignerAddress,
    description: msgCreateValidator.description,
    commission: msgCreateValidator.commission,
    minSelfDelegation: msgCreateValidator.minSelfDelegation,
    stakeDenom: msgCreateValidator.stakeDenom,
    stakeAmount: msgCreateValidator.stakeAmount,
    stakeStatus: StakeStatus.Staked,
    transactionId: msgCreateValidator.transactionId,
    blockId: msgCreateValidator.blockId,
    createMsgId: msgCreateValidator.id,
  });

  await Promise.all([
    validator.save(),
    msgCreateValidator.save(),
    enforceAccountExistence(signerAddress, msg.block.header.chainId),
    enforceAccountExistence(poktSignerAddress, msg.block.header.chainId),
  ]);
}

// TODO: update this to work with BatchMessage handler
// handleValidatorMsgCreate, referenced in project.ts
export async function handleValidatorMsgCreate(msg: CosmosMessage<MsgCreateValidator>): Promise<void> {
  await _handleValidatorMsgCreate(msg);
}
