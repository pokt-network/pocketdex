import { isMainThread } from "worker_threads";
import type { SupplierServiceConfigProps } from "../../types/models/SupplierServiceConfig";
import {
  insertRevShareWalletsSql,
  markRevShareWalletsCoveredSql,
  rewindNeeded,
  rewindRevShareWalletsSql,
} from "../dbFunctions/revShareWallets";
import { blockTransaction, getDbSchema, getSequelize } from "../utils/db";

// supplier_rev_share_wallets (src/mappings/dbFunctions/revShareWallets.ts) is plain DDL that SubQuery does not manage,
// like claims_by_block: its rewind does not touch it. A block that does not follow the last one this process started
// (the first block after the process starts, a SubQuery rewind or reindex, or a retried block) first deletes the pairs
// first seen at its height or above: first_seen_height is a minimum, so the replayed blocks write again the pairs they
// still list, and a pair the code no longer writes is gone. The next block of a run deletes nothing. It runs before
// indexPrimitives, so before genesis writes the genesis configs' pairs, and in the block transaction (a seq scan of the
// ~30k rows, ~2 ms on mainnet, 2026-10-15). The last height is this process's memory, which holds because one process
// indexes the blocks in order: no deployment passes --workers (tilt, scripts/shared.sh, pnf-ops). With --workers each
// worker thread sees blocks out of order, and every gap would read as a rewind and delete pairs other blocks wrote, so the
// rewind refuses to run off the main thread (the sandbox runs the mappings in the worker threads then, see
// sandbox.service.ts in node-core): the first block fails, before this table is touched.
let lastHeight: number | undefined;

export async function rewindRevShareWallets(height: number, mainThread = isMainThread): Promise<void> {
  if (!mainThread) {
    throw new Error(
      "[rev_share_wallets] the indexer runs with --workers: blocks arrive out of order, and the rewind of " +
        "supplier_rev_share_wallets (a height that does not follow the last one) would delete pairs; run without --workers"
    );
  }
  // set before the DELETE: a block that fails and is retried at the same height deletes again
  const needed = rewindNeeded(lastHeight, height);
  lastHeight = height;
  if (!needed) return;
  await getSequelize("SupplierServiceConfig").query(rewindRevShareWalletsSql(getDbSchema()), {
    bind: [height],
    transaction: blockTransaction(),
  });
}

// The (wallet, supplier) pair of every rev_share entry of the service configs a block writes, at that height; a pair
// already there keeps its height. In the block transaction, as the configs themselves.
export async function writeRevShareWallets(
  configs: Array<Pick<SupplierServiceConfigProps, "revShare" | "supplierId">>,
  height: number
): Promise<void> {
  const wallets: Array<string> = [];
  const suppliers: Array<string> = [];

  for (const { revShare, supplierId } of configs) {
    for (const { address } of revShare) {
      wallets.push(address);
      suppliers.push(supplierId);
    }
  }

  if (wallets.length === 0) return;

  await getSequelize("SupplierServiceConfig").query(insertRevShareWalletsSql(getDbSchema()), {
    bind: [wallets, suppliers, height],
    transaction: blockTransaction(),
  });
}

// A database indexed from genesis has the pairs of every height: genesis marks the table covered, so
// _operator_suppliers_ever reads it from the start (an existing database is marked by
// scripts/set_rev_share_wallets_coverage.sql after its backfill). In the block transaction.
export async function markRevShareWalletsCovered(): Promise<void> {
  await getSequelize("SupplierServiceConfig").query(markRevShareWalletsCoveredSql(getDbSchema()), {
    transaction: blockTransaction(),
  });
}
