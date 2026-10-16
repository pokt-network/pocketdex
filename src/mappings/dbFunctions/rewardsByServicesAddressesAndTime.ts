// Used to get the proof, claim and slash data between block timestamps and for the list of delegator addresses. It
// answers from the money tables, through its legacy_* twin (see rewardsByAddressesAndTime.ts): the same services (those of
// the suppliers the addresses share revenue with, zeros for the ones with no reward in the range) and the same
// net_rewards. gross_rewards, relays, estimated_relays, computed_units and estimated_computed_units are NOT the same: the
// old body added a claim once per transfer it produced, the twin counts each claim once (LEGACY_DIFFERS in smartTags.ts).
export function getRewardsByDelegatorAddressesAndTimesGroupByServiceFn (dbSchema: string): string {
  return `CREATE OR REPLACE FUNCTION ${dbSchema}.get_rewards_by_addresses_and_time_group_by_service(
  addresses TEXT[],
  start_ts TIMESTAMP,
  end_ts TIMESTAMP
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
AS $$
BEGIN
  RETURN (${dbSchema}.legacy_rewards_by_addresses_and_time_group_by_service(addresses, start_ts, end_ts)->>'data')::jsonb;
END;
$$;
`
}
