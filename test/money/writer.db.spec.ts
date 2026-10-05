// Golden test of the settlement money writer against a real PostgreSQL. Run with
//   MONEY_TEST_PG=postgres://postgres:postgres@127.0.0.1:5432/postgres yarn test:money
// CI runs it with a postgres:16 service. Without MONEY_TEST_PG every test is skipped.
//
// The expected income per (address, role, family) was computed from block_results by a separate script
// (.local/ab/money/make_ci_fixtures.py in the author's checkout), not by the code under test.
/* eslint-disable @typescript-eslint/no-floating-promises */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import * as zlib from "node:zlib";
import { fromBech32, toBech32 } from "@cosmjs/encoding";
import { CATALOG_FUNCTIONS, createSettlementFunctionsFn } from "../../src/mappings/dbFunctions/settlement/functions";
import { createSettlementTablesFn } from "../../src/mappings/dbFunctions/settlement/schema";
import { createSettlementSmartTagsFn, OMITTED_TABLES, UNUSED_ENTITY_TABLES } from "../../src/mappings/dbFunctions/settlement/smartTags";
import {
  createSettlementWriterFn,
  ROLLUP_VERSION,
  writeSettlementCalls,
} from "../../src/mappings/dbFunctions/settlement/writer";
import { addDelegatorValidator, De2Validator } from "../../src/mappings/money/de2";
import type { MapState } from "../../src/mappings/money/map";
import { buildSettlementPayload, PayloadSink, SettlementPayload } from "../../src/mappings/money/payload";
import { addReplay, REPLAY_ERAS, ReplayInput } from "../../src/mappings/money/replay";
import { eraAtHeight } from "../../src/mappings/utils/params_history";

// pg is the driver Sequelize already uses; it ships without type declarations here.
interface PgClient {
  connect(): Promise<void>;
  end(): Promise<void>;
  query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, string | number>> }>;
}
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Client } = require("pg") as { Client: new (options: { connectionString?: string }) => PgClient };

const URL = process.env.MONEY_TEST_PG;
const S = "money_ci";
const FIXTURES = path.join(__dirname, "fixtures");
const TABLES = [
  "settlement_blocks",
  "settlement_gaps",
  "claim_settlements",
  "shareholder_payouts",
  "staker_payouts",
  "validator_distributions",
  "delegator_validator_payouts",
  "claim_expirations",
  "claim_discards",
  "supplier_slashes",
  "daily_claims_by_application_service",
  "daily_claims_by_supplier",
  "daily_claims_by_supplier_application_service",
  "daily_income_by_address",
  "settlement_income_by_address",
  "settlement_supply_flows",
  "monthly_income_by_address_supplier",
  "monthly_income_by_address_service",
  "monthly_income_by_address_supplier_service",
  "settlement_claims_by_application_service",
  "daily_income_by_address_supplier",
  "daily_income_by_address_service",
  "daily_validator_rewards",
  "daily_delegator_rewards_by_validator",
  "hourly_income_by_address_supplier",
];

function gz(file: string): Record<string, unknown> {
  return JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString());
}

// The chain each fixture comes from: 694993 is a beta height, the others mainnet.
const CHAIN: Record<string, string> = {
  "899713": "pocket",
  "694993": "pocket-lego-testnet",
  "710013": "pocket",
  "716433": "pocket",
  "130000": "pocket",
  "96860": "pocket",
  "200013": "pocket",
  "250053": "pocket",
  "270033": "pocket",
  "350013": "pocket",
  "430053": "pocket",
  "699993": "pocket",
  "694053": "pocket",
  "699213": "pocket",
};

// The replay input kept for a height (test/money/fixtures/replay_<h>.json.gz): bigints as strings, Maps as entry lists.
function replayInput(height: number): ReplayInput {
  return JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(FIXTURES, `replay_${height}.json.gz`))).toString(), (k, v) =>
    ["tokens", "delegatorShares", "shares", "balance"].includes(k) && typeof v === "string" ? BigInt(v) : v
  ).input as ReplayInput;
}

function payloadOf(name: string, withDelegations: boolean): { height: number; payload: SettlementPayload } {
  const fx = gz(path.join(FIXTURES, `settlement_${name}.json.gz`)) as {
    height: number;
    events: [];
    mapState?: MapState & { validatorAccounts?: string[] };
  };
  const ts = new Date(Date.UTC(2026, 8, 1, 12, 0, 0));
  // the map-era fixtures carry the state at their height (make_map_fixtures.py)
  const state = fx.mapState && {
    ...fx.mapState,
    validatorAccounts: fx.mapState.validatorAccounts && new Set(fx.mapState.validatorAccounts),
  };
  const sink: PayloadSink = {};
  const payload = buildSettlementPayload(fx.height, ts, eraAtHeight(CHAIN[name], fx.height), fx.events, state, sink);
  assert.ok(payload);
  // 288,180–788,944: the chain's split replayed over the real snapshot at the height (replay_<h>.json.gz, read from
  // sauron's LCD), with each claim's legs from this fixture's own events; before it, no stakers split
  if (payload.era !== "batched_vrd") {
    if (REPLAY_ERAS.has(payload.era) && payload.claims.length > 0) {
      const input = replayInput(fx.height);
      const modes = addReplay(fx.height, payload, { ...input, mapStakers: sink.mapStakers });
      assert.ok([...modes.values()].every((m) => m.mode !== "unattributed"), `${name}: unattributed`);
    }
    return { height: fx.height, payload };
  }
  let validators: De2Validator[] | null = null;
  if (withDelegations) {
    const de2 = gz(path.join(__dirname, "../../src/mappings/money/fixtures/de2_899713.json.gz")) as {
      validators: Array<{
        operator: string;
        tokens: string;
        delegator_shares: string;
        rate: string;
        delegations: Array<{ delegator: string; shares: string }>;
      }>;
    };
    validators = de2.validators.map((v) => ({
      operator: v.operator,
      account: toBech32("pokt", fromBech32(v.operator).data),
      tokens: BigInt(v.tokens),
      delegatorShares: BigInt(v.delegator_shares),
      rateAtoms: BigInt(v.rate),
      delegations: v.delegations.map((d) => ({ delegator: d.delegator, shares: BigInt(d.shares) })),
    }));
  }
  addDelegatorValidator(fx.height, payload, validators);
  return { height: fx.height, payload };
}

