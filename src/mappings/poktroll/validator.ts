import { toBase64 } from "@cosmjs/encoding";
import {
  CosmosEvent,
  CosmosMessage,
} from "@subql/types-cosmos";
import type { MsgCreateValidator } from "cosmjs-types/cosmos/staking/v1beta1/tx";
import { isNil } from "lodash";
import { parseCoins } from "../../cosmjs/utils";
import {
  StakeStatus,
  Validator,
} from "../../types";
import { MsgCreateValidator as MsgCreateValidatorEntity } from "../../types/models/MsgCreateValidator";
import { ValidatorCommissionProps } from "../../types/models/ValidatorCommission";
import { ValidatorRewardProps } from "../../types/models/ValidatorReward";
import { enforceAccountsExists } from "../bank";
import {
  PREFIX,
  VALIDATOR_PREFIX,
} from "../constants";
import { optimizedBulkCreate } from "../utils/db";
import {
  getBlockId,
  getEventId,
  messageId,
} from "../utils/ids";
import { stringify } from "../utils/json";
import {
  Ed25519,
  pubKeyToAddress,
  Secp256k1,
} from "../utils/pub_key";


async function _handleValidatorMsgCreate(msg: CosmosMessage<MsgCreateValidator>): Promise<void> {
  const msgId = messageId(msg);
  const blockId = getBlockId(msg.block);
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
    blockId,
  });

  const validator = Validator.create({
    id: msgCreateValidator.signerId,
    ed25519_id: msgCreateValidator.address,
    signerId: msgCreateValidator.signerId,
    signerPoktPrefixId: poktSignerAddress,
    description: msgCreateValidator.description,
    commission: msgCreateValidator.commission,
    minSelfDelegation: msgCreateValidator.minSelfDelegation,
    stakeDenom: msgCreateValidator.stakeDenom,
    stakeAmount: msgCreateValidator.stakeAmount,
    stakeStatus: StakeStatus.Staked,
    transactionId: msgCreateValidator.transactionId,
    createMsgId: msgCreateValidator.id,
  });

  await Promise.all([
    validator.save(),
    msgCreateValidator.save(),
    // in bulk
    enforceAccountsExists([
      { account: { id: signerAddress, chainId: msg.block.header.chainId } },
      { account: { id: poktSignerAddress, chainId: msg.block.header.chainId } },
    ]),
  ]);
}

export async function handleValidatorMsgCreate(messages: Array<CosmosMessage<MsgCreateValidator>>): Promise<void> {
  await Promise.all(
    messages.map(
      (msg) => _handleValidatorMsgCreate(msg),
    ),
  );
}

function _handleValidatorRewardOrCommission(event: CosmosEvent): ValidatorRewardProps | ValidatorCommissionProps {
  const validator = event.event.attributes.find(attribute => attribute.key === "validator")?.value as unknown as string;
  if (!validator) {
    throw new Error(`[handleValidatorReward] validator not provided in event`);
  }

  const eventId = getEventId(event);
  const amount = (event.event.attributes.find(attribute => attribute.key === "amount")?.value ?? "0upokt") as unknown as string;
  const coins = parseCoins(amount);
  if (!coins.length) {
    logger.error(`[handleValidatorReward] amount: ${amount} attributes: ${stringify(event.event.attributes, undefined, 2)}`);
    throw new Error(`[handleValidatorReward] amount not provided in event`);
  }

  return {
    id: `${eventId}-${validator}`,
    blockId: getBlockId(event.block),
    validatorId: validator,
    eventId,
    amount: BigInt(coins[0].amount),
    denom: coins[0].denom,
  };
}

export async function handleValidatorRewards(events: Array<CosmosEvent>): Promise<void> {
  await optimizedBulkCreate("ValidatorReward", events, _handleValidatorRewardOrCommission);
}

export async function handleValidatorCommission(events: Array<CosmosEvent>): Promise<void> {
  await optimizedBulkCreate("ValidatorCommission", events, _handleValidatorRewardOrCommission);
}
