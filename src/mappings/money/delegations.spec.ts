// Unit tests for the delegation history helpers. Run with
//   yarn test:unit
/* eslint-disable @typescript-eslint/no-floating-promises */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { diffDelegations, stakingEventValidators } from "./delegations";

const ev = (type: string, attrs: Record<string, string>) => ({
  type,
  attributes: Object.entries(attrs).map(([key, value]) => ({ key, value })),
});

describe("stakingEventValidators", () => {
  it("collects the validators the staking events name, including both sides of a redelegation", () => {
    const got = stakingEventValidators([
      ev("delegate", { validator: "valA", delegator: "d1", amount: "1upokt", new_shares: "1" }),
      ev("redelegate", { source_validator: "valB", destination_validator: "valC", amount: "1upokt" }),
      ev("unbond", { validator: '"valD"', delegator: "d2" }),
      ev("cancel_unbonding_delegation", { validator: "valE", delegator: "d3" }),
      ev("create_validator", { validator: "valF", amount: "1upokt" }),
      ev("withdraw_rewards", { validator: "valZ", delegator: "d4" }),
      ev("transfer", { recipient: "valY" }),
    ]);
    assert.deepEqual([...got].sort(), ["valA", "valB", "valC", "valD", "valE", "valF"]);
  });
});

describe("diffDelegations", () => {
  const stored = [
    { id: "v-d1", delegator: "d1", shares: "100" },
    { id: "v-d2", delegator: "d2", shares: "200" },
    { id: "v-d3", delegator: "d3", shares: "300" },
  ];

  it("writes nothing when the chain matches the stored rows", () => {
    assert.deepEqual(
      diffDelegations(
        "v",
        [
          { delegator: "d1", shares: "100" },
          { delegator: "d2", shares: "200" },
          { delegator: "d3", shares: "300" },
        ],
        stored
      ),
      { upserts: [], removes: [] }
    );
  });

  it("upserts changed and new delegations and removes the ones the chain no longer returns", () => {
    const d = diffDelegations(
      "v",
      [
        { delegator: "d1", shares: "150" },
        { delegator: "d3", shares: "300" },
        { delegator: "d4", shares: "5" },
      ],
      stored
    );
    assert.deepEqual(d.upserts, [
      { delegator: "d1", shares: "150" },
      { delegator: "d4", shares: "5" },
    ]);
    assert.deepEqual(d.removes, ["v-d2"]);
  });

  it("rejects shares that are not LegacyDec atomics, and a delegator returned twice", () => {
    assert.throws(() => diffDelegations("v", [{ delegator: "d1", shares: "1.5" }], []), /not LegacyDec atomics/);
    assert.throws(() => diffDelegations("v", [{ delegator: "d1", shares: "" }], []), /not LegacyDec atomics/);
    assert.throws(
      () =>
        diffDelegations(
          "v",
          [
            { delegator: "d1", shares: "1" },
            { delegator: "d1", shares: "2" },
          ],
          []
        ),
      /returned twice/
    );
  });
});
