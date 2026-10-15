// supplier_rev_share_wallets: every (wallet, supplier) pair a service config of the supplier ever listed in its
// rev_share, with the first height a config listed it. Append-only: the indexer inserts the pairs of the configs a block
// writes (src/mappings/pocket/rev_share_wallets.ts), and scripts/backfill_rev_share_wallets.sql fills those of the heights
// indexed before it. operator_scope ever (_operator_suppliers_ever) reads it: SubQuery's GIN on rev_share finds the pairs
// too, but through every version of every config, ~980k heap rows for a large operator (~12 s for the 7 largest on
// mainnet, 2026-10-14), where 30,408 pairs hold the answer.
// supplier_rev_share_wallets_coverage.backfilled_at is set by scripts/set_rev_share_wallets_coverage.sql once the backfill
// has run after the release that writes the pairs: until then _operator_suppliers_ever keeps reading the configs.
// Schema changes are ALTER statements in a PR: CREATE ... IF NOT EXISTS never alters the table. The tables may be
// created by hand before the release, with this exact text, as the indexer's role (its COMMENT needs the owner).
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
