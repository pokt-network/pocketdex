// get_total_supply_by_day was rewritten for speed; it must answer exactly what the previous version answered.
//   MONEY_TEST_PG=postgres://postgres:postgres@127.0.0.1:5432/postgres yarn test:money
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { getTotalSupplyByDay } from "../../src/mappings/dbFunctions/supply";
import { getTotalSupplyByDayBefore } from "./fixtures/supply_by_day_before";

interface PgClient {
  connect(): Promise<void>;
  end(): Promise<void>;
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, string | null>[] }>;
}
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Client } = require("pg") as { Client: new (options: { connectionString?: string }) => PgClient };

const URL = process.env.MONEY_TEST_PG;
const S = "supply_ci";

describe("get_total_supply_by_day (PostgreSQL)", { skip: !URL && "MONEY_TEST_PG not set" }, () => {
  const c = new Client({ connectionString: URL });

  before(async () => {
    await c.connect();
    // an unbounded day series (infinite bounds) must fail here, not hang the suite
    await c.query("SET statement_timeout = '10s'");
    await c.query(`DROP SCHEMA IF EXISTS ${S} CASCADE; CREATE SCHEMA ${S};`);
    await c.query(`
      CREATE TABLE ${S}.blocks (id numeric, timestamp timestamp);
      CREATE TABLE ${S}.supplies (id text, denom text, amount numeric);
      CREATE TABLE ${S}.block_supplies (block_id numeric, supply_id text, _block_range int8range);
      CREATE TABLE ${S}.morse_claimable_accounts (id text, claimed boolean, claimed_at_id numeric,
        unstaked_balance_amount numeric, supplier_stake_amount numeric, application_stake_amount numeric);
      CREATE INDEX ON ${S}.blocks (timestamp, id);
      -- 2026-07-01..07-07, a block every 7 hours from 01:30, so days end at different hours; 07-04 has none
      INSERT INTO ${S}.blocks
        SELECT row_number() OVER (ORDER BY t), t
        FROM generate_series(timestamp '2026-07-01 01:30', timestamp '2026-07-07 23:00', interval '7 hours') t
        WHERE t::date <> date '2026-07-04';
      -- one more block exactly at midnight of 07-06
      INSERT INTO ${S}.blocks SELECT max(id) + 1, timestamp '2026-07-06 00:00' FROM ${S}.blocks;
      -- an upokt supply per block, growing, plus a uother supply on every block
      INSERT INTO ${S}.supplies SELECT 'upokt-' || id, 'upokt', 1000000 + id * 1000 FROM ${S}.blocks;
      INSERT INTO ${S}.supplies SELECT 'uother-' || id, 'uother', 7 FROM ${S}.blocks;
      INSERT INTO ${S}.block_supplies SELECT id, 'upokt-' || id, int8range(id::bigint, NULL) FROM ${S}.blocks;
      INSERT INTO ${S}.block_supplies SELECT id, 'uother-' || id, int8range(id::bigint, NULL) FROM ${S}.blocks;
      -- the last block of 07-02 has no upokt supply: both versions must fall back to the block before it
      DELETE FROM ${S}.block_supplies WHERE supply_id = 'upokt-' || (
        SELECT id FROM ${S}.blocks WHERE timestamp::date = date '2026-07-02' ORDER BY timestamp DESC LIMIT 1);
      -- morse accounts: unclaimed ones, and claimed ones at heights inside the seed
      INSERT INTO ${S}.morse_claimable_accounts
        SELECT 'm' || g, g % 3 = 0, CASE WHEN g % 3 = 0 THEN g % 20 END, g * 11, g * 13, g * 17
        FROM generate_series(1, 60) g;`);
    await c.query(getTotalSupplyByDay(S));
    await c.query(getTotalSupplyByDayBefore(S));
  });
  after(async () => {
    await c.query(`DROP SCHEMA IF EXISTS ${S} CASCADE`);
    await c.end();
  });

  const both = async (a: string, b: string) => {
    const r = (
      await c.query(
        `SELECT ${S}.get_total_supply_by_day($1, $2)::text n, ${S}.get_total_supply_by_day_before($1, $2)::text o`,
        [a, b]
      )
    ).rows[0];
    return { now: r.n, before: r.o };
  };

  it("answers the seeded days with real values, skipping the day without blocks and the supply-less last block", async () => {
    const { now } = await both("2026-07-01 00:00", "2026-07-07 23:59:59");
    assert.ok(now);
    const days = JSON.parse(now) as {
      day: string;
      last_block_id: number;
      shannon_supply: number;
      total_supply: number;
    }[];
    assert.deepEqual(
      days.map((d) => d.day.slice(0, 10)),
      ["2026-07-01", "2026-07-02", "2026-07-03", "2026-07-05", "2026-07-06", "2026-07-07"]
    );
    const lastOf0702 = (
      await c.query(`SELECT max(id)::text m FROM ${S}.blocks WHERE timestamp::date = date '2026-07-02'`)
    ).rows[0].m;
    assert.equal(days[1].last_block_id, Number(lastOf0702) - 1);
    assert.ok(days.every((d) => d.shannon_supply > 1000000 && d.total_supply > d.shannon_supply));
  });

  const ranges: [string, string, string][] = [
    ["whole seed", "2026-07-01 00:00", "2026-07-07 23:59:59"],
    ["wider than the seed", "2026-06-01 00:00", "2026-08-01 00:00"],
    ["mid-day both ends", "2026-07-01 13:00", "2026-07-06 05:15"],
    ["ends before the day's last block", "2026-07-03 00:00", "2026-07-03 10:00"],
    ["starts after the day's first block", "2026-07-03 09:00", "2026-07-03 23:59:59.999999"],
    ["midnight to midnight, end on the midnight block", "2026-07-05 00:00", "2026-07-06 00:00"],
    ["only the day without blocks", "2026-07-04 00:00", "2026-07-04 23:59:59"],
    ["before any block", "2020-01-01", "2020-02-01"],
    ["start after end", "2026-07-05 00:00", "2026-07-03 00:00"],
    ["same instant on a block", "2026-07-06 00:00", "2026-07-06 00:00"],
    ["one microsecond", "2026-07-02 15:29:59.999999", "2026-07-02 15:30:00"],
    ["infinite end", "2026-07-03 12:00", "infinity"],
    ["infinite start", "-infinity", "2026-07-03 12:00"],
    ["both infinite", "-infinity", "infinity"],
    ["far-off bounds", "0001-01-01", "9999-12-31"],
  ];
  for (const [name, a, b] of [
    ["no start", null, "2026-07-05 00:00"],
    ["no end", "2026-07-02 00:00", null],
    ["no start and no end", null, null],
  ] as const) {
    it(`answers NULL, as the previous version did: ${name}`, async () => {
      const r = await both(a as string, b as string);
      assert.equal(r.before, null);
      assert.equal(r.now, null);
    });
  }

  it("answers NULL with no blocks indexed, as the previous version did, even for an infinite range", async () => {
    await c.query("BEGIN");
    try {
      await c.query(`DELETE FROM ${S}.blocks`);
      for (const [a, b] of [
        ["2026-07-01", "2026-07-07"],
        ["-infinity", "infinity"],
      ]) {
        const r = await both(a, b);
        assert.equal(r.before, null);
        assert.equal(r.now, null);
      }
    } finally {
      await c.query("ROLLBACK");
    }
  });

  for (const [name, a, b] of ranges) {
    it(`answers byte for byte what the previous version answered: ${name}`, async () => {
      const r = await both(a, b);
      assert.equal(r.now, r.before);
    });
  }

  it("answers byte for byte what the previous version answered on every 5-hour range of the seed", async () => {
    const r = (
      await c.query(`
        WITH h AS (SELECT t FROM generate_series(timestamp '2026-06-30 22:00', timestamp '2026-07-08 02:00', interval '5 hours') t)
        SELECT count(*)::text n,
               count(*) FILTER (WHERE ${S}.get_total_supply_by_day(a.t, b.t)::text
                                  IS DISTINCT FROM ${S}.get_total_supply_by_day_before(a.t, b.t)::text)::text diff,
               count(*) FILTER (WHERE ${S}.get_total_supply_by_day(a.t, b.t) IS NOT NULL)::text answered
        FROM h a CROSS JOIN h b`)
    ).rows[0];
    assert.equal(r.diff, "0");
    assert.ok(Number(r.answered) > 500, `answered ${r.answered} of ${r.n}`);
  });
});
