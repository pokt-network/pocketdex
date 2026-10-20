// staked_suppliers_daily / get_staked_suppliers_by_service and supply_daily / get_supply / get_supply_composition,
// checked against the old functions they replace (get_amount_of_blocks_and_suppliers_by_times,
// get_supply_composition_between_dates, get_total_supply_by_day) on the same seeded tables.
//   MONEY_TEST_PG=postgres://postgres:postgres@127.0.0.1:5432/postgres yarn test:money
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { after, before, describe, it } from "node:test";
import path from "node:path";
import { upsertSuppliersByBlockAndServiceFn } from "../../src/mappings/dbFunctions/reports/suppliers";
import { createSupplierRevShareWalletsFn } from "../../src/mappings/dbFunctions/revShareWallets";
import { getAmountOfBlocksAndSuppliersByTimesFn } from "../../src/mappings/dbFunctions/servicePerformance";
import { createSettlementFunctionsFn } from "../../src/mappings/dbFunctions/settlement/functions";
import { createSettlementTablesFn } from "../../src/mappings/dbFunctions/settlement/schema";
import { createSettlementSmartTagsFn } from "../../src/mappings/dbFunctions/settlement/smartTags";
import { createSettlementWriterFn } from "../../src/mappings/dbFunctions/settlement/writer";
import {
  createStakedSuppliersDailyTableFn,
  createStakedSuppliersOfBlocksFn,
  rebuildStakedSuppliersDailyFn,
  refreshStakedSuppliersDailyFn,
} from "../../src/mappings/dbFunctions/stakedSuppliersDaily";
import {
  getSupplyCompositionBetweenDatesFn,
  getTotalSupplyBetweenDatesFn,
  getTotalSupplyByDay,
} from "../../src/mappings/dbFunctions/supply";
import {
  createSupplyAtFn,
  createSupplyDailyTablesFn,
  createSupplyPointsFn,
  rebuildSupplyDailyFn,
  refreshSupplyDailyFn,
} from "../../src/mappings/dbFunctions/supplyDaily";
import { createTxCountsDailyTableFn, createTxCountsOfBlocksFn } from "../../src/mappings/dbFunctions/txCounts";

type Row = Record<string, unknown>;
interface PgClient {
  connect(): Promise<void>;
  end(): Promise<void>;
  query(sql: string, params?: unknown[]): Promise<{ rows: Row[] }>;
}
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Client } = require("pg") as { Client: new (options: { connectionString?: string }) => PgClient };

const URL = process.env.MONEY_TEST_PG;
const S = "old_fn_rollups_ci";
const WRAPPED = "pokt14q8l4hlsdf2fqws7n6q6ck3xg5yt2qvgyynnll";

// Five UTC days with ten blocks each (every 140 minutes from 00:10), the ids 100..149; 2026-09-06 (a Sunday) has no
// block, and the last block of 09-05 (119) no upokt supply. 09-09 is the latest day, still open.
const DAYS = ["2026-09-04", "2026-09-05", "2026-09-07", "2026-09-08", "2026-09-09"];
const BLOCKS: Array<{ id: number; at: string }> = [];
DAYS.forEach((day, d) => {
  for (let i = 0; i < 10; i++) {
    const m = 10 + i * 140;
    BLOCKS.push({
      id: 100 + d * 10 + i,
      at: `${day} ${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}:00`,
    });
  }
});

// the old functions take an inclusive end without a zone: [a, b) is [a, b - 1 ms] for these whole-minute blocks
const oldEnd = (iso: string) => new Date(Date.parse(iso) - 1).toISOString().replace("T", " ").replace("Z", "");
const oldStart = (iso: string) => iso.replace("T", " ").replace("Z", "");
const num = (v: unknown) => (v === null || v === undefined ? null : String(Number(v)));

