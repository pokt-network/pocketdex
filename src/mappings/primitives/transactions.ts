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
import { pubKeyToAddress } from "../utils/pub_key";

function _handleTransaction(tx: CosmosTransaction): TransactionProps {
  let signerAddress;
  if (isEmpty(tx.decodedTx.authInfo.signerInfos) || isNil(tx.decodedTx.authInfo.signerInfos[0]?.publicKey)) {
    throw new Error(`[handleTransaction] (block ${tx.block.block.header.height}): hash=${tx.hash} missing signerInfos public key`);
  } else {
    const prefix = isMsgValidatorRelated(tx.decodedTx.body.messages[0].typeUrl) ? VALIDATOR_PREFIX : PREFIX;
    // if the first message is a MsgCreateValidator, we assume the signer is the account related to it,
    // that is hashed with a different prefix.
    signerAddress = pubKeyToAddress(
      tx.decodedTx.authInfo.signerInfos[0]?.publicKey.typeUrl,
      tx.decodedTx.authInfo.signerInfos[0]?.publicKey.value,
      prefix,
    );
  }

  const feeAmount = !isNil(tx.decodedTx.authInfo.fee) ? tx.decodedTx.authInfo.fee.amount : [];

  return {
    id: tx.hash,
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
