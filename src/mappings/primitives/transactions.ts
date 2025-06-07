import { CosmosTransaction } from "@subql/types-cosmos";
import {
  isEmpty,
  isNil,
} from "lodash";
import { TransactionProps } from "../../types/models/Transaction";
import { SignerInfo } from "../../types/proto-interfaces/cosmos/tx/v1beta1/tx";
import {
  PREFIX,
  VALIDATOR_PREFIX,
} from "../constants";
import { optimizedBulkCreate } from "../utils/db";
import { getBlockId } from "../utils/ids";
import {
  getMultisigInfo,
  isMulti,
} from "../utils/multisig";
import {
  getTxStatus,
  isMsgValidatorRelated,
} from "../utils/primitives";
import {
  pubKeyToAddress,
  Secp256k1,
} from "../utils/pub_key";

function _handleTransaction(tx: CosmosTransaction): TransactionProps {
  let signerAddress;

  if (isEmpty(tx.decodedTx.authInfo.signerInfos) || isNil(tx.decodedTx.authInfo.signerInfos[0].publicKey)) {
    throw new Error(`[handleTransaction] (block ${tx.block.block.header.height}): hash=${tx.hash} missing signerInfos public key`);
  }

  const prefix = isMsgValidatorRelated(tx.decodedTx.body.messages[0].typeUrl) ? VALIDATOR_PREFIX : PREFIX;

  const signerInfo = (tx.decodedTx.authInfo.signerInfos as SignerInfo[])[0];

  if (!signerInfo.publicKey) {
    throw new Error(`[handleTransaction] (block ${tx.block.block.header.height}): hash=${tx.hash} missing signerInfos public key`);
  }

  const signerType = signerInfo.publicKey.typeUrl;

  if (isMulti(signerInfo)) {
    const {
      allSignerAddresses,
      fromAddress,
      signedSignerAddresses,
    } = getMultisigInfo(signerInfo);

    console.log("[handleTransaction] MultiSig -> From:", fromAddress);
    console.log("[handleTransaction] MultiSig -> All: ", allSignerAddresses);
    console.log("[handleTransaction] MultiSig -> Signed:", signedSignerAddresses);

    // TODO: Add another properties to transaction to display that this is a multisig one
    // TODO: We should probably "create" this account otherwise maybe will not exists?
    signerAddress = fromAddress;
  } else if (signerType === Secp256k1) {
    signerAddress = pubKeyToAddress(
      signerType,
      tx.decodedTx.authInfo.signerInfos[0]?.publicKey.value,
      prefix,
    );
  } else {
    signerAddress = `Unsupported Signer: ${signerType}`;
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
