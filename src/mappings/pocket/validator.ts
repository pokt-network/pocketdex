import { toBase64 } from "@cosmjs/encoding";
import {
  CosmosEvent,
  CosmosMessage,
} from "@subql/types-cosmos";
import type { MsgCreateValidator } from "cosmjs-types/cosmos/staking/v1beta1/tx";
import {
  isEmpty,
  isNil,
} from "lodash";
import { BondStatus } from "../../client/cosmos/staking/v1beta1/staking";
import { parseCoins } from "../../cosmjs/utils";
import {
  StakeStatus,
  Validator,
} from "../../types";
import getQueryClient from "../utils/query_client";
import { fetchAllValidatorByStatus } from "./pagination";
import { MsgCreateValidator as MsgCreateValidatorEntity } from "../../types/models/MsgCreateValidator";
import { ValidatorCommissionProps } from "../../types/models/ValidatorCommission";
import { ValidatorRewardProps } from "../../types/models/ValidatorReward";
import { SignerInfo } from "../../types/proto-interfaces/cosmos/tx/v1beta1/tx";
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
  extractThresholdAndPubkeysFromMultisig,
  getMultiSignPubKeyAddress,
  isMulti,
} from "../utils/multisig";
import {
  Ed25519,
  pubKeyToAddress,
  Secp256k1,
} from "../utils/pub_key";


async function _handleValidatorMsgCreate(msg: CosmosMessage<MsgCreateValidator>): Promise<Validator> {
  const msgId = messageId(msg);
  const blockId = getBlockId(msg.block);
  const createValMsg = msg.msg.decodedMsg;

  if (isEmpty(msg.tx.decodedTx.authInfo.signerInfos) || isNil(msg.tx.decodedTx.authInfo.signerInfos[0]?.publicKey)) {
    throw new Error(`[handleValidatorMsgCreate] (block ${msg.block.block.header.height}): hash=${msg.tx.hash} missing signerInfos public key`);
  }

  const signerInfo = (msg.tx.decodedTx.authInfo.signerInfos as SignerInfo[])[0];

  if (!signerInfo.publicKey) {
    throw new Error(`[handleValidatorMsgCreate] (block ${msg.tx.block.block.header.height}): hash=${msg.tx.hash} missing signerInfos public key`);
  }

  const signerType = signerInfo.publicKey.typeUrl;
  let signerAddress, poktSignerAddress;

  if (isMulti(signerInfo)) {
    // TODO: is this doable?
    //  probably yes, but we should attempt to reproduce this and see if this
    //  code satisfied this well enough
    const { pubkeysBase64, threshold } = extractThresholdAndPubkeysFromMultisig(signerInfo.publicKey.value);
    const { from: validatorFrom } = getMultiSignPubKeyAddress(pubkeysBase64, threshold, VALIDATOR_PREFIX);
    signerAddress = validatorFrom;
    const { from: poktValidatorFrom } = getMultiSignPubKeyAddress(pubkeysBase64, threshold, PREFIX);
    poktSignerAddress = poktValidatorFrom;
  } else if (signerType === Secp256k1) {
    signerAddress = pubKeyToAddress(Secp256k1, signerInfo.publicKey.value, VALIDATOR_PREFIX);
    poktSignerAddress = pubKeyToAddress(Secp256k1, signerInfo.publicKey.value, PREFIX);
  } else {
    signerAddress = `Unsupported Signer: ${signerType}`;
    poktSignerAddress = `Unsupported Signer: ${signerType}`;
  }

  if (isNil(createValMsg.pubkey)) {
    throw new Error("Pubkey is nil");
  }

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
    msgCreateValidator.save(),
    enforceAccountsExists([
      { account: { id: signerAddress, chainId: msg.block.header.chainId } },
      { account: { id: poktSignerAddress, chainId: msg.block.header.chainId } },
    ]),
  ]);

  return validator;
}

export async function handleValidatorMsgCreate(messages: Array<CosmosMessage<MsgCreateValidator>>): Promise<void> {
  const validators = await Promise.all(messages.map(_handleValidatorMsgCreate));
  if (validators.length > 0) await store.bulkCreate("Validator", validators);
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
  await optimizedBulkCreate("ValidatorReward", events, 'block_id', _handleValidatorRewardOrCommission);
}

export async function handleValidatorCommission(events: Array<CosmosEvent>): Promise<void> {
  await optimizedBulkCreate("ValidatorCommission", events, 'block_id', _handleValidatorRewardOrCommission);
}

function mapBondStatus(status: BondStatus): StakeStatus {
  switch (status) {
    case BondStatus.BOND_STATUS_BONDED:
      return StakeStatus.Staked;
    case BondStatus.BOND_STATUS_UNBONDING:
      return StakeStatus.Unstaking;
    // BOND_STATUS_UNBONDED / UNSPECIFIED => not actively staked
    default:
      return StakeStatus.Unstaked;
  }
}

// reconcileValidators re-syncs every validator entity against the chain's
// authoritative state at the given height. We read the full validator set in a
// single (paginated) query instead of deriving mutations from individual
// messages/events: cosmos changes a validator's tokens through delegate,
// undelegate, redelegate, slashing and reward auto-compounding, and several of
// those can happen in the same block - accumulating them by hand drifts. Reading
// the resulting state is exact and 1:1 by construction.
//
// Only the mutable fields are overwritten; identity columns (ed25519_id,
// signerId, createMsgId, transactionId, ...) are preserved. Validators that the
// chain no longer returns (fully unbonded => removed from the staking store) are
// marked Unstaked with zero stake.
export async function reconcileValidators(height: number): Promise<void> {
  const queryClient = getQueryClient(height);
  const chainValidators = await queryClient.staking.allValidators();

  const seen = new Set<string>();
  // Collect every mutated entity and persist them in a single batched upsert
  // (store.bulkCreate => one statement) instead of issuing an individual
  // save()/UPDATE per validator.
  const toUpsert: Array<Validator> = [];

  for (const cv of chainValidators) {
    const id = cv.operatorAddress;
    seen.add(id);

    const validator = await Validator.get(id);
    if (isNil(validator)) {
      // Created earlier in this same block by handleValidatorMsgCreate (which
      // runs before reconcile); if it is not persisted yet there is nothing to
      // refresh and the next trigger will pick it up.
      continue;
    }

    validator.description = cv.description ?? validator.description;
    validator.commission = cv.commission?.commissionRates ?? validator.commission;
    validator.minSelfDelegation = parseInt(cv.minSelfDelegation || "0", 10);
    validator.stakeAmount = BigInt(cv.tokens || "0");
    validator.stakeStatus = mapBondStatus(cv.status);

    toUpsert.push(validator);
  }

  // Detect validators we still track as active but that the chain dropped from
  // the staking store, and close them out.
  const tracked = [
    ...await fetchAllValidatorByStatus(StakeStatus.Staked),
    ...await fetchAllValidatorByStatus(StakeStatus.Unstaking),
  ];

  for (const validator of tracked) {
    if (seen.has(validator.id)) {
      continue;
    }

    validator.stakeStatus = StakeStatus.Unstaked;
    validator.stakeAmount = BigInt(0);
    toUpsert.push(validator);
  }

  if (toUpsert.length > 0) {
    await store.bulkCreate("Validator", toUpsert);
  }
}