describe("settlement money writer (PostgreSQL)", { skip: !URL && "MONEY_TEST_PG not set" }, () => {
  const c = new Client({ connectionString: URL });

  const write = async (height: number, payload: SettlementPayload) => {
    await c.query("BEGIN");
    try {
      for (const { bind, sql } of writeSettlementCalls(S, height, payload)) await c.query(sql, bind);
      await c.query("COMMIT");
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    }
  };
  const md5All = async () => {
    const parts: string[] = [];
    for (const t of TABLES) {
      const r = await c.query(
        `SELECT count(*) n, coalesce(md5(string_agg(x::text, '|' ORDER BY x::text)), '') h FROM ${S}.${t} x`
      );
      parts.push(`${t}:${r.rows[0].n}:${r.rows[0].h}`);
    }
    return parts.join(" ");
  };

  before(async () => {
    await c.connect();
    await c.query(`DROP SCHEMA IF EXISTS ${S} CASCADE; CREATE SCHEMA ${S};`);
    await c.query(createSettlementTablesFn(S));
    await c.query(createSettlementWriterFn(S));
    // the SubQuery entity tables the catalog functions and the smart tags reference, reduced to what they read
    await c.query(`
      CREATE TABLE ${S}.event_claim_settleds (block_id numeric);
      CREATE TABLE ${S}.blocks (id numeric, timestamp timestamp);
      CREATE TABLE ${S}.application_gateways (gateway_id text, application_id text, _block_range int8range);
      CREATE TABLE ${S}.params (id text, namespace text, key text, value text, active_at numeric, _block_range int8range);
      CREATE TABLE ${S}.delegations (id text);
      INSERT INTO ${S}.event_claim_settleds VALUES (694993), (710013), (899713);`);
    await c.query(createSettlementFunctionsFn(S));
    await c.query(createSettlementSmartTagsFn(S));
  });
  after(async () => {
    await c.query(`DROP SCHEMA IF EXISTS ${S} CASCADE`);
    await c.end();
  });

  for (const [name, withDelegations, pairs] of [
    ["899713", true, 260],
    ["694993", false, 0],
    // detailed_batch: one row per (address, validator) of the replay's derived split (replay.ts), both roles
    ["710013", false, 588],
  ] as const) {
    it(`writes settlement ${name} with the income the chain paid, per address, role and family`, async () => {
      const { height, payload } = payloadOf(name, withDelegations);
      await write(height, payload);
      const expected = JSON.parse(fs.readFileSync(path.join(FIXTURES, `settlement_${name}.expected.json`), "utf8")) as {
        claims: number;
        income: Record<string, string>;
      };
      const got = await c.query(
        `SELECT address || '|' || role || '|' || family AS k, sum(amount_upokt)::text AS a FROM ${S}.v_income_base WHERE height = $1 GROUP BY 1`,
        [height]
      );
      assert.deepEqual(Object.fromEntries(got.rows.map((r) => [r.k, r.a])), expected.income);
      const claims = await c.query(`SELECT count(*)::int n FROM ${S}.claim_settlements WHERE height = $1`, [height]);
      assert.equal(claims.rows[0].n, expected.claims);
      // claims settled with a proof, counted from the raw events (claim_proof_status_int = 1)
      const raw = gz(path.join(FIXTURES, `settlement_${name}.json.gz`)) as {
        events: Array<{ type: string; attributes: Array<{ key: string; value: string }> }>;
      };
      const withProof = raw.events.filter(
        (e) =>
          e.type === "pocket.tokenomics.EventClaimSettled" &&
          e.attributes.some((a) => a.key === "claim_proof_status_int" && a.value === "1")
      ).length;
      const proofs = await c.query(
        `SELECT count(*) FILTER (WHERE settled_with_proof)::int n FROM ${S}.claim_settlements WHERE height = $1`,
        [height]
      );
      assert.equal(proofs.rows[0].n, withProof);
      const dv = await c.query(`SELECT count(*)::int n FROM ${S}.delegator_validator_payouts WHERE height = $1`, [
        height,
      ]);
      assert.equal(dv.rows[0].n, pairs);
    });
  }

  it("716433: a claim paying one shareholder address twice keeps the chain's legs and the chain's staker share", async () => {
    // detailed_batch, where the history job stopped: the relay legs of the two claims of supplier pokt1gfxp7… exceed
    // their mint (15 % + 70 % + 70 % to two addresses). What they leave is negative, the stakers' share is
    // floor(minted × 0.14), and the shareholder is paid both legs. In a rolled-back transaction: the other tests count
    // this day's heights.
    await c.query("BEGIN");
    try {
      const { height, payload } = payloadOf("716433", false);
      for (const { bind, sql } of writeSettlementCalls(S, height, payload)) await c.query(sql, bind);
      const expected = JSON.parse(fs.readFileSync(path.join(FIXTURES, "settlement_716433.expected.json"), "utf8")) as {
        claims: number;
        income: Record<string, string>;
      };
      const got = await c.query(
        `SELECT address || '|' || role || '|' || family AS k, sum(amount_upokt)::text AS a FROM ${S}.v_income_base WHERE height = $1 GROUP BY 1`,
        [height]
      );
      assert.deepEqual(Object.fromEntries(got.rows.map((r) => [r.k, r.a])), expected.income);
      const n = await c.query(
        `SELECT (SELECT count(*)::int FROM ${S}.claim_settlements WHERE height = $1) claims,
                (SELECT count(*)::int FROM ${S}.delegator_validator_payouts WHERE height = $1) dv`,
        [height]
      );
      assert.deepEqual(n.rows[0], { claims: expected.claims, dv: 593 });
      const rows = (
        await c.query(
          `SELECT relay_minted_upokt::text m, relay_to_supplier_upokt::text s, relay_to_stakers_upokt::text k, p.relay_upokt::text p
           FROM ${S}.claim_settlements c
           JOIN ${S}.shareholder_payouts p USING (height, event_idx)
           WHERE c.height = 716433 AND c.supplier_id = 'pokt1gfxp7uv8cdx4ef84xvc5y0davsul83acmutcf9'
             AND p.recipient_id = 'pokt1mvz6gf82quaal497gcpz2pt50qvynuxsp4up44' ORDER BY c.event_idx`
        )
      ).rows;
      assert.deepEqual(rows, [
        { m: "157082", s: "192345", k: "21991", p: "173730" },
        { m: "170", s: "207", k: "23", p: "186" },
      ]);
    } finally {
      await c.query("ROLLBACK");
    }
  });

  it("refuses a staker share or a global overpayment on a claim that does not repeat a shareholder address", async () => {
    // R1 and M1 admit the exception only on the claims that paid one address twice: the same amounts moved to a normal
    // claim are refused. Each case in its own rolled-back transaction.
    const DUP = "pokt1gfxp7uv8cdx4ef84xvc5y0davsul83acmutcf9";
    const refuses = async (name: string, change: (claims: SettlementPayload["claims"]) => void, message: RegExp) => {
      const { height, payload } = payloadOf(name, false);
      change(payload.claims);
      await c.query("BEGIN");
      try {
        await assert.rejects(async () => {
          for (const { bind, sql } of writeSettlementCalls(S, height, payload)) await c.query(sql, bind);
        }, message);
      } finally {
        await c.query("ROLLBACK");
      }
    };
    // 716433: one staker upokt more on a claim of another supplier (I3a alone would refuse it with another message)
    await refuses(
      "716433",
      (claims) => {
        const normal = claims.find((x) => x.supplier_id !== DUP && x.relay_to_stakers !== undefined);
        assert.ok(normal);
        normal.relay_to_stakers = (BigInt(normal.relay_to_stakers as string) + BigInt(1)).toString();
      },
      /the staker share differs from what the relay legs leave of the mint/
    );
    // 699213: the duplicate claim's global overpayment moved to another claim keeps M1's sum, and is refused
    await refuses(
      "699213",
      (claims) => {
        const dup = claims.find((x) => x.supplier_id === DUP);
        const normal = claims.find((x) => x.supplier_id !== DUP);
        assert.ok(dup && normal);
        assert.equal(dup.global_overpaid, "13");
        normal.global_overpaid = dup.global_overpaid;
        dup.global_overpaid = "0";
      },
      /a global overpayment without a repeated shareholder address/
    );
  });

  it("records each height's era and mint_ratio, and the detailed_batch expiration and slash as the chain had them", async () => {
    const blocks = await c.query(`SELECT height::int h, era, mint_ratio::text m FROM ${S}.settlement_blocks ORDER BY height`);
    assert.deepEqual(
      blocks.rows.map((r) => [r.h, r.era]),
      [
        [694993, "batched_vrd"],
        [710013, "detailed_batch"],
        [899713, "batched_vrd"],
      ]
    );
    // every claim of a height settles with one mint_ratio, the one its events carry
    for (const r of blocks.rows) {
      const raw = gz(path.join(FIXTURES, `settlement_${r.h}.json.gz`)) as {
        events: Array<{ type: string; attributes: Array<{ key: string; value: string }> }>;
      };
      const ratios = new Set(
        raw.events
          .filter((e) => e.type === "pocket.tokenomics.EventClaimSettled")
          .map((e) => JSON.parse(e.attributes.find((x) => x.key === "mint_ratio")!.value) as string)
      );
      assert.deepEqual([...ratios].map((x) => Number(x)), [Number(r.m)]);
    }
    // 710013's expiration has no num_estimated_relays: 256833404 / (60195000 / 12039) = 51366
    const exp = await c.query(`SELECT estimated_relays::text n FROM ${S}.claim_expirations WHERE height = 710013`);
    assert.deepEqual(exp.rows, [{ n: "51366" }]);
    const slash = await c.query(`SELECT penalty_upokt::text p, stake_after_upokt s FROM ${S}.supplier_slashes WHERE height = 710013`);
    assert.deepEqual(slash.rows, [{ p: "1", s: null }]);
  });

  it("a day mixing replayed rows (no commission) with batched_vrd ones keeps the real commission and counts the rest", async () => {
    // 710013 (detailed_batch, replayed: commission NULL) and 899713 / 694993 (batched_vrd) settle on the same day here,
    // as 788,944 and 788,945 do on mainnet
    const base = await c.query(
      `SELECT validator_operator v, family f, sum(commission_upokt)::text c,
              count(*) FILTER (WHERE commission_upokt IS NULL)::int na, count(*)::int n
       FROM ${S}.validator_distributions GROUP BY 1, 2 ORDER BY 1, 2`
    );
    const rollup = await c.query(
      `SELECT validator_operator v, family f, commission_upokt::text c, commission_na_count::int na, contribution_count::int n
       FROM ${S}.daily_validator_rewards WHERE day = '2026-09-01' ORDER BY 1, 2`
    );
    assert.deepEqual(rollup.rows, base.rows);
    // a validator paid on both sides: its real commission is kept, and the replayed contribution counted apart
    assert.ok(rollup.rows.some((r) => r.c !== null && Number(r.na) > 0 && Number(r.na) < Number(r.n)));
    // a validator with only replayed contributions has no commission at all, not 0
    assert.ok(rollup.rows.every((r) => (r.c === null) === (r.na === r.n)));
  });

  it("daily_delegator_rewards_by_validator counts the replayed contributions, as the base table does", async () => {
    const q = (from: string, cols: string) =>
      `SELECT delegator a, validator_operator v, family f, ${cols} FROM ${S}.${from} ORDER BY 1, 2, 3`;
    const base = await c.query(
      q(
        `delegator_validator_payouts GROUP BY delegator, validator_operator, family`,
        `sum(amount_upokt)::text x, count(*)::int n, count(*) FILTER (WHERE row_source IN ('replay', 'derived_split'))::int rp`
      )
    );
    const rollup = await c.query(
      q(`daily_delegator_rewards_by_validator`, `amount_upokt::text x, contribution_count::int n, replayed_count::int rp`)
    );
    // 710013 is replayed and the batched_vrd heights are not: both kinds of row are here
    assert.ok(base.rows.some((r) => Number(r.rp) > 0) && base.rows.some((r) => r.rp === 0));
    assert.deepEqual(rollup.rows, base.rows);
  });

  it("writes settlement_result heights (E0) with the income their legs paid, and rewrites them identically", async () => {
    // in one rolled-back transaction: the other tests read validator rewards from 11:00, which older eras refuse
    const flows = async () =>
      (
        await c.query(
          `SELECT coalesce(sum(amount_upokt), 0)::text a FROM ${S}.get_supply_flows(NULL, NULL, by_role => true)
           WHERE flow = 'global_mint' AND role = 'stakers'`
        )
      ).rows[0].a;
    const send = async (height: number, payload: SettlementPayload) => {
      for (const { bind, sql } of writeSettlementCalls(S, height, payload)) await c.query(sql, bind);
    };
    const stakersBefore = BigInt(await flows());
    await c.query("BEGIN");
    try {
      let proposer = BigInt(0);
      // 96860: the first settlements on mainnet, every claim overserviced (EventApplicationOverserviced)
      for (const name of ["96860", "130000", "200013"]) {
        const { height, payload } = payloadOf(name, false);
        assert.equal(payload.era, "settlement_result");
        await send(height, payload);
        const expected = JSON.parse(fs.readFileSync(path.join(FIXTURES, `settlement_${name}.expected.json`), "utf8")) as {
          claims: number;
          income: Record<string, string>;
          overservicing_loss?: string;
        };
        const got = await c.query(
          `SELECT address || '|' || role || '|' || family AS k, sum(amount_upokt)::text AS a FROM ${S}.v_income_base WHERE height = $1 GROUP BY 1`,
          [height]
        );
        assert.deepEqual(Object.fromEntries(got.rows.map((r) => [r.k, r.a])), expected.income);
        // the loss the expectation summed from the raw legs (claimed minus burn), 0 where nothing was overserviced
        const loss = await c.query(
          `SELECT sum(overservicing_loss_upokt)::text l FROM ${S}.claim_settlements WHERE height = $1`,
          [height]
        );
        assert.equal(loss.rows[0].l, expected.overservicing_loss ?? "0");
        for (const [k, v] of Object.entries(expected.income)) if (k.endsWith("|validator|global")) proposer += BigInt(v);
        const claims = await c.query(`SELECT count(*)::int n FROM ${S}.claim_settlements WHERE height = $1`, [height]);
        assert.equal(claims.rows[0].n, expected.claims);
        const block = await c.query(`SELECT era, mint_ratio::text m FROM ${S}.settlement_blocks WHERE height = $1`, [height]);
        assert.deepEqual(block.rows, [{ era: "settlement_result", m: "1" }]);
      }
      // 200013 (a subset of the height): 14 proposer legs, 5 expirations and slashes as the chain had them
      const stakers = await c.query(
        `SELECT count(*)::int n, min(role) r, min(family) f FROM ${S}.staker_payouts WHERE height = 200013`
      );
      assert.deepEqual(stakers.rows, [{ n: 14, r: "validator", f: "global" }]);
      const exp = await c.query(
        `SELECT estimated_relays::text n FROM ${S}.claim_expirations WHERE height = 200013 ORDER BY event_idx LIMIT 1`
      );
      assert.deepEqual(exp.rows, [{ n: "3107" }]); // 49070129 / (40911890 / 2591)
      const slash = await c.query(
        `SELECT count(*)::int n, count(stake_after_upokt)::int s FROM ${S}.supplier_slashes WHERE height = 200013`
      );
      assert.deepEqual(slash.rows, [{ n: 5, s: 0 }]);
      assert.equal(BigInt(await flows()) - stakersBefore, proposer);
      // get_income for 96860's addresses: the rollups answer what the base tables do
      const addresses = [
        ...new Set(
          Object.keys(
            (
              JSON.parse(fs.readFileSync(path.join(FIXTURES, "settlement_96860.expected.json"), "utf8")) as {
                income: Record<string, string>;
              }
            ).income
          ).map((k) => k.split("|")[0])
        ),
      ].sort();
      const income = async () =>
        (
          await c.query(
            `SELECT address, role, family, sum(amount_upokt)::text a FROM ${S}.get_income($1::text[], NULL, NULL)
             GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`,
            [addresses]
          )
        ).rows;
      const fromRollups = await income();
      assert.ok(fromRollups.length > 0);
      await c.query("SET LOCAL money.no_rollup = on");
      assert.deepEqual(await income(), fromRollups);
      await c.query("SET LOCAL money.no_rollup = off");
      // the catalog reads 96860's loss back (overserviced_unpaid_upokt): its one application settles at no other
      // height of this test
      const spend = await c.query(
        `SELECT count(*)::int n, sum(overserviced_unpaid_upokt)::text l FROM ${S}.get_application_spend($1::text[], NULL, NULL)`,
        [[...new Set(payloadOf("96860", false).payload.claims.map((x) => x.application_id))]]
      );
      assert.ok(Number(spend.rows[0].n) > 0);
      assert.equal(spend.rows[0].l, "41721679747");
      const before = await md5All();
      for (const name of ["96860", "130000", "200013"]) {
        const { height, payload } = payloadOf(name, false);
        await send(height, payload);
      }
      assert.equal(await md5All(), before);
      await c.query(`CALL ${S}.rebuild_rollups('2026-09-01')`);
      assert.equal(await md5All(), before);
    } finally {
      await c.query("ROLLBACK");
    }
  });

  it("writes map-era heights with the slices their bank legs paid, and rewrites them identically", async () => {
    // in one rolled-back transaction, like the settlement_result test: older eras refuse validator rewards from 11:00
    // 694053: a supplier paying one shareholder address twice (poktroll v0.1.31), its legs above the shareholders' slice
    // 699213: the same supplier with a global shareholder slice, paid twice too (M1)
    const names = ["250053", "270033", "350013", "430053", "699993", "694053", "699213"];
    const send = async (height: number, payload: SettlementPayload) => {
      for (const { bind, sql } of writeSettlementCalls(S, height, payload)) await c.query(sql, bind);
    };
    await c.query("BEGIN");
    try {
      for (const name of names) {
        const { height, payload } = payloadOf(name, false);
        await send(height, payload);
        const expected = JSON.parse(fs.readFileSync(path.join(FIXTURES, `settlement_${name}.expected.json`), "utf8")) as {
          claims: number;
          income: Record<string, string>;
        };
        const got = await c.query(
          `SELECT address || '|' || role || '|' || family AS k, sum(amount_upokt)::text AS a FROM ${S}.v_income_base WHERE height = $1 GROUP BY 1`,
          [height]
        );
        assert.deepEqual(Object.fromEntries(got.rows.map((r) => [r.k, r.a])), expected.income, name);
        const rows = await c.query(
          `SELECT (SELECT count(*)::int FROM ${S}.claim_settlements WHERE height = $1) claims,
                  (SELECT era FROM ${S}.settlement_blocks WHERE height = $1) era,
                  (SELECT count(*)::int FROM ${S}.staker_payouts WHERE height = $1 AND event_idx <> -1) per_claim,
                  (SELECT count(*)::int FROM ${S}.staker_payouts WHERE height = $1 AND role = 'delegator') delegators,
                  (SELECT count(*)::int FROM ${S}.delegator_validator_payouts WHERE height = $1 AND validator_operator = '') dv,
                  (SELECT coalesce(sum(amount_upokt), 0)::text FROM ${S}.delegator_validator_payouts WHERE height = $1) dv_upokt,
                  (SELECT coalesce(sum(amount_upokt), 0)::text FROM ${S}.staker_payouts WHERE height = $1) staker_upokt,
                  (SELECT coalesce(sum(pool_share_upokt), 0)::text FROM ${S}.validator_distributions WHERE height = $1) pool_upokt,
                  (SELECT count(DISTINCT row_source)::int FROM ${S}.claim_settlements WHERE height = $1 AND row_source = 'bank') bank`,
          [height]
        );
        const r = rows.rows[0];
        assert.equal(r.claims, expected.claims, name);
        assert.equal(r.era, eraAtHeight("pocket", height));
        assert.equal(r.per_claim, 0);
        // from 288,180 (map_proposer_operator) the staker legs are replayed per validator, none unattributed ('');
        // before it the network split nothing per validator
        assert.equal(r.dv, 0, name);
        const replayed = height >= 288180;
        assert.equal(r.dv_upokt, replayed ? r.staker_upokt : "0", name);
        assert.equal(r.pool_upokt, replayed ? r.staker_upokt : "0", name);
        assert.equal(r.bank, 1);
      }
      // the chain's staker share, floor(146342 × 0.14); its relay legs leave 146342 − 179196 − 6587 − 3658
      const dup = await c.query(
        `SELECT relay_to_stakers_upokt::text k, (relay_minted_upokt - relay_to_supplier_upokt - relay_to_dao_upokt
                - relay_to_source_owner_upokt - relay_to_application_upokt)::text left_upokt
         FROM ${S}.claim_settlements WHERE height = 694053 AND supplier_id = 'pokt1gfxp7uv8cdx4ef84xvc5y0davsul83acmutcf9'`
      );
      assert.deepEqual(dup.rows, [{ k: "20487", left_upokt: "-43099" }]);
      // 699213, the same claim with a global slice: G = 29, the shareholders' slice floor(29 × 0.8) = 23, and the bank
      // legs pay 4 to the supplier and 16 twice to pokt1mvz6… (36, 13 overpaid, which M1 adds)
      const glob = await c.query(
        `SELECT c.global_minted_upokt::text g, c.global_to_supplier_upokt::text s, p.global_upokt::text p
         FROM ${S}.claim_settlements c
         JOIN ${S}.shareholder_payouts p USING (height, event_idx)
         WHERE c.height = 699213 AND c.supplier_id = 'pokt1gfxp7uv8cdx4ef84xvc5y0davsul83acmutcf9'
           AND p.recipient_id = 'pokt1mvz6gf82quaal497gcpz2pt50qvynuxsp4up44'`
      );
      assert.deepEqual(glob.rows, [{ g: "29", s: "36", p: "32" }]);
      const before = await md5All();
      for (const name of names) {
        const { height, payload } = payloadOf(name, false);
        await send(height, payload);
      }
      assert.equal(await md5All(), before);
      await c.query(`CALL ${S}.rebuild_rollups('2026-09-01')`);
      assert.equal(await md5All(), before);
    } finally {
      await c.query("ROLLBACK");
    }
  });

  it("daily_claims_by_supplier counts the claims settled with a proof, as the base table does", async () => {
    const base = await c.query(
      `SELECT supplier_id s, (block_time AT TIME ZONE 'UTC')::date::text d, count(*) FILTER (WHERE settled_with_proof)::int p
       FROM ${S}.claim_settlements GROUP BY 1, 2 ORDER BY 1, 2`
    );
    const rollup = await c.query(
      `SELECT supplier_id s, day::text d, claims_with_proof::int p FROM ${S}.daily_claims_by_supplier ORDER BY 1, 2`
    );
    assert.ok(base.rows.some((r) => Number(r.p) > 0));
    assert.deepEqual(rollup.rows, base.rows);
  });

  it("rewriting a height leaves every table identical, and rebuild_rollups equals the incremental rollups", async () => {
    const before = await md5All();
    for (const [name, withDelegations] of [
      ["899713", true],
      ["694993", false],
      ["710013", false],
    ] as const) {
      const { height, payload } = payloadOf(name, withDelegations);
      await write(height, payload);
    }
    assert.equal(await md5All(), before);
    await c.query("BEGIN");
    await c.query(`CALL ${S}.rebuild_rollups('2026-09-01')`);
    await c.query("COMMIT");
    assert.equal(await md5All(), before);
  });

  it("every rollup in the catalog is added, probed, cleared of zeros and rebuilt by the writer, and hidden", async () => {
    // the rollups are the schema's hourly_ / daily_ / monthly_ tables, read from the catalog: a new one that misses a
    // place fails here instead of drifting on its first rewritten height
    const rollups = (
      await c.query(
        `SELECT c.relname, obj_description(c.oid, 'pg_class') tag, array_to_string(c.reloptions, ',') opts FROM pg_class c
         WHERE c.relnamespace = $1::regnamespace AND c.relkind = 'r' AND c.relname ~ '^(hourly|daily|monthly)_' ORDER BY 1`,
        [S]
      )
    ).rows;
    assert.equal(rollups.length, 12);
    const src = async (name: string) =>
      String(
        (await c.query(`SELECT prosrc FROM pg_proc WHERE pronamespace = $1::regnamespace AND proname = $2`, [S, name]))
          .rows[0].prosrc
      );
    const apply = await src("_rollup_apply");
    const rebuild = await src("rebuild_rollups");
    const subtract = apply.slice(apply.lastIndexOf("IF sg < 0 THEN"));
    const raise = subtract.indexOf("RAISE EXCEPTION 'rollup drift");
    const [probe, zeros] = [
      subtract.slice(0, raise),
      // up to the END IF of the subtraction, not of the probe
      subtract.slice(raise, subtract.indexOf("\n  END IF;", raise)),
    ];
    for (const r of rollups) {
      const t = String(r.relname);
      const ref = (verb: string) => new RegExp(`${verb} ${S}\\.${t}\\b`);
      assert.match(apply, ref("INSERT INTO"), `${t}: added`);
      assert.match(probe, ref("FROM"), `${t}: probed on subtraction`);
      assert.match(zeros, ref("DELETE FROM"), `${t}: zero rows deleted`);
      assert.match(rebuild, ref("DELETE FROM"), `${t}: rebuilt`);
      assert.ok(String(r.tag).startsWith("@omit"), `${t}: hidden from GraphQL`);
      assert.ok(String(r.opts).includes("fillfactor=90"), `${t}: fillfactor`);
      assert.ok(TABLES.includes(t), `${t}: in the md5 of the rewrite and rebuild tests`);
    }
  });

  it("the monthly supplier×service rollup summed over services is the daily supplier rollup of the month", async () => {
    // both come from _inc; the daily one also has the 'stakers' row per supplier, which is not an address's income
    const diff = await c.query(`
      WITH m AS (SELECT month, address, supplier_id, role, family, sum(amount_upokt)::bigint a, sum(transfer_count)::bigint n,
                        sum(contribution_count)::bigint k
                 FROM ${S}.monthly_income_by_address_supplier_service GROUP BY 1, 2, 3, 4, 5),
           d AS (SELECT date_trunc('month', day)::date AS month, address, supplier_id, role, family, sum(amount_upokt)::bigint a,
                        sum(transfer_count)::bigint n, sum(contribution_count)::bigint k
                 FROM ${S}.daily_income_by_address_supplier WHERE role <> 'stakers' GROUP BY 1, 2, 3, 4, 5)
      SELECT (SELECT count(*) FROM m)::int n_rows, (SELECT count(*) FROM (SELECT * FROM m EXCEPT SELECT * FROM d) x)::int only_m,
             (SELECT count(*) FROM (SELECT * FROM d EXCEPT SELECT * FROM m) x)::int only_d`);
    assert.ok(Number(diff.rows[0].n_rows) > 0);
    assert.deepEqual([diff.rows[0].only_m, diff.rows[0].only_d], [0, 0]);
  });

  it("rewriting 710013 over a corrupted commission or replayed count, or a commission left on a replayed-only row, is drift", async () => {
    const before = await md5All();
    const { height, payload } = payloadOf("710013", false);
    const rows = (
      await c.query(
        `SELECT validator_operator v, family f, commission_upokt::text c, commission_na_count::int na, contribution_count::int n
         FROM ${S}.daily_validator_rewards WHERE day = '2026-09-01' ORDER BY 1, 2`
      )
    ).rows;
    // a validator 710013 and a batched_vrd height both paid, and one only 710013 paid (no commission)
    const mixed = rows.find((r) => r.c !== null && Number(r.na) > 0 && Number(r.na) < Number(r.n));
    const replayedOnly = rows.find((r) => r.c === null && r.na === r.n);
    assert.ok(
      mixed && replayedOnly,
      "precondition: the 'writes settlement 899713 / 694993 / 710013' tests above wrote day 2026-09-01, with 710013 " +
        "replayed (no commission) next to the batched_vrd heights; this test needs a validator both paid and one only 710013 paid"
    );
    for (const [r, set, back] of [
      [mixed, "commission_na_count = commission_na_count - 1", "commission_na_count = commission_na_count + 1"],
      [replayedOnly, "commission_upokt = 7", "commission_upokt = NULL"],
    ] as const) {
      const where = `WHERE day = '2026-09-01' AND validator_operator = $1 AND family = $2`;
      await c.query(`UPDATE ${S}.daily_validator_rewards SET ${set} ${where}`, [r.v, r.f]);
      await assert.rejects(write(height, payload), /rollup drift at height 710013/);
      await c.query(`UPDATE ${S}.daily_validator_rewards SET ${back} ${where}`, [r.v, r.f]);
    }
    // the delegator rollup's replayed_count out of [0, contribution_count] is drift too
    const d = (
      await c.query(
        `SELECT delegator, validator_operator v, family f FROM ${S}.daily_delegator_rewards_by_validator
         WHERE day = '2026-09-01' AND replayed_count > 0 ORDER BY 1, 2, 3 LIMIT 1`
      )
    ).rows[0];
    assert.ok(d, "precondition: 710013 wrote replayed delegator rows on 2026-09-01");
    for (const delta of [1000000, -1000000]) {
      const where = `WHERE day = '2026-09-01' AND delegator = $1 AND validator_operator = $2 AND family = $3`;
      const set = (k: number) =>
        c.query(`UPDATE ${S}.daily_delegator_rewards_by_validator SET replayed_count = replayed_count + $4 ${where}`, [
          d.delegator,
          d.v,
          d.f,
          k,
        ]);
      await set(delta);
      await assert.rejects(write(height, payload), /rollup drift at height 710013/);
      await set(-delta);
    }
    assert.equal(await md5All(), before);
  });

  it("rewriting a height written with another rollup version asks for rebuild_rollups first", async () => {
    const before = await md5All();
    const { height, payload } = payloadOf("710013", false);
    await c.query(`UPDATE ${S}.settlement_blocks SET rollup_version = 1 WHERE height = $1`, [height]);
    await assert.rejects(write(height, payload), /written with rollup version 1, .*: run rebuild_rollups first/);
    await c.query(`UPDATE ${S}.settlement_blocks SET rollup_version = $2 WHERE height = $1`, [height, ROLLUP_VERSION]);
    assert.equal(await md5All(), before);
  });

  it("a payload sent in parts writes exactly what one call writes, and heights in one transaction stay apart", async () => {
    const written = await c.query(`SELECT count(*)::int n FROM ${S}.claim_settlements`);
    assert.ok(Number(written.rows[0].n) > 0);
    const before = await md5All();
    const big = payloadOf("899713", true);
    const small = payloadOf("694993", false);
    const calls = [
      ...writeSettlementCalls(S, big.height, big.payload, 1000),
      ...writeSettlementCalls(S, small.height, small.payload, 1000),
    ];
    assert.ok(calls.length > 10);
    await c.query("BEGIN");
    try {
      for (const { bind, sql } of calls) await c.query(sql, bind);
      await c.query("COMMIT");
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    }
    assert.equal(await md5All(), before);
  });

  it("parts sent outside one transaction stop the height instead of writing what is left", async () => {
    const before = await md5All();
    const big = payloadOf("899713", true);
    const calls = writeSettlementCalls(S, big.height, big.payload, 1000);
    assert.ok(calls.length > 2);
    // autocommit: each _stage_settlement commits and its staging tables drop, so only the last part reaches the writer
    for (const { bind, sql } of calls.slice(0, -1)) await c.query(sql, bind);
    const last = calls[calls.length - 1];
    await assert.rejects(c.query(last.sql, last.bind), /staged rows differ from the counts/);
    assert.equal(await md5All(), before);
  });

  it("get_income returns the expected income per address, from the rollups and from the base tables", async () => {
    // both fixtures are written with ts 2026-09-01 12:00 UTC (payloadOf)
    const want = new Map<string, bigint>();
    for (const name of ["899713", "694993"]) {
      const { income } = JSON.parse(
        fs.readFileSync(path.join(FIXTURES, `settlement_${name}.expected.json`), "utf8")
      ) as { income: Record<string, string> };
      for (const [k, a] of Object.entries(income)) {
        const address = k.split("|")[0];
        want.set(address, (want.get(address) ?? BigInt(0)) + BigInt(a));
      }
    }
    const addresses = [...want.keys()].sort().slice(0, 5);
    for (const [from, to] of [
      [null, null], // whole UTC days: daily_income_by_address
      ["2026-09-01T11:00:00Z", "2026-09-01T13:00:00Z"], // inside one day: settlement_income_by_address
    ]) {
      const got = await c.query(
        `SELECT address, sum(amount_upokt)::text a FROM ${S}.get_income($1::text[], $2, $3) GROUP BY 1`,
        [addresses, from, to]
      );
      assert.deepEqual(
        Object.fromEntries(got.rows.map((r) => [r.address, r.a])),
        Object.fromEntries(addresses.map((a) => [a, String(want.get(a))]))
      );
    }
  });

  it("with a bucket, every bucket up to the last settlement comes back for every series, zero where nothing settled", async () => {
    // both fixtures settle at 2026-09-01 12:00 UTC: 11:00-14:00 by hour lists 11:00 (zero) and 12:00; 13:00 is after
    // the last written settlement, so it is not indexed yet and is left out rather than reported as zero
    const address = (
      await c.query(`SELECT address FROM ${S}.v_income_base WHERE family = 'relay' GROUP BY 1 ORDER BY 1 LIMIT 1`)
    ).rows[0].address as string;
    const rows = (
      await c.query(
        `SELECT bucket_start, bucket_end, amount_upokt::text a FROM ${S}.get_income(addresses => $1::text[],
           range_start => '2026-09-01T11:00:00Z', range_end => '2026-09-01T14:00:00Z', bucket => 'hour',
           fill_empty_buckets => true)
         ORDER BY 1`,
        [[address]]
      )
    ).rows;
    assert.deepEqual(
      rows.map((r) => [new Date(r.bucket_start).toISOString(), new Date(r.bucket_end).toISOString()]),
      [
        ["2026-09-01T11:00:00.000Z", "2026-09-01T12:00:00.000Z"],
        ["2026-09-01T12:00:00.000Z", "2026-09-01T13:00:00.000Z"],
      ]
    );
    assert.equal(rows[0].a, "0");
    assert.ok(BigInt(rows[1].a) > BigInt(0));
    // by default (fill_empty_buckets => false) only the buckets with rows, and so does the compat JSON (as the live function)
    const sparse = await c.query(
      `SELECT bucket_start FROM ${S}.get_income(addresses => $1::text[], range_start => '2026-09-01T11:00:00Z',
         range_end => '2026-09-01T14:00:00Z', bucket => 'hour')`,
      [[address]]
    );
    assert.deepEqual(
      sparse.rows.map((r) => new Date(r.bucket_start).toISOString()),
      ["2026-09-01T12:00:00.000Z"]
    );
    const compat = await c.query(
      `SELECT ${S}.legacy_rewards_by_addresses_and_time_group_by_date($1::text[], '2026-09-01 11:00', '2026-09-01 13:59:59',
         'hour') j`,
      [[address]]
    );
    assert.deepEqual(
      (compat.rows[0].j as unknown as { date_truncated: string }[]).map((e) => e.date_truncated),
      ["2026-09-01T12:00:00"]
    );
    // a far range end does not generate empty buckets past the last settlement
    const months = await c.query(
      `SELECT count(*)::int n FROM ${S}.get_income(addresses => $1::text[], range_start => '2026-08-01T00:00:00Z',
         range_end => '2100-01-01T00:00:00Z', bucket => 'month', fill_empty_buckets => true)`,
      [[address]]
    );
    assert.ok(Number(months.rows[0].n) <= 2);
  });

  it("get_service_usage with top_by_settled returns the services that settled the most, in place of a list", async () => {
    const expected = (
      await c.query(
        `SELECT service_id, sum(settled_upokt)::text settled FROM ${S}.claim_settlements
         GROUP BY 1 ORDER BY sum(settled_upokt) DESC, service_id COLLATE "C" LIMIT 2`
      )
    ).rows;
    const rows = (
      await c.query(
        `SELECT service_id, settled_upokt::text settled FROM ${S}.get_service_usage(services => NULL,
           range_start => NULL, range_end => NULL, top_by_settled => 2) ORDER BY settled_upokt DESC, service_id COLLATE "C"`
      )
    ).rows;
    assert.ok(expected.length > 0);
    assert.deepEqual(rows, expected);
    // rows come in rank order, rank_by_settled = place in the top; NULL when the services are named
    const ranked = (
      await c.query(
        `SELECT service_id, rank_by_settled r FROM ${S}.get_service_usage(services => NULL, range_start => NULL,
           range_end => NULL, top_by_settled => 2)`
      )
    ).rows;
    assert.deepEqual(
      ranked,
      expected.map((e, i) => ({ service_id: e.service_id, r: i + 1 }))
    );
    const named = await c.query(
      `SELECT DISTINCT rank_by_settled r FROM ${S}.get_service_usage(services => $1::text[], range_start => NULL,
         range_end => NULL)`,
      [expected.map((e) => e.service_id)]
    );
    assert.deepEqual(named.rows, [{ r: null }]);
    // a mid-day range by hour (edges only, no rollup day) gives the same series as naming those services
    const series = (sql: string, params: unknown[]) =>
      c.query(
        `SELECT bucket_start, service_id, settled_upokt::text, relays::text, claims FROM ${S}.get_service_usage(${sql},
           range_start => '2026-09-01T11:00:00Z', range_end => '2026-09-01T14:00:00Z', bucket => 'hour')
         ORDER BY bucket_start, service_id COLLATE "C"`,
        params
      );
    const byTop = (await series("services => NULL, top_by_settled => 2", [])).rows;
    const byName = (await series("services => $1::text[]", [expected.map((r) => r.service_id)])).rows;
    assert.ok(byTop.length > 0);
    assert.deepEqual(byTop, byName);
    // both: the top among the given services (the second-best alone in the list is its number 1)
    const within = await c.query(
      `SELECT service_id, rank_by_settled r FROM ${S}.get_service_usage($1::text[], NULL, NULL, top_by_settled => 1)`,
      [[expected[expected.length - 1].service_id, "no-such-service"]]
    );
    assert.deepEqual(within.rows, [{ service_id: expected[expected.length - 1].service_id, r: 1 }]);
    await assert.rejects(
      c.query(`SELECT * FROM ${S}.get_service_usage(NULL, NULL, NULL)`),
      /pass services, top_by_settled, or both/
    );
  });

  it("get_supplier_penalties gives a slash its claim's expiration reason and NULL where a kind has no value", async () => {
    await c.query("BEGIN");
    try {
      const h = (await c.query(`SELECT max(height) h FROM ${S}.settlement_blocks`)).rows[0].h as string;
      await c.query(
        `INSERT INTO ${S}.claim_expirations VALUES ($1, 900001, 'sup-x', 'app-x', 'svc-x', 100, 50, 'PROOF_INVALID', 7, 7, 7, 7)`,
        [h]
      );
      await c.query(`INSERT INTO ${S}.supplier_slashes VALUES ($1, 900002, 'sup-x', 'app-x', 'svc-x', 100, 30, 970)`, [h]);
      // a slash whose claim has no expiration row keeps its own 'unknown' series
      await c.query(`INSERT INTO ${S}.supplier_slashes VALUES ($1, 900003, 'sup-x', 'app-y', 'svc-x', 100, 5, 965)`, [h]);
      const rows = (
        await c.query(
          `SELECT kind, reason, claimed_upokt::text claimed, slashed_upokt::text slashed, relays::text relays
           FROM ${S}.get_supplier_penalties(ARRAY['sup-x'], NULL, NULL) ORDER BY kind, reason`
        )
      ).rows;
      assert.deepEqual(rows, [
        { kind: "expired", reason: "PROOF_INVALID", claimed: "50", slashed: null, relays: "7" },
        { kind: "slashed", reason: "PROOF_INVALID", claimed: null, slashed: "30", relays: null },
        { kind: "slashed", reason: "unknown", claimed: null, slashed: "5", relays: null },
      ]);
    } finally {
      await c.query("ROLLBACK");
    }
  });

  it("get_delegator_income gives the same total per delegator with and without by_validator", async () => {
    // a mid-day range reads the base edges; the whole history reads the rollup
    for (const [from, to] of [
      [null, null],
      ["2026-09-01T11:30:00Z", "2026-09-01T12:30:00Z"],
    ]) {
      const q = (byValidator: boolean) =>
        c.query(
          `SELECT delegator, sum(amount_upokt)::text a FROM ${S}.get_delegator_income(
             ARRAY(SELECT DISTINCT delegator FROM ${S}.delegator_validator_payouts ORDER BY 1 LIMIT 200), $1, $2,
             by_validator => $3) GROUP BY 1 ORDER BY 1`,
          [from, to, byValidator]
        );
      const total = (await q(false)).rows;
      assert.ok(total.length > 0);
      assert.deepEqual(total, (await q(true)).rows);
      // a pure delegator (no validator role) gets exactly what the chain paid it as delegator
      const chain = (
        await c.query(
          `SELECT address delegator, sum(amount_upokt)::text a FROM ${S}.get_income($1::text[], $2, $3)
           WHERE role = 'delegator' AND address NOT IN (SELECT address FROM ${S}.get_income($1::text[], $2, $3) WHERE role = 'validator')
           GROUP BY 1 ORDER BY 1`,
          [total.map((r) => r.delegator), from, to]
        )
      ).rows;
      assert.ok(chain.length > 0);
      const byDelegator = new Map(total.map((r) => [r.delegator, r.a]));
      for (const r of chain) assert.equal(byDelegator.get(r.delegator), r.a, String(r.delegator));
    }
  });

  it("get_delegator_income by_validator shows detailed_batch income per validator, derived and with no commission", async () => {
    const want = await c.query(
      `SELECT delegator, validator_operator, sum(amount_upokt)::text a FROM ${S}.delegator_validator_payouts
       WHERE height = 710013 GROUP BY 1, 2 ORDER BY 1, 2 LIMIT 200`
    );
    assert.ok(want.rows.length > 0);
    const src = await c.query(
      `SELECT DISTINCT row_source FROM ${S}.delegator_validator_payouts WHERE height = 710013
       UNION ALL SELECT DISTINCT row_source FROM ${S}.validator_distributions WHERE height = 710013`
    );
    assert.deepEqual(src.rows, [{ row_source: "derived_split" }, { row_source: "derived_split" }]);
    const vd = await c.query(
      `SELECT count(*)::int n, count(commission_upokt)::int c, count(commission_rate)::int r FROM ${S}.validator_distributions
       WHERE height = 710013`
    );
    assert.deepEqual(vd.rows, [{ n: 20, c: 0, r: 0 }]);
  });


  it("get_validator_rewards: commission unknown is NULL and counted, replayed rows counted, and the delegated stake seen", async () => {
    // the mixed day: 710013 replayed (no commission) and 899713 / 694993 batched_vrd, on 2026-09-01
    const base = await c.query(
      `SELECT validator_operator v, sum(commission_upokt)::text c, count(*) FILTER (WHERE commission_upokt IS NULL)::int na,
              count(*)::int n, count(*) FILTER (WHERE row_source IN ('replay', 'derived_split'))::int rp,
              avg(total_delegated_stake_upokt)::text sa, min(total_delegated_stake_upokt)::text smin,
              max(total_delegated_stake_upokt)::text smax
       FROM ${S}.validator_distributions GROUP BY 1 ORDER BY 1`
    );
    const got = await c.query(
      `SELECT validator_operator v, commission_upokt::text c, commission_unknown_count::int na, distributions::int n,
              replayed_count::int rp, delegated_stake_avg_upokt::text sa, delegated_stake_min_upokt::text smin,
              delegated_stake_max_upokt::text smax
       FROM ${S}.get_validator_rewards(NULL, NULL, NULL) ORDER BY 1`
    );
    assert.deepEqual(got.rows, base.rows);
    assert.ok(got.rows.some((r) => r.c === null) && got.rows.some((r) => r.c !== null && Number(r.na) > 0));
    assert.ok(got.rows.some((r) => Number(r.rp) > 0));
    // a group total mixes validators: no stake
    const group = await c.query(
      `SELECT delegated_stake_avg_upokt a, delegated_stake_min_upokt mi, delegated_stake_max_upokt ma, distributions::int n
       FROM ${S}.get_validator_rewards(NULL, NULL, NULL, by_validator => false)`
    );
    assert.deepEqual(group.rows, [{ a: null, mi: null, ma: null, n: base.rows.reduce((t, r) => t + Number(r.n), 0) }]);
    // by hour with fill: the settlement hour carries the rows, the empty hour is 0 with no stake seen
    const hours = await c.query(
      `SELECT bucket_start, commission_upokt::text c, distributions::int n, delegated_stake_avg_upokt s
       FROM ${S}.get_validator_rewards(ARRAY[$1], '2026-09-01T11:00:00Z', '2026-09-01T13:00:00Z', 'hour',
         fill_empty_buckets => true)`,
      [base.rows.find((r) => r.c === null)?.v]
    );
    // rows come newest first
    assert.deepEqual(hours.rows.map((r) => [new Date(r.bucket_start).toISOString(), r.c, r.n, r.s === null]), [
      ["2026-09-01T12:00:00.000Z", null, 1, false],
      ["2026-09-01T11:00:00.000Z", "0", 0, true],
    ]);
    // a range that starts in an older era answers (there are just no distributions there) instead of raising
    await c.query("BEGIN");
    try {
      await c.query(
        `INSERT INTO ${S}.settlement_blocks (height, block_time, era, dao_address, day, rollup_version)
         VALUES (1000, '2026-08-31T12:00:00Z', 'settlement_result', NULL, '2026-08-31', 1)`
      );
      const all = await c.query(`SELECT count(*)::int n FROM ${S}.get_validator_rewards(NULL, '2026-08-31T00:00:00Z', NULL)`);
      assert.equal(all.rows[0].n, base.rows.length);
    } finally {
      await c.query("ROLLBACK");
    }
  });

  it("a NULL id list with by_<entity> => false still returns its zero group row when nothing matched", async () => {
    for (const sql of [
      `SELECT delegator, amount_upokt::text a FROM ${S}.get_delegator_income(NULL, NULL, NULL, by_delegator => false,
         validators => ARRAY['poktvaloper1nosuch'], fill_empty_buckets => true)`,
      `SELECT validator_operator, total_upokt::text a FROM ${S}.get_validator_rewards(NULL, '2026-09-01T00:00:00Z',
         '2026-09-01T01:00:00Z', by_validator => false, fill_empty_buckets => true)`,
      `SELECT supplier_id, claimed_upokt::text a FROM ${S}.get_supplier_earnings(NULL, '2026-09-01T00:00:00Z',
         '2026-09-01T01:00:00Z', by_supplier => false, fill_empty_buckets => true)`,
    ]) {
      const { rows } = await c.query(sql);
      assert.deepEqual(rows.map((r) => Object.values(r)), [["all", "0"]], sql);
      const sparse = await c.query(sql.replace(", fill_empty_buckets => true", ""));
      assert.deepEqual(sparse.rows, [], `${sql}: by default an idle group is absent, which means 0`);
    }
    await c.query("BEGIN");
    try {
      await c.query(`
        CREATE TABLE ${S}.msg_submit_proofs (supplier_id text, service_id text, block_id numeric);
        CREATE TABLE ${S}.event_proof_validity_checkeds (supplier_id text, service_id text, block_id numeric,
          proof_validation_status text, failure_reason text);`);
      const { rows } = await c.query(
        `SELECT supplier_id, proofs_submitted::text a FROM ${S}.get_supplier_proofs(NULL, '2026-09-01T00:00:00Z',
           '2026-09-01T01:00:00Z', by_supplier => false, fill_empty_buckets => true)`
      );
      assert.deepEqual(rows.map((r) => Object.values(r)), [["all", "0"]]);
    } finally {
      await c.query("ROLLBACK");
    }
  });

  it("the compat functions take any number of addresses, the catalog functions at most 200", async () => {
    const many = Array.from({ length: 250 }, (_, i) => `pokt1fake${i}`);
    const { rows } = await c.query(
      `SELECT ${S}.legacy_rewards_by_addresses_and_time($1::text[], '2026-09-01 00:00', '2026-09-02 00:00') a`,
      [[...many, "x"]]
    );
    assert.equal(rows[0].a, "0");
    await assert.rejects(c.query(`SELECT * FROM ${S}.get_income($1::text[], NULL, NULL)`, [many]), /between 1 and 200/);
  });

  it("the supplier compat functions sum what get_income gives for those suppliers, and nothing for no list", async () => {
    const address = (
      await c.query(`SELECT address FROM ${S}.v_income_base WHERE supplier_id <> '' GROUP BY 1
                     ORDER BY count(DISTINCT supplier_id) DESC, 1 LIMIT 1`)
    ).rows[0].address as string;
    const all = (
      await c.query(`SELECT array_agg(DISTINCT supplier_id ORDER BY supplier_id) s FROM ${S}.v_income_base
                     WHERE address = $1 AND supplier_id <> ''`, [address])
    ).rows[0].s as unknown as string[];
    assert.ok(all.length >= 3);
    const some = all.filter((_, i) => i % 2 === 0);
    for (const [from, to] of [
      ["2026-09-01 00:00", "2026-09-01 23:59:59.999999"], // a whole UTC day: the rollups
      ["2026-09-01 11:00", "2026-09-01 12:59:59.999999"], // inside the day: the base tables
    ]) {
      const want = (
        await c.query(
          `SELECT sum(amount_upokt)::text a FROM ${S}.get_income(ARRAY[$1], $2::timestamp AT TIME ZONE 'UTC',
             ($3::timestamp + interval '1 microsecond') AT TIME ZONE 'UTC', by_supplier => true)
           WHERE supplier_id = ANY($4::text[])`,
          [address, from, to, some]
        )
      ).rows[0].a as string;
      const total = (
        await c.query(
          `SELECT sum(amount_upokt)::text a FROM ${S}.get_income(ARRAY[$1], $2::timestamp AT TIME ZONE 'UTC',
             ($3::timestamp + interval '1 microsecond') AT TIME ZONE 'UTC', by_supplier => true)`,
          [address, from, to]
        )
      ).rows[0].a as string;
      assert.ok(BigInt(want) > BigInt(0) && BigInt(want) < BigInt(total));
      const d6 = await c.query(`SELECT ${S}.legacy_rewards_of_addresses_by_suppliers_and_time(ARRAY[$1], $2, $3, $4)::text a`, [
        address,
        some,
        from,
        to,
      ]);
      assert.equal(d6.rows[0].a, want);
      const d5 = await c.query(
        `SELECT ${S}.legacy_rewards_by_suppliers_and_time_group_by_address_and_date(ARRAY[$1], $2, $3, $4, 'day') j`,
        [address, some, from, to]
      );
      const rows = d5.rows[0].j as unknown as { total_amount: number | string }[];
      assert.equal(rows.length, 1);
      assert.equal(String(rows[0].total_amount), want);
    }
    for (const list of [null, [], [""], ["pokt1nosuchsupplier"]]) {
      const none = await c.query(
        `SELECT ${S}.legacy_rewards_of_addresses_by_suppliers_and_time(ARRAY[$1], $2, '2026-09-01', '2026-09-02')::text a`,
        [address, list]
      );
      assert.deepEqual([list, none.rows[0].a], [list, "0"]);
    }
    // by month: the whole of September from the monthly rollup, the same total
    const month = await c.query(
      `SELECT ${S}.legacy_rewards_by_suppliers_and_time_group_by_address_and_date(ARRAY[$1], $2, '2026-09-01',
         '2026-09-30 23:59:59.999999', 'month') j`,
      [address, some]
    );
    const day = await c.query(
      `SELECT ${S}.legacy_rewards_of_addresses_by_suppliers_and_time(ARRAY[$1], $2, '2026-09-01', '2026-09-30 23:59:59.999999')::text a`,
      [address, some]
    );
    const months = month.rows[0].j as unknown as { total_amount: number | string }[];
    assert.deepEqual(months.map((m) => String(m.total_amount)), [day.rows[0].a]);
    // by hour: the whole hour from hourly_income_by_address_supplier and the partial hour at the edge from the base
    for (const [from, to] of [
      ["2026-09-01 11:00", "2026-09-01 12:59:59.999999"],
      ["2026-09-01 11:30", "2026-09-01 12:30"],
    ]) {
      const hours = await c.query(
        `SELECT ${S}.legacy_rewards_by_suppliers_and_time_group_by_address_and_date(ARRAY[$1], $2, $3, $4, 'hour') j`,
        [address, some, from, to]
      );
      const want = await c.query(
        `SELECT to_char(bucket_start AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') d, sum(amount_upokt)::text a
         FROM ${S}.get_income(ARRAY[$1], $3::timestamp AT TIME ZONE 'UTC', ($4::timestamp + interval '1 microsecond') AT TIME ZONE 'UTC',
           'hour', by_supplier => true, fill_empty_buckets => false)
         WHERE supplier_id = ANY($2::text[]) GROUP BY 1 ORDER BY 1`,
        [address, some, from, to]
      );
      const got = hours.rows[0].j as unknown as { date_truncated: string; total_amount: number | string }[];
      assert.ok(want.rows.length > 0);
      assert.deepEqual(
        got.map((g) => [g.date_truncated, String(g.total_amount)]),
        want.rows.map((w) => [w.d, w.a])
      );
    }
    for (const list of [null, []]) {
      const d5 = await c.query(
        `SELECT ${S}.legacy_rewards_by_suppliers_and_time_group_by_address_and_date(ARRAY[$1], $2, '2026-09-01', '2026-09-02', 'day') j`,
        [address, list]
      );
      assert.deepEqual([list, d5.rows[0].j], [list, null]);
    }
  });

  it("_bucket_end is inlined: the plan of a query that calls it has no call to it", async () => {
    const plan = await c.query(
      `EXPLAIN (VERBOSE) SELECT ${S}._bucket_end('day', block_time, block_time) FROM ${S}.settlement_blocks`
    );
    assert.ok(!plan.rows.map((r) => r["QUERY PLAN"]).join("\n").includes("_bucket_end"));
  });

  it("a filled series is the sparse rows plus one zero cell per missing (bucket, series), for every function that fills", async () => {
    // both fixtures settle at 2026-09-01 12:00 UTC: 10:00-13:00 by hour has buckets 10, 11 (no settlement) and 12;
    // the day and week ranges start before the settlement and reach past the last one
    const address = (
      await c.query(`SELECT address FROM ${S}.v_income_base WHERE supplier_id <> '' GROUP BY 1
                     ORDER BY count(DISTINCT supplier_id) DESC, 1 LIMIT 1`)
    ).rows[0].address as string;
    const supplier = (await c.query(`SELECT supplier_id FROM ${S}.claim_settlements ORDER BY 1 LIMIT 1`)).rows[0]
      .supplier_id as string;
    const application = (await c.query(`SELECT application_id FROM ${S}.claim_settlements ORDER BY 1 LIMIT 1`)).rows[0]
      .application_id as string;
    const calls: Array<[string, string, string[], number]> = [
      // [function call without fill_empty_buckets, series key columns, list, expected bucket count]
      [`get_income(ARRAY[$1], '2026-09-01T10:00:00Z', '2026-09-01T13:00:00Z', 'hour', by_supplier => true`, "address, role, family, supplier_id, service_id", [address], 3],
      [`get_income(ARRAY[$1], '2026-08-25T00:00:00Z', '2026-09-10T00:00:00Z', 'week', by_supplier => true, by_address => false`, "address, role, family, supplier_id, service_id", [address], 2],
      [`get_supplier_earnings(ARRAY[$1], '2026-08-30T00:00:00Z', '2026-09-03T00:00:00Z', 'day', by_service => true`, "supplier_id, service_id, application_id", [supplier], 3],
      [`get_application_spend(ARRAY[$1], '2026-09-01T10:00:00Z', '2026-09-01T13:00:00Z', 'hour', by_supplier => true`, "application_id, service_id, supplier_id", [application], 3],
      [`get_supply_flows('2026-08-25T00:00:00Z', '2026-09-10T00:00:00Z', 'week', by_role => true`, "flow, role", [], 2],
    ];
    for (const [call, keys, list, buckets] of calls) {
      const args = list.length ? [list[0]] : [];
      const series = async (fill: boolean) =>
        (await c.query(`SELECT bucket_start, ${keys}, to_jsonb(x) j FROM ${S}.${call}, fill_empty_buckets => ${fill}) x`, args))
          .rows;
      const filled = await series(true);
      const sparse = await series(false);
      const key = (r: Record<string, unknown>) => keys.split(", ").map((k) => String(r[k])).join("|");
      const cell = (r: Record<string, unknown>) => `${new Date(String(r.bucket_start)).toISOString()}|${key(r)}`;
      const nseries = new Set(filled.map(key)).size;
      assert.ok(sparse.length > 0 && nseries > 0);
      // every cell exactly once
      assert.equal(new Set(filled.map(cell)).size, filled.length, call);
      assert.equal(filled.length, nseries * buckets, call);
      // the sparse rows come back unchanged, and every other cell is a zero row
      const sparseCells = new Map(sparse.map((r) => [cell(r), JSON.stringify(r.j)]));
      for (const r of filled) {
        const j = r.j as unknown as Record<string, unknown>;
        if (sparseCells.has(cell(r))) assert.equal(JSON.stringify(j), sparseCells.get(cell(r)), call);
        else
          for (const [k, v] of Object.entries(j).filter(([k]) => !["bucket_start", "bucket_end", ...keys.split(", ")].includes(k)))
            assert.ok(v === 0 || v === null, `${call}: ${k} = ${JSON.stringify(v)} in a filled cell`);
      }
    }
  });

  it("a range after the last written settlement returns no rows with a bucket, not a zero row per id", async () => {
    // both fixtures settle at 2026-09-01 12:00 UTC; those buckets are not indexed yet
    const address = (await c.query(`SELECT address FROM ${S}.v_income_base ORDER BY 1 LIMIT 1`)).rows[0].address as string;
    const supplier = (await c.query(`SELECT supplier_id FROM ${S}.claim_settlements ORDER BY 1 LIMIT 1`)).rows[0]
      .supplier_id as string;
    for (const [fn, list, from, to, bucket, extra] of [
      ["get_income", address, "2026-09-02T00:00:00Z", "2026-09-04T00:00:00Z", "day", ""],
      ["get_income", address, "2026-09-01T13:00:00Z", "2026-09-01T15:00:00Z", "hour", ""],
      ["get_income", address, "2026-09-02T00:00:00Z", "2026-09-04T00:00:00Z", "day", ", by_address => false"],
      ["get_supplier_earnings", supplier, "2026-09-02T00:00:00Z", "2026-09-04T00:00:00Z", "day", ""],
    ]) {
      const { rows } = await c.query(`SELECT * FROM ${S}.${fn}(ARRAY[$1], $2, $3, $4${extra})`, [list, from, to, bucket]);
      assert.deepEqual([fn, bucket, extra, rows.length], [fn, bucket, extra, 0]);
    }
  });

  it("GraphQL: every catalog function that returns rows is a plain list, and the helpers are hidden", async () => {
    // subql-query 2.22.2 adds a _block_range filter to every function connection, which the catalog rows lack
    const { rows } = await c.query(
      `SELECT p.proname, obj_description(p.oid, 'pg_proc') tag FROM pg_proc p
       WHERE p.pronamespace = $1::regnamespace AND p.prokind = 'f' AND p.proretset ORDER BY 1`,
      [S]
    );
    const tags = Object.fromEntries(rows.map((r) => [r.proname, r.tag]));
    const catalog = rows.map((r) => String(r.proname)).filter((n) => !n.startsWith("_"));
    assert.deepEqual(catalog, [
      "get_app_auto_unstakes", "get_application_spend", "get_delegator_income", "get_gateway_spend", "get_income",
      "get_param_history", "get_service_usage", "get_supplier_distribution", "get_supplier_earnings",
      "get_supplier_penalties", "get_supplier_proofs", "get_supply_flows", "get_validator_rewards", "money_coverage",
    ]);
    for (const n of catalog) assert.ok(String(tags[n]).startsWith("@simpleCollections only\n"), n);
    // the same functions have a description (smartTags.ts) and a _json twin (functions.ts)
    assert.deepEqual([...catalog].sort(), [...CATALOG_FUNCTIONS].sort());
    const twins = await c.query(
      `SELECT p.proname, obj_description(p.oid, 'pg_proc') tag FROM pg_proc p
       WHERE p.pronamespace = $1::regnamespace AND p.proname = ANY($2::text[]) ORDER BY 1`,
      [S, catalog.map((n) => n + "_json")]
    );
    assert.deepEqual(twins.rows.map((r) => r.proname), catalog.map((n) => n + "_json").sort());
    for (const r of twins.rows) assert.ok(/no row limit/.test(String(r.tag)) && !/@omit/.test(String(r.tag)), String(r.proname));
    for (const n of ["_buckets", "_income"]) assert.deepEqual([n, tags[n]], [n, "@omit"]);
    const vrd = await c.query(
      `SELECT count(*)::int n FROM pg_proc p WHERE p.pronamespace = $1::regnamespace AND p.proname = '_vrd_range_start'`,
      [S]
    );
    assert.equal(vrd.rows[0].n, 0);
  });

  it("get_supplier_earnings counts settled claims with and without a proof, from the rollup and from the base", async () => {
    const want = (
      await c.query(`SELECT supplier_id, count(*)::text n, count(*) FILTER (WHERE settled_with_proof)::text p
                     FROM ${S}.claim_settlements GROUP BY 1 ORDER BY count(*) FILTER (WHERE settled_with_proof) DESC, 1 LIMIT 3`)
    ).rows;
    assert.ok(Number(want[0].p) > 0);
    const suppliers = want.map((w) => w.supplier_id);
    for (const [from, to] of [
      [null, null], // whole UTC days: daily_claims_by_supplier_application_service
      ["2026-09-01T11:00:00Z", "2026-09-01T13:00:00Z"], // inside one day: claim_settlements
    ]) {
      const got = await c.query(
        `SELECT supplier_id, settled_claims::text n, settled_claims_with_proof::text p, settled_claims_without_proof::text q
         FROM ${S}.get_supplier_earnings($1::text[], $2, $3) ORDER BY settled_claims_with_proof DESC, 1`,
        [suppliers, from, to]
      );
      assert.deepEqual(
        got.rows,
        want.map((w) => ({ supplier_id: w.supplier_id, n: w.n, p: w.p, q: String(Number(w.n) - Number(w.p)) }))
      );
    }
  });

  it("NE1 names the flow mint_ratio_unminted, not the chain's deflation", async () => {
    const flows = await c.query(
      `SELECT DISTINCT flow FROM ${S}.get_supply_flows(NULL, NULL) WHERE flow IN ('deflation', 'mint_ratio_unminted')`
    );
    assert.deepEqual(flows.rows.map((r) => r.flow), ["mint_ratio_unminted"]);
  });

  it("get_supply_flows counts a replayed height's global staker money once, and an unattributed family's from its legs", async () => {
    // 710013 is replayed and its fixture pays no global staker share: one is seeded as the writer writes it, the staker
    // leg in staker_payouts and, when the replay attributes it, the same amount in a validator row
    const h = 710013;
    const blk = (await c.query(`SELECT era, block_time FROM ${S}.settlement_blocks WHERE height = $1`, [h])).rows[0];
    assert.ok(REPLAY_ERAS.has(String(blk.era)), String(blk.era));
    const stakers = async () =>
      BigInt(
        (
          await c.query(
            `SELECT coalesce(sum(amount_upokt), 0)::text a
             FROM ${S}.get_supply_flows($1::timestamptz, $1::timestamptz + interval '1 second', by_role => true)
             WHERE flow = 'global_mint' AND role = 'stakers'`,
            [blk.block_time]
          )
        ).rows[0].a
      );
    const before = await stakers();
    await c.query("BEGIN");
    try {
      await c.query(
        `INSERT INTO ${S}.staker_payouts (height, event_idx, recipient_id, op_reason, role, family, amount_upokt, row_source, calc_version)
         VALUES ($1, -1, 'pokt1seededstaker', 'TLM_GLOBAL_MINT_VALIDATOR_REWARD_DISTRIBUTION', 'validator', 'global', 1000, 'event', 1)`,
        [h]
      );
      // unattributed: no validator row, the legs are the only record
      assert.equal(await stakers(), before + BigInt(1000));
      await c.query(
        `INSERT INTO ${S}.validator_distributions (height, event_idx, op_reason, family, validator_operator, validator_account,
           pool_share_upokt, self_delegation_upokt, to_delegators_upokt, total_delegated_stake_upokt, delegator_count, row_source, calc_version)
         VALUES ($1, -1000, 'TLM_GLOBAL_MINT_VALIDATOR_REWARD_DISTRIBUTION', 'global', 'poktvaloper1seeded', 'pokt1seededstaker',
           1000, 1000, 0, 1, 0, 'replay', 1)`,
        [h]
      );
      // replayed: the validator row, not also the legs it was replayed from
      assert.equal(await stakers(), before + BigInt(1000));
    } finally {
      await c.query("ROLLBACK");
    }
  });

  it("a NULL id list means every id, and get_delegator_income keeps only the validators asked for", async () => {
    const sum = async (sql: string, args: unknown[] = []) => (await c.query(sql, args)).rows[0].a as string;
    for (const [from, to] of [
      [null, null],
      ["2026-09-01T11:00:00Z", "2026-09-01T13:00:00Z"],
    ]) {
      const range = [from, to];
      assert.equal(
        await sum(`SELECT sum(claimed_upokt)::text a FROM ${S}.get_supplier_earnings(NULL, $1, $2)`, range),
        await sum(`SELECT sum(claimed_upokt)::text a FROM ${S}.claim_settlements c JOIN ${S}.settlement_blocks b USING (height)
                   WHERE ($1::timestamptz IS NULL OR b.block_time >= $1) AND ($2::timestamptz IS NULL OR b.block_time < $2)`, range)
      );
      assert.equal(
        await sum(`SELECT sum(total_upokt)::text a FROM ${S}.get_validator_rewards(NULL, $1, $2)`, range),
        await sum(`SELECT sum(total_upokt)::text a FROM ${S}.get_validator_rewards(
                     ARRAY(SELECT DISTINCT validator_operator FROM ${S}.validator_distributions), $1, $2)`, range)
      );
      const all = await sum(`SELECT sum(amount_upokt)::text a FROM ${S}.get_delegator_income(NULL, $1, $2)`, range);
      assert.ok(BigInt(all) > BigInt(0));
      assert.equal(
        all,
        await sum(`SELECT sum(amount_upokt)::text a FROM ${S}.delegator_validator_payouts p JOIN ${S}.settlement_blocks b USING (height)
                   WHERE ($1::timestamptz IS NULL OR b.block_time >= $1) AND ($2::timestamptz IS NULL OR b.block_time < $2)`, range)
      );
      const validator = (
        await c.query(`SELECT validator_operator v FROM ${S}.delegator_validator_payouts WHERE validator_operator <> ''
                       GROUP BY 1 ORDER BY count(*) DESC, 1 LIMIT 1`)
      ).rows[0].v as string;
      const one = await c.query(
        `SELECT delegator, validator_operator, amount_upokt::text a FROM ${S}.get_delegator_income(NULL, $1, $2,
           by_validator => true, validators => ARRAY[$3]) ORDER BY 1`,
        [...range, validator]
      );
      const want = await c.query(
        `SELECT delegator, validator_operator, sum(amount_upokt)::text a FROM ${S}.delegator_validator_payouts p
         JOIN ${S}.settlement_blocks b USING (height) WHERE validator_operator = $3
           AND ($1::timestamptz IS NULL OR b.block_time >= $1) AND ($2::timestamptz IS NULL OR b.block_time < $2)
         GROUP BY 1, 2 ORDER BY 1`,
        [...range, validator]
      );
      assert.ok(want.rows.length > 1);
      assert.deepEqual(one.rows, want.rows);
    }
    await c.query("BEGIN");
    try {
      await c.query(`
        CREATE TABLE ${S}.msg_submit_proofs (supplier_id text, service_id text, block_id numeric);
        CREATE TABLE ${S}.event_proof_validity_checkeds (supplier_id text, service_id text, block_id numeric,
          proof_validation_status text, failure_reason text);`);
      assert.equal(
        await sum(`SELECT sum(claims_settled_with_proof + claims_settled_without_proof)::text a
                   FROM ${S}.get_supplier_proofs(NULL, NULL, NULL)`),
        await sum(`SELECT count(*)::text a FROM ${S}.claim_settlements`)
      );
    } finally {
      await c.query("ROLLBACK");
    }
    await assert.rejects(
      c.query(`SELECT * FROM ${S}.get_supplier_earnings(ARRAY['x'], NULL, NULL, owners => ARRAY['y'])`),
      /not both/
    );
  });

  it("NE3: get_param_history lists the 3 changes inside a range, the first with the value from before the range", async () => {
    await c.query("BEGIN");
    try {
      // one version before the range (height 100) and 3 changes inside it (200, 300, 400); 350 rewrites 300's value
      await c.query(`
        INSERT INTO ${S}.blocks VALUES (100, '2026-08-01 00:00'), (200, '2026-08-10 00:00'), (300, '2026-08-11 00:00'),
          (350, '2026-08-11 12:00'), (400, '2026-08-12 00:00'), (500, '2026-08-20 00:00');
        INSERT INTO ${S}.params VALUES
          ('tokenomics-m', 'tokenomics', 'm', '10', NULL, '[100,200)'), ('tokenomics-m', 'tokenomics', 'm', '20', 200, '[200,300)'),
          ('tokenomics-m', 'tokenomics', 'm', '30', 300, '[300,350)'), ('tokenomics-m', 'tokenomics', 'm', '30', 350, '[350,400)'),
          ('tokenomics-m', 'tokenomics', 'm', '40', 400, '[400,)');`);
      const { rows } = await c.query(
        `SELECT height::int, value, previous_value FROM ${S}.get_param_history(ARRAY['tokenomics'], ARRAY['m'],
           '2026-08-05T00:00:00Z', '2026-08-15T00:00:00Z')`
      );
      // newest first
      assert.deepEqual(rows, [
        { height: 400, value: "40", previous_value: "30" },
        { height: 300, value: "30", previous_value: "20" },
        { height: 200, value: "20", previous_value: "10" },
      ]);
    } finally {
      await c.query("ROLLBACK");
    }
  });

  it("every <function>_json returns the rows of its function, in order, also above 1000 rows", async () => {
    const address = (await c.query(`SELECT address FROM ${S}.v_income_base ORDER BY 1 LIMIT 1`)).rows[0].address as string;
    const supplier = (await c.query(`SELECT supplier_id FROM ${S}.claim_settlements ORDER BY 1 LIMIT 1`)).rows[0]
      .supplier_id as string;
    const calls: Array<[string, string, unknown[], number]> = [
      // [function, arguments, values, minimum rows]
      ["get_supply_flows", "$1, $2, 'hour', by_role => true, fill_empty_buckets => true", ["2026-08-26T12:00:00Z", "2026-09-02T12:00:00Z"], 1001],
      ["get_income", "ARRAY[$1], NULL, NULL, by_reason => true, by_supplier => true", [address], 1],
      ["get_supplier_earnings", "NULL, $1, $2, 'hour'", ["2026-09-01T00:00:00Z", "2026-09-02T00:00:00Z"], 1],
      ["get_supplier_distribution", "ARRAY[$1], NULL, NULL, by_reason => true", [supplier], 1],
      ["money_coverage", "NULL, NULL", [], 1],
    ];
    for (const [fn, args, values, min] of calls) {
      // the twin gives every number as a string (amounts past 2^53): compare against the rows with numbers as strings
      const str = (v: unknown): unknown =>
        typeof v === "number" ? String(v) : Array.isArray(v) ? v.map(str) : v;
      const rows = (await c.query(`SELECT to_jsonb(r) j FROM ${S}.${fn}(${args}) r`, values)).rows.map((r) =>
        Object.fromEntries(Object.entries(r.j as unknown as Record<string, unknown>).map(([k, v]) => [k, str(v)]))
      );
      const json = (await c.query(`SELECT ${S}.${fn}_json(${args}) j`, values)).rows[0].j;
      assert.ok(rows.length >= min, `${fn}: ${rows.length} rows`);
      assert.deepEqual(json, rows, fn);
    }
  });

  it("every _json twin gives every number as a string, at any depth, so no JavaScript client rounds an amount", async () => {
    await c.query("BEGIN");
    try {
      await c.query(`
        CREATE TABLE ${S}.msg_submit_proofs (supplier_id text, service_id text, block_id numeric);
        CREATE TABLE ${S}.event_proof_validity_checkeds (supplier_id text, service_id text, block_id numeric,
          proof_validation_status text, failure_reason text);
        CREATE TABLE ${S}.event_application_unbonding_begins (application_id text, reason int, block_id numeric);
        INSERT INTO ${S}.blocks VALUES (899713, '2026-09-01 12:00');
        INSERT INTO ${S}.event_proof_validity_checkeds
          SELECT supplier_id, service_id, 899713, 'INVALID', 'bad proof' FROM ${S}.claim_settlements LIMIT 1;
        INSERT INTO ${S}.event_application_unbonding_begins SELECT application_id, 1, 899713 FROM ${S}.claim_settlements LIMIT 1;
        INSERT INTO ${S}.params VALUES ('shared-x', 'shared', 'x', '1', NULL, '[899713,)');`);
      const list = (col: string, table: string) => `ARRAY(SELECT DISTINCT ${col} FROM ${S}.${table} ORDER BY 1 LIMIT 5)`;
      const calls: Record<string, string> = {
        money_coverage: "NULL, NULL",
        get_application_spend: `${list("application_id", "claim_settlements")}, NULL, NULL`,
        get_gateway_spend: "ARRAY['gw'], NULL, NULL, fill_empty_buckets => true", // an idle id: its zero row
        get_supplier_earnings: "NULL, NULL, NULL",
        get_supplier_distribution: `${list("supplier_id", "claim_settlements")}, NULL, NULL, by_reason => true`,
        get_income: `${list("address", "v_income_base")}, NULL, NULL, by_reason => true`,
        get_validator_rewards: "NULL, NULL, NULL",
        get_delegator_income: "NULL, NULL, NULL",
        get_supply_flows: "NULL, NULL, by_role => true",
        get_supplier_penalties: `${list("supplier_id", "claim_settlements")}, NULL, NULL, fill_empty_buckets => true`,
        get_service_usage: "NULL, NULL, NULL, top_by_settled => 3",
        get_app_auto_unstakes: "NULL, NULL, NULL",
        get_supplier_proofs: "NULL, NULL, NULL",
        get_param_history: "NULL, NULL, NULL, NULL",
      };
      assert.deepEqual(Object.keys(calls).sort(), [...CATALOG_FUNCTIONS].sort());
      const numbers = (v: unknown, path: string): string[] =>
        typeof v === "number" ? [path] : v !== null && typeof v === "object"
          ? Object.entries(v as Record<string, unknown>).flatMap(([k, x]) => numbers(x, `${path}.${k}`)) : [];
      for (const [fn, args] of Object.entries(calls)) {
        const j = (await c.query(`SELECT ${S}.${fn}_json(${args}) j`)).rows[0].j as unknown as unknown[];
        assert.ok(j.length > 0, fn);
        assert.deepEqual(numbers(j, fn), []);
      }
      const proofs = (await c.query(`SELECT ${S}.get_supplier_proofs_json(NULL, NULL, NULL) j`)).rows[0].j as unknown as
        { invalid_by_reason: Record<string, unknown> }[];
      assert.ok(proofs.some((p) => p.invalid_by_reason["bad proof"] === "1"));
    } finally {
      await c.query("ROLLBACK");
    }
  });

  it("every table OMITTED_TABLES names exists and is hidden, and UNUSED_ENTITY_TABLES names 34 real entities", async () => {
    const hidden = await c.query(
      `SELECT c.relname, obj_description(c.oid, 'pg_class') tag FROM pg_class c
       WHERE c.relnamespace = $1::regnamespace AND c.relname = ANY($2::text[])`,
      [S, OMITTED_TABLES]
    );
    assert.deepEqual(hidden.rows.map((r) => r.relname).sort(), [...OMITTED_TABLES].sort());
    for (const r of hidden.rows) assert.ok(/^@omit(\n|$)/.test(String(r.tag)), String(r.relname));
    // the unused entities: each name is a SubQuery table of schema.graphql (or one of the two raw staked tables)
    const snake = (n: string) => n.replace(/(?<!^)([A-Z])/g, "_$1").toLowerCase();
    const entities = [...fs.readFileSync(path.join(__dirname, "../../schema.graphql"), "utf8").matchAll(/^type (\w+) @entity/gm)]
      .map((m) => snake(m[1]));
    const tableOf = (t: string) =>
      entities.some((e) => [e, e + "s", e + "es", e.replace(/y$/, "ies")].includes(t)) ||
      ["staked_apps_by_block_and_services", "staked_suppliers_by_block_and_services"].includes(t);
    // the 34 names, literally (a valid singular or another entity's table would pass the shape check below)
    assert.deepEqual([...UNUSED_ENTITY_TABLES].sort(), [
      "authz_execs",
      "authz_msg_execs",
      "event_application_reimbursement_requests",
      "event_claim_updateds",
      "event_gateway_unstakeds",
      "event_proof_updateds",
      "event_proof_validity_checkeds",
      "event_supplier_service_config_activateds",
      "event_transfer_begins",
      "event_transfer_ends",
      "event_transfer_errors",
      "events",
      "genesis_balances",
      "genesis_files",
      "messages",
      "module_accounts",
      "msg_add_services",
      "msg_claim_morse_accounts",
      "msg_claim_morse_application_services",
      "msg_claim_morse_applications",
      "msg_claim_morse_supplier_services",
      "msg_claim_morse_suppliers",
      "msg_create_validators",
      "msg_import_morse_claimable_accounts",
      "msg_recover_morse_accounts",
      "msg_stake_application_services",
      "msg_transfer_applications",
      "msg_unstake_applications",
      "msg_unstake_gateways",
      "staked_apps_by_block_and_services",
      "staked_suppliers_by_block_and_services",
      "supply_denoms",
      "validator_commissions",
      "validator_rewards",
    ]);
    assert.deepEqual(UNUSED_ENTITY_TABLES.filter((t) => !tableOf(t)), []);
    // created empty here, with a SubQuery @foreignKey tag: @omit goes in front and the tag stays
    await c.query("BEGIN");
    try {
      for (const t of UNUSED_ENTITY_TABLES) await c.query(`CREATE TABLE ${S}.${t} (id text)`);
      await c.query(`COMMENT ON TABLE ${S}.events IS E'@foreignKey (block_id) REFERENCES blocks (id)'`);
      await c.query(createSettlementSmartTagsFn(S));
      await c.query(createSettlementSmartTagsFn(S));
      const tags = await c.query(
        `SELECT c.relname, obj_description(c.oid, 'pg_class') tag FROM pg_class c
         WHERE c.relnamespace = $1::regnamespace AND c.relname = ANY($2::text[]) ORDER BY 1`,
        [S, UNUSED_ENTITY_TABLES]
      );
      assert.equal(tags.rows.length, 34);
      for (const r of tags.rows)
        assert.equal(r.tag, r.relname === "events" ? "@omit\n@foreignKey (block_id) REFERENCES blocks (id)" : "@omit");
    } finally {
      await c.query("ROLLBACK");
    }
  });

  it("get_income by supplier and service reads whole months from the monthly rollup and equals the base", async () => {
    const addrs = (
      await c.query(`SELECT array_agg(address) a FROM (SELECT address FROM ${S}.v_income_base
                     WHERE supplier_id <> '' AND service_id <> '' GROUP BY 1 ORDER BY count(*) DESC, 1 LIMIT 200) x`)
    ).rows[0].a as unknown as string[];
    assert.ok(addrs.length > 1);
    const q = `SELECT bucket_start, address, role, family, supplier_id, service_id, amount_upokt::text a, transfer_count::text n
               FROM ${S}.get_income($1::text[], $2, $3, $4, by_reason => true, by_supplier => true, by_service => true,
                 fill_empty_buckets => false)`;
    for (const [from, to, bucket] of [
      ["2026-08-15T00:00:00Z", "2026-10-02T00:00:00Z", null], // September whole, edges from the base
      ["2026-08-15T00:00:00Z", "2026-10-02T00:00:00Z", "month"],
      ["2026-09-01T11:00:00Z", "2026-11-01T00:00:00Z", "month"], // September starts mid-day: no whole month of it
      ["2026-09-01T00:00:00Z", "2026-10-01T00:00:00Z", "year"],
      [null, null, null], // open range: every month whole
    ]) {
      const rollup = (await c.query(q, [addrs, from, to, bucket])).rows;
      const uses = await c.query(
        `SELECT count(*)::int n FROM ${S}.monthly_income_by_address_supplier_service WHERE address = ANY($1::text[])`,
        [addrs]
      );
      assert.ok(Number(uses.rows[0].n) > 0);
      await c.query("BEGIN");
      try {
        await c.query("SET LOCAL money.no_rollup = on");
        const base = (await c.query(q, [addrs, from, to, bucket])).rows;
        assert.ok(base.length > 0);
        assert.deepEqual(rollup, base, `${from} ${to} ${bucket}`);
      } finally {
        await c.query("ROLLBACK");
      }
    }
  });

  it("a read of rollup days written with an older rollup version raises until rebuild_rollups", async () => {
    const supplier = (await c.query(`SELECT supplier_id FROM ${S}.claim_settlements WHERE height = 899713 LIMIT 1`)).rows[0]
      .supplier_id as string;
    const address = (await c.query(`SELECT address FROM ${S}.v_income_base WHERE height = 899713 LIMIT 1`)).rows[0]
      .address as string;
    await c.query("BEGIN");
    try {
      await c.query(`UPDATE ${S}.settlement_blocks SET rollup_version = rollup_version - 1 WHERE height = 899713`);
      for (const sql of [
        `SELECT * FROM ${S}.get_supplier_earnings(ARRAY['${supplier}'], NULL, NULL)`,
        `SELECT * FROM ${S}.get_income(ARRAY['${address}'], NULL, NULL)`,
        `SELECT * FROM ${S}.get_income(ARRAY['${address}'], NULL, NULL, 'month', by_supplier => true, by_service => true)`,
      ]) {
        await c.query("SAVEPOINT r");
        await assert.rejects(c.query(sql), /written with rollup version \d+ \(current \d+\): run rebuild_rollups first/, sql);
        await c.query("ROLLBACK TO SAVEPOINT r");
      }
      // a range inside one day reads no rollup day: it answers
      const edge = await c.query(
        `SELECT count(*)::int n FROM ${S}.get_supplier_earnings(ARRAY['${supplier}'], '2026-09-01T11:00:00Z', '2026-09-01T13:00:00Z')`
      );
      assert.equal(edge.rows[0].n, 1);
    } finally {
      await c.query("ROLLBACK");
    }
  });

  it("every catalog function returns its rows newest first", async () => {
    await c.query("BEGIN");
    try {
      await c.query(`
        CREATE TABLE ${S}.msg_submit_proofs (supplier_id text, service_id text, block_id numeric);
        CREATE TABLE ${S}.event_proof_validity_checkeds (supplier_id text, service_id text, block_id numeric,
          proof_validation_status text, failure_reason text);
        CREATE TABLE ${S}.event_application_unbonding_begins (application_id text, reason int, block_id numeric);
        INSERT INTO ${S}.blocks VALUES (899000, '2026-09-01 11:30'), (899713, '2026-09-01 12:00');
        INSERT INTO ${S}.event_application_unbonding_begins VALUES ('app-u', 1, 899713);
        INSERT INTO ${S}.params VALUES ('shared-x', 'shared', 'x', '1', NULL, '[899000,899713)'),
          ('shared-x', 'shared', 'x', '2', NULL, '[899713,)');`);
      const list = (col: string, table: string) => `ARRAY(SELECT DISTINCT ${col} FROM ${S}.${table} ORDER BY 1 LIMIT 3)`;
      const h = "'2026-09-01T11:00:00Z', '2026-09-01T13:00:00Z', 'hour', fill_empty_buckets => true"; // 11:00 (empty), 12:00
      const calls: Record<string, string> = {
        money_coverage: "NULL, NULL",
        get_application_spend: `${list("application_id", "claim_settlements")}, ${h}`,
        get_gateway_spend: `ARRAY['gw'], ${h}`,
        get_supplier_earnings: `NULL, ${h}`,
        get_supplier_distribution: `${list("supplier_id", "claim_settlements")}, ${h}`,
        get_income: `${list("address", "v_income_base")}, ${h}`,
        get_validator_rewards: `NULL, ${h}`,
        get_delegator_income: `NULL, ${h}`,
        get_supply_flows: h,
        get_supplier_penalties: `${list("supplier_id", "claim_settlements")}, ${h}`,
        get_service_usage: `NULL, ${h}, top_by_settled => 2`,
        get_app_auto_unstakes: `NULL, ${h}`,
        get_supplier_proofs: `NULL, ${h}`,
        get_param_history: "NULL, NULL, NULL, NULL",
      };
      assert.deepEqual(Object.keys(calls).sort(), [...CATALOG_FUNCTIONS].sort());
      for (const [fn, args] of Object.entries(calls)) {
        const col = fn === "get_param_history" ? "height" : fn === "money_coverage" ? "first_height" : "bucket_start";
        // get_service_usage orders by its top rank first: newest first within each service
        const group = fn === "get_service_usage" ? "service_id" : "''";
        const rows = (await c.query(`SELECT ${col}::text t, ${group} g FROM ${S}.${fn}(${args})`)).rows;
        const times = rows.map((r) => (/^\d+$/.test(String(r.t)) ? Number(r.t) : Date.parse(String(r.t))));
        if (fn !== "money_coverage") assert.ok(new Set(times).size >= 2, `${fn}: ${times.length} rows, one time`);
        for (let i = 1; i < times.length; i++)
          if (rows[i].g === rows[i - 1].g) assert.ok(times[i] <= times[i - 1], `${fn} row ${i} is newer than row ${i - 1}`);
      }
    } finally {
      await c.query("ROLLBACK");
    }
  });

  it("get_delegator_income counts the replayed contributions, from the rollup and from the base", async () => {
    const want = (
      await c.query(`SELECT count(*) FILTER (WHERE row_source IN ('replay', 'derived_split'))::text n
                     FROM ${S}.delegator_validator_payouts`)
    ).rows[0].n as string;
    assert.ok(Number(want) > 0);
    for (const [from, to] of [
      [null, null], // whole UTC days: daily_delegator_rewards_by_validator.replayed_count
      ["2026-09-01T11:00:00Z", "2026-09-01T13:00:00Z"], // inside one day: delegator_validator_payouts.row_source
    ]) {
      const got = await c.query(
        `SELECT sum(replayed_count)::text n FROM ${S}.get_delegator_income(NULL, $1, $2, by_validator => true)`,
        [from, to]
      );
      assert.equal(got.rows[0].n, want);
    }
  });

  it("get_income by supplier and service equals the base over two months, at month, mid-day and +1 µs edges", async () => {
    await c.query("BEGIN");
    try {
      // 899713's settlement written again in July, at mid-day and at a lower height: income in two months
      const { payload } = payloadOf("899713", true);
      payload.ts = "2026-07-15T08:30:00.000Z";
      for (const { bind, sql } of writeSettlementCalls(S, 600013, payload)) await c.query(sql, bind);
      // the top payees of every settlement height, so each edge height (also the first one after a whole-month
      // window) pays some of the addresses asked about
      const addrs = (
        await c.query(`SELECT array_agg(DISTINCT address) a FROM (
                         SELECT address, row_number() OVER (PARTITION BY height ORDER BY count(*) DESC, address) k
                         FROM ${S}.v_income_base WHERE supplier_id <> '' AND service_id <> '' GROUP BY height, address) x
                       WHERE k <= 50`)
      ).rows[0].a as unknown as string[];
      assert.ok(addrs.length > 50 && addrs.length <= 200, `${addrs.length} addresses`);
      const q = `SELECT bucket_start, address, role, family, supplier_id, service_id, amount_upokt::text a, transfer_count::text n
                 FROM ${S}.get_income($1::text[], $2, $3, $4, by_reason => true, by_supplier => true, by_service => true,
                   fill_empty_buckets => false)`;
      for (const [from, to, bucket] of [
        ["2026-07-01T00:00:00Z", "2026-10-01T00:00:00Z", "month"], // aligned: July, August, September whole
        ["2026-07-01T00:00:00Z", "2026-10-01T00:00:00Z", null],
        ["2026-07-15T08:30:00Z", "2026-09-01T12:00:00Z", null], // starts at July's settlement, ends at September's
        ["2026-07-15T08:30:00.000001Z", "2026-09-01T12:00:00.000001Z", null], // +1 µs: July out, September in
        ["2026-06-01T00:00:00Z", "2026-09-01T00:00:00Z", "year"],
      ]) {
        await c.query("SAVEPOINT r");
        const rollup = (await c.query(q, [addrs, from, to, bucket])).rows;
        await c.query("SET LOCAL money.no_rollup = on");
        const base = (await c.query(q, [addrs, from, to, bucket])).rows;
        await c.query("ROLLBACK TO SAVEPOINT r");
        assert.ok(base.length > 0, `${from} ${to}`);
        // counts and totals first: a wrong answer fails here with a short message, not in a diff of thousands of rows
        const total = (rows: typeof base) => rows.reduce((t, r) => t + BigInt(String(r.a)), BigInt(0)).toString();
        assert.equal(rollup.length, base.length, `${from} ${to} ${bucket}: rows`);
        assert.equal(total(rollup), total(base), `${from} ${to} ${bucket}: total`);
        assert.deepEqual(rollup, base, `${from} ${to} ${bucket}`);
      }
    } finally {
      await c.query("ROLLBACK");
    }
  });

  it("event-based series (proofs, auto-unstakes) run to the last indexed block and sum to their total", async () => {
    await c.query("BEGIN");
    try {
      // proof and unstake events a week after the last written settlement (2026-09-01 12:00)
      await c.query(`
        CREATE TABLE ${S}.msg_submit_proofs (supplier_id text, service_id text, block_id numeric);
        CREATE TABLE ${S}.event_proof_validity_checkeds (supplier_id text, service_id text, block_id numeric,
          proof_validation_status text, failure_reason text);
        CREATE TABLE ${S}.event_application_unbonding_begins (application_id text, reason int, block_id numeric);
        INSERT INTO ${S}.blocks VALUES (900000, '2026-09-01 12:30'), (900500, '2026-09-08 10:00');
        INSERT INTO ${S}.msg_submit_proofs VALUES ('sup-p', 'svc', 900000), ('sup-p', 'svc', 900500);
        INSERT INTO ${S}.event_proof_validity_checkeds VALUES ('sup-p', 'svc', 900500, 'VALIDATED', '');
        INSERT INTO ${S}.event_application_unbonding_begins VALUES ('app-u', 1, 900500);`);
      const proofs = async (bucket: string | null) =>
        (
          await c.query(
            `SELECT sum(proofs_submitted)::text p, sum(proofs_validated)::text v
             FROM ${S}.get_supplier_proofs(ARRAY['sup-p'], NULL, NULL, $1)`,
            [bucket]
          )
        ).rows[0];
      assert.deepEqual(await proofs(null), { p: "2", v: "1" });
      assert.deepEqual(await proofs("month"), { p: "2", v: "1" });
      const unstakes = async (bucket: string | null) =>
        (await c.query(`SELECT sum(unstakes)::text n FROM ${S}.get_app_auto_unstakes(NULL, NULL, NULL, $1)`, [bucket]))
          .rows[0].n;
      assert.equal(await unstakes(null), "1");
      assert.equal(await unstakes("month"), "1");
    } finally {
      await c.query("ROLLBACK");
    }
  });

  it("by_<entity> => false sums the group, and every requested id gets a row even without activity", async () => {
    const addrs = (
      await c.query(`SELECT array_agg(address) a FROM (SELECT DISTINCT address FROM ${S}.v_income_base ORDER BY 1 LIMIT 50) x`)
    ).rows[0].a as unknown as string[];
    const sum = await c.query(
      `SELECT sum(amount_upokt)::text a, sum(transfer_count)::text n FROM ${S}.get_income($1::text[], NULL, NULL)`,
      [addrs]
    );
    const group = await c.query(
      `SELECT address, sum(amount_upokt)::text a, sum(transfer_count)::text n FROM ${S}.get_income($1::text[], NULL, NULL,
         by_address => false) GROUP BY 1`,
      [addrs]
    );
    assert.deepEqual(group.rows, [{ address: "all", ...sum.rows[0] }]);
    // an id with no activity: with fill, one zero row in the total and a zero series with a bucket; by default nothing
    const ids = [addrs[0], "pokt1noactivity"];
    const idle = async (extra: string) =>
      (
        await c.query(
          `SELECT bucket_start, amount_upokt::text a FROM ${S}.get_income($1::text[], '2026-09-01T11:00:00Z',
             '2026-09-01T14:00:00Z'${extra}) WHERE address = 'pokt1noactivity' ORDER BY 1`,
          [ids]
        )
      ).rows.map((r) => r.a);
    assert.deepEqual(await idle(", fill_empty_buckets => true"), ["0"]);
    assert.deepEqual(await idle(", 'hour', fill_empty_buckets => true"), ["0", "0"]);
    assert.deepEqual(await idle(", 'hour'"), []);
    assert.deepEqual(await idle(""), []);
  });

  it("the supplier functions take owners and resolve every supplier they own now, with no cap", async () => {
    await c.query("BEGIN");
    try {
      const sups = (
        await c.query(`SELECT array_agg(DISTINCT supplier_id ORDER BY supplier_id) s FROM ${S}.claim_settlements`)
      ).rows[0].s as unknown as string[];
      assert.ok(sups.length > 1);
      // owner-a owns every supplier now plus 250 idle ones; one supplier was owner-b's before
      await c.query(`CREATE TABLE ${S}.suppliers (id text, owner_id text, _block_range int8range)`);
      await c.query(
        `INSERT INTO ${S}.suppliers SELECT u, 'owner-a', int8range(1, NULL) FROM unnest($1::text[]) u
         UNION ALL SELECT 'idle-' || g, 'owner-a', int8range(1, NULL) FROM generate_series(1, 250) g
         UNION ALL SELECT $2, 'owner-b', int8range(0, 1)`,
        [sups, sups[0]]
      );
      // the same suppliers named by hand, in calls of at most 200
      const parts = Array.from({ length: Math.ceil(sups.length / 200) }, (_, i) => sups.slice(i * 200, i * 200 + 200));
      const inParts = async (sql: string) => {
        let a = BigInt(0);
        let n = BigInt(0);
        for (const part of parts) {
          const r = (await c.query(sql, [part])).rows[0];
          a += BigInt(r.a ?? 0);
          n += BigInt(r.n ?? 0);
        }
        return { a: a.toString(), n: n.toString() };
      };
      const bySuppliers = await inParts(
        `SELECT sum(claimed_upokt)::text a, sum(settled_claims)::text n FROM ${S}.get_supplier_earnings($1::text[], NULL, NULL)`
      );
      const byOwner = await c.query(
        `SELECT supplier_id, claimed_upokt::text a, settled_claims::text n FROM ${S}.get_supplier_earnings(suppliers => NULL,
           range_start => NULL, range_end => NULL, owners => ARRAY['owner-a'], by_supplier => false)`
      );
      assert.deepEqual(byOwner.rows, [{ supplier_id: "all", ...bySuppliers }]);
      // the other supplier functions resolve owners the same way
      for (const fn of ["get_supplier_distribution", "get_supplier_penalties"]) {
        const a = await inParts(
          `SELECT 0 a, count(*)::int n FROM ${S}.${fn}($1::text[], NULL, NULL, fill_empty_buckets => true)`
        );
        const b = await c.query(
          `SELECT count(*)::int n FROM ${S}.${fn}(NULL, NULL, NULL, owners => ARRAY['owner-a'], fill_empty_buckets => true)`
        );
        assert.equal(Number(b.rows[0].n) - 250, Number(a.n), fn);
      }
      const perSupplier = await c.query(
        `SELECT count(*)::int n FROM ${S}.get_supplier_earnings(suppliers => NULL, range_start => NULL, range_end => NULL,
           owners => ARRAY['owner-a'], fill_empty_buckets => true)`
      );
      assert.equal(perSupplier.rows[0].n, sups.length + 250);
      const formerOwner = await c.query(
        `SELECT count(*)::int n FROM ${S}.get_supplier_earnings(suppliers => NULL, range_start => NULL, range_end => NULL,
           owners => ARRAY['owner-b'])`
      );
      assert.equal(formerOwner.rows[0].n, 0);
      await assert.rejects(
        c.query(`SELECT * FROM ${S}.get_supplier_earnings(ARRAY['x'], NULL, NULL, owners => ARRAY['owner-a'])`),
        /pass suppliers or owners/
      );
    } finally {
      await c.query("ROLLBACK");
    }
  });

  it("every id-list function returns an idle id, and an idle group, as zero rows", async () => {
    await c.query("BEGIN");
    try {
      await c.query(`
        CREATE TABLE ${S}.msg_submit_proofs (supplier_id text, service_id text, block_id numeric);
        CREATE TABLE ${S}.event_proof_validity_checkeds (supplier_id text, service_id text, block_id numeric,
          proof_validation_status text, failure_reason text);
        CREATE TABLE ${S}.event_application_unbonding_begins (application_id text, reason int, block_id numeric);
        INSERT INTO ${S}.blocks VALUES (900000, '2026-09-01 12:30');`);
      const fns: [string, string, string][] = [
        ["get_application_spend", "applications", "by_application"],
        ["get_gateway_spend", "gateways", "by_gateway"],
        ["get_supplier_earnings", "suppliers", "by_supplier"],
        ["get_supplier_distribution", "suppliers", "by_supplier"],
        ["get_income", "addresses", "by_address"],
        ["get_validator_rewards", "validators", "by_validator"],
        ["get_delegator_income", "delegators", "by_delegator"],
        ["get_supplier_penalties", "suppliers", "by_supplier"],
        ["get_service_usage", "services", "by_service"],
        ["get_app_auto_unstakes", "applications", "by_application"],
        ["get_supplier_proofs", "suppliers", "by_supplier"],
      ];
      for (const [fn, list, flag] of fns) {
        for (const [bucket, buckets] of [
          ["NULL", 1],
          ["'hour'", 2],
        ] as const) {
          for (const [byEntity, entity] of [
            [true, "pokt1idle"],
            [false, "all"],
          ] as const) {
            const { rows } = await c.query(
              `SELECT to_jsonb(r) j FROM ${S}.${fn}(${list} => ARRAY[NULL, 'pokt1idle', 'pokt1idle'],
                 range_start => '2026-09-01T11:00:00Z', range_end => '2026-09-01T14:00:00Z', bucket => ${bucket},
                 ${flag} => ${byEntity}, fill_empty_buckets => true) r`
            );
            const label = `${fn} bucket=${bucket} ${flag}=${byEntity}`;
            assert.equal(rows.length, buckets, label);
            for (const { j } of rows as unknown as { j: Record<string, unknown> }[]) {
              assert.ok(Object.values(j).includes(entity), label);
              for (const [k, v] of Object.entries(j))
                if (typeof v === "number") assert.equal(v, 0, `${label} ${k}`);
            }
          }
        }
      }
    } finally {
      await c.query("ROLLBACK");
    }
  });

  it("the per-settlement application×service table and the monthly service rollup agree with the base", async () => {
    const apps = (
      await c.query(`SELECT array_agg(DISTINCT application_id ORDER BY application_id) a FROM ${S}.claim_settlements`)
    ).rows[0].a as unknown as string[];
    const parts = Array.from({ length: Math.ceil(apps.length / 200) }, (_, i) => apps.slice(i * 200, i * 200 + 200));
    // by_supplier reads claim_settlements, without it settlement_claims_by_application_service: same totals per hour
    const totals: Record<string, Record<string, string>> = {};
    for (const bySupplier of [false, true]) {
      const got: Record<string, string> = {};
      for (const part of parts) {
        const { rows } = await c.query(
          `SELECT bucket_start::text b, sum(burned_upokt)::text a, sum(relays)::text r, sum(claims)::text n
           FROM ${S}.get_application_spend($1::text[], '2026-09-01T11:00:00Z', '2026-09-01T14:00:00Z', 'hour',
             by_supplier => $2, by_application => false) GROUP BY 1`,
          [part, bySupplier]
        );
        for (const r of rows) {
          const k = String(r.b);
          const [a, rr, n] = (got[k] ?? "0|0|0").split("|").map((x) => BigInt(x));
          got[k] = [a + BigInt(r.a), rr + BigInt(r.r), n + BigInt(r.n)].join("|");
        }
      }
      totals[String(bySupplier)] = got;
    }
    assert.ok(Object.keys(totals.false).length > 0);
    assert.deepEqual(totals.true, totals.false);
    // the table itself is claim_settlements grouped by height, application and service
    const diff = await c.query(`
      (SELECT height, application_id, service_id, count(*)::bigint, sum(claimed_upokt)::bigint, sum(settled_upokt)::bigint,
              sum(overservicing_loss_upokt)::bigint, sum(global_minted_upokt)::bigint, sum(relays)::bigint,
              sum(estimated_relays)::bigint, sum(claimed_compute_units)::bigint, sum(estimated_compute_units)::bigint
       FROM ${S}.claim_settlements GROUP BY 1, 2, 3
       EXCEPT
       SELECT height, application_id, service_id, claim_count, claimed_upokt, settled_upokt, overservicing_loss_upokt,
              global_minted_upokt, relays, estimated_relays, claimed_compute_units, estimated_compute_units
       FROM ${S}.settlement_claims_by_application_service)
      UNION ALL
      (SELECT height, application_id, service_id, claim_count, claimed_upokt, settled_upokt, overservicing_loss_upokt,
              global_minted_upokt, relays, estimated_relays, claimed_compute_units, estimated_compute_units
       FROM ${S}.settlement_claims_by_application_service
       EXCEPT
       SELECT height, application_id, service_id, count(*)::bigint, sum(claimed_upokt)::bigint, sum(settled_upokt)::bigint,
              sum(overservicing_loss_upokt)::bigint, sum(global_minted_upokt)::bigint, sum(relays)::bigint,
              sum(estimated_relays)::bigint, sum(claimed_compute_units)::bigint, sum(estimated_compute_units)::bigint
       FROM ${S}.claim_settlements GROUP BY 1, 2, 3)`);
    assert.equal(diff.rows.length, 0);
    // service usage per hour on a mid-hour range = claim_settlements summed by hour and service
    const svc = await c.query(`
      SELECT bucket_start::text b, service_id, settled_upokt::text s, relays::text r, claims::text n
      FROM ${S}.get_service_usage(services => NULL, top_by_settled => 200, range_start => '2026-09-01T11:30:00Z',
        range_end => '2026-09-01T12:30:00Z', bucket => 'hour', fill_empty_buckets => false) ORDER BY 1, 2`);
    const oracle = await c.query(`
      SELECT date_trunc('hour', block_time, 'UTC')::text b, service_id, sum(settled_upokt)::text s,
             sum(relays)::text r, count(*)::text n
      FROM ${S}.claim_settlements WHERE block_time >= '2026-09-01T11:30:00Z' AND block_time < '2026-09-01T12:30:00Z'
      GROUP BY 1, 2 ORDER BY 1, 2`);
    assert.ok(oracle.rows.length > 0);
    assert.deepEqual(svc.rows, oracle.rows);
    // a whole month by service: the monthly rollup, against everything from the base tables
    const addrs = (
      await c.query(
        `SELECT array_agg(address) a FROM (SELECT DISTINCT address FROM ${S}.v_income_base WHERE service_id <> '' ORDER BY 1 LIMIT 200) x`
      )
    ).rows[0].a;
    const q = `SELECT service_id, role, family, sum(amount_upokt)::text a, sum(transfer_count)::text n
               FROM ${S}.get_income($1::text[], '2026-09-01T00:00:00Z', '2026-10-01T00:00:00Z', 'month', by_reason => true,
                 by_service => true, fill_empty_buckets => false) GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`;
    const rollup = (await c.query(q, [addrs])).rows;
    await c.query("BEGIN");
    try {
      await c.query("SET LOCAL money.no_rollup = on");
      assert.ok(rollup.length > 0);
      assert.deepEqual((await c.query(q, [addrs])).rows, rollup);
    } finally {
      await c.query("ROLLBACK");
    }
  });

  it("bucket=day takes up to 92 days and bucket=week up to 366, and each asks for a coarser bucket beyond", async () => {
    const q = `SELECT count(DISTINCT bucket_start) n FROM ${S}.get_supply_flows($1::timestamptz, $2::timestamptz, 'day')`;
    const ok = await c.query(q, ["2026-07-01T00:00:00Z", "2026-10-01T00:00:00Z"]);
    assert.ok(Number(ok.rows[0].n) > 0); // filled from the first indexed day, not from range_start
    await assert.rejects(
      c.query(q, ["2026-07-01T00:00:00Z", "2026-10-01T00:00:01Z"]),
      /bucket=day allows ranges up to 92 days; use week \(up to 366 days\), month or year/
    );
    await assert.rejects(
      c.query(`SELECT count(*) FROM ${S}.get_supply_flows($1::timestamptz, $2::timestamptz, 'hour')`, [
        "2026-09-01T00:00:00Z",
        "2026-09-08T00:00:01Z",
      ]),
      /bucket=hour allows ranges up to 7 days/
    );
    const w = `SELECT count(*) FROM ${S}.get_supply_flows($1::timestamptz, $2::timestamptz, 'week')`;
    await c.query(w, ["2025-10-01T00:00:00Z", "2026-10-02T00:00:00Z"]);
    await assert.rejects(c.query(w, ["2025-10-01T00:00:00Z", "2026-10-02T00:00:01Z"]), /bucket=week allows ranges up to 366 days/);
    await assert.rejects(c.query(`SELECT count(*) FROM ${S}.get_supply_flows(NULL, NULL, 'week')`), /bucket=week allows/);
    await c.query(`SELECT count(*) FROM ${S}.get_supply_flows(NULL, NULL, 'month')`);
  });

  it("every PL/pgSQL catalog function plans each call with its arguments, never a cached generic plan", async () => {
    const r = await c.query(
      `SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace JOIN pg_language l ON l.oid = p.prolang
       WHERE n.nspname = $1 AND l.lanname = 'plpgsql' AND p.provolatile = 's' AND p.prokind = 'f'
         AND NOT coalesce('plan_cache_mode=force_custom_plan' = ANY(p.proconfig), false) ORDER BY 1`,
      [S]
    );
    assert.deepEqual(r.rows, []);
    const n = await c.query(
      `SELECT count(*) n FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace WHERE ns.nspname = $1
         AND p.proname = 'get_income' AND 'plan_cache_mode=force_custom_plan' = ANY(p.proconfig)`,
      [S]
    );
    assert.equal(n.rows[0].n, "1");
  });

  it("every bucketed catalog function answers each bucket inside its range limit with its real total, and raises just past it", async () => {
    await c.query("BEGIN");
    try {
      // data for the functions the settlement fixtures leave empty: a gateway, proofs and an auto-unstake at 899713
      await c.query(`
        CREATE TABLE ${S}.msg_submit_proofs (supplier_id text, service_id text, block_id numeric);
        CREATE TABLE ${S}.event_proof_validity_checkeds (supplier_id text, service_id text, block_id numeric,
          proof_validation_status text, failure_reason text);
        CREATE TABLE ${S}.event_application_unbonding_begins (application_id text, reason int, block_id numeric);
        INSERT INTO ${S}.blocks VALUES (899713, '2026-09-01 12:00');
        INSERT INTO ${S}.application_gateways
          SELECT DISTINCT 'gw', application_id, '[0,)'::int8range FROM ${S}.claim_settlements;
        INSERT INTO ${S}.msg_submit_proofs SELECT supplier_id, service_id, 899713 FROM ${S}.claim_settlements LIMIT 3;
        INSERT INTO ${S}.event_proof_validity_checkeds
          SELECT supplier_id, service_id, 899713, 'VALIDATED', '' FROM ${S}.claim_settlements LIMIT 2;
        INSERT INTO ${S}.event_application_unbonding_begins SELECT application_id, 1, 899713 FROM ${S}.claim_settlements LIMIT 1;`);
      // 899713's settlement again on 2026-07-15 and 2026-08-31 (lower heights), and events on both dates too: every bucket
      // size then has data in at least two buckets, so a row put in the wrong bucket cannot hide behind a single one
      const { payload } = payloadOf("899713", true);
      for (const [h, ts] of [
        [600013, "2026-07-15T08:30:00.000Z"],
        [690013, "2026-08-31T08:30:00.000Z"],
      ] as const) {
        for (const { bind, sql } of writeSettlementCalls(S, h, { ...payload, ts })) await c.query(sql, bind);
      }
      await c.query(`
        INSERT INTO ${S}.blocks VALUES (600013, '2026-07-15 08:30'), (690013, '2026-08-31 08:30');
        INSERT INTO ${S}.msg_submit_proofs SELECT supplier_id, service_id, h FROM ${S}.claim_settlements,
          (VALUES (600013), (690013)) v(h) LIMIT 4;
        INSERT INTO ${S}.event_application_unbonding_begins SELECT application_id, 1, h FROM ${S}.claim_settlements,
          (VALUES (600013), (690013)) v(h) LIMIT 2;
        INSERT INTO ${S}.claim_expirations SELECT v.h, e.event_idx, e.supplier_id, e.application_id, e.service_id,
          e.session_end, e.claimed_upokt, e.reason, e.relays, e.estimated_relays, e.claimed_compute_units,
          e.estimated_compute_units FROM ${S}.claim_expirations e, (VALUES (600013), (690013)) v(h);`);
      const ids = (col: string, table: string) => `ARRAY(SELECT DISTINCT ${col} FROM ${S}.${table} ORDER BY 1 LIMIT 3), `;
      // the id argument each function needs before the named range and bucket, and an additive column to check
      const calls: Record<string, [string, string]> = {
        get_application_spend: [ids("application_id", "claim_settlements"), "burned_upokt"],
        get_gateway_spend: ["ARRAY['gw'], ", "burned_upokt"],
        get_supplier_earnings: ["NULL, ", "claimed_upokt"],
        get_supplier_distribution: [ids("supplier_id", "claim_settlements"), "amount_upokt"],
        get_income: [ids("address", "v_income_base"), "amount_upokt"],
        get_validator_rewards: ["NULL, ", "total_upokt"],
        get_delegator_income: ["NULL, ", "amount_upokt"],
        get_supply_flows: ["", "amount_upokt"],
        get_supplier_penalties: [ids("supplier_id", "claim_expirations"), "events"],
        get_service_usage: ["NULL, top_by_settled => 5, ", "claimed_upokt"],
        get_app_auto_unstakes: ["NULL, ", "unstakes"],
        get_supplier_proofs: ["NULL, ", "proofs_submitted"],
      };
      const bucketed = (
        await c.query(
          `SELECT proname FROM pg_proc WHERE pronamespace = $1::regnamespace AND 'bucket' = ANY(proargnames)
             AND proname = ANY($2::text[]) ORDER BY 1`,
          [S, [...CATALOG_FUNCTIONS]]
        )
      ).rows.map((r) => String(r.proname));
      assert.deepEqual(bucketed, Object.keys(calls).sort());
      const end = "2026-09-02T00:00:00Z";
      const before = (days: number, extraSeconds = 0) =>
        new Date(Date.parse(end) - days * 86400000 - extraSeconds * 1000).toISOString();
      // [bucket, range_start, range_end, error or null]
      const cases: Array<[string | null, string | null, string | null, RegExp | null]> = [
        ["hour", before(7), end, null],
        ["hour", before(7, 1), end, /bucket=hour allows ranges up to 7 days; use day \(up to 92 days\)/],
        ["hour", null, null, /bucket=hour allows ranges up to 7 days/],
        ["day", before(92), end, null],
        ["day", before(92, 1), end, /bucket=day allows ranges up to 92 days; use week \(up to 366 days\), month or year/],
        ["day", null, null, /bucket=day allows ranges up to 92 days/],
        ["week", before(366), end, null],
        ["week", before(366, 1), end, /bucket=week allows ranges up to 366 days; use month or year/],
        ["week", null, null, /bucket=week allows ranges up to 366 days/],
        ["month", before(3650), end, null],
        ["month", null, null, null],
        ["year", before(3650), end, null],
        ["year", null, null, null],
        [null, before(3650), end, null],
        [null, null, null, null],
        ["minute", null, null, /invalid bucket: minute/],
      ];
      for (const fn of bucketed) {
        const [prefix, col] = calls[fn];
        // n rows, b distinct buckets, t the total, and w the rows whose bucket_start is no bucket of any data time
        const sum = async (start: string | null, stop: string | null, bucket: string | null) =>
          (
            await c.query(
              `SELECT count(*)::int n, count(DISTINCT r.bucket_start)::int b, coalesce(sum(r.${col}), 0)::text t,
                      count(*) FILTER (WHERE $3::text IS NOT NULL AND NOT EXISTS (
                        SELECT 1 FROM (SELECT block_time ts FROM ${S}.settlement_blocks
                                       UNION SELECT timestamp AT TIME ZONE 'UTC' FROM ${S}.blocks) d
                        WHERE r.bucket_start = date_trunc($3, d.ts AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'))::int w
               FROM ${S}.${fn}(${prefix}range_start => $1::timestamptz, range_end => $2::timestamptz, bucket => $3) r`,
              [start, stop, bucket]
            )
          ).rows[0] as { n: number; b: number; t: string; w: number };
        for (const [bucket, start, stop, error] of cases) {
          const label = `${fn} bucket=${bucket} ${start ?? "NULL"}..${stop ?? "NULL"}`;
          await c.query("SAVEPOINT b");
          if (error) await assert.rejects(sum(start, stop, bucket), error, label);
          else {
            // real rows, and the buckets add up to the total of the same range: bucketing neither loses nor counts twice
            const got = await sum(start, stop, bucket);
            const total = await sum(start, stop, null);
            assert.ok(got.n > 0 && BigInt(total.t) > BigInt(0), `${label}: ${got.n} rows, total ${total.t}`);
            assert.equal(got.t, total.t, label);
            assert.equal(got.w, 0, `${label}: rows outside the buckets of their data`);
            if (bucket && bucket !== "year") assert.ok(got.b >= 2, `${label}: ${got.b} buckets with data`);
          }
          await c.query("ROLLBACK TO SAVEPOINT b");
        }
      }
    } finally {
      await c.query("ROLLBACK");
    }
  });

  it("the catalog functions raise on a range that overlaps a settlement gap", async () => {
    await c.query("BEGIN");
    try {
      await c.query(`INSERT INTO ${S}.settlement_gaps VALUES (700000, 800000)`);
      await assert.rejects(
        c.query(`SELECT * FROM ${S}.get_income(ARRAY['x'], NULL, NULL)`),
        /overlaps settlement heights 700000 to 800000/
      );
    } finally {
      await c.query("ROLLBACK");
    }
  });

  it("rejects a payload whose detailed legs differ from the settlement batch, and keeps the height as it was", async () => {
    const before = await md5All();
    const { height, payload } = payloadOf("899713", true);
    const leg = payload.batch.find((b) => b.op_type === "mod_to_acct" && b.role === "dao");
    assert.ok(leg);
    leg.amount = (BigInt(leg.amount) + BigInt(1)).toString();
    await assert.rejects(write(height, payload), /detailed legs differ from the settlement batch/);
    assert.equal(await md5All(), before);
  });

  it("rejects a detailed_batch payload whose delegator rows differ from the batch, and keeps the height as it was", async () => {
    const before = await md5All();
    const { height, payload } = payloadOf("710013", false);
    payload.dv[0].amount = (BigInt(payload.dv[0].amount) + BigInt(1)).toString();
    await assert.rejects(write(height, payload), /staker payouts per validator differ from the settlement batch/);
    payload.dv.pop();
    await assert.rejects(write(height, payload), /staker payouts per validator differ from the settlement batch/);
    assert.equal(await md5All(), before);
  });
});
