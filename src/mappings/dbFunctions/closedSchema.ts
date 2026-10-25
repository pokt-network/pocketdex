// What the GraphQL API exposes since the schema was closed (docs/graphql-migration.md): the catalog and legacy_
// functions, _metadata, the basic entity tables below and the old functions a consumer still calls. Everything else is
// hidden with @omit, which subql-query reads from the comments; a table created later is hidden too, until it is named
// here. The entity tables lose their relations: the @foreignKey lines SubQuery writes in their comments are removed,
// which removes the forward and the backward fields and the filters through them.
//
// createClosedSchemaFn runs last at start, in the same transaction as the functions that rewrite their own comments
// (supply.ts), so no start publishes anything unhidden. A comment is written only when it changes: each COMMENT locks
// its object, and this runs on every start. Missing functions are skipped, and so is an object the indexer's role does
// not own (a COMMENT on it would fail the start): a warning names it, and it is hidden by hand.

// The entity tables that stay (Jorge, 2026-10-14). delegations and module_accounts are not here: they were hidden
// before and stay hidden.
export const EXPOSED_ENTITY_TABLES = [
  "accounts",
  "balances",
  "blocks",
  "block_metadata",
  "block_supplies",
  "supplies",
  "transactions",
  "native_transfers",
  "params",
  "services",
  "suppliers",
  "supplier_service_configs",
  "applications",
  "application_services",
  "application_gateways",
  "gateways",
  "validators",
  "authzs",
  "morse_claimable_accounts",
];

// Old functions, neither catalog nor legacy_, that no consumer references (the consumers' open PR heads,
// 2026-10-16; .local/consumers/close-schema/RESULT.md): hidden. Most have a legacy_ twin or a catalog function that
// replaces them (docs/graphql-migration.md). A function a consumer still
// calls is not named here and stays exposed: it is a candidate to leave in the next release, decided by measured use.
// Every overload is hidden.
export const OMITTED_OLD_FUNCTIONS = [
  "get_rewards_by_addresses_and_time",
  "get_rewards_by_addresses_and_time_group_by_date",
  "get_rewards_by_addresses_and_time_group_by_address_and_date",
  "get_rewards_by_addresses_and_time_group_by_service",
  "get_rewards_of_addresses_by_suppliers_and_time",
  "get_rewards_by_suppliers_and_time_group_by_address_and_date",
  "get_rewards_by_suppliers_and_time_group_by_service",
  "get_mint_breakdown_between_dates",
  "get_burn_breakdown_between_dates",
  "get_supplier_stats_by_domains",
  "get_mint_breakdown_between_dates_v2",
  "get_rewards_by_domains_and_time_group_by_service_v2",
  "get_data_by_delegator_addresses_and_times_v2",
  "get_monetary_base_by_date",
  "get_rewards_group_by_address_and_date",
  "get_data_by_delegator_addresses_and_times",
  "get_data_by_delegator_addresses_and_blocks",
  "get_claim_proofs_data_by_delegators_and_time",
  "services_performance_between_times",
  // hidden with the rollups' release (2026-10-20): get_staked_suppliers_by_service gives its per-service sums
  "get_suppliers_staked_and_blocks_by_point_json",
];

export function createClosedSchemaFn(dbSchema: string): string {
  const s = dbSchema;
  const list = (names: string[]) => names.map((n) => `'${n}'`).join(", ");
  return `
DO $$
DECLARE r record; c text;
BEGIN
  FOR r IN SELECT k.oid::regclass t, k.relowner AS own, obj_description(k.oid, 'pg_class') old,
                  k.relname = ANY(ARRAY[${list(EXPOSED_ENTITY_TABLES)}]) exposed
           FROM pg_class k
           WHERE k.relnamespace = '${s}'::regnamespace AND k.relkind = 'r' AND k.relname !~ '^_metadata' LOOP
    -- the lines that are not relations, an earlier @omit or @deprecated, then @omit first when not exposed
    c := coalesce((SELECT string_agg(l, E'\\n' ORDER BY i)
                   FROM unnest(string_to_array(coalesce(r.old, ''), E'\\n')) WITH ORDINALITY u(l, i)
                   WHERE l !~ '^@foreignKey' AND l !~ '^@omit$' AND l !~ '^@deprecated'), '');
    IF NOT r.exposed THEN
      c := '@omit' || CASE WHEN c = '' THEN '' ELSE E'\\n' || c END;
    END IF;
    IF r.old IS DISTINCT FROM nullif(c, '') THEN
      IF pg_has_role(r.own, 'USAGE') THEN
        EXECUTE format('COMMENT ON TABLE %s IS %L', r.t, nullif(c, ''));
      ELSE
        RAISE WARNING 'closed schema: table % is owned by %, its comment was not changed', r.t, r.own::regrole;
      END IF;
    END IF;
  END LOOP;
  FOR r IN SELECT p.oid::regprocedure f, p.proowner AS own FROM pg_proc p
           WHERE p.pronamespace = '${s}'::regnamespace AND p.prokind = 'f'
             AND p.proname = ANY(ARRAY[${list(OMITTED_OLD_FUNCTIONS)}])
             AND obj_description(p.oid, 'pg_proc') IS DISTINCT FROM '@omit' LOOP
    IF pg_has_role(r.own, 'USAGE') THEN
      EXECUTE format('COMMENT ON FUNCTION %s IS %L', r.f, '@omit');
    ELSE
      RAISE WARNING 'closed schema: function % is owned by %, it was not hidden', r.f, r.own::regrole;
    END IF;
  END LOOP;
END $$;
`;
}
