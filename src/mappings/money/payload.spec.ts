// Unit tests for the strict settlement payload parser. Run with
//   yarn test:unit
/* eslint-disable @typescript-eslint/no-floating-promises */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import * as zlib from "node:zlib";
import { writeSettlementCalls } from "../dbFunctions/settlement/writer";
import { eraAtHeight } from "../utils/params_history";
import { sha256 } from "@cosmjs/crypto";
import { toBech32 } from "@cosmjs/encoding";
import { MapState, proposerOperatorAccount } from "./map";
import { buildSettlementPayload, estimatedRelays, RawEvent, SettlementPayload } from "./payload";

const q = (v: string) => JSON.stringify(v);

function claimSettled(over: Record<string, string> = {}, detailed?: unknown[]): RawEvent {
  const attrs: Record<string, string> = {
    application_address: q("pokt1app"),
    claimed_upokt: q("1000upokt"),
    settled_upokt: q("1000upokt"),
    minted_upokt: q("975upokt"),
    overservicing_loss_upokt: q("0upokt"),
    deflation_loss_upokt: q("25upokt"),
    num_claimed_compute_units: q("10"),
    num_estimated_compute_units: q("10"),
    num_estimated_relays: q("2"),
    num_relays: q("2"),
    claim_proof_status_int: "0",
    mint_ratio: q("0.975"),
    reward_distribution_detailed: JSON.stringify(
      detailed ?? [
        {
          recipient_address: "pokt1owner",
          op_reason: "TLM_RELAY_BURN_EQUALS_MINT_SUPPLIER_SHAREHOLDER_REWARD_DISTRIBUTION",
          amount: "770upokt",
        },
        {
          recipient_address: "pokt1dao",
          op_reason: "TLM_RELAY_BURN_EQUALS_MINT_DAO_REWARD_DISTRIBUTION",
          amount: "44upokt",
        },
      ]
    ),
    service_id: q("svc"),
    session_end_block_height: q("100"),
    session_id: q("sess"),
    supplier_operator_address: q("pokt1sup"),
    supplier_owner_address: q("pokt1owner"),
    mode: "EndBlock",
    ...over,
  };
  return {
    type: "pocket.tokenomics.EventClaimSettled",
    attributes: Object.entries(attrs).map(([key, value]) => ({ key, value })),
  };
}

function batch(opType: string, opReason: string, amount = "10upokt"): RawEvent {
  const attrs: Record<string, string> = {
    num_claims: "1",
    op_reason: q(opReason),
    op_type: q(opType),
    recipient: q("pokt1x"),
    sender_module: q("tokenomics"),
    session_end_block_height: q("100"),
    total_amount: q(amount),
  };
  return {
    type: "pocket.tokenomics.EventSettlementBatch",
    attributes: Object.entries(attrs).map(([key, value]) => ({ key, value })),
  };
}

const OTHER: RawEvent = { type: "coin_received", attributes: [{ key: "amount", value: "1upokt" }] };
const TS = new Date("2026-10-01T00:00:00Z");

