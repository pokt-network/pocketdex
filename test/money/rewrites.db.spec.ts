// Report functions rewritten for speed; each must answer exactly what its previous version answered.
//   MONEY_TEST_PG=postgres://postgres:postgres@127.0.0.1:5432/postgres yarn test:money
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import {
  getAmountOfBlocksAndSuppliersByTimesFn,
  servicesPerformanceBetweenTimesFn,
} from "../../src/mappings/dbFunctions/servicePerformance";
import { getAmountOfBlocksAndSuppliersByTimesBefore } from "./fixtures/blocks_and_suppliers_before";
import { servicesPerformanceBetweenTimesBefore } from "./fixtures/services_performance_before";

interface PgClient {
  connect(): Promise<void>;
  end(): Promise<void>;
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, string | null>[] }>;
}
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Client } = require("pg") as { Client: new (options: { connectionString?: string }) => PgClient };

const URL = process.env.MONEY_TEST_PG;
const S = "rewrites_ci";

describe("report functions rewritten for speed (PostgreSQL)", { skip: !URL && "MONEY_TEST_PG not set" }, () => {
  const c = new Client({ connectionString: URL });

  before(async () => {
    await c.connect();
    await c.query("SET statement_timeout = '10s'");
    await c.query(`DROP SCHEMA IF EXISTS ${S} CASCADE; CREATE SCHEMA ${S};`);
    await c.query(`
      CREATE TABLE ${S}.blocks (id numeric, timestamp timestamp);
      CREATE INDEX ON ${S}.blocks (timestamp, id);
      -- 2026-07-01..07-10, a block every 10 minutes
      INSERT INTO ${S}.blocks
        SELECT row_number() OVER (ORDER BY t), t
        FROM generate_series(timestamp '2026-07-01 00:00', timestamp '2026-07-10 23:50', interval '10 minutes') t;

      CREATE TABLE ${S}.services (id text, name text, _block_range int8range);
      INSERT INTO ${S}.services VALUES
        ('svc1', 'one (old name)', int8range(1, 50)), ('svc1', 'one', int8range(50, NULL)),
        ('svc2', 'two', int8range(1, NULL)), ('svc3', 'three', int8range(1, NULL)),
        ('svc4', 'four', int8range(1, NULL)), ('svc5', 'five', int8range(1, NULL)),
        -- no live version: its relays are left out of the answer
        ('svc6', 'six', int8range(1, 100));

      -- a service's computed units are k * block id, k distinct per service, so no two services tie on the sort
      CREATE TABLE ${S}.relay_by_block_and_services (block_id numeric, service_id text, relays numeric,
        estimated_relays numeric, computed_units numeric, estimated_computed_units numeric, claimed_upokt numeric);
      INSERT INTO ${S}.relay_by_block_and_services
        SELECT b.id, s.id, b.id * s.k + 1, b.id * s.k * 3, b.id * s.k, b.id * s.k * 2, b.id * s.k * 11
        FROM ${S}.blocks b
        CROSS JOIN (VALUES ('svc1', 1), ('svc2', 2), ('svc3', 3), ('svc6', 7), ('svc_unknown', 13)) s(id, k);
      -- svc4 relays only on 07-05 and later, svc5 only before 07-04 (no current period in most windows)
      INSERT INTO ${S}.relay_by_block_and_services
        SELECT b.id, 'svc4', 1, 1, b.id * 5, CASE WHEN b.timestamp < '2026-07-07' THEN 0 ELSE b.id END, 0
        FROM ${S}.blocks b WHERE b.timestamp >= '2026-07-05';
      INSERT INTO ${S}.relay_by_block_and_services
        SELECT b.id, 'svc5', 2, 2, b.id * 17, b.id * 17, 5 FROM ${S}.blocks b WHERE b.timestamp < '2026-07-04';

      CREATE TABLE ${S}.applications (id text, stake_status text, _block_range int8range);
      CREATE TABLE ${S}.application_services (application_id text, service_id text, _block_range int8range);
      INSERT INTO ${S}.applications VALUES
        ('app1', 'Staked', int8range(1, NULL)),
        ('app2', 'Staked', int8range(1, 10)), ('app2', 'Unstaked', int8range(10, NULL)),
        ('app3', 'Unstaked', int8range(1, 10)), ('app3', 'Staked', int8range(10, NULL)),
        ('app4', 'Staked', int8range(1, NULL));
      INSERT INTO ${S}.application_services VALUES
        ('app1', 'svc1', int8range(1, NULL)), ('app1', 'svc2', int8range(1, NULL)),
        ('app2', 'svc1', int8range(1, NULL)),
        ('app3', 'svc1', int8range(1, 20)), ('app3', 'svc3', int8range(20, NULL)),
        ('app4', 'svc2', int8range(1, NULL)), ('app4', 'svc2', int8range(5, NULL));

      CREATE TABLE ${S}.suppliers (id text, stake_status text, _block_range int8range);
      CREATE TABLE ${S}.supplier_service_configs (supplier_id text, service_id text, _block_range int8range);
      INSERT INTO ${S}.suppliers
        SELECT 'sup' || g, CASE WHEN g % 4 = 0 THEN 'Unstaking' ELSE 'Staked' END, int8range(1, 30) FROM generate_series(1, 40) g;
      INSERT INTO ${S}.suppliers
        SELECT 'sup' || g, CASE WHEN g % 5 = 0 THEN 'Unstaked' ELSE 'Staked' END, int8range(30, NULL) FROM generate_series(1, 40) g;
      INSERT INTO ${S}.supplier_service_configs
        SELECT 'sup' || g, s, CASE WHEN g % 7 = 0 THEN int8range(1, 30) ELSE int8range(30, NULL) END
        FROM generate_series(1, 40) g CROSS JOIN unnest(ARRAY['svc1', 'svc2', 'svc3', 'svc4']) s
        WHERE g % length(s) <> 0 OR s = 'svc1';
      -- a supplier configured twice for one service counts once
      INSERT INTO ${S}.supplier_service_configs VALUES ('sup1', 'svc2', int8range(31, NULL));
      -- staked suppliers per block: services svc1..svc3 on every block, svc4 from 07-05
      CREATE TABLE ${S}.staked_suppliers_by_block_and_services (block_id numeric, service_id text, amount numeric, tokens numeric);
      INSERT INTO ${S}.staked_suppliers_by_block_and_services
        SELECT b.id, s, (b.id % 7) + length(s), b.id * 10 FROM ${S}.blocks b CROSS JOIN unnest(ARRAY['svc1', 'svc2', 'svc3']) s;
      INSERT INTO ${S}.staked_suppliers_by_block_and_services
        SELECT b.id, 'svc4', 3, 30 FROM ${S}.blocks b WHERE b.timestamp >= '2026-07-05';`);
    await c.query(servicesPerformanceBetweenTimesFn(S));
    await c.query(servicesPerformanceBetweenTimesBefore(S));
    await c.query(getAmountOfBlocksAndSuppliersByTimesFn(S));
    await c.query(getAmountOfBlocksAndSuppliersByTimesBefore(S));
  });
  after(async () => {
    await c.query(`DROP SCHEMA IF EXISTS ${S} CASCADE`);
    await c.end();
  });

  describe("services_performance_between_times", () => {
    const both = async (e: string | null, m: string | null, s: string | null) => {
      const r = (
        await c.query(
          `SELECT ${S}.services_performance_between_times($1, $2, $3)::text n,
                  ${S}.services_performance_between_times_before($1, $2, $3)::text o`,
          [e, m, s]
        )
      ).rows[0];
      return { now: r.n, before: r.o };
    };

    it("answers the seeded services with real values", async () => {
      const { now } = await both("2026-07-08 00:00", "2026-07-06 00:00", "2026-07-04 00:00");
      assert.ok(now);
      const rows = JSON.parse(now) as { service_id: string; apps_staked: number; suppliers_staked: number }[];
      assert.deepEqual(
        rows.map((r) => r.service_id),
        ["svc4", "svc3", "svc2", "svc1"]
      );
      assert.ok(rows.every((r) => r.suppliers_staked > 0));
      assert.ok(rows.some((r) => r.apps_staked > 0));
    });

    const windows: [string, string | null, string | null, string | null][] = [
      ["a day against the day before", "2026-07-06 00:00", "2026-07-05 00:00", "2026-07-04 00:00"],
      ["the whole seed", "2026-07-10 23:50", "2026-07-05 12:00", "2026-07-01 00:00"],
      ["wider than the seed", "2026-08-01", "2026-07-05", "2026-06-01"],
      ["edges on blocks", "2026-07-03 10:10", "2026-07-03 10:00", "2026-07-03 09:50"],
      ["edges between blocks", "2026-07-03 10:15", "2026-07-03 10:05", "2026-07-03 09:55"],
      ["no previous blocks", "2026-07-01 05:00", "2026-07-01 00:00", "2026-06-30 00:00"],
      ["no current blocks", "2026-08-02", "2026-08-01", "2026-07-02"],
      ["previous period with zero estimated units", "2026-07-08 00:00", "2026-07-06 00:00", "2026-07-05 00:00"],
      ["start after end", "2026-07-02", "2026-07-05", "2026-07-08"],
      ["infinite bounds", "infinity", "2026-07-05", "-infinity"],
      ["no end", null, "2026-07-05", "2026-07-03"],
      ["no middle", "2026-07-05", null, "2026-07-03"],
      ["no start", "2026-07-05", "2026-07-04", null],
    ];
    for (const [name, e, m, s] of windows) {
      it(`answers byte for byte what the previous version answered: ${name}`, async () => {
        const r = await both(e, m, s);
        assert.equal(r.now, r.before);
      });
    }

    it("answers byte for byte what the previous version answered on every 13-hour window pair of the seed", async () => {
      const r = (
        await c.query(`
          WITH h AS (SELECT t FROM generate_series(timestamp '2026-06-30 20:00', timestamp '2026-07-11 04:00', interval '13 hours') t)
          SELECT count(*)::text n,
                 count(*) FILTER (WHERE ${S}.services_performance_between_times(a.t + (a.t - b.t), a.t, b.t)::text
                   IS DISTINCT FROM ${S}.services_performance_between_times_before(a.t + (a.t - b.t), a.t, b.t)::text)::text diff,
                 count(*) FILTER (WHERE ${S}.services_performance_between_times(a.t + (a.t - b.t), a.t, b.t) IS NOT NULL)::text answered
          FROM h a JOIN h b ON b.t < a.t`)
      ).rows[0];
      assert.equal(r.diff, "0");
      assert.ok(Number(r.answered) > 100, `answered ${r.answered} of ${r.n}`);
    });
  });

  describe("get_amount_of_blocks_and_suppliers_by_times", () => {
    const both = async (a: string | null, b: string | null) => {
      const r = (
        await c.query(
          `SELECT ${S}.get_amount_of_blocks_and_suppliers_by_times($1, $2)::text n,
                  ${S}.get_amount_of_blocks_and_suppliers_by_times_before($1, $2)::text o`,
          [a, b]
        )
      ).rows[0];
      return { now: r.n, before: r.o };
    };
    it("answers the seeded services with real values", async () => {
      const { now } = await both("2026-07-04 00:00", "2026-07-06 00:00");
      assert.ok(now);
      const rows = JSON.parse(now) as { service_id: string; blocks: number }[];
      assert.deepEqual(rows.map((r) => r.service_id).sort(), ["svc1", "svc2", "svc3", "svc4"]);
      assert.equal(rows.find((r) => r.service_id === "svc1")?.blocks, 2 * 144 + 1);
    });
    for (const [name, a, b] of [
      ["two days", "2026-07-04 00:00", "2026-07-06 00:00"],
      ["edges between blocks", "2026-07-03 10:05", "2026-07-03 12:15"],
      ["wider than the seed", "2026-06-01", "2026-08-01"],
      ["no blocks", "2026-08-01", "2026-08-02"],
      ["start after end", "2026-07-05", "2026-07-03"],
      ["infinite", "-infinity", "infinity"],
      ["no start", null, "2026-07-03"],
      ["no end", "2026-07-03", null],
    ] as const) {
      it(`answers byte for byte what the previous version answered: ${name}`, async () => {
        const r = await both(a, b);
        assert.equal(r.now, r.before);
      });
    }
  });
});
