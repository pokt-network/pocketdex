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

  // The staking module keys validators by operatorAddress, which is the
  // canonical id every other consumer (reconcile, rewards/commission FKs)
  // already assumes. Take it straight from the message instead of trusting the
  // signer-pubkey derivation, and cross-check both: a mismatch means the
  // derivation assumptions broke, and failing here is loud — unlike a silent
  // row the reconciler would close out as Unstaked forever.
  const operatorAddress = createValMsg.validatorAddress;

  if (!operatorAddress) {
    throw new Error(`[handleValidatorMsgCreate] (block ${msg.block.block.header.height}): hash=${msg.tx.hash} missing validatorAddress in MsgCreateValidator`);
  }

  if ((isMulti(signerInfo) || signerType === Secp256k1) && signerAddress !== operatorAddress) {
    throw new Error(`[handleValidatorMsgCreate] (block ${msg.block.block.header.height}): hash=${msg.tx.hash} derived signer address ${signerAddress} != msg validatorAddress ${operatorAddress}`);
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
    id: operatorAddress,
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

// Compares two @jsonField values (description, commission) ignoring key order
// and empty/absent fields: the stored side comes back from jsonb, which does not
// preserve insertion order, while the incoming side is a decoded proto message
// where an unset string is "" rather than missing.
//
// Invariant this relies on: both @jsonField types it is called with
// (ValidatorDescription, ValidatorCommissionParams in schema.graphql) are FLAT
// objects of scalars. Only the top level is canonicalised, so a nested object
// added later would still be compared by its serialised form with whatever key
// order each side happens to have — reporting "changed" every block and writing
// a historical row per validator per block. Keep them flat, or extend this.
function jsonFieldEquals(a: unknown, b: unknown): boolean {
  const canonical = (value: unknown): string => {
    if (isNil(value)) return "null";
    return stringify(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => !isNil(v) && v !== "")
        .sort(([keyA], [keyB]) => keyA.localeCompare(keyB)),
    );
  };

  return canonical(a) === canonical(b);
}

// Validator ids already reported as "Staked in store but missing from chain".
// Process-scoped, so a restart re-reports whatever is still broken.
const reportedMissingFromChain = new Set<string>();

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

  // The read is pinned to the block height, which makes it the one part of block
  // indexing that depends on the node still serving state at that height: a
  // pruned height during a from-genesis reindex, or a transient RPC failure,
  // would otherwise throw out of the block handler and stall indexing entirely.
  // Running every block is what makes giving up on this block safe — the next
  // one reads the same set again — but it must be loud, or "the reconcile is
  // broken" and "nothing changed" become the same silence.
  //
  // Only the read is tolerated. Everything below it writes through the block's
  // Postgres transaction, shared with every other handler, so a failure there
  // must fail the block instead of leaving the rest of it running on an aborted
  // transaction.
  let chainValidators: Awaited<ReturnType<typeof queryClient.staking.allValidators>>;
  try {
    chainValidators = await queryClient.staking.allValidators();
  } catch (error) {
    logger.error(`[reconcileValidators] chain read failed at height ${height}, retrying next block: ${error}`);
    return;
  }

  const seen = new Set<string>();
  // Collect every mutated entity and persist them in a single batched upsert
  // (store.bulkCreate => one statement) instead of issuing an individual
  // save()/UPDATE per validator.
  const toUpsert: Array<Validator> = [];

  for (const cv of chainValidators) {
    const id = cv.operatorAddress;
    seen.add(id);
    // Back on chain: forget it was reported, so a second, unrelated incident on
    // the same validator is not silenced by the dedupe below.
    reportedMissingFromChain.delete(id);

    const validator = await Validator.get(id);
    if (isNil(validator)) {
      // Created earlier in this same block by handleValidatorMsgCreate (which
      // runs before reconcile); if it is not persisted yet there is nothing to
      // refresh and the next block will pick it up.
      continue;
    }

    const description = cv.description ?? validator.description;
    const commission = cv.commission?.commissionRates ?? validator.commission;
    const minSelfDelegation = parseInt(cv.minSelfDelegation || "0", 10);
    const stakeAmount = BigInt(cv.tokens || "0");
    const stakeStatus = mapBondStatus(cv.status);

    // Reconcile runs on every block, so most blocks find every validator already
    // in sync. Writing them anyway would open a new historical row per validator
    // per block; skip the ones that did not move.
    if (
      validator.stakeStatus === stakeStatus &&
      validator.stakeAmount === stakeAmount &&
      validator.minSelfDelegation === minSelfDelegation &&
      jsonFieldEquals(validator.description, description) &&
      jsonFieldEquals(validator.commission, commission)
    ) {
      continue;
    }

    validator.description = description;
    validator.commission = commission;
    validator.minSelfDelegation = minSelfDelegation;
    validator.stakeAmount = stakeAmount;
    validator.stakeStatus = stakeStatus;

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

    // Same invariant as reconcileApplications: the staking module keeps a
    // validator in its store (any bond status) until unbonding fully completes,
    // and running every block means the reconcile itself has already moved the
    // row to Unstaking well before the chain drops it. A Staked row missing from
    // the chain read is an impossible state — report it instead of wiping it.
    //
    // Reported once per unresolved streak: the row is deliberately never
    // repaired, so re-logging it on every block would bury the signal it exists
    // to raise. The id is forgotten as soon as the chain returns it again, so a
    // later incident still reports.
    if (validator.stakeStatus !== StakeStatus.Unstaking) {
      if (!reportedMissingFromChain.has(validator.id)) {
        reportedMissingFromChain.add(validator.id);
        logger.error(`[reconcileValidators] validator ${validator.id} is ${validator.stakeStatus} in store but missing from chain at height ${height} — refusing close-out, investigate`);
      }
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