describe("buildSettlementPayload", () => {
  it("returns null for a block with no money events", () => {
    assert.equal(buildSettlementPayload(1, TS, "batched_vrd", [OTHER]), null);
  });

  it("numbers events by their position in finalize_block_events, counting non-money events", () => {
    const p = buildSettlementPayload(1, TS, "batched_vrd", [OTHER, OTHER, claimSettled()])!;
    assert.equal(p.claims[0].event_idx, 2);
    assert.deepEqual(
      p.detailed.map((d) => d.event_idx),
      [2, 2]
    );
    assert.equal(p.claims[0].minted, "975");
    assert.deepEqual(
      p.detailed.map((d) => [d.role, d.family]),
      [
        ["rev_share", "relay"],
        ["dao", "relay"],
      ]
    );
  });

  it("rejects an op_reason it does not know", () => {
    assert.throws(
      () =>
        buildSettlementPayload(1, TS, "batched_vrd", [
          claimSettled({}, [{ recipient_address: "a", op_reason: "TLM_NEW_REASON", amount: "1upokt" }]),
        ]),
      /unknown op_reason "TLM_NEW_REASON"/
    );
    assert.throws(
      () => buildSettlementPayload(1, TS, "batched_vrd", [batch("mod_to_acct", "TLM_NEW_REASON")]),
      /unknown op_reason/
    );
  });

  it("rejects a reason in the wrong place: staker reasons never appear in the claim's detailed list", () => {
    assert.throws(
      () =>
        buildSettlementPayload(1, TS, "batched_vrd", [
          claimSettled({}, [
            {
              recipient_address: "a",
              op_reason: "TLM_RELAY_BURN_EQUALS_MINT_VALIDATOR_REWARD_DISTRIBUTION",
              amount: "1upokt",
            },
          ]),
        ]),
      /not expected in reward_distribution_detailed/
    );
    assert.throws(
      () =>
        buildSettlementPayload(1, TS, "batched_vrd", [
          batch("mint", "TLM_RELAY_BURN_EQUALS_MINT_DAO_REWARD_DISTRIBUTION"),
        ]),
      /op_type mint is not expected/
    );
  });

  it("rejects empty or malformed amounts instead of reading them as zero", () => {
    for (const bad of ["", q(""), q("upokt"), q("12"), q("12uatom"), q("-5upokt"), q("1.5upokt")]) {
      assert.throws(
        () => buildSettlementPayload(1, TS, "batched_vrd", [claimSettled({ minted_upokt: bad })]),
        /minted_upokt/
      );
    }
  });

  it("rejects a missing attribute", () => {
    const e = claimSettled();
    const without = { ...e, attributes: e.attributes.filter((a) => a.key !== "deflation_loss_upokt") };
    assert.throws(
      () => buildSettlementPayload(1, TS, "batched_vrd", [without]),
      /missing attribute "deflation_loss_upokt"/
    );
  });

  it("accepts an empty detailed list (a claim that settled nothing)", () => {
    const p = buildSettlementPayload(1, TS, "batched_vrd", [
      claimSettled({ settled_upokt: q("0upokt"), minted_upokt: q("0upokt") }, []),
    ])!;
    assert.equal(p.claims.length, 1);
    assert.equal(p.detailed.length, 0);
  });

  it("reads the validator distribution's commission rate as a LegacyDec with 18 decimals only", () => {
    const vrd = (rate: string): RawEvent => ({
      type: "pocket.tokenomics.EventValidatorRewardDistribution",
      attributes: Object.entries({
        commission_rate: q(rate),
        commission_upokt: q("1"),
        delegators_reward_upokt: q("8"),
        num_delegators: "2",
        op_reason: q("TLM_RELAY_BURN_EQUALS_MINT_VALIDATOR_REWARD_DISTRIBUTION"),
        pool_share_upokt: q("10"),
        self_delegation_reward_upokt: q("1"),
        total_delegated_stake_upokt: q("100"),
        validator_account_address: q("pokt1v"),
        validator_operator_address: q("poktvaloper1v"),
      }).map(([key, value]) => ({ key, value })),
    });
    assert.equal(buildSettlementPayload(1, TS, "batched_vrd", [vrd("0.100000000000000000")])!.vrd[0].family, "relay");
    for (const bad of ["0.1", "100000000000000000", "1e-1"]) {
      assert.throws(() => buildSettlementPayload(1, TS, "batched_vrd", [vrd(bad)]), /commission_rate/);
    }
  });
});

