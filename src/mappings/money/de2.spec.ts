// Unit tests for the delegator × validator split. Run with
//   yarn test:unit
/* eslint-disable @typescript-eslint/no-floating-promises */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import * as zlib from "node:zlib";
import { fromBech32, toBech32 } from "@cosmjs/encoding";
import { addDelegatorValidator, De2Validator, largestRemainder } from "./de2";
import { buildSettlementPayload, RawEvent } from "./payload";

const B = (v: number | string) => BigInt(v);
const E18 = B("1000000000000000000");

describe("largestRemainder", () => {
  it("gives floor shares, then the leftover to the largest remainders, ties by address", () => {
    // 10 over 1:1:1 -> 3 each, 1 left; equal remainders, so the first address in codepoint order gets it
    const got = largestRemainder(
      new Map([
        ["b", B(1)],
        ["a", B(1)],
        ["c", B(1)],
      ]),
      B(10)
    );
    assert.deepEqual([...got].sort(), [
      ["a", B(4)],
      ["b", B(3)],
      ["c", B(3)],
    ]);
    // 7 over 2:1 -> 4.67, 2.33 -> 4 + 2, the larger remainder (2/3) takes the unit
    assert.deepEqual(
      [
        ...largestRemainder(
          new Map([
            ["x", B(2)],
            ["y", B(1)],
          ]),
          B(7)
        ),
      ],
      [
        ["x", B(5)],
        ["y", B(2)],
      ]
    );
  });

  it("splits zero into zeros and refuses to split over a zero total", () => {
    assert.deepEqual([...largestRemainder(new Map([["a", B(0)]]), B(0))], [["a", B(0)]]);
    assert.throws(() => largestRemainder(new Map([["a", B(0)]]), B(5)), /zero total/);
  });
});

function payloadFrom(height: number, events: RawEvent[]) {
  const p = buildSettlementPayload(height, new Date(0), "batched_vrd", events);
  assert.ok(p);
  return p;
}

describe("addDelegatorValidator on mainnet 899,713", () => {
  const fx = JSON.parse(
    zlib.gunzipSync(fs.readFileSync(path.join(__dirname, "fixtures/de2_899713.json.gz"))).toString()
  );
  const validators = (): De2Validator[] =>
    fx.validators.map((v: Record<string, unknown>) => ({
      operator: v.operator,
      account: toBech32("pokt", fromBech32(v.operator as string).data),
      tokens: B(v.tokens as string),
      delegatorShares: B(v.delegator_shares as string),
      rateAtoms: B(v.rate as string),
      delegations: (v.delegations as Array<{ delegator: string; shares: string }>).map((d) => ({
        delegator: d.delegator,
        shares: B(d.shares),
      })),
    }));

  it("matches every validator distribution and every batch recipient (21 validators, 216 recipients, 260 pairs)", () => {
    const p = payloadFrom(fx.height, fx.events);
    addDelegatorValidator(fx.height, p, validators());
    assert.equal(p.vrd.length, 21);
    assert.equal(
      new Set(p.batch.filter((b) => b.role === "validator" || b.role === "delegator").map((b) => b.recipient_id)).size,
      216
    );
    assert.equal(p.dv.length, 260);
  });

  it("fails when the delegations do not produce the amounts the chain paid", () => {
    const tampered = validators();
    const v = tampered.find((x) => x.delegations.length > 1) as De2Validator;
    const moved = v.delegations[0].shares / B(2);
    v.delegations = [
      { ...v.delegations[0], shares: v.delegations[0].shares - moved },
      { ...v.delegations[1], shares: v.delegations[1].shares + moved },
      ...v.delegations.slice(2),
    ];
    assert.throws(
      () => addDelegatorValidator(fx.height, payloadFrom(fx.height, fx.events), tampered),
      /\[de2\] height 899713/
    );
  });

  it("refuses to run without a delegation snapshot when there are staker rewards", () => {
    assert.throws(
      () => addDelegatorValidator(fx.height, payloadFrom(fx.height, fx.events), null),
      /no delegation snapshot/
    );
  });
});

describe("addDelegatorValidator edge cases", () => {
  const q = (v: string) => JSON.stringify(v);
  const batch = (reason: string, recipient: string, amount: string): RawEvent => ({
    type: "pocket.tokenomics.EventSettlementBatch",
    attributes: Object.entries({
      num_claims: "1",
      op_reason: q(reason),
      op_type: q("mod_to_acct"),
      recipient: q(recipient),
      sender_module: q("tokenomics"),
      total_amount: q(`${amount}upokt`),
    }).map(([key, value]) => ({ key, value })),
  });
  const vrd = (
    account: string,
    operator: string,
    pool: string,
    commission: string,
    self: string,
    rate: string
  ): RawEvent => ({
    type: "pocket.tokenomics.EventValidatorRewardDistribution",
    attributes: Object.entries({
      commission_rate: q(rate),
      commission_upokt: q(commission),
      delegators_reward_upokt: q("0"),
      num_delegators: "1",
      op_reason: q("TLM_RELAY_BURN_EQUALS_MINT_VALIDATOR_REWARD_DISTRIBUTION"),
      pool_share_upokt: q(pool),
      self_delegation_reward_upokt: q(self),
      total_delegated_stake_upokt: q("100"),
      validator_account_address: q(account),
      validator_operator_address: q(operator),
    }).map(([key, value]) => ({ key, value })),
  });

  it("a 100% commission keeps the whole pool; an account that is validator and delegator sums both", () => {
    // valA (rate 1) and valB (rate 0) with 50/50 tokens; acctA also delegates to valB
    const vals: De2Validator[] = [
      {
        operator: "valA",
        account: "acctA",
        tokens: B(50),
        delegatorShares: B(50) * E18,
        rateAtoms: E18,
        delegations: [{ delegator: "acctA", shares: B(50) * E18 }],
      },
      {
        operator: "valB",
        account: "acctB",
        tokens: B(50),
        delegatorShares: B(50) * E18,
        rateAtoms: B(0),
        delegations: [
          { delegator: "acctB", shares: B(25) * E18 },
          { delegator: "acctA", shares: B(25) * E18 },
        ],
      },
    ];
    const p = payloadFrom(1, [
      batch("TLM_RELAY_BURN_EQUALS_MINT_VALIDATOR_REWARD_DISTRIBUTION", "acctA", "15"),
      batch("TLM_RELAY_BURN_EQUALS_MINT_VALIDATOR_REWARD_DISTRIBUTION", "acctB", "5"),
      vrd("acctA", "valA", "10", "10", "0", "1.000000000000000000"),
      vrd("acctB", "valB", "10", "0", "5", "0.000000000000000000"),
    ]);
    addDelegatorValidator(1, p, vals);
    assert.deepEqual(p.dv.map((r) => [r.delegator, r.validator_operator, r.amount]).sort(), [
      ["acctA", "valB", "5"],
      ["acctB", "valB", "5"],
    ]);
  });

  it("a settlement with no staker rows writes no pairs and needs no snapshot", () => {
    const p = payloadFrom(1, [batch("TLM_RELAY_BURN_EQUALS_MINT_DAO_REWARD_DISTRIBUTION", "dao", "3")]);
    addDelegatorValidator(1, p, null);
    assert.deepEqual(p.dv, []);
  });
});