describe("staked suppliers and supply daily rollups (PostgreSQL)", { skip: !URL && "MONEY_TEST_PG not set" }, () => {
  const c = new Client({ connectionString: URL });
  const q = async (sql: string, params?: unknown[]) => (await c.query(sql, params)).rows;

  before(async () => {
    await c.connect();
    await c.query("SET statement_timeout = '30s'");
    await c.query(
      `DROP SCHEMA IF EXISTS ${S} CASCADE; CREATE SCHEMA ${S}; CREATE EXTENSION IF NOT EXISTS "uuid-ossp" WITH SCHEMA public;`
    );
    await c.query(`SET search_path = ${S}, public`);
    await c.query(createSettlementTablesFn(S));
    await c.query(createSettlementWriterFn(S));
    await c.query(`
      CREATE TABLE ${S}.event_claim_settleds (block_id numeric);
      CREATE TABLE ${S}.blocks (id numeric, timestamp timestamp, total_txs int, successful_txs int, failed_txs int);
      CREATE INDEX ON ${S}.blocks (timestamp, id);
      CREATE INDEX ON ${S}.blocks (id);
      CREATE TABLE ${S}.transactions (id text, block_id numeric, code int, amount_of_messages jsonb, _block_range int8range);
      CREATE TABLE ${S}.application_gateways (gateway_id text, application_id text, _block_range int8range);
      CREATE TABLE ${S}.params (id text, namespace text, key text, value text, active_at numeric, _block_range int8range);
      CREATE TABLE ${S}.delegations (id text);
      INSERT INTO ${S}.money_progress VALUES (true, 1, 999999999);
      -- staked suppliers: six suppliers on three services, some unstaking part-way, two on svc-x for a while
      CREATE TABLE ${S}.suppliers (id text, stake_status text, stake_amount numeric, _block_range int8range);
      CREATE TABLE ${S}.supplier_service_configs (supplier_id text, service_id text, _block_range int8range);
      INSERT INTO ${S}.suppliers
        SELECT 's' || i, 'Staked', 1000 + i, int8range(100 + 3 * i, CASE WHEN i % 2 = 0 THEN 130 + 2 * i END) FROM generate_series(0, 5) i
        UNION ALL
        SELECT 's' || i, 'Unstaking', 1000 + i, int8range(130 + 2 * i, NULL) FROM generate_series(0, 5) i WHERE i % 2 = 0;
      INSERT INTO ${S}.supplier_service_configs
        SELECT 's' || i, 'svc-' || (i % 3), int8range(1, NULL) FROM generate_series(0, 5) i
        UNION ALL
        SELECT 's' || i, 'svc-x', int8range(110, 125) FROM generate_series(0, 1) i;
      -- supply: an upokt supply per block, growing, and a uother one
      CREATE TABLE ${S}.supplies (id text, denom text, amount numeric);
      CREATE TABLE ${S}.block_supplies (block_id numeric, supply_id text, _block_range int8range);
      CREATE TABLE ${S}.morse_claimable_accounts (id text, claimed boolean, claimed_at_id numeric,
        unstaked_balance_amount numeric, supplier_stake_amount numeric, application_stake_amount numeric);
      CREATE TABLE ${S}.balances (id text, account_id text, denom text, amount numeric, last_updated_block_id numeric,
        _block_range int8range);
      CREATE TABLE ${S}.module_accounts (id text, name text, _block_range int8range);
      INSERT INTO ${S}.module_accounts VALUES ('mod-pool', 'bonded_tokens_pool', '[1,)'), ('mod-fee', 'fee_collector', '[1,)');
      INSERT INTO ${S}.params VALUES ('tokenomics-dao_reward_address', 'tokenomics', 'dao_reward_address', 'dao-a', NULL, '[1,125)'),
        ('tokenomics-dao_reward_address', 'tokenomics', 'dao_reward_address', 'dao-b', NULL, '[125,)');
      -- every account changes every four blocks; dao-a, dao-b and the wrapped address are plain accounts
      INSERT INTO ${S}.balances
        SELECT a || '-' || k, a, 'upokt', 1000 * length(a) + k * 7 + ascii(a) , 100 + 4 * k,
               int8range(100 + 4 * k, CASE WHEN k < 12 THEN 104 + 4 * k END)
        FROM unnest(ARRAY['mod-pool', 'mod-fee', 'dao-a', 'dao-b', '${WRAPPED}', 'acc1', 'acc22']) a, generate_series(0, 12) k
        UNION ALL
        SELECT 'u-' || k, 'acc1', 'uother', 5, 100, int8range(100 + k, 101 + k) FROM generate_series(0, 49) k;
      INSERT INTO ${S}.morse_claimable_accounts
        SELECT 'm' || g, g % 3 = 0, CASE WHEN g % 3 = 0 THEN 100 + (g * 7) % 50 END, g * 11, g * 13, g * 17
        FROM generate_series(1, 60) g;`);
    for (const b of BLOCKS) {
      await c.query(`INSERT INTO ${S}.blocks VALUES ($1, $2, 0, 0, 0)`, [b.id, b.at]);
    }
    await c.query(`
      INSERT INTO ${S}.supplies SELECT 'upokt-' || id, 'upokt', 1000000 + id * 1000 FROM ${S}.blocks;
      INSERT INTO ${S}.supplies SELECT 'uother-' || id, 'uother', 7 FROM ${S}.blocks;
      INSERT INTO ${S}.block_supplies SELECT id, 'upokt-' || id, int8range(id::bigint, NULL) FROM ${S}.blocks WHERE id <> 119;
      INSERT INTO ${S}.block_supplies SELECT id, 'uother-' || id, int8range(id::bigint, NULL) FROM ${S}.blocks;`);
    await c.query(createSupplierRevShareWalletsFn(S));
    await c.query(createTxCountsDailyTableFn(S));
    await c.query(createTxCountsOfBlocksFn(S));
    await c.query(upsertSuppliersByBlockAndServiceFn(S));
    await c.query(createStakedSuppliersDailyTableFn(S));
    await c.query(createStakedSuppliersOfBlocksFn(S));
    await c.query(rebuildStakedSuppliersDailyFn(S));
    await c.query(refreshStakedSuppliersDailyFn(S));
    await c.query(createSupplyDailyTablesFn(S));
    await c.query(createSupplyAtFn(S));
    await c.query(createSupplyPointsFn(S));
    await c.query(rebuildSupplyDailyFn(S));
    await c.query(refreshSupplyDailyFn(S));
    await c.query(createSettlementFunctionsFn(S));
    await c.query(createSettlementSmartTagsFn(S));
    await c.query(getAmountOfBlocksAndSuppliersByTimesFn(S));
    await c.query(getSupplyCompositionBetweenDatesFn(S));
    await c.query(getTotalSupplyByDay(S));
    await c.query(getTotalSupplyBetweenDatesFn(S));
  });
  after(async () => {
    await c.query(`DROP SCHEMA IF EXISTS ${S} CASCADE`);
    await c.end();
  });

  // ---- staked suppliers ----
  const index = async (from: number, to: number) => {
    for (let id = from; id <= to; id++)
      await c.query(`SELECT ${S}.upsert_staked_suppliers_by_block_and_services($1)`, [id]);
  };
  type Svc = Array<[string, string, string]>; // service_id, blocks, suppliers_staked
  const old = async (a: string, b: string): Promise<Svc> => {
    const j = (
      await q(`SELECT ${S}.get_amount_of_blocks_and_suppliers_by_times($1, $2)::text j`, [oldStart(a), oldEnd(b)])
    )[0].j;
    return (
      (JSON.parse(String(j)) ?? []) as Array<{ service_id: string; blocks: number; suppliers_staked: number }>
    ).map((r) => [r.service_id, String(r.blocks), String(r.suppliers_staked)]);
  };
  const staked = async (a: string | null, b: string | null, services: string[] | null = null) =>
    q(
      `SELECT service_id, blocks::text, suppliers_staked::text, first_height::text f, last_height::text l, covered_gaps
       FROM ${S}.get_staked_suppliers_by_service($1::timestamptz, $2::timestamptz, $3::text[])`,
      [a, b, services]
    );
  const svc = (rows: Row[]): Svc =>
    rows
      .filter((r) => r.service_id !== "*")
      .map((r) => [String(r.service_id), String(r.blocks), String(r.suppliers_staked)]);
  const dayRows = async (day: string) =>
    q(
      `SELECT service_id, blocks::text, suppliers_staked::text, first_height::text f, last_height::text l
       FROM ${S}.staked_suppliers_daily WHERE day = $1 ORDER BY 1`,
      [day]
    );
  const WINDOWS: Array<[string, string]> = [
    ["2026-09-04T00:00:00Z", "2026-09-10T00:00:00Z"],
    ["2026-09-04T05:00:00Z", "2026-09-08T07:00:00Z"],
    ["2026-09-05T00:00:00Z", "2026-09-08T00:00:00Z"],
    ["2026-09-07T03:00:00Z", "2026-09-07T15:00:00Z"],
    ["2026-09-05T20:00:00Z", "2026-09-07T04:00:00Z"],
  ];

  it("adds each block to its day as the old function sums the day, '*' holding every block and service", async () => {
    await index(100, 149);
    for (const day of DAYS) {
      const rows = await dayRows(day);
      const next = new Date(Date.parse(`${day}T00:00:00Z`) + 86400000).toISOString();
      assert.deepEqual(svc(rows), await old(`${day}T00:00:00Z`, next), day);
      const star = rows.find((r) => r.service_id === "*")!;
      assert.equal(star.blocks, "10", day);
      assert.equal(
        Number(star.suppliers_staked),
        (await old(`${day}T00:00:00Z`, next)).reduce((s, r) => s + Number(r[2]), 0)
      );
      assert.deepEqual(new Set(rows.map((r) => `${r.f}-${r.l}`)).size, 1, day);
    }
    assert.deepEqual(
      (await dayRows("2026-09-05")).map((r) => [r.service_id, r.f, r.l]).filter((r) => r[0] === "*"),
      [["*", "110", "119"]]
    );
  });

  it("answers the old function's numbers for full days, partial days and a range inside one day", async () => {
    for (const [a, b] of WINDOWS) {
      const rows = await staked(a, b);
      assert.deepEqual(svc(rows), await old(a, b), `${a} ${b}`);
      assert.deepEqual(rows[0].covered_gaps, [], `${a} ${b}`);
    }
    // services filters; the rollup's '*' rows only mark a day as held, they are no answer row
    const two = await staked(WINDOWS[1][0], WINDOWS[1][1], ["svc-1", "svc-x"]);
    assert.deepEqual(
      two.map((r) => r.service_id),
      ["svc-1", "svc-x"]
    );
    for (const [a, b] of WINDOWS) assert.ok(!(await staked(a, b)).some((r) => r.service_id === "*"), `${a} ${b}`);
    assert.deepEqual(
      svc(two),
      (await old(WINDOWS[1][0], WINDOWS[1][1])).filter((r) => r[0] === "svc-1" || r[0] === "svc-x")
    );
  });

  it("rebuilds a day to the rows the per-block refresh wrote, and is idempotent on a rewind and mid-day", async () => {
    const written = await dayRows("2026-09-07");
    assert.equal((await q(`SELECT ${S}.rebuild_staked_suppliers_daily('2026-09-07')::text b`))[0].b, "10");
    assert.deepEqual(await dayRows("2026-09-07"), written);
    // the indexer rewound to 124 and indexes it again: the day holds 120..124, then the rest adds again
    await index(124, 124);
    assert.deepEqual(
      (await dayRows("2026-09-07")).map((r) => r.l),
      written.map(() => "124")
    );
    await index(125, 129);
    assert.deepEqual(await dayRows("2026-09-07"), written);
    // deployed mid-day: the day is read whole up to the block
    await c.query(`DELETE FROM ${S}.staked_suppliers_daily WHERE day = '2026-09-08'`);
    await index(135, 139);
    assert.deepEqual(svc(await dayRows("2026-09-08")), await old("2026-09-08T00:00:00Z", "2026-09-09T00:00:00Z"));
  });

  it("reports a full day the rollup does not hold as a gap, not a zero; a day without blocks is none", async () => {
    await c.query(`DELETE FROM ${S}.staked_suppliers_daily WHERE day = '2026-09-05'`);
    const rows = await staked("2026-09-04T00:00:00Z", "2026-09-08T00:00:00Z");
    // 09-06 has no block: not a gap
    const gaps = rows[0].covered_gaps as Array<{ from: string; to: string }>;
    assert.deepEqual(
      gaps.map((g) => [Date.parse(g.from), Date.parse(g.to)]),
      [[Date.parse("2026-09-05T00:00:00Z"), Date.parse("2026-09-06T00:00:00Z")]]
    );
    const without = (await old("2026-09-04T00:00:00Z", "2026-09-05T00:00:00Z")).concat(
      await old("2026-09-07T00:00:00Z", "2026-09-08T00:00:00Z")
    );
    const summed = new Map<string, [number, number]>();
    for (const [s, b, n] of without)
      summed.set(s, [(summed.get(s)?.[0] ?? 0) + Number(b), (summed.get(s)?.[1] ?? 0) + Number(n)]);
    assert.deepEqual(
      svc(rows),
      [...summed].sort((x, y) => (x[0] < y[0] ? -1 : 1)).map(([s, [b, n]]) => [s, String(b), String(n)])
    );
    const none = await staked("2026-09-05T00:00:00Z", "2026-09-06T00:00:00Z");
    assert.equal(none.length, 1);
    assert.deepEqual([none[0].service_id, none[0].blocks], [null, null]);
    const twin = JSON.parse(
      String(
        (
          await q(
            `SELECT ${S}.get_staked_suppliers_by_service_json('2026-09-05T00:00:00Z', '2026-09-06T00:00:00Z')::text j`
          )
        )[0].j
      )
    ) as { range: { gaps: unknown[] }; data: unknown[] };
    assert.deepEqual(twin.data, []);
    assert.equal(twin.range.gaps.length, 1);
    await c.query(`SELECT ${S}.rebuild_staked_suppliers_daily('2026-09-05')`);
    assert.deepEqual(svc(await staked(WINDOWS[0][0], WINDOWS[0][1])), await old(WINDOWS[0][0], WINDOWS[0][1]));
    // the json twin: numbers as strings
    const j = JSON.parse(
      String((await q(`SELECT ${S}.get_staked_suppliers_by_service_json($1, $2)::text j`, WINDOWS[0]))[0].j)
    ) as { data: Array<Record<string, unknown>> };
    assert.equal(typeof j.data[0].suppliers_staked, "string");
  });

  // ---- supply ----
  const closeDays = async () => {
    for (const b of BLOCKS) await c.query(`SELECT ${S}.refresh_supply_daily($1)`, [b.id]);
  };
  interface Old {
    date_truncated: string;
    latest_block: number;
    network_supply: number;
    unmigrated_supply: number;
    total_supply: number;
    network_supply_composition: Array<{ label: string; amount: number }> | null;
  }
  const oldComposition = async (a: string, b: string, bucket: string) =>
    (JSON.parse(
      String(
        (
          await q(`SELECT ${S}.get_supply_composition_between_dates($1, $2, $3)::text j`, [
            oldStart(a),
            oldEnd(b),
            bucket,
          ])
        )[0].j
      )
    ) ?? []) as Old[];
  const supply = async (a: string | null, b: string | null, bucket = "day") =>
    q(
      `SELECT bucket_start, bucket_end, height::text, block_time, network_supply_upokt::text n, unmigrated_upokt::text u,
              total_supply_upokt::text t, covered_gaps FROM ${S}.get_supply($1::timestamptz, $2::timestamptz, $3)`,
      [a, b, bucket]
    );
  const composition = async (a: string | null, b: string | null, bucket = "day") =>
    q(
      `SELECT bucket_start, height::text, label, amount_upokt::text a FROM ${S}.get_supply_composition($1::timestamptz, $2::timestamptz, $3)`,
      [a, b, bucket]
    );
  const ms = (v: unknown) => (v instanceof Date ? v.getTime() : Date.parse(`${String(v).replace(" ", "T")}Z`));
  // the old answer as the new rows: oldest first there, newest first here
  const sameAsOld = async (a: string, b: string, bucket: string) => {
    const o = (await oldComposition(a, b, bucket)).reverse();
    const n = await supply(a, b, bucket);
    assert.deepEqual(
      n.map((r) => [ms(r.bucket_start), r.height, num(r.n), num(r.u), num(r.t)]),
      o.map((r) => [
        ms(r.date_truncated),
        String(r.latest_block),
        num(r.network_supply),
        num(r.unmigrated_supply),
        num(r.total_supply),
      ]),
      `${a} ${b} ${bucket}`
    );
    const comp = await composition(a, b, bucket);
    const key = (t: number, h: string, l: string, x: unknown) => `${t}|${h}|${l}|${num(x)}`;
    assert.deepEqual(
      comp.map((r) => key(ms(r.bucket_start), String(r.height), String(r.label), r.a)).sort(),
      o
        .flatMap((r) =>
          (r.network_supply_composition ?? []).map((x) =>
            key(ms(r.date_truncated), String(r.latest_block), x.label, x.amount)
          )
        )
        .sort(),
      `${a} ${b} ${bucket} composition`
    );
    return n;
  };
  const SUPPLY_WINDOWS: Array<[string, string, string]> = [
    ["2026-09-04T00:00:00Z", "2026-09-10T00:00:00Z", "day"],
    ["2026-09-04T05:00:00Z", "2026-09-08T07:00:00Z", "day"],
    ["2026-09-07T03:00:00Z", "2026-09-07T15:00:00Z", "day"],
    ["2026-08-31T00:00:00Z", "2026-09-14T00:00:00Z", "week"],
    ["2026-09-05T06:00:00Z", "2026-09-08T12:00:00Z", "week"],
    ["2026-09-01T00:00:00Z", "2026-10-01T00:00:00Z", "month"],
    ["2026-01-01T00:00:00Z", "2027-01-01T00:00:00Z", "year"],
  ];

  it("writes each day when the next day's first block comes, a day without a point held with none", async () => {
    await closeDays();
    const rows = await q(
      `SELECT day::text, height::text h, first_height::text f, last_height::text l FROM ${S}.supply_daily ORDER BY 1`
    );
    assert.deepEqual(
      rows.map((r) => [r.day, r.h, r.f, r.l]),
      [
        ["2026-09-04", "109", "100", "109"],
        // 119 has no upokt supply: the point is the block before it
        ["2026-09-05", "118", "110", "119"],
        ["2026-09-06", null, null, null],
        ["2026-09-07", "129", "120", "129"],
        ["2026-09-08", "139", "130", "139"],
      ]
    );
    // the open day is not written
    assert.equal(
      (await q(`SELECT count(*)::int n FROM ${S}.supply_composition_daily WHERE day = '2026-09-09'`))[0].n,
      0
    );
  });

  it("answers what get_supply_composition_between_dates answers, by day, week, month and year", async () => {
    for (const [a, b, bucket] of SUPPLY_WINDOWS) {
      const n = await sameAsOld(a, b, bucket);
      assert.ok(n.length > 0, `${a} ${b} ${bucket}`);
      assert.deepEqual(n[0].covered_gaps, []);
    }
    // the week of 08-31 ends on 09-06, which has no block: its point is 09-05's
    const weeks = await supply("2026-08-31T00:00:00Z", "2026-09-14T00:00:00Z", "week");
    assert.deepEqual(
      weeks.map((r) => r.height),
      ["149", "118"]
    );
    assert.deepEqual(
      weeks.map((r) => [ms(r.bucket_start), ms(r.bucket_end)]),
      [
        [Date.parse("2026-09-07T00:00:00Z"), Date.parse("2026-09-14T00:00:00Z")],
        [Date.parse("2026-08-31T00:00:00Z"), Date.parse("2026-09-07T00:00:00Z")],
      ]
    );
  });

  it("answers get_total_supply_by_day's totals by day, the whole history included", async () => {
    const o = JSON.parse(
      String((await q(`SELECT ${S}.get_total_supply_by_day('2026-09-01 00:00', '2026-09-30 23:59:59')::text j`))[0].j)
    ) as Array<{ day: string; last_block_id: number; shannon_supply: number; total_supply: number }>;
    const n = (await supply(null, null)).reverse();
    assert.deepEqual(
      n.map((r) => [ms(r.bucket_start), r.height, num(r.n), num(r.t)]),
      o.map((r) => [ms(r.day), String(r.last_block_id), num(r.shannon_supply), num(r.total_supply)])
    );
  });

  it("reads the rollup for full days: a day not held is a gap, never an earlier point", async () => {
    // a rollup value no live computation gives proves the full days are read from it
    await c.query(`UPDATE ${S}.supply_daily SET total_supply_upokt = -1 WHERE day = '2026-09-07'`);
    const marked = await supply("2026-09-07T00:00:00Z", "2026-09-08T00:00:00Z");
    assert.deepEqual(
      marked.map((r) => r.t),
      ["-1"]
    );
    await c.query(`SELECT ${S}.rebuild_supply_daily('2026-09-07')`);
    await c.query(
      `DELETE FROM ${S}.supply_composition_daily WHERE day = '2026-09-05'; DELETE FROM ${S}.supply_daily WHERE day = '2026-09-05'`
    );
    const weeks = await supply("2026-08-31T00:00:00Z", "2026-09-14T00:00:00Z", "week");
    assert.deepEqual(
      weeks.map((r) => r.height),
      ["149"]
    );
    const gaps = weeks[0].covered_gaps as Array<{ from: string; to: string }>;
    assert.deepEqual(
      gaps.map((g) => [Date.parse(g.from), Date.parse(g.to)]),
      [[Date.parse("2026-09-05T00:00:00Z"), Date.parse("2026-09-06T00:00:00Z")]]
    );
    // nothing but the gap: one row of NULLs, left out of the twin's data
    const none = await supply("2026-09-05T00:00:00Z", "2026-09-06T00:00:00Z");
    assert.deepEqual(
      none.map((r) => r.height),
      [null]
    );
    for (const fn of ["get_supply_json", "get_supply_composition_json"]) {
      const twin = JSON.parse(
        String((await q(`SELECT ${S}.${fn}('2026-09-05T00:00:00Z', '2026-09-06T00:00:00Z')::text j`))[0].j)
      ) as { range: { gaps: unknown[] }; data: unknown[] };
      assert.deepEqual(twin.data, [], fn);
      assert.equal(twin.range.gaps.length, 1, fn);
    }
    assert.equal((await q(`SELECT ${S}.rebuild_supply_daily('2026-09-05')::text h`))[0].h, "118");
    await sameAsOld(...SUPPLY_WINDOWS[3]);
  });

  it("writes a day again when its blocks are indexed again, and only when a day closes", async () => {
    // a balance of 09-05's point changes (the day indexed again): written again at the next day's first block
    await c.query(
      `UPDATE ${S}.balances SET amount = amount + 1000 WHERE account_id = 'acc1' AND _block_range @> 118::bigint`
    );
    await c.query(`SELECT ${S}.refresh_supply_daily(125)`);
    const before = await q(
      `SELECT amount_upokt::text a FROM ${S}.supply_composition_daily WHERE day = '2026-09-05' AND label = 'others'`
    );
    await c.query(`SELECT ${S}.refresh_supply_daily(120)`);
    const now = await q(
      `SELECT amount_upokt::text a FROM ${S}.supply_composition_daily WHERE day = '2026-09-05' AND label = 'others'`
    );
    assert.equal(Number(now[0].a) - Number(before[0].a), 1000);
    await sameAsOld(...SUPPLY_WINDOWS[0]);
  });

  it("gives one point live by height, the last block at or below it with an upokt supply", async () => {
    const at = async (h: number | null) =>
      q(
        `SELECT height::text, network_supply_upokt::text n, unmigrated_upokt::text u, total_supply_upokt::text t, label, amount_upokt::text a
         FROM ${S}.get_supply_composition_at($1::bigint)`,
        [h]
      );
    for (const [h, want] of [
      [119, "118"],
      [127, "127"],
      [null, "149"],
    ] as Array<[number | null, string]>) {
      const rows = await at(h);
      assert.ok(rows.length > 1);
      assert.deepEqual([...new Set(rows.map((r) => r.height))], [want]);
      const block = BLOCKS.find((b) => String(b.id) === want)!;
      const o = (
        await oldComposition(`${block.at.slice(0, 10)}T00:00:00Z`, `${block.at.replace(" ", "T")}.001Z`, "day")
      ).pop()!;
      assert.equal(String(o.latest_block), want);
      assert.deepEqual(
        [num(rows[0].n), num(rows[0].u), num(rows[0].t)],
        [num(o.network_supply), num(o.unmigrated_supply), num(o.total_supply)]
      );
      assert.deepEqual(
        rows.map((r) => `${r.label}|${num(r.a)}`).sort(),
        (o.network_supply_composition ?? []).map((x) => `${x.label}|${num(x.amount)}`).sort()
      );
    }
    assert.deepEqual(await at(50), []);
    // get_supply's live end reads the unmigrated amount from the rollup's nearest day (09-08, 139) less the Morse
    // accounts claimed since: the same as computing it in full, with claims in between
    assert.ok(Number((await q(`SELECT count(*) n FROM ${S}.morse_claimable_accounts WHERE claimed_at_id > 139 AND claimed_at_id <= 149`))[0].n) > 0);
    const live = (await supply("2026-09-09T00:00:00Z", "2026-09-10T00:00:00Z"))[0];
    const full = (await at(149))[0];
    assert.deepEqual([live.height, num(live.n), num(live.u), num(live.t)], ["149", num(full.n), num(full.u), num(full.t)]);
    // without a day held below it, in full
    const first = (await supply("2026-09-04T00:00:00Z", "2026-09-04T05:00:00Z"))[0];
    assert.deepEqual([first.height, num(first.u)], ["102", num((await at(102))[0].u)]);
  });

  // scripts/fill_*_daily.sql as the runbook runs them: psql in its own session
  const psqlScript = (script: string) =>
    new Promise<{ code: number | null; stderr: string; stdout: string }>((resolve, reject) => {
      const p = spawn("psql", [
        URL as string,
        "-X",
        "-v",
        `schema=${S}`,
        "-f",
        path.join(__dirname, "..", "..", "scripts", script),
      ]);
      let stderr = "";
      let stdout = "";
      p.stderr.on("data", (d) => (stderr += String(d)));
      p.stdout.on("data", (d) => (stdout += String(d)));
      p.on("error", reject);
      p.on("close", (code) => resolve({ code, stderr, stdout }));
    });

  it("the backfill scripts write the closed days the rollups do not hold, and nothing else", async () => {
    const all = async () => ({
      staked: await q(`SELECT * FROM ${S}.staked_suppliers_daily ORDER BY day, service_id`),
      supply: await q(`SELECT * FROM ${S}.supply_daily ORDER BY day`),
      composition: await q(`SELECT * FROM ${S}.supply_composition_daily ORDER BY day, label`),
    });
    // the open day 09-09 (the staked rollup has it from the per-block refresh) is not the backfill's
    const want = await all();
    await c.query(`DELETE FROM ${S}.staked_suppliers_daily WHERE day IN ('2026-09-04', '2026-09-07');
                   DELETE FROM ${S}.supply_composition_daily WHERE day IN ('2026-09-04', '2026-09-07');
                   DELETE FROM ${S}.supply_daily WHERE day IN ('2026-09-04', '2026-09-06', '2026-09-07')`);
    for (const script of ["fill_staked_suppliers_daily.sql", "fill_supply_daily.sql"]) {
      const r = await psqlScript(script);
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, /days_not_held\s*\n-+\n\s*0\n/, script);
      // run again: nothing left to write
      const again = await psqlScript(script);
      assert.equal(again.code, 0, again.stderr);
      assert.doesNotMatch(again.stdout, /2026-09-0/, script);
    }
    assert.deepEqual(await all(), want);
  });

  it("gives get_total_supply_between_dates' snapshot without a bucket: one row at the range's last point", async () => {
    for (const [a, b] of [
      ["2026-09-04T00:00:00Z", "2026-09-10T00:00:00Z"],
      ["2026-09-04T05:00:00Z", "2026-09-06T00:00:00Z"],
      ["2026-09-07T03:00:00Z", "2026-09-07T15:00:00Z"],
      ["2026-09-04T00:00:00Z", "2026-09-05T23:00:00Z"],
    ]) {
      const o = JSON.parse(
        String((await q(`SELECT ${S}.get_total_supply_between_dates($1, $2)::text j`, [oldStart(a), oldEnd(b)]))[0].j)
      ) as Record<string, number>;
      const n = await supply(a, b, null as unknown as string);
      assert.equal(n.length, 1, `${a} ${b}`);
      // the range clipped to what is indexed: up to the latest block (09-09 22:50) + 1 µs
      assert.deepEqual(
        [n[0].height, num(n[0].n), num(n[0].u), num(n[0].t), ms(n[0].bucket_start)],
        [String(o.latest_block), num(o.network_supply), num(o.unmigrated_supply), num(o.total_supply), Date.parse(a)],
        `${a} ${b}`
      );
    }
  });

  it("refuses a bucket other than day, week, month or year (or NULL for get_supply)", async () => {
    await assert.rejects(supply("2026-09-04T00:00:00Z", "2026-09-05T00:00:00Z", "hour"), /bucket must be/);
    for (const bucket of ["hour", null]) {
      await assert.rejects(
        composition("2026-09-04T00:00:00Z", "2026-09-05T00:00:00Z", bucket as string),
        /bucket must be/
      );
    }
  });
});