describe("writeSettlementCalls", () => {
  const rows = (n: number, tag: string) => Array.from({ length: n }, (_, i) => ({ tag, i }));
  const payload = {
    ts: "2026-09-01T12:00:00.000Z",
    era: "batched_vrd",
    row_source: "event",
    claims: rows(7, "c"),
    detailed: rows(5, "d"),
    batch: rows(3, "b"),
    vrd: [],
    reimb: rows(7, "r"),
    expired: [],
    discarded: [],
    slashed: rows(1, "s"),
    dv: [],
  } as unknown as SettlementPayload;

  it("sends a payload within the limit in one write_settlement call", () => {
    const calls = writeSettlementCalls("x", 10, payload, 100);
    assert.equal(calls.length, 1);
    assert.match(calls[0].sql, /^CALL x\.write_settlement\(/);
    const sent = JSON.parse(calls[0].bind[1] as string);
    assert.deepEqual({ ...sent, counts: undefined }, { ...payload, counts: undefined });
    // with the row count of every array, which write_settlement checks against what it staged
    assert.equal(sent.counts.claims, payload.claims.length);
    assert.equal(sent.counts.dv, 0);
  });

  it("splits a bigger payload into staged parts of at most maxRows rows, keeping every row in order", () => {
    const calls = writeSettlementCalls("x", 10, payload, 4);
    assert.equal(calls.length, 6); // 23 rows
    const parts = calls.map((c) => JSON.parse(c.bind[c.bind.length - 1] as string) as Record<string, unknown>);
    calls.slice(0, -1).forEach((c) => assert.match(c.sql, /^CALL x\._stage_settlement\(/));
    assert.match(calls[5].sql, /^CALL x\.write_settlement\(/);
    assert.deepEqual(calls[5].bind[0], 10);
    for (const part of parts) {
      const n = Object.values(part).reduce((a: number, v) => a + (Array.isArray(v) ? v.length : 0), 0);
      assert.ok(n <= 4);
    }
    const merged: Record<string, unknown[]> = {};
    for (const part of parts) {
      for (const [k, v] of Object.entries(part)) if (Array.isArray(v)) merged[k] = (merged[k] ?? []).concat(v);
    }
    for (const key of ["claims", "detailed", "batch", "reimb", "slashed"] as const) {
      assert.deepEqual(merged[key], payload[key]);
    }
    assert.equal(parts[5].ts, payload.ts);
    assert.equal(parts[5].era, payload.era);
    assert.equal(parts[5].row_source, payload.row_source);
  });
});

// The money events of a real settlement height (test/money/fixtures, built from mainnet block_results).
function realEvents(name: string): { height: number; events: RawEvent[] } {
  const file = path.join(__dirname, "../../../test/money/fixtures", `settlement_${name}.json.gz`);
  return JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString()) as { height: number; events: RawEvent[] };
}

function event(type: string, attrs: Record<string, string>): RawEvent {
  return { type, attributes: Object.entries(attrs).map(([key, value]) => ({ key, value })) };
}

describe("estimatedRelays", () => {
  it("matches num_estimated_relays on every EventClaimExpired of mainnet 788973 (v0.1.34 carries it)", () => {
    const fx = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/expired_788973.json"), "utf8")) as {
      expired: Array<Record<string, string>>;
    };
    assert.equal(fx.expired.length, 54);
    for (const e of fx.expired) {
      assert.equal(
        estimatedRelays(e.num_relays, e.num_claimed_compute_units, e.num_estimated_compute_units),
        e.num_estimated_relays
      );
    }
  });

  it("is 0 with no relays or less than one compute unit per relay, and divides as integers", () => {
    assert.equal(estimatedRelays("0", "100", "1000"), "0");
    assert.equal(estimatedRelays("10", "5", "1000"), "0");
    // 7 CU per relay (22 / 3, truncated), 100 / 7 = 14
    assert.equal(estimatedRelays("3", "22", "100"), "14");
  });
});

describe("detailed_batch (poktroll v0.1.33) events", () => {
  const expired = (over: Record<string, string> = {}) =>
    event("pocket.tokenomics.EventClaimExpired", {
      application_address: q("pokt1app"),
      claimed_upokt: q("19784647upokt"),
      expiration_reason: q("PROOF_MISSING"),
      num_claimed_compute_units: q("60195000"),
      num_estimated_compute_units: q("256833404"),
      num_relays: q("12039"),
      service_id: q("bsc"),
      session_end_block_height: q("709980"),
      supplier_operator_address: q("pokt1sup"),
      ...over,
    });
  const slashed = (over: Record<string, string> = {}) =>
    event("pocket.tokenomics.EventSupplierSlashed", {
      application_address: q("pokt1app"),
      proof_missing_penalty: q("1upokt"),
      service_id: q("bsc"),
      session_end_block_height: q("709980"),
      supplier_operator_address: q("pokt1sup"),
      ...over,
    });

  it("computes an expiration's estimated relays and leaves the stake after a slash NULL (mainnet 710013)", () => {
    const p = buildSettlementPayload(710013, TS, "detailed_batch", [expired(), slashed()])!;
    assert.equal(p.expired[0].num_estimated_relays, "51366"); // 256833404 / (60195000 / 12039)
    assert.equal(p.slashed[0].stake_after, null);
  });

  it("still reads both from the events from batched_vrd on", () => {
    const p = buildSettlementPayload(788973, TS, "batched_vrd", [
      expired({ num_estimated_relays: q("51366") }),
      slashed({ supplier_stake_after_slash: q("60000999999upokt") }),
    ])!;
    assert.equal(p.slashed[0].stake_after, "60000999999");
    assert.throws(() => buildSettlementPayload(788973, TS, "batched_vrd", [expired()]), /num_estimated_relays/);
    assert.throws(() => buildSettlementPayload(788973, TS, "batched_vrd", [slashed()]), /supplier_stake_after_slash/);
  });

  it("parses the real detailed_batch height 710013 under its era, with the claims' mint_ratio", () => {
    const { events, height } = realEvents("710013");
    assert.equal(eraAtHeight("pocket", height), "detailed_batch");
    const p = buildSettlementPayload(height, TS, "detailed_batch", events)!;
    assert.equal(p.claims.length, 2186);
    assert.equal(p.vrd.length, 0);
    assert.ok(p.batch.some((b) => b.role === "validator"));
    assert.deepEqual([...new Set(p.claims.map((c) => c.mint_ratio))], ["0.975"]);
  });

  it("stops a detailed_batch height whose expiration or slash carries a batched_vrd-only attribute", () => {
    assert.throws(
      () => buildSettlementPayload(710013, TS, "detailed_batch", [expired({ num_estimated_relays: q("51366") })]),
      /attribute "num_estimated_relays" is not emitted in this era/
    );
    assert.throws(
      () =>
        buildSettlementPayload(710013, TS, "detailed_batch", [
          slashed({ supplier_stake_after_slash: q("60000999999upokt") }),
        ]),
      /attribute "supplier_stake_after_slash" is not emitted in this era/
    );
  });

  it("stops a detailed_batch height with a global staker row (get_supply_flows relies on there being none)", () => {
    const { events, height } = realEvents("710013");
    const staker = events.find(
      (e) =>
        e.type === "pocket.tokenomics.EventSettlementBatch" &&
        e.attributes.some((a) => a.key === "op_reason" && a.value.includes("DELEGATOR_REWARD"))
    )!;
    const global = {
      ...staker,
      attributes: staker.attributes.map((a) =>
        a.key === "op_reason" ? { ...a, value: q("TLM_GLOBAL_MINT_DELEGATOR_REWARD_DISTRIBUTION") } : a
      ),
    };
    assert.throws(
      () => buildSettlementPayload(height, TS, "detailed_batch", [...events, global]),
      /has a global staker row in the settlement batch/
    );
  });

  it("rejects a mint_ratio that is not a decimal", () => {
    for (const bad of [q(""), q("1e-1"), q("-0.5"), q("0,975")]) {
      assert.throws(
        () => buildSettlementPayload(1, TS, "batched_vrd", [claimSettled({ mint_ratio: bad })]),
        /mint_ratio/
      );
    }
  });
});

describe("the events must have the shape of the height's era", () => {
  it("stops a batched_vrd height labelled detailed_batch: it has validator distributions", () => {
    const { events, height } = realEvents("899713");
    assert.equal(eraAtHeight("pocket", height), "batched_vrd");
    assert.ok(buildSettlementPayload(height, TS, "batched_vrd", events));
    assert.throws(
      () => buildSettlementPayload(height, TS, "detailed_batch", events),
      /era detailed_batch has EventValidatorRewardDistribution/
    );
  });

  it("stops a detailed_batch height labelled batched_vrd: staker rows without validator distributions", () => {
    const { events, height } = realEvents("710013");
    // the expiration at 710013 has no num_estimated_relays: read it without that event to reach the check
    const settled = events.filter(
      (e) => e.type !== "pocket.tokenomics.EventClaimExpired" && e.type !== "pocket.tokenomics.EventSupplierSlashed"
    );
    assert.throws(
      () => buildSettlementPayload(height, TS, "batched_vrd", settled),
      /era batched_vrd has staker rows in the settlement batch but no EventValidatorRewardDistribution/
    );
  });

  it("stops a detailed_batch height with settled claims and no settlement batch", () => {
    assert.throws(
      () => buildSettlementPayload(1, TS, "detailed_batch", [claimSettled()]),
      /era detailed_batch has settled claims but no EventSettlementBatch/
    );
  });

  it("refuses an era the parser does not know, but only on a height with money events", () => {
    for (const era of ["unknown_era"]) {
      assert.throws(
        () => buildSettlementPayload(1, TS, era, [claimSettled()]),
        new RegExp(`era ${era} is not supported`)
      );
      assert.equal(buildSettlementPayload(1, TS, era, [OTHER]), null);
    }
  });
});

describe("settlement_result (poktroll v0.1.26 and earlier) events", () => {
  const SETTLED = "pocket.tokenomics.EventClaimSettled";
  // the real claim events of 200013 (a subset of the height), with one claim's settlement_result rewritten by `f`
  const withResult = (f: (sr: Record<string, Array<Record<string, unknown>>>) => void) => {
    const { events, height } = realEvents("200013");
    let done = false;
    const out = events.map((e) => {
      if (done || e.type !== SETTLED) return e;
      done = true;
      return {
        ...e,
        attributes: e.attributes.map((a) => {
          if (a.key !== "settlement_result") return a;
          const sr = JSON.parse(a.value) as Record<string, Array<Record<string, unknown>>>;
          f(sr);
          return { ...a, value: JSON.stringify(sr) };
        }),
      };
    });
    return { events: out, height };
  };
  const leg = (sr: Record<string, Array<Record<string, unknown>>>, k: string, reason: string) =>
    sr[k].find((l) => l.op_reason === reason) as { coin: { amount: string } };

  it("reads the first settlements (96,845-96,860), where every claim is overserviced, with the loss the chain recorded", () => {
    const { events, height } = realEvents("96860");
    const expected = JSON.parse(
      fs.readFileSync(path.join(__dirname, "../../../test/money/fixtures/settlement_96860.expected.json"), "utf8")
    ) as { claims: number; overservicing_loss: string; income: Record<string, string> };
    assert.equal(eraAtHeight("pocket", height), "settlement_result");
    const p = buildSettlementPayload(height, TS, "settlement_result", events)!;
    assert.equal(p.claims.length, expected.claims);
    assert.ok(p.claims.every((c) => BigInt(c.settled) + BigInt(c.overservicing_loss) === BigInt(c.claimed)));
    assert.ok(p.claims.every((c) => BigInt(c.overservicing_loss) > BigInt(0) && c.minted === c.settled));
    assert.equal(
      p.claims.reduce((n, c) => n + BigInt(c.overservicing_loss), BigInt(0)).toString(),
      expected.overservicing_loss
    );
    const income: Record<string, bigint> = {};
    for (const d of p.detailed) {
      const k = `${d.recipient_id}|${d.role}|${d.family}`;
      income[k] = (income[k] ?? BigInt(0)) + BigInt(d.amount);
    }
    assert.deepEqual(Object.fromEntries(Object.entries(income).map(([k, v]) => [k, v.toString()])), expected.income);
  });

  it("stops an overserviced claim whose EventApplicationOverserviced is missing, does not match, or matches no claim", () => {
    const { events, height } = realEvents("96860");
    const OS = "pocket.tokenomics.EventApplicationOverserviced";
    const first = events.findIndex((e) => e.type === OS);
    const without = events.filter((_, i) => i !== first);
    assert.throws(
      () => buildSettlementPayload(height, TS, "settlement_result", without),
      /no EventApplicationOverserviced for the claim/
    );
    const wrong = events.map((e, i) =>
      i !== first
        ? e
        : {
            ...e,
            attributes: e.attributes.map((a) =>
              a.key === "effective_burn" ? { ...a, value: '{"denom":"upokt","amount":"1"}' } : a
            ),
          }
    );
    assert.throws(
      () => buildSettlementPayload(height, TS, "settlement_result", wrong),
      /EventApplicationOverserviced \(event \d+\) effective_burn 1, expected_burn \d+ do not match the claim/
    );
    const orphan = {
      ...events[first],
      attributes: events[first].attributes.map((a) =>
        a.key === "supplier_operator_addr" ? { ...a, value: '"pokt1nobody"' } : a
      ),
    };
    assert.throws(
      () => buildSettlementPayload(height, TS, "settlement_result", [...events, orphan]),
      /EventApplicationOverserviced matches no claim/
    );
  });

  // the events of one claim (its EventApplicationOverserviced if any, its reimbursement request, the claim) moved to
  // another (application, supplier operator), in a session of their own (claims and requests pair on the session)
  const toPair = (group: RawEvent[], app: string, supplier: string): RawEvent[] =>
    group.map((e) => ({
      ...e,
      attributes: e.attributes.map((a) => {
        if (a.key === "application_addr") return { ...a, value: JSON.stringify(app) };
        if (a.key === "supplier_operator_addr") return { ...a, value: JSON.stringify(supplier) };
        if (a.key === "session_id") return { ...a, value: JSON.stringify(`moved-${JSON.parse(a.value) as string}`) };
        if (a.key !== "claim") return a;
        const c = JSON.parse(a.value) as { supplier_operator_address: string; session_header: Record<string, string> };
        c.supplier_operator_address = supplier;
        c.session_header.application_address = app;
        c.session_header.session_id = `moved-${c.session_header.session_id}`;
        return { ...a, value: JSON.stringify(c) };
      }),
    }));
  const pairOf = (claimEvent: RawEvent): [string, string] => {
    const c = JSON.parse(claimEvent.attributes.find((a) => a.key === "claim")!.value) as {
      supplier_operator_address: string;
      session_header: { application_address: string };
    };
    return [c.session_header.application_address, c.supplier_operator_address];
  };

  it("pairs the claims of one (application, supplier) with their EventApplicationOverserviced in block order", () => {
    const { events, height } = realEvents("96860");
    // 96860 is [overserviced, request, claim] per claim; the second claim moves to the first claim's pair
    const [app, supplier] = pairOf(events[2]);
    const two = [...events.slice(0, 3), ...toPair(events.slice(3, 6), app, supplier)];
    const p = buildSettlementPayload(height, TS, "settlement_result", two)!;
    assert.equal(p.claims.length, 2);
    // both claims burn what the application had left (the same effective_burn); their claimed amounts differ
    assert.notEqual(p.claims[0].claimed, p.claims[1].claimed);
    for (const c of p.claims) assert.equal(BigInt(c.settled) + BigInt(c.overservicing_loss), BigInt(c.claimed));
    // the two overserviced events swapped: the first claim meets the second's expected_burn, below its own claimed
    // amount, and the height stops
    const swapped = [two[3], ...two.slice(1, 3), two[0], ...two.slice(4)];
    assert.throws(
      () => buildSettlementPayload(height, TS, "settlement_result", swapped),
      /EventApplicationOverserviced \(event 0\) effective_burn \d+, expected_burn \d+ do not match the claim/
    );
  });

  it("leaves a fully paid claim of the same (application, supplier) without loss and its overserviced event to the next", () => {
    const { events, height } = realEvents("96860");
    const [app, supplier] = pairOf(events[2]);
    // a claim from 130000, paid in full, between the overserviced claim's event and that claim
    const paid = toPair(realEvents("130000").events.slice(0, 2), app, supplier);
    const mixed = [events[0], ...paid, events[1], events[2]];
    const p = buildSettlementPayload(height, TS, "settlement_result", mixed)!;
    assert.deepEqual(
      p.claims.map((c) => [c.event_idx, BigInt(c.overservicing_loss) > BigInt(0)]),
      [
        [2, false],
        [4, true],
      ]
    );
    assert.equal(p.claims[0].settled, p.claims[0].claimed);
  });

  it("reads a real height: nested claim, Coin objects, proposer legs as validator income, owner from the request", () => {
    const { events, height } = realEvents("200013");
    assert.equal(eraAtHeight("pocket", height), "settlement_result");
    const p = buildSettlementPayload(height, TS, "settlement_result", events)!;
    assert.equal(p.claims.length, 34);
    assert.equal(p.batch.length, 0);
    const stakers = p.detailed.filter((d) => d.role === "validator");
    assert.equal(stakers.length, 14);
    assert.ok(
      stakers.every((d) => d.family === "global" && d.op_reason === "TLM_GLOBAL_MINT_PROPOSER_REWARD_DISTRIBUTION")
    );
    assert.ok(p.claims.every((c) => c.supplier_owner_id !== "" && c.mint_ratio === "1" && c.settled === c.claimed));
    assert.deepEqual(
      p.slashed.map((x) => [x.penalty, x.stake_after]),
      Array(5).fill(["1", null])
    );
    assert.equal(p.expired[0].num_estimated_relays, "3107");
    assert.equal(p.expired[0].claimed, "1642966");
  });

  it("stops a claim whose legs break a settlement_result identity", () => {
    const cases: Array<[(sr: Record<string, Array<Record<string, unknown>>>) => void, RegExp]> = [
      [
        (sr) => (leg(sr, "burns", "TLM_RELAY_BURN_EQUALS_MINT_APPLICATION_STAKE_BURN").coin.amount = "1"),
        /burn 1 < claimed \d+ and no EventApplicationOverserviced for the claim/,
      ],
      [
        (sr) => (leg(sr, "burns", "TLM_RELAY_BURN_EQUALS_MINT_APPLICATION_STAKE_BURN").coin.amount = "99999999999999"),
        /burn \+ overservicing loss = claimed fails/,
      ],
      [
        (sr) => (leg(sr, "mints", "TLM_RELAY_BURN_EQUALS_MINT_SUPPLIER_STAKE_MINT").coin.amount = "1"),
        /relay mint = burn/,
      ],
      [(sr) => (leg(sr, "mints", "TLM_GLOBAL_MINT_INFLATION").coin.amount = "999"), /global legs = global mint/],
      [
        (sr) =>
          (leg(sr, "mod_to_acct_transfers", "TLM_GLOBAL_MINT_REIMBURSEMENT_REQUEST_ESCROW_DAO_TRANSFER").coin.amount =
            "0"),
        /escrow legs = global mint/,
      ],
      [(sr) => sr.mod_to_acct_transfers.pop(), /identity/],
      [(sr) => (sr.burns = []), /no burns leg/],
      [(sr) => (sr.mints[0].op_reason = "TLM_NEW_MINT"), /unexpected mints op_reason/],
      [(sr) => (sr.mod_to_acct_transfers[0].coin = { denom: "uatom", amount: "1" }), /not an upokt Coin object/],
    ];
    for (const [f, re] of cases) {
      const { events, height } = withResult(f);
      assert.throws(() => buildSettlementPayload(height, TS, "settlement_result", events), re);
    }
  });

  it("stops a claim without exactly one reimbursement request", () => {
    const { events, height } = realEvents("130000");
    const without = events.filter((e, i) => i !== events.findIndex((x) => x.type.endsWith("ReimbursementRequest")));
    assert.throws(
      () => buildSettlementPayload(height, TS, "settlement_result", without),
      /0 reimbursement requests for the claim, expected 1/
    );
  });

  it("stops a claim with more than one proposer leg", () => {
    const proposer = "TLM_GLOBAL_MINT_PROPOSER_REWARD_DISTRIBUTION";
    const { events, height } = withResult((sr) => {
      const dao = leg(sr, "mod_to_acct_transfers", "TLM_GLOBAL_MINT_DAO_REWARD_DISTRIBUTION") as Record<
        string,
        unknown
      >;
      sr.mod_to_acct_transfers.push({ ...dao, op_reason: proposer }, { ...dao, op_reason: proposer });
    });
    assert.throws(() => buildSettlementPayload(height, TS, "settlement_result", events), /more than one proposer leg/);
  });

  it("stops a reimbursement request with no claim, and one without a supplier owner", () => {
    const { events, height } = realEvents("130000");
    const reimb = events.find((e) => e.type.endsWith("ReimbursementRequest"))!;
    const orphan = {
      ...reimb,
      attributes: reimb.attributes.map((a) => (a.key === "session_id" ? { ...a, value: q("other-session") } : a)),
    };
    assert.throws(
      () => buildSettlementPayload(height, TS, "settlement_result", [...events, orphan]),
      /0 claims for the reimbursement request, expected 1/
    );
    const noOwner = events.map((e) =>
      e.type.endsWith("ReimbursementRequest")
        ? { ...e, attributes: e.attributes.filter((a) => a.key !== "supplier_owner_addr") }
        : e
    );
    assert.throws(
      () => buildSettlementPayload(height, TS, "settlement_result", noOwner),
      /missing attribute "supplier_owner_addr"/
    );
  });

  it("refuses another era's events under settlement_result, and settlement_result events under another era", () => {
    assert.throws(
      () => buildSettlementPayload(1, TS, "settlement_result", [claimSettled()]),
      /missing attribute "claim"/
    );
    const { events, height } = realEvents("130000");
    assert.throws(() => buildSettlementPayload(height, TS, "batched_vrd", events), /is not an upokt amount/);
  });
});

describe("map era (poktroll v0.1.27–v0.1.32) events", () => {
  // a subset of a real height with its bank groups (make_map_fixtures.py) and the map state at the height
  const mapFixture = (name: string) => {
    const file = path.join(__dirname, "../../../test/money/fixtures", `settlement_${name}.json.gz`);
    const fx = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString()) as {
      height: number;
      events: RawEvent[];
      mapState: MapState & { validatorAccounts?: string[] };
    };
    const state: MapState = {
      ...fx.mapState,
      validatorAccounts: fx.mapState.validatorAccounts ? new Set(fx.mapState.validatorAccounts) : undefined,
    };
    return { ...fx, state };
  };
  const build = (name: string, f?: (events: RawEvent[], state: MapState) => void) => {
    const { events, height, state } = mapFixture(name);
    const copy = events.map((e) => ({ ...e, attributes: e.attributes.map((a) => ({ ...a })) }));
    const st = { ...state, meb: { ...state.meb } };
    f?.(copy, st);
    return buildSettlementPayload(height, TS, eraAtHeight("pocket", height), copy, st);
  };
  const attr = (e: RawEvent, key: string) => e.attributes.find((a) => a.key === key)!;

  it("reads each sub-era with the slices its bank legs pay, and aggregates the staker legs per recipient", () => {
    const want: Array<[string, string, string[]]> = [
      ["250053", "map_proposer_consensus", ["validator/relay"]],
      ["270033", "map_no_stakers", []],
      ["350013", "map_proposer_operator", ["validator/relay"]],
      ["430053", "map_all_bonded", ["delegator/relay", "validator/relay"]],
      ["699993", "map_all_bonded_deflation", ["delegator/relay", "validator/relay"]],
    ];
    for (const [name, era, roles] of want) {
      const p = build(name)!;
      assert.equal(p.era, era);
      assert.equal(p.row_source, "bank");
      assert.ok(p.claims.every((c) => c.session_id !== "" && c.supplier_owner_id !== ""));
      assert.ok(p.batch.every((b) => b.event_idx === -1));
      assert.deepEqual([...new Set(p.batch.map((b) => `${b.role}/${b.family}`))].sort(), roles, name);
      assert.equal(p.claims[0].mint_ratio, name === "699993" ? "0.975" : "1");
    }
  });

  it("reads beta's map heights as mainnet's, and a claim of 0 upokt with no request and no bank legs", () => {
    // beta (pocket-lego-testnet) settles in the map format from its first settlement; at 3,333, 9 of 22 claims
    // (service pnf-anvil) claimed 0 upokt: the chain skipped the token logic modules for them, so they have no
    // reimbursement request, no mint and no burn
    const want: Array<[string, string, string, number, number]> = [
      ["3333", "map_all_bonded", "1", 22, 9],
      ["3393", "map_all_bonded", "1", 16, 0],
      ["16533", "map_all_bonded", "1", 31, 0],
      ["19713", "map_all_bonded_deflation", "0.975", 32, 0],
      ["153453", "map_all_bonded_deflation", "0.975", 31, 0],
    ];
    for (const [h, era, ratio, claims, zeros] of want) {
      const { events, height, state } = mapFixture(`beta_${h}`);
      const p = buildSettlementPayload(height, TS, eraAtHeight("pocket-lego-testnet", height), events, state)!;
      assert.equal(p.era, era, h);
      assert.equal(p.row_source, "bank", h);
      assert.equal(p.claims.length, claims, h);
      const zero = p.claims.filter((c) => c.claimed === "0");
      assert.equal(zero.length, zeros, h);
      assert.ok(zero.every((c) => c.settled === "0" && c.minted === "0" && c.session_id === ""), h);
      assert.ok(!p.detailed.some((d) => zero.some((c) => c.event_idx === d.event_idx)), h);
      const paid = p.claims.filter((c) => c.claimed !== "0");
      assert.ok(paid.every((c) => c.session_id !== "" && c.supplier_owner_id !== "" && c.settled !== "0"), h);
      assert.ok(p.claims.every((c) => c.mint_ratio === ratio), h);
      assert.deepEqual([...new Set(p.batch.map((b) => `${b.role}/${b.family}`))], ["validator/relay"], h);
    }
  });

  it("stops a height whose bank legs, mints, map or state disagree with the formula", () => {
    const firstOf = (events: RawEvent[], type: string) => events.find((e) => e.type === type)!;
    const cases: Array<[string, (events: RawEvent[], state: MapState) => void, RegExp]> = [
      ["250053", (_e, s) => (s.dao = "pokt1other"), /relay DAO is not paid to pokt1other/],
      ["250053", (_e, s) => (s.proposerAccount = "pokt1other"), /proposer leg paid to/],
      ["250053", (_e, s) => (s.meb.supplier = "0.69"), /do not pay the formula amount/],
      ["270033", (_e, s) => (s.meb.proposer = "0.01"), /pays no stakers, but the params give the proposer a share/],
      ["250053", (e) => (attr(firstOf(e, "coinbase"), "amount").value = "1upokt"), /mints \(1, 1\), expected/],
      [
        "250053",
        (e) => {
          const a = attr(firstOf(e, "pocket.tokenomics.EventApplicationReimbursementRequest"), "amount");
          a.value = JSON.stringify("2upokt");
        },
        /reimbursement request 2 differs from the global mint 1/,
      ],
      [
        "350013",
        (e) => {
          const a = attr(firstOf(e, "pocket.tokenomics.EventClaimSettled"), "reward_distribution");
          const rd = JSON.parse(a.value) as Record<string, string>;
          const k = Object.keys(rd)[0];
          rd[k] = `${BigInt(/^(\d+)/.exec(rd[k])![1]) + BigInt(1)}upokt`;
          a.value = JSON.stringify(rd);
        },
        /bank events of claim 0/,
      ],
      ["430053", (_e, s) => (s.validatorAccounts = undefined), /needs the bonded validators' accounts/],
      [
        "430053",
        (e) =>
          e.push({
            ...firstOf(e, "pocket.tokenomics.EventClaimSettled"),
            type: "pocket.tokenomics.EventSettlementBatch",
          }),
        /not emitted in the map era/,
      ],
    ];
    for (const [name, f, re] of cases) assert.throws(() => build(name, f), re, String(re));
    assert.throws(() => {
      const { events, height } = mapFixture("250053");
      buildSettlementPayload(height, TS, "map_proposer_consensus", events);
    }, /needs the map state/);
  });

  it("finds the map_proposer_operator proposer among all validators, bonded or not", () => {
    const key = new Uint8Array(32).fill(7);
    const pubkey = new Uint8Array([0x0a, 32, ...key]);
    const operator = toBech32("poktvaloper", new Uint8Array(20).fill(3));
    const validators = [
      {
        operatorAddress: toBech32("poktvaloper", new Uint8Array(20).fill(1)),
        consensusPubkey: { value: new Uint8Array(34) },
      },
      // leaving the bonded set in this block: the chain still finds it by consensus address
      { operatorAddress: operator, consensusPubkey: { value: pubkey }, status: "BOND_STATUS_UNBONDING" },
    ];
    const proposer = sha256(key).slice(0, 20);
    assert.equal(proposerOperatorAccount(validators, proposer), toBech32("pokt", new Uint8Array(20).fill(3)));
    assert.throws(
      () => proposerOperatorAccount(validators.slice(0, 1), proposer),
      /no validator has the consensus address/
    );
  });
});
