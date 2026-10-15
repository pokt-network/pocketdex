// Golden test of the settlement money writer against a real PostgreSQL. Run with
//   MONEY_TEST_PG=postgres://postgres:postgres@127.0.0.1:5432/postgres yarn test:money
// CI runs it with a postgres:16 service. Without MONEY_TEST_PG every test is skipped.
//
// The expected income per (address, role, family) was computed from block_results by a separate script
// (.local/ab/money/make_ci_fixtures.py in the author's checkout), not by the code under test.
/* eslint-disable @typescript-eslint/no-floating-promises */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import * as zlib from "node:zlib";
import { fromBech32, toBech32 } from "@cosmjs/encoding";
import { createEntityDescriptionsFn } from "../../src/mappings/dbFunctions/entityDescriptions";
import { createDeprecationsFn, DEPRECATED_RELATION, deprecatedTag } from "../../src/mappings/dbFunctions/deprecations";
import {
  createSupplierRevShareWalletsFn,
  insertRevShareWalletsSql,
  rewindNeeded,
  rewindRevShareWalletsSql,
} from "../../src/mappings/dbFunctions/revShareWallets";
import { getSupplierStatsByDomainsFn } from "../../src/mappings/dbFunctions/rewards";
import {
  blockTimeColumnsSql,
  CATALOG_FUNCTIONS,
  createSettlementFunctionsFn,
} from "../../src/mappings/dbFunctions/settlement/functions";
import { createSettlementTablesFn, ROLLUP_TABLES } from "../../src/mappings/dbFunctions/settlement/schema";
import {
  createSettlementSmartTagsFn,
  OMITTED_TABLES,
  STATE_FUNCTIONS,
  UNUSED_ENTITY_TABLES,
} from "../../src/mappings/dbFunctions/settlement/smartTags";
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
import { entityStubsSql } from "./stubs";

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
  "daily_claims_paid_by_address_service",
  "monthly_claims_by_supplier_service",
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
  "703773": "pocket",
  "689253": "pocket",
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

  // the newer catalog functions' entity tables, one row per block from 600000 to 900000 (stubs.ts)
  const stubEntityTables = async () =>
    c.query(entityStubsSql(S, `SELECT b.id FROM ${S}.blocks b WHERE b.id BETWEEN 600000 AND 900000`));

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
      INSERT INTO ${S}.event_claim_settleds VALUES (694993), (710013), (899713);
      -- indexed from 1 Jan 2026 to the fixtures' settlement block (1 Sep 12:00): the catalog's coverage
      -- (functions.ts _coverage) is what is indexed, and its fills run to the latest indexed block
      INSERT INTO ${S}.blocks VALUES (1, '2026-01-01'), (999999999, '2026-09-01 12:00');
      -- the indexer's money step processed every block (money/write.ts)
      INSERT INTO ${S}.money_progress VALUES (true, 1, 999999999);`);
    await c.query(createSupplierRevShareWalletsFn(S));
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
    // 703773: the same, with a slice so small that its first two legs already pay it
    // 689253: two claims their application could pay nothing of (settled 0, no request, no bank legs)
    const names = ["250053", "270033", "350013", "430053", "699993", "694053", "699213", "703773", "689253"];
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
      // 703773: G = 4, slice floor(4 × 0.8) = 3, legs 1 to the supplier and 2 twice to pokt1mvz6… (5, 2 overpaid)
      const small = await c.query(
        `SELECT c.global_minted_upokt::text g, c.global_to_supplier_upokt::text s, p.global_upokt::text p
         FROM ${S}.claim_settlements c
         JOIN ${S}.shareholder_payouts p USING (height, event_idx)
         WHERE c.height = 703773 AND c.supplier_id = 'pokt1gfxp7uv8cdx4ef84xvc5y0davsul83acmutcf9'
           AND p.recipient_id = 'pokt1mvz6gf82quaal497gcpz2pt50qvynuxsp4up44'`
      );
      assert.deepEqual(small.rows, [{ g: "4", s: "5", p: "4" }]);
      // 689253: the unpaid claims lose all they claimed to overservicing, and mint nothing
      const unpaid = await c.query(
        `SELECT count(*)::int n, sum(claimed_upokt)::text claimed, sum(overservicing_loss_upokt)::text loss,
                sum(relay_minted_upokt + global_minted_upokt + mint_ratio_unminted_upokt)::text minted,
                count(*) FILTER (WHERE session_id = '')::int no_session
         FROM ${S}.claim_settlements WHERE height = 689253 AND settled_upokt = 0`
      );
      assert.deepEqual(unpaid.rows, [{ n: 2, claimed: "31276", loss: "31276", minted: "0", no_session: 2 }]);
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
    assert.equal(rollups.length, 14);
    assert.equal(ROLLUP_TABLES.length, 14);
    const src = async (name: string) =>
      String(
        (await c.query(`SELECT prosrc FROM pg_proc WHERE pronamespace = $1::regnamespace AND proname = $2`, [S, name]))
          .rows[0].prosrc
      );
    const apply = await src("_rollup_apply");
    const rebuild = await src("rebuild_rollups");
    for (const r of rollups) {
      const t = String(r.relname);
      const ref = (verb: string) => new RegExp(`${verb} ${S}\\.${t}\\b`);
      assert.match(apply, ref("INSERT INTO"), `${t}: added`);
      // on a subtraction its upsert (a CTE of one statement, no ';' in it) returns the rows it wrote with the rule each breaks
      // and, at zero contributions, their ctid; the statement reads them and raises right after it, then those rows go
      const sub = new RegExp(`(r\\d) AS \\(INSERT INTO ${S}\\.${t} AS t[^;]*?RETURNING '${t}'::text AS rollup,[^;]*?` +
                             `AS left_row\\)\\s*SELECT \\(SELECT format[^;]*? FROM ([^;]*?) WHERE broken IS NOT NULL LIMIT 1\\),[^;]*?` +
                             `INTO v_drift,[^;]*;\\s*IF v_drift IS NOT NULL THEN\\s*` +
                             `RAISE EXCEPTION 'rollup drift at height %: % after subtracting the height'[^;]*;\\s*END IF;` +
                             `[\\s\\S]*?DELETE FROM ${S}\\.${t} WHERE ctid = ANY\\((v_zero\\d)\\) AND \\w+ = 0;\\s*GET DIAGNOSTICS v_n = ROW_COUNT;` +
                             `\\s*IF v_n <> cardinality\\(\\3\\) THEN`).exec(apply);
      assert.ok(sub && new RegExp(`\\b${sub[1]}\\b`).test(sub[2]), `${t}: checked on subtraction by its upsert's RETURNING`);
      assert.ok(sub && apply.includes(`ARRAY(SELECT zero_row FROM ${sub[1]} WHERE zero_row IS NOT NULL)`), `${t}: zero rows deleted`);
      // on an add, the same upsert alone
      const add = new RegExp(`\\bELSE (?:WITH [^;]*?)?INSERT INTO ${S}\\.${t} AS t\\b[^;]*; END IF;`).exec(apply.replace(/\s+/g, " "));
      assert.ok(add && !add[0].includes("RETURNING"), `${t}: added by a plain upsert`);
      assert.match(rebuild, ref("DELETE FROM"), `${t}: rebuilt`);
      assert.ok(String(r.tag).startsWith("@omit"), `${t}: hidden from GraphQL`);
      assert.ok(String(r.opts).includes("fillfactor=90"), `${t}: fillfactor`);
      assert.ok(TABLES.includes(t), `${t}: in the md5 of the rewrite and rebuild tests`);
      assert.ok(ROLLUP_TABLES.includes(t), `${t}: first_height / last_height (ROLLUP_TABLES)`);
      assert.match(apply, new RegExp(`INSERT INTO ${S}\\.${t} AS t[\\s\\S]*?first_height = CASE`), `${t}: bounds kept`);
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

  it("daily_claims_paid_by_address_service counts each claim once per address it paid, by day and service, as the base does", async () => {
    const r = (
      await c.query(`
        WITH b AS (SELECT sb.day, p.address, c.service_id, count(*)::bigint n, sum(c.settled_upokt)::bigint s,
                          sum(c.relays)::bigint r, sum(c.estimated_relays)::bigint er, sum(c.claimed_compute_units)::bigint cu,
                          sum(c.estimated_compute_units)::bigint ecu
                   FROM ${S}.v_claims_paid p JOIN ${S}.claim_settlements c ON c.height = p.height AND c.event_idx = p.event_idx
                   JOIN ${S}.settlement_blocks sb ON sb.height = c.height GROUP BY 1, 2, 3),
             t AS (SELECT day, address, service_id, claim_count, settled_upokt, relays, estimated_relays, claimed_compute_units,
                          estimated_compute_units FROM ${S}.daily_claims_paid_by_address_service)
        SELECT (SELECT count(*) FROM t)::int n, (SELECT count(*) FROM (SELECT * FROM t EXCEPT SELECT * FROM b) x)::int only_t,
               (SELECT count(*) FROM (SELECT * FROM b EXCEPT SELECT * FROM t) x)::int only_b,
               (SELECT count(*) FROM ${S}.settlement_blocks WHERE NOT claims_paid_rollup)::int unmarked,
               -- the roles v_claims_paid reads: every claim pays the DAO, and some pay a shareholder in both families
               (SELECT count(DISTINCT address) FROM ${S}.v_claims_paid p JOIN ${S}.settlement_blocks sb USING (height)
                WHERE p.address = sb.dao_address)::int dao,
               (SELECT count(*) FROM ${S}.shareholder_payouts WHERE relay_upokt > 0 AND global_upokt > 0)::int both_families`)
    ).rows[0];
    assert.ok(Number(r.n) > 0 && Number(r.dao) > 0 && Number(r.both_families) > 0, JSON.stringify(r));
    assert.deepEqual([r.only_t, r.only_b, r.unmarked], [0, 0, 0]);
  });

  it("a day written before daily_claims_paid_by_address_service: a rewrite subtracts nothing it did not add, and fill_claims_paid_day writes it", async () => {
    const before = await md5All();
    const day = "2026-09-01";
    const heights = (await c.query(`SELECT count(*)::int n FROM ${S}.settlement_blocks WHERE day = $1`, [day])).rows[0].n;
    assert.ok(Number(heights) >= 2, `precondition: the tests above wrote several heights on ${day}`);
    const fill = async () => Number((await c.query(`SELECT ${S}.fill_claims_paid_day($1) n`, [day])).rows[0].n);
    const rollupDay = async () =>
      (
        await c.query(
          `SELECT count(*)::int n, coalesce(md5(string_agg(x::text, '|' ORDER BY x::text)), '') h
           FROM ${S}.daily_claims_paid_by_address_service x WHERE day = $1`,
          [day]
        )
      ).rows[0];
    const held = async () =>
      (await c.query(`SELECT height::int h FROM ${S}.settlement_blocks WHERE day = $1 AND claims_paid_rollup ORDER BY 1`, [day]))
        .rows;
    // as the rollup arrives on a database written before it: no row, and no height held
    await c.query(`UPDATE ${S}.settlement_blocks SET claims_paid_rollup = false WHERE day = $1`, [day]);
    await c.query(`DELETE FROM ${S}.daily_claims_paid_by_address_service WHERE day = $1`, [day]);
    // rewriting one of them subtracts nothing (it would go negative: drift) and adds nothing: it stays not held
    const { height, payload } = payloadOf("899713", true);
    await write(height, payload);
    assert.deepEqual(await held(), []);
    assert.equal((await rollupDay()).n, 0);
    assert.equal(await fill(), Number(heights));
    assert.equal(await md5All(), before);
    // a day already held is left as it is, but not a row left at zero claims
    await c.query(`INSERT INTO ${S}.daily_claims_paid_by_address_service VALUES ($1, 'zero-row', 'svc', 0, 0, 0, 0, 0, 0)`, [day]);
    assert.equal(await fill(), 0);
    assert.equal(
      (await c.query(`SELECT count(*)::int n FROM ${S}.daily_claims_paid_by_address_service WHERE address = 'zero-row'`)).rows[0].n,
      0
    );
    // held -> an image without the rollup rewrites the height: it subtracts and adds the other rollups, leaves this one
    // as it was (the old contribution stays) and the height not held (its write_settlement does not name the column)
    const day0 = await rollupDay();
    await c.query(`UPDATE ${S}.settlement_blocks SET claims_paid_rollup = false WHERE height = $1`, [height]);
    // -> this image rewrites it: nothing subtracted, nothing added again, still not held, so no day counts it twice
    await write(height, payload);
    assert.deepEqual(await rollupDay(), day0);
    assert.ok(!(await held()).some((r) => r.h === height));
    // an image without the rollup that rewrote a held height may also have left a stale contribution: the fill
    // recomputes the whole day from the base tables
    await c.query(`UPDATE ${S}.daily_claims_paid_by_address_service SET claim_count = 2 * claim_count, settled_upokt = 2 * settled_upokt
                   WHERE day = $1`, [day]);
    assert.equal(await fill(), 1);
    assert.equal(await md5All(), before);
  });

  it("a height rewritten held -> by an image without the rollup -> by this one is counted once, also by the drift check", async () => {
    const before = await md5All();
    const { height, payload } = payloadOf("899713", true);
    const sums = async () =>
      (
        await c.query(
          `SELECT sum(claim_count)::text n, sum(settled_upokt)::text s, sum(estimated_relays)::text er,
                  sum(estimated_compute_units)::text ecu FROM ${S}.daily_claims_paid_by_address_service WHERE day = '2026-09-01'`
        )
      ).rows[0];
    const once = await sums();
    await c.query(`UPDATE ${S}.settlement_blocks SET claims_paid_rollup = false WHERE height = $1`, [height]);
    await write(height, payload);
    await write(height, payload);
    assert.deepEqual(await sums(), once);
    await c.query(`SELECT ${S}.fill_claims_paid_day('2026-09-01')`);
    assert.equal(await md5All(), before);
    // a held height whose rollup row lost an estimate is drift on its next rewrite, as a lost amount is
    for (const col of ["estimated_relays", "estimated_compute_units"]) {
      const k = (
        await c.query(
          `SELECT p.address, c.service_id FROM ${S}.v_claims_paid p
           JOIN ${S}.claim_settlements c ON c.height = p.height AND c.event_idx = p.event_idx
           JOIN ${S}.settlement_blocks sb ON sb.height = p.height WHERE sb.day = '2026-09-01'
           GROUP BY 1, 2 HAVING count(*) = 1 AND min(p.height) = ${height} AND sum(c.${col}) > 0
           ORDER BY 1, 2 LIMIT 1`
        )
      ).rows[0];
      assert.ok(k, `precondition: a row whose only claim is at ${height}, with ${col} > 0`);
      const where = `WHERE day = '2026-09-01' AND address = $1 AND service_id = $2`;
      // the height's contribution to the row gone but the estimate: claim_count reaches 0 with the estimate left
      await c.query(`UPDATE ${S}.daily_claims_paid_by_address_service SET ${col} = ${col} + 1 ${where}`, [k.address, k.service_id]);
      await assert.rejects(write(height, payload), /rollup drift at height 899713/, col);
      await c.query(`UPDATE ${S}.daily_claims_paid_by_address_service SET ${col} = ${col} - 1 ${where}`, [k.address, k.service_id]);
    }
    // any column going negative is drift too, on a row that other heights keep above 0 claims
    const m = (
      await c.query(
        `SELECT p.address, c.service_id FROM ${S}.v_claims_paid p
         JOIN ${S}.claim_settlements c ON c.height = p.height AND c.event_idx = p.event_idx
         JOIN ${S}.settlement_blocks sb ON sb.height = p.height WHERE sb.day = '2026-09-01'
         GROUP BY 1, 2 HAVING count(*) >= 2 AND count(*) FILTER (WHERE p.height = ${height}) >= 1
         ORDER BY 1, 2 LIMIT 1`
      )
    ).rows[0];
    assert.ok(m, `precondition: a row with claims at ${height} and at another height`);
    const whereM = `WHERE day = '2026-09-01' AND address = $1 AND service_id = $2`;
    const relays = (
      await c.query(`SELECT relays::text r FROM ${S}.daily_claims_paid_by_address_service ${whereM}`, [m.address, m.service_id])
    ).rows[0].r;
    await c.query(`UPDATE ${S}.daily_claims_paid_by_address_service SET relays = -1 ${whereM}`, [m.address, m.service_id]);
    await assert.rejects(write(height, payload), /rollup drift at height 899713/, "relays below 0");
    await c.query(`UPDATE ${S}.daily_claims_paid_by_address_service SET relays = $3 ${whereM}`, [m.address, m.service_id, relays]);
    assert.equal(await md5All(), before);
  });

  it("monthly_claims_by_supplier_service sums the claims per month, supplier and service, as the base does, every height held", async () => {
    const r = (
      await c.query(`
        WITH b AS (SELECT date_trunc('month', sb.day::timestamp)::date AS month, c.supplier_id, c.service_id, count(*)::bigint n,
                          sum(c.claimed_upokt)::bigint cl, sum(c.settled_upokt)::bigint st, sum(c.overservicing_loss_upokt)::bigint ol,
                          sum(c.relays)::bigint r, sum(c.estimated_relays)::bigint er,
                          sum(c.claimed_compute_units)::bigint cu, sum(c.estimated_compute_units)::bigint ecu,
                          count(*) FILTER (WHERE c.settled_with_proof)::bigint p
                   FROM ${S}.claim_settlements c JOIN ${S}.settlement_blocks sb USING (height) GROUP BY 1, 2, 3),
             t AS (SELECT month, supplier_id, service_id, claim_count, claimed_upokt, settled_upokt, overservicing_loss_upokt,
                          relays, estimated_relays, claimed_compute_units, estimated_compute_units,
                          claims_with_proof FROM ${S}.monthly_claims_by_supplier_service)
        SELECT (SELECT count(*) FROM t)::int n, (SELECT count(*) FROM (SELECT * FROM t EXCEPT SELECT * FROM b) x)::int only_t,
               (SELECT count(*) FROM (SELECT * FROM b EXCEPT SELECT * FROM t) x)::int only_b,
               (SELECT count(*) FROM ${S}.settlement_blocks WHERE NOT monthly_claims_rollup)::int unmarked,
               (SELECT sum(claims_with_proof) FROM t)::int with_proof, (SELECT sum(overservicing_loss_upokt) FROM t)::text ol`)
    ).rows[0];
    assert.ok(Number(r.n) > 0 && Number(r.with_proof) > 0, JSON.stringify(r));
    assert.deepEqual([r.only_t, r.only_b, r.unmarked], [0, 0, 0]);
  });

  it("a month written before monthly_claims_by_supplier_service: a rewrite adds nothing to it, and fill_monthly_claims_month writes it", async () => {
    const before = await md5All();
    const month = "2026-09-01";
    const heights = (
      await c.query(`SELECT count(*)::int n FROM ${S}.settlement_blocks WHERE date_trunc('month', day::timestamp) = $1`, [month])
    ).rows[0].n;
    assert.ok(Number(heights) >= 2, `precondition: the tests above wrote several heights in ${month}`);
    // any day of the month names it
    const fill = async () => Number((await c.query(`SELECT ${S}.fill_monthly_claims_month('2026-09-17') n`)).rows[0].n);
    const rollupMonth = async () =>
      (
        await c.query(
          `SELECT count(*)::int n, coalesce(md5(string_agg(x::text, '|' ORDER BY x::text)), '') h
           FROM ${S}.monthly_claims_by_supplier_service x WHERE month = $1`,
          [month]
        )
      ).rows[0];
    const held = async () =>
      (await c.query(`SELECT height::int h FROM ${S}.settlement_blocks WHERE monthly_claims_rollup ORDER BY 1`)).rows;
    // as the rollup arrives on a database written before it: no row, and no height held
    await c.query(`UPDATE ${S}.settlement_blocks SET monthly_claims_rollup = false`);
    await c.query(`DELETE FROM ${S}.monthly_claims_by_supplier_service`);
    // rewriting one of them subtracts nothing (it would go negative: drift) and adds nothing: it stays not held
    const { height, payload } = payloadOf("899713", true);
    await write(height, payload);
    assert.deepEqual(await held(), []);
    assert.equal((await rollupMonth()).n, 0);
    const other = new Client({ connectionString: URL });
    await other.connect();
    try {
      // it waits for the writer's lock past the session's lock_timeout (as write_settlement, up to 30 s a try), and
      // leaves the session's value as it was
      await other.query(`SELECT pg_advisory_lock(hashtext('pocketdex.write_settlement'))`);
      await c.query("BEGIN");
      let ok = false;
      try {
        await c.query("SET LOCAL lock_timeout = '50ms'");
        const filled = fill();
        filled.catch(() => undefined); // awaited below: a failure there, not as an unhandled rejection meanwhile
        await new Promise((r) => setTimeout(r, 800)); // past 10 tries of the session's 50 ms
        await other.query(`SELECT pg_advisory_unlock(hashtext('pocketdex.write_settlement'))`);
        assert.equal(await filled, Number(heights));
        assert.equal((await c.query("SELECT current_setting('lock_timeout') t")).rows[0].t, "50ms");
        // and holds it until it commits: a writer started meanwhile waits for it
        const locked = await other.query(`SELECT pg_try_advisory_lock(hashtext('pocketdex.write_settlement')) ok`);
        assert.equal(locked.rows[0].ok, false);
        ok = true;
      } finally {
        await c.query(ok ? "COMMIT" : "ROLLBACK");
      }
    } finally {
      await other.end();
    }
    assert.equal(await md5All(), before);
    // a month already held is left as it is, but not a row left at zero claims
    await c.query(`INSERT INTO ${S}.monthly_claims_by_supplier_service VALUES ($1, 'zero-row', 'svc', 0, 0, 0, 0, 0, 0, 0, 0, 0)`, [month]);
    assert.equal(await fill(), 0);
    assert.equal(
      (await c.query(`SELECT count(*)::int n FROM ${S}.monthly_claims_by_supplier_service WHERE supplier_id = 'zero-row'`)).rows[0].n,
      0
    );
    // held -> an image without the rollup rewrites the height: it subtracts and adds the other rollups, leaves this one as
    // it was (the old contribution stays) and the height not held (its write_settlement does not name the column)
    const month0 = await rollupMonth();
    await c.query(`UPDATE ${S}.settlement_blocks SET monthly_claims_rollup = false WHERE height = $1`, [height]);
    // -> this image rewrites it: nothing subtracted, nothing added again, still not held, so no month counts it twice
    await write(height, payload);
    assert.deepEqual(await rollupMonth(), month0);
    assert.ok(!(await held()).some((r) => r.h === height));
    // an image without the rollup that rewrote a held height may also have left a stale contribution: the fill
    // recomputes the whole month
    await c.query(`UPDATE ${S}.monthly_claims_by_supplier_service SET claim_count = 2 * claim_count, settled_upokt = 2 * settled_upokt
                   WHERE month = $1`, [month]);
    assert.equal(await fill(), 1);
    assert.equal(await md5All(), before);
  });

  // Per rollup, from its base rows (not from the writer's SQL): the lowest and highest settlement height of the rows each
  // rollup row sums, as [key..., first_height, last_height]. Rows in one and not the other, per rollup.
  const auditBounds = async () => {
    const inc = `${S}.v_income_base v JOIN ${S}.settlement_blocks sb USING (height)`;
    const cl = `${S}.claim_settlements c JOIN ${S}.settlement_blocks sb USING (height)`;
    const month = "date_trunc('month', sb.day::timestamp)::date";
    const base: Record<string, [string, string]> = {
      daily_claims_by_application_service: ["day, application_id, service_id", `SELECT sb.day, c.application_id, c.service_id, min(c.height), max(c.height) FROM ${cl} GROUP BY 1, 2, 3`],
      daily_claims_by_supplier: ["day, supplier_id", `SELECT sb.day, c.supplier_id, min(c.height), max(c.height) FROM ${cl} GROUP BY 1, 2`],
      daily_claims_by_supplier_application_service: ["day, supplier_id, application_id, service_id",
        `SELECT sb.day, c.supplier_id, c.application_id, c.service_id, min(c.height), max(c.height) FROM ${cl} GROUP BY 1, 2, 3, 4`],
      monthly_claims_by_supplier_service: ["month, supplier_id, service_id",
        `SELECT ${month}, c.supplier_id, c.service_id, min(c.height), max(c.height) FROM ${cl} WHERE sb.monthly_claims_rollup GROUP BY 1, 2, 3`],
      daily_income_by_address: ["day, address, role, family", `SELECT sb.day, v.address, v.role, v.family, min(v.height), max(v.height) FROM ${inc} GROUP BY 1, 2, 3, 4`],
      monthly_income_by_address_supplier: ["month, supplier_id, address, role, family",
        `SELECT ${month}, v.supplier_id, v.address, v.role, v.family, min(v.height), max(v.height) FROM ${inc} WHERE v.supplier_id <> '' GROUP BY 1, 2, 3, 4, 5`],
      daily_income_by_address_supplier: ["day, supplier_id, address, role, family",
        `SELECT sb.day, v.supplier_id, v.address, v.role, v.family, min(v.height), max(v.height) FROM ${inc} WHERE v.supplier_id <> '' GROUP BY 1, 2, 3, 4, 5
         UNION ALL SELECT sb.day, c.supplier_id, '', 'stakers', 'relay', min(c.height), max(c.height) FROM ${cl} GROUP BY 1, 2`],
      daily_income_by_address_service: ["day, address, role, family, service_id",
        `SELECT sb.day, v.address, v.role, v.family, v.service_id, min(v.height), max(v.height) FROM ${inc} WHERE v.service_id <> '' GROUP BY 1, 2, 3, 4, 5`],
      monthly_income_by_address_service: ["month, address, role, family, service_id",
        `SELECT ${month}, v.address, v.role, v.family, v.service_id, min(v.height), max(v.height) FROM ${inc} WHERE v.service_id <> '' GROUP BY 1, 2, 3, 4, 5`],
      monthly_income_by_address_supplier_service: ["month, address, supplier_id, service_id, role, family",
        `SELECT ${month}, v.address, v.supplier_id, v.service_id, v.role, v.family, min(v.height), max(v.height) FROM ${inc}
         WHERE v.supplier_id <> '' AND v.service_id <> '' GROUP BY 1, 2, 3, 4, 5, 6`],
      daily_claims_paid_by_address_service: ["day, address, service_id",
        `SELECT sb.day, p.address, c.service_id, min(p.height), max(p.height) FROM ${S}.v_claims_paid p
         JOIN ${S}.claim_settlements c ON c.height = p.height AND c.event_idx = p.event_idx JOIN ${S}.settlement_blocks sb ON sb.height = p.height
         WHERE sb.claims_paid_rollup GROUP BY 1, 2, 3`],
      daily_validator_rewards: ["day, validator_operator, family",
        `SELECT sb.day, x.validator_operator, x.family, min(x.height), max(x.height) FROM ${S}.validator_distributions x JOIN ${S}.settlement_blocks sb USING (height) GROUP BY 1, 2, 3`],
      daily_delegator_rewards_by_validator: ["day, delegator, validator_operator, family",
        `SELECT sb.day, x.delegator, x.validator_operator, x.family, min(x.height), max(x.height) FROM ${S}.delegator_validator_payouts x
         JOIN ${S}.settlement_blocks sb USING (height) GROUP BY 1, 2, 3, 4`],
      hourly_income_by_address_supplier: ["hour, address, supplier_id",
        `SELECT date_trunc('hour', sb.block_time, 'UTC'), v.address, v.supplier_id, min(v.height), max(v.height) FROM ${inc}
         WHERE v.supplier_id <> '' GROUP BY 1, 2, 3`],
    };
    assert.deepEqual(Object.keys(base).sort(), [...ROLLUP_TABLES].sort());
    const out: Record<string, string> = {};
    for (const [t, [keys, sql]] of Object.entries(base)) {
      const r = (
        await c.query(`WITH b AS (${sql}), t AS (SELECT ${keys}, first_height, last_height FROM ${S}.${t})
                       SELECT (SELECT count(*) FROM t)::int n, (SELECT count(*) FROM (SELECT * FROM t EXCEPT SELECT * FROM b) x)::int only_t,
                              (SELECT count(*) FROM (SELECT * FROM b EXCEPT SELECT * FROM t) x)::int only_b`)
      ).rows[0];
      out[t] = `${r.n} rows, ${r.only_t} not from the base, ${r.only_b} missing`;
    }
    return out;
  };
  const boundsHold = async (label: string) => {
    for (const [t, v] of Object.entries(await auditBounds()))
      assert.match(v, /^\d+ rows, 0 not from the base, 0 missing$/, `${label}: ${t} ${v}`);
  };

  it("every rollup row's first_height / last_height are the lowest and highest height of the base rows it sums", async () => {
    const a = await auditBounds();
    // the rollups the fixtures above write (the two claim-paid and claims rollups held, validators and delegators paid)
    for (const t of ROLLUP_TABLES) assert.ok(!a[t].startsWith("0 rows"), `${t}: ${a[t]}`);
    await boundsHold("as written");
    // every height written here holds its bounds
    assert.equal((await c.query(`SELECT count(*)::int n FROM ${S}.settlement_blocks WHERE NOT bounds_rollup`)).rows[0].n, 0);
  });

  it("the bounds columns come to rollups written before them by a catalog change alone, no table rewritten", async () => {
    const files = async () =>
      (
        await c.query(`SELECT relname, pg_relation_filenode(oid)::text f FROM pg_class
                       WHERE relnamespace = $1::regnamespace AND relname = ANY($2::text[]) ORDER BY 1`, [S, ROLLUP_TABLES])
      ).rows;
    await c.query("BEGIN");
    try {
      // as on a database written before them
      for (const t of ROLLUP_TABLES) await c.query(`ALTER TABLE ${S}.${t} DROP COLUMN first_height, DROP COLUMN last_height`);
      const before = await files();
      assert.equal(before.length, ROLLUP_TABLES.length);
      await c.query(createSettlementTablesFn(S));
      assert.deepEqual(await files(), before);
      const cols = await c.query(`SELECT count(*)::int n FROM information_schema.columns WHERE table_schema = $1
                                  AND table_name = ANY($2::text[]) AND column_name IN ('first_height', 'last_height')`, [S, ROLLUP_TABLES]);
      assert.equal(cols.rows[0].n, 2 * ROLLUP_TABLES.length);
    } finally {
      await c.query("ROLLBACK");
    }
    // a start on a database that has them alters nothing, and takes no lock on a rollup for it
    await c.query("BEGIN");
    try {
      await c.query(createSettlementTablesFn(S));
      const locks = await c.query(`SELECT count(*)::int n FROM pg_locks l JOIN pg_class k ON k.oid = l.relation
                                   WHERE l.pid = pg_backend_pid() AND l.mode = 'AccessExclusiveLock' AND k.relname = ANY($1::text[])`,
                                  [ROLLUP_TABLES]);
      assert.equal(locks.rows[0].n, 0);
    } finally {
      await c.query("ROLLBACK");
    }
  });

  it("a rewrite that leaves a validator row only replayed contributions recomputes the bound it removed", async () => {
    await c.query("BEGIN");
    try {
      const at = async (h: number, ts: string, p: SettlementPayload) => {
        for (const { bind, sql } of writeSettlementCalls(S, h, { ...p, ts })) await c.query(sql, bind);
      };
      // on 21 Aug: 710013's settlement (validators replayed, no commission), then 899713's (the same validators, with one)
      const replayed = payloadOf("710013", false).payload;
      const batched = payloadOf("899713", true).payload;
      await at(899821, "2026-08-21T12:10:00.000Z", replayed);
      await at(899822, "2026-08-21T12:20:00.000Z", batched);
      const row = async (v: string, f: string) =>
        (
          await c.query(
            `SELECT first_height || '..' || last_height b, commission_upokt::text c FROM ${S}.daily_validator_rewards
             WHERE day = '2026-08-21' AND validator_operator = $1 AND family = $2`,
            [v, f]
          )
        ).rows[0];
      const mixed = (
        await c.query(
          `SELECT validator_operator v, family f FROM ${S}.daily_validator_rewards
           WHERE day = '2026-08-21' AND commission_upokt IS NOT NULL AND commission_na_count BETWEEN 1 AND contribution_count - 1
             AND first_height = 899821 AND last_height = 899822 ORDER BY 1, 2 LIMIT 1`
        )
      ).rows[0];
      assert.ok(mixed, "precondition: a validator both heights paid on 21 Aug, with and without a commission");
      // 899822 rewritten with nothing: the row keeps 710013's replayed contributions alone, so the subtraction sets its
      // commission to NULL (a new version of the row, after its upsert left its last height at -899822) and the add,
      // which does not touch it, recomputes that bound
      await at(899822, "2026-08-21T12:20:00.000Z", {
        ...batched, claims: [], detailed: [], batch: [], vrd: [], reimb: [], expired: [], discarded: [], slashed: [], dv: [],
      });
      assert.deepEqual(await row(String(mixed.v), String(mixed.f)), { b: "899821..899821", c: null });
      await boundsHold("899822 emptied");
    } finally {
      await c.query("ROLLBACK");
    }
  });

  it("a rewrite that removes a row's first or last height recomputes it from the base, and one that keeps it changes nothing", async () => {
    await c.query("BEGIN");
    try {
      const at = async (h: number, ts: string, p: SettlementPayload) => {
        for (const { bind, sql } of writeSettlementCalls(S, h, { ...p, ts })) await c.query(sql, bind);
      };
      const emptied = (p: SettlementPayload): SettlementPayload =>
        ({ ...p, claims: [], detailed: [], batch: [], vrd: [], reimb: [], expired: [], discarded: [], slashed: [], dv: [] });
      // two small settlements, each three times on 20 Aug (nothing else settled that day), the last one in a later hour:
      // 694993's claims (supplier and claim rollups), 703773's validator and delegator payouts (staker rollups)
      const p = payloadOf("694993", false).payload;
      const q = payloadOf("703773", false).payload;
      assert.ok(q.vrd.length > 0 && q.dv.length > 0, "precondition: 703773 pays validators and delegators");
      for (const [h, ts] of [[899801, "12:10"], [899802, "12:20"], [899803, "13:30"]] as const) await at(h, `2026-08-20T${ts}:00.000Z`, p);
      for (const [h, ts] of [[899811, "12:10"], [899812, "12:20"], [899813, "13:30"]] as const) await at(h, `2026-08-20T${ts}:00.000Z`, q);
      const supplier = p.claims[0].supplier_id;
      const validator = q.vrd[0].validator_operator;
      const rows = async () =>
        (
          await c.query(
            `SELECT (SELECT first_height || '..' || last_height FROM ${S}.daily_claims_by_supplier WHERE supplier_id = $1 AND day = '2026-08-20') s,
                    (SELECT min(first_height) || '..' || max(last_height) FROM ${S}.daily_validator_rewards
                     WHERE validator_operator = $2 AND day = '2026-08-20') v`,
            [supplier, validator]
          )
        ).rows[0];
      assert.deepEqual(await rows(), { s: "899801..899803", v: "899811..899813" });
      await boundsHold("written three times");
      // the same settlements written again: nothing moves
      const before = await md5All();
      await at(899803, "2026-08-20T13:30:00.000Z", p);
      await at(899813, "2026-08-20T13:30:00.000Z", q);
      assert.equal(await md5All(), before);
      // the last ones rewritten with nothing: every row they were the last height of goes back, from the base
      await at(899803, "2026-08-20T13:30:00.000Z", emptied(p));
      await at(899813, "2026-08-20T13:30:00.000Z", emptied(q));
      assert.deepEqual(await rows(), { s: "899801..899802", v: "899811..899812" });
      await boundsHold("last heights emptied");
      // and the first ones: every row they were the first height of goes up
      await at(899801, "2026-08-20T12:10:00.000Z", emptied(p));
      await at(899811, "2026-08-20T12:10:00.000Z", emptied(q));
      assert.deepEqual(await rows(), { s: "899802..899802", v: "899812..899812" });
      await boundsHold("first heights emptied");
    } finally {
      await c.query("ROLLBACK");
    }
  });

  it("fill_rollup_bounds writes the bounds of rows written before them, waits for the replicas, and resumes after a stop", async () => {
    const before = await md5All();
    const notices: string[] = [];
    const onNotice = (m: { message: string }) => notices.push(m.message);
    (c as unknown as { on(e: string, f: (m: { message: string }) => void): void }).on("notice", onNotice);
    // a replica that replays 10 s behind for its next reads, then caught up (in place of pg_stat_replication)
    const lagging = async (reads: number) => {
      await c.query(`DROP TABLE IF EXISTS ${S}.lag_script; CREATE TABLE ${S}.lag_script (n serial, s numeric)`);
      await c.query(`INSERT INTO ${S}.lag_script (s) SELECT 10 FROM generate_series(1, $1)`, [reads]);
      await c.query(`CREATE OR REPLACE FUNCTION ${S}._replica_lag(OUT senders int, OUT readable int, OUT lag_seconds numeric,
                       OUT lag_bytes numeric) LANGUAGE sql VOLATILE AS $f$
                       WITH x AS (DELETE FROM ${S}.lag_script WHERE n = (SELECT min(n) FROM ${S}.lag_script) RETURNING s)
                       SELECT 1, 1, coalesce((SELECT s FROM x), 0), 0::numeric $f$`);
    };
    try {
      // as on a database written before the bounds: none on any row, no height marked
      for (const t of ROLLUP_TABLES) await c.query(`UPDATE ${S}.${t} SET first_height = NULL, last_height = NULL`);
      await c.query(`UPDATE ${S}.settlement_blocks SET bounds_rollup = false`);
      // stopped while it waits for the replica (statement_timeout, as a Ctrl-C would): what it committed stays
      await lagging(30);
      await c.query("SET statement_timeout = '3s'");
      await assert.rejects(c.query(`CALL ${S}.fill_rollup_bounds()`), /statement timeout/);
      await c.query("RESET statement_timeout");
      assert.ok(notices.some((n) => /waiting, replica 10\.0 s and 0\.0 MB behind/.test(n)), notices.join("\n"));
      const kept = (await c.query(`SELECT array_agg(unit) u FROM ${S}.rollup_bounds_fill`)).rows[0].u as unknown as string[];
      assert.ok(kept && kept.length >= 1, "the units done before the stop are kept");
      assert.equal((await c.query(`SELECT count(*)::int n FROM ${S}.settlement_blocks WHERE bounds_rollup`)).rows[0].n, 0);
      // run again: it resumes after them, waits for the replica, and finishes
      notices.length = 0;
      await lagging(2);
      await c.query(`CALL ${S}.fill_rollup_bounds()`);
      assert.ok(notices.some((n) => /fill_rollup_bounds: \d{4}-\d{2} done, \d+ heights marked/.test(n)), notices.join("\n"));
      for (const u of kept) {
        const [t, day] = u.split(" ");
        assert.ok(!notices.some((n) => n.startsWith(`fill_rollup_bounds: ${day} ${t} `)), `${u} done before, not redone`);
      }
      assert.equal((await c.query(`SELECT count(*)::int n FROM ${S}.settlement_blocks WHERE NOT bounds_rollup`)).rows[0].n, 0);
      assert.equal((await c.query(`SELECT count(*)::int n FROM ${S}.rollup_bounds_fill`)).rows[0].n, 0);
      await boundsHold("filled");
      assert.equal(await md5All(), before);
      // nothing left: a third run does nothing
      notices.length = 0;
      await c.query(`CALL ${S}.fill_rollup_bounds()`);
      assert.deepEqual(notices, []);
      // the throttle stops when the replicas' positions cannot be read, and paces the WAL of a minute
      await c.query(`CREATE OR REPLACE FUNCTION ${S}._replica_lag(OUT senders int, OUT readable int, OUT lag_seconds numeric,
                       OUT lag_bytes numeric) LANGUAGE sql VOLATILE AS $f$ SELECT 1, 0, 0::numeric, 0::numeric $f$`);
      await assert.rejects(c.query(`CALL ${S}._fill_throttle(5, 1e9, NULL, now(), pg_current_wal_lsn(), 0)`), /not readable by this role/);
      await c.query(`CREATE OR REPLACE FUNCTION ${S}._replica_lag(OUT senders int, OUT readable int, OUT lag_seconds numeric,
                       OUT lag_bytes numeric) LANGUAGE sql VOLATILE AS $f$ SELECT 0, 0, 0::numeric, 0::numeric $f$`);
      const paced = await c.query(`CALL ${S}._fill_throttle(5, 1e9, 1, now() - interval '58 seconds', '0/0'::pg_lsn, 0)`);
      assert.ok(Number(paced.rows[0].waited) >= 1.5, JSON.stringify(paced.rows[0]));
    } finally {
      (c as unknown as { removeListener(e: string, f: unknown): void }).removeListener("notice", onNotice);
      await c.query("RESET statement_timeout");
      await c.query(`DROP TABLE IF EXISTS ${S}.lag_script`);
      // the real _replica_lag back
      await c.query(createSettlementWriterFn(S));
    }
  });

  it("fill_rollup_bounds marks only the heights it found unmarked when it took the month, not one an image without the bounds wrote meanwhile", async () => {
    const notices: string[] = [];
    const onNotice = (m: { message: string }) => notices.push(m.message);
    (c as unknown as { on(e: string, f: (m: { message: string }) => void): void }).on("notice", onNotice);
    const last = (
      await c.query(`SELECT max(height)::text h, date_trunc('month', max(day))::date::text m FROM ${S}.settlement_blocks`)
    ).rows[0] as { h: string; m: string };
    const month = `day >= '${last.m}'::date AND day < ('${last.m}'::date + interval '1 month')`;
    try {
      // the month's heights unmarked, but its last one, which the fake replica read below unmarks once the run has
      // taken the month: as an older image writing that height during the fill would leave it
      await c.query(`UPDATE ${S}.settlement_blocks SET bounds_rollup = (height = $1) WHERE ${month}`, [last.h]);
      const heights = Number((await c.query(`SELECT count(*) n FROM ${S}.settlement_blocks WHERE ${month}`)).rows[0].n);
      assert.ok(heights >= 2, `the month has ${heights} heights`);
      await c.query(`CREATE OR REPLACE FUNCTION ${S}._replica_lag(OUT senders int, OUT readable int, OUT lag_seconds numeric,
                       OUT lag_bytes numeric) LANGUAGE sql VOLATILE AS $f$
                       UPDATE ${S}.settlement_blocks SET bounds_rollup = false WHERE height = ${last.h} AND bounds_rollup;
                       SELECT 1, 1, 0::numeric, 0::numeric $f$`);
      await c.query(`CALL ${S}.fill_rollup_bounds()`);
      const unmarked = (await c.query(`SELECT array_agg(height::text) h FROM ${S}.settlement_blocks WHERE NOT bounds_rollup`)).rows[0]
        .h as unknown as string[];
      assert.deepEqual(unmarked, [last.h]);
      assert.ok(notices.some((n) => n.endsWith(`done, ${heights - 1} heights marked`)), notices.join("\n"));
      assert.ok(notices.some((n) => / 1 heights left unmarked, written while the fill ran/.test(n)), notices.join("\n"));
      // once every writer keeps the bounds (the real _replica_lag back), the next run marks it
      await c.query(createSettlementWriterFn(S));
      const lagSrc = (await c.query(`SELECT prosrc FROM pg_proc WHERE oid = '${S}._replica_lag'::regproc`)).rows[0].prosrc as string;
      assert.ok(lagSrc.includes("pg_stat_get_wal_senders") && !lagSrc.includes("bounds_rollup"), lagSrc);
      await c.query(`CALL ${S}.fill_rollup_bounds()`);
      assert.equal((await c.query(`SELECT count(*)::int n FROM ${S}.settlement_blocks WHERE NOT bounds_rollup`)).rows[0].n, 0);
      await boundsHold("marked on the next run");
    } finally {
      (c as unknown as { removeListener(e: string, f: unknown): void }).removeListener("notice", onNotice);
      await c.query(createSettlementWriterFn(S));
    }
  });

  it("subtracting a height raises on each rule of each rollup row it touched, naming the rollup, the key and the rule, and on no other row", async () => {
    // the rules of the check: any column of the rollup (but its key, period and bounds, read here from the catalog) below 0, the
    // invariants between columns listed below, and a row at 0 contributions with any other column not at 0
    const claims = ["claims_with_proof > claim_count"];
    const day = "day = $1::date";
    const month = "month = date_trunc('month', $1::date)::date";
    // rollup, its rows of a height's period, key, count, invariants between columns
    const rollups: Array<[string, string, string[], string, string[]]> = [
      ["daily_income_by_address", day, ["address", "role", "family"], "contribution_count", []],
      // its 'stakers' rows (address '', from the claims) and its address rows
      ["daily_income_by_address_supplier", `${day} AND role = 'stakers'`, ["supplier_id", "address", "role", "family"], "contribution_count", []],
      ["daily_income_by_address_supplier", `${day} AND role <> 'stakers'`, ["supplier_id", "address", "role", "family"], "contribution_count", []],
      ["daily_income_by_address_service", day, ["address", "role", "family", "service_id"], "contribution_count", []],
      ["monthly_income_by_address_supplier", month, ["address", "supplier_id", "role", "family"], "contribution_count", []],
      ["monthly_income_by_address_service", month, ["address", "role", "family", "service_id"], "contribution_count", []],
      ["monthly_income_by_address_supplier_service", month, ["address", "supplier_id", "service_id", "role", "family"], "contribution_count", []],
      ["hourly_income_by_address_supplier", "hour = ($1::date + interval '12 hours') AT TIME ZONE 'UTC'", ["address", "supplier_id"],
       "contribution_count", []],
      ["daily_claims_by_application_service", day, ["application_id", "service_id"], "claim_count", []],
      ["daily_claims_by_supplier", day, ["supplier_id"], "claim_count", claims],
      ["daily_claims_by_supplier_application_service", day, ["supplier_id", "application_id", "service_id"], "claim_count", claims],
      ["monthly_claims_by_supplier_service", month, ["supplier_id", "service_id"], "claim_count", claims],
      ["daily_delegator_rewards_by_validator", day, ["delegator", "validator_operator", "family"], "contribution_count",
       ["replayed_count > contribution_count"]],
      ["daily_validator_rewards", day, ["validator_operator", "family"], "contribution_count",
       ["commission_na_count > contribution_count", "commission_na_count = contribution_count AND coalesce(commission_upokt, 0) <> 0"]],
      ["daily_claims_paid_by_address_service", day, ["address", "service_id"], "claim_count", []],
    ];
    const rulesOf = async (t: string, keys: string[], count: string, rules: string[]) => {
      const cols = (
        await c.query(`SELECT column_name::text c FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2
                       ORDER BY ordinal_position`, [S, t])
      ).rows.map((r) => String(r.c)).filter((col) => ![...keys, "day", "month", "hour", count, "first_height", "last_height"].includes(col));
      assert.ok(cols.length > 0, `${t}: measures besides ${count}`);
      return [`${count} < 0`, ...cols.map((col) => `${col} < 0`), ...rules, ...cols.map((col) => `${count} = 0 AND ${col} <> 0`)];
    };
    // the column a rule is about, and the update that breaks it, and only it or an earlier rule about the same column, once
    // the height's contribution is subtracted from a row that holds nothing else (each height below is the only one of its
    // month, so every row of its periods is its own); a measure below 0 on a row that keeps one contribution
    const columnOf = (rule: string) => (/^(\w+) < 0$|^\w+ = 0 AND (\w+) <> 0$|^(\w+) > \w+$/.exec(rule) ?? []).slice(1).find(Boolean) ?? "commission_upokt";
    const breaking = (rule: string, count: string) => {
      const col = columnOf(rule);
      if (rule === `${count} < 0`) return `${count} = ${count} - 1`;
      if (rule === `${col} < 0`) return `${count} = ${count} + 1, ${col} = coalesce(${col}, 0) - 1`;
      return `${col} = coalesce(${col}, 0) + 1`;
    };
    const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    await c.query("BEGIN");
    try {
      // 710013's settlement alone in May (validators with and without a commission, replayed delegator rows), and
      // 899713's alone in June for what 710013 lacks; both new, so held by the claims_paid and monthly claims rollups
      const heights = [
        { height: 540013, date: "2026-05-10", payload: payloadOf("710013", false).payload },
        { height: 550013, date: "2026-06-10", payload: payloadOf("899713", true).payload },
      ];
      const writeAt = async (h: (typeof heights)[number]) => {
        h.payload.ts = `${h.date}T12:00:00.000Z`;
        for (const { bind, sql } of writeSettlementCalls(S, h.height, h.payload)) await c.query(sql, bind);
      };
      for (const h of heights) await writeAt(h);
      // a subtraction alone leaves no row at zero contributions: each height is the only one of its periods, so all of
      // their rows go
      await c.query("SAVEPOINT d");
      for (const h of heights) await c.query(`CALL ${S}._rollup_apply($1, -1)`, [h.height]);
      for (const [t, period] of rollups)
        for (const h of heights) {
          const n = (await c.query(`SELECT count(*)::int n FROM ${S}.${t} WHERE ${period}`, [h.date])).rows[0].n;
          assert.equal(n, 0, `${t}: no row left after subtracting ${h.height}`);
        }
      await c.query("ROLLBACK TO SAVEPOINT d");
      const cases: string[] = [];
      for (const [t, period, keys, count, explicit] of rollups) {
        const rules = await rulesOf(t, keys, count, explicit);
        const touched: Array<{ h: (typeof heights)[number]; id: string; k: string }> = [];
        for (const h of heights) {
          const r = (await c.query(`SELECT ctid::text id, concat_ws(' / ', ${keys.join(", ")}) k FROM ${S}.${t}
                                     WHERE ${period} ORDER BY ${keys.join(", ")} LIMIT 1`, [h.date])).rows[0];
          if (r) touched.push({ h, id: String(r.id), k: String(r.k) });
        }
        assert.ok(touched.length > 0, `precondition: a ${t} row one of the heights wrote`);
        const { h, id, k } = touched[0];
        for (const [i, rule] of rules.entries()) {
          // the rule, or an earlier one about the same column that the update breaks too (a column at 0 contributions
          // above its count, a commission left on a row without one)
          const named = rules.slice(0, i + 1).filter((r) => r === rule || new RegExp(`\\b${columnOf(rule)}\\b`).test(r));
          await c.query("SAVEPOINT d");
          const n = await c.query(`UPDATE ${S}.${t} SET ${breaking(rule, count)} WHERE ctid = $1::tid RETURNING 1`, [id]);
          assert.equal(n.rows.length, 1);
          // the subtraction of the height's rewrite, alone
          await assert.rejects(
            c.query(`CALL ${S}._rollup_apply($1, -1)`, [h.height]),
            new RegExp(`: rollup drift at height ${h.height}: ${t} row ${esc(k)} has (${named.map(esc).join("|")}) after subtracting the height$`),
            `${t}: ${rule}`
          );
          await c.query("ROLLBACK TO SAVEPOINT d");
          cases.push(`${t}: ${rule}`);
        }
        // a row of the same period the height did not touch, broken: its rewrite leaves it as it is
        await c.query(`INSERT INTO ${S}.${t} SELECT (jsonb_populate_record(NULL::${S}.${t},
                         to_jsonb(x) || jsonb_build_object($2::text, 'untouched', $3::text, -1))).* FROM ${S}.${t} x WHERE ctid = $1::tid`,
                       [id, keys[0], count]);
      }
      // columns the probes before the RETURNING check did not read, below 0 on a row with contributions or at zero
      // contributions, are checked now; and the whole of rules x rollups
      assert.equal(cases.length, 165);
      for (const x of ["daily_income_by_address: transfer_count < 0", "daily_validator_rewards: self_delegation_upokt < 0",
                       "daily_claims_by_application_service: relay_to_dao_upokt < 0",
                       "daily_claims_by_application_service: claim_count = 0 AND mint_ratio_unminted_upokt <> 0",
                       "daily_claims_by_supplier_application_service: claim_count = 0 AND global_minted_upokt <> 0",
                       "daily_validator_rewards: contribution_count = 0 AND self_delegation_upokt <> 0",
                       "daily_claims_paid_by_address_service: claim_count = 0 AND estimated_compute_units <> 0"])
        assert.ok(cases.includes(x), x);
      for (const h of heights) await writeAt(h);
      // a row of the gated rollups that a height no longer held does not touch, broken: its rewrite leaves it as it is
      await c.query("SAVEPOINT d");
      await c.query(`UPDATE ${S}.settlement_blocks SET claims_paid_rollup = false, monthly_claims_rollup = false
                     WHERE height = ANY($1::bigint[])`, [heights.map((h) => h.height)]);
      for (const t of ["daily_claims_paid_by_address_service", "monthly_claims_by_supplier_service"]) {
        const n = await c.query(`UPDATE ${S}.${t} SET claim_count = claim_count - 1000000 WHERE claim_count > 0 RETURNING 1`);
        assert.ok(n.rows.length > 0, `precondition: ${t} rows`);
      }
      for (const h of heights) await writeAt(h);
      await c.query("ROLLBACK TO SAVEPOINT d");
      for (const [t, , keys] of rollups) {
        const n = (await c.query(`SELECT count(*)::int n FROM ${S}.${t} WHERE ${keys[0]} = 'untouched'`)).rows[0].n;
        assert.equal(n, rollups.filter((r) => r[0] === t).length, `${t}: the untouched rows are left`);
      }
    } finally {
      await c.query("ROLLBACK");
    }
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

  it("get_last_settlement is the highest written settlement height up to money_progress and its block time, and is described for GraphQL", async () => {
    const want = await c.query(`SELECT height::text, block_time FROM ${S}.settlement_blocks ORDER BY height DESC LIMIT 1`);
    assert.equal(want.rows.length, 1, "the fixtures above wrote settlements");
    const got = await c.query(`SELECT height::text, block_time FROM ${S}.get_last_settlement()`);
    assert.deepEqual(got.rows, want.rows);
    const d = await c.query(`SELECT obj_description('${S}.get_last_settlement()'::regprocedure, 'pg_proc') d`);
    assert.match(String(d.rows[0].d), /^The last settlement the money tables hold/);
    // a rewound money step leaves its rows above the progress: they are not the last settlement until rewritten
    await c.query("BEGIN");
    try {
      const below = (
        await c.query(`SELECT height::text h, block_time FROM ${S}.settlement_blocks ORDER BY height DESC OFFSET 1 LIMIT 1`)
      ).rows[0];
      await c.query(`UPDATE ${S}.money_progress SET height = $1`, [below.h]);
      const got2 = await c.query(`SELECT height::text, block_time FROM ${S}.get_last_settlement()`);
      assert.deepEqual(got2.rows, [{ height: below.h, block_time: below.block_time }]);
      // with no progress: one row of NULLs, as the comment says (not set-returning, so not an empty result)
      await c.query(`DELETE FROM ${S}.money_progress`);
      const got3 = await c.query(`SELECT height::text, block_time FROM ${S}.get_last_settlement()`);
      assert.deepEqual(got3.rows, [{ height: null, block_time: null }]);
    } finally {
      await c.query("ROLLBACK");
    }
  });

  it("get_height_at is the last indexed block at or before a time, and is described for GraphQL", async () => {
    await c.query("BEGIN");
    try {
      // three blocks after the fixtures' last one, two of them in the same microsecond (the higher height answers)
      await c.query(`INSERT INTO ${S}.blocks VALUES (1000000001, '2027-01-01 00:00:00.000001'),
        (1000000002, '2027-01-01 00:00:00.000005'), (1000000003, '2027-01-01 00:00:00.000005')`);
      const at = async (t: string) =>
        (await c.query(`SELECT height::text, to_char(block_time AT TIME ZONE 'UTC', 'SS.US') t, beyond_tip FROM ${S}.get_height_at('${t}')`)).rows;
      for (const [time, want] of [
        ["2027-01-01T00:00:00.000001Z", [{ height: "1000000001", t: "00.000001", beyond_tip: false }]],
        ["2027-01-01T00:00:00.000004Z", [{ height: "1000000001", t: "00.000001", beyond_tip: false }]],
        // at the newest block's time: not beyond it; after it: the newest block, beyond the tip
        ["2027-01-01T00:00:00.000005Z", [{ height: "1000000003", t: "00.000005", beyond_tip: false }]],
        ["2027-01-01T01:00:01+01:00", [{ height: "1000000003", t: "00.000005", beyond_tip: true }]],
        // before the first indexed block: one row of NULLs (not set-returning)
        ["2000-01-01T00:00:00Z", [{ height: null, t: null, beyond_tip: null }]],
      ] as const)
        assert.deepEqual([time, await at(time)], [time, want]);
      await c.query("SAVEPOINT e");
      await assert.rejects(c.query(`SELECT * FROM ${S}.get_height_at(NULL)`), /at_time is required/);
      await c.query("ROLLBACK TO SAVEPOINT e");
    } finally {
      await c.query("ROLLBACK");
    }
    const d = await c.query(`SELECT obj_description('${S}.get_height_at(timestamptz)'::regprocedure, 'pg_proc') d`);
    assert.match(String(d.rows[0].d), /^The last indexed block at or before at_time/);
  });

  it("the block-time computed columns give each row its block's time, and stay published", async () => {
    await c.query("BEGIN");
    try {
      // blocks 1 (2026-01-01) and 999999999 (2026-09-01 12:00); a row at a height with no block row yet gets NULL
      await c.query(`
        CREATE TABLE ${S}.transactions (id text, block_id numeric);
        CREATE TABLE ${S}.native_transfers (id text, block_id numeric);
        CREATE TABLE ${S}.balances (id text, last_updated_block_id numeric);
        INSERT INTO ${S}.transactions VALUES ('t1', 999999999), ('t2', 5);
        INSERT INTO ${S}.native_transfers VALUES ('n1', 1);
        INSERT INTO ${S}.balances VALUES ('b1', 999999999);`);
      // the startup DDL, twice (idempotent), then the smart tags, which must not hide them
      await c.query(blockTimeColumnsSql(S));
      await c.query(blockTimeColumnsSql(S));
      await c.query(createSettlementSmartTagsFn(S));
      const { rows } = await c.query(`
        SELECT 'tx ' || t.id || ' ' || coalesce(to_char(${S}.transactions_block_time(t) AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI'), '-') k
        FROM ${S}.transactions t
        UNION ALL SELECT 'nt ' || n.id || ' ' || to_char(${S}.native_transfers_block_time(n) AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI')
        FROM ${S}.native_transfers n
        UNION ALL SELECT 'bal ' || b.id || ' ' || to_char(${S}.balances_last_updated_time(b) AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI')
        FROM ${S}.balances b ORDER BY 1`);
      assert.deepEqual(rows.map((r) => r.k), ["bal b1 2026-09-01 12:00", "nt n1 2026-01-01 00:00", "tx t1 2026-09-01 12:00", "tx t2 -"]);
      const d = await c.query(`SELECT p.proname, count(*) OVER (PARTITION BY p.proname) n, obj_description(p.oid, 'pg_proc') d FROM pg_proc p
        WHERE p.pronamespace = $1::regnamespace AND p.proname IN ('transactions_block_time', 'native_transfers_block_time',
          'balances_last_updated_time') ORDER BY 1`, [S]);
      assert.deepEqual(d.rows.map((r) => [r.proname, String(r.n), /^Time of the block/.test(String(r.d))]), [
        ["balances_last_updated_time", "1", true],
        ["native_transfers_block_time", "1", true],
        ["transactions_block_time", "1", true],
      ]);
    } finally {
      await c.query("ROLLBACK");
    }
  });

  it("get_active_accounts counts the live upokt balances updated since each time", async () => {
    await c.query("BEGIN");
    try {
      // blocks 1 (2026-01-01) and 999999999 (2026-09-01 12:00); acc-a updated at the last block, acc-b at the first, acc-c's
      // live row is another denom, acc-d's update at the last block is a closed version
      await c.query(`
        CREATE TABLE ${S}.balances (account_id text, denom text, last_updated_block_id numeric, _block_range int8range);
        INSERT INTO ${S}.balances VALUES ('acc-a', 'upokt', 999999999, int8range(999999999, NULL)),
          ('acc-a', 'upokt', 1, int8range(1, 999999999)), ('acc-b', 'upokt', 1, int8range(1, NULL)),
          ('acc-c', 'mact', 999999999, int8range(999999999, NULL)), ('acc-d', 'upokt', 999999999, int8range(999999999, 999999999 + 1)),
          ('acc-d', 'upokt', 1, int8range(1, 2));`);
      const { rows } = await c.query(
        `SELECT since_time AT TIME ZONE 'UTC' t, height::text, beyond_tip, accounts::text FROM ${S}.get_active_accounts($1::timestamptz[])`,
        [["2026-06-01T00:00:00Z", "2025-01-01T00:00:00Z", "2026-09-01T12:00:00Z", "2026-09-02T00:00:00Z", "2026-06-01T00:00:00Z"]]
      );
      assert.deepEqual(
        rows.map((r) => [new Date(String(r.t) + "Z").toISOString(), r.height, r.beyond_tip, r.accounts]),
        [
          ["2025-01-01T00:00:00.000Z", null, false, "2"],
          ["2026-06-01T00:00:00.000Z", "1", false, "1"],
          // at the last block's time: that block counts (the newest block before it is 1)
          ["2026-09-01T12:00:00.000Z", "1", false, "1"],
          ["2026-09-02T00:00:00.000Z", "999999999", true, null],
        ]
      );
      for (const arg of ["ARRAY[]::timestamptz[]", "ARRAY[NULL]::timestamptz[]"]) {
        await c.query("SAVEPOINT e");
        await assert.rejects(c.query(`SELECT * FROM ${S}.get_active_accounts(${arg})`), /since_times must have between 1 and 20 times/);
        await c.query("ROLLBACK TO SAVEPOINT e");
      }
    } finally {
      await c.query("ROLLBACK");
    }
  });

  it("get_block_supplies gives the supply of each denomination at a block", async () => {
    await c.query("BEGIN");
    try {
      await c.query(`
        CREATE TABLE ${S}.block_supplies (block_id numeric, supply_id text, _block_range int8range);
        CREATE TABLE ${S}.supplies (id text, denom text, amount numeric, _block_range int8range);
        INSERT INTO ${S}.block_supplies VALUES (10, 'upokt@10', int8range(10, NULL)), (10, 'mact@1', int8range(10, NULL)),
          (11, 'upokt@11', int8range(11, NULL)), (11, 'mact@1', int8range(11, NULL));
        INSERT INTO ${S}.supplies VALUES ('upokt@10', 'upokt', 1000, int8range(10, NULL)), ('upokt@11', 'upokt', 1005, int8range(11, NULL)),
          ('mact@1', 'mact', 7, int8range(1, NULL));`);
      const at = async (h: string) =>
        (await c.query(`SELECT denom || ' ' || amount k FROM ${S}.get_block_supplies(${h})`)).rows.map((r) => r.k);
      assert.deepEqual(await at("11"), ["mact 7", "upokt 1005"]);
      assert.deepEqual(await at("10"), ["mact 7", "upokt 1000"]);
      assert.deepEqual(await at("12"), []);
      // by hash (any case), the same rows; and the block's metadata record, by height or by hash
      await c.query(`
        ALTER TABLE ${S}.blocks ADD COLUMN hash text;
        INSERT INTO ${S}.blocks (id, timestamp, hash) VALUES (11, '2026-01-02', 'AB11');
        CREATE TABLE ${S}.block_metadata (id numeric, block_id jsonb, header jsonb, last_commit jsonb, _block_range int8range);
        INSERT INTO ${S}.block_metadata VALUES (11, '{"hash": "AB11"}', '{"height": "11"}', '{"round": 0}', int8range(11, NULL));`);
      assert.deepEqual(await at("hash => 'ab11'"), ["mact 7", "upokt 1005"]);
      assert.deepEqual(await at("hash => 'NONE'"), []);
      const meta = async (args: string) =>
        (await c.query(`SELECT block_height || ' ' || header::text || ' ' || last_commit::text || ' ' || block_id::text k
                        FROM ${S}.get_block_metadata(${args})`)).rows.map((r) => r.k);
      const m11 = ['11 {"height": "11"} {"round": 0} {"hash": "AB11"}'];
      assert.deepEqual(await meta("11"), m11);
      assert.deepEqual(await meta("hash => 'AB11'"), m11);
      // with 0x (any case) and spaces around it
      assert.deepEqual(await meta("hash => '0xab11'"), m11);
      assert.deepEqual(await meta("hash => ' 0XAB11 '"), m11);
      assert.deepEqual(await at("hash => '0xAB11'"), ["mact 7", "upokt 1005"]);
      assert.deepEqual(await meta("12"), []);
      for (const [fn, args] of [["get_block_supplies", "11, 'AB11'"], ["get_block_metadata", ""]] as const) {
        await c.query("SAVEPOINT e");
        await assert.rejects(c.query(`SELECT * FROM ${S}.${fn}(${args})`), /pass height or hash \(exactly one\)/, fn);
        await c.query("ROLLBACK TO SAVEPOINT e");
      }
      // each denomination in its own unit: not the upokt note of the other state functions
      const d = await c.query(`SELECT obj_description('${S}.get_block_supplies(bigint, text)'::regprocedure, 'pg_proc') d`);
      assert.match(String(d.rows[0].d), /^@simpleCollections only\nSupply at a block/);
      assert.doesNotMatch(String(d.rows[0].d), /Amounts in upokt/);
      await c.query("SAVEPOINT e");
      await assert.rejects(c.query(`SELECT * FROM ${S}.get_block_supplies(NULL)`), /pass height or hash \(exactly one\)/);
      await c.query("ROLLBACK TO SAVEPOINT e");
    } finally {
      await c.query("ROLLBACK");
    }
  });

  it("get_staked_supplier_services lists the live configs of Staked suppliers and pages by keyset", async () => {
    await c.query("BEGIN");
    try {
      // s1 Staked with two live configs and a closed one; s2 Unstaked (its live config must not show); s3 Staked
      await c.query(`
        CREATE TABLE ${S}.suppliers (id text, owner_id text, stake_status text, stake_amount numeric, _block_range int8range);
        INSERT INTO ${S}.suppliers VALUES ('s1', 'own-a', 'Staked', 300, int8range(5, NULL)), ('s1', 'own-x', 'Staked', 100, int8range(1, 5)),
          ('s2', 'own-a', 'Unstaked', 0, int8range(1, NULL)), ('s3', 'own-b', 'Staked', 500, int8range(1, NULL));
        CREATE TABLE ${S}.supplier_service_configs (supplier_id text, service_id text, domains jsonb, activated_at_id numeric,
          _block_range int8range);
        INSERT INTO ${S}.supplier_service_configs VALUES
          ('s1', 'svc-x', '["a.net"]', 10, int8range(1, NULL)), ('s1', 'svc-y', '["a.net", "b.io"]', 12, int8range(1, NULL)),
          ('s1', 'svc-z', '["c.org"]', 3, int8range(1, 4)), ('s2', 'svc-x', '["a.net"]', 2, int8range(1, NULL)),
          ('s3', 'svc-x', 'null', 7, int8range(1, NULL));`);
      const got = async (args: string) =>
        (
          await c.query(
            `SELECT concat_ws(' ', supplier_id, service_id, owner_id, stake_upokt, array_to_string(domains, ','), activated_at_height) k
             FROM ${S}.get_staked_supplier_services(${args})`
          )
        ).rows.map((r) => String(r.k));
      const all = ["s1 svc-x own-a 300 a.net 10", "s1 svc-y own-a 300 a.net,b.io 12", "s3 svc-x own-b 500  7"];
      assert.deepEqual(await got(""), all);
      assert.deepEqual(await got("services => ARRAY['svc-x']"), [all[0], all[2]]);
      const paged: string[] = [];
      let page = await got("row_limit => 1");
      paged.push(...page);
      while (page.length === 1) {
        const [sup, svc] = page[0].split(" ");
        page = await got(`row_limit => 1, after_supplier_id => '${sup}', after_service_id => '${svc}'`);
        paged.push(...page);
      }
      assert.deepEqual(paged, all);
      for (const [args, err] of [
        ["row_limit => 0", /row_limit must be between 1 and 1000/],
        ["after_supplier_id => 's1'", /pass both after_supplier_id and after_service_id/],
        ["services => ARRAY[]::text[]", /services must have between 1 and 200 elements/],
      ] as const) {
        await c.query("SAVEPOINT e");
        await assert.rejects(c.query(`SELECT * FROM ${S}.get_staked_supplier_services(${args})`), err);
        await c.query("ROLLBACK TO SAVEPOINT e");
      }
      // per (domain, service): each config once per distinct domain (s3's svc-y repeats a.net), none for no domain, the
      // same counts as get_staked_supplier_services regrouped, and the totals on every row
      await c.query(`INSERT INTO ${S}.supplier_service_configs VALUES ('s3', 'svc-y', '["a.net", "a.net"]', 8, int8range(1, NULL))`);
      const groups = async (args: string) =>
        (
          await c.query(`SELECT concat_ws(' ', domain, service_id, configs, total_configs, total_suppliers) k
                         FROM ${S}.get_staked_domain_services(${args})`)
        ).rows.map((r) => String(r.k));
      // s3's svc-x config has no domain: counted under domain '' (first in the order)
      const want = [" svc-x 1 4 2", "a.net svc-x 1 4 2", "a.net svc-y 2 4 2", "b.io svc-y 1 4 2"];
      assert.deepEqual(await groups(""), want);
      const regrouped = await c.query(`SELECT concat_ws(' ', d, service_id, count(*)) k FROM (
          SELECT DISTINCT r.supplier_id, r.service_id, d FROM ${S}.get_staked_supplier_services() r, unnest(r.domains) d) x
        GROUP BY d, service_id ORDER BY d, service_id`);
      assert.deepEqual(regrouped.rows.map((r) => `${r.k} 4 2`), want.slice(1));
      // every config is on some row: the configs of the rows add up to at least total_configs
      const sums = await c.query(`SELECT sum(configs)::int s, max(total_configs)::int t FROM ${S}.get_staked_domain_services()`);
      assert.ok(sums.rows[0].s >= sums.rows[0].t, JSON.stringify(sums.rows[0]));
      const pagedGroups: string[] = [];
      let gpage = await groups("row_limit => 1");
      pagedGroups.push(...gpage);
      while (gpage.length === 1) {
        const [dom, svc] = gpage[0].split(" ");
        gpage = await groups(`row_limit => 1, after_domain => '${dom}', after_service_id => '${svc}'`);
        pagedGroups.push(...gpage);
      }
      // the totals on the first page only
      assert.deepEqual(pagedGroups, [want[0], ...want.slice(1).map((w) => w.split(" ").slice(0, 3).join(" "))]);
      for (const [args, err] of [
        ["row_limit => 1001", /row_limit must be between 1 and 1000/],
        ["after_domain => 'a.net'", /pass both after_domain and after_service_id/],
      ] as const) {
        await c.query("SAVEPOINT e");
        await assert.rejects(c.query(`SELECT * FROM ${S}.get_staked_domain_services(${args})`), err);
        await c.query("ROLLBACK TO SAVEPOINT e");
      }
      // the Staked suppliers one by one, s5 with no live config (empty arrays), s2 Unstaked left out
      await c.query(`
        ALTER TABLE ${S}.suppliers ADD COLUMN operator_id text;
        UPDATE ${S}.suppliers SET operator_id = 'op-' || id;
        CREATE TABLE ${S}._metadata (key varchar, value jsonb);
        INSERT INTO ${S}._metadata VALUES ('lastProcessedHeight', '100');
        INSERT INTO ${S}.suppliers VALUES ('s5', 'own-c', 'Staked', 70, int8range(1, NULL), 'op-s5');`);
      const staked = async (args: string) =>
        (
          await c.query(`SELECT concat_ws(' ', supplier_id, owner_id, operator_id, stake_upokt, array_to_string(service_ids, ','),
                           array_to_string(domains, ','), cardinality(service_ids), cardinality(domains)) k
                         FROM ${S}.get_staked_suppliers(${args})`)
        ).rows.map((r) => String(r.k));
      const sup = ["s1 own-a op-s1 300 svc-x,svc-y a.net,b.io 2 2", "s3 own-b op-s3 500 svc-x,svc-y a.net 2 1", "s5 own-c op-s5 70   0 0"];
      assert.deepEqual(await staked(""), sup);
      assert.deepEqual(await staked("row_limit => 2, after_supplier_id => 's1'"), sup.slice(1));
      // at a height: the versions in force then (s1 owned by own-x with 100 staked and svc-z live at 3), and the height
      // on every row, lastProcessedHeight without at_height
      const at3 = await staked("at_height => 3");
      assert.deepEqual(at3[0], "s1 own-x op-s1 100 svc-x,svc-y,svc-z a.net,b.io,c.org 3 3");
      const heights = async (args: string) =>
        (await c.query(`SELECT DISTINCT height::text h FROM ${S}.get_staked_suppliers(${args})`)).rows.map((r) => r.h);
      assert.deepEqual(await heights(""), ["100"]);
      assert.deepEqual(await heights("at_height => 3"), ["3"]);
      // other statuses: s2 (Unstaked) keeps a live config; s6 has none, so the configs closed at its last closing (9)
      await c.query(`INSERT INTO ${S}.suppliers VALUES ('s6', 'own-d', 'Unstaked', 0, int8range(1, NULL), 'op-s6');
        INSERT INTO ${S}.supplier_service_configs VALUES ('s6', 'svc-a', '["x.io"]', 2, int8range(2, 9)),
          ('s6', 'svc-b', '["y.io"]', 2, int8range(2, 5));`);
      assert.deepEqual(await staked("stake_statuses => ARRAY['Unstaked']"), ["s2 own-a op-s2 0 svc-x a.net 1 1", "s6 own-d op-s6 0 svc-a x.io 1 1"]);
      assert.deepEqual(await staked("stake_statuses => ARRAY['Staked', 'Unstaked'], row_limit => 2"), [sup[0], "s2 own-a op-s2 0 svc-x a.net 1 1"]);
      // a Staked supplier with no live config gets empty arrays, not its closed configs, whatever else is asked for
      await c.query(`INSERT INTO ${S}.supplier_service_configs VALUES ('s5', 'svc-q', '["q.io"]', 1, int8range(1, 3))`);
      assert.deepEqual(await staked("stake_statuses => ARRAY['Staked', 'Unstaked'], after_supplier_id => 's3'"),
        ["s5 own-c op-s5 70   0 0", "s6 own-d op-s6 0 svc-a x.io 1 1"]);
      // other statuses at a height: s6's configs in force then (both at 4), else those closed at its last closing up to
      // the height (svc-a at 9, before svc-c, live 10 to 12, closed after it), and the height on every row
      await c.query(`INSERT INTO ${S}.supplier_service_configs VALUES ('s6', 'svc-c', '["z.io"]', 2, int8range(10, 12))`);
      const s6 = "stake_statuses => ARRAY['Unstaked'], after_supplier_id => 's5'";
      assert.deepEqual(await staked(`${s6}, at_height => 4`), ["s6 own-d op-s6 0 svc-a,svc-b x.io,y.io 2 2"]);
      assert.deepEqual(await staked(`${s6}, at_height => 9`), ["s6 own-d op-s6 0 svc-a x.io 1 1"]);
      assert.deepEqual(await staked(`${s6}, at_height => 11`), ["s6 own-d op-s6 0 svc-c z.io 1 1"]);
      assert.deepEqual(await staked(s6), ["s6 own-d op-s6 0 svc-c z.io 1 1"]);
      assert.deepEqual(await heights(`${s6}, at_height => 9`), ["9"]);
      await c.query("SAVEPOINT e");
      await assert.rejects(c.query(`SELECT * FROM ${S}.get_staked_suppliers(stake_statuses => ARRAY['Bonded'])`), /stake_statuses takes Staked/);
      await c.query("ROLLBACK TO SAVEPOINT e");
      await c.query("SAVEPOINT e");
      await assert.rejects(c.query(`SELECT * FROM ${S}.get_staked_suppliers(row_limit => 0)`), /row_limit must be between 1 and 1000/);
      await c.query("ROLLBACK TO SAVEPOINT e");
    } finally {
      await c.query("ROLLBACK");
    }
    const d = await c.query(
      `SELECT obj_description(p.oid, 'pg_proc') d FROM pg_proc p WHERE p.pronamespace = $1::regnamespace AND p.proname = 'get_staked_supplier_services'`,
      [S]
    );
    assert.match(String(d.rows[0].d), /^@simpleCollections only\nLive service configs[\s\S]*pass the last row's keys as after_\*/);
  });

  it("supplier_rev_share_wallets: the startup DDL reruns as the indexer's role, which owns the tables", async () => {
    // the text itself is frozen against the one created by hand in prod (suppliers.spec.ts)
    await c.query("BEGIN");
    try {
      await c.query(`CREATE ROLE rsw_indexer_ci NOSUPERUSER; CREATE SCHEMA rsw_ci AUTHORIZATION rsw_indexer_ci; SET LOCAL ROLE rsw_indexer_ci;`);
      await c.query(createSupplierRevShareWalletsFn("rsw_ci"));
      await c.query(createSupplierRevShareWalletsFn("rsw_ci"));
      const owners = await c.query(`SELECT c.relname, pg_get_userbyid(c.relowner) o, obj_description(c.oid, 'pg_class') d
        FROM pg_class c WHERE c.relnamespace = 'rsw_ci'::regnamespace AND c.relkind = 'r' ORDER BY 1`);
      assert.deepEqual(owners.rows.map((r) => `${r.relname} ${r.o} ${r.d}`), [
        "supplier_rev_share_wallets rsw_indexer_ci @omit",
        "supplier_rev_share_wallets_coverage rsw_indexer_ci @omit",
      ]);
    } finally {
      await c.query("ROLLBACK");
    }
  });

  it("supplier_rev_share_wallets: a reindex from a height drops the pairs the replayed blocks no longer write", async () => {
    await c.query("BEGIN");
    try {
      await c.query(`CREATE SCHEMA rsw_rw; ${createSupplierRevShareWalletsFn("rsw_rw")}`);
      // the indexer's statements, as src/mappings/pocket/rev_share_wallets.ts sends them: a block that does not follow
      // the last one starts with the rewind; a block that writes configs then inserts their pairs
      let last: number | undefined;
      let rewinds: Array<number> = [];
      const block = async (h: number, pairs: Array<[string, string]>) => {
        if (rewindNeeded(last, h)) {
          rewinds.push(h);
          await c.query(rewindRevShareWalletsSql("rsw_rw"), [h]);
        }
        last = h;
        if (pairs.length > 0) await c.query(insertRevShareWalletsSql("rsw_rw"), [pairs.map((p) => p[0]), pairs.map((p) => p[1]), h]);
      };
      const rows = async () =>
        (await c.query(`SELECT wallet_address || ' ' || supplier_id || ' ' || first_seen_height k FROM rsw_rw.supplier_rev_share_wallets ORDER BY 1`))
          .rows.map((r) => String(r.k));
      // the first run, every block from 10 to 16: pairs at 10, 12 and 15; a pair seen again keeps its first height
      for (let h = 10; h <= 16; h++) {
        await block(h, h === 10 ? [["a", "s1"]] : h === 12 ? [["b", "s1"], ["c", "s2"], ["a", "s1"]] : h === 15 ? [["d", "s3"]] : []);
      }
      assert.deepEqual(await rows(), ["a s1 10", "b s1 12", "c s2 12", "d s3 15"]);
      // consecutive blocks rewind nothing: only the first block of the run did
      assert.deepEqual(rewinds, [10]);
      rewinds = [];
      // rewound to 11 and replayed from 12 by code that no longer writes c for s2: 12 does not follow 16, so it runs the
      // rewind first, at the height of the pair to drop (a rewind of "above" would keep it); 13..16 follow and do not
      for (let h = 12; h <= 16; h++) await block(h, h === 12 ? [["b", "s1"]] : h === 15 ? [["d", "s3"]] : []);
      assert.deepEqual(await rows(), ["a s1 10", "b s1 12", "d s3 15"]);
      assert.deepEqual(rewinds, [12]);
    } finally {
      await c.query("ROLLBACK");
    }
  });

  // scripts/*_rev_share_wallets.sql as the runbook runs them: psql (the CI image has postgresql-client and scripts/) in its
  // own session, so over a schema the test commits, not one inside c's transaction
  const psqlScript = (script: string, schema: string, vars: Array<string> = []) =>
    new Promise<{ code: number | null; stderr: string; stdout: string }>((resolve, reject) => {
      const args = [URL as string, "-X", "-q", "-v", "ON_ERROR_STOP=1", "-v", `schema=${schema}`, ...vars.flatMap((v) => ["-v", v])];
      const p = spawn("psql", [...args, "-f", path.join(__dirname, "..", "..", "scripts", script)]);
      let stderr = "";
      let stdout = "";
      p.stderr.on("data", (d) => (stderr += String(d)));
      p.stdout.on("data", (d) => (stdout += String(d)));
      p.on("error", reject);
      p.on("close", (code) => resolve({ code, stderr, stdout }));
    });
  const rswSchema = async (schema: string, configs: string) => {
    await c.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE; CREATE SCHEMA ${schema}; ${createSupplierRevShareWalletsFn(schema)}
      CREATE TABLE ${schema}.supplier_service_configs (supplier_id text, service_id text, rev_share jsonb, _block_range int8range);
      INSERT INTO ${schema}.supplier_service_configs VALUES ${configs};`);
  };
  const rswRows = async (schema: string) =>
    (await c.query(`SELECT wallet_address || ' ' || supplier_id || ' ' || first_seen_height k FROM ${schema}.supplier_rev_share_wallets ORDER BY 1`))
      .rows.map((r) => String(r.k));

  it("supplier_rev_share_wallets: a live backfill batch waits for a block's uncommitted pairs, retries, and does not deadlock", async () => {
    const holder = new Client({ connectionString: URL });
    await holder.connect();
    try {
      // 4 suppliers in batches of 2: two ranges, the first and the last open
      await rswSchema("rsw_bf", `('s0', 'svc', '[{"address": "w0"}]', int8range(10, 20)), ('s1', 'svc', '[{"address": "w1"}]', int8range(20, NULL)),
        ('s2', 'svc', '[{"address": "w2"}]', int8range(30, NULL)), ('s3', 'svc', '[{"address": "w3"}]', int8range(40, NULL)),
        ('s3', 'svc', '[{"address": "w9"}]', 'empty'::int8range)`);
      // a block at 50 writes s1's and s0's pairs, given out of order, and has not committed
      await holder.query("BEGIN");
      await holder.query(insertRevShareWalletsSql("rsw_bf"), [["w1", "w0"], ["s1", "s0"], 50]);
      // the block took its row locks in key order, as the batches do: inserted, and so locked, w0 before w1
      const order = await holder.query(`SELECT wallet_address FROM rsw_bf.supplier_rev_share_wallets ORDER BY ctid`);
      assert.deepEqual(order.rows.map((r) => r.wallet_address), ["w0", "w1"]);
      const run = psqlScript("backfill_rev_share_wallets.sql", "rsw_bf", ["batch_size=2"]);
      // the first batch (s0, s1) waits on the block's w0 until lock_timeout (2 s), rolls back, and retries
      await new Promise((r) => setTimeout(r, 2600));
      await holder.query("COMMIT");
      const { code, stderr } = await run;
      assert.equal(code, 0, stderr);
      assert.match(stderr, /batch 1\/2 attempt 1: canceling statement due to lock timeout, retrying in 1 s/);
      assert.match(stderr, /batch 1\/2: 2 pairs inserted or lowered \(attempt [2-9]\)/);
      assert.match(stderr, /batch 2\/2: 2 pairs inserted or lowered \(attempt 1\)/);
      assert.doesNotMatch(stderr, /deadlock/);
      // the block's pairs are lowered to the configs' first heights; the empty version adds nothing
      assert.deepEqual(await rswRows("rsw_bf"), ["w0 s0 10", "w1 s1 20", "w2 s2 30", "w3 s3 40"]);
      // a second run changes nothing
      const again = await psqlScript("backfill_rev_share_wallets.sql", "rsw_bf", ["batch_size=2"]);
      assert.equal(again.code, 0, again.stderr);
      assert.equal((again.stderr.match(/: 0 pairs inserted or lowered \(attempt 1\)/g) ?? []).length, 2, again.stderr);
    } finally {
      await holder.query("ROLLBACK").catch(() => undefined);
      await holder.end();
      await c.query("DROP SCHEMA IF EXISTS rsw_bf CASCADE");
    }
  });

  it("supplier_rev_share_wallets: the coverage mark refuses while a pair is missing or extra, and writes nothing", async () => {
    try {
      await rswSchema("rsw_cov", `('s1', 'svc', '[{"address": "w1"}, {"address": "w2"}]', int8range(10, NULL))`);
      const covered = async () => Number((await c.query(`SELECT count(*) n FROM rsw_cov.supplier_rev_share_wallets_coverage`)).rows[0].n);
      // w2 missing, and an extra pair no config version lists (a rewind racing a backfill batch)
      await c.query(`INSERT INTO rsw_cov.supplier_rev_share_wallets VALUES ('w1', 's1', 10), ('w8', 's1', 12)`);
      let r = await psqlScript("set_rev_share_wallets_coverage.sql", "rsw_cov");
      assert.notEqual(r.code, 0);
      assert.match(r.stderr, /supplier_rev_share_wallets is not complete: 1 pairs missing .*, 1 extra/);
      assert.equal(await covered(), 0);
      // extra alone still refuses
      await c.query(`INSERT INTO rsw_cov.supplier_rev_share_wallets VALUES ('w2', 's1', 10)`);
      r = await psqlScript("set_rev_share_wallets_coverage.sql", "rsw_cov");
      assert.notEqual(r.code, 0);
      assert.match(r.stderr, /supplier_rev_share_wallets is not complete: 0 pairs missing .*, 1 extra/);
      assert.equal(await covered(), 0);
      // complete: marked, and a second run keeps the first row
      await c.query(`DELETE FROM rsw_cov.supplier_rev_share_wallets WHERE wallet_address = 'w8'`);
      r = await psqlScript("set_rev_share_wallets_coverage.sql", "rsw_cov");
      assert.equal(r.code, 0, r.stderr);
      const first = (await c.query(`SELECT backfilled_at FROM rsw_cov.supplier_rev_share_wallets_coverage`)).rows;
      assert.equal(first.length, 1);
      r = await psqlScript("set_rev_share_wallets_coverage.sql", "rsw_cov");
      assert.equal(r.code, 0, r.stderr);
      assert.deepEqual((await c.query(`SELECT backfilled_at FROM rsw_cov.supplier_rev_share_wallets_coverage`)).rows, first);
    } finally {
      await c.query("DROP SCHEMA IF EXISTS rsw_cov CASCADE");
    }
  });

  it("get_supplier_config_history compresses a supplier's config versions to their changes of content", async () => {
    await c.query("BEGIN");
    try {
      // kava: mainnet's pokt14psq…scsn8l-kava, 12 versions (restakes and activations repeat the content) and an unstake
      // gap from 120893 to 135840; eth: a reordered rev_share (no change) and then new percentages; an empty range
      const rs = (...e: Array<[string, number]>) =>
        `'${JSON.stringify(e.map(([address, pct]) => ({ address, revSharePercentage: String(pct) })))}'`;
      const ep = (url: string) => `'${JSON.stringify([{ url: `https://${url}`, rpcType: 3, configs: [] }])}'`;
      const kava = (lo: number, hi: number, r: string, url: string) =>
        `('sk', 'kava', ${r}, ${ep(url)}, '["${url}"]', int8range(${lo}, ${hi}))`;
      const z = rs(["w-z", 100]);
      const three = rs(["w-s", 5], ["w-q", 65], ["w-z", 30]);
      await c.query(`
        CREATE TABLE ${S}.supplier_service_configs (supplier_id text, service_id text, rev_share jsonb, endpoints jsonb,
          domains jsonb, _block_range int8range);
        INSERT INTO ${S}.supplier_service_configs VALUES
          ${kava(96805, 96806, z, "t.net")}, ${kava(96806, 98629, z, "t.net")},
          ${kava(98629, 98631, z, "m.net")}, ${kava(98631, 99038, z, "m.net")},
          ${kava(99038, 99041, z, "n.net")}, ${kava(99041, 115311, z, "n.net")},
          ${kava(115311, 115321, three, "n.net")}, ${kava(115321, 115326, three, "n.net")},
          ${kava(115326, 115331, three, "n.net")}, ${kava(115331, 120893, three, "n.net")},
          ${kava(135841, 135851, three, "e.net")}, ${kava(135851, 164482, three, "e.net")},
          ('sk', 'eth', ${rs(["w-a", 50], ["w-b", 50])}, ${ep("x.io")}, '["x.io"]', int8range(100, 200)),
          ('sk', 'eth', ${rs(["w-b", 50], ["w-a", 50])}, ${ep("x.io")}, '["x.io"]', int8range(200, 300)),
          ('sk', 'eth', ${rs(["w-a", 40], ["w-b", 60])}, ${ep("x.io")}, '["x.io"]', int8range(300, NULL)),
          ('sk', 'eth', ${rs(["w-c", 100])}, ${ep("y.io")}, '["y.io"]', int8range(250, 250)),
          ('other', 'kava', ${z}, ${ep("t.net")}, '["t.net"]', int8range(1, NULL));`);
      const history = async (args: string) =>
        (
          await c.query(`SELECT concat_ws(' ', service_id, first_height, coalesce(last_height::text, '-'),
                           (SELECT string_agg((x->>'address') || ':' || (x->>'revSharePercentage'), ',' ORDER BY i)
                            FROM jsonb_array_elements(rev_share) WITH ORDINALITY a(x, i)),
                           endpoints->0->>'url', array_to_string(domains, ',')) k
                         FROM ${S}.get_supplier_config_history(${args})`)
        ).rows.map((r) => String(r.k));
      const all = [
        "eth 100 299 w-a:50,w-b:50 https://x.io x.io",
        "eth 300 - w-a:40,w-b:60 https://x.io x.io",
        "kava 96805 98628 w-z:100 https://t.net t.net",
        "kava 98629 99037 w-z:100 https://m.net m.net",
        "kava 99038 115310 w-z:100 https://n.net n.net",
        // sorted by address: the chain's order (w-s, w-q, w-z) is not kept
        "kava 115311 120892 w-q:65,w-s:5,w-z:30 https://n.net n.net",
        "kava 135841 164481 w-q:65,w-s:5,w-z:30 https://e.net e.net",
      ];
      assert.deepEqual(await history("'sk'"), all);
      assert.deepEqual(await history("'sk', services => ARRAY['kava']"), all.slice(2));
      assert.deepEqual(await history("'sk', row_limit => 3"), all.slice(0, 3));
      assert.deepEqual(await history("'sk', row_limit => 3, after_service_id => 'kava', after_first_height => 96805"), all.slice(3, 6));
      assert.deepEqual(await history("'nobody'"), []);
      for (const [args, err] of [
        ["NULL", /supplier_id is required/],
        ["'sk', row_limit => 1001", /row_limit must be between 1 and 1000/],
        ["'sk', after_service_id => 'kava'", /pass both after_service_id and after_first_height/],
      ] as const) {
        await c.query("SAVEPOINT e");
        await assert.rejects(c.query(`SELECT * FROM ${S}.get_supplier_config_history(${args})`), err);
        await c.query("ROLLBACK TO SAVEPOINT e");
      }
    } finally {
      await c.query("ROLLBACK");
    }
    const d = await c.query(
      `SELECT obj_description(p.oid, 'pg_proc') d FROM pg_proc p WHERE p.pronamespace = $1::regnamespace AND p.proname = 'get_supplier_config_history'`,
      [S]
    );
    assert.match(String(d.rows[0].d), /^@simpleCollections only\nService configs of one supplier over time[\s\S]*pass the last row's keys as after_\*/);
  });

  it("get_gateway_fleet and get_gateway_delegations read gateways and their delegations now and at a height", async () => {
    await c.query("BEGIN");
    try {
      // g1 staked at 10 (stake 100, then 150 from 50); g2 staked at 30, Unstaked at 60; g3 staked at 70 with no delegation.
      // a1 delegates to g1 from 10, a2 from 20 to 40 then to g2 from 40; a3 to g1 from 45. a1 restaked at 50 (20 -> 25)
      // and changed services at 50 (svc-x, svc-y -> svc-x).
      await c.query(`
        CREATE TABLE ${S}.gateways (id text, stake_amount numeric, stake_status text, _block_range int8range);
        INSERT INTO ${S}.gateways VALUES ('g1', 100, 'Staked', int8range(10, 50)), ('g1', 150, 'Staked', int8range(50, NULL)),
          ('g2', 70, 'Staked', int8range(30, 60)), ('g2', 70, 'Unstaked', int8range(60, NULL)),
          ('g3', 90, 'Staked', int8range(70, NULL));
        INSERT INTO ${S}.application_gateways (gateway_id, application_id, _block_range) VALUES ('g1', 'a1', int8range(10, NULL)),
          ('g1', 'a2', int8range(20, 40)), ('g2', 'a2', int8range(40, NULL)), ('g1', 'a3', int8range(45, NULL));
        CREATE TABLE ${S}.applications (id text, account_id text, stake_amount numeric, stake_status text, _block_range int8range);
        INSERT INTO ${S}.applications VALUES ('a1', 'a1', 20, 'Staked', int8range(5, 50)), ('a1', 'a1', 25, 'Staked', int8range(50, NULL)),
          ('a2', 'a2', 30, 'Staked', int8range(15, 55)), ('a2', 'a2', 30, 'Unstaking', int8range(55, NULL)),
          ('a3', 'a3', 40, 'Staked', int8range(45, NULL));
        CREATE TABLE ${S}.application_services (application_id text, service_id text, _block_range int8range);
        INSERT INTO ${S}.application_services VALUES ('a1', 'svc-y', int8range(5, 50)), ('a1', 'svc-x', int8range(5, NULL)),
          ('a2', 'svc-z', int8range(15, NULL)), ('a3', 'svc-x', int8range(45, NULL));
        CREATE TABLE ${S}.msg_delegate_to_gateways (id text, application_id text, gateway_id text, block_id numeric);
        CREATE TABLE ${S}.msg_undelegate_from_gateways (LIKE ${S}.msg_delegate_to_gateways);
        INSERT INTO ${S}.msg_delegate_to_gateways VALUES ('d1', 'a1', 'g1', 10), ('d2', 'a2', 'g1', 20), ('d3', 'a2', 'g2', 40),
          ('d4', 'a3', 'g1', 45), ('d5', 'a3', 'g1', 46);
        INSERT INTO ${S}.msg_undelegate_from_gateways VALUES ('u1', 'a2', 'g1', 40);
        CREATE TABLE ${S}._metadata (key varchar, value jsonb);
        INSERT INTO ${S}._metadata VALUES ('lastProcessedHeight', '100'), ('targetHeight', '101');`);
      const rows = async (sql: string) => (await c.query(sql)).rows.map((r) => Object.values(r).join(" "));
      const fleet = (args: string) =>
        rows(`SELECT gateway_id, stake_status, stake_upokt::text, delegated_applications::text, delegations_ever::text,
                     undelegations_ever::text, gateway_count::text FROM ${S}.get_gateway_fleet(${args})`);
      for (const [args, want] of [
        ["", ["g1 Staked 150 2 4 1 1", "g3 Staked 90 0 0 0 1", "g2 Unstaked 70 1 1 0 1"]],
        ["gateways => ARRAY['g2', 'none']", ["g2 Unstaked 70 1 1 0 1"]],
        ["stake_statuses => ARRAY['Staked'], by_gateway => false", ["all all 240 2 4 1 2"]],
        ["gateways => ARRAY['none'], by_gateway => false", ["all all 0 0 0 0 0"]],
      ] as const)
        assert.deepEqual([args, await fleet(args)], [args, want]);
      const delegations = (args: string) =>
        rows(`SELECT gateway_id, gateway_stake_upokt::text, gateway_stake_status, application_id, stake_upokt::text, stake_status,
                     array_to_string(service_ids, ',') FROM ${S}.get_gateway_delegations(${args})`);
      const now = ["g1 150 Staked a1 25 Staked svc-x", "g1 150 Staked a3 40 Staked svc-x", "g2 70 Unstaked a2 30 Unstaking svc-z",
        "g3 90 Staked    "];
      for (const [args, want] of [
        ["ARRAY['g3', 'g2', 'g1']", now],
        ["ARRAY['g1', 'g2', 'g3'], at_height => 30", ["g1 100 Staked a1 20 Staked svc-x,svc-y", "g1 100 Staked a2 30 Staked svc-z",
          "g2 70 Staked    "]],
        ["ARRAY['g2'], at_height => 45", ["g2 70 Staked a2 30 Staked svc-z"]],
        ["ARRAY['g3'], at_height => 30", []],
      ] as const)
        assert.deepEqual([args, await delegations(args)], [args, want]);
      // pages of one row: the keys of the last row, application_id NULL for a gateway with no delegation
      const paged: string[] = [];
      let page = await delegations("ARRAY['g1', 'g2', 'g3'], row_limit => 1");
      paged.push(...page);
      while (page.length === 1) {
        const [g, , , app] = page[0].split(" ");
        page = await delegations(`ARRAY['g1', 'g2', 'g3'], row_limit => 1, after_gateway_id => '${g}', after_application_id => ${app ? `'${app}'` : "NULL"}`);
        paged.push(...page);
      }
      assert.deepEqual(paged, now);
      assert.deepEqual(await delegations("ARRAY['g1', 'g2', 'g3'], after_gateway_id => 'g2'"), [now[3]]);
      // the height read: lastProcessedHeight without at_height, else at_height; NULL at_height reads that height
      const heights = async (args: string) =>
        (await c.query(`SELECT DISTINCT height::text h FROM ${S}.get_gateway_delegations(${args})`)).rows.map((r) => r.h);
      assert.deepEqual(await heights("ARRAY['g1', 'g2']"), ["100"]);
      assert.deepEqual(await heights("ARRAY['g1', 'g2'], at_height => 30"), ["30"]);
      await c.query(`UPDATE ${S}._metadata SET value = '45' WHERE key = 'lastProcessedHeight'`);
      assert.deepEqual(await delegations("ARRAY['g2']"), ["g2 70 Staked a2 30 Staked svc-z"]);
      for (const [fn, args, err] of [
        ["get_gateway_delegations", "NULL", /gateways must have between 1 and 200 elements/],
        ["get_gateway_delegations", "ARRAY['g1'], row_limit => 1001", /row_limit must be between 1 and 1000/],
        ["get_gateway_delegations", "ARRAY['g1'], after_application_id => 'a1'", /after_application_id goes with after_gateway_id/],
        ["get_gateway_delegations", "ARRAY['g1'], at_height => 0", /at_height must be a block height/],
        ["get_gateway_fleet", "stake_statuses => ARRAY['Bonded']", /stake_statuses takes Staked, Unstaking and Unstaked/],
        ["get_gateway_fleet", "gateways => ARRAY[]::text[]", /gateways must have between 1 and 200 elements/],
      ] as const) {
        await c.query("SAVEPOINT e");
        await assert.rejects(c.query(`SELECT * FROM ${S}.${fn}(${args})`), err, `${fn}(${args})`);
        await c.query("ROLLBACK TO SAVEPOINT e");
      }
    } finally {
      await c.query("ROLLBACK");
    }
    const d = await c.query(
      `SELECT p.proname, obj_description(p.oid, 'pg_proc') d FROM pg_proc p
       WHERE p.pronamespace = $1::regnamespace AND p.proname IN ('get_gateway_fleet', 'get_gateway_delegations') ORDER BY 1`,
      [S]
    );
    assert.match(String(d.rows[0].d), /^@simpleCollections only\nGateways and the applications[\s\S]*pass the last row's keys as after_\*/);
    assert.match(String(d.rows[1].d), /^@simpleCollections only\nGateways now[\s\S]*paged by GraphQL \(first \/ offset\)/);
  });

  it("get_supplier_fleet, get_service_summary and get_application_fleet read the current versions, per actor or as one fleet row", async () => {
    await c.query("BEGIN");
    try {
      // s1 changed owner (own-b before); s4's only config is closed, s2 has none
      await c.query(`
        CREATE TABLE ${S}.suppliers (id text, owner_id text, stake_status text, stake_amount numeric, _block_range int8range);
        INSERT INTO ${S}.suppliers VALUES ('s1', 'own-b', 'Staked', 300, int8range(1, 5)),
          ('s1', 'own-a', 'Staked', 300, int8range(5, NULL)), ('s2', 'own-a', 'Unstaking', 100, int8range(1, NULL)),
          ('s3', 'own-b', 'Staked', 500, int8range(1, NULL)), ('s4', 'own-b', 'Unstaked', 50, int8range(1, NULL));
        CREATE TABLE ${S}.supplier_service_configs (supplier_id text, service_id text, rev_share jsonb, domains jsonb,
          _block_range int8range);
        INSERT INTO ${S}.supplier_service_configs VALUES
          ('s1', 'svc-x', '[{"address": "op-1"}]', '["a.net"]', int8range(1, NULL)),
          ('s1', 'svc-y', '[{"address": "op-1"}]', '["a.net", "b.io"]', int8range(1, NULL)),
          ('s3', 'svc-x', '[{"address": "op-1"}, {"address": "op-2"}]', '["b.io"]', int8range(1, NULL)),
          ('s4', 'svc-x', '[{"address": "op-1"}]', '["a.net"]', int8range(1, 3));`);
      const fleet = async (args: string) =>
        (
          await c.query(
            `SELECT supplier_id, owner_id, stake_status, stake_upokt::text, service_count::text, supplier_count::text
             FROM ${S}.get_supplier_fleet(${args})`
          )
        ).rows.map((r) => Object.values(r).join(" "));
      for (const [args, want] of [
        ["owners => ARRAY['own-a']", ["s1 own-a Staked 300 2 1", "s2 own-a Unstaking 100 0 1"]],
        ["owners => ARRAY['own-a'], stake_statuses => ARRAY['Staked'], by_supplier => false", ["all  all 300  1"]],
        ["operators => ARRAY['op-1']", ["s3 own-b Staked 500 1 1", "s1 own-a Staked 300 2 1"]],
        // ever: also the suppliers whose configs shared revenue with op-1 before, in any status
        ["operators => ARRAY['op-1'], operator_scope => 'ever'", ["s3 own-b Staked 500 1 1", "s1 own-a Staked 300 2 1", "s4 own-b Unstaked 50 0 1"]],
        ["operators => ARRAY['op-1'], operator_scope => 'ever', stake_statuses => ARRAY['Unstaked']", ["s4 own-b Unstaked 50 0 1"]],
        ["operators => ARRAY['op-2'], operator_scope => 'ever'", ["s3 own-b Staked 500 1 1"]],
        ["domains => ARRAY['a.net']", ["s1 own-a Staked 300 2 1"]],
        ["domains => ARRAY['b.io'], stake_statuses => ARRAY['Staked'], by_supplier => false", ["all  all 800  2"]],
        ["suppliers => ARRAY['s4', 's3']", ["s3 own-b Staked 500 1 1", "s4 own-b Unstaked 50 0 1"]],
        ["by_supplier => false", ["all  all 950  4"]],
        ["stake_statuses => ARRAY['Unstaking', 'Unstaked']", ["s2 own-a Unstaking 100 0 1", "s4 own-b Unstaked 50 0 1"]],
        ["owners => ARRAY['nobody'], by_supplier => false", ["all  all 0  0"]],
        ["owners => ARRAY['nobody']", []],
        ["services => ARRAY['svc-y']", ["s1 own-a Staked 300 2 1"]],
        ["owners => ARRAY['own-b'], services => ARRAY['svc-x']", ["s3 own-b Staked 500 1 1"]],
        // domains with services: one config with both (s1 has b.io on svc-y and svc-x on a.net only)
        ["domains => ARRAY['b.io'], services => ARRAY['svc-x']", ["s3 own-b Staked 500 1 1"]],
        ["domains => ARRAY['a.net'], services => ARRAY['svc-y'], by_supplier => false", ["all  all 300  1"]],
        // a ceiling on the stake, exclusive
        ["max_stake_upokt => 300", ["s2 own-a Unstaking 100 0 1", "s4 own-b Unstaked 50 0 1"]],
        // keyset pages by stake descending, then id
        ["row_limit => 2", ["s3 own-b Staked 500 1 1", "s1 own-a Staked 300 2 1"]],
        ["row_limit => 2, after_stake_upokt => 300, after_supplier_id => 's1'", ["s2 own-a Unstaking 100 0 1", "s4 own-b Unstaked 50 0 1"]],
        ["row_limit => 1, after_stake_upokt => 500, after_supplier_id => 's3', stake_statuses => ARRAY['Staked']", ["s1 own-a Staked 300 2 1"]],
        // row_offset: a page at any depth of the same order
        ["row_limit => 2, row_offset => 1", ["s1 own-a Staked 300 2 1", "s2 own-a Unstaking 100 0 1"]],
        ["row_offset => 3", ["s4 own-b Unstaked 50 0 1"]],
      ] as const)
        assert.deepEqual([args, await fleet(args)], [args, want]);
      // an empty version (created and closed in one block) shares revenue with nobody, on either path
      await c.query(`INSERT INTO ${S}.supplier_service_configs VALUES ('s2', 'svc-z', '[{"address": "op-4"}]', '["z.io"]', 'empty'::int8range)`);
      assert.deepEqual(await fleet("operators => ARRAY['op-4'], operator_scope => 'ever'"), []);
      await c.query(`DELETE FROM ${S}.supplier_service_configs WHERE service_id = 'svc-z'`);
      // once the backfill has filled supplier_rev_share_wallets, ever reads the pairs there and no longer the configs:
      // op-3 is in no config here, only in the table
      await c.query(`
        INSERT INTO ${S}.supplier_rev_share_wallets VALUES ('op-1', 's1', 1), ('op-1', 's3', 1), ('op-1', 's4', 1),
          ('op-2', 's3', 1), ('op-3', 's2', 7);
        INSERT INTO ${S}.supplier_rev_share_wallets_coverage (backfilled_at) VALUES (now());`);
      for (const [args, want] of [
        ["operators => ARRAY['op-1'], operator_scope => 'ever'", ["s3 own-b Staked 500 1 1", "s1 own-a Staked 300 2 1", "s4 own-b Unstaked 50 0 1"]],
        ["operators => ARRAY['op-3'], operator_scope => 'ever'", ["s2 own-a Unstaking 100 0 1"]],
        ["operators => ARRAY['op-2', 'op-3'], operator_scope => 'ever'", ["s3 own-b Staked 500 1 1", "s2 own-a Unstaking 100 0 1"]],
      ] as const)
        assert.deepEqual([args, await fleet(args)], [args, want]);
      await c.query(`DELETE FROM ${S}.supplier_rev_share_wallets; DELETE FROM ${S}.supplier_rev_share_wallets_coverage;`);
      // domain '' = a live config with no domain (get_staked_domain_services' '' row): s2's svc-z ([] domains) and
      // s4's svc-z (NULL); combined with a domain, and with services one config must have both
      await c.query("SAVEPOINT nodomain");
      await c.query(`INSERT INTO ${S}.supplier_service_configs VALUES ('s2', 'svc-z', '[]', '[]', int8range(1, NULL)),
        ('s4', 'svc-z', '[]', NULL, int8range(1, NULL)), ('s1', 'svc-z', '[]', '["a.net"]', int8range(1, NULL))`);
      for (const [args, want] of [
        ["domains => ARRAY['']", ["s2 own-a Unstaking 100 1 1", "s4 own-b Unstaked 50 1 1"]],
        ["domains => ARRAY['', 'b.io']", ["s3 own-b Staked 500 1 1", "s1 own-a Staked 300 3 1", "s2 own-a Unstaking 100 1 1",
          "s4 own-b Unstaked 50 1 1"]],
        ["domains => ARRAY[''], services => ARRAY['svc-z']", ["s2 own-a Unstaking 100 1 1", "s4 own-b Unstaked 50 1 1"]],
        ["domains => ARRAY[''], services => ARRAY['svc-x']", []],
        ["domains => ARRAY['a.net'], services => ARRAY['svc-z']", ["s1 own-a Staked 300 3 1"]],
      ] as const)
        assert.deepEqual([args, await fleet(args)], [args, want]);
      await c.query("ROLLBACK TO SAVEPOINT nodomain");
      // with services, the domains of each supplier's live configs for them
      for (const [args, want] of [
        ["services => ARRAY['svc-y']", ["s1 a.net,b.io"]],
        ["services => ARRAY['svc-x']", ["s3 b.io", "s1 a.net"]],
        ["owners => ARRAY['own-b']", ["s3 ", "s4 "]],
      ] as const)
        assert.deepEqual(
          [args, (await c.query(`SELECT concat_ws(' ', supplier_id, coalesce(array_to_string(service_domains, ','), '')) k
                                 FROM ${S}.get_supplier_fleet(${args})`)).rows.map((r) => r.k)],
          [args, want]
        );
      // domains ranked by what was claimed on them, with the Staked suppliers on each now and their stake
      await c.query(`
        CREATE TABLE ${S}.domain_service_daily_rewards (domain text, service_id text, day date, relays bigint,
          estimated_relays bigint, computed_units bigint, estimated_computed_units bigint, gross_rewards numeric);
        INSERT INTO ${S}.domain_service_daily_rewards VALUES ('a.net', 'svc-x', '2026-03-01', 10, 11, 20, 21, 1000),
          ('a.net', 'svc-y', '2026-03-02', 5, 6, 7, 8, 500), ('b.io', 'svc-x', '2026-03-01', 1, 1, 1, 1, 2000),
          ('c.org', 'svc-x', '2026-03-03', 1, 1, 1, 1, 100);`);
      const domains = async (args: string) =>
        (
          await c.query(
            `SELECT concat_ws(' ', domain, claimed_upokt, relays, estimated_relays, compute_units, estimated_compute_units,
                    first_day::text, last_day::text, staked_suppliers, staked_upokt) k FROM ${S}.get_supplier_domains(${args})`
          )
        ).rows.map((r) => String(r.k));
      const b = "b.io 2000 1 1 1 1 2026-03-01 2026-03-01 2 800";
      for (const [args, want] of [
        ["", [b, "a.net 1500 15 17 27 29 2026-03-01 2026-03-02 1 300", "c.org 100 1 1 1 1 2026-03-03 2026-03-03 0 0"]],
        ["top => 1", [b]],
        ["'2026-03-02T00:00:00Z', '2026-03-04T00:00:00Z'", ["a.net 500 5 6 7 8 2026-03-02 2026-03-02 1 300", "c.org 100 1 1 1 1 2026-03-03 2026-03-03 0 0"]],
      ] as const)
        assert.deepEqual([args, await domains(args)], [args, want]);
      // the Morse accounts to claim, claimed or not, from their current versions
      await c.query(`
        CREATE TABLE ${S}.morse_claimable_accounts (id text, claimed boolean, unstaked_balance_amount numeric,
          supplier_stake_amount numeric, application_stake_amount numeric, _block_range int8range);
        INSERT INTO ${S}.morse_claimable_accounts VALUES ('m1', false, 10, 0, 0, int8range(1, 9)),
          ('m1', true, 10, 0, 0, int8range(9, NULL)), ('m2', false, 100, 50, 0, int8range(1, NULL)),
          ('m3', false, 1, 0, 7, int8range(1, NULL));`);
      assert.deepEqual(
        (await c.query(`SELECT concat_ws(' ', claimed, accounts, unstaked_balance_upokt, supplier_stake_upokt,
                          application_stake_upokt) k FROM ${S}.get_morse_claim_summary()`)).rows.map((r) => r.k),
        ["f 2 101 50 7", "t 1 10 0 0"]
      );
      // per service: suppliers with a live config (Staked ones), applications with a live service row (Staked ones)
      await c.query(`
        CREATE TABLE ${S}.applications (id text, stake_status text, stake_amount numeric, _block_range int8range);
        INSERT INTO ${S}.applications VALUES ('a1', 'Staked', 10, int8range(1, 5)), ('a1', 'Staked', 20, int8range(5, NULL)),
          ('a2', 'Unstaking', 5, int8range(1, NULL)), ('a3', 'Staked', 70, int8range(1, NULL));
        CREATE TABLE ${S}.application_services (application_id text, service_id text, _block_range int8range);
        INSERT INTO ${S}.application_services VALUES ('a1', 'svc-x', int8range(1, NULL)), ('a1', 'svc-z', int8range(1, NULL)),
          ('a2', 'svc-x', int8range(1, NULL)), ('a3', 'svc-x', int8range(1, 4));
        INSERT INTO ${S}.application_gateways (application_id, gateway_id, _block_range) VALUES ('a1', 'g1', int8range(1, NULL)), ('a3', 'g1', int8range(1, NULL)),
          ('a3', 'g2', int8range(1, NULL)), ('a2', 'g2', int8range(1, 3));
        -- the newest update of a service is its difficulty now; svc-y never had one
        CREATE TABLE ${S}.event_relay_mining_difficulty_updateds (service_id text, new_target_hash_hex_encoded text,
          new_num_relays_ema numeric, block_id numeric);
        INSERT INTO ${S}.event_relay_mining_difficulty_updateds VALUES ('svc-x', 'ff', 10, 10), ('svc-x', 'fd', 30, 20),
          ('svc-x', 'fe', 20, 15), ('svc-z', 'aa', 7, 5);
        CREATE TABLE ${S}.services (id text, owner_id text, _block_range int8range);
        -- own-s also owns svc-w, which has no supplier config or application now: a row of zeros
        INSERT INTO ${S}.services VALUES ('svc-x', 'own-s', int8range(1, NULL)), ('svc-z', 'own-s', int8range(1, NULL)),
          ('svc-w', 'own-s', int8range(1, NULL)),
          ('svc-y', 'own-s', int8range(1, 5)), ('svc-y', 'own-t', int8range(5, NULL));`);
      const rows = async (sql: string) => (await c.query(sql)).rows.map((r) => Object.values(r).join(" "));
      for (const [args, want] of [
        // every live service, svc-w (no config or application now) with zeros
        ["", ["svc-w 0 0 0 0   ", "svc-x 2 2 1 2 30 fd 20", "svc-y 1 1 0 0   ", "svc-z 0 0 1 1 7 aa 5"]],
        ["ARRAY['svc-w', 'svc-x']", ["svc-w 0 0 0 0   ", "svc-x 2 2 1 2 30 fd 20"]],
        ["ARRAY['svc-y', 'svc-z', 'none']", ["svc-y 1 1 0 0   ", "svc-z 0 0 1 1 7 aa 5"]],
        // the services an address owns now (svc-y was own-s's before)
        ["owners => ARRAY['own-s']", ["svc-w 0 0 0 0   ", "svc-x 2 2 1 2 30 fd 20", "svc-z 0 0 1 1 7 aa 5"]],
        ["ARRAY['svc-z', 'svc-y'], owners => ARRAY['own-s']", ["svc-z 0 0 1 1 7 aa 5"]],
        ["owners => ARRAY['nobody']", []],
      ] as const)
        assert.deepEqual(
          [args, await rows(`SELECT service_id, staked_suppliers::text, suppliers::text, staked_applications::text,
                               applications::text, num_relays_ema::text, target_hash_hex, difficulty_updated_height::text
                             FROM ${S}.get_service_summary(${args})`)],
          [args, want]
        );
      for (const [args, want] of [
        ["", ["a3 Staked 70 0 2 1", "a1 Staked 20 2 1 1", "a2 Unstaking 5 1 0 1"]],
        ["services => ARRAY['svc-x']", ["a1 Staked 20 2 1 1", "a2 Unstaking 5 1 0 1"]],
        ["gateways => ARRAY['g2']", ["a3 Staked 70 0 2 1"]],
        ["services => ARRAY['svc-x'], gateways => ARRAY['g1']", ["a1 Staked 20 2 1 1"]],
        ["applications => ARRAY['a2', 'a3'], stake_statuses => ARRAY['Staked']", ["a3 Staked 70 0 2 1"]],
        ["stake_statuses => ARRAY['Staked'], by_application => false", ["all all 90   2"]],
        ["applications => ARRAY['none'], by_application => false", ["all all 0   0"]],
        // one page of the order, counted for its own rows
        ["row_limit => 1, row_offset => 1", ["a1 Staked 20 2 1 1"]],
      ] as const)
        assert.deepEqual(
          [args, await rows(`SELECT application_id, stake_status, stake_upokt::text, service_count::text, gateway_count::text,
                               application_count::text FROM ${S}.get_application_fleet(${args})`)],
          [args, want]
        );
      // get_supplier_stats_by_domains, which it replaces, gives the same count and stake
      await c.query(getSupplierStatsByDomainsFn(S));
      for (const d of ["a.net", "b.io"]) {
        const old = (
          await c.query(
            `SELECT j->>'total_staked_tokens' stake, j->>'suppliers_count' n FROM ${S}.get_supplier_stats_by_domains(ARRAY[$1]) j`,
            [d]
          )
        ).rows[0];
        const now = await fleet(`domains => ARRAY['${d}'], stake_statuses => ARRAY['Staked'], by_supplier => false`);
        const [, , , stake, , count] = now[0].split(" ");
        assert.deepEqual([d, stake, count], [d, old.stake, old.n]);
      }
      for (const [args, err] of [
        ["row_limit => 0", /row_limit must be between 1 and 1000, or NULL/],
        ["row_offset => -1", /row_offset must be 0 or more/],
        ["row_limit => 10, after_supplier_id => 's1'", /pass both after_stake_upokt and after_supplier_id/],
        ["after_stake_upokt => 300, after_supplier_id => 's1'", /pass both after_stake_upokt and after_supplier_id/],
        ["owners => ARRAY['own-a'], domains => ARRAY['a.net']", /pass one of suppliers, owners/],
        ["operators => ARRAY['op-1'], operator_scope => 'past'", /operator_scope is now or ever \(has past\)/],
        ["operator_scope => 'ever'", /operator_scope ever applies to operators/],
        ["operators => ARRAY['op-1'], owners => ARRAY['own-a'], operator_scope => 'ever'", /pass one of suppliers, owners/],
        ["operators => ARRAY[]::text[], operator_scope => 'ever'", /operators must have between 1 and 200 elements/],
        ["stake_statuses => ARRAY['Bonded']", /stake_statuses takes Staked, Unstaking and Unstaked/],
        ["domains => ARRAY[]::text[]", /domains must have between 1 and 200 elements/],
      ] as const) {
        await c.query("SAVEPOINT e");
        await assert.rejects(c.query(`SELECT * FROM ${S}.get_supplier_fleet(${args})`), err);
        await c.query("ROLLBACK TO SAVEPOINT e");
      }
    } finally {
      await c.query("ROLLBACK");
    }
    const d = await c.query(
      `SELECT obj_description(p.oid, 'pg_proc') d FROM pg_proc p
       WHERE p.pronamespace = $1::regnamespace AND p.proname = 'get_supplier_fleet'`,
      [S]
    );
    assert.equal(d.rows.length, 1);
    assert.match(String(d.rows[0].d), /^@simpleCollections only\nSupplier fleet now: [\s\S]*\nColumns: TABLE\(supplier_id text, /);
    // exactly the functions that page by keyset say so, and not first / offset
    const k = await c.query(
      `SELECT p.proname FROM pg_proc p WHERE p.pronamespace = $1::regnamespace
         AND obj_description(p.oid, 'pg_proc') ~ 'page with the keys of the last row in before_\\*, not with first / offset'
       ORDER BY 1`,
      [S]
    );
    assert.deepEqual(k.rows.map((r) => r.proname), [
      "get_actor_lifecycle", "get_claims", "get_created_claims", "get_morse_claims", "get_native_transfers",
      "get_relay_mining_difficulty",
    ]);
  });

  it("get_claims lists settled and expired claims newest first through each index walk, and pages by keyset", async () => {
    const counts = (
      await c.query(`SELECT (SELECT count(*) FROM ${S}.claim_settlements)::int s, (SELECT count(*) FROM ${S}.claim_expirations)::int e`)
    ).rows[0];
    assert.ok(Number(counts.s) > 10 && Number(counts.e) > 0, JSON.stringify(counts));
    // the claims by hand: both tables, the range by the settlement's block time
    const want = async (where: string, from: string | null, to: string | null, statuses = ["settled", "expired"]) =>
      (
        await c.query(
          `SELECT t.status || ' ' || t.height || ' ' || t.event_idx || ' ' || t.x k FROM (
             SELECT 'settled' status, c.height, c.event_idx, c.supplier_id, c.application_id, c.service_id, c.settled_upokt::text x
             FROM ${S}.claim_settlements c
             UNION ALL
             SELECT 'expired', e.height, e.event_idx, e.supplier_id, e.application_id, e.service_id, e.reason
             FROM ${S}.claim_expirations e) t
           JOIN ${S}.settlement_blocks sb ON sb.height = t.height
           WHERE (${where}) AND t.status = ANY($3::text[])
             AND ($1::timestamptz IS NULL OR sb.block_time >= $1) AND ($2::timestamptz IS NULL OR sb.block_time < $2)
           ORDER BY t.height DESC, t.event_idx DESC`,
          [from, to, statuses]
        )
      ).rows.map((r) => String(r.k));
    const got = async (args: string, bind: unknown[] = []) =>
      (
        await c.query(
          `SELECT status || ' ' || height || ' ' || event_idx || ' ' || coalesce(settled_upokt::text, expiration_reason) k
           FROM ${S}.get_claims(${args})`,
          bind
        )
      ).rows.map((r) => String(r.k));
    const one = (await c.query(`SELECT supplier_id, application_id, service_id FROM ${S}.claim_expirations LIMIT 1`)).rows[0];
    const sups = (await c.query(`SELECT array_agg(DISTINCT supplier_id) a FROM ${S}.claim_settlements`)).rows[0]
      .a as unknown as string[];
    await c.query("BEGIN");
    try {
      // owner-f owns every supplier and 250 idle ones: more than 200, so its claims come from the walk over the heights
      await c.query(`CREATE TABLE ${S}.suppliers (id text, owner_id text, stake_status text, _block_range int8range)`);
      await c.query(
        `INSERT INTO ${S}.suppliers SELECT u, 'owner-f', 'Staked', int8range(1, NULL) FROM unnest($1::text[]) u
         UNION ALL SELECT 'idle-' || g, 'owner-f', 'Staked', int8range(1, NULL) FROM generate_series(1, 250) g`,
        [sups]
      );
      await c.query(`CREATE TABLE ${S}.supplier_service_configs (supplier_id text, service_id text, rev_share jsonb, _block_range int8range)`);
      await c.query(`INSERT INTO ${S}.supplier_service_configs VALUES ($1, 'svc', '[{"address": "op-old"}]', int8range(1, 2))`, [
        one.supplier_id,
      ]);
      for (const [args, where, from, to, statuses] of [
        [`NULL, NULL, NULL, operators => ARRAY['op-old'], operator_scope => 'ever', row_limit => 1000`, `t.supplier_id = '${one.supplier_id}'`, null, null, undefined],
        ["NULL, NULL, NULL, row_limit => 1000", "true", null, null, undefined],
        [`ARRAY['${one.supplier_id}'], NULL, NULL, row_limit => 1000`, `t.supplier_id = '${one.supplier_id}'`, null, null, undefined],
        ["NULL, NULL, NULL, owners => ARRAY['owner-f'], row_limit => 1000", "true", null, null, undefined],
        [`NULL, NULL, NULL, applications => ARRAY['${one.application_id}'], row_limit => 1000`, `t.application_id = '${one.application_id}'`, null, null, undefined],
        [`NULL, NULL, NULL, services => ARRAY['${one.service_id}'], row_limit => 1000`, `t.service_id = '${one.service_id}'`, null, null, undefined],
        [`NULL, NULL, NULL, owners => ARRAY['owner-f'], services => ARRAY['${one.service_id}'], row_limit => 1000`, `t.service_id = '${one.service_id}'`, null, null, undefined],
        ["NULL, NULL, NULL, statuses => ARRAY['expired'], row_limit => 1000", "true", null, null, ["expired"]],
        [`NULL, NULL, NULL, owners => ARRAY['owner-f'], statuses => ARRAY['settled'], row_limit => 1000`, "true", null, null, ["settled"]],
        ["NULL, '2026-09-01T12:00:00Z', '2026-09-02T00:00:00Z', row_limit => 1000", "true", "2026-09-01T12:00:00Z", "2026-09-02T00:00:00Z", undefined],
        ["NULL, '2026-01-01T00:00:00Z', '2026-09-01T12:00:00Z', row_limit => 1000", "true", "2026-01-01T00:00:00Z", "2026-09-01T12:00:00Z", undefined],
        ["NULL, NULL, NULL, row_limit => 5", "true", null, null, undefined],
      ] as const) {
        const w = await want(where, from, to, statuses ? [...statuses] : undefined);
        assert.ok(args.includes("'2026-01-01") || w.length > 0, args);
        assert.deepEqual([args, await got(args)], [args, w.slice(0, args.endsWith("row_limit => 5") ? 5 : 1000)]);
      }
      // the pages, each from the last row of the one before, add up to the whole list, through every walk
      const busy = (
        await c.query(`SELECT supplier_id FROM ${S}.claim_settlements GROUP BY 1 ORDER BY count(*) DESC, 1 LIMIT 1`)
      ).rows[0].supplier_id as string;
      for (const f of [
        "NULL, NULL, NULL",
        `ARRAY['${busy}'], NULL, NULL`,
        "NULL, NULL, NULL, owners => ARRAY['owner-f']",
        `NULL, NULL, NULL, applications => ARRAY['${one.application_id}']`,
        `NULL, NULL, NULL, services => ARRAY['${one.service_id}']`,
      ]) {
        // the first 1000 rows, in about seven pages
        const all = await got(`${f}, row_limit => 1000`);
        const size = Math.max(3, Math.ceil(all.length / 7));
        const paged: string[] = [];
        let page = await got(`${f}, row_limit => ${size}`);
        paged.push(...page);
        while (page.length === size && paged.length < all.length) {
          const [, height, eventIdx] = page[size - 1].split(" ");
          page = await got(`${f}, row_limit => ${size}, before_height => ${height}, before_event_idx => ${eventIdx}`);
          paged.push(...page);
        }
        assert.ok(all.length > 3, f);
        assert.deepEqual([f, paged.slice(0, all.length)], [f, all]);
        // two rows a page, over the first 40: a page boundary inside a height, where several applications settled
        const small: string[] = [];
        let p2 = await got(`${f}, row_limit => 2`);
        small.push(...p2);
        while (p2.length === 2 && small.length < 40) {
          const [, height, eventIdx] = p2[1].split(" ");
          p2 = await got(`${f}, row_limit => 2, before_height => ${height}, before_event_idx => ${eventIdx}`);
          small.push(...p2);
        }
        assert.deepEqual([f, small.slice(0, 40)], [f, all.slice(0, 40)]);
      }
      // an id given twice is one id
      assert.deepEqual(
        await got(`ARRAY['${busy}', '${busy}'], NULL, NULL, row_limit => 1000`),
        await got(`ARRAY['${busy}'], NULL, NULL, row_limit => 1000`)
      );
      assert.deepEqual(
        await got(`NULL, NULL, NULL, services => ARRAY['${one.service_id}', '${one.service_id}'], row_limit => 1000`),
        await got(`NULL, NULL, NULL, services => ARRAY['${one.service_id}'], row_limit => 1000`)
      );
    } finally {
      await c.query("ROLLBACK");
    }
    for (const [args, err] of [
      ["NULL, NULL, NULL, row_limit => 1001", /row_limit must be between 1 and 1000/],
      ["NULL, NULL, NULL, statuses => ARRAY['open']", /statuses takes settled and expired/],
      ["NULL, NULL, NULL, before_height => 5", /pass both before_height and before_event_idx/],
      ["NULL, NULL, NULL, services => ARRAY[]::text[]", /services must have between 1 and 200 elements/],
    ] as const)
      await assert.rejects(c.query(`SELECT * FROM ${S}.get_claims(${args})`), err);
  });

  it("get_actor_lifecycle lists an actor's stake events newest first, per kind, and pages by keyset", async () => {
    await c.query("BEGIN");
    try {
      // blocks 100..400, a minute apart from 1 Mar 2026; every table the function reads, reduced to its columns
      await c.query(`
        INSERT INTO ${S}.blocks SELECT g, '2026-03-01'::timestamp + g * interval '1 minute' FROM generate_series(100, 400, 10) g;
        CREATE TABLE ${S}.suppliers (id text, owner_id text, stake_status text, _block_range int8range);
        INSERT INTO ${S}.suppliers VALUES ('s1', 'own-a', 'Staked', int8range(1, NULL)), ('s2', 'own-b', 'Staked', int8range(1, NULL));
        CREATE TABLE ${S}.msg_stake_suppliers (id text, supplier_id text, owner_id text, stake_amount numeric, block_id numeric, transaction_id text);
        CREATE TABLE ${S}.msg_unstake_suppliers (id text, supplier_id text, block_id numeric, transaction_id text);
        CREATE TABLE ${S}.event_supplier_unbonding_begins (id text, supplier_id text, reason text, unbonding_end_height numeric, session_end_height numeric, block_id numeric);
        CREATE TABLE ${S}.event_supplier_unbonding_ends (LIKE ${S}.event_supplier_unbonding_begins);
        CREATE TABLE ${S}.event_supplier_slasheds (id text, supplier_id text, application_id text, service_id text, session_id text,
          session_end_height numeric, proof_validation_status text, proof_missing_penalty numeric, previous_stake_amount numeric,
          after_stake_amount numeric, block_id numeric);
        CREATE TABLE ${S}.msg_stake_applications (id text, application_id text, stake_amount numeric, block_id numeric, transaction_id text);
        CREATE TABLE ${S}.msg_unstake_applications (id text, application_id text, block_id numeric, transaction_id text);
        CREATE TABLE ${S}.event_application_unbonding_begins (id text, application_id text, reason int, session_end_height numeric,
          unstaking_end_height numeric, block_id numeric);
        CREATE TABLE ${S}.event_application_unbonding_ends (LIKE ${S}.event_application_unbonding_begins);
        CREATE TABLE ${S}.msg_stake_gateways (id text, gateway_id text, stake_amount numeric, block_id numeric, transaction_id text);
        CREATE TABLE ${S}.msg_unstake_gateways (id text, gateway_id text, block_id numeric, transaction_id text);
        CREATE TABLE ${S}.event_gateway_unbonding_begins (id text, gateway_id text, unbonding_end_height numeric, session_end_height numeric,
          block_id numeric, transaction_id text);
        CREATE TABLE ${S}.event_gateway_unbonding_ends (id text, gateway_id text, unbonding_end_height numeric, session_end_height numeric,
          block_id numeric);
        CREATE TABLE ${S}.msg_delegate_to_gateways (id text, application_id text, gateway_id text, block_id numeric, transaction_id text);
        CREATE TABLE ${S}.msg_undelegate_from_gateways (LIKE ${S}.msg_delegate_to_gateways);
        INSERT INTO ${S}.msg_delegate_to_gateways VALUES ('dg1', 'a1', 'g1', 180, 'tx8');
        INSERT INTO ${S}.msg_undelegate_from_gateways VALUES ('ug1', 'a1', 'g1', 190, 'tx9');
        INSERT INTO ${S}.msg_stake_suppliers VALUES ('ms1', 's1', 'own-a', 1000, 100, 'tx1'), ('ms2', 's1', 'own-a', 1500, 200, 'tx2'),
          ('ms3', 's2', 'own-b', 900, 150, 'tx3');
        INSERT INTO ${S}.event_supplier_slasheds VALUES ('sl1', 's1', 'a1', 'svc', 'sess1', 240, 'PENDING_VALIDATION', 10, 1500, 1490, 250);
        INSERT INTO ${S}.msg_unstake_suppliers VALUES ('mu1', 's1', 290, 'tx4');
        INSERT INTO ${S}.event_supplier_unbonding_begins VALUES ('ub1', 's1', 'SUPPLIER_UNBONDING_REASON_VOLUNTARY', 400, 290, 300);
        INSERT INTO ${S}.event_supplier_unbonding_ends VALUES ('ue1', 's1', 'SUPPLIER_UNBONDING_REASON_VOLUNTARY', 400, 290, 400);
        INSERT INTO ${S}.msg_stake_applications VALUES ('ma1', 'a1', 500, 110, 'tx5');
        INSERT INTO ${S}.event_application_unbonding_begins VALUES ('ab1', 'a1', 1, 110, 130, 120);
        INSERT INTO ${S}.event_application_unbonding_ends VALUES ('ae1', 'a1', 1, 110, 130, 130);
        INSERT INTO ${S}.event_application_unbonding_begins VALUES ('ab2', 'a2', 0, 110, 130, 140), ('ab3', 'a3', 2, 110, 130, 150);
        INSERT INTO ${S}.event_application_unbonding_ends VALUES ('ae2', 'a2', 0, 110, 130, 170), ('ae3', 'a3', -1, 110, 130, 180);
        INSERT INTO ${S}.msg_stake_gateways VALUES ('mg1', 'g1', 700, 140, 'tx6');
        INSERT INTO ${S}.msg_unstake_gateways VALUES ('mgu1', 'g1', 160, 'tx7');
        INSERT INTO ${S}.event_gateway_unbonding_begins VALUES ('gb1', 'g1', 200, 160, 170, 'tx7');
        CREATE TABLE ${S}.supplier_service_configs (supplier_id text, service_id text, rev_share jsonb, _block_range int8range);
        INSERT INTO ${S}.supplier_service_configs VALUES ('s1', 'svc', '[{"address": "op-x"}]', int8range(1, 50));`);
      const got = async (args: string) =>
        (
          await c.query(
            `SELECT height || ' ' || actor_id || ' ' || event || ' ' || id || ' ' || coalesce(stake_upokt::text, '-') || ' '
                    || coalesce(reason, '-') || ' ' || coalesce(penalty_upokt::text, '-') k
             FROM ${S}.get_actor_lifecycle(${args})`
          )
        ).rows.map((r) => String(r.k));
      const s1 = [
        "400 s1 unbonding_end ue1 - SUPPLIER_UNBONDING_REASON_VOLUNTARY -",
        "300 s1 unbonding_begin ub1 - SUPPLIER_UNBONDING_REASON_VOLUNTARY -",
        "290 s1 unstake mu1 - - -",
        "250 s1 slash sl1 1490 - 10",
        "200 s1 stake ms2 1500 - -",
        "100 s1 stake ms1 1000 - -",
      ];
      for (const [args, want] of [
        ["'supplier', ARRAY['s1'], NULL, NULL", s1],
        ["'supplier', NULL, NULL, NULL, owners => ARRAY['own-a']", s1],
        ["'supplier', NULL, NULL, NULL, operators => ARRAY['op-x']", []],
        ["'supplier', NULL, NULL, NULL, operators => ARRAY['op-x'], operator_scope => 'ever'", s1],
        ["'supplier', ARRAY['s1', 's2'], NULL, NULL, events => ARRAY['stake']", ["200 s1 stake ms2 1500 - -", "150 s2 stake ms3 900 - -", "100 s1 stake ms1 1000 - -"]],
        ["'supplier', ARRAY['s1'], '2026-03-01T04:00:00Z', '2026-03-01T05:00:00Z'", ["290 s1 unstake mu1 - - -", "250 s1 slash sl1 1490 - 10"]],
        // the application events keep the proto number (0 elective, 1 below the minimum stake, 2 migration); the rows name
        // it as the Application entity does; -1, stored for an end reason the indexer did not recognize, is UNRECOGNIZED
        ["'application', ARRAY['a1'], NULL, NULL", [
          "190 a1 undelegate ug1 - - -", "180 a1 delegate dg1 - - -",
          "130 a1 unbonding_end ae1 - BELOW_MINIMUM_STAKE -", "120 a1 unbonding_begin ab1 - BELOW_MINIMUM_STAKE -", "110 a1 stake ma1 500 - -",
        ]],
        ["'application', ARRAY['a2', 'a3'], NULL, NULL", [
          "180 a3 unbonding_end ae3 - UNRECOGNIZED -", "170 a2 unbonding_end ae2 - ELECTIVE -",
          "150 a3 unbonding_begin ab3 - MIGRATION -", "140 a2 unbonding_begin ab2 - ELECTIVE -",
        ]],
        ["'gateway', ARRAY['g1'], NULL, NULL", [
          "190 g1 undelegate ug1 - - -", "180 g1 delegate dg1 - - -",
          "170 g1 unbonding_begin gb1 - - -", "160 g1 unstake mgu1 - - -", "140 g1 stake mg1 700 - -",
        ]],
        ["'gateway', ARRAY['g1'], NULL, NULL, events => ARRAY['delegate', 'undelegate']", ["190 g1 undelegate ug1 - - -", "180 g1 delegate dg1 - - -"]],
        ["'gateway', ARRAY['nobody'], NULL, NULL", []],
      ] as const)
        assert.deepEqual([args, await got(args)], [args, want]);
      // two rows a page, each from the last row of the one before
      const paged: string[] = [];
      let page = await got("'supplier', ARRAY['s1'], NULL, NULL, row_limit => 2");
      paged.push(...page);
      while (page.length === 2) {
        const [height, , , id] = page[1].split(" ");
        page = await got(`'supplier', ARRAY['s1'], NULL, NULL, row_limit => 2, before_height => ${height}, before_id => '${id}'`);
        paged.push(...page);
      }
      assert.deepEqual(paged, s1);
      const t = (await c.query(`SELECT block_time, transaction_id FROM ${S}.get_actor_lifecycle('supplier', ARRAY['s1'], NULL, NULL, events => ARRAY['unstake'])`)).rows;
      // each side of a delegation names the other
      const dg = (await c.query(`SELECT actor_id, application_id, gateway_id, transaction_id FROM ${S}.get_actor_lifecycle('application', ARRAY['a1'], NULL, NULL, events => ARRAY['delegate'])`)).rows;
      assert.deepEqual(dg, [{ actor_id: "a1", application_id: "a1", gateway_id: "g1", transaction_id: "tx8" }]);
      assert.deepEqual(t, [{ block_time: new Date("2026-03-01T04:50:00Z"), transaction_id: "tx4" }]);
      for (const [args, err] of [
        ["'validator', ARRAY['v1'], NULL, NULL", /kind is supplier, application or gateway/],
        ["'application', ARRAY['a1'], NULL, NULL, owners => ARRAY['own-a']", /owners and operators apply to kind supplier/],
        ["'supplier', NULL, NULL, NULL", /pass one of addresses, owners/],
        ["'supplier', ARRAY['s1'], NULL, NULL, owners => ARRAY['own-a']", /pass one of addresses, owners/],
        ["'supplier', ARRAY[]::text[], NULL, NULL", /addresses must have between 1 and 200 elements/],
        ["'supplier', ARRAY['s1'], NULL, NULL, operator_scope => 'past'", /operator_scope is now or ever/],
        ["'supplier', ARRAY['s1'], NULL, NULL, events => ARRAY['delegate']", /events of kind supplier are stake, unstake, unbonding_begin, unbonding_end, slash/],
        ["'gateway', ARRAY['g1'], NULL, NULL, events => ARRAY['slash']", /events of kind gateway are stake, unstake, unbonding_begin, unbonding_end, delegate, undelegate/],
        ["'supplier', ARRAY['s1'], NULL, NULL, operator_scope => 'ever'", /operator_scope ever applies to operators/],
        ["'gateway', NULL, NULL, NULL", /addresses must have between 1 and 200 elements/],
        ["'supplier', ARRAY['s1'], NULL, NULL, before_height => 5", /pass both before_height and before_id/],
      ] as const) {
        await c.query("SAVEPOINT e");
        await assert.rejects(c.query(`SELECT * FROM ${S}.get_actor_lifecycle(${args})`), err);
        await c.query("ROLLBACK TO SAVEPOINT e");
      }
    } finally {
      await c.query("ROLLBACK");
    }
  });

  it("get_morse_claims lists each kind of Morse claim newest first, with its services, and pages by keyset", async () => {
    await c.query("BEGIN");
    try {
      await c.query(`
        INSERT INTO ${S}.blocks SELECT g, '2026-03-01'::timestamp + g * interval '1 minute' FROM generate_series(100, 400, 10) g;
        CREATE TABLE ${S}.msg_claim_morse_accounts (id text, shannon_signing_address text, shannon_dest_address text,
          morse_src_address text, balance_amount numeric, block_id numeric, transaction_id text);
        CREATE TABLE ${S}.msg_claim_morse_applications (id text, shannon_signing_address text, shannon_dest_address text,
          morse_src_address text, stake_amount numeric, balance_amount numeric, block_id numeric, transaction_id text);
        CREATE TABLE ${S}.msg_claim_morse_application_services (id text, claim_msg_id text, service_id text);
        CREATE TABLE ${S}.msg_claim_morse_suppliers (id text, shannon_signing_address text, shannon_owner_address text,
          shannon_operator_address text, morse_src_address text, morse_node_address text, claim_signer_type text,
          stake_amount numeric, balance_amount numeric, block_id numeric, transaction_id text);
        CREATE TABLE ${S}.msg_claim_morse_supplier_services (id text, claim_msg_id text, service_id text);
        CREATE TABLE ${S}.msg_recover_morse_accounts (id text, shannon_dest_address_id text, morse_src_address text,
          recovered_balance_amount numeric, is_admin boolean, block_id numeric, transaction_id text);
        INSERT INTO ${S}.msg_claim_morse_accounts VALUES ('acc1', 'sign1', 'dest1', 'm1', 100, 100, 'tx1');
        INSERT INTO ${S}.msg_claim_morse_applications VALUES ('app1', 'sign2', 'dest2', 'm2', 500, 7, 200, 'tx2');
        INSERT INTO ${S}.msg_claim_morse_application_services VALUES ('as1', 'app1', 'svc-b'), ('as2', 'app1', 'svc-a');
        INSERT INTO ${S}.msg_claim_morse_suppliers VALUES ('sup1', 'sign3', 'own3', 'op3', 'm3', 'NODE3', 'CLAIM_SIGNER_TYPE_OPERATOR', 900, 9, 300, 'tx3');
        INSERT INTO ${S}.msg_claim_morse_supplier_services VALUES ('ss1', 'sup1', 'svc-a'), ('ss2', 'sup1', 'svc-a');
        INSERT INTO ${S}.msg_recover_morse_accounts VALUES ('rec1', 'dest1', 'm4', 40, true, 300, 'tx4');
        -- the supplier claim's destination as the chain records it: its claimed account (here the operator, not the owner)
        CREATE TABLE ${S}.morse_claimable_accounts (id text, claimed_msg_id text, shannon_dest_address text, _block_range int8range);
        INSERT INTO ${S}.morse_claimable_accounts VALUES ('m3', NULL, NULL, int8range(1, 300)), ('m3', 'sup1', 'op3', int8range(300, NULL));`);
      const got = async (args: string) =>
        (
          await c.query(
            `SELECT height || ' ' || kind || ' ' || id || ' ' || morse_src_address || ' ' || coalesce(shannon_dest_address, '-') || ' '
                    || coalesce(shannon_operator_address, '-') || ' ' || coalesce(balance_upokt::text, '-') || ' '
                    || coalesce(stake_upokt::text, '-') || ' ' || coalesce(array_to_string(service_ids, ','), '-') || ' '
                    || coalesce(claim_signer_type, '-') || ' ' || coalesce(is_admin::text, '-') k
             FROM ${S}.get_morse_claims(${args})`
          )
        ).rows.map((r) => String(r.k));
      const all = [
        "300 supplier sup1 m3 op3 op3 9 900 svc-a CLAIM_SIGNER_TYPE_OPERATOR -",
        "300 recover rec1 m4 dest1 - 40 - - - true",
        "200 application app1 m2 dest2 - 7 500 svc-a,svc-b - -",
        "100 account acc1 m1 dest1 - 100 - - - -",
      ];
      for (const [args, want] of [
        ["NULL, NULL, NULL, NULL", all],
        // stored lowercased by the indexer, asked in any case
        ["ARRAY['M2', 'm4'], NULL, NULL, NULL", [all[1], all[2]]],
        ["NULL, ARRAY['dest1'], NULL, NULL", [all[1], all[3]]],
        ["NULL, ARRAY['op3'], NULL, NULL", [all[0]]],
        ["NULL, ARRAY['dest1'], NULL, NULL, kinds => ARRAY['account']", [all[3]]],
        ["NULL, NULL, '2026-03-01T03:00:00Z', '2026-03-01T04:00:00Z'", [all[2]]],
        ["NULL, NULL, NULL, NULL, row_limit => 1, before_height => 300, before_id => 'sup1'", [all[1]]],
        ["NULL, NULL, NULL, NULL, row_limit => 2, before_height => 300, before_id => 'rec1'", [all[2], all[3]]],
        ["ARRAY['nobody'], NULL, NULL, NULL", []],
      ] as const)
        assert.deepEqual([args, await got(args)], [args, want]);
      for (const [args, err] of [
        ["NULL, NULL, NULL, NULL, kinds => ARRAY['validator']", /kinds takes account, application, supplier, recover/],
        ["ARRAY[]::text[], NULL, NULL, NULL", /morse_addresses must have between 1 and 200 elements/],
        ["NULL, NULL, NULL, NULL, before_height => 5", /pass both before_height and before_id/],
        ["NULL, NULL, NULL, NULL, row_limit => 0", /row_limit must be between 1 and 1000/],
      ] as const) {
        await c.query("SAVEPOINT e");
        await assert.rejects(c.query(`SELECT * FROM ${S}.get_morse_claims(${args})`), err);
        await c.query("ROLLBACK TO SAVEPOINT e");
      }
    } finally {
      await c.query("ROLLBACK");
    }
  });

  it("the entity descriptions keep a table's smart tags first, replace its old text, and skip missing tables", async () => {
    await c.query("BEGIN");
    try {
      await c.query(`
        CREATE TABLE ${S}.suppliers (id text, owner_id text, stake_amount numeric);
        COMMENT ON TABLE ${S}.suppliers IS E'@foreignKey (owner_id) REFERENCES accounts (id)\n@omit create\nan old text';`);
      await c.query(createEntityDescriptionsFn(S));
      const tuples = async () =>
        (await c.query(`SELECT objsubid, ctid::text FROM pg_description WHERE objoid = '${S}.suppliers'::regclass ORDER BY 1`)).rows;
      const first = await tuples();
      assert.equal(first.length, 4, "the table and its 3 columns are described");
      await c.query(createEntityDescriptionsFn(S));
      assert.deepEqual(await tuples(), first, "an unchanged description is not written again");
      const t = (await c.query(`SELECT obj_description('${S}.suppliers'::regclass, 'pg_class') d`)).rows[0].d as string;
      assert.equal(
        t,
        `@foreignKey (owner_id) REFERENCES accounts (id)|${DEPRECATED_RELATION}\n@omit create\nOne row per supplier, keyed by operator address, ` +
          "with its stake and unstaking state. SubQuery keeps its history; GraphQL lists show the current version of each " +
          "row unless asked for an earlier height."
      );
      const cols = (
        await c.query(
          `SELECT a.attname, col_description(a.attrelid, a.attnum) d FROM pg_attribute a
           WHERE a.attrelid = '${S}.suppliers'::regclass AND a.attnum > 0 ORDER BY a.attnum`
        )
      ).rows.map((r) => [r.attname, r.d]);
      assert.deepEqual(cols, [
        ["id", "Operator address."],
        ["owner_id", "Owner address (Account id), from the last stake message or Morse claim."],
        ["stake_amount", "Stake in upokt: the amount of the last stake message (a Morse claim adds its stake to the previous one), reduced by slashes; 0 once Unstaked."],
      ]);
    } finally {
      await c.query("ROLLBACK");
    }
  });

  it("the deprecations mark the tables and functions that go, first in their comment, once, and skip what is missing", async () => {
    await c.query("BEGIN");
    try {
      await c.query(`
        CREATE TABLE IF NOT EXISTS ${S}.event_claim_settleds (block_id numeric);
        COMMENT ON TABLE ${S}.event_claim_settleds IS E'@deprecated an older mark\n@foreignKey (supplier_id) REFERENCES suppliers (id)\nold text';
        CREATE TABLE IF NOT EXISTS ${S}.relays (id text);
        CREATE FUNCTION ${S}.get_rewards_by_addresses_and_time(a text) RETURNS int LANGUAGE sql AS 'SELECT 1';
        CREATE FUNCTION ${S}.get_rewards_by_addresses_and_time(a text, b text) RETURNS int LANGUAGE sql AS 'SELECT 2';
        COMMENT ON FUNCTION ${S}.get_rewards_by_addresses_and_time(text, text) IS 'its description';`);
      await c.query(createDeprecationsFn(S));
      const comments = async () =>
        (
          await c.query(
            `SELECT 'table ' || k.relname n, obj_description(k.oid, 'pg_class') d FROM pg_class k
             WHERE k.relnamespace = $1::regnamespace AND k.relname IN ('event_claim_settleds', 'relays')
             UNION ALL SELECT 'function ' || pronargs, obj_description(p.oid, 'pg_proc') FROM pg_proc p
             WHERE p.pronamespace = $1::regnamespace AND p.proname = 'get_rewards_by_addresses_and_time' ORDER BY 1`,
            [S]
          )
        ).rows.map((r) => [r.n, r.d]);
      const fn = deprecatedTag("legacyRewardsByAddressesAndTime (same arguments, the old JSON under data)");
      const want = [
        ["function 1", fn],
        ["function 2", `${fn}\nits description`],
        ["table event_claim_settleds", `${deprecatedTag("getClaimsList or getClaimsJson; sums in getSupplierEarningsJson, getApplicationSpendJson, getGatewaySpendJson, getServiceUsageJson")}\n@foreignKey (supplier_id) REFERENCES suppliers (id)\nold text`],
        ["table relays", deprecatedTag("nothing: the table is empty")],
      ];
      assert.deepEqual(await comments(), want);
      // a second start writes nothing: same pg_description tuples
      const tuples = async () =>
        (await c.query(`SELECT objoid::text, ctid::text FROM pg_description WHERE description ~ '^@deprecated' ORDER BY 1`)).rows;
      const before = await tuples();
      await c.query(createDeprecationsFn(S));
      assert.deepEqual(await comments(), want);
      assert.deepEqual(await tuples(), before);
    } finally {
      await c.query("ROLLBACK");
    }
  });

  it("get_relay_mining_difficulty lists each service's updates newest first and pages by keyset", async () => {
    await c.query("BEGIN");
    try {
      await c.query(`
        INSERT INTO ${S}.blocks SELECT g, '2026-03-01'::timestamp + g * interval '1 minute' FROM generate_series(100, 300, 50) g;
        CREATE TABLE ${S}.event_relay_mining_difficulty_updateds (service_id text, prev_target_hash_hex_encoded text,
          new_target_hash_hex_encoded text, prev_num_relays_ema numeric, new_num_relays_ema numeric, block_id numeric);
        INSERT INTO ${S}.event_relay_mining_difficulty_updateds VALUES ('svc-a', 'ff', 'fe', 10, 20, 100),
          ('svc-a', 'fe', 'fd', 20, 30, 200), ('svc-a', 'fd', 'fc', 30, 40, 300), ('svc-b', 'ff', 'f0', 1, 2, 200),
          ('svc-b', 'f0', 'e0', 2, 3, 250), ('svc-c', 'ff', 'fe', 5, 6, 250);`);
      const got = async (args: string) =>
        (
          await c.query(
            `SELECT height || ' ' || service_id || ' ' || prev_num_relays_ema || '>' || new_num_relays_ema || ' '
                    || new_target_hash_hex k FROM ${S}.get_relay_mining_difficulty(${args})`
          )
        ).rows.map((r) => String(r.k));
      const all = ["300 svc-a 30>40 fc", "250 svc-b 2>3 e0", "200 svc-b 1>2 f0", "200 svc-a 20>30 fd", "100 svc-a 10>20 fe"];
      assert.deepEqual(await got("ARRAY['svc-a', 'svc-b'], NULL, NULL"), all);
      assert.deepEqual(await got("ARRAY['svc-a', 'svc-b'], '2026-03-01T02:30:00Z', '2026-03-01T04:20:00Z'"), all.slice(1, 4));
      const paged: string[] = [];
      let page = await got("ARRAY['svc-a', 'svc-b'], NULL, NULL, row_limit => 2");
      paged.push(...page);
      while (page.length === 2) {
        const [height, service] = page[1].split(" ");
        page = await got(`ARRAY['svc-a', 'svc-b'], NULL, NULL, row_limit => 2, before_height => ${height}, before_service_id => '${service}'`);
        paged.push(...page);
      }
      assert.deepEqual(paged, all);
      // a page at any depth by row_offset
      for (const off of [0, 1, 2, 3, 4, 5])
        assert.deepEqual(await got(`ARRAY['svc-a', 'svc-b'], NULL, NULL, row_limit => 2, row_offset => ${off}`), all.slice(off, off + 2), String(off));
      // the deepest offset with the largest page: an empty page, not an integer overflow of row_limit + row_offset
      assert.deepEqual(await got(`ARRAY['svc-a', 'svc-b'], NULL, NULL, row_limit => 1000, row_offset => 10000000`), []);
      for (const off of ["-1", "10000001", "2147483647"]) {
        await c.query("SAVEPOINT e");
        await assert.rejects(c.query(`SELECT * FROM ${S}.get_relay_mining_difficulty(ARRAY['svc-a'], NULL, NULL, row_offset => ${off})`),
          /row_offset must be between 0 and 10000000/, off);
        await c.query("ROLLBACK TO SAVEPOINT e");
      }
      await assert.rejects(c.query(`SELECT * FROM ${S}.get_relay_mining_difficulty(NULL, NULL, NULL)`), /services must have between 1 and 200/);
    } finally {
      await c.query("ROLLBACK");
    }
  });

  it("get_native_transfers lists an address's transfers newest first with their transaction, by direction, by keyset", async () => {
    await c.query("BEGIN");
    try {
      // a sends to b (100) and to c (200), b sends to a (200), c to d (250, not ours), a to itself (300); tx3 is not indexed
      await c.query(`
        INSERT INTO ${S}.blocks SELECT g, '2026-03-01'::timestamp + g * interval '1 minute' FROM generate_series(100, 300, 50) g;
        CREATE TABLE ${S}.native_transfers (id text, sender_id text, recipient_id text, denom text, amounts jsonb, status text,
          transaction_id text, block_id numeric, _block_range int8range);
        CREATE TABLE ${S}.transactions (id text, code integer, codespace text, fees jsonb, signer_address text, memo text,
          _block_range int8range);
        INSERT INTO ${S}.native_transfers VALUES ('n1', 'a', 'b', 'upokt', '[{"denom": "upokt", "amount": "1"}]', 'Success', 'tx1', 100, int8range(100, NULL)),
          ('n2', 'b', 'a', 'upokt', '[{"denom": "upokt", "amount": "2"}]', 'Success', 'tx2', 200, int8range(200, NULL)),
          ('n3', 'a', 'c', 'upokt', '[{"denom": "upokt", "amount": "3"}]', 'Error', 'tx3', 200, int8range(200, NULL)),
          ('n4', 'c', 'd', 'upokt', '[{"denom": "upokt", "amount": "4"}]', 'Success', 'tx4', 250, int8range(250, NULL)),
          ('n5', 'a', 'a', 'upokt', '[{"denom": "upokt", "amount": "5"}]', 'Success', 'tx5', 300, int8range(300, NULL));
        INSERT INTO ${S}.transactions VALUES ('tx1', 0, '', '[{"denom": "upokt", "amount": "10"}]', 'a', 'hi', int8range(100, NULL)),
          ('tx2', 0, '', '[]', 'b', '', int8range(200, NULL)), ('tx4', 0, '', '[]', 'c', '', int8range(250, NULL)),
          ('tx5', 5, 'bank', '[{"denom": "upokt", "amount": "7"}]', 'a', 'self', int8range(300, NULL));`);
      const got = async (args: string) =>
        (
          await c.query(`SELECT concat_ws(' ', height, id, sender_id, recipient_id, status, transaction_id, tx_code, tx_codespace,
                           tx_fees::text, tx_signer_address, tx_memo) k FROM ${S}.get_native_transfers(${args})`)
        ).rows.map((r) => String(r.k));
      const all = [
        '300 n5 a a Success tx5 5 bank [{"denom": "upokt", "amount": "7"}] a self',
        "200 n3 a c Error tx3",
        "200 n2 b a Success tx2 0  [] b ",
        '100 n1 a b Success tx1 0  [{"denom": "upokt", "amount": "10"}] a hi',
      ];
      assert.deepEqual(await got("ARRAY['a']"), all);
      assert.deepEqual(await got("ARRAY['a'], 'sent'"), [all[0], all[1], all[3]]);
      assert.deepEqual(await got("ARRAY['a'], 'received'"), [all[0], all[2]]);
      assert.deepEqual(await got("ARRAY['a'], NULL, '2026-03-01T03:00:00Z', '2026-03-01T04:00:00Z'"), all.slice(1, 3));
      const paged: string[] = [];
      let page = await got("ARRAY['a'], row_limit => 1");
      paged.push(...page);
      while (page.length === 1) {
        const [height, id] = page[0].split(" ");
        page = await got(`ARRAY['a'], row_limit => 1, before_height => ${height}, before_id => '${id}'`);
        paged.push(...page);
      }
      assert.deepEqual(paged, all);
      for (const [args, err] of [
        ["ARRAY['a'], 'both'", /direction is sent, received or NULL/],
        ["ARRAY[]::text[]", /addresses must have between 1 and 200 elements/],
        ["ARRAY['a'], row_limit => 1001", /row_limit must be between 1 and 1000/],
        ["ARRAY['a'], before_height => 5", /pass both before_height and before_id/],
      ] as const) {
        await c.query("SAVEPOINT e");
        await assert.rejects(c.query(`SELECT * FROM ${S}.get_native_transfers(${args})`), err);
        await c.query("ROLLBACK TO SAVEPOINT e");
      }
    } finally {
      await c.query("ROLLBACK");
    }
  });

  it("get_created_claims lists up to 20 suppliers' created claims newest first and pages by keyset", async () => {
    await c.query("BEGIN");
    try {
      await c.query(`
        INSERT INTO ${S}.blocks SELECT g, '2026-03-01'::timestamp + g * interval '1 minute' FROM generate_series(100, 300, 50) g;
        CREATE TABLE ${S}.msg_create_claims (id text, supplier_id text, application_id text, service_id text, session_id text,
          session_end_height numeric, num_relays numeric, num_estimated_relays numeric, num_claimed_computed_units numeric,
          num_estimated_computed_units numeric, claimed_amount numeric, transaction_id text, block_id numeric);
        INSERT INTO ${S}.msg_create_claims VALUES ('t1-0', 's1', 'a1', 'svc', 'x1', 90, 5, 6, 7, 8, 9, 't1', 100),
          ('t2-0', 's1', 'a1', 'svc', 'x2', 190, 1, 1, 1, 1, 1, 't2', 200), ('t2-1', 's1', 'a2', 'svc', 'x3', 190, 2, 2, 2, 2, 2, 't2', 200),
          ('t3-0', 's2', 'a1', 'svc', 'x4', 240, 3, 3, 3, 3, 3, 't3', 250), ('t4-0', 's3', 'a1', 'svc', 'x5', 290, 4, 4, 4, 4, 4, 't4', 300);`);
      const got = async (args: string) =>
        (
          await c.query(`SELECT concat_ws(' ', height, id, supplier_id, session_id, relays) k FROM ${S}.get_created_claims(${args})`)
        ).rows.map((r) => String(r.k));
      const all = ["250 t3-0 s2 x4 3", "200 t2-1 s1 x3 2", "200 t2-0 s1 x2 1", "100 t1-0 s1 x1 5"];
      assert.deepEqual(await got("ARRAY['s1', 's2', 's1'], NULL, NULL"), all);
      assert.deepEqual(await got("ARRAY['s1'], '2026-03-01T03:00:00Z', NULL"), all.slice(1, 3));
      // the sessions ending at or after a height: 190 keeps x2, x3 and x4, and pages the same way
      assert.deepEqual(await got("ARRAY['s1', 's2'], NULL, NULL, from_session_end_height => 190"), all.slice(0, 3));
      assert.deepEqual(
        await got("ARRAY['s1', 's2'], NULL, NULL, row_limit => 1, before_height => 200, before_id => 't2-1', from_session_end_height => 190"),
        [all[2]]
      );
      const paged: string[] = [];
      let page = await got("ARRAY['s1', 's2'], NULL, NULL, row_limit => 1");
      paged.push(...page);
      while (page.length === 1) {
        const [height, id] = page[0].split(" ");
        page = await got(`ARRAY['s1', 's2'], NULL, NULL, row_limit => 1, before_height => ${height}, before_id => '${id}'`);
        paged.push(...page);
      }
      assert.deepEqual(paged, all);
      // the count of the same claims, per requested supplier, 0 for one that made none
      const count = async (args: string) =>
        (
          await c.query(`SELECT concat_ws(' ', supplier_id, claims, first_height, last_height, beyond_tip) k FROM ${S}.get_created_claims_count(${args})`)
        ).rows.map((r) => String(r.k));
      assert.deepEqual(await count("ARRAY['s2', 's1', 'nobody', 's1'], NULL, NULL"), [
        "nobody 0 f", "s1 3 100 200 f", "s2 1 250 250 f",
      ]);
      assert.deepEqual(await count("ARRAY['s1'], '2026-03-01T03:00:00Z', NULL"), ["s1 2 200 200 f"]);
      // the claims of sessions ending at or after 190, as the list gives them
      assert.deepEqual(await count("ARRAY['s1', 's2'], NULL, NULL, from_session_end_height => 190"), [
        "s1 2 200 200 f", "s2 1 250 250 f",
      ]);
      // a range past the last block (300, at 05:00) counts none and says beyond_tip; one ending past it counts what is
      // indexed and says it too; one ending at the last block's time is final
      assert.deepEqual(await count("ARRAY['s1'], '2030-01-01T00:00:00Z', NULL, from_session_end_height => 190"), ["s1 0 t"]);
      assert.deepEqual(await count("ARRAY['s1'], NULL, '2030-01-01T00:00:00Z'"), ["s1 3 100 200 t"]);
      assert.deepEqual(await count("ARRAY['s1'], NULL, '2026-03-01T05:00:00Z'"), ["s1 3 100 200 f"]);
      assert.deepEqual(await got("ARRAY['s1'], '2030-01-01T00:00:00Z', NULL, from_session_end_height => 190"), []);
      const many = Array.from({ length: 21 }, (_, i) => `'s${i}'`).join(", ");
      for (const fn of ["get_created_claims", "get_created_claims_count"]) {
        await c.query("SAVEPOINT e");
        await assert.rejects(c.query(`SELECT * FROM ${S}.${fn}(ARRAY[${many}], NULL, NULL)`), /between 1 and 20 elements/, fn);
        await c.query("ROLLBACK TO SAVEPOINT e");
      }
    } finally {
      await c.query("ROLLBACK");
    }
  });

  it("get_block_stats sums and averages the blocks' report columns per bucket", async () => {
    await c.query("BEGIN");
    try {
      // 120 blocks a minute apart from 1 Mar 2026 10:30, two hours; the report columns as the indexer fills them
      await c.query(`
        ALTER TABLE ${S}.blocks ADD COLUMN size int, ADD COLUMN time_to_block bigint, ADD COLUMN total_txs int,
          ADD COLUMN successful_txs int, ADD COLUMN failed_txs int, ADD COLUMN total_relays numeric,
          ADD COLUMN total_estimated_relays numeric, ADD COLUMN total_computed_units numeric,
          ADD COLUMN total_estimated_computed_units numeric;
        INSERT INTO ${S}.blocks SELECT 1000 + g, '2026-03-01 10:30'::timestamp + g * interval '1 minute', 100 + g, 60000 + g, g % 5,
          g % 5 - g % 2, g % 2, 10 * g, 11 * g, 20 * g, 21 * g FROM generate_series(0, 119) g;
        -- the first block: its previous one is not indexed, so update_block_took leaves 0
        UPDATE ${S}.blocks SET time_to_block = 0 WHERE id = 1000;`);
      const want = async (trunc: string | null, from: string, to: string) =>
        (
          await c.query(
            `SELECT count(*) || ' ' || min(id) || ' ' || max(id) || ' ' || sum(total_txs) || ' ' || sum(successful_txs) || ' '
                    || sum(failed_txs) || ' ' || sum(total_relays) || ' ' || sum(total_estimated_relays) || ' '
                    || sum(total_computed_units) || ' ' || sum(total_estimated_computed_units) || ' '
                    || round(avg(time_to_block) FILTER (WHERE time_to_block > 0), 3) || ' '
                    || min(time_to_block) FILTER (WHERE time_to_block > 0) || ' ' || max(time_to_block) || ' '
                    || round(avg(size), 3) k
             FROM ${S}.blocks WHERE timestamp >= $2::timestamptz AT TIME ZONE 'UTC' AND timestamp < $3::timestamptz AT TIME ZONE 'UTC'
             GROUP BY CASE WHEN $1::text IS NULL THEN NULL ELSE date_trunc($1, timestamp) END ORDER BY min(timestamp) DESC`,
            [trunc, from, to]
          )
        ).rows.map((r) => String(r.k));
      const got = async (bucket: string | null, from: string, to: string) =>
        (
          await c.query(
            `SELECT blocks || ' ' || first_height || ' ' || last_height || ' ' || total_txs || ' ' || successful_txs || ' '
                    || failed_txs || ' ' || relays || ' ' || estimated_relays || ' ' || compute_units || ' '
                    || estimated_compute_units || ' ' || avg_time_to_block_ms || ' ' || min_time_to_block_ms || ' '
                    || max_time_to_block_ms || ' ' || avg_size_bytes k, bucket_start, bucket_end
             FROM ${S}.get_block_stats($2, $3, $1)`,
            [bucket, from, to]
          )
        ).rows;
      for (const [bucket, from, to] of [
        [null, "2026-03-01T10:00:00Z", "2026-03-01T13:00:00Z"],
        ["hour", "2026-03-01T10:00:00Z", "2026-03-01T13:00:00Z"],
        ["hour", "2026-03-01T11:15:00Z", "2026-03-01T12:10:00Z"],
        ["day", "2026-03-01T00:00:00Z", "2026-03-02T00:00:00Z"],
      ] as const) {
        const rows = await got(bucket, from, to);
        assert.deepEqual([bucket, from, rows.map((r) => r.k)], [bucket, from, await want(bucket, from, to)]);
        if (bucket === null) assert.match(String(rows[0].k), / 60001 60119 /, "the 0 of block 1000 is not the minimum");
        assert.ok(rows.length > 0);
        if (bucket === "hour")
          for (const r of rows) assert.equal(new Date(r.bucket_end).getTime() - new Date(r.bucket_start).getTime() <= 3600e3, true);
      }
    } finally {
      await c.query("ROLLBACK");
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
         'hour')->'data' j`,
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
      // operator_scope ever: sup-x shared revenue with op-old in a closed config version only, and is no supplier now
      await c.query(`
        CREATE TABLE ${S}.supplier_service_configs (supplier_id text, service_id text, rev_share jsonb, _block_range int8range);
        INSERT INTO ${S}.supplier_service_configs VALUES ('sup-x', 'svc-x', '[{"address": "op-new"}, {"address": "op-old"}]', int8range(1, 9)),
          ('sup-x', 'svc-x', '[{"address": "op-new"}]', int8range(9, NULL)), ('sup-z', 'svc-x', '[{"address": "op-z"}]', int8range(1, NULL));
        CREATE TABLE ${S}.suppliers (id text, stake_status text, _block_range int8range);`);
      const scoped = async (args: string) =>
        (
          await c.query(`SELECT kind, reason, slashed_upokt::text slashed FROM ${S}.get_supplier_penalties(NULL, NULL, NULL,
                           operators => ARRAY['op-old'], ${args}) ORDER BY kind, reason`)
        ).rows;
      assert.deepEqual(await scoped("operator_scope => 'ever'"), rows.map(({ kind, reason, slashed }) => ({ kind, reason, slashed })));
      assert.deepEqual(await scoped("operator_scope => 'now'"), []);
      for (const [args, err] of [
        ["operator_scope => 'past'", /operator_scope is now or ever \(has past\)/],
        ["operator_scope => 'ever', bucket => 'minute'", /invalid bucket: minute/],
      ] as const) {
        await c.query("SAVEPOINT e");
        await assert.rejects(scoped(args), err);
        await c.query("ROLLBACK TO SAVEPOINT e");
      }
    } finally {
      await c.query("ROLLBACK");
    }
  });

  it("get_supplier_penalties with no suppliers and no owners answers for every supplier", async () => {
    await c.query("BEGIN");
    try {
      const h = (await c.query(`SELECT max(height) h FROM ${S}.settlement_blocks`)).rows[0].h as string;
      await c.query(
        `INSERT INTO ${S}.claim_expirations VALUES ($1, 900001, 'sup-x', 'app-x', 'svc-x', 100, 50, 'PROOF_INVALID', 7, 7, 7, 7),
           ($1, 900002, 'sup-y', 'app-x', 'svc-x', 100, 20, 'PROOF_MISSING', 3, 3, 3, 3)`,
        [h]
      );
      await c.query(`INSERT INTO ${S}.supplier_slashes VALUES ($1, 900002, 'sup-y', 'app-x', 'svc-x', 100, 30, 970)`, [h]);
      const listed = (
        await c.query(`SELECT array_agg(DISTINCT supplier_id) l FROM (
          SELECT supplier_id FROM ${S}.claim_expirations UNION SELECT supplier_id FROM ${S}.claim_discards
          UNION SELECT supplier_id FROM ${S}.supplier_slashes) x`)
      ).rows[0].l as unknown as string[];
      assert.ok(listed.length >= 2);
      const q = (arg: string) =>
        c.query(
          `SELECT kind, reason, events::text, claimed_upokt::text, slashed_upokt::text
           FROM ${S}.get_supplier_penalties(${arg}, NULL, NULL, by_supplier => false) ORDER BY kind, reason`,
          arg === "$1" ? [listed] : []
        );
      const every = (await q("NULL")).rows;
      assert.ok(every.some((r) => r.kind === "slashed"));
      assert.deepEqual(every, (await q("$1")).rows);
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
      `SELECT ${S}.legacy_rewards_by_addresses_and_time($1::text[], '2026-09-01 00:00', '2026-09-02 00:00')->>'data' a`,
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
      const d6 = await c.query(`SELECT ${S}.legacy_rewards_of_addresses_by_suppliers_and_time(ARRAY[$1], $2, $3, $4)->>'data' a`, [
        address,
        some,
        from,
        to,
      ]);
      assert.equal(d6.rows[0].a, want);
      const d5 = await c.query(
        `SELECT ${S}.legacy_rewards_by_suppliers_and_time_group_by_address_and_date(ARRAY[$1], $2, $3, $4, 'day')->'data' j`,
        [address, some, from, to]
      );
      const rows = d5.rows[0].j as unknown as { total_amount: number | string }[];
      assert.equal(rows.length, 1);
      assert.equal(String(rows[0].total_amount), want);
    }
    for (const list of [null, [], [""], ["pokt1nosuchsupplier"]]) {
      const none = await c.query(
        `SELECT ${S}.legacy_rewards_of_addresses_by_suppliers_and_time(ARRAY[$1], $2, '2026-09-01', '2026-09-02')->>'data' a`,
        [address, list]
      );
      assert.deepEqual([list, none.rows[0].a], [list, "0"]);
    }
    // by month: the whole of September from the monthly rollup, the same total
    const month = await c.query(
      `SELECT ${S}.legacy_rewards_by_suppliers_and_time_group_by_address_and_date(ARRAY[$1], $2, '2026-09-01',
         '2026-09-30 23:59:59.999999', 'month')->'data' j`,
      [address, some]
    );
    const day = await c.query(
      `SELECT ${S}.legacy_rewards_of_addresses_by_suppliers_and_time(ARRAY[$1], $2, '2026-09-01', '2026-09-30 23:59:59.999999')->>'data' a`,
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
        `SELECT ${S}.legacy_rewards_by_suppliers_and_time_group_by_address_and_date(ARRAY[$1], $2, $3, $4, 'hour')->'data' j`,
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
        `SELECT ${S}.legacy_rewards_by_suppliers_and_time_group_by_address_and_date(ARRAY[$1], $2, '2026-09-01', '2026-09-02', 'day')->'data' j`,
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
          for (const [k, v] of Object.entries(j).filter(
            ([k]) =>
              !["bucket_start", "bucket_end", "covered_from", "covered_to", "covered_gaps", ...keys.split(", ")].includes(k)
          ))
            assert.ok(v === 0 || v === null, `${call}: ${k} = ${JSON.stringify(v)} in a filled cell`);
      }
    }
  });

  it("a range after the last written settlement returns no rows with a bucket, not a zero row per id", async () => {
    // both fixtures settle at 2026-09-01 12:00 UTC; nothing settled in these buckets, and by default (sparse) an id
    // with nothing gets no row
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

  it("the smart tags find keyset state functions by an argument named after_ with the underscore escaped", () => {
    // in the template literal a single backslash is lost: LIKE 'after_%' would match any argument starting "after"
    const sql = createSettlementSmartTagsFn(S);
    assert.ok(sql.includes("a LIKE 'after\\_%'"), "LIKE 'after\\_%' in the generated SQL");
    assert.ok(!sql.includes("a LIKE 'after_%'"));
  });

  it("GraphQL: every catalog function that returns rows is a plain list, and the helpers are hidden", async () => {
    // subql-query 2.22.2 adds a _block_range filter to every function connection, which the catalog rows lack
    const { rows } = await c.query(
      `SELECT p.proname, obj_description(p.oid, 'pg_proc') tag FROM pg_proc p
       WHERE p.pronamespace = $1::regnamespace AND p.prokind = 'f' AND p.proretset ORDER BY 1`,
      [S]
    );
    const tags = Object.fromEntries(rows.map((r) => [r.proname, r.tag]));
    const catalog = rows.map((r) => String(r.proname)).filter((n) => !n.startsWith("_") && !STATE_FUNCTIONS.includes(n));
    // the functions over the current state are plain lists too, with no _json twin
    assert.deepEqual(rows.map((r) => String(r.proname)).filter((n) => STATE_FUNCTIONS.includes(n)), [...STATE_FUNCTIONS].sort());
    for (const n of STATE_FUNCTIONS) assert.ok(String(tags[n]).startsWith("@simpleCollections only\n"), n);
    assert.deepEqual(catalog, [
      "get_actor_lifecycle", "get_app_auto_unstakes", "get_application_spend", "get_block_stats", "get_claims",
      "get_created_claims", "get_delegator_income", "get_gateway_spend", "get_income", "get_morse_claims", "get_native_transfers",
      "get_param_history",
      "get_relay_mining_difficulty", "get_service_usage", "get_supplier_distribution", "get_supplier_earnings",
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
    // the twins of the keyset functions hold one page (row_limit), the others every row
    const keyset = [
      "get_claims_json", "get_created_claims_json", "get_actor_lifecycle_json", "get_relay_mining_difficulty_json", "get_morse_claims_json",
      "get_native_transfers_json",
    ];
    for (const r of twins.rows) {
      const limit = keyset.includes(String(r.proname)) ? /at most row_limit/ : /no row limit/;
      assert.ok(limit.test(String(r.tag)) && !/@omit/.test(String(r.tag)), String(r.proname));
    }
    for (const n of ["_buckets", "_income"]) assert.deepEqual([n, tags[n]], [n, "@omit"]);
    // nothing else is published, set-returning or not: every other function is hidden, a writer (published as a
    // mutation) included
    const shown = (
      await c.query(
        `SELECT p.proname FROM pg_proc p WHERE p.pronamespace = $1::regnamespace AND p.prokind = 'f'
           AND coalesce(obj_description(p.oid, 'pg_proc'), '') !~ '^@omit' ORDER BY 1`,
        [S]
      )
    ).rows.map((r) => String(r.proname));
    // ...but the functions over the current state, and get_last_settlement and get_height_at (one row, not set-returning, so they have no
    // list or _json twin), published on purpose
    assert.deepEqual(
      shown.filter((n) => !catalog.includes(n.replace(/_json$/, "")) && !n.startsWith("legacy_")),
      ["get_height_at", "get_last_settlement", ...STATE_FUNCTIONS].sort()
    );
    const vrd = await c.query(
      `SELECT count(*)::int n FROM pg_proc p WHERE p.pronamespace = $1::regnamespace AND p.proname = '_vrd_range_start'`,
      [S]
    );
    assert.equal(vrd.rows[0].n, 0);
  });

  it("get_supplier_earnings keeps the claims of services, with and without by_service, from every source", async () => {
    // the supplier and service with the most claims, among others of the supplier
    const top = (
      await c.query(`SELECT supplier_id, service_id FROM ${S}.claim_settlements
                     WHERE supplier_id IN (SELECT supplier_id FROM ${S}.claim_settlements GROUP BY 1 HAVING count(DISTINCT service_id) > 1)
                     GROUP BY 1, 2 ORDER BY count(*) DESC, 1, 2 LIMIT 1`)
    ).rows[0];
    assert.ok(top, "the fixtures hold a supplier with more than one service");
    const cols = `bucket_start, claimed_upokt::text, settled_upokt::text, relays::text, compute_units::text, settled_claims::text,
                  settled_claims_with_proof::text, first_settled_height::text, last_settled_height::text`;
    for (const [from, to, bucket] of [
      [null, null, "NULL"], // whole months: monthly_claims_by_supplier_service
      [null, null, "'month'"],
      ["2026-09-01T00:00:00Z", "2026-09-04T00:00:00Z", "'day'"], // rollup days: daily_claims_by_supplier_application_service
      ["2026-09-01T11:00:00Z", "2026-09-01T13:00:00Z", "NULL"], // inside one day: claim_settlements
    ]) {
      const label = `${from} ${to} ${bucket}`;
      const by = await c.query(
        `SELECT ${cols} FROM ${S}.get_supplier_earnings(ARRAY[$1], $2, $3, ${bucket}, by_service => true) WHERE service_id = $4 ORDER BY 1`,
        [top.supplier_id, from, to, top.service_id]
      );
      assert.ok(by.rows.length > 0, label);
      const kept = await c.query(
        `SELECT ${cols} FROM ${S}.get_supplier_earnings(ARRAY[$1], $2, $3, ${bucket}, services => ARRAY[$4]) ORDER BY 1`,
        [top.supplier_id, from, to, top.service_id]
      );
      assert.deepEqual(kept.rows, by.rows, label);
      const keptBy = await c.query(
        `SELECT DISTINCT service_id FROM ${S}.get_supplier_earnings(ARRAY[$1], $2, $3, ${bucket}, by_service => true, services => ARRAY[$4])`,
        [top.supplier_id, from, to, top.service_id]
      );
      assert.deepEqual(keptBy.rows, [{ service_id: top.service_id }], label);
    }
    await assert.rejects(
      c.query(`SELECT * FROM ${S}.get_supplier_earnings(NULL, NULL, NULL, services => ARRAY[]::text[])`),
      /services must have between 1 and 200 elements/
    );
    // by_application rows carry each application's gateways now; NULL without by_application
    await c.query("BEGIN");
    try {
      const app = (await c.query(`SELECT application_id FROM ${S}.claim_settlements WHERE supplier_id = $1 LIMIT 1`, [top.supplier_id]))
        .rows[0].application_id;
      await c.query(`INSERT INTO ${S}.application_gateways VALUES ('gw-b', $1, int8range(1, NULL)), ('gw-a', $1, int8range(1, NULL)),
                       ('gw-old', $1, int8range(1, 2))`, [app]);
      const gws = await c.query(
        `SELECT application_id, array_to_string(gateway_ids, ',') g FROM ${S}.get_supplier_earnings(ARRAY[$1], NULL, NULL, by_application => true)`,
        [top.supplier_id]
      );
      assert.ok(gws.rows.length > 1);
      for (const r of gws.rows) assert.equal(r.g, r.application_id === app ? "gw-a,gw-b" : "", String(r.application_id));
      const none = await c.query(`SELECT DISTINCT gateway_ids FROM ${S}.get_supplier_earnings(ARRAY[$1], NULL, NULL)`, [top.supplier_id]);
      assert.deepEqual(none.rows, [{ gateway_ids: null }]);
    } finally {
      await c.query("ROLLBACK");
    }
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
    await c.query("BEGIN");
    try {
      // the rows below go into the base tables only (not through the writer): read the base, not the rollups
      await c.query("SET LOCAL money.no_rollup = on");
      const before = await stakers();
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
      /pass one of suppliers, owners .* or operators/
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

  it("every <function>_json returns {range, data}: the rows of its function, in order, also above 1000 rows", async () => {
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
      // data has the columns of the rows but covered_from / covered_to / covered_gaps, which every row repeats and range
      // carries
      const all = (await c.query(`SELECT to_jsonb(r) j FROM ${S}.${fn}(${args}) r`, values)).rows.map(
        (r) => r.j as unknown as Record<string, unknown>
      );
      const rows = all.map((r) =>
        Object.fromEntries(
          Object.entries(r)
            .filter(([k]) => !["covered_from", "covered_to", "covered_gaps"].includes(k))
            .map(([k, v]) => [k, str(v)])
        )
      );
      const json = (await c.query(`SELECT ${S}.${fn}_json(${args}) j`, values)).rows[0].j as unknown as {
        range: Record<string, unknown>;
        data: unknown[];
      };
      assert.ok(rows.length >= min, `${fn}: ${rows.length} rows`);
      assert.deepEqual(Object.keys(json).sort(), ["data", "range"], fn);
      assert.deepEqual(json.data, rows, fn);
      assert.deepEqual(
        Object.keys(json.range).sort(),
        ["covered_from", "covered_to", "end_inclusive", "gaps", "requested_from", "requested_to"],
        fn
      );
      assert.equal(json.range.end_inclusive, false, fn);
      const ms = (v: unknown) => (v === null ? null : Date.parse(String(v)));
      assert.deepEqual(
        [ms(json.range.covered_from), ms(json.range.covered_to)],
        [ms(all[0].covered_from), ms(all[0].covered_to)],
        fn
      );
      assert.deepEqual(json.range.gaps, all[0].covered_gaps, fn);
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
        get_claims: "NULL, NULL, NULL",
        get_actor_lifecycle: "'supplier', ARRAY['sup-l'], NULL, NULL",
        get_block_stats: "NULL, NULL",
        get_relay_mining_difficulty: "ARRAY['svc-d'], NULL, NULL",
        get_created_claims: "ARRAY['sup-l'], NULL, NULL",
        get_native_transfers: "ARRAY['acc-s']",
        get_morse_claims: "NULL, NULL, NULL, NULL",
      };
      await stubEntityTables();
      assert.deepEqual(Object.keys(calls).sort(), [...CATALOG_FUNCTIONS].sort());
      const numbers = (v: unknown, path: string): string[] =>
        typeof v === "number" ? [path] : v !== null && typeof v === "object"
          ? Object.entries(v as Record<string, unknown>).flatMap(([k, x]) => numbers(x, `${path}.${k}`)) : [];
      for (const [fn, args] of Object.entries(calls)) {
        const j = (await c.query(`SELECT ${S}.${fn}_json(${args}) j`)).rows[0].j as unknown as { data: unknown[] };
        assert.ok(j.data.length > 0, fn);
        assert.deepEqual(numbers(j, fn), []);
      }
      const proofs = (
        (await c.query(`SELECT ${S}.get_supplier_proofs_json(NULL, NULL, NULL) j`)).rows[0].j as unknown as {
          data: { invalid_by_reason: Record<string, unknown> }[];
        }
      ).data;
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
      // a range that leaves part of a day's settlements out reads that day from the base: it answers (a settlement at
      // 15:00 the range leaves out)
      await c.query(`INSERT INTO ${S}.settlement_blocks (height, block_time, era, day, rollup_version)
                     SELECT 899714, '2026-09-01T15:00:00Z', era, day, ${ROLLUP_VERSION} FROM ${S}.settlement_blocks WHERE height = 899713`);
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
        // the application whose claims settled at the most heights
        get_claims: `NULL, NULL, NULL, applications => ARRAY(SELECT application_id FROM ${S}.claim_settlements
                       GROUP BY 1 ORDER BY count(DISTINCT height) DESC, 1 LIMIT 1), row_limit => 1000`,
        get_actor_lifecycle: "'supplier', ARRAY['sup-l'], '2026-09-01T11:00:00Z', '2026-09-01T13:00:00Z'",
        get_block_stats: "'2026-09-01T11:00:00Z', '2026-09-01T13:00:00Z', 'hour'",
        get_relay_mining_difficulty: "ARRAY['svc-d'], '2026-09-01T11:00:00Z', '2026-09-01T13:00:00Z'",
        get_created_claims: "ARRAY['sup-l'], '2026-09-01T11:00:00Z', '2026-09-01T13:00:00Z'",
        get_native_transfers: "ARRAY['acc-r'], NULL, '2026-09-01T11:00:00Z', '2026-09-01T13:00:00Z'",
        get_morse_claims: "NULL, NULL, '2026-09-01T11:00:00Z', '2026-09-01T13:00:00Z'",
      };
      await stubEntityTables();
      assert.deepEqual(Object.keys(calls).sort(), [...CATALOG_FUNCTIONS].sort());
      // the functions that list rows one by one order them by height
      const byHeight = [
        "get_param_history", "get_claims", "get_actor_lifecycle", "get_relay_mining_difficulty", "get_created_claims", "get_morse_claims",
        "get_native_transfers",
      ];
      for (const [fn, args] of Object.entries(calls)) {
        const col = byHeight.includes(fn) ? "height" : fn === "money_coverage" ? "first_height" : "bucket_start";
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

  it("get_supplier_earnings gives each row's first and last settled height, from the rollups as from the claims, NULL where not held", async () => {
    const q = `SELECT ${S}.get_supplier_earnings_json(NULL, $1, $2, $3, by_service => $4, by_application => $5, by_supplier => $6)::text j`;
    const both = async (args: unknown[]) => {
      const r = String((await c.query(q, args)).rows[0].j);
      await c.query("SAVEPOINT b");
      try {
        await c.query("SET LOCAL money.no_rollup = on");
        return [r, String((await c.query(q, args)).rows[0].j)];
      } finally {
        await c.query("ROLLBACK TO SAVEPOINT b");
      }
    };
    await c.query("BEGIN");
    try {
      for (const [from, to] of [
        [null, null], // whole days: the rollups' bounds
        ["2026-09-01T11:00:00Z", "2026-09-01T13:00:00Z"], // inside one day: the claims' heights
        ["2026-08-30T00:00:00Z", "2026-09-03T00:00:00Z"],
      ])
        // bucket=day takes ranges of up to 92 days
        for (const bucket of from === null ? [null, "month"] : [null, "day", "month"])
          for (const [byService, byApplication, bySupplier] of [
            [false, false, true], [false, false, false], [true, false, true], [true, false, false],
            [false, true, true], [true, true, false],
          ]) {
            const [r, b] = await both([from, to, bucket, byService, byApplication, bySupplier]);
            assert.match(b, /"last_settled_height": "\d+"/, `${from} ${to} ${bucket}`);
            assert.equal(r, b, `${from} ${to} ${bucket} service ${byService} application ${byApplication} supplier ${bySupplier}`);
          }
      // per supplier over the whole history: the lowest and highest height of its claims
      const want = (
        await c.query(`SELECT supplier_id, min(height)::text f, max(height)::text l FROM ${S}.claim_settlements GROUP BY 1 ORDER BY 1`)
      ).rows;
      const got = (
        await c.query(`SELECT supplier_id, first_settled_height::text f, last_settled_height::text l
                       FROM ${S}.get_supplier_earnings(NULL, NULL, NULL) ORDER BY 1`)
      ).rows;
      assert.deepEqual(got, want);
      // a height of 1 Sep whose bounds the rollups may not hold: every group 1 Sep is in reads NULL, the amounts as before,
      // and a range inside that day still has its heights (a settlement at 15:00 the range leaves out: the day is read from
      // the claims, an edge)
      const amounts = `SELECT supplier_id, settled_upokt::text s FROM ${S}.get_supplier_earnings(NULL, NULL, NULL) ORDER BY 1`;
      const settled = (await c.query(amounts)).rows;
      await c.query(`UPDATE ${S}.settlement_blocks SET bounds_rollup = false WHERE height = 899713`);
      const unheld = (
        await c.query(`SELECT count(*)::int n, count(last_settled_height)::int l, count(first_settled_height)::int f
                       FROM ${S}.get_supplier_earnings(NULL, NULL, NULL)`)
      ).rows[0];
      assert.ok(Number(unheld.n) > 0);
      assert.deepEqual([unheld.l, unheld.f], [0, 0]);
      assert.deepEqual((await c.query(amounts)).rows, settled);
      await c.query(`INSERT INTO ${S}.settlement_blocks (height, block_time, era, day, rollup_version)
                     SELECT 899799, '2026-09-01T15:00:00Z', era, day, rollup_version FROM ${S}.settlement_blocks WHERE height = 899713`);
      const inside = (
        await c.query(`SELECT count(*)::int n, count(last_settled_height)::int l
                       FROM ${S}.get_supplier_earnings(NULL, '2026-09-01T11:00:00Z', '2026-09-01T13:00:00Z')`)
      ).rows[0];
      assert.ok(Number(inside.n) > 0 && inside.l === inside.n, JSON.stringify(inside));
    } finally {
      await c.query("ROLLBACK");
    }
  });

  it("get_application_spend and get_gateway_spend carry the first and last settlement height of each row, as the claims", async () => {
    const apps = (await c.query(`SELECT array_agg(DISTINCT application_id) a FROM ${S}.claim_settlements`)).rows[0]
      .a as unknown as string[];
    const want = (
      await c.query(`SELECT application_id || ' ' || service_id || ' ' || min(height) || ' ' || max(height) k
                     FROM ${S}.claim_settlements GROUP BY application_id, service_id ORDER BY 1`)
    ).rows.map((r) => String(r.k));
    const spend = `SELECT application_id || ' ' || service_id || ' ' || first_settled_height || ' ' || last_settled_height k
                   FROM ${S}.get_application_spend($1, NULL, NULL, by_service => true) ORDER BY 1`;
    // every application delegates to gw-all at every height
    const gateway = `SELECT application_id || ' ' || service_id || ' ' || first_settled_height || ' ' || last_settled_height k
                     FROM ${S}.get_gateway_spend(ARRAY['gw-all'], NULL, NULL, by_application => true, by_service => true) ORDER BY 1`;
    await c.query("BEGIN");
    try {
      await c.query(`INSERT INTO ${S}.application_gateways SELECT 'gw-all', u, int8range(1, NULL) FROM unnest($1::text[]) u`, [apps]);
      for (const sql of [spend, gateway]) {
        const bind = sql === spend ? [apps] : [];
        assert.deepEqual((await c.query(sql, bind)).rows.map((r) => String(r.k)), want, "rollups");
        await c.query("SAVEPOINT b");
        await c.query("SET LOCAL money.no_rollup = on");
        assert.deepEqual((await c.query(sql, bind)).rows.map((r) => String(r.k)), want, "claims");
        await c.query("ROLLBACK TO SAVEPOINT b");
      }
      // a day whose bounds the rollups may not hold: its groups read NULL heights
      await c.query(`UPDATE ${S}.settlement_blocks SET bounds_rollup = false WHERE height = 899713`);
      const unheld = (
        await c.query(`SELECT count(*)::int n, count(last_settled_height)::int l FROM ${S}.get_application_spend($1, NULL, NULL)`, [apps])
      ).rows[0];
      assert.ok(Number(unheld.n) > 0 && Number(unheld.l) < Number(unheld.n), JSON.stringify(unheld));
    } finally {
      await c.query("ROLLBACK");
    }
  });

  it("get_supplier_earnings by service reads whole held months from monthly_claims_by_supplier_service and equals the daily path", async () => {
    await c.query("BEGIN");
    try {
      // 899713's settlement written again on 15 July (mid-day), 3 August (midnight) and 20 August: three months with claims,
      // and a month with two settlement days
      for (const [h, ts] of [
        [600013, "2026-07-15T08:30:00.000Z"],
        [650013, "2026-08-03T00:00:00.000Z"],
        [670013, "2026-08-20T18:00:00.000Z"],
      ] as const) {
        const { payload } = payloadOf("899713", true);
        payload.ts = ts;
        for (const { bind, sql } of writeSettlementCalls(S, h, payload)) await c.query(sql, bind);
      }
      // owner-m owns every supplier: more than the 200 a list takes, as the owners the explorer asks about; op-m shares
      // revenue on every other one
      const sups = (await c.query(`SELECT array_agg(DISTINCT supplier_id ORDER BY supplier_id) s FROM ${S}.claim_settlements`))
        .rows[0].s as unknown as string[];
      assert.ok(sups.length > 200, `${sups.length} suppliers`);
      await c.query(`CREATE TABLE ${S}.suppliers (id text, owner_id text, stake_status text, _block_range int8range)`);
      await c.query(`INSERT INTO ${S}.suppliers SELECT u, 'owner-m', 'Staked', int8range(1, NULL) FROM unnest($1::text[]) u`, [sups]);
      await c.query(
        `CREATE TABLE ${S}.supplier_service_configs (supplier_id text, service_id text, rev_share jsonb, _block_range int8range)`
      );
      await c.query(
        `INSERT INTO ${S}.supplier_service_configs SELECT u, 'svc', '[{"address": "op-m", "rev_share_percentage": 100}]', int8range(1, NULL)
         FROM unnest($1::text[]) WITH ORDINALITY x(u, i) WHERE i % 2 = 0`,
        [sups]
      );
      type Who = "owners" | "operators" | "every supplier";
      const json = async (from: string | null, to: string | null, bucket: string | null, bySupplier: boolean, who: Who, fill: boolean) =>
        String(
          (
            await c.query(
              `SELECT ${S}.get_supplier_earnings_json(NULL, $1, $2, $3, by_service => true, by_supplier => $4,
                 owners => CASE WHEN $5 = 'owners' THEN ARRAY['owner-m'] END,
                 operators => CASE WHEN $5 = 'operators' THEN ARRAY['op-m'] END, fill_empty_buckets => $6)::text j`,
              [from, to, bucket, bySupplier, who, fill]
            )
          ).rows[0].j
        );
      const daily = async (...args: Parameters<typeof json>) => {
        await c.query("SAVEPOINT r");
        try {
          await c.query("SET LOCAL money.no_rollup = on");
          return await json(...args);
        } finally {
          await c.query("ROLLBACK TO SAVEPOINT r");
        }
      };
      const ranges: Array<[string | null, string | null]> = [
        [null, null], // the whole history: every month whole
        ["2025-09-01T12:00:00Z", "2026-09-01T12:00:00.000001Z"], // a year, both ends mid-day
        ["2026-07-01T00:00:00Z", "2026-09-01T00:00:00Z"], // aligned: July and August whole
        ["2026-07-10T00:00:00Z", "2026-08-25T00:00:00Z"], // mid-month ends with nothing outside them: July, August whole
        ["2026-07-15T08:30:00.000001Z", "2026-08-20T18:00:00Z"], // +1 µs: July's settlement out, August's last one out
        ["2026-08-01T00:00:00Z", "2026-08-10T00:00:00Z"], // inside August, a settlement after it: no whole month
        ["2026-08-04T00:00:00Z", "2026-08-10T00:00:00Z"], // nothing settled
      ];
      for (const [from, to] of ranges)
        for (const bucket of [null, "month", "year"])
          for (const [bySupplier, who, fill] of [
            [false, "owners", false],
            [true, "owners", false],
            [false, "every supplier", false],
            [false, "operators", false],
            [true, "operators", true],
            [false, "owners", true],
          ] as Array<[boolean, Who, boolean]>) {
            const label = `${from} ${to} ${bucket} by_supplier ${bySupplier} ${who} fill_empty_buckets ${fill}`;
            const args = [from, to, bucket, bySupplier, who, fill] as const;
            const [m, d] = [await json(...args), await daily(...args)];
            assert.equal(m, d, label);
            if (from !== "2026-08-04T00:00:00Z") assert.ok(JSON.parse(d).data.length > 0, label);
          }
      // the months are read from the rollup: a changed July row changes the whole-history answer, not the daily one
      const settled = async (from: string | null, noRollup: boolean) => {
        await c.query("SAVEPOINT s");
        try {
          if (noRollup) await c.query("SET LOCAL money.no_rollup = on");
          return (
            await c.query(
              `SELECT sum(settled_upokt)::text s FROM ${S}.get_supplier_earnings(NULL, $1, NULL, by_service => true, by_supplier => false,
                 owners => ARRAY['owner-m'])`,
              [from]
            )
          ).rows[0].s as string;
        } finally {
          await c.query("ROLLBACK TO SAVEPOINT s");
        }
      };
      const want = await settled(null, true);
      const julyRows = (await c.query(`SELECT count(*)::int n FROM ${S}.monthly_claims_by_supplier_service WHERE month = '2026-07-01'`))
        .rows[0].n;
      assert.ok(Number(julyRows) > 0);
      await c.query(`UPDATE ${S}.monthly_claims_by_supplier_service SET settled_upokt = settled_upokt + 7 WHERE month = '2026-07-01'`);
      assert.equal(await settled(null, false), (BigInt(want) + BigInt(7 * Number(julyRows))).toString());
      assert.equal(await settled(null, true), want);
      // July is not whole when the range starts after its settlement: from the days
      const fromAug = await settled("2026-07-15T08:30:00.000001Z", true);
      assert.equal(await settled("2026-07-15T08:30:00.000001Z", false), fromAug);
      // a month with a height the rollup does not hold is read from the days: the marker gates it
      await c.query(`UPDATE ${S}.settlement_blocks SET monthly_claims_rollup = false WHERE height = 600013`);
      assert.equal(await settled(null, false), want);
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
        /pass one of suppliers, owners .* or operators/
      );
    } finally {
      await c.query("ROLLBACK");
    }
  });

  it("the supplier functions take operators: the Staked suppliers whose live configs share revenue with them now, no cap", async () => {
    await c.query("BEGIN");
    try {
      const sups = (
        await c.query(`SELECT array_agg(DISTINCT supplier_id ORDER BY supplier_id) s FROM ${S}.claim_settlements`)
      ).rows[0].s as unknown as string[];
      assert.ok(sups.length > 1);
      const idle = Array.from({ length: 250 }, (_, i) => `idle-${i + 1}`);
      await c.query(`CREATE TABLE ${S}.suppliers (id text, stake_status text, _block_range int8range)`);
      await c.query(
        `CREATE TABLE ${S}.supplier_service_configs (supplier_id text, service_id text, rev_share jsonb, _block_range int8range)`
      );
      // op-a shares revenue now on every supplier that settled and on 250 idle ones, next to another address; not
      // through an unstaked supplier, nor through a config that is no longer live (sups[0]'s old one, naming op-b)
      await c.query(
        `INSERT INTO ${S}.suppliers SELECT u, 'Staked', int8range(1, NULL) FROM unnest($1::text[] || $2::text[]) u
         UNION ALL SELECT 'unstaked-1', 'Unstaked', int8range(1, NULL)
         UNION ALL SELECT 'unstaked-1', 'Staked', int8range(0, 1)`,
        [sups, idle]
      );
      await c.query(
        `INSERT INTO ${S}.supplier_service_configs
         SELECT u, 'svc', jsonb_build_array(jsonb_build_object('address', 'someone', 'rev_share_percentage', 40),
                                            jsonb_build_object('address', 'op-a', 'rev_share_percentage', 60)), int8range(1, NULL)
         FROM unnest($1::text[] || $2::text[]) u
         UNION ALL SELECT 'unstaked-1', 'svc', '[{"address": "op-a", "rev_share_percentage": 100}]', int8range(1, NULL)
         UNION ALL SELECT $3, 'old', '[{"address": "op-b", "rev_share_percentage": 100}]', int8range(0, 1)`,
        [sups, idle, sups[0]]
      );
      const resolve = async (ops: string[]) =>
        (await c.query(`SELECT ${S}._operator_suppliers($1::text[]) s`, [ops])).rows[0].s as unknown as string[];
      assert.deepEqual(await resolve(["op-a", "nobody"]), [...sups, ...idle].sort());
      assert.deepEqual(await resolve(["op-b"]), []);
      // the same suppliers named by hand, in calls of at most 200
      const parts = Array.from({ length: Math.ceil(sups.length / 200) }, (_, i) => sups.slice(i * 200, i * 200 + 200));
      let claimed = BigInt(0);
      let claims = BigInt(0);
      for (const part of parts) {
        const r = (
          await c.query(
            `SELECT sum(claimed_upokt)::text a, sum(settled_claims)::text n FROM ${S}.get_supplier_earnings($1::text[], NULL, NULL)`,
            [part]
          )
        ).rows[0];
        claimed += BigInt(r.a ?? 0);
        claims += BigInt(r.n ?? 0);
      }
      const byOperator = await c.query(
        `SELECT supplier_id, claimed_upokt::text a, settled_claims::text n FROM ${S}.get_supplier_earnings(suppliers => NULL,
           range_start => NULL, range_end => NULL, operators => ARRAY['op-a'], by_supplier => false)`
      );
      assert.deepEqual(byOperator.rows, [{ supplier_id: "all", a: claimed.toString(), n: claims.toString() }]);
      // every requested supplier gets its row: the ones that settled, and the 250 idle ones
      for (const fn of ["get_supplier_earnings", "get_supplier_distribution", "get_supplier_penalties"]) {
        let named = 0;
        for (const part of parts)
          named += Number(
            (await c.query(`SELECT count(*)::int n FROM ${S}.${fn}($1::text[], NULL, NULL, fill_empty_buckets => true)`, [part]))
              .rows[0].n
          );
        const r = await c.query(
          `SELECT count(*)::int n FROM ${S}.${fn}(NULL, NULL, NULL, operators => ARRAY['op-a'], fill_empty_buckets => true)`
        );
        assert.equal(Number(r.rows[0].n) - idle.length, named, fn);
        // an operator whose suppliers are all unstaked or gone answers no rows
        const none = await c.query(`SELECT count(*)::int n FROM ${S}.${fn}(NULL, NULL, NULL, operators => ARRAY['op-b'])`);
        assert.equal(none.rows[0].n, 0, fn);
      }
      // one of suppliers, owners and operators; get_supplier_distribution needs one
      for (const fn of ["get_supplier_earnings", "get_supplier_distribution", "get_supplier_penalties", "get_supplier_proofs"]) {
        for (const args of ["ARRAY['x'], NULL, NULL, operators => ARRAY['op-a']", "NULL, NULL, NULL, owners => ARRAY['o'], operators => ARRAY['op-a']"]) {
          await c.query("SAVEPOINT a");
          await assert.rejects(c.query(`SELECT * FROM ${S}.${fn}(${args})`), /pass one of suppliers, owners .* or operators/, fn);
          await c.query("ROLLBACK TO SAVEPOINT a");
        }
      }
      await assert.rejects(
        c.query(`SELECT * FROM ${S}.get_supplier_distribution(NULL, NULL, NULL)`),
        /pass one of suppliers, owners .* or operators/
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
        -- indexed from 10:30 to 12:30: the 11:00 bucket is covered (before the first indexed block nothing is), and the
        -- series over blocks end with the 12:00 bucket
        DELETE FROM ${S}.blocks;
        INSERT INTO ${S}.blocks VALUES (600000, '2026-09-01 10:30'), (900000, '2026-09-01 12:30');`);
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
        get_block_stats: ["", "blocks"],
      };
      await stubEntityTables();
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

  it("the catalog functions answer a range that overlaps a settlement gap, and list the gap in its range", async () => {
    await c.query("BEGIN");
    try {
      await c.query(`INSERT INTO ${S}.settlement_gaps VALUES (700000, 800000);
                     INSERT INTO ${S}.blocks VALUES (699999, '2026-09-01 10:00'), (800001, '2026-09-01 11:00')`);
      const { rows } = await c.query(`SELECT * FROM ${S}.get_income(ARRAY['x'], NULL, NULL)`);
      assert.deepEqual(rows, []);
      // half-open between the covered blocks around it
      const j = (await c.query(`SELECT ${S}.get_income_json(ARRAY['x'], NULL, NULL) j`)).rows[0].j as unknown as {
        range: { gaps: Array<{ from: string; to: string }> };
        data: unknown[];
      };
      assert.deepEqual(j.data, []);
      assert.deepEqual(
        j.range.gaps.map((g) => [new Date(g.from).toISOString(), new Date(g.to).toISOString()]),
        [["2026-09-01T10:00:00.000Z", "2026-09-01T11:00:00.000Z"]]
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
