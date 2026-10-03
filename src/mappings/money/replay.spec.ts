/* eslint-disable @typescript-eslint/no-floating-promises */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import * as zlib from "node:zlib";
import { fromBech32, toBech32 } from "@cosmjs/encoding";
import type { SettlementPayload } from "./payload";
import {
  addReplay,
  byPower,
  collectStakes,
  Family,
  largestRemainder,
  replayD,
  replayM3,
  replayMap,
  ReplayValidator,
  tokensFromShares,
} from "./replay";

const DEC = BigInt("1000000000000000000");
const n = (x: number | string) => BigInt(x);

// an operator whose raw bytes are `byte` repeated, and its account
const operator = (byte: number) => toBech32("poktvaloper", new Uint8Array(20).fill(byte));
const account = (op: string) => toBech32("pokt", fromBech32(op).data);
const delegator = (byte: number) => toBech32("pokt", new Uint8Array(20).fill(byte));

function validator(
  byte: number,
  tokens: number,
  delegations: Array<[number, number]>,
  sharesPerToken = 1
): ReplayValidator {
  const op = operator(byte);
  return {
    operator: op,
    account: account(op),
    tokens: n(tokens),
    delegatorShares: n(tokens) * n(sharesPerToken) * DEC,
    delegations: delegations.map(([d, t]) => ({ delegator: delegator(d), shares: n(t) * n(sharesPerToken) * DEC })),
  };
}

