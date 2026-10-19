// The GraphQL API as subql-query serves it, checked by introspection. Run with
//   GRAPHQL_URL=http://127.0.0.1:3000/graphql yarn test:graphql
// against a subql-query over a database that has done this release's startup. Without GRAPHQL_URL the run fails: a
// check that skips itself is a check that never runs.
//
// It fails when: an entity has a relation to another one, a root field is neither an entity, a function nor one of
// subql-query's own, an entity or function field has no description, or a table the release hides comes back.
import assert from "node:assert/strict";
import { before, describe, it } from "node:test";

interface TypeRef {
  kind: string;
  name: string | null;
  ofType: TypeRef | null;
}
interface Field {
  name: string;
  description: string | null;
  type: TypeRef;
}
interface GqlType {
  kind: string;
  name: string;
  fields: Field[] | null;
}

const QUERY = `{ __schema { types { kind name fields(includeDeprecated: true) { name description type { kind name ofType { kind name ofType { kind name ofType { kind name } } } } } } } }`;

const ENTITY_TYPES = [
  "Account",
  "Application",
  "ApplicationGateway",
  "ApplicationService",
  "Authz",
  "Balance",
  "Block",
  "BlockMetadatum",
  "BlockSupply",
  "Gateway",
  "MorseClaimableAccount",
  "NativeTransfer",
  "Param",
  "Service",
  "Supplier",
  "SupplierServiceConfig",
  "Supply",
  "Transaction",
  "Validator",
];
// subql-query's own, which no comment in the database can describe or hide
const OWN_ROOTS = new Set(["query", "node", "nodeId", "_metadata", "_metadatas"]);
const FUNCTION_ROOT = /^(get[A-Z]|legacy[A-Z]|moneyCoverage|servicesPerformance)/;
const HIDDEN_ROOTS =
  /^(event|msg|modToAcct|relay|domainServiceDaily|delegation|moduleAccount|genesis|supplyDenom|validatorCommission|validatorReward|messages?$|events?$)/;

const baseName = (t: TypeRef): string | null => (t.ofType ? baseName(t.ofType) : t.name);

describe("closed GraphQL schema (introspection)", () => {
  const types = new Map<string, GqlType>();

  before(async () => {
    const url = process.env.GRAPHQL_URL;
    assert.ok(url, "GRAPHQL_URL is not set: point it at a subql-query over a database that did this release's startup");
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: QUERY }),
    });
    const body = (await res.json()) as { data: { __schema: { types: GqlType[] } } };
    for (const t of body.data.__schema.types) types.set(t.name, t);
  });

  const rootFields = (): Field[] => types.get("Query")?.fields ?? [];
  const isEntity = (t: GqlType) => t.kind === "OBJECT" && (t.fields ?? []).some((f) => f.name === "nodeId");

  it("has exactly the 19 basic entity types", () => {
    const got = [...types.values()]
      .filter((t) => isEntity(t) && t.name !== "Query")
      .map((t) => t.name)
      .sort();
    assert.deepEqual(got, [...ENTITY_TYPES].sort());
  });

  it("gives no entity a relation: no field of an entity returns another object type", () => {
    for (const t of types.values()) {
      if (!isEntity(t) || t.name === "Query") continue;
      for (const f of t.fields ?? []) {
        const base = baseName(f.type);
        const target = base ? types.get(base) : undefined;
        assert.ok(!target || target.kind !== "OBJECT", `${t.name}.${f.name} returns ${base}`);
      }
    }
  });

  it("serves only entities, functions and subql-query's own root fields", () => {
    for (const f of rootFields()) {
      const base = baseName(f.type) ?? "";
      const entityRoot = ENTITY_TYPES.includes(base) || base.endsWith("Connection") || f.name.endsWith("ByNodeId");
      assert.ok(
        OWN_ROOTS.has(f.name) || FUNCTION_ROOT.test(f.name) || entityRoot,
        `Query.${f.name} is neither an entity, a function nor subql-query's own`
      );
      assert.ok(!HIDDEN_ROOTS.test(f.name), `Query.${f.name} is a table the release hides`);
    }
  });

  it("describes every function root field and every field of every entity", () => {
    const missing: string[] = [];
    for (const f of rootFields()) {
      if (FUNCTION_ROOT.test(f.name) && !(f.description ?? "").trim()) missing.push(`Query.${f.name}`);
    }
    for (const t of types.values()) {
      if (!isEntity(t) || t.name === "Query") continue;
      for (const f of t.fields ?? []) {
        if (f.name !== "nodeId" && !(f.description ?? "").trim()) missing.push(`${t.name}.${f.name}`);
      }
    }
    assert.deepEqual(missing, []);
  });
});
