// A field added to an entity that existed in a deployed version never reaches the databases indexed with it
// (SubQuery only migrates on a deployment change), so it must be listed in ADDED_ENTITY_COLUMNS, which adds it at
// start. fixtures/entity_fields_4227989.json is schema.graphql as deployed on 2026-10-03 (main 4227989), before #96.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { ADDED_ENTITY_COLUMNS, addEntityColumnsFn } from "./entityColumns";
import { entityFields } from "./entityFields";

const ROOT = path.join(__dirname, "..", "..", "..");
const deployed = JSON.parse(
  fs.readFileSync(path.join(__dirname, "fixtures", "entity_fields_4227989.json"), "utf8")
) as Record<string, string[]>;
const current = entityFields(fs.readFileSync(path.join(ROOT, "schema.graphql"), "utf8"));
const snake = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();

describe("entity fields added after a deployment", () => {
  it("reads every entity of both schemas", () => {
    assert.equal(Object.keys(deployed).length, 72);
    assert.ok(current.Validator.includes("delegatorShares"));
    assert.ok(!deployed.Validator.includes("delegatorShares"));
    assert.ok(current.Delegation, "Delegation is new, so SubQuery creates its table");
  });

  it("lists, to be added at start, every field added to an entity that was already deployed", () => {
    const added = Object.entries(deployed).flatMap(([entity, fields]) =>
      (current[entity] ?? []).filter((f) => !fields.includes(f)).map((f) => `${entity}.${f}`)
    );
    assert.deepEqual(added.sort(), ADDED_ENTITY_COLUMNS.map((c) => `${c.entity}.${c.field}`).sort());
  });

  it("adds each listed field under the column SubQuery gives it, idempotently", () => {
    for (const c of ADDED_ENTITY_COLUMNS) assert.equal(c.column, snake(c.field));
    const sql = addEntityColumnsFn("beta");
    assert.match(sql, /table_schema = 'beta' AND table_name = 'validators' AND column_name = 'delegator_shares'/);
    assert.match(sql, /ALTER TABLE beta\.validators ADD COLUMN IF NOT EXISTS delegator_shares text;/);
  });
});
