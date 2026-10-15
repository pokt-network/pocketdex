// supplier_rev_share_wallets: every (wallet, supplier) pair a service config of the supplier ever listed in its
// rev_share, with the first height a config listed it. The indexer inserts the pairs of the configs a block writes, and
// after a rewind deletes those first seen at or above the height it resumes from (src/mappings/pocket/rev_share_wallets.ts);
// scripts/backfill_rev_share_wallets.sql fills those of the heights indexed before it. operator_scope ever
// (_operator_suppliers_ever) reads it: SubQuery's GIN on rev_share finds the pairs too, but through every version of every
// config, ~980k heap rows for a large operator (~12 s for the 7 largest on mainnet, 2026-10-14), where 30,408 pairs hold
// the answer.
// supplier_rev_share_wallets_coverage.backfilled_at is set at genesis, or by scripts/set_rev_share_wallets_coverage.sql
// once the backfill has run after the release that writes the pairs: until then _operator_suppliers_ever keeps reading
// the configs.
// Schema changes are ALTER statements in a PR: CREATE ... IF NOT EXISTS never alters the table. The tables were created by
// hand on beta and mainnet before the release, with this exact text, as the indexer's role (its COMMENT needs the owner):
// the text is frozen (suppliers.spec.ts compares it with dbFunctions/fixtures).
export function createSupplierRevShareWalletsFn(dbSchema: string): string {
  const s = dbSchema;
  return `
CREATE TABLE IF NOT EXISTS ${s}.supplier_rev_share_wallets (
  wallet_address    TEXT   NOT NULL,
  supplier_id       TEXT   NOT NULL,
  first_seen_height BIGINT NOT NULL,
  PRIMARY KEY (wallet_address, supplier_id)
);
COMMENT ON TABLE ${s}.supplier_rev_share_wallets IS E'@omit';
CREATE TABLE IF NOT EXISTS ${s}.supplier_rev_share_wallets_coverage (
  singleton     BOOLEAN     PRIMARY KEY DEFAULT true CHECK (singleton),
  backfilled_at TIMESTAMPTZ NOT NULL
);
COMMENT ON TABLE ${s}.supplier_rev_share_wallets_coverage IS E'@omit';
`;
}

// Whether a block at height must delete what a rewind left (rev_share_wallets.ts): unless it is the one after last.
export function rewindNeeded(last: number | undefined, height: number): boolean {
  return last === undefined || height !== last + 1;
}

// The statements the indexer runs on the table (src/mappings/pocket/rev_share_wallets.ts), here so the DB tests run the
// same text. Bind parameters: rewind $1 = the block height; insert $1 = wallet addresses, $2 = their suppliers (pairs by
// position), $3 = the block height. The insert takes its row locks ORDER BY (wallet_address, supplier_id), as
// scripts/backfill_rev_share_wallets.sql does, so a block's insert and a live backfill batch lock rows in one order.
export const rewindRevShareWalletsSql = (s: string): string =>
  `DELETE FROM ${s}.supplier_rev_share_wallets WHERE first_seen_height >= $1::bigint`;

export const insertRevShareWalletsSql = (s: string): string =>
  `INSERT INTO ${s}.supplier_rev_share_wallets (wallet_address, supplier_id, first_seen_height)
SELECT DISTINCT p.wallet_address, p.supplier_id, $3::bigint FROM unnest($1::text[], $2::text[]) AS p(wallet_address, supplier_id)
ORDER BY 1, 2
ON CONFLICT (wallet_address, supplier_id) DO NOTHING`;

export const markRevShareWalletsCoveredSql = (s: string): string =>
  `INSERT INTO ${s}.supplier_rev_share_wallets_coverage (backfilled_at) VALUES (now()) ON CONFLICT (singleton) DO NOTHING`;
