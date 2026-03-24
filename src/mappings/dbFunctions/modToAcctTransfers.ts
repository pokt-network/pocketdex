// mod_to_acct_transfers is no longer managed by SubQuery to avoid the GiST indexes
// SubQuery creates on every column for historical tracking. We recreate it with the
// same structure but no indexes — indexes can be added selectively as needed.
//
// On existing deployments CREATE TABLE IF NOT EXISTS is a no-op, so the existing
// table and its data are untouched. On new deployments the table is created here.
// op_reason uses TEXT instead of the SubQuery hash-named enum — compatible with
// the existing enum values and works on new deployments without SubQuery's enum.
export function createModToAcctTransfersTableFn(dbSchema: string): string {
  return `
CREATE TABLE IF NOT EXISTS ${dbSchema}.mod_to_acct_transfers (
  id                     TEXT      NOT NULL,
  event_claim_settled_id TEXT      NOT NULL,
  block_id               NUMERIC   NOT NULL,
  op_reason              ${dbSchema}.c8206fb405 NOT NULL,
  recipient_id           TEXT      NOT NULL,
  amount                 NUMERIC   NOT NULL,
  denom                  TEXT      NOT NULL,
  _block_range           INT8RANGE NOT NULL,
  PRIMARY KEY (id)
);
`;
}
