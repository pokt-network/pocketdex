// mod_to_acct_transfers and mod_to_acct_transfers_summarized are gone: no longer written since release 2, no reader since
// 2026-10-22, and the money tables hold what they held (checked against them for heights 1..972053, their last written
// height, 2026-11-10: 0 differences per block and address). The start no longer creates them; the tables themselves are
// dropped by hand (1.4 TB on mainnet), since a DROP of that size does not belong in a start.
//
// The old functions that still read them are dropped here, every overload. One the indexer's role does not own (made by
// hand as postgres: backfill_mod_to_acct_transfers_summarized, check_mod_to_acct_transfers_summarized_gaps) would fail
// the start, so it is skipped with a warning and dropped by hand with the tables.
export const RAW_TRANSFER_READERS = [
  "get_rewards_group_by_address_and_date",
  "get_mint_breakdown_between_dates_v2",
  "backfill_mod_to_acct_transfers_summarized",
  "check_mod_to_acct_transfers_summarized_gaps",
];

export function dropRawTransferReadersFn(dbSchema: string): string {
  return `
DO $$
DECLARE f record;
BEGIN
  FOR f IN SELECT p.oid::regprocedure sig, pg_has_role(current_user, p.proowner, 'USAGE') own FROM pg_proc p
           WHERE p.pronamespace = '${dbSchema}'::regnamespace
             AND p.proname = ANY(ARRAY[${RAW_TRANSFER_READERS.map((n) => `'${n}'`).join(", ")}]) LOOP
    IF f.own THEN
      EXECUTE format('DROP FUNCTION %s', f.sig);
    ELSE
      RAISE WARNING '% reads the dropped mod_to_acct_transfers and is not owned by %: drop it by hand', f.sig, current_user;
    END IF;
  END LOOP;
END $$;
`;
}
