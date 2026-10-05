// get_claim_proofs_data_by_time now reads claims_by_block, one row per block written by write_claims_by_block; it must
// answer exactly what the previous version answered from the raw tables.
//   MONEY_TEST_PG=postgres://postgres:postgres@127.0.0.1:5432/postgres yarn test:money
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createClaimsByBlockFn, getClaimProofsDataByTimeFn } from "../../src/mappings/dbFunctions/claimProofs";
import { getClaimProofsDataByTimeBefore } from "./fixtures/claim_proofs_by_time_before";

interface PgClient {
  connect(): Promise<void>;
  end(): Promise<void>;
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, string | null>[] }>;
}
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Client } = require("pg") as { Client: new (options: { connectionString?: string }) => PgClient };

const URL = process.env.MONEY_TEST_PG;
const S = "claim_proofs_ci";
const RAW = ["msg_create_claims", "event_claim_settleds", "event_claim_expireds"];

describe("get_claim_proofs_data_by_time over claims_by_block (PostgreSQL)", { skip: !URL && "MONEY_TEST_PG not set" }, () => {
  const c = new Client({ connectionString: URL });
  const table = async () =>
    (await c.query(`SELECT coalesce(jsonb_agg(t ORDER BY block_id)::text, '[]') j FROM ${S}.claims_by_block t`)).rows[0].j;
  const maxHeight = async () => Number((await c.query(`SELECT max(id)::text m FROM ${S}.blocks`)).rows[0].m);

  before(async () => {
    await c.connect();
    await c.query("SET statement_timeout = '20s'");
    await c.query(`DROP SCHEMA IF EXISTS ${S} CASCADE; CREATE SCHEMA ${S};`);
    const cols = `id text, block_id numeric, num_relays numeric, num_estimated_relays numeric,
      num_claimed_computed_units numeric, num_estimated_computed_units numeric, claimed_amount numeric,
      _block_range int8range`;
    await c.query(`
      CREATE TABLE ${S}.blocks (id numeric, timestamp timestamp, _block_range int8range);
      ${RAW.map((t) => `CREATE TABLE ${S}.${t} (${cols});`).join("\n")}
      -- 2026-07-01..07-06, a block every 37 minutes from 00:10; 07-04 has none
      INSERT INTO ${S}.blocks
        SELECT row_number() OVER (ORDER BY t), t, int8range(1, NULL)
        FROM generate_series(timestamp '2026-07-01 00:10', timestamp '2026-07-06 23:00', interval '37 minutes') t
        WHERE t::date <> date '2026-07-04';
      -- one more block exactly at midnight of 07-05
      INSERT INTO ${S}.blocks SELECT max(id) + 1, timestamp '2026-07-05 00:00', int8range(1, NULL) FROM ${S}.blocks;
      -- claims every 3rd block, settlements every 5th, expirations every 7th, 1-4 rows each
      INSERT INTO ${S}.msg_create_claims
        SELECT b.id || '-c-' || g, b.id, 100 + g, 90 + g, 1000 * g, 900 * g, 7 * g, int8range(b.id::bigint, NULL)
        FROM ${S}.blocks b, generate_series(1, 1 + (b.id::int % 4)) g WHERE b.id % 3 = 0;
      INSERT INTO ${S}.event_claim_settleds
        SELECT b.id || '-s-' || g, b.id, 50 + g, 40 + g, 500 * g, 400 * g, 3 * g, int8range(b.id::bigint, NULL)
        FROM ${S}.blocks b, generate_series(1, 1 + (b.id::int % 3)) g WHERE b.id % 5 = 0;
      INSERT INTO ${S}.event_claim_expireds
        SELECT b.id || '-e-' || g, b.id, 20 + g, 10 + g, 200 * g, 100 * g, 11 * g, int8range(b.id::bigint, NULL)
        FROM ${S}.blocks b, generate_series(1, 2) g WHERE b.id % 7 = 0;
      -- older rows without the estimated columns (NULL), as before they were indexed
      UPDATE ${S}.msg_create_claims SET num_estimated_relays = NULL, num_estimated_computed_units = NULL
        WHERE block_id < 20;
      -- a block whose only settlement has every sum NULL
      INSERT INTO ${S}.event_claim_settleds VALUES ('8-s-null', 8, NULL, NULL, NULL, NULL, NULL, int8range(8, NULL));
      -- the same expired event stored several times in its block, as mainnet has at 551,673-554,673
      INSERT INTO ${S}.event_claim_expireds SELECT * FROM ${S}.event_claim_expireds WHERE block_id = 14;
      INSERT INTO ${S}.event_claim_expireds SELECT * FROM ${S}.event_claim_expireds WHERE block_id = 14;
      -- rows of a height with no row in blocks: the previous version dropped them in its join
      INSERT INTO ${S}.msg_create_claims VALUES ('orphan-c', 100000, 1, 1, 1, 1, 1, int8range(100000, NULL));
      INSERT INTO ${S}.event_claim_expireds VALUES ('orphan-e', 100000, 1, 1, 1, 1, 1, int8range(100000, NULL));`);
    await c.query(createClaimsByBlockFn(S));
    await c.query(getClaimProofsDataByTimeFn(S));
    await c.query(getClaimProofsDataByTimeBefore(S));
    await c.query(`SELECT ${S}.write_claims_by_block(1, 100000)`);
  });
  after(async () => {
    await c.query(`DROP SCHEMA IF EXISTS ${S} CASCADE`);
    await c.end();
  });

  const both = async (a: string | null, b: string | null, tr: string | null) => {
    const r = (
      await c.query(
        `SELECT ${S}.get_claim_proofs_data_by_time($1, $2, $3)::text n,
                ${S}.get_claim_proofs_data_by_time_before($1, $2, $3)::text o`,
        [a, b, tr]
      )
    ).rows[0];
    return { now: r.n, before: r.o };
  };

  it("writes one row per block with claims, settlements or expirations, and none for a height missing in blocks", async () => {
    const r = (
      await c.query(`
        SELECT (SELECT count(*) FROM ${S}.claims_by_block)::text n,
               (SELECT count(*) FROM ${S}.blocks WHERE id % 3 = 0 OR id % 5 = 0 OR id % 7 = 0 OR id = 8)::text want,
               (SELECT count(*) FROM ${S}.claims_by_block WHERE block_id = 100000)::text orphan,
               (SELECT expired_count || '/' || expired_relays FROM ${S}.claims_by_block WHERE block_id = 14) dup,
               (SELECT settled_count || '/' || coalesce(settled_relays::text, 'null') FROM ${S}.claims_by_block
                  WHERE block_id = 8) nulls`)
    ).rows[0];
    assert.equal(r.n, r.want);
    assert.equal(r.orphan, "0");
    // 2 distinct ids, each stored 4 times: counted once, summed four times, as the previous version did
    assert.equal(r.dup, `2/${4 * (21 + 22)}`);
    assert.equal(r.nulls, "1/null");
  });

  it("answers real values for the seed", async () => {
    const { now } = await both("2026-07-01 00:00", "2026-07-06 23:59:59", "day");
    assert.ok(now);
    const days = JSON.parse(now) as { date: string; claim_amount: number; proof_amount: number }[];
    assert.deepEqual(
      days.map((d) => d.date.slice(0, 10)),
      ["2026-07-01", "2026-07-02", "2026-07-03", "2026-07-05", "2026-07-06"]
    );
    assert.ok(days.every((d) => d.claim_amount > 0 && d.proof_amount > 0));
  });

  const ranges: [string, string | null, string | null, string | null][] = [
    ["whole seed by day", "2026-07-01 00:00", "2026-07-06 23:59:59", "day"],
    ["whole seed by hour", "2026-07-01 00:00", "2026-07-06 23:59:59", "hour"],
    ["whole seed by week", "2026-07-01 00:00", "2026-07-06 23:59:59", "week"],
    ["whole seed by month", "2026-06-01 00:00", "2026-08-01 00:00", "month"],
    ["mid-day both ends", "2026-07-01 13:07", "2026-07-05 05:15", "day"],
    ["end on the midnight block", "2026-07-03 00:00", "2026-07-05 00:00", "day"],
    ["start on the midnight block", "2026-07-05 00:00", "2026-07-05 03:00", "hour"],
    ["only the day without blocks", "2026-07-04 00:00", "2026-07-04 23:59:59", "day"],
    ["before any block", "2020-01-01", "2020-02-01", "day"],
    ["start after end", "2026-07-05 00:00", "2026-07-03 00:00", "day"],
    ["same instant on a block", "2026-07-05 00:00", "2026-07-05 00:00", "day"],
    ["infinite bounds", "-infinity", "infinity", "day"],
    ["no start", null, "2026-07-05 00:00", "day"],
    ["no end", "2026-07-02 00:00", null, "day"],
    ["no interval", "2026-07-01 00:00", "2026-07-06 23:59:59", null],
  ];
  for (const [name, a, b, tr] of ranges) {
    it(`answers byte for byte what the previous version answered: ${name}`, async () => {
      const r = await both(a, b, tr);
      assert.equal(r.now, r.before);
    });
  }

  it("fails like the previous version on an unknown interval", async () => {
    for (const f of ["get_claim_proofs_data_by_time", "get_claim_proofs_data_by_time_before"]) {
      await assert.rejects(c.query(`SELECT ${S}.${f}('2026-07-01', '2026-07-02', 'fortnight')`), /not recognized/);
    }
  });

  it("answers byte for byte what the previous version answered on every 7-hour range of the seed, by hour and day", async () => {
    const r = (
      await c.query(`
        WITH h AS (SELECT t FROM generate_series(timestamp '2026-06-30 22:00', timestamp '2026-07-07 02:00', interval '7 hours') t)
        SELECT count(*)::text n,
               count(*) FILTER (WHERE ${S}.get_claim_proofs_data_by_time(a.t, b.t, tr)::text
                                  IS DISTINCT FROM ${S}.get_claim_proofs_data_by_time_before(a.t, b.t, tr)::text)::text diff,
               count(*) FILTER (WHERE ${S}.get_claim_proofs_data_by_time(a.t, b.t, tr) IS NOT NULL)::text answered
        FROM h a CROSS JOIN h b CROSS JOIN (VALUES ('hour'), ('day')) v(tr)`)
    ).rows[0];
    assert.equal(r.diff, "0");
    assert.ok(Number(r.answered) > 400, `answered ${r.answered} of ${r.n}`);
  });

  it("writes the same table block by block as in one range, and again on a rewrite", async () => {
    const once = await table();
    const top = await maxHeight();
    await c.query(`TRUNCATE ${S}.claims_by_block`);
    for (let h = 1; h <= top; h++) await c.query(`SELECT ${S}.write_claims_by_block($1, $1)`, [h]);
    assert.equal(await table(), once);
    // the history fill over a range the indexer already wrote, in uneven chunks
    for (let h = 1; h <= top; h += 17) await c.query(`SELECT ${S}.write_claims_by_block($1, $2)`, [h, h + 16]);
    assert.equal(await table(), once);
  });

  it("rewrites a reindexed height: changed rows are replaced and a height left without events loses its row", async () => {
    const once = await table();
    await c.query("BEGIN");
    try {
      // height 15 is reindexed with one claim less and no settlement; height 21 with no claims or expirations at all
      await c.query(`DELETE FROM ${S}.msg_create_claims WHERE id = '15-c-1'`);
      await c.query(`DELETE FROM ${S}.event_claim_settleds WHERE block_id = 15`);
      await c.query(`DELETE FROM ${S}.msg_create_claims WHERE block_id = 21`);
      await c.query(`DELETE FROM ${S}.event_claim_expireds WHERE block_id = 21`);
      await c.query(`SELECT ${S}.write_claims_by_block(15, 15)`);
      await c.query(`SELECT ${S}.write_claims_by_block(21, 21)`);
      const r = (
        await c.query(`SELECT (SELECT claim_count || '/' || settled_count FROM ${S}.claims_by_block WHERE block_id = 15) h15,
                              (SELECT count(*)::text FROM ${S}.claims_by_block WHERE block_id = 21) h21`)
      ).rows[0];
      assert.equal(r.h15, "3/0");
      assert.equal(r.h21, "0");
      const after = await both("2026-07-01 00:00", "2026-07-06 23:59:59", "hour");
      assert.equal(after.now, after.before);
    } finally {
      await c.query("ROLLBACK");
    }
    assert.equal(await table(), once);
  });

  // coverage at M = 90 (a block with claims, mid-seed): the table is complete from M up; below it, as before the fill,
  // it has nothing. A row of M is altered so that an answer read from the table shows it.
  const M = 90;
  const withCoverageAtM = async (fn: () => Promise<void>) => {
    await c.query("BEGIN");
    try {
      await c.query(`UPDATE ${S}.claims_by_block_coverage SET covered_from_height = $1`, [M]);
      await c.query(`DELETE FROM ${S}.claims_by_block WHERE block_id < $1`, [M]);
      await c.query(`UPDATE ${S}.claims_by_block SET claim_count = claim_count + 1000 WHERE block_id = $1`, [M]);
      await fn();
    } finally {
      await c.query("ROLLBACK");
    }
  };
  const ts = async (h: number) =>
    (await c.query(`SELECT timestamp::text t FROM ${S}.blocks WHERE id = $1`, [h])).rows[0].t as string;

  it("reads claims_by_block when the range has no block below the coverage", async () => {
    await withCoverageAtM(async () => {
      const r = await both(await ts(M), "2026-07-06 23:59:59", "day");
      assert.notEqual(r.now, r.before);
    });
  });

  it("answers from the raw tables, as before, when the range starts below the coverage", async () => {
    await withCoverageAtM(async () => {
      for (const [a, b, tr] of [
        ["2026-07-01 00:00", "2026-07-06 23:59:59", "day"],
        ["2026-07-01 00:00", "2026-07-06 23:59:59", "hour"],
        ["-infinity", "infinity", "day"],
        [await ts(M - 50), await ts(M + 50), "hour"],
      ]) {
        const r = await both(a, b, tr);
        assert.ok(r.now);
        assert.equal(r.now, r.before);
      }
    });
  });

  it("switches at the coverage: from the block below it is raw, from just after that block it is the table", async () => {
    await withCoverageAtM(async () => {
      const below = await both(await ts(M - 1), "2026-07-06 23:59:59", "hour");
      assert.equal(below.now, below.before);
      const after = (
        await c.query(`SELECT (timestamp + interval '1 microsecond')::text t FROM ${S}.blocks WHERE id = $1`, [M - 1])
      ).rows[0].t as string;
      for (const a of [after, await ts(M)]) {
        const r = await both(a, "2026-07-06 23:59:59", "hour");
        assert.notEqual(r.now, r.before);
      }
      // a range that ends before the coverage is raw too
      const old = await both("2026-07-01 00:00", await ts(M - 1), "hour");
      assert.equal(old.now, old.before);
    });
  });

  it("answers byte for byte what the previous version answered on every 7-hour range with the table filled from the middle", async () => {
    await c.query("BEGIN");
    try {
      await c.query(`UPDATE ${S}.claims_by_block_coverage SET covered_from_height = $1`, [M]);
      await c.query(`DELETE FROM ${S}.claims_by_block WHERE block_id < $1`, [M]);
      const r = (
        await c.query(`
          WITH h AS (SELECT t FROM generate_series(timestamp '2026-06-30 22:00', timestamp '2026-07-07 02:00', interval '7 hours') t)
          SELECT count(*) FILTER (WHERE ${S}.get_claim_proofs_data_by_time(a.t, b.t, tr)::text
                                    IS DISTINCT FROM ${S}.get_claim_proofs_data_by_time_before(a.t, b.t, tr)::text)::text diff
          FROM h a CROSS JOIN h b CROSS JOIN (VALUES ('hour'), ('day')) v(tr)`)
      ).rows[0];
      assert.equal(r.diff, "0");
    } finally {
      await c.query("ROLLBACK");
    }
  });

  it("starts the coverage at the next height to index, and lowers it only by writes that reach it", async () => {
    const cov = async () =>
      Number((await c.query(`SELECT covered_from_height::text h FROM ${S}.claims_by_block_coverage`)).rows[0].h);
    await c.query("BEGIN");
    try {
      await c.query(`DROP TABLE ${S}.claims_by_block_coverage`);
      await c.query(createClaimsByBlockFn(S));
      const top = await maxHeight();
      assert.equal(await cov(), top + 1);
      // the start again keeps it
      await c.query(createClaimsByBlockFn(S));
      assert.equal(await cov(), top + 1);
      // the indexer's next block keeps the table complete from the same height
      await c.query(`SELECT ${S}.write_claims_by_block($1, $1)`, [top + 1]);
      assert.equal(await cov(), top + 1);
      // a range that leaves a gap below the coverage does not lower it
      await c.query(`SELECT ${S}.write_claims_by_block(1, $1)`, [top - 1]);
      assert.equal(await cov(), top + 1);
      // the fill walking down from it lowers it chunk by chunk
      await c.query(`SELECT ${S}.write_claims_by_block($1, $2)`, [top - 9, top]);
      assert.equal(await cov(), top - 9);
      await c.query(`SELECT ${S}.write_claims_by_block($1, $2)`, [top - 30, top - 10]);
      assert.equal(await cov(), top - 30);
      // rewriting heights inside the covered part leaves it as is
      await c.query(`SELECT ${S}.write_claims_by_block($1, $1)`, [top - 5]);
      assert.equal(await cov(), top - 30);
    } finally {
      await c.query("ROLLBACK");
    }
  });

  it("answers like the raw tables after a rewind, before and after the indexer writes again", async () => {
    await c.query("BEGIN");
    try {
      // SubQuery's rewind to 120 removes the blocks and the raw rows above it, and leaves claims_by_block as it was
      await c.query(`DELETE FROM ${S}.blocks WHERE id > 120`);
      for (const t of RAW) await c.query(`DELETE FROM ${S}.${t} WHERE block_id > 120 AND block_id < 100000`);
      const ranges: [string, string, string][] = [
        ["2026-07-01 00:00", "2026-07-06 23:59:59", "hour"],
        ["-infinity", "infinity", "day"],
      ];
      for (const [a, b, tr] of ranges) {
        const r = await both(a, b, tr);
        assert.equal(r.now, r.before);
      }
      // the indexer writes 121 again, now with one claim only: the rows above it go
      await c.query(`INSERT INTO ${S}.blocks VALUES (121, timestamp '2026-07-05 23:00', int8range(121, NULL))`);
      await c.query(`INSERT INTO ${S}.msg_create_claims VALUES ('121-c-x', 121, 5, 5, 5, 5, 5, int8range(121, NULL))`);
      await c.query(`SELECT ${S}.write_claims_by_block(121, 121)`);
      const above = (await c.query(`SELECT count(*)::text n FROM ${S}.claims_by_block WHERE block_id > 121`)).rows[0];
      assert.equal(above.n, "0");
      for (const [a, b, tr] of ranges) {
        const r = await both(a, b, tr);
        assert.equal(r.now, r.before);
      }
    } finally {
      await c.query("ROLLBACK");
    }
  });
});
