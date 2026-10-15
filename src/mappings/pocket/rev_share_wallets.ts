import type { SupplierServiceConfigProps } from "../../types/models/SupplierServiceConfig";
import { getDbSchema, getSequelize } from "../utils/db";

// The (wallet, supplier) pair of every rev_share entry of the service configs a block writes, into
// supplier_rev_share_wallets (src/mappings/dbFunctions/revShareWallets.ts) at that height; a pair already there keeps
// its height. One statement, in the block transaction, as the configs themselves.
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

  await getSequelize("SupplierServiceConfig").query(
    `INSERT INTO ${getDbSchema()}.supplier_rev_share_wallets (wallet_address, supplier_id, first_seen_height)
     SELECT DISTINCT p.wallet_address, p.supplier_id, $3::bigint FROM unnest($1::text[], $2::text[]) AS p(wallet_address, supplier_id)
     ON CONFLICT (wallet_address, supplier_id) DO NOTHING`,
    { bind: [wallets, suppliers, height], transaction: store.context.transaction }
  );
}
