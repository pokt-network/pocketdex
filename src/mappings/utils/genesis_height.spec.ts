// Unit tests for the genesis initial_height parsing. Run with
//   yarn test:unit
/* eslint-disable @typescript-eslint/no-floating-promises */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { genesisInitialHeight } from "./genesis_height";

describe("genesisInitialHeight", () => {
  it("accepts a number or a numeric string, with 0 meaning 1", () => {
    assert.equal(genesisInitialHeight(1), 1);
    assert.equal(genesisInitialHeight(0), 1);
    assert.equal(genesisInitialHeight("1"), 1); // a node's /genesis
    assert.equal(genesisInitialHeight("0"), 1);
    assert.equal(genesisInitialHeight("3000"), 3000);
  });

  it("throws on anything else instead of skipping the genesis", () => {
    for (const bad of [undefined, null, "", " ", "1.5", "-1", -1, 1.5, "abc", {}, true]) {
      assert.throws(() => genesisInitialHeight(bad), /invalid genesis initial_height/);
    }
  });
});
