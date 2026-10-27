// The old GraphQL functions that a catalog function, or an entity the schema keeps, now replaces: marked @deprecated so
// introspection, GraphiQL and generated clients show them with their replacement (docs/graphql-migration.md). They keep
// answering as before. subql-query 2.22.2 honours @deprecated in a function's comment (measured on a local copy,
// 2026-10-14, when #112 marked the functions it replaced the same way).

export const MIGRATION_DOC = "https://github.com/pokt-network/pocketdex/blob/main/docs/graphql-migration.md";

// each old function, by name (every overload), with what replaces it
export const DEPRECATED_OLD_FUNCTIONS: Record<string, string> = {
  get_total_supply_by_day: "getSupplyList or getSupplyJson (bucket day)",
  get_total_supply_between_dates:
    "getSupplyList or getSupplyJson with bucket year, its newest row (the range's last point; GraphQL drops an explicit bucket: null and applies the default day)",
  get_supply_composition_between_dates:
    "getSupplyCompositionList or getSupplyCompositionJson (and getSupplyList for the totals; getSupplyCompositionAtList for one block)",
  get_amount_of_blocks_and_suppliers_by_times: "getStakedSuppliersByServiceList or getStakedSuppliersByServiceJson",
  get_rewards_by_date: "getNetworkRewardsList or getNetworkRewardsJson",
  get_claim_proofs_data_by_time: "getNetworkClaimsList or getNetworkClaimsJson",
  get_overserviced_by_addresses_and_time: "getOverservicedList or getOverservicedJson",
  get_rewards_by_domains_and_time_group_by_service: "getDomainServiceRewardsList or getDomainServiceRewardsJson",
  get_missing_validator_blocks: "getValidatorBlocksList with kind missed",
  get_produced_blocks_by_validator: "getValidatorBlocksList with kind produced",
  get_latest_blocks_by_day:
    "getBlockStatsJson with bucket day (last_height of each day), then blocks filtered by those ids",
  get_dao_balance_at_height: "balances with blockHeight and the DAO address as accountId",
  get_compute_units_to_tokens_multiplier_evolution:
    "getParamHistoryList with namespaces [shared] and keys [compute_units_to_tokens_multiplier]",
  get_relays_by_service_per_point_json: "getServiceUsageJson with a bucket",
};

export const deprecatedTag = (replacement: string): string =>
  `@deprecated Will be removed from the schema. Use ${replacement}. See ${MIGRATION_DOC}`;

// Puts the @deprecated line first in each comment (an earlier one replaced) and keeps the rest. The old functions
// rewrite their own comments on every start, so this runs after them, in the same transaction (index.ts), and writes
// only the comments that change: each COMMENT locks its object. Missing functions are skipped.
export function createDeprecationsFn(dbSchema: string): string {
  const s = dbSchema;
  const q = (t: string) => `'${t.replace(/'/g, "''")}'`;
  const values = Object.entries(DEPRECATED_OLD_FUNCTIONS)
    .map(([name, use]) => `(${q(name)}, ${q(deprecatedTag(use))})`)
    .join(", ");
  return `
DO $$
DECLARE r record; c text;
BEGIN
  FOR r IN SELECT p.oid::regprocedure f, d.tag, obj_description(p.oid, 'pg_proc') old FROM pg_proc p
           JOIN (VALUES ${values}) d(name, tag) ON d.name = p.proname
           WHERE p.pronamespace = '${s}'::regnamespace LOOP
    c := r.tag || coalesce(E'\\n' || nullif(regexp_replace(coalesce(r.old, ''), '^@deprecated[^\\n]*(\\n|$)', ''), ''), '');
    IF r.old IS DISTINCT FROM c THEN
      EXECUTE format('COMMENT ON FUNCTION %s IS %L', r.f, c);
    END IF;
  END LOOP;
END $$;
`;
}
