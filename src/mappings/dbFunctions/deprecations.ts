// What the GraphQL schema will lose, marked @deprecated so introspection, GraphiQL and generated clients show it with
// its replacement (docs/graphql-migration.md). Written by createDeprecationsFn at start, after every table and function
// it names exists. What subql-query 2.22.2 honours (measured on a local copy, 2026-10-14): @deprecated in a table's
// comment deprecates its list, its ...ByNodeId and the relations into it, but not its lookup by key; in a function's
// comment, the function; as |@deprecated in a @foreignKey spec, the forward relation (the entity tables that stay get it
// from createEntityDescriptionsFn). Backward relations between tables that stay, aggregates, filters through a relation
// and node / nodeId cannot be marked: the migration doc announces them.

import { LEGACY_REPLACES } from "./settlement/smartTags";

export const MIGRATION_DOC = "https://github.com/pokt-network/pocketdex/blob/main/docs/graphql-migration.md";

// the GraphQL lists exposed on mainnet (2026-10-14) that go, by table, with their replacement
export const DEPRECATED_TABLES: Record<string, string> = {
  event_claim_settleds: "getClaimsList or getClaimsJson; sums in getSupplierEarningsJson, getApplicationSpendJson, getGatewaySpendJson, getServiceUsageJson",
  event_claim_expireds: "getClaimsList or getClaimsJson with statuses [expired]; totals in getSupplierPenaltiesJson",
  msg_create_claims: "getCreatedClaimsList",
  msg_submit_proofs: "getSupplierProofsJson",
  event_supplier_slasheds: "getActorLifecycleList with kind supplier and events [slash]; totals in getSupplierPenaltiesJson",
  msg_stake_suppliers: "getActorLifecycleList with kind supplier",
  msg_unstake_suppliers: "getActorLifecycleList with kind supplier",
  event_supplier_unbonding_begins: "getActorLifecycleList with kind supplier",
  event_supplier_unbonding_ends: "getActorLifecycleList with kind supplier",
  msg_stake_applications: "getActorLifecycleList with kind application",
  event_application_unbonding_begins: "getActorLifecycleList with kind application",
  event_application_unbonding_ends: "getActorLifecycleList with kind application",
  msg_stake_gateways: "getActorLifecycleList with kind gateway",
  event_gateway_unbonding_begins: "getActorLifecycleList with kind gateway",
  event_gateway_unbonding_ends: "getActorLifecycleList with kind gateway",
  msg_delegate_to_gateways: "getActorLifecycleList with kind application or gateway and events [delegate, undelegate]",
  msg_undelegate_from_gateways: "getActorLifecycleList with kind application or gateway and events [delegate, undelegate]",
  msg_stake_supplier_services: "supplierServiceConfigs",
  event_relay_mining_difficulty_updateds: "getRelayMiningDifficultyList",
  event_validator_reward_distributions: "getValidatorRewardsJson or getDelegatorIncomeJson",
  event_application_overserviceds: "getApplicationSpendJson",
  mod_to_acct_transfers: "getIncomeJson, getSupplierEarningsJson or getSupplierDistributionJson",
  mod_to_acct_transfers_summarized: "getIncomeJson, getSupplierEarningsJson or getSupplierDistributionJson",
  relay_by_block_and_services: "getServiceUsageJson",
  domain_service_daily_rewards: "getSupplierDomainsList",
  relays: "nothing: the table is empty",
};

const camel = (s: string) => s.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
// the functions that go, with their replacement: each live function a legacy_ one replaces (get_x by legacy_x), and
// get_supplier_stats_by_domains
export const DEPRECATED_FUNCTIONS: Record<string, string> = {
  ...Object.fromEntries(
    Object.keys(LEGACY_REPLACES).map((l) => [`get_${l.slice("legacy_".length)}`, `${camel(l)} (same arguments, the old JSON under data)`])
  ),
  get_supplier_stats_by_domains: "getSupplierFleetList with domains, stakeStatuses [Staked] and bySupplier false",
};

export const deprecatedTag = (replacement: string): string =>
  `@deprecated Will be removed from the schema. Use ${replacement}. See ${MIGRATION_DOC}`;
export const DEPRECATED_RELATION = `@deprecated Relations will be removed from the schema: query the related entity by its key. See ${MIGRATION_DOC}`;

// Puts the @deprecated line first in each comment (any earlier one replaced), keeps the rest, and writes only the
// comments that change: each COMMENT locks its object, and this runs on every start. Missing tables and functions are
// skipped.
export function createDeprecationsFn(dbSchema: string): string {
  const s = dbSchema;
  const q = (t: string) => `'${t.replace(/'/g, "''")}'`;
  const values = (m: Record<string, string>) =>
    Object.entries(m)
      .map(([name, use]) => `(${q(name)}, ${q(deprecatedTag(use))})`)
      .join(", ");
  const tagged = `r.tag || coalesce(E'\\n' || nullif(regexp_replace(coalesce(r.old, ''), '^@deprecated[^\\n]*(\\n|$)', ''), ''), '')`;
  return `
DO $$
DECLARE r record; c text;
BEGIN
  FOR r IN SELECT k.oid::regclass t, d.tag, obj_description(k.oid, 'pg_class') old FROM pg_class k
           JOIN (VALUES ${values(DEPRECATED_TABLES)}) d(name, tag) ON d.name = k.relname
           WHERE k.relnamespace = '${s}'::regnamespace AND k.relkind = 'r' LOOP
    c := ${tagged};
    IF r.old IS DISTINCT FROM c THEN
      EXECUTE format('COMMENT ON TABLE %s IS %L', r.t, c);
    END IF;
  END LOOP;
  FOR r IN SELECT p.oid::regprocedure f, d.tag, obj_description(p.oid, 'pg_proc') old FROM pg_proc p
           JOIN (VALUES ${values(DEPRECATED_FUNCTIONS)}) d(name, tag) ON d.name = p.proname
           WHERE p.pronamespace = '${s}'::regnamespace LOOP
    c := ${tagged};
    IF r.old IS DISTINCT FROM c THEN
      EXECUTE format('COMMENT ON FUNCTION %s IS %L', r.f, c);
    END IF;
  END LOOP;
END $$;
`;
}
