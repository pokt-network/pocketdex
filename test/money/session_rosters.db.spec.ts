// The session rosters (sessionRosters.ts) over a small chain, block by block as handleAddBlockReports runs them: the
// rosters written at each session start with who sat in each seat then, the final states at each settlement block
// (where the params placed it or where its claims settled), the rollups against the seats one by one, the money gap and
// its fill, and the catalog functions over them.
//   MONEY_TEST_PG=postgres://postgres:postgres@127.0.0.1:5432/postgres yarn test:money
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createDomainServiceDailyRewardsTableFn } from "../../src/mappings/dbFunctions/domainRewards";
import { createSupplierRevShareWalletsFn } from "../../src/mappings/dbFunctions/revShareWallets";
import {
  createSessionRosterFunctionsFn,
  createSessionRosterTablesFn,
  createSessionRosterWritersFn,
  SESSION_ROSTER_CATALOG_FUNCTIONS,
  SESSION_ROSTER_STATE_FUNCTIONS,
  SESSION_STATES,
} from "../../src/mappings/dbFunctions/sessionRosters";
import { createSettlementFunctionsFn } from "../../src/mappings/dbFunctions/settlement/functions";
import { createSettlementTablesFn } from "../../src/mappings/dbFunctions/settlement/schema";
import { createSettlementSmartTagsFn } from "../../src/mappings/dbFunctions/settlement/smartTags";
import { createSettlementWriterFn } from "../../src/mappings/dbFunctions/settlement/writer";
import { backfillSessionRosters } from "../../scripts/backfill_session_rosters";
import { finalizeRostersAt } from "../../src/mappings/money/history/job";
import { buildSessionRosters, SessionRosterInputs, sessionRosterStep } from "../../src/mappings/pocket/sessionRosters";

type Row = Record<string, unknown>;
interface PgClient {
  connect(): Promise<void>;
  end(): Promise<void>;
  query(sql: string, params?: unknown[]): Promise<{ rows: Row[] }>;
}
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Client } = require("pg") as { Client: new (options: { connectionString?: string }) => PgClient };

const URL = process.env.MONEY_TEST_PG;
const S = "session_rosters_ci";
const STATES = SESSION_STATES.slice(1);
const RANGE = ["2026-09-01T00:00:00Z", "2026-09-03T00:00:00Z"];
const P = ["p1", "p2", "p3", "p4", "p5"];

