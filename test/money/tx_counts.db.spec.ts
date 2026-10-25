// tx_counts_daily (refreshed per block, rebuilt per day) and get_tx_counts, checked against a counter written here
// from the generated transactions, not from the SQL under test.
//   MONEY_TEST_PG=postgres://postgres:postgres@127.0.0.1:5432/postgres yarn test:money
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { after, before, describe, it } from "node:test";
import path from "node:path";
import { createSupplierRevShareWalletsFn } from "../../src/mappings/dbFunctions/revShareWallets";
import { createSettlementFunctionsFn } from "../../src/mappings/dbFunctions/settlement/functions";
import { createSettlementSmartTagsFn } from "../../src/mappings/dbFunctions/settlement/smartTags";
import { createSettlementTablesFn } from "../../src/mappings/dbFunctions/settlement/schema";
import { createSettlementWriterFn } from "../../src/mappings/dbFunctions/settlement/writer";
import {
  createTxCountsDailyTableFn,
  createTxCountsOfBlocksFn,
  rebuildTxCountsDailyFn,
  refreshTxCountsDailyFn,
} from "../../src/mappings/dbFunctions/txCounts";

interface PgClient {
  connect(): Promise<void>;
  end(): Promise<void>;
  query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, string | null>> }>;
}
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Client } = require("pg") as { Client: new (options: { connectionString?: string }) => PgClient };

const URL = process.env.MONEY_TEST_PG;
const S = "tx_counts_ci";

const SEND = "/cosmos.bank.v1beta1.MsgSend";
const CLAIM = "/pocket.proof.MsgCreateClaim";
const PROOF = "/pocket.proof.MsgSubmitProof";

// four UTC days, ten blocks each (every 140 minutes from 00:10), the block ids 100..139; the last day is the latest
const DAYS = ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04"];
interface Tx {
  block: number;
  code: number;
  types: string[];
}
interface Blk {
  id: number;
  at: string;
  day: string;
}
const blocks: Blk[] = [];
const txs: Tx[] = [];
DAYS.forEach((day, d) => {
  for (let i = 0; i < 10; i++) {
    const id = 100 + d * 10 + i;
    const minutes = 10 + i * 140;
    const at = `${day} ${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(
      2,
      "0"
    )}:00`;
    blocks.push({ id, at, day });
    // 0..3 transactions per block; a failed one every fifth; one or two message types, a type twice in one transaction
    for (let j = 0; j < id % 4; j++) {
      const k = (id + j) % 5;
      const types = k === 0 ? [SEND, SEND, CLAIM] : k === 1 ? [CLAIM] : k === 2 ? [PROOF, SEND] : [SEND];
      txs.push({ block: id, code: k === 4 ? 1 : 0, types });
    }
  }
});

type Count = Map<string, number>; // `${type}|${status}` -> transactions
function count(of: (b: Blk) => boolean): Count {
  const out: Count = new Map();
  const add = (type: string, status: string) => out.set(`${type}|${status}`, (out.get(`${type}|${status}`) ?? 0) + 1);
  for (const t of txs) {
    const b = blocks.find((x) => x.id === t.block)!;
    if (!of(b)) continue;
    const status = t.code === 0 ? "success" : "failed";
    add("*", status);
    for (const type of new Set(t.types)) add(type, status);
  }
  return out;
}
const inRange = (from: string, to: string) => (b: Blk) => b.at >= from && b.at < to;
const sql = (iso: string) => iso.replace("T", " ").replace("Z", "");

