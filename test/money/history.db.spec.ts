// The history job (src/mappings/money/history) against a real PostgreSQL and a fake archive RPC/LCD that serves the
// settlement fixtures and a block with no money (only a mint) at every height near them. Run with MONEY_TEST_PG set (yarn test:money);
// without it every test is skipped.
//
// The job walks every height down to 1, so each era is walked over a short window around its fixture, each in a
// schema of its own: 899713 (batched_vrd: validators and delegations from the LCD), 710013 (detailed_batch),
// 699993 (map_all_bonded_deflation: params from the params table, bonded validators from the LCD) and 350013
// (map_proposer_operator: the proposer's operator found from the header's consensus address).
/* eslint-disable @typescript-eslint/no-floating-promises */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import * as zlib from "node:zlib";
import { sha256 } from "@cosmjs/crypto";
import { fromBech32, toBech32, toHex } from "@cosmjs/encoding";
import { createSettlementFunctionsFn } from "../../src/mappings/dbFunctions/settlement/functions";
import { createSettlementTablesFn } from "../../src/mappings/dbFunctions/settlement/schema";
import { createSettlementSmartTagsFn } from "../../src/mappings/dbFunctions/settlement/smartTags";
import { createSettlementWriterFn } from "../../src/mappings/dbFunctions/settlement/writer";
import { Chain } from "../../src/mappings/money/history/chain";
import { HistoryOptions, PgClient, planGap, RAW_EVENT_TABLES, runHistory } from "../../src/mappings/money/history/job";
import type { MapState } from "../../src/mappings/money/map";
import type { RawEvent } from "../../src/mappings/money/payload";
import { eraAtHeight } from "../../src/mappings/utils/params_history";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Client } = require("pg") as {
  Client: new (o: { connectionString?: string }) => PgClient & { connect(): Promise<void>; end(): Promise<void> };
};

const URL = process.env.MONEY_TEST_PG;
const S = "money_hist";
// the raw event tables of the indexer that the job reads
const RAW_TABLES = RAW_EVENT_TABLES.map(([table]) => table);
const FIXTURES = path.join(__dirname, "fixtures");
const HEIGHTS = [899713, 710013, 699993, 350013];
const DISCARD_HEIGHTS = [704013, 202113];
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
  "daily_income_by_address",
  "settlement_income_by_address",
  "settlement_supply_flows",
  "monthly_income_by_address_supplier",
  "monthly_income_by_address_service",
  "monthly_income_by_address_supplier_service",
  "settlement_claims_by_application_service",
  "daily_validator_rewards",
  "daily_delegator_rewards_by_validator",
];

function gz<T>(file: string): T {
  return JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString()) as T;
}

// LegacyDec atomics as the LCD prints them
function dec(atoms: string): string {
  const s = atoms.padStart(19, "0");
  return `${s.slice(0, -18)}.${s.slice(-18)}`;
}

const valoper = (account: string) => toBech32("poktvaloper", fromBech32(account).data);
const key = (seed: number) => Uint8Array.from({ length: 32 }, (_, i) => (seed * 31 + i) % 256);
const lcdValidator = (operator: string, status: string, k: Uint8Array, extra: Record<string, string> = {}) => ({
  operator_address: operator,
  consensus_pubkey: { "@type": "/cosmos.crypto.ed25519.PubKey", key: Buffer.from(k).toString("base64") },
  status,
  tokens: extra.tokens ?? "1000000",
  delegator_shares: dec(extra.shares ?? "1000000000000000000000000"),
  commission: { commission_rates: { rate: dec(extra.rate ?? "100000000000000000") } },
});
// block times in height order, with nanoseconds as CometBFT prints them
const timeOf = (h: number) =>
  new Date(Date.UTC(2025, 0, 1) + (h - 300000) * 30000).toISOString().replace(".000Z", ".123456789Z");

interface Fixture {
  height: number;
  events: RawEvent[];
  mapState?: MapState & { validatorAccounts?: string[] };
}