describe("session rosters (PostgreSQL)", { skip: !URL && "MONEY_TEST_PG not set" }, () => {
  let a4: { id: string; members: string[] } = { id: "", members: [] };
  const c = new Client({ connectionString: URL });
  const q = async (sql: string, params?: unknown[]) => (await c.query(sql, params)).rows;
  // what handleAddBlockReports does at a block (sessionRosterStep, in the block transaction); inputsRead counts the
  // blocks it read the start inputs for
  let inputsRead = 0;
  const block = async (h: number) => {
    const counted = async (sql: string, params: unknown[]) => {
      if (sql.includes("_session_roster_inputs(") && params.length === 1) inputsRead += 1;
      return q(sql, params);
    };
    await q("BEGIN");
    try {
      const { changed } = await sessionRosterStep(counted, S, h, 1, true);
      await q("COMMIT");
      return changed;
    } catch (e) {
      await q("ROLLBACK");
      throw e;
    }
  };
  const members = async (app: string, svc: string, start: number) =>
    (
      await q(
        `SELECT n.supplier_id FROM ${S}.session_suppliers ss
         JOIN ${S}.session_rosters r ON r.session_num = ss.session_num
         JOIN ${S}.application_numbers a ON a.application_num = r.application_num AND a.application_id = $1
         JOIN ${S}.service_numbers v ON v.service_num = r.service_num AND v.service_id = $2
         JOIN ${S}.supplier_numbers n ON n.supplier_num = ss.supplier_num
         WHERE r.start_height = $3 ORDER BY 1`,
        [app, svc, start]
      )
    ).map((r) => String(r.supplier_id));
  const sessionId = async (app: string, svc: string, start: number) =>
    String(
      (
        await q(
          `SELECT r.session_id FROM ${S}.session_rosters r
           JOIN ${S}.application_numbers a ON a.application_num = r.application_num AND a.application_id = $1
           JOIN ${S}.service_numbers v ON v.service_num = r.service_num AND v.service_id = $2
           WHERE r.start_height = $3`,
          [app, svc, start]
        )
      )[0].session_id
    );
  // a settled claim with its paid shareholder share (relay 60%, global 10% of the settled amount), and what each rev-share
  // address of the supplier's config at the settlement block received of it (shareholder_payouts: each leg by its
  // percentage, rounded down, the remainder to the last address, so the parts add up to the share)
  const settle = async (h: number, i: number, sup: string, app: string, svc: string, end: number, upokt: number) => {
    await settleClaim(h, i, sup, app, svc, end, upokt);
    await q(
      `INSERT INTO ${S}.shareholder_payouts (height, event_idx, supplier_id, service_id, recipient_id, relay_upokt, global_upokt,
         row_source, calc_version)
       WITH cfg AS (SELECT c.rev_share FROM ${S}.supplier_service_configs c
                    WHERE c.supplier_id = $3 AND c.service_id = $4 AND c._block_range @> $1::bigint
                    ORDER BY lower(c._block_range) DESC LIMIT 1),
       r AS (SELECT e->>'address' a, (e->>'revSharePercentage')::bigint pct, row_number() OVER () i, count(*) OVER () n
             FROM cfg CROSS JOIN jsonb_array_elements(cfg.rev_share) e),
       legs AS (SELECT r.*, $5::bigint * 6 / 10 * r.pct / 100 rl, $5::bigint / 10 * r.pct / 100 gl FROM r)
       SELECT $1, $2, $3, $4, legs.a,
              legs.rl + CASE WHEN legs.i = legs.n THEN $5::bigint * 6 / 10 - sum(legs.rl) OVER () ELSE 0 END,
              legs.gl + CASE WHEN legs.i = legs.n THEN $5::bigint / 10 - sum(legs.gl) OVER () ELSE 0 END, 'test', 1
       FROM legs`,
      [h, i, sup, svc, upokt]
    );
  };
  const settleClaim = (h: number, i: number, sup: string, app: string, svc: string, end: number, upokt: number) =>
    q(
      `INSERT INTO ${S}.claim_settlements (height, event_idx, block_time, supplier_id, application_id, service_id,
         session_id, session_end, claimed_upokt, settled_upokt, relay_minted_upokt, overservicing_loss_upokt,
         mint_ratio_unminted_upokt, global_minted_upokt, relays, estimated_relays, claimed_compute_units,
         estimated_compute_units, relay_to_supplier_upokt, relay_to_dao_upokt, relay_to_source_owner_upokt,
         relay_to_application_upokt, relay_to_stakers_upokt, global_to_supplier_upokt, global_to_dao_upokt,
         global_to_source_owner_upokt, global_to_application_upokt, reimbursement_to_dao_upokt, row_source, calc_version,
         settled_with_proof)
       VALUES ($1, $2, now(), $3, $4, $5, 'x', $6, $7::bigint, $7::bigint, 0, 0, 0, 0, 3, 3, 5, 5, $7::bigint * 6 / 10, 0, 0, 0, 0,
         $7::bigint / 10, 0, 0, 0, 0,
         'test', 1, true)`,
      [h, i, sup, app, svc, end, upokt]
    );

  before(async () => {
    await c.connect();
    await c.query("SET statement_timeout = '30s'");
    await c.query(`DROP SCHEMA IF EXISTS ${S} CASCADE; CREATE SCHEMA ${S};`);
    await c.query(createSettlementTablesFn(S));
    await c.query(createSettlementWriterFn(S));
    await c.query(`
      CREATE TABLE ${S}.event_claim_settleds (block_id numeric);
      CREATE TABLE ${S}.delegations (id text);
      -- a1 delegates to g1 until block 13 and to g2 from it; a2 to g1 throughout
      CREATE TABLE ${S}.application_gateways (gateway_id text, application_id text, _block_range int8range);
      INSERT INTO ${S}.application_gateways VALUES ('g1', 'a1', '[1,13)'), ('g2', 'a1', '[13,)'), ('g1', 'a2', '[1,)');
      INSERT INTO ${S}.money_progress VALUES (true, 1, 999999999);
      -- 48 blocks an hour apart from 2026-09-01 00:00 (the rosters cover the first day whole): two UTC days
      CREATE TABLE ${S}.blocks (id numeric, timestamp timestamp, hash text);
      CREATE INDEX ON ${S}.blocks (timestamp, id);
      INSERT INTO ${S}.blocks SELECT g, timestamp '2026-09-01 00:00' + (g - 1) * interval '1 hour',
        upper(md5(g::text) || md5((g + 1000)::text)) FROM generate_series(1, 48) g;
      -- sessions of 4 blocks, rosters of 3: grace end + 1, claims end + 2 .. end + 4, proofs end + 4 .. end + 6, settled at
      -- end + 1 + 1 + 2 + 0 + 2 = end + 6; from block 22 the proof window closes 3 blocks after it opens (end + 7)
      CREATE TABLE ${S}.params (id text, namespace text, key text, value text, block_id numeric, active_at numeric,
        _block_range int8range);
      INSERT INTO ${S}.params VALUES
        ('a', 'shared', 'num_blocks_per_session', '4', 1, 1, '[1,)'),
        ('b', 'session', 'num_suppliers_per_session', '3', 1, 1, '[1,)'),
        ('c', 'shared', 'claim_window_open_offset_blocks', '1', 1, 1, '[1,)'),
        ('d', 'shared', 'claim_window_close_offset_blocks', '2', 1, 1, '[1,)'),
        ('e', 'shared', 'proof_window_open_offset_blocks', '0', 1, 1, '[1,)'),
        ('f', 'shared', 'proof_window_close_offset_blocks', '2', 1, 1, '[1,22)'),
        ('f', 'shared', 'proof_window_close_offset_blocks', '3', 22, 22, '[22,)'),
        ('g', 'shared', 'grace_period_end_offset_blocks', '1', 1, 1, '[1,)');
      -- a1, a2 on s1; a3 on s2, unstaking from block 9 (it keeps the session 9-12, not 13-16)
      CREATE TABLE ${S}.applications (id text, stake_status text, unstaking_begin_block_id numeric, _block_range int8range);
      INSERT INTO ${S}.applications VALUES ('a1', 'Staked', NULL, '[1,)'), ('a2', 'Staked', NULL, '[1,)'),
        ('a3', 'Staked', NULL, '[1,9)'), ('a3', 'Unstaking', 9, '[9,)'),
        -- a4 stakes at 6, during the session 5-8: the chain validates its claims of that session (the start had no a4)
        ('a4', 'Staked', NULL, '[6,)');
      CREATE TABLE ${S}.application_services (id text, application_id text, service_id text, _block_range int8range);
      INSERT INTO ${S}.application_services VALUES ('a1-s1', 'a1', 's1', '[1,)'), ('a2-s1', 'a2', 's1', '[1,)'),
        ('a3-s2', 'a3', 's2', '[1,)'), ('a4-s1', 'a4', 's1', '[6,)');
      -- s1: p1..p5, and p6 staked at 5 but activated at 7 (a candidate from the start 9 on); s2: q1, q2
      CREATE TABLE ${S}.supplier_service_configs (supplier_id text, service_id text, activated_at_id numeric,
        rev_share jsonb, domains jsonb, _block_range int8range);
      INSERT INTO ${S}.supplier_service_configs
        -- p1 serves from a.net, p2 from b.io, p3 from a.net until it moves to b.io in the start block 13 (the session
        -- 13-16 is still served from a.net, the version closed at its start)
        -- p1 shares revenue 50/50 with r1 and r4; p2 with r1 alone until the start 13 and 1/49/50 with r2, r3 and r5
        -- from it (the session 13-16 is still r1's, the version closed at its start)
        SELECT p, 's1', 1, CASE WHEN p = 'p1' THEN '[{"address": "r1", "revSharePercentage": "50"},
                                                   {"address": "r4", "revSharePercentage": "50"}]'::jsonb ELSE '[]' END,
               CASE WHEN p = 'p1' THEN '["a.net"]'::jsonb ELSE '[]' END, '[1,)'::int8range
        FROM unnest(ARRAY['p1']) p
        -- p4 shares with r6 and r7: 50/50, then 20/80 from block 14 (the start 17 is served by it, the same UTC day as 13's)
        UNION ALL SELECT 'p4', 's1', 1, '[{"address": "r6", "revSharePercentage": "50"}, {"address": "r7", "revSharePercentage": "50"}]',
                         '[]', '[1,14)'
        UNION ALL SELECT 'p4', 's1', 14, '[{"address": "r6", "revSharePercentage": "20"}, {"address": "r7", "revSharePercentage": "80"}]',
                         '[]', '[14,)'
        UNION ALL SELECT 'p2', 's1', 1, '[{"address": "r1", "revSharePercentage": "100"}]', '["b.io"]', '[1,13)'
        UNION ALL SELECT 'p2', 's1', 13, '[{"address": "r3", "revSharePercentage": "49"}, {"address": "r2", "revSharePercentage": "1"},
                                           {"address": "r5", "revSharePercentage": "50"}]', '["b.io"]', '[13,)'
        UNION ALL SELECT 'p3', 's1', 1, '[]', '["a.net"]', '[1,13)'
        UNION ALL SELECT 'p3', 's1', 1, '[]', '["b.io"]', '[13,)'
        -- p5 unstakes at the start block 9: still a candidate of the session 9-12, not of 13-16
        UNION ALL SELECT 'p5', 's1', 1, '[]', '[]', '[1,9)'
        UNION ALL SELECT 'p6', 's1', 7, '[]', '[]', '[5,)'
        -- p7 stakes in the start block 9: its config has no activation until the start 13 writes the activated version,
        -- so it is a candidate from 13 on, not at 9 (mainnet 894,421)
        UNION ALL SELECT 'p7', 's1', NULL, '[]', '[]', '[9,13)'
        UNION ALL SELECT 'p7', 's1', 13, '[]', '[]', '[13,)'
        UNION ALL SELECT q, 's2', 1, '[]', '[]', '[1,)' FROM unnest(ARRAY['q1', 'q2']) q;
      CREATE TABLE ${S}.suppliers (id text, owner_id text, stake_status text, _block_range int8range);
      -- p4 passes from o2 to o3 at the start block 13 (its seats are o3's from the start 17 on)
      INSERT INTO ${S}.suppliers SELECT p, CASE WHEN p IN ('p1', 'p2') THEN 'o1' ELSE 'o2' END, 'Staked',
          CASE WHEN p = 'p4' THEN '[1,13)' ELSE '[1,)' END::int8range
        FROM unnest(ARRAY['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'q1', 'q2']) p
        UNION ALL SELECT 'p4', 'o3', 'Staked', '[13,)';
      CREATE TABLE ${S}.msg_create_claims (supplier_id text, application_id text, service_id text, session_id text,
        block_id numeric, _block_range int8range, session_start_height numeric);`);
    await c.query(createDomainServiceDailyRewardsTableFn(S));
    await c.query(createSupplierRevShareWalletsFn(S));
    await c.query(createSessionRosterTablesFn(S));
    await c.query(createSessionRosterWritersFn(S));
    await c.query(createSessionRosterFunctionsFn(S));
    await c.query(createSettlementFunctionsFn(S));
    await c.query(createSettlementSmartTagsFn(S));
    for (let h = 1; h <= 40; h++) {
      if (h === 7) {
        // the session 1-4 (end 4, settled at 10): a1's first member paid 100, its second expired and slashed, its third
        // made no claim; a2's made none; a3's q1 discarded, q2 settled for 0. The session 5-8 of a2 (settled at 14): one
        // member's claim has no outcome
        const [m1, m2] = await members("a1", "s1", 1);
        await settle(10, 1, m1, "a1", "s1", 4, 100);
        await q(
          `INSERT INTO ${S}.msg_create_claims VALUES ($1, 'a1', 's1', $2, 6, '[6,)', 1), ($3, 'a1', 's1', $2, 6, '[6,)', 1)`,
          [m1, await sessionId("a1", "s1", 1), m2]
        );
        await q(
          `INSERT INTO ${S}.claim_expirations VALUES (10, 2, $1, 'a1', 's1', 4, 50, 'PROOF_MISSING', 1, 1, 1, 1)`,
          [m2]
        );
        await q(`INSERT INTO ${S}.supplier_slashes VALUES (10, 3, $1, 'a1', 's1', 4, 7, NULL)`, [m2]);
        await q(`INSERT INTO ${S}.claim_discards VALUES (10, 4, 'q1', 'a3', 's2', 4, 'boom')`);
        await settle(10, 5, "q2", "a3", "s2", 4, 0);
        await q(`INSERT INTO ${S}.settlement_blocks (height, block_time, era, day, rollup_version)
                 VALUES (10, now(), 'test', '2026-09-01', 1)`);
      }
      if (h === 9) {
        const [u] = await members("a2", "s1", 5);
        await q(`INSERT INTO ${S}.msg_create_claims VALUES ($1, 'a2', 's1', $2, 10, '[10,)', 5)`, [
          u,
          await sessionId("a2", "s1", 5),
        ]);
        // a4's claim of the session 5-8 (no roster yet), at block 10, settled at 14: its id and member as the chain has them
        const [at] = await q(`SELECT * FROM ${S}._session_roster_inputs(5, '[["a4", "s1"]]')`);
        a4 = (buildSessionRosters(5, at as unknown as SessionRosterInputs).sessions as Array<{ id: string; members: string[] }>)[0];
        await q(`INSERT INTO ${S}.msg_create_claims VALUES ($1, 'a4', 's1', $2, 10, '[10,)', 5)`, [a4.members[0], a4.id]);
        await settle(14, 1, a4.members[0], "a4", "s1", 8, 40);
        await q(`INSERT INTO ${S}.settlement_blocks (height, block_time, era, day, rollup_version) VALUES (14, now(), 'test', '2026-09-01', 1)`);
      }
      if (h === 21) {
        // p1's and p2's claims of their sessions 17-20 (settled at 26): the 50/50 and 1/49/50 rev-share splits
        const seats = await q(`SELECT DISTINCT ON (n.supplier_id) n.supplier_id, a.application_id, r.session_id
          FROM ${S}.session_suppliers ss JOIN ${S}.session_rosters r USING (session_num)
          JOIN ${S}.application_numbers a ON a.application_num = r.application_num
          JOIN ${S}.supplier_numbers n ON n.supplier_num = ss.supplier_num
          WHERE r.start_height = 17 AND n.supplier_id IN ('p1', 'p2') ORDER BY n.supplier_id, a.application_id`);
        assert.deepEqual(seats.map((x) => x.supplier_id), ["p1", "p2"]);
        for (const [k, x] of seats.entries()) {
          await q(`INSERT INTO ${S}.msg_create_claims VALUES ($1, $2, 's1', $3, 22, '[22,)', 17)`, [x.supplier_id, x.application_id, x.session_id]);
          await settle(26, k + 1, String(x.supplier_id), String(x.application_id), "s1", 20, 1000);
        }
        // the rest of p2's session 17-20 claims the same: a normal seat (each member paid V / K, F = 1)
        const p2s = seats.find((x) => x.supplier_id === "p2") as Row;
        const rest = await q(`SELECT n.supplier_id FROM ${S}.session_suppliers ss JOIN ${S}.session_rosters r USING (session_num)
          JOIN ${S}.supplier_numbers n ON n.supplier_num = ss.supplier_num
          WHERE r.session_id = $1 AND n.supplier_id <> 'p2' ORDER BY 1`, [p2s.session_id]);
        assert.equal(rest.length, 2);
        for (const [k, x] of rest.entries()) {
          await q(`INSERT INTO ${S}.msg_create_claims VALUES ($1, $2, 's1', $3, 22, '[22,)', 17)`, [x.supplier_id, p2s.application_id, p2s.session_id]);
          await settle(26, k + 10, String(x.supplier_id), String(p2s.application_id), "s1", 20, 1000);
        }
        // p2's session 13-16 started with r1's config (100%); the chain pays it at 22 with the one of the block: r3, r2, r5
        const [m13] = await q(`SELECT a.application_id, r.session_id FROM ${S}.session_suppliers ss JOIN ${S}.session_rosters r USING (session_num)
          JOIN ${S}.application_numbers a ON a.application_num = r.application_num
          JOIN ${S}.supplier_numbers n ON n.supplier_num = ss.supplier_num
          WHERE r.start_height = 13 AND n.supplier_id = 'p2' ORDER BY 1 LIMIT 1`);
        assert.ok(m13);
        await q(`INSERT INTO ${S}.msg_create_claims VALUES ('p2', $1, 's1', $2, 18, '[18,)', 13)`, [m13.application_id, m13.session_id]);
        await settle(22, 1, "p2", String(m13.application_id), "s1", 16, 1000);
        await q(`INSERT INTO ${S}.settlement_blocks (height, block_time, era, day, rollup_version) VALUES (22, now(), 'test', '2026-09-01', 1)`);
        await q(`INSERT INTO ${S}.settlement_blocks (height, block_time, era, day, rollup_version) VALUES (26, now(), 'test', '2026-09-01', 1)`);
      }
      if (h === 25) {
        // the session 21-24 of a1 ends after the proof window grew (its params say it settles at 31), but the chain
        // settled its claim at 30, with the window it had: the session settles there, with its claim
        const [m] = await members("a1", "s1", 21);
        await q(`INSERT INTO ${S}.msg_create_claims VALUES ($1, 'a1', 's1', $2, 26, '[26,)', 21)`, [m, await sessionId("a1", "s1", 21)]);
        await settle(30, 1, m, "a1", "s1", 24, 20);
        await q(`INSERT INTO ${S}.settlement_blocks (height, block_time, era, day, rollup_version) VALUES (30, now(), 'test', '2026-09-01', 1)`);
      }
      await block(h);
    }
  });
  after(async () => {
    await c.query(`DROP SCHEMA IF EXISTS ${S} CASCADE`);
    await c.end();
  });

  const stateOf = async (sup: string, app: string, svc: string, start: number) =>
    String(
      (
        await q(
          `SELECT ${S}._session_state_name(ss.state) s FROM ${S}.session_suppliers ss
           JOIN ${S}.session_rosters r ON r.session_num = ss.session_num
           JOIN ${S}.application_numbers a ON a.application_num = r.application_num AND a.application_id = $2
           JOIN ${S}.service_numbers v ON v.service_num = r.service_num AND v.service_id = $3
           JOIN ${S}.supplier_numbers n ON n.supplier_num = ss.supplier_num AND n.supplier_id = $1
           WHERE r.start_height = $4`,
          [sup, app, svc, start]
        )
      )[0]?.s
    );
  // every rollup equals the seats and sessions one by one, and every session row its seats
  const checkRollups = async () => {
    const sums = STATES.map((n, i) => `count(*) FILTER (WHERE ss.state = ${i + 1}) ${n}`).join(", ");
    const rows = (x: Row[]) => x.map((r) => JSON.stringify(Object.values(r).map(String)));
    const day = `(r.start_time AT TIME ZONE 'UTC')::date::text`;
    // per (day, service, supplier, who sat in the seat)
    const raw = await q(`
      SELECT ${day} AS day, ss.service_num, ss.supplier_num, coalesce(ss.owner_num, 0) o, coalesce(ss.domain_num, 0) d,
             ss.operator_nums, ss.operator_share_percents, count(*) seats, ${sums}, coalesce(sum(ss.paid_upokt), 0) y,
             coalesce(sum(ss.relays), 0) rel, coalesce(sum(ss.compute_units), 0) cu,
             round(sum(coalesce(r.paid_upokt, 0)::numeric / r.roster_size), 6) eq, sum(coalesce(r.paid_upokt, 0)) pool,
             sum(r.roster_size) k
      FROM ${S}.session_suppliers ss JOIN ${S}.session_rosters r ON r.session_num = ss.session_num
      WHERE ss.state <> 0 GROUP BY 1, 2, 3, 4, 5, 6, 7 ORDER BY 1, 2, 3, 4, 5, 6, 7`);
    const roll = await q(`
      SELECT d.day::text AS day, d.service_num, d.supplier_num, d.owner_num, d.domain_num, d.operator_nums,
             d.operator_share_percents, d.sessions,
             ${STATES.map((n) => `d.${n}`).join(", ")}, d.paid_upokt, d.relays, d.compute_units,
             round(d.equal_share_upokt, 6) eq, d.pool_upokt, d.roster_seats
      FROM ${S}.session_supplier_daily d WHERE d.sessions <> 0 ORDER BY 1, 2, 3, 4, 5, 6, 7`);
    assert.ok(roll.length > 0);
    assert.deepEqual(rows(roll), rows(raw));
    // and what each rev-share address received, element by element
    const praw = await q(`
      SELECT ${day} AS day, ss.service_num, ss.supplier_num, coalesce(ss.owner_num, 0) o, coalesce(ss.domain_num, 0) d,
             ss.operator_nums, ss.operator_share_percents, u.i, sum(u.x) x
      FROM ${S}.session_suppliers ss JOIN ${S}.session_rosters r ON r.session_num = ss.session_num
      CROSS JOIN unnest(coalesce(ss.operator_paid_upokt, array_fill(0::bigint, ARRAY[cardinality(ss.operator_nums)])))
        WITH ORDINALITY u(x, i)
      WHERE ss.state <> 0 GROUP BY 1, 2, 3, 4, 5, 6, 7, 8 ORDER BY 1, 2, 3, 4, 5, 6, 7, 8`);
    const proll = await q(`
      SELECT d.day::text AS day, d.service_num, d.supplier_num, d.owner_num, d.domain_num, d.operator_nums,
             d.operator_share_percents, u.i, u.x
      FROM ${S}.session_supplier_daily d CROSS JOIN unnest(d.operator_paid_upokt) WITH ORDINALITY u(x, i)
      WHERE d.sessions <> 0 ORDER BY 1, 2, 3, 4, 5, 6, 7, 8`);
    assert.ok(proll.length > 0);
    assert.deepEqual(rows(proll), rows(praw));
    // every seat's rev-share percentages add up to 100 (as the chain requires), so the addresses' parts of B add up to B
    const pct = await q(`SELECT ss.session_num FROM ${S}.session_suppliers ss
      WHERE (SELECT sum(x) FROM unnest(ss.operator_share_percents) x) IS DISTINCT FROM 100 AND cardinality(ss.operator_nums) > 0`);
    assert.deepEqual(pct, []);
    // per (day, service, application): the sessions, and their seats' states
    const sraw = await q(`
      WITH st AS (SELECT ss.session_num, ${sums} FROM ${S}.session_suppliers ss GROUP BY 1)
      SELECT ${day} AS day, r.service_num, r.application_num, count(*) sessions,
             count(*) FILTER (WHERE r.claimed > 0) wc, count(*) FILTER (WHERE r.claimed = 0) nw, sum(r.roster_size) rs,
             sum(r.candidates) cand, sum(r.claimed) cs, ${STATES.map((n) => `sum(st.${n}) ${n}`).join(", ")},
             coalesce(sum(r.paid_upokt), 0) v, coalesce(sum(r.settled_upokt), 0) settled,
             coalesce(sum(r.relays), 0) rel, coalesce(sum(r.compute_units), 0) cu
      FROM ${S}.session_rosters r JOIN st USING (session_num) WHERE r.settled_height IS NOT NULL
      GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`);
    const sroll = await q(`
      SELECT d.day::text, d.service_num, d.application_num, d.sessions, d.sessions_with_claim, d.sessions_no_work,
             d.roster_seats, d.candidates, d.claimed_seats, ${STATES.map((n) => `d.${n}`).join(", ")}, d.paid_upokt,
             d.settled_upokt, d.relays, d.compute_units
      FROM ${S}.session_daily d WHERE d.sessions <> 0 ORDER BY 1, 2, 3`);
    assert.deepEqual(rows(sroll), rows(sraw));
    // each session row: its seats per state, its claimed seats, and its relays and compute units
    const bad = await q(`
      SELECT r.session_id FROM ${S}.session_rosters r
      JOIN (SELECT ss.session_num, ${sums}, count(*) FILTER (WHERE ss.state IN (1, 2, 3, 4, 5, 8)) claimed,
                   sum(ss.relays) rel, sum(ss.compute_units) cu
            FROM ${S}.session_suppliers ss GROUP BY 1) x USING (session_num)
      WHERE r.settled_height IS NOT NULL AND (r.claimed <> x.claimed OR r.relays IS DISTINCT FROM x.rel
        OR r.compute_units IS DISTINCT FROM x.cu OR ${STATES.map((n) => `r.${n} <> x.${n}`).join(" OR ")})`);
    assert.deepEqual(bad, []);
    // per dimension (owner, rev-share address, domain): its seats, and each of its sessions once with V and K; the
    // session's own sets of them are its seats'
    const dims = `
      WITH sd AS (
        SELECT ss.*, ${day} AS day, r.paid_upokt v, r.roster_size k, dm.kind, dm.dim, dm.y dy, dm.b db
        FROM ${S}.session_suppliers ss JOIN ${S}.session_rosters r USING (session_num)
        CROSS JOIN LATERAL (SELECT coalesce(r.paid_upokt, 0)::numeric / r.roster_size b) e
        CROSS JOIN LATERAL (SELECT 1 kind, ss.owner_num dim, ss.paid_upokt y, e.b WHERE ss.owner_num IS NOT NULL
                            UNION ALL SELECT 2, u.o, u.p, e.b * u.pc / 100
                              FROM unnest(ss.operator_nums, ss.operator_paid_upokt, ss.operator_share_percents) u(o, p, pc)
                            UNION ALL SELECT 3, ss.domain_num, ss.paid_upokt, e.b WHERE ss.domain_num IS NOT NULL) dm
        WHERE ss.state <> 0)`;
    const draw = await q(`${dims},
      ses AS (SELECT DISTINCT kind, dim, day, service_num, session_num, v, k FROM sd)
      SELECT a.kind, a.dim, a.day, a.service_num, b.sessions, a.seats, ${STATES.map((n) => `a.${n}`).join(", ")}, a.y,
             a.rel, a.cu, a.eq, b.pool, b.k
      FROM (SELECT kind, dim, day, service_num, count(*) seats,
                   ${STATES.map((n, i) => `count(*) FILTER (WHERE state = ${i + 1}) ${n}`).join(", ")},
                   coalesce(sum(dy), 0) y, coalesce(sum(relays), 0) rel, coalesce(sum(compute_units), 0) cu,
                   round(sum(db), 6) eq
            FROM sd GROUP BY 1, 2, 3, 4) a
      JOIN (SELECT kind, dim, day, service_num, count(*) sessions, sum(coalesce(v, 0)) pool, sum(k) k
            FROM ses GROUP BY 1, 2, 3, 4) b USING (kind, dim, day, service_num)
      ORDER BY 1, 2, 3, 4`);
    const droll = await q(`
      SELECT d.kind, d.dim_num, d.day::text, d.service_num, d.sessions, d.seats, ${STATES.map((n) => `d.${n}`).join(", ")},
             d.paid_upokt, d.relays, d.compute_units, round(d.equal_share_upokt, 6), d.pool_upokt, d.roster_seats
      FROM ${S}.session_dimension_daily d WHERE d.seats <> 0 ORDER BY 1, 2, 3, 4`);
    assert.ok(droll.length > 0);
    assert.deepEqual(rows(droll), rows(draw));
    const sets = await q(`
      SELECT r.session_id FROM ${S}.session_rosters r
      WHERE r.owner_nums IS DISTINCT FROM ARRAY(SELECT DISTINCT ss.owner_num FROM ${S}.session_suppliers ss
                                                WHERE ss.session_num = r.session_num AND ss.owner_num IS NOT NULL ORDER BY 1)
         OR r.operator_nums IS DISTINCT FROM ARRAY(SELECT DISTINCT o FROM ${S}.session_suppliers ss CROSS JOIN unnest(ss.operator_nums) o
                                                   WHERE ss.session_num = r.session_num ORDER BY 1)
         OR r.domain_nums IS DISTINCT FROM ARRAY(SELECT DISTINCT ss.domain_num FROM ${S}.session_suppliers ss
                                                 WHERE ss.session_num = r.session_num AND ss.domain_num IS NOT NULL ORDER BY 1)
         OR r.member_nums IS DISTINCT FROM ARRAY(SELECT ss.supplier_num FROM ${S}.session_suppliers ss
                                                 WHERE ss.session_num = r.session_num ORDER BY 1)`);
    assert.deepEqual(sets, []);
    // what the rev-share addresses received on each settled seat = its shareholder payouts to them (the claim's
    // shareholder_payouts rows whose recipient is one of the seat's operators)
    const [pay] = await q(`
      SELECT (SELECT coalesce(sum(x), 0) FROM ${S}.session_suppliers ss CROSS JOIN unnest(ss.operator_paid_upokt) x) y,
             (SELECT coalesce(sum(sp.relay_upokt + sp.global_upokt), 0)
              FROM ${S}.session_suppliers ss JOIN ${S}.session_rosters r USING (session_num)
              JOIN ${S}.supplier_numbers n ON n.supplier_num = ss.supplier_num
              JOIN ${S}.application_numbers a ON a.application_num = r.application_num
              JOIN ${S}.service_numbers v ON v.service_num = r.service_num
              JOIN ${S}.claim_settlements c ON c.supplier_id = n.supplier_id AND c.application_id = a.application_id
                AND c.service_id = v.service_id AND c.session_end = r.end_height
              JOIN ${S}.shareholder_payouts sp ON sp.height = c.height AND sp.event_idx = c.event_idx
              JOIN ${S}.account_numbers o ON o.address = sp.recipient_id AND o.account_num = ANY(ss.operator_nums)
              WHERE ss.state <> 0 AND NOT r.money_missing) p`);
    assert.equal(String(pay.y), String(pay.p));
  };

  it("reads the start inputs only at the session starts, and moves the coverage only there", async () => {
    // blocks 1..40, sessions of 4 blocks: the starts 1, 5, ..., 37
    assert.equal(inputsRead, 10);
    const [p] = await q(`SELECT from_height, height FROM ${S}.session_roster_progress`);
    assert.deepEqual([Number(p.from_height), Number(p.height)], [1, 37]);
  });

  it("writes every active (application, service) session at each start, with the chain's selection", async () => {
    const rows = await q(`
      SELECT r.start_height, a.application_id, v.service_id, r.roster_size, r.candidates, r.end_height, r.settlement_height
      FROM ${S}.session_rosters r JOIN ${S}.application_numbers a USING (application_num) JOIN ${S}.service_numbers v USING (service_num)
      WHERE r.start_height IN (1, 9, 13) ORDER BY 1, 2`);
    assert.deepEqual(
      rows.map((r) => [
        r.start_height,
        r.application_id,
        r.service_id,
        r.roster_size,
        r.candidates,
        r.end_height,
        r.settlement_height,
      ]),
      [
        [1, "a1", "s1", 3, 5, 4, 10],
        [1, "a2", "s1", 3, 5, 4, 10],
        [1, "a3", "s2", 2, 2, 4, 10],
        [9, "a1", "s1", 3, 6, 12, 18],
        [9, "a2", "s1", 3, 6, 12, 18],
        [9, "a3", "s2", 2, 2, 12, 18],
        [9, "a4", "s1", 3, 6, 12, 18],
        [13, "a1", "s1", 3, 6, 16, 22],
        [13, "a2", "s1", 3, 6, 16, 22],
        [13, "a4", "s1", 3, 6, 16, 22],
      ]
    );
    assert.deepEqual(await members("a3", "s2", 1), ["q1", "q2"]);
    // the lifecycle heights, by the params at the session end: the proof window grew at 22
    const life = await q(`SELECT DISTINCT start_height, grace_end_height, claim_open_height, claim_close_height,
        proof_open_height, settlement_height FROM ${S}.session_rosters WHERE start_height IN (17, 21) ORDER BY 1`);
    assert.deepEqual(life.map((r) => Object.values(r).map(Number)), [
      [17, 21, 22, 24, 24, 26],
      [21, 25, 26, 28, 28, 31],
    ]);
    // the dictionaries take a number only for a new id: 10 starts of the same 2 services used 2 service numbers
    const [seq] = await q(`SELECT max(service_num) m, (SELECT last_value FROM ${S}.service_numbers_service_num_seq) l
                           FROM ${S}.service_numbers`);
    assert.deepEqual([Number(seq.m), Number(seq.l)], [2, 2]);
  });

  it("writes the session of a claim with no roster at the claim's block, with the start's suppliers", async () => {
    const [r] = await q(`SELECT r.session_id, r.start_height, r.settled_height, r.paid_upokt FROM ${S}.session_rosters r
      JOIN ${S}.application_numbers a USING (application_num) WHERE a.application_id = 'a4' AND r.start_height = 5`);
    assert.deepEqual([r.session_id, Number(r.start_height), Number(r.settled_height), String(r.paid_upokt)], [a4.id, 5, 14, "28"]);
    assert.deepEqual(await members("a4", "s1", 5), [...a4.members].sort());
    assert.equal(await stateOf(a4.members[0], "a4", "s1", 5), "paid");
    // a4 is in the start rosters from 9 on
    assert.equal((await members("a4", "s1", 9)).length, 3);
    const [none] = await q(`SELECT count(*) n FROM ${S}._claims_without_roster(1, 100, 1)`);
    assert.equal(Number(none.n), 0);
  });

  it("gives each member its final state at the settlement block", async () => {
    const [m1, m2, m3] = await members("a1", "s1", 1);
    const got = await Promise.all([
      stateOf(m1, "a1", "s1", 1),
      stateOf(m2, "a1", "s1", 1),
      stateOf(m3, "a1", "s1", 1),
      stateOf("q1", "a3", "s2", 1),
      stateOf("q2", "a3", "s2", 1),
    ]);
    // m1..m3 in roster order are by id here; the first two claimed
    assert.deepEqual(got.slice(3), ["discarded", "settled_zero"]);
    assert.deepEqual(got.slice(0, 3).sort(), ["idle_others_worked", "paid", "slashed"].sort());
    for (const m of await members("a2", "s1", 1)) assert.equal(await stateOf(m, "a2", "s1", 1), "idle_no_work");
    const states5 = await Promise.all((await members("a2", "s1", 5)).map((m) => stateOf(m, "a2", "s1", 5)));
    assert.deepEqual(states5.sort(), ["idle_others_worked", "idle_others_worked", "unresolved"]);
    const [v] = await q(
      `SELECT r.paid_upokt, r.settled_upokt, r.claimed, r.settled_height FROM ${S}.session_rosters r
                         WHERE r.session_id = $1`,
      [await sessionId("a1", "s1", 1)]
    );
    assert.deepEqual([v.paid_upokt, v.settled_upokt, v.claimed, v.settled_height].map(String), [
      "70",
      "100",
      "2",
      "10",
    ]);
    // the sessions whose settlement block has not come are still active
    const [act] = await q(`SELECT count(*) n FROM ${S}.session_rosters WHERE settled_height IS NULL`);
    // starts 33 and 37 (settled at start + 9), a1, a2 and a4 each
    assert.equal(Number(act.n), 6);
  });

  it("settles a session where its claims settled, when the params placed it elsewhere", async () => {
    const [r] = await q(`SELECT r.settlement_height, r.settled_height, r.money_missing, r.paid_upokt, r.relays
      FROM ${S}.session_rosters r WHERE r.session_id = $1`, [await sessionId("a1", "s1", 21)]);
    assert.deepEqual([r.settlement_height, r.settled_height, r.money_missing, String(r.paid_upokt), String(r.relays)],
      [31, 30, false, "14", "3"]);
    const states = await Promise.all((await members("a1", "s1", 21)).map((m) => stateOf(m, "a1", "s1", 21)));
    assert.deepEqual(states.sort(), ["idle_others_worked", "idle_others_worked", "paid"]);
  });

  it("freezes who sat in each seat at the session start", async () => {
    // p4's owner: o2 up to the start 13 (the version live before it), o3 from 17
    const own = await q(`SELECT ss.start_height, o.address FROM ${S}.session_suppliers ss
      JOIN ${S}.supplier_numbers n USING (supplier_num) JOIN ${S}.account_numbers o ON o.account_num = ss.owner_num
      WHERE n.supplier_id = 'p4' AND ss.start_height IN (13, 17) GROUP BY 1, 2 ORDER BY 1`);
    assert.deepEqual(own.map((r) => [r.start_height, r.address]), [[13, "o2"], [17, "o3"]]);
    // p2's rev-share: r1 up to the start 13, r2, r3 and r5 from 17
    const ops = await q(`SELECT DISTINCT ss.start_height,
        ARRAY(SELECT o.address FROM ${S}.account_numbers o WHERE o.account_num = ANY(ss.operator_nums) ORDER BY 1) a
      FROM ${S}.session_suppliers ss JOIN ${S}.supplier_numbers n USING (supplier_num)
      WHERE n.supplier_id = 'p2' AND ss.start_height IN (13, 17) ORDER BY 1`);
    assert.deepEqual(ops.map((r) => [r.start_height, r.a]), [[13, ["r1"]], [17, ["r2", "r3", "r5"]]]);
    // a1's gateways: g1 before 13, g2 from it; a2's g1
    const gw = await q(`SELECT DISTINCT a.application_id, r.start_height,
        ARRAY(SELECT o.address FROM ${S}.account_numbers o WHERE o.account_num = ANY(r.gateway_nums) ORDER BY 1) g
      FROM ${S}.session_rosters r JOIN ${S}.application_numbers a USING (application_num)
      WHERE r.start_height IN (9, 13) AND a.application_id IN ('a1', 'a2') ORDER BY 1, 2`);
    assert.deepEqual(gw.map((r) => [r.application_id, r.start_height, r.g]), [
      ["a1", 9, ["g1"]],
      ["a1", 13, ["g2"]],
      ["a2", 9, ["g1"]],
      ["a2", 13, ["g1"]],
    ]);
    // the selectors read the frozen seats: o3's seats are p4's from 17 on, r1's p1's and p2's before 17
    const [o3] = await q(`SELECT * FROM ${S}.get_supplier_session_funnel(NULL, $1, $2, owners => ARRAY['o3'])`, RANGE);
    const [o3raw] = await q(`SELECT count(*) n FROM ${S}.session_suppliers ss JOIN ${S}.supplier_numbers n USING (supplier_num)
      WHERE n.supplier_id = 'p4' AND ss.start_height >= 17 AND ss.state <> 0`);
    assert.ok(Number(o3raw.n) > 0);
    assert.equal(String(o3.seats), String(o3raw.n));
    const [r1] = await q(`SELECT * FROM ${S}.get_supplier_session_funnel(NULL, $1, $2, operators => ARRAY['r1'])`, RANGE);
    const [r1raw] = await q(`SELECT count(*) n, count(DISTINCT ss.session_num) ses FROM ${S}.session_suppliers ss
      JOIN ${S}.supplier_numbers n USING (supplier_num)
      WHERE ss.state <> 0 AND (n.supplier_id = 'p1' OR (n.supplier_id = 'p2' AND ss.start_height < 17))`);
    assert.deepEqual([String(r1.seats), String(r1.sessions_with_selected)], [String(r1raw.n), String(r1raw.ses)]);
    // two rev-share addresses of one seat: the seat counts once
    const [r23] = await q(`SELECT * FROM ${S}.get_supplier_session_funnel(NULL, $1, $2, operators => ARRAY['r3', 'r2'])`, RANGE);
    const [p2raw] = await q(`SELECT count(*) n FROM ${S}.session_suppliers ss JOIN ${S}.supplier_numbers n USING (supplier_num)
      WHERE n.supplier_id = 'p2' AND ss.start_height >= 17 AND ss.state <> 0`);
    assert.equal(String(r23.seats), String(p2raw.n));
  });

  it("gives each rev-share address its own part of a seat's pay", async () => {
    const part = async (sup: string) =>
      (
        await q(`SELECT ss.paid_upokt, ss.operator_paid_upokt,
            ARRAY(SELECT o.address FROM unnest(ss.operator_nums) WITH ORDINALITY u(n, i)
                  JOIN ${S}.account_numbers o ON o.account_num = u.n ORDER BY u.i) a
          FROM ${S}.session_suppliers ss JOIN ${S}.session_rosters r USING (session_num)
          JOIN ${S}.supplier_numbers n ON n.supplier_num = ss.supplier_num
          WHERE n.supplier_id = $1 AND r.start_height = 17 AND ss.paid_upokt IS NOT NULL`, [sup])
      )[0];
    // 1000 settled: 600 relay + 100 global = 700 to the shareholders
    const p1 = await part("p1");
    assert.deepEqual([String(p1.paid_upokt), p1.a, (p1.operator_paid_upokt as string[]).map(String)], ["700", ["r1", "r4"], ["350", "350"]]);
    const p2 = await part("p2");
    // r2 1% (6 + 1), r3 49% (294 + 49), r5 50% (300 + 50): the parts add up to the seat's pay
    assert.deepEqual([String(p2.paid_upokt), p2.a, (p2.operator_paid_upokt as string[]).map(String)], ["700", ["r2", "r3", "r5"], ["7", "343", "350"]]);
    for (const x of [p1, p2]) assert.equal(String((x.operator_paid_upokt as string[]).reduce((s, v) => s + Number(v), 0)), String(x.paid_upokt));
    // the funnel by rev-share address: its own part, here and through its rollup (one address) and the seats (two)
    const [r4] = await q(`SELECT * FROM ${S}.get_supplier_session_funnel(NULL, $1, $2, operators => ARRAY['r4'])`, RANGE);
    const [r4s] = await q(`SELECT * FROM ${S}.get_supplier_session_funnel(NULL, $1, $2, by_supplier => true, operators => ARRAY['r4'])`, RANGE);
    const [r35] = await q(`SELECT * FROM ${S}.get_supplier_session_funnel(NULL, $1, $2, operators => ARRAY['r3', 'r5'])`, RANGE);
    // every settled seat's part for those addresses (p1's other claims pay r4 too; p2's, r3 and r5)
    const own = async (addrs: string[]) =>
      String((await q(`SELECT coalesce(sum(u.p), 0) y FROM ${S}.session_suppliers ss
        CROSS JOIN unnest(ss.operator_nums, ss.operator_paid_upokt) u(o, p)
        JOIN ${S}.account_numbers a ON a.account_num = u.o WHERE a.address = ANY($1) AND ss.state <> 0`, [addrs]))[0].y);
    assert.deepEqual([String(r4.paid_upokt), String(r4s.paid_upokt), String(r35.paid_upokt)],
      [await own(["r4"]), await own(["r4"]), await own(["r3", "r5"])]);
    // and less than the seats paid: r3 and r5 hold 99% of p2's
    const [r35seats] = await q(`SELECT sum(ss.paid_upokt) y FROM ${S}.session_suppliers ss JOIN ${S}.supplier_numbers n USING (supplier_num)
      WHERE n.supplier_id = 'p2' AND ss.start_height >= 17 AND ss.state <> 0`);
    assert.ok(Number(r35.paid_upokt) < Number(r35seats.y) && Number(r35.paid_upokt) >= 693);
    // the session 17-20 alone (block 17 at 16:00): r2's part of p2's seat
    const [l] = await q(`SELECT * FROM ${S}.get_supplier_session_list(NULL, '2026-09-01T16:00:00Z', '2026-09-01T17:00:00Z',
      states => ARRAY['paid'], operators => ARRAY['r2'])`);
    assert.deepEqual((l.selected_paid_upokt as string[]).map(String), ["7"]);
  });

  it("gives each rev-share address its part of a seat's B, so that a normal seat's F is 1 for each", async () => {
    // p2's session 17-20: its three members each paid 700, V = 2100, K = 3, B = 700; r2 1%, r3 49%, r5 50%
    const at17 = (addr: string) => q(`SELECT * FROM ${S}.get_supplier_session_list(NULL, '2026-09-01T16:00:00Z',
      '2026-09-01T17:00:00Z', states => ARRAY['paid'], operators => ARRAY[$1])`, [addr]);
    const [r2] = await at17("r2");
    assert.deepEqual([String(r2.paid_upokt), String(r2.roster_size)], ["2100", "3"]);
    const b = Number(r2.paid_upokt) / Number(r2.roster_size);
    const got: number[][] = [];
    for (const addr of ["r2", "r3", "r5"]) {
      const [row] = await at17(addr);
      got.push([Number((row.selected_equal_share_upokt as string[])[0]), Number((row.selected_paid_upokt as string[])[0])]);
    }
    assert.deepEqual(got.map(([bb]) => bb), [b * 0.01, b * 0.49, b * 0.5]);
    for (const [bb, y] of got) assert.equal(y / bb, 1);
    // the parts add up to the seat's B; a supplier selector gets the whole
    const [whole] = await q(`SELECT * FROM ${S}.get_supplier_session_list(ARRAY['p2'], '2026-09-01T16:00:00Z', '2026-09-01T17:00:00Z',
      states => ARRAY['paid'])`);
    assert.deepEqual((whole.selected_equal_share_upokt as string[]).map(Number), [b]);
    // the funnel's B for r3 and r5 together: their parts of every seat's B (its rollup and the seats agree)
    const [r35] = await q(`SELECT * FROM ${S}.get_supplier_session_funnel(NULL, $1, $2, operators => ARRAY['r3', 'r5'])`, RANGE);
    const [r35raw] = await q(`SELECT round(sum(u.b)) b FROM ${S}.session_suppliers ss JOIN ${S}.session_rosters r USING (session_num)
      CROSS JOIN LATERAL (SELECT u.o, coalesce(r.paid_upokt, 0)::numeric / r.roster_size * u.pc / 100 b
                          FROM unnest(ss.operator_nums, ss.operator_share_percents) u(o, pc)) u
      JOIN ${S}.account_numbers a ON a.account_num = u.o WHERE a.address IN ('r3', 'r5') AND ss.state <> 0`);
    assert.ok(Number(r35raw.b) > 0);
    assert.equal(String(r35.equal_share_upokt), String(r35raw.b));
    // one address by supplier (its element of each supplier row): r5's parts of p2's seats
    const r5s = await q(`SELECT * FROM ${S}.get_supplier_session_funnel(NULL, $1, $2, by_supplier => true, operators => ARRAY['r5'])`, RANGE);
    const r5raw = await q(`SELECT n.supplier_id, round(sum(u.b)) b FROM ${S}.session_suppliers ss JOIN ${S}.session_rosters r USING (session_num)
      JOIN ${S}.supplier_numbers n ON n.supplier_num = ss.supplier_num
      CROSS JOIN LATERAL (SELECT u.o, coalesce(r.paid_upokt, 0)::numeric / r.roster_size * u.pc / 100 b
                          FROM unnest(ss.operator_nums, ss.operator_share_percents) u(o, pc)) u
      JOIN ${S}.account_numbers a ON a.account_num = u.o WHERE a.address = 'r5' AND ss.state <> 0 GROUP BY 1 ORDER BY 1`);
    assert.ok(r5raw.length > 0 && Number(r5raw[0].b) > 0);
    assert.deepEqual(r5s.map((x) => [x.supplier_id, String(x.equal_share_upokt)]), r5raw.map((x) => [x.supplier_id, String(x.b)]));
    // a session not settled yet has no B
    const open = await q(`SELECT * FROM ${S}.get_supplier_session_list(NULL, NULL, NULL, states => ARRAY['active'], operators => ARRAY['r5'])`);
    assert.ok(open.length > 0 && open.every((x) => x.session_id !== null));
    assert.ok(open.every((x) => (x.selected_equal_share_upokt as unknown[]).every((v) => v === null)));
    // the same addresses with other percentages split a supplier's day: p4's 50/50 seats and its 20/80 ones
    const split = await q(`SELECT DISTINCT d.operator_share_percents FROM ${S}.session_supplier_daily d
      JOIN ${S}.supplier_numbers n USING (supplier_num) WHERE n.supplier_id = 'p4' AND d.day = '2026-09-01' ORDER BY 1`);
    assert.deepEqual(split.map((x) => (x.operator_share_percents as number[]).map(Number)), [[20, 80], [50, 50]]);
  });

  it("keeps a seat with its start config when the rev-share changes during the session; Y goes by the payouts", async () => {
    // p2's session 13-16 started with r1 at 100%; its claim settled at 22, when r3, r2 and r5 held p2's config
    const [seat] = await q(`SELECT ss.paid_upokt, ss.operator_paid_upokt, ss.operator_share_percents,
        ARRAY(SELECT o.address FROM unnest(ss.operator_nums) u(n) JOIN ${S}.account_numbers o ON o.account_num = u.n) a,
        r.paid_upokt v, r.roster_size k, r.settled_height
      FROM ${S}.session_suppliers ss JOIN ${S}.session_rosters r USING (session_num)
      JOIN ${S}.supplier_numbers n ON n.supplier_num = ss.supplier_num
      WHERE n.supplier_id = 'p2' AND r.start_height = 13 AND ss.paid_upokt IS NOT NULL`);
    assert.deepEqual([seat.a, (seat.operator_share_percents as number[]).map(Number), String(seat.paid_upokt), Number(seat.settled_height)],
      [["r1"], [100], "700", 22]);
    // the chain paid the addresses of the settlement block, none of them an operator of the seat: r1's part is 0
    const pays = await q(`SELECT sp.recipient_id, sp.relay_upokt + sp.global_upokt amt FROM ${S}.shareholder_payouts sp
      WHERE sp.height = 22 AND sp.supplier_id = 'p2' ORDER BY 1`);
    assert.deepEqual(pays.map((x) => [x.recipient_id, String(x.amt)]), [["r2", "7"], ["r3", "343"], ["r5", "350"]]);
    assert.deepEqual((seat.operator_paid_upokt as string[]).map(String), ["0"]);
    // r1's B there is the seat's whole B; its Y, 0
    const [l] = await q(`SELECT * FROM ${S}.get_supplier_session_list(NULL, '2026-09-01T12:00:00Z', '2026-09-01T13:00:00Z',
      states => ARRAY['paid'], operators => ARRAY['r1'])`);
    const i = (l.selected_supplier_ids as string[]).indexOf("p2");
    assert.deepEqual([Number((l.selected_paid_upokt as string[])[i]), Number((l.selected_equal_share_upokt as string[])[i])],
      [0, Math.round(Number(seat.v) / Number(seat.k))]);
    // and the addresses the chain paid have no seat in that session
    const r3 = await q(`SELECT * FROM ${S}.get_supplier_session_list(NULL, '2026-09-01T12:00:00Z', '2026-09-01T13:00:00Z',
      operators => ARRAY['r3', 'r2', 'r5'])`);
    assert.deepEqual(r3.filter((x) => x.session_id !== null), []);
  });

  it("keeps every rollup equal to the seats one by one", checkRollups);

  it("finalizes again without moving anything, and moves the rollups when a late claim settles", async () => {
    await q("BEGIN");
    const again = Number((await q(`SELECT ${S}.finalize_session_rosters(10) n`))[0].n);
    await q("COMMIT");
    assert.equal(again, 0);
    await checkRollups();
    // a claim of a2's session 1-4 settles at 41: the session is recomputed, its members move from idle_no_work
    const [w] = await members("a2", "s1", 1);
    await settle(41, 1, w, "a2", "s1", 4, 30);
    await q(
      `INSERT INTO ${S}.settlement_blocks (height, block_time, era, day, rollup_version) VALUES (41, now(), 'test', '2026-09-02', 1)`
    );
    await q(`INSERT INTO ${S}.blocks VALUES (41.5, timestamp '2026-09-02 17:00', 'X')`);
    assert.ok((await block(41)) > 0);
    assert.equal(await stateOf(w, "a2", "s1", 1), "paid");
    await checkRollups();
  });

  it("answers the funnel of a selector from the rollup and the seats", async () => {
    const [r] = await q(`SELECT * FROM ${S}.get_supplier_session_funnel($1, $2, $3)`, [P, ...RANGE]);
    const [raw] = await q(
      `
      SELECT count(*) seats, count(DISTINCT ss.session_num) ses, sum(ss.paid_upokt) paid
      FROM ${S}.session_suppliers ss JOIN ${S}.supplier_numbers n USING (supplier_num)
      WHERE n.supplier_id = ANY($1) AND ss.state <> 0`,
      [P]
    );
    assert.equal(String(r.seats), String(raw.seats));
    assert.equal(String(r.sessions_with_selected), String(raw.ses));
    assert.equal(String(r.paid_upokt), String(raw.paid));
    const [net] = await q(`SELECT count(*) n, sum(r.paid_upokt) v FROM ${S}.session_rosters r
                           JOIN ${S}.service_numbers v USING (service_num) WHERE v.service_id = 's1' AND r.settled_height IS NOT NULL`);
    // without by_service: the sessions of the services the selection sat in (s1 only), the sum of the by_service rows'
    const [all] = await q(`SELECT count(*) n FROM ${S}.session_rosters WHERE settled_height IS NOT NULL`);
    assert.ok(Number(net.n) < Number(all.n));
    assert.equal(String(r.network_sessions), String(net.n));
    const perSvc = await q(`SELECT * FROM ${S}.get_supplier_session_funnel($1, $2, $3, NULL, true)`, [[...P, "q1"], ...RANGE]);
    const [both] = await q(`SELECT * FROM ${S}.get_supplier_session_funnel($1, $2, $3)`, [[...P, "q1"], ...RANGE]);
    assert.equal(perSvc.length, 2);
    assert.equal(String(both.network_sessions), String(perSvc.reduce((a, x) => a + Number(x.network_sessions), 0)));
    assert.equal(String(r.pool_upokt), String(net.v));
    // owners: o1 owns p1 and p2
    const [o] = await q(`SELECT * FROM ${S}.get_supplier_session_funnel(NULL, $1, $2, owners => ARRAY['o1'])`, RANGE);
    const [oraw] =
      await q(`SELECT count(*) seats FROM ${S}.session_suppliers ss JOIN ${S}.supplier_numbers n USING (supplier_num)
                            WHERE n.supplier_id IN ('p1', 'p2') AND ss.state <> 0`);
    assert.equal(String(o.seats), String(oraw.seats));
    await assert.rejects(
      q(`SELECT * FROM ${S}.get_supplier_session_funnel(ARRAY['p1'], $1, $2, owners => ARRAY['o1'])`, RANGE),
      /pass one of/
    );
    // domains: the seats served from the domain (p1's, and p3's until it moved to b.io: session_dimension_daily)
    const [dm] = await q(
      `SELECT * FROM ${S}.get_supplier_session_funnel(NULL, $1, $2, domains => ARRAY['a.net'])`,
      RANGE
    );
    const onA = `SELECT ss.* FROM ${S}.session_suppliers ss JOIN ${S}.domain_numbers dn USING (domain_num)
                 WHERE dn.domain = 'a.net' AND ss.state <> 0`;
    const [draw] = await q(`SELECT count(*) seats, count(DISTINCT session_num) ses FROM (${onA}) x`);
    const [p3a] = await q(`SELECT count(*) n FROM (${onA}) x JOIN ${S}.supplier_numbers n USING (supplier_num)
                           WHERE n.supplier_id = 'p3'`);
    assert.ok(Number(p3a.n) > 0);
    assert.equal(String(dm.seats), String(draw.seats));
    assert.equal(String(dm.sessions_with_selected), String(draw.ses));
    // two domains: a session with members on both counts once
    const [two] = await q(`SELECT * FROM ${S}.get_supplier_session_funnel(NULL, $1, $2, domains => ARRAY['a.net', 'b.io'])`, RANGE);
    const [tworaw] = await q(`SELECT count(DISTINCT ss.session_num) n, count(*) seats FROM ${S}.session_suppliers ss
      JOIN ${S}.supplier_numbers n USING (supplier_num) WHERE n.supplier_id IN ('p1', 'p2', 'p3') AND ss.state <> 0`);
    assert.deepEqual([String(two.sessions_with_selected), String(two.seats)], [String(tworaw.n), String(tworaw.seats)]);
    // by supplier: each supplier's seats served from the domain, adding up to the domain's total (not p3's b.io seats)
    const bySup = await q(`SELECT * FROM ${S}.get_supplier_session_funnel(NULL, $1, $2, by_supplier => true, domains => ARRAY['a.net'])`, RANGE);
    assert.deepEqual(bySup.map((x) => x.supplier_id).sort(), ["p1", "p3"]);
    // and the network of the services the domain's seats sat in, as without by_supplier
    assert.ok(Number(dm.network_sessions) > 0);
    assert.ok(bySup.every((x) => String(x.network_sessions) === String(dm.network_sessions)));
    assert.equal(String(bySup.reduce((a, x) => a + Number(x.seats), 0)), String(draw.seats));
    const bySvcSup = await q(`SELECT * FROM ${S}.get_supplier_session_funnel(NULL, $1, $2, NULL, true, true, domains => ARRAY['a.net'])`, RANGE);
    assert.equal(String(bySvcSup.reduce((a, x) => a + Number(x.seats), 0)), String(draw.seats));
    // by service and supplier: the rows add up to the total
    const parts = await q(`SELECT * FROM ${S}.get_supplier_session_funnel($1, $2, $3, 'day', true, true)`, [
      P,
      ...RANGE,
    ]);
    assert.equal(String(parts.reduce((a, x) => a + Number(x.seats), 0)), String(raw.seats));
  });

  it("answers the network, the applications, the gateways and the sessions running now", async () => {
    const rows = await q(`SELECT * FROM ${S}.get_network_sessions($1, $2)`, RANGE);
    const s1 = rows.find((x) => x.service_id === "s1") as Row;
    const [raw] = await q(`SELECT count(*) n, count(*) FILTER (WHERE claimed = 0) nw, sum(relays) rel FROM ${S}.session_rosters r
                           JOIN ${S}.service_numbers v USING (service_num) WHERE v.service_id = 's1' AND r.settled_height IS NOT NULL`);
    assert.deepEqual([String(s1.sessions), String(s1.no_work), String(s1.relays)], [String(raw.n), String(raw.nw), String(raw.rel)]);
    assert.equal(s1.application_id, "all");
    // by application, and one application
    const byApp = await q(`SELECT * FROM ${S}.get_network_sessions($1, $2, by_application => true)`, RANGE);
    assert.equal(String(byApp.filter((x) => x.service_id === "s1").reduce((a, x) => a + Number(x.sessions), 0)), String(s1.sessions));
    const apps = await q(`SELECT * FROM ${S}.get_network_sessions($1, $2, applications => ARRAY['a2'], by_application => true)`, RANGE);
    assert.ok(apps.length > 0 && apps.every((x) => x.application_id === "a2"));
    // gateways: the sessions of the applications delegated to them at the start (g1: a1 before 13, a2 throughout)
    const [g1] = await q(`SELECT * FROM ${S}.get_network_sessions($1, $2, gateways => ARRAY['g1'], by_service => false)`, RANGE);
    const [g1raw] = await q(`SELECT count(*) n FROM ${S}.session_rosters r JOIN ${S}.application_numbers a USING (application_num)
      WHERE r.settled_height IS NOT NULL AND (a.application_id = 'a2' OR (a.application_id = 'a1' AND r.start_height < 13))`);
    assert.equal(String(g1.sessions), String(g1raw.n));
    await assert.rejects(q(`SELECT * FROM ${S}.get_network_sessions($1, $2, applications => ARRAY['a1'], gateways => ARRAY['g1'])`, RANGE), /not both/);
    // running now, per phase at the latest block (48, beyond what this chain indexed): the start 41 is claiming, and
    // the starts 33 and 37 are past their settlement heights (43, 47) unsettled: overdue
    const act = await q(`SELECT * FROM ${S}.get_active_sessions(ARRAY['p1', 'p2', 'p3', 'p4', 'p5', 'p6'])`);
    assert.deepEqual(
      act.map((x) => [x.service_id, x.phase, Number(x.network_sessions)]),
      [["s1", "claiming", 3], ["s1", "overdue", 6]]
    );
    assert.ok(act.every((x) => Number(x.selected_sessions) > 0 && Number(x.selected_seats) >= Number(x.selected_sessions)));
    const [none] = await q(`SELECT * FROM ${S}.get_active_sessions()`);
    assert.equal(none.selected_sessions, null);
    const ga = await q(`SELECT * FROM ${S}.get_active_sessions(gateways => ARRAY['g2'], by_service => false)`);
    // g2 has a1's sessions: one per start
    assert.deepEqual(ga.map((x) => [x.phase, Number(x.selected_sessions)]), [["claiming", 1], ["overdue", 2]]);
  });

  it("lists sessions with full rosters, and pages them", async () => {
    const all = await q(`SELECT * FROM ${S}.get_session_rosters($1, $2)`, RANGE);
    const [first] = await q(`SELECT * FROM ${S}.get_session_rosters($1, $2, row_limit => 1)`, RANGE);
    const next = await q(
      `SELECT * FROM ${S}.get_session_rosters($1, $2, row_limit => 1000, before_height => $3, before_session_id => $4)`,
      [...RANGE, first.start_height, first.session_id]
    );
    assert.equal(next.length, all.length - 1);
    const one = all.find((x) => (x.member_ids as string[]).includes("q1") && Number(x.start_height) === 1) as Row;
    assert.deepEqual(one.member_ids, ["q1", "q2"]);
    assert.deepEqual(one.member_states, ["discarded", "settled_zero"]);
    const mine = await q(
      `SELECT * FROM ${S}.get_supplier_session_list(ARRAY['q1'], $1, $2, states => ARRAY['discarded'])`,
      RANGE
    );
    assert.deepEqual(
      mine.map((x) => [x.selected_supplier_ids, x.selected_states]),
      [[["q1"], ["discarded"]]]
    );
    const [j] = await q(`SELECT ${S}.get_session_rosters_json($1, $2, row_limit => 2) j`, RANGE);
    const json = j.j as { range: Row; data: Row[] };
    assert.equal(json.data.length, 2);
    assert.ok(json.range.covered_from);
  });
  it("carries on every row the part of the range its _json twin reports, and data [] where nothing is covered", async () => {
    const CALLS: Record<string, string> = {
      get_supplier_session_funnel: "ARRAY['p1', 'p2'], $1, $2",
      get_network_sessions: "$1, $2",
      get_supplier_session_list: "ARRAY['p1', 'p2'], $1, $2",
      get_session_rosters: "$1, $2",
    };
    assert.deepEqual(Object.keys(CALLS).sort(), [...SESSION_ROSTER_CATALOG_FUNCTIONS].sort());
    // GraphQL plain lists with a description (smartTags.ts), and the helpers hidden
    const tags = Object.fromEntries(
      (
        await q(
          `SELECT p.proname, obj_description(p.oid, 'pg_proc') t FROM pg_proc p
      WHERE p.pronamespace = $1::regnamespace`,
          [S]
        )
      ).map((r) => [r.proname, String(r.t)])
    );
    for (const f of [...SESSION_ROSTER_CATALOG_FUNCTIONS, ...SESSION_ROSTER_STATE_FUNCTIONS])
      assert.ok(tags[f].startsWith("@simpleCollections only\n"), f);
    for (const f of [
      "_session_roster_inputs",
      "_write_session_rosters",
      "_session_roster_progress",
      "_session_state_name",
      "_session_selector",
      "_session_phase",
      "_session_gaps",
      "_money_covers",
      "finalize_session_rosters",
    ])
      assert.equal(tags[f], "@omit", f);
    for (const [fn, args] of Object.entries(CALLS)) {
      for (const range of [RANGE, ["2026-08-01T00:00:00Z", "2026-08-02T00:00:00Z"]]) {
        const rows = await q(`SELECT * FROM ${S}.${fn}(${args})`, range);
        const [{ j }] = await q(`SELECT ${S}.${fn}_json(${args}) j`, range);
        const json = j as { range: { covered_from: string | null; covered_to: string | null }; data: unknown[] };
        for (const r of rows) {
          assert.equal(
            r.covered_from === null ? null : (r.covered_from as Date).toISOString(),
            json.range.covered_from === null ? null : new Date(json.range.covered_from).toISOString(),
            fn
          );
        }
        if (range === RANGE) assert.ok(json.data.length > 0 && json.range.covered_from, fn);
        else assert.deepEqual([json.data, json.range.covered_from], [[], null], fn);
      }
    }
  });
  it("backfills what the indexer wrote, from the session starts and the settlement blocks", async () => {
    // the indexer has processed blocks 1..41 here; the tables it wrote, by session id (the dictionaries stay)
    const tables = ["session_supplier_daily", "session_daily", "session_dimension_daily"];
    const snapshot = async () => ({
      rosters: await q(`SELECT to_jsonb(r) - 'session_num' j FROM ${S}.session_rosters r ORDER BY r.session_id`),
      seats: await q(`SELECT r.session_id, to_jsonb(ss) - 'session_num' j
        FROM ${S}.session_suppliers ss JOIN ${S}.session_rosters r USING (session_num) ORDER BY 1, ss.supplier_num`),
      progress: await q(`SELECT from_height, height FROM ${S}.session_roster_progress`),
      ...Object.fromEntries(await Promise.all(tables.map(async (t) => [t, await q(`SELECT * FROM ${S}.${t} t ORDER BY t::text`)]))),
    });
    const indexed = await snapshot();
    assert.ok((indexed.rosters as Row[]).length > 0);
    await q(`TRUNCATE ${S}.session_rosters, ${S}.session_suppliers, ${S}.session_roster_progress, ${tables.map((t) => `${S}.${t}`).join(", ")}`);
    // the late pass three blocks of claims at a time: a4's claim at 10 is found in the chunk 10..12
    const got = await backfillSessionRosters(q, S, { from: 1, to: 41, latest: 41, lateChunk: 3 });
    assert.deepEqual([got.starts, got.late, got.unmatched], [11, 1, []]);
    assert.deepEqual(await snapshot(), indexed);
    await checkRollups();
  });

  it("settles where the money tables do not cover the block, and completes it when they do", async () => {
    // the sessions of the start 33 settle at 43; a1's has a claim, settled at 43
    const sid = await sessionId("a1", "s1", 33);
    const [m] = await members("a1", "s1", 33);
    await q(`INSERT INTO ${S}.msg_create_claims VALUES ($1, 'a1', 's1', $2, 38, '[38,)', 33)`, [m, sid]);
    await settle(43, 1, m, "a1", "s1", 36, 50);
    await q(`INSERT INTO ${S}.settlement_blocks (height, block_time, era, day, rollup_version) VALUES (43, now(), 'test', '2026-09-02', 1)`);
    const due = async () =>
      Number((await q(`SELECT count(*) n FROM ${S}.session_rosters WHERE start_height = 33 AND settled_height IS NULL`))[0].n);
    assert.equal(await due(), 3);
    // 43 is a settlement gap: the sessions settle all the same, the claimed seat unresolved, the money missing
    await q(`INSERT INTO ${S}.settlement_gaps (from_height, to_height) VALUES (43, 43)`);
    assert.ok((await block(43)) > 0);
    assert.equal(await due(), 0);
    assert.equal(await stateOf(m, "a1", "s1", 33), "unresolved");
    const [r] = await q(`SELECT money_missing, paid_upokt FROM ${S}.session_rosters WHERE session_id = $1`, [sid]);
    assert.deepEqual([r.money_missing, r.paid_upokt], [true, null]);
    for (const x of await members("a2", "s1", 33)) assert.equal(await stateOf(x, "a2", "s1", 33), "idle_no_work");
    await checkRollups();
    // the readers report the starts of those sessions as a gap of their coverage
    const [j] = await q(`SELECT ${S}.get_network_sessions_json($1, $2) j`, RANGE);
    const gaps = (j.j as { range: { gaps: Array<{ from: string; to: string }> } }).range.gaps;
    assert.equal(gaps.length, 1);
    const [t] = await q(`SELECT start_time FROM ${S}.session_rosters WHERE session_id = $1`, [sid]);
    assert.equal(new Date(gaps[0].from).toISOString(), (t.start_time as Date).toISOString());
    // finalizing again inside the gap moves nothing
    await q("BEGIN");
    assert.equal(Number((await q(`SELECT ${S}.finalize_session_rosters(43) n`))[0].n), 0);
    await q("COMMIT");
    // the gap is filled: the history job wrote 43 and finalizes it (finalizeRostersAt, in its transaction after the gap
    // is lowered); the session completes, the rollups move by the difference (the claimed seat, and the two others
    // whose share of the session's V moved)
    await q("BEGIN");
    await q(`DELETE FROM ${S}.settlement_gaps`);
    await finalizeRostersAt(c as unknown as Parameters<typeof finalizeRostersAt>[0], S, 43);
    await q("COMMIT");
    const [moved] = await q(`SELECT count(*) n FROM ${S}.session_suppliers ss JOIN ${S}.session_rosters r USING (session_num)
      WHERE r.session_id = $1 AND ss.state <> 0`, [sid]);
    assert.equal(Number(moved.n), 3);
    assert.equal(await stateOf(m, "a1", "s1", 33), "paid");
    const [r2] = await q(`SELECT money_missing, paid_upokt, settled_height FROM ${S}.session_rosters WHERE session_id = $1`, [sid]);
    assert.deepEqual([r2.money_missing, String(r2.paid_upokt), r2.settled_height], [false, "35", 43]);
    await checkRollups();
    const [j2] = await q(`SELECT ${S}.get_network_sessions_json($1, $2) j`, RANGE);
    assert.deepEqual((j2.j as { range: { gaps: unknown[] } }).range.gaps, []);
    // the money step behind the block (an override skipping heights): the start 37's sessions settle without money
    await q(`UPDATE ${S}.money_progress SET height = 46`);
    assert.ok((await block(47)) > 0);
    const [mm] = await q(`SELECT count(*) n FROM ${S}.session_rosters WHERE start_height = 37 AND money_missing`);
    assert.equal(Number(mm.n), 3);
    await q(`UPDATE ${S}.money_progress SET height = 999999999`);
    await checkRollups();
  });
});