describe("tx_counts_daily and get_tx_counts (PostgreSQL)", { skip: !URL && "MONEY_TEST_PG not set" }, () => {
  const c = new Client({ connectionString: URL });

  before(async () => {
    await c.connect();
    await c.query("SET statement_timeout = '30s'");
    await c.query(`DROP SCHEMA IF EXISTS ${S} CASCADE; CREATE SCHEMA ${S};`);
    await c.query(createSettlementTablesFn(S));
    await c.query(createSettlementWriterFn(S));
    await c.query(`
      CREATE TABLE ${S}.event_claim_settleds (block_id numeric);
      CREATE TABLE ${S}.blocks (id numeric, timestamp timestamp, total_txs int, successful_txs int, failed_txs int);
      CREATE INDEX ON ${S}.blocks (timestamp, id);
      CREATE TABLE ${S}.transactions (id text, block_id numeric, code int, amount_of_messages jsonb, _block_range int8range);
      CREATE TABLE ${S}.application_gateways (gateway_id text, application_id text, _block_range int8range);
      CREATE TABLE ${S}.params (id text, namespace text, key text, value text, active_at numeric, _block_range int8range);
      CREATE TABLE ${S}.delegations (id text);
      INSERT INTO ${S}.money_progress VALUES (true, 1, 999999999);`);
    for (const b of blocks) {
      const mine = txs.filter((t) => t.block === b.id);
      await c.query(`INSERT INTO ${S}.blocks VALUES ($1, $2, $3, $4, $5)`, [
        b.id,
        b.at,
        mine.length,
        mine.filter((t) => t.code === 0).length,
        mine.filter((t) => t.code !== 0).length,
      ]);
    }
    let n = 0;
    for (const t of txs) {
      const msgs = new Map<string, number>();
      for (const type of t.types) msgs.set(type, (msgs.get(type) ?? 0) + 1);
      await c.query(
        `INSERT INTO ${S}.transactions VALUES ($1, $2::numeric, $3, $4::jsonb, int8range($5::bigint, NULL))`,
        [`tx${n++}`, t.block, t.code, JSON.stringify([...msgs].map(([type, amount]) => ({ type, amount }))), t.block]
      );
    }
    await c.query(createSupplierRevShareWalletsFn(S));
    await c.query(createSettlementFunctionsFn(S));
    await c.query(createSettlementSmartTagsFn(S));
    await c.query(createTxCountsDailyTableFn(S));
    await c.query(createTxCountsOfBlocksFn(S));
    await c.query(rebuildTxCountsDailyFn(S));
    await c.query(refreshTxCountsDailyFn(S));
  });
  after(async () => {
    await c.query(`DROP SCHEMA IF EXISTS ${S} CASCADE`);
    await c.end();
  });

  const rolled = async (day: string) =>
    (
      await c.query(
        `SELECT msg_type, status, txs::text, first_height::text f, last_height::text l FROM ${S}.tx_counts_daily WHERE day = $1 ORDER BY 1, 2`,
        [day]
      )
    ).rows;
  const asMap = (rows: Array<Record<string, string | null>>): Count =>
    new Map(rows.filter((r) => r.txs !== "0").map((r) => [`${r.msg_type}|${r.status}`, Number(r.txs)]));
  const refreshBlocks = async (day: string, after = -Infinity) => {
    for (const b of blocks.filter((x) => x.day === day && x.id > after)) {
      await c.query(`SELECT ${S}.refresh_tx_counts_daily($1)`, [b.id]);
    }
  };
  const oracleDay = (day: string, upTo = Infinity) => count((b) => b.day === day && b.id <= upTo);
  const sorted = (m: Count) => [...m].sort((a, b) => a[0].localeCompare(b[0]));
  const heights = (rows: Array<Record<string, string | null>>) => new Set(rows.map((r) => `${r.f}-${r.l}`));

  it("adds each block of a day to its rows, a transaction once under each type it holds and once under '*'", async () => {
    await refreshBlocks(DAYS[0]);
    const rows = await rolled(DAYS[0]);
    assert.deepEqual(sorted(asMap(rows)), sorted(oracleDay(DAYS[0])));
    // the sum of '*' is every transaction of the day; a type twice in one transaction counted once
    const star = rows.filter((r) => r.msg_type === "*").reduce((s, r) => s + Number(r.txs), 0);
    assert.equal(star, txs.filter((t) => blocks.find((b) => b.id === t.block)!.day === DAYS[0]).length);
    // every row of the day holds the day's blocks
    assert.deepEqual(heights(rows), new Set(["100-109"]));
  });

  it("rebuilds a day to the same rows the per-block refresh wrote", async () => {
    await refreshBlocks(DAYS[1]);
    const written = await rolled(DAYS[1]);
    const total = (await c.query(`SELECT ${S}.rebuild_tx_counts_daily($1)::text t`, [DAYS[1]])).rows[0].t;
    assert.equal(total, String(txs.filter((t) => blocks.find((b) => b.id === t.block)!.day === DAYS[1]).length));
    assert.deepEqual(await rolled(DAYS[1]), written);
  });

  it("is idempotent on a rewind: a block already held rebuilds the day up to it, and the rest adds again", async () => {
    // the indexer rewound to block 114 and indexes it again
    await c.query(`SELECT ${S}.refresh_tx_counts_daily(114)`);
    const mid = await rolled(DAYS[1]);
    assert.deepEqual(sorted(asMap(mid)), sorted(oracleDay(DAYS[1], 114)));
    assert.deepEqual(heights(mid), new Set(["110-114"]));
    await refreshBlocks(DAYS[1], 114);
    assert.deepEqual(sorted(asMap(await rolled(DAYS[1]))), sorted(oracleDay(DAYS[1])));
    // the last block twice
    await c.query(`SELECT ${S}.refresh_tx_counts_daily(119)`);
    assert.deepEqual(sorted(asMap(await rolled(DAYS[1]))), sorted(oracleDay(DAYS[1])));
  });

  it("reads a day whole when its first block is not the one it is called for (deployed mid-day)", async () => {
    await c.query(`SELECT ${S}.refresh_tx_counts_daily(125)`);
    assert.deepEqual(sorted(asMap(await rolled(DAYS[2]))), sorted(oracleDay(DAYS[2], 125)));
    await refreshBlocks(DAYS[2], 125);
    assert.deepEqual(sorted(asMap(await rolled(DAYS[2]))), sorted(oracleDay(DAYS[2])));
    assert.deepEqual(heights(await rolled(DAYS[2])), new Set(["120-129"]));
  });

  it("keeps the '*' rows of a day with no transaction, so the day counts as held", async () => {
    await c.query(`INSERT INTO ${S}.blocks VALUES (200, '2026-09-10 01:00', 0, 0, 0)`);
    await c.query(`SELECT ${S}.refresh_tx_counts_daily(200)`);
    const rows = await rolled("2026-09-10");
    assert.deepEqual(
      rows.map((r) => [r.msg_type, r.status, r.txs]),
      [
        ["*", "failed", "0"],
        ["*", "success", "0"],
      ]
    );
    await c.query(`DELETE FROM ${S}.tx_counts_daily WHERE day = '2026-09-10'; DELETE FROM ${S}.blocks WHERE id = 200`);
  });

  const get = async (from: string, to: string, types: string[] | null = null, statuses: string[] | null = null) =>
    (
      await c.query(
        `SELECT msg_type, status, txs::text, first_height::text f, last_height::text l, covered_gaps FROM ${S}.get_tx_counts($1::timestamptz, $2::timestamptz, $3::text[], $4::text[]) ORDER BY 1, 2`,
        [from, to, types, statuses]
      )
    ).rows;

  it("answers a range of full days from the rollup and its partial days from the blocks", async () => {
    await refreshBlocks(DAYS[3]);
    const from = "2026-09-01T05:00:00Z";
    const to = "2026-09-04T07:00:00Z";
    const want = count(inRange(sql(from), sql(to)));
    const rows = await get(from, to);
    assert.deepEqual(sorted(asMap(rows)), sorted(want));
    assert.deepEqual(rows[0].covered_gaps, []);
    // a type and a status
    const sends = await get(from, to, [SEND], ["failed"]);
    assert.equal(sends.length, 1);
    assert.deepEqual(
      [sends[0].msg_type, sends[0].status, Number(sends[0].txs)],
      [SEND, "failed", want.get(`${SEND}|failed`) ?? 0]
    );
  });

  it("counts only '*' from the blocks' own totals, with the same numbers", async () => {
    for (const [from, to] of [
      ["2026-09-01T05:00:00Z", "2026-09-04T07:00:00Z"],
      ["2026-09-02T00:00:00Z", "2026-09-04T00:00:00Z"],
      ["2026-09-02T03:00:00Z", "2026-09-02T11:00:00Z"],
    ]) {
      const star = await get(from, to, ["*"]);
      const all = (await get(from, to)).filter((r) => r.msg_type === "*");
      assert.deepEqual(
        star.map((r) => [r.msg_type, r.status, r.txs]),
        all.map((r) => [r.msg_type, r.status, r.txs]),
        `${from} ${to}`
      );
      assert.ok(star.length > 0);
    }
  });

  it("reads a range inside one day, or on day boundaries, from the blocks or the rollup alone", async () => {
    for (const [from, to] of [
      ["2026-09-03T01:00:00Z", "2026-09-03T20:00:00Z"],
      ["2026-09-02T00:00:00Z", "2026-09-03T00:00:00Z"],
      ["2026-09-02T00:00:00Z", "2026-09-02T04:00:00Z"],
    ]) {
      assert.deepEqual(sorted(asMap(await get(from, to))), sorted(count(inRange(sql(from), sql(to)))), `${from} ${to}`);
    }
  });

  it("reports a full day the rollup does not hold as a gap, not a zero", async () => {
    await c.query(`DELETE FROM ${S}.tx_counts_daily WHERE day = '2026-09-02'`);
    const rows = await get("2026-09-01T00:00:00Z", "2026-09-04T00:00:00Z");
    assert.deepEqual(sorted(asMap(rows)), sorted(count((b) => b.day === "2026-09-01" || b.day === "2026-09-03")));
    const gaps = rows[0].covered_gaps as unknown as Array<{ from: string; to: string }>;
    assert.deepEqual(
      gaps.map((g) => [Date.parse(g.from), Date.parse(g.to)]),
      [[Date.parse("2026-09-02T00:00:00Z"), Date.parse("2026-09-03T00:00:00Z")]]
    );
    // a range inside the gap: nothing to read, one row of NULLs that carries it
    const none = await get("2026-09-02T00:00:00Z", "2026-09-03T00:00:00Z");
    assert.equal(none.length, 1);
    assert.deepEqual([none[0].msg_type, none[0].status, none[0].txs], [null, null, null]);
    assert.equal((none[0].covered_gaps as unknown as unknown[]).length, 1);
    // the json twin keeps that row out of data and puts the gap in range
    const twin = JSON.parse(
      (await c.query(`SELECT ${S}.get_tx_counts_json('2026-09-02T00:00:00Z', '2026-09-03T00:00:00Z')::text j`)).rows[0].j as string
    ) as { range: { gaps: unknown[] }; data: unknown[] };
    assert.deepEqual(twin.data, []);
    assert.equal(twin.range.gaps.length, 1);
    await c.query(`SELECT ${S}.rebuild_tx_counts_daily('2026-09-02')`);
    assert.deepEqual(
      sorted(asMap(await get("2026-09-01T00:00:00Z", "2026-09-04T00:00:00Z"))),
      sorted(count((b) => b.day !== "2026-09-04"))
    );
  });

  it("answers the json twin with the range and the rows as strings", async () => {
    const j = (
      await c.query(
        `SELECT ${S}.get_tx_counts_json('2026-09-01T05:00:00Z', '2026-09-04T07:00:00Z', ARRAY['*'], NULL)::text j`
      )
    ).rows[0].j as string;
    const parsed = JSON.parse(j) as { range: { gaps: unknown[] }; data: Array<Record<string, string>> };
    assert.deepEqual(parsed.range.gaps, []);
    assert.deepEqual(
      parsed.data.map((r) => r.msg_type),
      ["*", "*"]
    );
    assert.equal(typeof parsed.data[0].txs, "string");
    // an empty answer (a range before the first block) still has its range
    const empty = JSON.parse(
      (await c.query(`SELECT ${S}.get_tx_counts_json('2026-08-01T00:00:00Z', '2026-08-02T00:00:00Z')::text j`)).rows[0]
        .j as string
    ) as { data: unknown[] };
    assert.deepEqual(empty.data, []);
  });

  it("does not report a day without blocks as a gap, and the backfill does not wait for it", async () => {
    // a halt: 09-05..09-07 have no block (mainnet 2025-05-01..06), the chain resumes on 09-08
    await c.query(`INSERT INTO ${S}.blocks VALUES (300, '2026-09-08 01:00', 0, 0, 0)`);
    await c.query(`SELECT ${S}.refresh_tx_counts_daily(300)`);
    try {
      const rows = await get("2026-09-03T00:00:00Z", "2026-09-08T05:00:00Z");
      assert.deepEqual(rows[0].covered_gaps, []);
      assert.deepEqual(sorted(asMap(rows)), sorted(count((b) => b.day === "2026-09-03" || b.day === "2026-09-04")));
      // scripts/fill_tx_counts_daily.sql as the runbook runs it: nothing to write, and no day left (the halt is none)
      const r = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
        const p = spawn("psql", [URL as string, "-X", "-v", `schema=${S}`, "-f", path.join(__dirname, "..", "..", "scripts", "fill_tx_counts_daily.sql")]);
        let stdout = "";
        let stderr = "";
        p.stdout.on("data", (d) => (stdout += String(d)));
        p.stderr.on("data", (d) => (stderr += String(d)));
        p.on("error", reject);
        p.on("close", (code) => resolve({ code, stdout, stderr }));
      });
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, /days_not_held\s*\n-+\n\s*0\n/);
      assert.doesNotMatch(r.stdout, /2026-09-0/);
    } finally {
      await c.query(`DELETE FROM ${S}.tx_counts_daily WHERE day = '2026-09-08'; DELETE FROM ${S}.blocks WHERE id = 300`);
    }
  });

  it("refuses a status that is neither success nor failed and an inverted range", async () => {
    await assert.rejects(get("2026-09-01T00:00:00Z", "2026-09-02T00:00:00Z", null, ["ok"]), /statuses must be/);
    await assert.rejects(get("2026-09-02T00:00:00Z", "2026-09-01T00:00:00Z"), /range_start must be earlier/);
  });
});