// The fake archive node: /block_results, /header and the two LCD routes, from the fixtures.
function fakeArchive() {
  const fixtures = new Map(HEIGHTS.map((h) => [h, gz<Fixture>(path.join(FIXTURES, `settlement_${h}.json.gz`))]));
  // blocks whose only money events are discards: nested claims (settlement_result) and flat fields (v0.1.27 on)
  for (const h of DISCARD_HEIGHTS) fixtures.set(h, gz<Fixture>(path.join(FIXTURES, `discards_${h}.json.gz`)));
  const proposerKey = key(7);
  const validators = new Map<number, unknown[]>();
  const delegations = new Map<string, unknown[]>();
  const de2 = gz<{
    validators: Array<{
      operator: string;
      tokens: string;
      delegator_shares: string;
      rate: string;
      delegations: Array<{ delegator: string; shares: string }>;
    }>;
  }>(path.join(__dirname, "../../src/mappings/money/fixtures/de2_899713.json.gz"));
  validators.set(
    899713,
    de2.validators.map((v, i) =>
      lcdValidator(v.operator, "BOND_STATUS_BONDED", key(100 + i), {
        tokens: v.tokens,
        shares: v.delegator_shares,
        rate: v.rate,
      })
    )
  );
  for (const v of de2.validators) {
    delegations.set(
      `899713|${v.operator}`,
      v.delegations.map((d) => ({
        delegation: { delegator_address: d.delegator, validator_address: v.operator, shares: dec(d.shares) },
      }))
    );
  }
  // the real snapshots at the replayed heights (test/money/fixtures/replay_<h>.json.gz, read from sauron's LCD): the
  // bonded validators and every delegation with its balance, so the job's replay reproduces the chain's amounts
  const snapshot = (h: number) =>
    gz<{
      input: {
        validators: Array<{
          operator: string;
          account: string;
          tokens: string;
          delegatorShares: string;
          delegations: Array<{ delegator: string; shares: string; balance?: string }>;
        }>;
        proposer?: { operator: string; account: string; tokens: string; delegatorShares: string };
      };
    }>(path.join(FIXTURES, `replay_${h}.json.gz`)).input;
  for (const h of [699993, 710013, 350013]) {
    const real = snapshot(h);
    validators.set(
      h,
      real.validators.map((v, i) =>
        lcdValidator(
          v.operator,
          "BOND_STATUS_BONDED",
          // 350013's proposer is found by the header's consensus address: give it the key the header names
          v.operator === real.proposer?.operator ? proposerKey : key(200 + i),
          { tokens: v.tokens, shares: v.delegatorShares }
        )
      )
    );
    for (const v of real.validators) {
      delegations.set(
        `${h}|${v.operator}`,
        v.delegations.map((d) => ({
          delegation: { delegator_address: d.delegator, validator_address: v.operator, shares: dec(d.shares) },
          balance: d.balance === undefined ? undefined : { denom: "upokt", amount: d.balance },
        }))
      );
    }
    const p = real.proposer;
    if (p && !real.validators.some((v) => v.operator === p.operator)) {
      // the proposer, found by its consensus address in any status
      (validators.get(h) as unknown[]).push(
        lcdValidator(p.operator, "BOND_STATUS_UNBONDING", proposerKey, { tokens: p.tokens, shares: p.delegatorShares })
      );
    }
  }
  // not bonded: never a staker
  (validators.get(699993) as unknown[]).push(
    lcdValidator(valoper("pokt1ptu925yug3spwxrp9vzzgtkgtg7hgx5jt4jzp0"), "BOND_STATUS_UNBONDING", key(300))
  );

  // what the fake does wrong, per height
  const state = {
    failing: new Set<number>(), // block_results answers 500
    headerFailing: new Set<number>(), // /header answers 500
    otherHeight: new Set<number>(), // /header answers for height + 1
    brOtherHeight: new Set<number>(), // /block_results answers for height + 1
    lcdOtherHeight: new Set<number>(), // the LCD answers for height + 1
    repeatKey: false, // the LCD's second validators page repeats the first page's next_key
    noEvents: new Set<number>(), // block_results without finalize_block_events
    nullEvents: new Set<number>(), // block_results with finalize_block_events: null
    emptyEvents: new Set<number>(), // block_results with finalize_block_events: []
    noMint: new Set<number>(), // a block without the mint of its BeginBlock
    blockResults: new Map<number, number>(),
    delegationReads: new Map<number, number>(),
    validatorPages: 0,
  };
  const send = (res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { "content-type": "application/json", ...headers });
    res.end(JSON.stringify(body));
  };
  // the LCD reports the height it served, as sauron-api does (x-cosmos-block-height in the response)
  const lcd = (res: http.ServerResponse, height: number, body: unknown) =>
    send(res, 200, body, { "x-cosmos-block-height": String(state.lcdOtherHeight.has(height) ? height + 1 : height) });
  const server = http.createServer((req, res) => {
    const url = new globalThis.URL(req.url ?? "", "http://x");
    const height = Number(url.searchParams.get("height") ?? req.headers["x-cosmos-block-height"]);
    const fx = fixtures.get(height);
    const answered = String(state.otherHeight.has(height) ? height + 1 : height);
    if (url.pathname === "/status") {
      return send(res, 200, {
        jsonrpc: "2.0",
        id: -1,
        result: { node_info: { network: "pocket" }, sync_info: { latest_block_height: "950000" } },
      });
    }
    // every height within 30 of a fixture is a block: the fixture's events, or a block with no money (a mint)
    const near = [...fixtures.keys()].some((f) => Math.abs(f - height) <= 30);
    if (url.pathname === "/block_results" && near) {
      state.blockResults.set(height, (state.blockResults.get(height) ?? 0) + 1);
      if (state.failing.has(height)) return send(res, 500, { error: "archive node unavailable" });
      // every block starts with the mint of its BeginBlock, as on mainnet, unless a test takes it out
      const mint = state.noMint.has(height)
        ? []
        : [{ type: "mint", attributes: [{ key: "amount", value: "1", index: true }] }];
      const events = [
        ...mint,
        ...(fx
          ? fx.events.map((e) => ({ type: e.type, attributes: e.attributes.map((a) => ({ ...a, index: true })) }))
          : [{ type: "coin_spent", attributes: [{ key: "spender", value: "pokt1mint", index: true }] }]),
      ];
      const result: Record<string, unknown> = {
        height: String(state.brOtherHeight.has(height) ? height + 1 : height),
        txs_results: null,
        finalize_block_events: state.nullEvents.has(height) ? null : state.emptyEvents.has(height) ? [] : events,
        validator_updates: [],
        consensus_param_updates: null,
        app_hash: "",
      };
      if (state.noEvents.has(height)) delete result.finalize_block_events;
      return send(res, 200, { jsonrpc: "2.0", id: -1, result });
    }
    if (url.pathname === "/header" && fx) {
      if (state.headerFailing.has(height)) return send(res, 500, { error: "header unavailable" });
      const proposer = height === 350013 ? sha256(proposerKey).slice(0, 20) : key(height % 97).slice(0, 20);
      return send(res, 200, {
        jsonrpc: "2.0",
        id: -1,
        result: {
          header: {
            chain_id: "pocket",
            height: answered,
            time: timeOf(height),
            proposer_address: toHex(proposer).toUpperCase(),
          },
        },
      });
    }
    // the preflight asks for one validator, at any height
    if (url.pathname === "/cosmos/staking/v1beta1/validators" && url.searchParams.get("pagination.limit") === "1") {
      return lcd(res, height, {
        validators: [
          lcdValidator(valoper("pokt1ptu925yug3spwxrp9vzzgtkgtg7hgx5jt4jzp0"), "BOND_STATUS_BONDED", key(1)),
        ],
        pagination: {},
      });
    }
    if (url.pathname === "/cosmos/staking/v1beta1/validators" && validators.has(height)) {
      const all = validators.get(height) as unknown[];
      // two pages: the first half with next_key "p2", then the rest
      state.validatorPages++;
      const half = Math.ceil(all.length / 2);
      if (url.searchParams.get("pagination.key") !== "p2") {
        return lcd(res, height, { validators: all.slice(0, half), pagination: { next_key: "p2" } });
      }
      return lcd(res, height, { validators: all.slice(half), pagination: { next_key: state.repeatKey ? "p2" : null } });
    }
    const m = /^\/cosmos\/staking\/v1beta1\/validators\/([^/]+)\/delegations$/.exec(url.pathname);
    if (m && delegations.has(`${height}|${m[1]}`)) {
      return lcd(res, height, {
        delegation_responses: delegations.get(`${height}|${m[1]}`),
        pagination: { next_key: null },
      });
    }
    // any other validator of a served height: its self-delegation
    if (m && validators.has(height)) {
      state.delegationReads.set(height, (state.delegationReads.get(height) ?? 0) + 1);
      const account = toBech32("pokt", fromBech32(m[1]).data);
      return lcd(res, height, {
        delegation_responses: [
          {
            delegation: {
              delegator_address: account,
              validator_address: m[1],
              shares: dec("1000000000000000000000000"),
            },
          },
        ],
        pagination: { next_key: null },
      });
    }
    send(res, 404, { error: `not served: ${req.url} at ${height}` });
  });
  return { server, state, fixtures };
}

