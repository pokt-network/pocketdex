// The closed schema's lists stay consistent with the rest of the code: the exposed entity tables are the described
// ones, and a function it hides is never one the catalog or the legacy_ bridge publishes. The comments it writes are
// tested against a database in test/money/writer.db.spec.ts.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createClosedSchemaFn, EXPOSED_ENTITY_TABLES, OMITTED_OLD_FUNCTIONS } from "./closedSchema";
import { ENTITY_DESCRIPTIONS } from "./entityDescriptions";
import { CATALOG_FUNCTIONS } from "./settlement/functions";
import { LEGACY_REPLACES, STATE_FUNCTIONS } from "./settlement/smartTags";

describe("closed schema", () => {
  it("exposes exactly the entity tables that have a description", () => {
    assert.deepEqual([...EXPOSED_ENTITY_TABLES].sort(), Object.keys(ENTITY_DESCRIPTIONS).sort());
    assert.equal(new Set(EXPOSED_ENTITY_TABLES).size, EXPOSED_ENTITY_TABLES.length);
  });

  it("hides only old functions: none is a catalog, state or legacy_ function, and none is named twice", () => {
    const published = new Set([...CATALOG_FUNCTIONS, ...STATE_FUNCTIONS, ...Object.keys(LEGACY_REPLACES)]);
    for (const f of OMITTED_OLD_FUNCTIONS) {
      assert.match(f, /^get_[a-z0-9_]+$/);
      assert.ok(!published.has(f), `${f} is published by the catalog`);
    }
    assert.equal(new Set(OMITTED_OLD_FUNCTIONS).size, OMITTED_OLD_FUNCTIONS.length);
  });

  it("keeps SubQuery's _metadata and writes in the given schema only", () => {
    const sql = createClosedSchemaFn("beta");
    assert.match(sql, /relname !~ '\^_metadata'/);
    assert.match(sql, /'beta'::regnamespace/);
    assert.ok(!sql.includes("mainnet"));
  });
});
