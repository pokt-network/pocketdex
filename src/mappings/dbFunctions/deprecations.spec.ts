// Unit test: the deprecation lists name no table that stays exposed, and every mark parses as one smart tag line (and,
// for a relation, as one |-separated spec part). The comments themselves are checked against PostgreSQL in
// test/money/writer.db.spec.ts.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEPRECATED_FUNCTIONS, DEPRECATED_RELATION, DEPRECATED_TABLES, deprecatedTag } from "./deprecations";
import { ENTITY_DESCRIPTIONS } from "./entityDescriptions";

describe("deprecations", () => {
  it("deprecate no table that stays, the nine live functions legacy_ replaces, and fit one tag line", () => {
    assert.deepEqual(Object.keys(DEPRECATED_TABLES).filter((t) => t in ENTITY_DESCRIPTIONS), []);
    assert.equal(Object.keys(DEPRECATED_FUNCTIONS).length, 10);
    assert.equal(DEPRECATED_FUNCTIONS.get_rewards_by_addresses_and_time, "legacyRewardsByAddressesAndTime (same arguments, the old JSON under data)");
    for (const tag of [DEPRECATED_RELATION, ...Object.values({ ...DEPRECATED_TABLES, ...DEPRECATED_FUNCTIONS }).map(deprecatedTag)]) {
      assert.match(tag, /^@deprecated \S/);
      assert.doesNotMatch(tag, /[|\n']/, tag);
    }
  });
});
