import { CosmosTransaction } from "@subql/types-cosmos";
import {
  isEmpty,
  isNil,
} from "lodash";
import { TransactionProps } from "../../types/models/Transaction";
import {
  PREFIX,
  VALIDATOR_PREFIX,
} from "../constants";
import { optimizedBulkCreate } from "../utils/db";
import { getBlockId } from "../utils/ids";
import {
  getTxStatus,
  isMsgValidatorRelated,
} from "../utils/primitives";
import {
  MultisigLegacyAminoPubKey,
  pubKeyToAddress,
  Secp256k1,
} from "../utils/pub_key";
import { LegacyAminoPubKey } from "../../types/proto-interfaces/cosmos/crypto/multisig/keys";

function _handleTransaction(tx: CosmosTransaction): TransactionProps {
  let signerAddress;
  if (isEmpty(tx.decodedTx.authInfo.signerInfos) || isNil(tx.decodedTx.authInfo.signerInfos[0]?.publicKey)) {
    throw new Error(`[handleTransaction] (block ${tx.block.block.header.height}): hash=${tx.hash} missing signerInfos public key`);
  } else {
    const prefix = isMsgValidatorRelated(tx.decodedTx.body.messages[0].typeUrl) ? VALIDATOR_PREFIX : PREFIX;
    // if the first message is a MsgCreateValidator, we assume the signer is the account related to it,
    // that is hashed with a different prefix.
    const signerType = tx.decodedTx.authInfo.signerInfos[0]?.publicKey.typeUrl;

    if (signerType === MultisigLegacyAminoPubKey) {
      try {
        // TODO: Add support for multisign
        // Beta network:
        // MultiSign TX 8FBC06F36312F48E3ECABDDC145322BF24C322BAB37F9A3D7B9AA2430C16CC16
        // Block: 39712
        // This results in error since signersInfo.publicKeys is not an array, maybe public_keys or current cosmosjs
        // does not handle this well?
        const signersInfo = tx.decodedTx.authInfo.signerInfos[0] as unknown as LegacyAminoPubKey;
        const signers = (signersInfo.publicKeys as unknown as [Uint8Array]).map((value: Uint8Array) => pubKeyToAddress(
          signerType,
          value,
          prefix,
        ));
        console.log(`MultisigLegacyAminoPubKey: ${signers.join(", ")}`);
        signerAddress = signers[0]; // TODO: we need to handle this properly as multisign
      } catch (e) {
        signerAddress = `Unsupported pubkey type: ${signerType}`;
        console.error(e);
      }
    } else if (signerType === Secp256k1) {
      signerAddress = pubKeyToAddress(
        signerType,
        tx.decodedTx.authInfo.signerInfos[0]?.publicKey.value,
        prefix,
      );
    } else {
      signerAddress = `Unsupported pubkey type: ${signerType}`;
    }
  }

  const feeAmount = !isNil(tx.decodedTx.authInfo.fee) ? tx.decodedTx.authInfo.fee.amount : [];

  return {
    id: tx.hash,
    idx: tx.idx,
    blockId: getBlockId(tx.block),
    gasUsed: tx.tx.gasUsed,
    gasWanted: tx.tx.gasWanted,
    memo: tx.decodedTx.body.memo,
    timeoutHeight: tx.decodedTx.body.timeoutHeight,
    fees: feeAmount,
    log: tx.tx.log || "",
    status: getTxStatus(tx),
    signerAddress,
    code: tx.tx.code,
    codespace: tx.tx.codespace,
  };
}

// handleTransactions, referenced in project.ts, handles transactions and store as is in case we need to use them on a migration
export async function handleTransactions(txs: CosmosTransaction[]): Promise<void> {
  // Process Transactions using the _handleTransaction function
  await optimizedBulkCreate("Transaction", txs, _handleTransaction);
}
