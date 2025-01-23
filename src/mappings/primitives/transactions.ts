import { CosmosTransaction } from "@subql/types-cosmos";
import {
  isEmpty,
  isNil,
} from "lodash";
import { TransactionProps } from "../../types/models/Transaction";
import {
  PREFIX,
  TxStatus,
} from "../constants";
import { getBlockIdAsString } from "../utils/ids";
import { pubKeyToAddress } from "../utils/pub_key";

function _handleTransaction(tx: CosmosTransaction): TransactionProps {
  let status = tx.tx.code === 0 ? TxStatus.Success : TxStatus.Error;

  let signerAddress;
  if (isEmpty(tx.decodedTx.authInfo.signerInfos) || isNil(tx.decodedTx.authInfo.signerInfos[0]?.publicKey)) {
    status = TxStatus.Error;
    logger.error(`[handleTransaction] (block ${tx.block.block.header.height}): hash=${tx.hash} missing signerInfos public key`);
  } else {
    signerAddress = pubKeyToAddress(
      tx.decodedTx.authInfo.signerInfos[0]?.publicKey.typeUrl,
      tx.decodedTx.authInfo.signerInfos[0]?.publicKey.value,
      PREFIX,
    );
  }

  const feeAmount = !isNil(tx.decodedTx.authInfo.fee) ? tx.decodedTx.authInfo.fee.amount : [];

  return {
    id: tx.hash,
    // timeline,
    blockId: getBlockIdAsString(tx.block),
    gasUsed: tx.tx.gasUsed,
    gasWanted: tx.tx.gasWanted,
    memo: tx.decodedTx.body.memo,
    timeoutHeight: tx.decodedTx.body.timeoutHeight,
    fees: feeAmount,
    log: tx.tx.log || "",
    status,
    signerAddress,
    code: tx.tx.code,
    codespace: tx.tx.codespace,
  };
}

// handleTransactions, referenced in project.ts, handles transactions and store as is in case we need to use them on a migration
export async function handleTransactions(txs: CosmosTransaction[]): Promise<void> {
  await store.bulkCreate("Transaction", txs.map(tx => _handleTransaction(tx)));
}
