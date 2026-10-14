// Every described table is an entity of schema.graphql, and its columns are exactly that entity's stored fields as
// SubQuery names them (snake_case; a relation to another entity is <field>_id): a renamed or added field fails here
// instead of leaving a column undescribed or a description on nothing.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { createEntityDescriptionsFn, ENTITY_DESCRIPTIONS } from "./entityDescriptions";

const schema = fs.readFileSync(path.join(__dirname, "..", "..", "..", "schema.graphql"), "utf8");
const snake = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
const entities = new Set([...schema.matchAll(/^type\s+(\w+)\s+@entity/gm)].map((m) => m[1]));
const columns: Record<string, string[]> = {};
for (const m of schema.matchAll(/^type\s+(\w+)\s+@entity\b[^{]*\{([\s\S]*?)^\}/gm)) {
  columns[m[1]] = m[2]
    .split("\n")
    .map((l) => l.replace(/#.*/, "").trim())
    .filter((l) => /^\w+\s*:/.test(l) && !l.includes("@derivedFrom"))
    .map((l) => {
      const [name, type] = l.split(":").map((x) => x.trim());
      const base = type.replace(/[[\]!]/g, " ").trim().split(/\s+/)[0];
      return `${snake(name)}${entities.has(base) ? "_id" : ""}`;
    })
    .sort();
}
// SubQuery's table name: snake_case of the entity, pluralised
const tableOf: Record<string, string> = {};
for (const e of entities) {
  const t = snake(e);
  for (const p of [`${t}s`, `${t}es`, t.replace(/y$/, "ies")]) tableOf[p] = e;
}

describe("entity descriptions", () => {
  it("describe every stored column of each described entity, and nothing else", () => {
    assert.equal(Object.keys(ENTITY_DESCRIPTIONS).length, 17);
    for (const [table, d] of Object.entries(ENTITY_DESCRIPTIONS)) {
      const entity = tableOf[table];
      assert.ok(entity, `${table} is no entity table`);
      assert.deepEqual([table, Object.keys(d.columns).sort()], [table, columns[entity]]);
      assert.ok(d.table.length > 0 && Object.values(d.columns).every((w) => w.length > 0), table);
    }
  });

  it("writes the table description after the smart tags and skips what the database lacks", () => {
    const sql = createEntityDescriptionsFn("beta");
    assert.match(sql, /WHERE l ~ '\^@'/);
    assert.match(sql, /JOIN information_schema\.columns c ON c\.table_schema = 'beta'/);
    assert.match(sql, /\('suppliers', 'owner_id', 'Owner address \(Account id\)/);
  });
});