describe("validator replay (288,180–788,944)", () => {
  it("converts shares to tokens as the SDK's LegacyDec does, banker's rounding included", () => {
    // 1:1
    assert.equal(tokensFromShares(n(500) * DEC, n(1000), n(1000) * DEC), n(500));
    // a slashed validator: 1000 shares now worth 999 tokens; 1 share is 0.999 tokens, truncated to 0
    assert.equal(tokensFromShares(DEC, n(999), n(1000) * DEC), n(0));
    assert.equal(tokensFromShares(n(1000) * DEC, n(999), n(1000) * DEC), n(999));
    // exactly .5 at the 18th decimal rounds to even before the truncation: 1 share × 1 token / 2e18 shares
    assert.equal(tokensFromShares(n(1), n(1), n(2) * DEC), n(0));
  });

  it("rounds a quotient ending in exactly .5 at the 18th decimal to even: up when odd, down when even", () => {
    // 1 share × (2e18 − 1) tokens / 2e18 shares = 0.9999999999999999995: the quotient 999…999 (odd) rounds up to 1
    assert.equal(tokensFromShares(DEC, DEC * n(2) - n(1), DEC * DEC * n(2)), n(1));
    // 1 share × (2e18 − 3) tokens / 2e18 shares = 0.9999999999999999985: 999…998 (even) stays, truncated to 0
    assert.equal(tokensFromShares(DEC, DEC * n(2) - n(3), DEC * DEC * n(2)), n(0));
  });

  it("orders validators by consensus power, then by the operator's bytes, not by tokens or bech32", () => {
    // same power (2,010,000), tokens differing below 1e6: the lower bytes go first whatever the tokens
    const a = validator(0x39, 2_010_000_260_000, []);
    const b = validator(0x13, 2_010_000_200_000, []);
    const c = validator(0x01, 5_000_000_000_000, []);
    assert.deepEqual(
      byPower([a, b, c]).map((v) => v.operator),
      [c.operator, b.operator, a.operator]
    );
  });

  it("largest remainder: R below the number of stakeholders, a zero fraction, and a remainder nobody can take", () => {
    // R = 2 over three equal stakes: base 0 each, the remainder 2 goes to the two lowest keys (equal fractions)
    const three = new Map([
      ["c", n(1)],
      ["a", n(1)],
      ["b", n(1)],
    ]);
    assert.deepEqual([...largestRemainder(three, n(3), n(2))].sort(), [
      ["a", n(1)],
      ["b", n(1)],
      ["c", n(0)],
    ]);
    // a key whose share is exact has no fraction and gets no remainder unit
    const exact = new Map([
      ["x", n(50)],
      ["y", n(25)],
      ["z", n(25)],
    ]);
    assert.deepEqual([...largestRemainder(exact, n(100), n(3))].sort(), [
      ["x", n(1)],
      ["y", n(1)],
      ["z", n(1)],
    ]);
    // stakes summing to less than the total (the overwrite) with no fraction: the remainder stays unpaid
    const short = new Map([["a", n(50)]]);
    assert.deepEqual([...largestRemainder(short, n(100), n(2))], [["a", n(1)]]);
    // the remainder is spread floor(rem / n) each, one more to the first rem mod n
    const big = new Map([
      ["a", n(1)],
      ["b", n(1)],
    ]);
    // 2.5 each: base 2 + 2, remainder 21 over two keys, 10 each and the extra unit to "a"
    assert.deepEqual(Object.fromEntries(largestRemainder(big, n(10), n(25))), { a: n(13), b: n(12) });
  });

  it("a validator's account that delegates elsewhere: the last delegation wins in M4/M5, they add up in D", () => {
    const v1 = validator(0x01, 3_000_000_000, [[0x20, 2_000_000_000]]);
    const v2 = validator(0x02, 1_000_000_000, [[0x20, 1_000_000_000]]);
    const over = collectStakes([v2, v1], false).stakes.get(delegator(0x20));
    // v1 has the larger power, so v2's delegation comes last and replaces it
    assert.deepEqual(over && [over.stake, [...over.byValidator]], [
      n(1_000_000_000),
      [[v2.operator, n(1_000_000_000)]],
    ]);
    const sum = collectStakes([v2, v1], true).stakes.get(delegator(0x20));
    assert.equal(sum?.stake, n(3_000_000_000));
    assert.deepEqual(Object.fromEntries(sum?.byValidator ?? []), {
      [v1.operator]: n(2_000_000_000),
      [v2.operator]: n(1_000_000_000),
    });
  });

  it("D: a validator with no delegations assigns its account's stake, replacing what that account had accumulated", () => {
    const v2 = validator(0x02, 500, []);
    // the account of v2 delegates to v1, which comes first by power; then v2's own branch assigns its tokens
    const v1 = validator(0x01, 5000, [[0x60, 4000]]);
    v1.delegations = [...v1.delegations, { delegator: v2.account, shares: n(1000) * DEC }];
    const s2 = collectStakes([v1, v2], true).stakes.get(v2.account);
    assert.equal(s2?.stake, n(500));
    assert.deepEqual(Object.fromEntries(s2?.byValidator ?? []), { [v2.operator]: n(500) });
  });

  it("a bonded validator with zero tokens adds nothing to the total and pays none of its delegators", () => {
    const zero = validator(0x03, 0, []);
    zero.delegatorShares = n(10) * DEC;
    zero.delegations = [{ delegator: delegator(0x70), shares: n(10) * DEC }];
    const r = collectStakes([validator(0x01, 100, [[0x71, 100]]), zero], false);
    assert.equal(r.total, n(100));
    assert.equal(r.stakes.has(delegator(0x70)), false);
  });

  it("checks the LCD's delegation balance against TokensFromShares for a slashed validator", () => {
    const slashed = validator(0x05, 999, [[0x30, 1000]]);
    slashed.delegatorShares = n(1000) * DEC;
    slashed.delegations = [{ delegator: delegator(0x30), shares: n(1000) * DEC, balance: n(999) }];
    assert.equal(collectStakes([slashed], false).stakes.get(delegator(0x30))?.stake, n(999));
    slashed.delegations = [{ delegator: delegator(0x30), shares: n(1000) * DEC, balance: n(1000) }];
    assert.throws(() => collectStakes([slashed], false), /the LCD's balance 1000 differs from TokensFromShares 999/);
  });

  it("M3 pays the proposer's operator everything, with no commission", () => {
    const p = validator(0x09, 10, []);
    const r = replayM3(p, new Map([["relay", n(77)]]));
    assert.deepEqual(r.dv, [
      { delegator: p.account, validator_operator: p.operator, family: "relay", amount: "77", row_source: "replay" },
    ]);
    assert.equal(r.vrd.length, 1);
    assert.equal(r.vrd[0].commission, null);
    assert.equal(r.vrd[0].commission_rate, null);
    assert.equal(r.vrd[0].pool_share, "77");
    assert.equal(r.vrd[0].self_delegation, "77");
    assert.ok(r.vrd[0].event_idx < 0);
  });

  it("M4/M5 replays each claim against its legs, and an unreproduced claim leaves the family unattributed", () => {
    const v1 = validator(0x01, 3000, [
      [0x40, 2000],
      [0x41, 1000],
    ]);
    const v2 = validator(0x02, 1000, []);
    const stakes = collectStakes([v1, v2], false);
    const legsOf = (r: number) => {
      const got = largestRemainder(new Map([...stakes.stakes].map(([a, s]) => [a, s.stake])), stakes.total, n(r));
      return new Map([...got].filter(([, x]) => x > n(0)));
    };
    const claims = [7, 3].map((r, i) => ({
      event_idx: i,
      reward: new Map<Family, bigint>([["relay", n(r)]]),
      legs: new Map<Family, Map<string, bigint>>([["relay", legsOf(r)]]),
    }));
    const ok = replayMap(1, claims, [v1, v2]);
    assert.equal(ok.modes.get("relay")?.mode, "replay");
    assert.equal(
      ok.dv.reduce((a, x) => a + BigInt(x.amount), n(0)),
      n(10)
    );
    // R = 7 over stakes 2000 / 1000 / 1000 of 4000: 3, 1, 1 and the remainder 2 to the two 0.75 fractions; R = 3:
    // 1, 0, 0 and the remainder to the same two. v1's two delegators get 4 and 3, v2's own account 3
    assert.deepEqual(
      ok.vrd.map((v) => [v.validator_operator, v.pool_share, v.self_delegation, v.num_delegators]),
      [
        [v1.operator, "7", "0", "2"],
        [v2.operator, "3", "3", "0"],
      ]
    );
    // one leg one unit off: nothing is attributed, the chain's amounts are kept with validator ''
    const bad = claims.map((c) => ({ ...c, legs: new Map(c.legs) }));
    const legs = new Map(bad[1].legs.get("relay"));
    const [first] = legs.keys();
    legs.set(first, (legs.get(first) as bigint) + n(1));
    bad[1].legs.set("relay", legs);
    // a share the chain paid nobody is a difference too, never skipped
    const unpaid = replayMap(1, [{ ...claims[0], legs: new Map() }], [v1, v2]);
    assert.equal(unpaid.modes.get("relay")?.mode, "unattributed");
    assert.equal(unpaid.modes.get("relay")?.amount, n(0));
    const un = replayMap(1, bad, [v1, v2]);
    assert.equal(un.modes.get("relay")?.mode, "unattributed");
    assert.match(un.modes.get("relay")?.reason ?? "", /height 1 event 1 relay/);
    assert.equal(un.vrd.length, 0);
    assert.ok(un.dv.every((x) => x.validator_operator === "" && x.row_source === "unattributed"));
    assert.equal(
      un.dv.reduce((a, x) => a + BigInt(x.amount), n(0)),
      n(11)
    );
  });

  it("D replays each family once per height, splits each address over its validators summing to its amount", () => {
    const v1 = validator(0x01, 3001, [
      [0x50, 2001],
      [0x51, 1000],
    ]);
    const v2 = validator(0x02, 1002, [
      [0x50, 1001],
      [0x02, 1],
    ]);
    // the validator 0x02 delegates 1 token to itself through its account; 0x50 delegates to both
    v2.delegations = [
      { delegator: delegator(0x50), shares: n(1001) * DEC },
      { delegator: account(v2.operator), shares: n(1) * DEC },
    ];
    const stakes = collectStakes([v1, v2], true);
    const weights = new Map([...stakes.stakes].map(([a, s]) => [a, s.stake]));
    const batchOf = (r: number) =>
      new Map([...largestRemainder(weights, stakes.total, n(r))].filter(([, x]) => x > n(0)));
    const reward = new Map<Family, bigint>([
      ["global", n(5)],
      ["relay", n(1001)],
    ]);
    const batch = new Map<Family, Map<string, bigint>>([
      ["relay", batchOf(1001)],
      ["global", batchOf(5)],
    ]);
    const r = replayD(9, reward, batch, [v1, v2]);
    for (const family of ["relay", "global"] as const) {
      assert.equal(r.modes.get(family)?.mode, "derived_split", family);
      // Σ over validators of each address's split = its batch amount
      const per = new Map<string, bigint>();
      for (const x of r.dv.filter((d) => d.family === family)) {
        per.set(x.delegator, (per.get(x.delegator) ?? n(0)) + BigInt(x.amount));
      }
      assert.deepEqual([...per].sort(), [...(batch.get(family) as Map<string, bigint>)].sort(), family);
    }
    // the address on two validators is split between them
    assert.equal(r.dv.filter((d) => d.family === "relay" && d.delegator === delegator(0x50)).length, 2);
    // the order the families come in changes no amount
    const swapped = replayD(9, new Map([...reward].reverse()), new Map([...batch].reverse()), [v2, v1]);
    const sorted = (x: typeof r) =>
      JSON.stringify([
        [...x.dv].sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1)),
        x.vrd.map((v) => ({ ...v, event_idx: 0 })).sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1)),
      ]);
    assert.equal(sorted(swapped), sorted(r));
    // a batch that differs leaves that family unattributed, the other one derived
    const off = new Map(batch);
    off.set("global", new Map([[delegator(0x51), n(5)]]));
    const mixed = replayD(9, reward, off, [v1, v2]);
    assert.deepEqual(
      [mixed.modes.get("relay")?.mode, mixed.modes.get("global")?.mode],
      ["derived_split", "unattributed"]
    );
  });
});