describe("settlement history job (PostgreSQL)", { skip: !URL && "MONEY_TEST_PG not set" }, () => {
  const c = new Client({ connectionString: URL });
  const reader = new Client({ connectionString: URL });
  const archive = fakeArchive();
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "money-history-"));
  const lines: string[] = [];
  let base = "";
  const SD = `${S}_d`;
  const SM5 = `${S}_m5`;
  const SM3 = `${S}_m3`;
  const SX = `${S}_discards`;
  const SE = `${S}_e0`;

  // null: no cache
  const chain = async (cache: string | null = cacheDir) =>
    new Chain({ rpc: base, lcd: base, cacheDir: cache ?? undefined, retries: 1 }).open();
  // the indexer's money step started one above the job's start (money_progress), as it does before a job runs
  const run = async (o: Partial<HistoryOptions> = {}, client: PgClient = c) => {
    if (o.start !== undefined)
      await c.query(`INSERT INTO ${o.schema ?? S}.money_progress VALUES (true, $1, $1) ON CONFLICT (id) DO NOTHING`, [
        o.start + 1,
      ]);
    return runHistory(client, {
      schema: S,
      chain: await chain(),
      reader,
      log: (l) => lines.push(l),
      env: {},
      ...o,
    });
  };
  const gaps = async (schema = S) =>
    (await c.query(`SELECT from_height::int f, to_height::int t FROM ${schema}.settlement_gaps ORDER BY 1`)).rows;
  const written = async (schema = S) =>
    (await c.query(`SELECT height::int h FROM ${schema}.settlement_blocks ORDER BY 1 DESC`)).rows.map((r) => r.h);
  const md5All = async (schema = S, tables = TABLES) => {
    const parts: string[] = [];
    for (const t of tables) {
      const r = await c.query(
        `SELECT count(*) n, coalesce(md5(string_agg(x::text, '|' ORDER BY x::text)), '') h FROM ${schema}.${t} x`
      );
      parts.push(`${t}:${r.rows[0].n}:${r.rows[0].h}`);
    }
    return parts.join(" ");
  };
  const md5NoGaps = async (schema = S) =>
    md5All(
      schema,
      TABLES.filter((t) => t !== "settlement_gaps")
    );

  // the income per (address, role, family) a height wrote equals the expectation summed from the raw legs
  const assertIncome = async (schema: string, h: number) => {
    const expected = JSON.parse(fs.readFileSync(path.join(FIXTURES, `settlement_${h}.expected.json`), "utf8")) as {
      claims: number;
      income: Record<string, string>;
    };
    const got = await c.query(
      `SELECT address || '|' || role || '|' || family AS k, sum(amount_upokt)::text AS a FROM ${schema}.v_income_base WHERE height = $1 GROUP BY 1`,
      [h]
    );
    assert.deepEqual(Object.fromEntries(got.rows.map((x) => [x.k, x.a])), expected.income, String(h));
    const b = await c.query(
      `SELECT era, block_time, (SELECT count(*)::int FROM ${schema}.claim_settlements WHERE height = $1) claims
       FROM ${schema}.settlement_blocks WHERE height = $1`,
      [h]
    );
    assert.equal(b.rows[0].era, eraAtHeight("pocket", h));
    assert.equal(b.rows[0].claims, expected.claims);
    assert.equal((b.rows[0].block_time as Date).getTime(), Date.UTC(2025, 0, 1) + (h - 300000) * 30000 + 123);
  };

  const makeSchema = async (schema: string) => {
    await c.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE; CREATE SCHEMA ${schema};`);
    await c.query(createSettlementTablesFn(schema));
    await c.query(createSettlementWriterFn(schema));
    await c.query(`
      ${RAW_TABLES.map((t) => `CREATE TABLE ${schema}.${t} (block_id numeric);`).join("\n")}
      CREATE TABLE ${schema}.blocks (id numeric, timestamp timestamp);
      CREATE TABLE ${schema}.application_gateways (gateway_id text, application_id text, _block_range int8range);
      CREATE TABLE ${schema}.params (id text, namespace text, key text, value text, active_at numeric, _block_range int8range);
      CREATE TABLE ${schema}.delegations (id text);
`);
    // the raw tables hold what each fixture block emitted, so the cross-check finds nothing unless a test says so
    for (const [h, fx] of archive.fixtures) {
      for (const [table, event] of RAW_EVENT_TABLES) {
        const n = fx.events.filter((e) => e.type === event).length;
        if (n > 0)
          await c.query(`INSERT INTO ${schema}.${table} SELECT $1::numeric FROM generate_series(1, $2)`, [h, n]);
      }
    }
    // detailed_batch reads the proposer's share of the relay mint for the replay (rebuilt_v3.tsv at 710,013)
    for (const [k, v] of [
      [
        "mint_equals_burn_claim_distribution",
        '{"dao":0.045,"proposer":0.14,"supplier":0.79,"source_owner":0.025,"application":0}',
      ],
      ["mint_allocation_percentages", '{"dao":0.1,"proposer":0,"supplier":0.8,"source_owner":0.1,"application":0}'],
      ["global_inflation_per_claim", "0.000001"],
      ["mint_ratio", "0.975"],
      ["dao_reward_address", "pokt1dr5jtqaaz4wk8wevl33e7vkxsjlphljnjhyq2l"],
    ]) {
      await c.query(
        `INSERT INTO ${schema}.params VALUES ($1, 'tokenomics', $2, $3, 703870, int8range(703870, 788945))`,
        [`tokenomics-${k}`, k, v]
      );
    }
    // the tokenomics params of each map height, one version whose block range holds it
    for (const h of [699993, 350013]) {
      const st = archive.fixtures.get(h)?.mapState as MapState;
      const json = (sh: Record<string, string>) =>
        JSON.stringify(Object.fromEntries(Object.entries(sh).map(([k, v]) => [k, Number(v)])));
      const values: Record<string, string> = {
        mint_equals_burn_claim_distribution: json(st.meb as unknown as Record<string, string>),
        mint_allocation_percentages: json(st.mintAlloc as unknown as Record<string, string>),
        global_inflation_per_claim: st.globalInflation,
        mint_ratio: st.mintRatio,
        dao_reward_address: st.dao,
      };
      for (const [k, v] of Object.entries(values)) {
        // the version in force starts exactly at the height; the one before it ends there and is wrong on purpose
        const before = k === "dao_reward_address" ? "pokt1wrongdao" : k === "mint_ratio" ? "0.5" : v;
        await c.query(
          `INSERT INTO ${schema}.params VALUES
             ($1, 'tokenomics', $2, $3, $4::numeric, int8range($4::bigint, $4::bigint + 10)),
             ($1, 'tokenomics', $2, $5, $4::numeric - 50, int8range($4::bigint - 50, $4::bigint))`,
          [`tokenomics-${k}`, k, v, h, before]
        );
      }
    }
    await c.query(createSettlementFunctionsFn(schema));
    await c.query(createSettlementSmartTagsFn(schema));
  };

  before(async () => {
    await new Promise<void>((r) => archive.server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(archive.server.address() as AddressInfo).port}`;
    await c.connect();
    await reader.connect();
    for (const schema of [S, SD, SM5, SM3, SX, SE]) await makeSchema(schema);
  });
  after(async () => {
    for (const schema of [S, SD, SM5, SM3, SX, SE]) await c.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await c.end();
    await reader.end();
    archive.server.close();
    fs.rmSync(cacheDir, { recursive: true, force: true });
  });

  it("refuses to start without a money_progress row (the indexer creates it)", async () => {
    await assert.rejects(run(), /money_progress has no row/);
    assert.deepEqual(await gaps(), []);
  });

  it("checks that the LCD serves the lowest height that needs it before recording anything", async () => {
    archive.state.lcdOtherHeight.add(899705);
    await assert.rejects(run({ start: 899720, to: 899705 }), /asked for height 899705, the LCD answered for 899706/);
    archive.state.lcdOtherHeight.clear();
    assert.deepEqual(await gaps(), []);
  });

  it("walks every height, writes the one with money, and lowers the gap below what it has walked", async () => {
    const pages = archive.state.validatorPages;
    const r = await run({ start: 899720, to: 899705 });
    // 899720 down to 899705: 16 heights, one with money
    assert.deepEqual(r, { written: [899713], noMoney: 15, discards: 0, findings: 0, mintless: 0, unattributed: {} });
    assert.deepEqual(await gaps(), [{ f: 1, t: 899704 }]);
    assert.deepEqual(await written(), [899713]);
    await assertIncome(S, 899713);
    // 899713 has delegator × validator rows from the LCD snapshot (260 pairs, as in writer.db.spec.ts)
    const dv = await c.query(`SELECT count(*)::int n FROM ${S}.delegator_validator_payouts WHERE height = 899713`);
    assert.equal(dv.rows[0].n, 260);
    // the validators came in two LCD pages
    assert.equal(archive.state.validatorPages - pages, 2);
    // the heights with no money are not cached; the money height is
    const cached = fs.readdirSync((await chain()).cache as string).filter((f) => f.includes(".events."));
    assert.deepEqual(
      cached.map((f) => f.split(".")[0]),
      ["899713"]
    );
  });

  it("lowers the gap for heights with no money in batches, never below a height it has not classified", async () => {
    // 899704 down: the block at 899696 fails after eight heights with no money, with batches of three
    archive.state.failing.add(899696);
    const r = await run({ to: 899690, flushEvery: 3, chain: await chain(null) });
    archive.state.failing.clear();
    assert.equal(r.failed?.height, 899696);
    assert.match(r.failed?.error ?? "", /HTTP 500/);
    assert.equal(r.noMoney, 8);
    // every classified height above the failing one is covered, the failing one is not
    assert.deepEqual(await gaps(), [{ f: 1, t: 899696 }]);
    assert.ok(
      lines.some(
        (l) => l === "[history] covered down to 899702 (3 heights with no money event since the last lowering)"
      )
    );
  });

  it("stops at a block whose finalize_block_events is absent, null or empty: every real block has a mint", async () => {
    for (const [mode, expect] of [
      ["noEvents", /block_results at height 899696 has no finalize_block_events/],
      ["nullEvents", /block_results at height 899696: empty finalize_block_events: real blocks have at least a mint/],
      ["emptyEvents", /block_results at height 899696: empty finalize_block_events: real blocks have at least a mint/],
    ] as const) {
      archive.state[mode].add(899696);
      const r = await run({ to: 899690, chain: await chain(null) });
      archive.state[mode].clear();
      assert.equal(r.failed?.height, 899696, mode);
      assert.equal(r.failed?.stage, "height");
      assert.match(r.failed?.error ?? "", expect);
      assert.deepEqual(await gaps(), [{ f: 1, t: 899696 }]);
    }
    // a chain whose blocks can be empty says so
    archive.state.emptyEvents.add(899696);
    archive.state.noEvents.add(899694);
    const allowed = await new Chain({ rpc: base, lcd: base, retries: 1, allowEmptyBlocks: true }).open();
    const r = await run({ to: 899690, chain: allowed });
    archive.state.emptyEvents.clear();
    archive.state.noEvents.clear();
    assert.equal(r.failed?.height, 899694);
    assert.equal(r.noMoney, 2);
    assert.deepEqual(await gaps(), [{ f: 1, t: 899694 }]);
  });

  it("stops at a block_results for another height, then a rerun resumes from the gap to the end of the range", async () => {
    archive.state.brOtherHeight.add(899694);
    const r = await run({ to: 899690, chain: await chain(null) });
    archive.state.brOtherHeight.clear();
    assert.equal(r.failed?.error, "[history] block_results: asked for height 899694, the node answered for 899695");
    assert.deepEqual(await run({ to: 899690 }), {
      written: [],
      noMoney: 5,
      discards: 0,
      findings: 0,
      mintless: 0,
      unattributed: {},
    });
    assert.deepEqual(await gaps(), [{ f: 1, t: 899689 }]);
  });

  it("rewriting a walked range leaves every table identical, and a dry run keeps nothing", async () => {
    const before = await md5NoGaps();
    await c.query(`UPDATE ${S}.settlement_gaps SET to_height = 899720`);
    assert.deepEqual(await run({ to: 899705, dryRun: true }), {
      written: [899713],
      noMoney: 15,
      discards: 0,
      findings: 0,
      mintless: 0,
      unattributed: {},
    });
    assert.deepEqual(await gaps(), [{ f: 1, t: 899720 }]);
    assert.equal(await md5NoGaps(), before);
    assert.deepEqual(await run({ to: 899705 }), {
      written: [899713],
      noMoney: 15,
      discards: 0,
      findings: 0,
      mintless: 0,
      unattributed: {},
    });
    assert.equal(await md5NoGaps(), before);
    // the start is always one below money_progress.from_height (lowered by the walk to 899690): anything else would
    // leave heights uncovered
    await c.query(`DELETE FROM ${S}.settlement_gaps`);
    await assert.rejects(run({ start: 5 }), /--start must be 899689/);
    await c.query(`INSERT INTO ${S}.settlement_gaps VALUES (1, 899689)`);
  });

  it("owns only its row: an override hole over the history range is not its territory", async () => {
    const opts = { schema: S } as unknown as Parameters<typeof planGap>[1];
    await c.query(`DELETE FROM ${S}.settlement_gaps`);
    await c.query(`INSERT INTO ${S}.settlement_gaps VALUES (1, 300000), (299000, 899689)`);
    assert.deepEqual(await planGap(c, opts), { top: 300000, create: false });
    await c.query(`DELETE FROM ${S}.settlement_gaps WHERE from_height = 1`);
    // (no row of its own: it would start one below money_progress.from_height)
    assert.deepEqual(await planGap(c, opts), { top: 899689, create: true });
    await c.query(`DELETE FROM ${S}.settlement_gaps`);
    await c.query(`INSERT INTO ${S}.settlement_gaps VALUES (1, 899689)`);
  });

  it("detailed_batch: writes 710013 with its expiration, and a CALL failing inside it leaves the tables as they were", async () => {
    const before = await md5NoGaps(SD);
    const failing: PgClient = {
      query: async (sql, params) => {
        const r = await c.query(sql, params);
        if (sql.includes(".write_settlement(") && params?.[0] === 710013) throw new Error("injected after the CALL");
        return r;
      },
    };
    const r1 = await run({ schema: SD, start: 710016, to: 710010 }, failing);
    assert.equal(r1.failed?.height, 710013);
    assert.equal(r1.failed?.era, "detailed_batch");
    assert.match(r1.failed?.error ?? "", /injected after the CALL/);
    assert.equal(await md5NoGaps(SD), before);
    // the three heights with no money above it are covered, 710013 is not
    assert.deepEqual(await gaps(SD), [{ f: 1, t: 710013 }]);
    assert.deepEqual(await run({ schema: SD, to: 710010 }), {
      written: [710013],
      noMoney: 3,
      discards: 0,
      findings: 0,
      mintless: 0,
      unattributed: {},
    });
    await assertIncome(SD, 710013);
    const exp = await c.query(`SELECT estimated_relays::text n FROM ${SD}.claim_expirations WHERE height = 710013`);
    assert.deepEqual(exp.rows, [{ n: "51366" }]);
  });

  it("map_all_bonded_deflation: 699993 reads the params version that starts at it, and a stop waits for the prefetch", async () => {
    let inflight = 0;
    const counting: PgClient = {
      query: async (sql, params) => {
        inflight++;
        try {
          // slow params reads keep the prefetch running when the height above stops the job
          if (sql.includes(".params ")) await new Promise((res) => setTimeout(res, 3000));
          return await reader.query(sql, params);
        } finally {
          inflight--;
        }
      },
    };
    archive.state.failing.add(699995);
    const r1 = await run({
      schema: SM5,
      start: 699999,
      to: 699990,
      workers: 4,
      reader: counting,
      chain: await chain(null),
    });
    archive.state.failing.clear();
    assert.equal(r1.failed?.height, 699995);
    assert.equal(inflight, 0);
    assert.deepEqual(await gaps(SM5), [{ f: 1, t: 699995 }]);
    assert.deepEqual(await run({ schema: SM5, to: 699990 }), {
      written: [699993],
      noMoney: 5,
      discards: 0,
      findings: 0,
      mintless: 0,
      unattributed: {},
    });
    await assertIncome(SM5, 699993);
  });

  it("map_proposer_operator: 350013 finds its proposer's operator from the header's consensus address", async () => {
    assert.deepEqual(await run({ schema: SM3, start: 350016, to: 350010 }), {
      written: [350013],
      noMoney: 6,
      discards: 0,
      findings: 0,
      mintless: 0,
      unattributed: {},
    });
    await assertIncome(SM3, 350013);
    assert.deepEqual(await gaps(SM3), [{ f: 1, t: 350009 }]);
    assert.ok(lines.some((l) => /^\[history\] height=350013 era=map_proposer_operator .* md5=[0-9a-f]{32}$/.test(l)));
  });

  it("refuses an LCD whose next_key repeats", async () => {
    archive.state.repeatKey = true;
    await assert.rejects((await chain(null)).validators(899713), /next_key p2 repeats/);
    archive.state.repeatKey = false;
  });

  it("writes a height whose only money events are discards, flat (detailed_batch) or with the claim nested (settlement_result)", async () => {
    assert.deepEqual(await run({ schema: SX, start: 704016, to: 704010 }), {
      written: [704013],
      noMoney: 6,
      discards: 57,
      findings: 0,
      mintless: 0,
      unattributed: {},
    });
    assert.deepEqual(await run({ schema: SE, start: 202116, to: 202110 }), {
      written: [202113],
      noMoney: 6,
      discards: 40,
      findings: 0,
      mintless: 0,
      unattributed: {},
    });
    for (const [schema, h, era, n] of [
      [SX, 704013, "detailed_batch", 57],
      [SE, 202113, "settlement_result", 40],
    ] as const) {
      const r = await c.query(
        `SELECT (SELECT era FROM ${schema}.settlement_blocks WHERE height = $1) era,
                (SELECT count(*)::int FROM ${schema}.claim_discards WHERE height = $1) discards,
                (SELECT count(*)::int FROM ${schema}.claim_settlements WHERE height = $1) claims`,
        [h]
      );
      assert.deepEqual(r.rows, [{ era, discards: n, claims: 0 }]);
    }
  });

  it("keeps the bonded validators and their delegations of the replay eras in the cache", async () => {
    const dir = (await chain()).cache as string;
    const files = fs.readdirSync(dir);
    for (const h of [710013, 699993, 350013]) {
      assert.ok(files.includes(`${h}.validators.json.gz`), String(h));
      assert.ok(
        files.some((f) => f.startsWith(`${h}.delegations.`)),
        String(h)
      );
    }
    // 699993: 20 bonded validators, the delegations of each kept (the unbonding one's are not read)
    assert.equal(files.filter((f) => f.startsWith("699993.delegations.")).length, 20);
    // and the replay wrote their rows: no family unattributed at any of them
    assert.ok(
      lines.some((l) => /^\[history\] height=699993 era=map_all_bonded_deflation .* replay=relay:replay /.test(l))
    );
    assert.ok(
      lines.some((l) => /^\[history\] height=710013 era=detailed_batch .* replay=relay:derived_split /.test(l))
    );
    assert.ok(
      lines.some((l) => /^\[history\] height=350013 era=map_proposer_operator .* replay=relay:replay /.test(l))
    );
    assert.ok(
      lines.some((l) => /^\[history\] height=699993 era=map_all_bonded_deflation .* snapshot=20\/589 /.test(l))
    );
    assert.ok(lines.some((l) => /^\[history\] height=710013 era=detailed_batch .* snapshot=20\/588 /.test(l)));
    // and the database records which money heights have their snapshot, with its counts
    for (const [schema, h, era, bonded, delegations] of [
      [SD, 710013, "detailed_batch", 20, 588],
      [SM5, 699993, "map_all_bonded_deflation", 20, 589],
      [SM3, 350013, "map_proposer_operator", 6, 26],
      [SX, 704013, null, null, null],
    ] as const) {
      const r = await c.query(
        `SELECT era, bonded, delegations FROM ${schema}.settlement_replay_snapshots WHERE height = $1`,
        [h]
      );
      assert.deepEqual(r.rows, era === null ? [] : [{ era, bonded, delegations }], String(h));
    }
  });

  it("stops where a raw table has more rows than the block has events, and records where it has fewer", async () => {
    const before = await md5NoGaps();
    // an expiration the indexer holds at 899716, where the block has none: the walk stops there
    await c.query(`UPDATE ${S}.settlement_gaps SET to_height = 899720`);
    await c.query(`INSERT INTO ${S}.event_claim_expireds VALUES (899716)`);
    const r = await run({ to: 899705 });
    assert.equal(r.failed?.height, 899716);
    assert.match(
      r.failed?.error ?? "",
      /the indexer's event_claim_expireds has 1 rows at height 899716, the block has 0 pocket.tokenomics.EventClaimExpired/
    );
    assert.deepEqual(await gaps(), [{ f: 1, t: 899716 }]);
    await c.query(`DELETE FROM ${S}.event_claim_expireds WHERE block_id = 899716`);
    // the indexer lacks 899713's settled claims: the height is written and the gap recorded
    const settled = await c.query(`SELECT count(*)::int n FROM ${S}.event_claim_settleds WHERE block_id = 899713`);
    await c.query(`DELETE FROM ${S}.event_claim_settleds WHERE block_id = 899713`);
    const from = lines.length;
    assert.deepEqual(await run({ to: 899705 }), {
      written: [899713],
      noMoney: 11,
      discards: 0,
      findings: 1,
      mintless: 0,
      unattributed: {},
    });
    const found = await c.query(
      `SELECT height::int h, event_type t, chain_count c, raw_count r FROM ${S}.settlement_history_findings`
    );
    assert.deepEqual(found.rows, [{ h: 899713, t: "pocket.tokenomics.EventClaimSettled", c: settled.rows[0].n, r: 0 }]);
    assert.ok(
      lines
        .slice(from)
        .includes(
          `[history] FINDING height=899713 type=pocket.tokenomics.EventClaimSettled chain=${settled.rows[0].n} raw=0`
        )
    );
    assert.equal(await md5NoGaps(), before);
    await c.query(`INSERT INTO ${S}.event_claim_settleds SELECT 899713 FROM generate_series(1, $1)`, [
      settled.rows[0].n,
    ]);
    await c.query(`DELETE FROM ${S}.settlement_history_findings`);
    await c.query(`UPDATE ${S}.settlement_gaps SET to_height = 899689`);
  });

  it("runs one job per schema: a second one is refused while the first holds the session lock", async () => {
    const other = new Client({ connectionString: URL });
    await other.connect();
    try {
      await other.query("SELECT pg_advisory_lock(hashtext($1))", [`pocketdex.history.${S}`]);
      await assert.rejects(run({ to: 899689 }), /another history job holds the lock for schema money_hist/);
      await other.query("SELECT pg_advisory_unlock(hashtext($1))", [`pocketdex.history.${S}`]);
      // released: the job runs, and releases it in turn
      assert.deepEqual(await run({ to: 899689 }), {
        written: [],
        noMoney: 1,
        discards: 0,
        findings: 0,
        mintless: 0,
        unattributed: {},
      });
      const held = await other.query("SELECT pg_try_advisory_lock(hashtext($1)) ok", [`pocketdex.history.${S}`]);
      assert.equal(held.rows[0].ok, true);
    } finally {
      await other.end();
    }
  });

  it("a money height amid a long run of heights with no money lowers the gap over them, and a failure right after keeps it", async () => {
    const before = await md5NoGaps();
    await c.query(`UPDATE ${S}.settlement_gaps SET to_height = 899720`);
    archive.state.failing.add(899712);
    // no batch lowers the gap before 899713: only its transaction does, over the seven heights above it
    const r = await run({ to: 899705, workers: 4, flushEvery: 1000, chain: await chain(null) });
    archive.state.failing.clear();
    assert.deepEqual(r.written, [899713]);
    assert.equal(r.noMoney, 7);
    assert.deepEqual(r.failed && [r.failed.stage, r.failed.height], ["height", 899712]);
    assert.deepEqual(await gaps(), [{ f: 1, t: 899712 }]);
    assert.equal(await md5NoGaps(), before);
    await c.query(`UPDATE ${S}.settlement_gaps SET to_height = 899688`);
  });

  it("stops with stage gap when lowering the gap over heights with no money fails, and warns of a block without its mint", async () => {
    const failing: PgClient = {
      query: async (sql, params) => {
        if (sql.includes("UPDATE") && sql.includes(".settlement_gaps")) throw new Error("injected gap failure");
        return c.query(sql, params);
      },
    };
    archive.state.noMint.add(899687);
    const from = lines.length;
    const r = await run({ to: 899680, flushEvery: 3 }, failing);
    archive.state.noMint.clear();
    assert.deepEqual(r.failed, { stage: "gap", height: 899686, error: "injected gap failure" });
    assert.equal(r.mintless, 1);
    assert.deepEqual(await gaps(), [{ f: 1, t: 899688 }]);
    const tail = lines.slice(from);
    assert.ok(
      tail.includes(
        "[history] STOPPED lowering the gap over the heights with no money down to 899686: injected gap failure"
      )
    );
    assert.ok(
      tail.includes("[history] WARNING height=899687: no mint event in finalize_block_events (truncated response?)")
    );
  });

  it("a rewrite replaces the findings and snapshot rows an earlier run left for the height", async () => {
    await c.query(`UPDATE ${S}.settlement_gaps SET to_height = 899720`);
    await c.query(`INSERT INTO ${S}.settlement_history_findings (height, event_type, chain_count, raw_count)
                   VALUES (899713, 'pocket.tokenomics.EventClaimExpired', 9, 0)`);
    await c.query(`INSERT INTO ${S}.settlement_replay_snapshots (height, era, bonded, delegations)
                   VALUES (899713, 'detailed_batch', 1, 1)`);
    assert.deepEqual((await run({ to: 899705 })).written, [899713]);
    for (const t of ["settlement_history_findings", "settlement_replay_snapshots"]) {
      const r = await c.query(`SELECT count(*)::int n FROM ${S}.${t} WHERE height = 899713`);
      assert.equal(r.rows[0].n, 0, t);
    }
    await c.query(`UPDATE ${S}.settlement_gaps SET to_height = 899688`);
  });

  it("hides the two job tables from the GraphQL API", async () => {
    for (const t of ["settlement_history_findings", "settlement_replay_snapshots"]) {
      const r = await c.query(`SELECT obj_description($1::regclass, 'pg_class') d`, [`${S}.${t}`]);
      assert.equal(r.rows[0].d, "@omit", t);
    }
  });
});