// The replay inputs of real heights (.local/ab/money/replay/check_replay.ts: the snapshot from sauron's LCD at the
// height, legs and R from the block): M3 288,213 and 350,013; M4 382,293, 430,053 (two validators of equal power)
// and 500,013 (v0.1.30); M5 636,573 and 699,993; D 703,893, 750,033 and 788,913. M4/M5 keep their first 40 claims.
describe("validator replay on mainnet heights", () => {
  const FIXTURES = path.join(__dirname, "../../../test/money/fixtures");
  // entry lists back to Maps and digit strings back to bigints, the shapes the input had
  const revive = (key: string, v: unknown): unknown => {
    if (["tokens", "delegatorShares", "shares", "balance"].includes(key) && typeof v === "string") return BigInt(v);
    if ((key === "reward" || key === "legs") && Array.isArray(v)) {
      return new Map(
        (v as Array<[string, unknown]>).map(([k, x]) => [
          k,
          Array.isArray(x)
            ? new Map((x as Array<[string, string]>).map(([a, b]) => [a, BigInt(b)]))
            : BigInt(x as string),
        ])
      );
    }
    return v;
  };
  for (const h of [288213, 350013, 382293, 430053, 500013, 636573, 699993, 703893, 750033, 788913]) {
    it(`${h} replays every family, with no unattributed amount`, () => {
      const fx = JSON.parse(
        zlib.gunzipSync(fs.readFileSync(path.join(FIXTURES, `replay_${h}.json.gz`))).toString(),
        revive
      ) as {
        era: string;
        input: Parameters<typeof addReplay>[2];
        batch?: SettlementPayload["batch"];
        claims?: SettlementPayload["claims"];
      };
      const payload = {
        era: fx.era,
        claims: fx.claims ?? [],
        batch: fx.batch ?? [],
        vrd: [],
        dv: [],
      } as unknown as SettlementPayload;
      const modes = addReplay(h, payload, fx.input);
      // the gate: every family reproduced, none written unattributed
      assert.ok(modes.size > 0);
      for (const [family, m] of modes) {
        assert.equal(m.mode, fx.era === "detailed_batch" ? "derived_split" : "replay", `${family}: ${m.reason ?? ""}`);
        const dv = payload.dv.filter((d) => d.family === family).reduce((a, d) => a + BigInt(d.amount), n(0));
        const pools = payload.vrd.filter((v) => v.family === family).reduce((a, v) => a + BigInt(v.pool_share), n(0));
        assert.equal(dv, m.amount);
        assert.equal(pools, m.amount);
      }
      assert.ok(payload.vrd.every((v) => v.commission === null && v.commission_rate === null && v.event_idx < 0));
      if (h === 430053) {
        // equal power: the operator with the lower bytes (zdyj…) comes first, 18808… last, so a delegator of both is
        // paid through its delegation to 18808…
        const both = payload.dv.filter((d) => d.delegator.startsWith("pokt1ym80acz6s"));
        assert.ok(both.length > 0);
        assert.ok(both.every((d) => d.validator_operator.startsWith("poktvaloper18808")));
      }
    });
  }
});
