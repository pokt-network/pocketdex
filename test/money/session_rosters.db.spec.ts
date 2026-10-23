// The session rosters (sessionRosters.ts) over a small chain, block by block as handleAddBlockReports runs them: the
// rosters written at each session start, the final states at each settlement block, the rollups against the seats one
// by one, and the catalog functions over them.
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
import { buildSessionRosters, SessionRosterInputs, writeClaimsWithoutRoster } from "../../src/mappings/pocket/sessionRosters";

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
  // what handleAddBlockReports does at a block
  const block = async (h: number) => {
    const [inputs] = await q(`SELECT * FROM ${S}._session_roster_inputs($1::bigint)`, [h]);
    if (inputs.is_start) {
      await q(`SELECT ${S}._write_session_rosters($1::jsonb)`, [
        JSON.stringify(buildSessionRosters(h, inputs as unknown as SessionRosterInputs)),
      ]);
    }
    await writeClaimsWithoutRoster(q, S, h, h, 1);
    await q("BEGIN");
    try {
      const [{ n }] = await q(`SELECT ${S}.finalize_session_rosters($1::bigint) n`, [h]);
      await q("COMMIT");
      await q(`SELECT ${S}._session_roster_progress($1::bigint)`, [h]);
      return Number(n);
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
  // a settled claim with its paid shareholder share (relay 60%, global 10% of the settled amount)
  const settle = (h: number, i: number, sup: string, app: string, svc: string, end: number, upokt: number) =>
    q(
      `INSERT INTO ${S}.claim_settlements (height, event_idx, block_time, supplier_id, application_id, service_id,
         session_id, session_end, claimed_upokt, settled_upokt, relay_minted_upokt, overservicing_loss_upokt,
         mint_ratio_unminted_upokt, global_minted_upokt, relays, estimated_relays, claimed_compute_units,
         estimated_compute_units, relay_to_supplier_upokt, relay_to_dao_upokt, relay_to_source_owner_upokt,
         relay_to_application_upokt, relay_to_stakers_upokt, global_to_supplier_upokt, global_to_dao_upokt,
         global_to_source_owner_upokt, global_to_application_upokt, reimbursement_to_dao_upokt, row_source, calc_version,
         settled_with_proof)
       VALUES ($1, $2, now(), $3, $4, $5, 'x', $6, $7::bigint, $7::bigint, 0, 0, 0, 0, 1, 1, 1, 1, $7::bigint * 6 / 10, 0, 0, 0, 0,
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
      CREATE TABLE ${S}.application_gateways (gateway_id text, application_id text, _block_range int8range);
      INSERT INTO ${S}.money_progress VALUES (true, 1, 999999999);
      -- 48 blocks an hour apart from 2026-09-01 00:00 (the rosters cover the first day whole): two UTC days
      CREATE TABLE ${S}.blocks (id numeric, timestamp timestamp, hash text);
      CREATE INDEX ON ${S}.blocks (timestamp, id);
      INSERT INTO ${S}.blocks SELECT g, timestamp '2026-09-01 00:00' + (g - 1) * interval '1 hour',
        upper(md5(g::text) || md5((g + 1000)::text)) FROM generate_series(1, 48) g;
      -- sessions of 4 blocks, rosters of 3, settled at end + 1 + 1 + 2 + 0 + 2 = end + 6
      CREATE TABLE ${S}.params (id text, namespace text, key text, value text, block_id numeric, active_at numeric,
        _block_range int8range);
      INSERT INTO ${S}.params VALUES
        ('a', 'shared', 'num_blocks_per_session', '4', 1, 1, '[1,)'),
        ('b', 'session', 'num_suppliers_per_session', '3', 1, 1, '[1,)'),
        ('c', 'shared', 'claim_window_open_offset_blocks', '1', 1, 1, '[1,)'),
        ('d', 'shared', 'claim_window_close_offset_blocks', '2', 1, 1, '[1,)'),
        ('e', 'shared', 'proof_window_open_offset_blocks', '0', 1, 1, '[1,)'),
        ('f', 'shared', 'proof_window_close_offset_blocks', '2', 1, 1, '[1,)');
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
        -- p1 and p3 serve from a.net, p2 from b.io
        SELECT p, 's1', 1, '[]'::jsonb,
               CASE WHEN p IN ('p1', 'p3') THEN '["a.net"]'::jsonb WHEN p = 'p2' THEN '["b.io"]' ELSE '[]' END, '[1,)'::int8range
        FROM unnest(ARRAY['p1', 'p2', 'p3', 'p4']) p
        -- p5 unstakes at the start block 9: still a candidate of the session 9-12, not of 13-16
        UNION ALL SELECT 'p5', 's1', 1, '[]', '[]', '[1,9)'
        UNION ALL SELECT 'p6', 's1', 7, '[]', '[]', '[5,)'
        -- p7 stakes in the start block 9: its config has no activation until the start 13 writes the activated version,
        -- so it is a candidate from 13 on, not at 9 (mainnet 894,421)
        UNION ALL SELECT 'p7', 's1', NULL, '[]', '[]', '[9,13)'
        UNION ALL SELECT 'p7', 's1', 13, '[]', '[]', '[13,)'
        UNION ALL SELECT q, 's2', 1, '[]', '[]', '[1,)' FROM unnest(ARRAY['q1', 'q2']) q;
      CREATE TABLE ${S}.suppliers (id text, owner_id text, stake_status text, _block_range int8range);
      INSERT INTO ${S}.suppliers SELECT p, CASE WHEN p IN ('p1', 'p2') THEN 'o1' ELSE 'o2' END, 'Staked', '[1,)'
        FROM unnest(ARRAY['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'q1', 'q2']) p;
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
  // every rollup equals the seats and sessions one by one
  const checkRollups = async () => {
    const sums = STATES.map((n, i) => `count(*) FILTER (WHERE ss.state = ${i + 1}) ${n}`).join(", ");
    const raw = await q(`
      SELECT (r.start_time AT TIME ZONE 'UTC')::date::text AS day, ss.supplier_num, ss.service_num, count(*) seats, ${sums},
             coalesce(sum(ss.paid_upokt), 0) paid, round(sum(coalesce(r.paid_upokt, 0)::numeric / r.roster_size), 6) eq
      FROM ${S}.session_suppliers ss JOIN ${S}.session_rosters r ON r.session_num = ss.session_num
      WHERE ss.state <> 0 GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`);
    const roll = await q(`
      SELECT d.day::text AS day, d.supplier_num, d.service_num, d.sessions seats, ${STATES.map((n) => `d.${n}`).join(
        ", "
      )},
             d.paid_upokt paid, round(d.equal_share_upokt, 6) eq
      FROM ${S}.session_supplier_daily d WHERE d.sessions <> 0 ORDER BY 1, 2, 3`);
    assert.deepEqual(
      roll.map((r) => JSON.stringify(Object.values(r).map(String))),
      raw.map((r) => JSON.stringify(Object.values(r).map(String)))
    );
    const sraw = await q(`
      SELECT (r.start_time AT TIME ZONE 'UTC')::date::text AS day, r.service_num, count(*) sessions,
             count(*) FILTER (WHERE r.claimed > 0) wc, count(*) FILTER (WHERE r.claimed = 0) nw, sum(r.roster_size) rs,
             sum(r.candidates) cand, coalesce(sum(r.paid_upokt), 0) paid, coalesce(sum(r.settled_upokt), 0) settled
      FROM ${S}.session_rosters r WHERE r.settled_height IS NOT NULL GROUP BY 1, 2 ORDER BY 1, 2`);
    const sroll = await q(`
      SELECT d.day::text, d.service_num, d.sessions, d.sessions_with_claim, d.sessions_no_work, d.roster_seats,
             d.candidates, d.paid_upokt, d.settled_upokt
      FROM ${S}.session_service_daily d WHERE d.sessions <> 0 ORDER BY 1, 2`);
    assert.deepEqual(
      sroll.map((r) => Object.values(r).map(String)),
      sraw.map((r) => Object.values(r).map(String))
    );
    const seatStates = await q(`
      SELECT (r.start_time AT TIME ZONE 'UTC')::date::text AS day, ss.service_num, ${sums}
      FROM ${S}.session_suppliers ss JOIN ${S}.session_rosters r ON r.session_num = ss.session_num
      WHERE ss.state <> 0 GROUP BY 1, 2 ORDER BY 1, 2`);
    const seatRoll = await q(`SELECT d.day::text, d.service_num, ${STATES.map((n) => `d.${n}`).join(", ")}
      FROM ${S}.session_service_daily d WHERE d.sessions <> 0 ORDER BY 1, 2`);
    assert.deepEqual(
      seatRoll.map((r) => Object.values(r).map(String)),
      seatStates.map((r) => Object.values(r).map(String))
    );
    // per domain: the seats of members on it, and each session once with its V and K; per supplier its sessions' V and K
    const draw = await q(`
      WITH seat AS (
        SELECT (r.start_time AT TIME ZONE 'UTC')::date dd, ss.domain_num, ss.service_num, ss.session_num, ss.paid_upokt,
               r.paid_upokt v
        FROM ${S}.session_suppliers ss JOIN ${S}.session_rosters r ON r.session_num = ss.session_num
        WHERE ss.state <> 0 AND ss.domain_num IS NOT NULL),
      ses AS (SELECT DISTINCT dd, domain_num, service_num, session_num, v FROM seat)
      SELECT a.dd::text AS day, a.domain_num, a.service_num, a.seats, b.sessions, a.y, b.v
      FROM (SELECT dd, domain_num, service_num, count(*) seats, coalesce(sum(paid_upokt), 0) y FROM seat GROUP BY 1, 2, 3) a
      JOIN (SELECT dd, domain_num, service_num, count(*) sessions, coalesce(sum(v), 0) v FROM ses GROUP BY 1, 2, 3) b
        USING (dd, domain_num, service_num)
      ORDER BY 1, 2, 3`);
    const droll = await q(`SELECT d.day::text AS day, d.domain_num, d.service_num, d.seats, d.sessions, d.paid_upokt, d.pool_upokt
      FROM ${S}.session_domain_daily d WHERE d.seats <> 0 ORDER BY 1, 2, 3`);
    assert.ok(droll.length > 0);
    assert.deepEqual(droll.map((r) => Object.values(r).map(String)), draw.map((r) => Object.values(r).map(String)));
    const praw = await q(`SELECT ss.supplier_num, sum(coalesce(r.paid_upokt, 0)) v, sum(r.roster_size) k
      FROM ${S}.session_suppliers ss JOIN ${S}.session_rosters r USING (session_num) WHERE ss.state <> 0 GROUP BY 1 ORDER BY 1`);
    const proll = await q(`SELECT supplier_num, sum(pool_upokt) v, sum(roster_seats) k FROM ${S}.session_supplier_daily
      GROUP BY 1 HAVING sum(sessions) <> 0 ORDER BY 1`);
    assert.deepEqual(proll.map((r) => Object.values(r).map(String)), praw.map((r) => Object.values(r).map(String)));
    // per (day, supplier), every service together
    const dayraw = await q(`SELECT (r.start_time AT TIME ZONE 'UTC')::date::text AS day, ss.supplier_num, count(*) seats,
      count(*) FILTER (WHERE ss.state = 7) inw, coalesce(sum(ss.paid_upokt), 0) y, sum(coalesce(r.paid_upokt, 0)) v, sum(r.roster_size) k
      FROM ${S}.session_suppliers ss JOIN ${S}.session_rosters r USING (session_num) WHERE ss.state <> 0 GROUP BY 1, 2 ORDER BY 1, 2`);
    const dayroll = await q(`SELECT d.day::text AS day, d.supplier_num, d.sessions, d.idle_no_work, d.paid_upokt, d.pool_upokt, d.roster_seats
      FROM ${S}.session_supplier_day d WHERE d.sessions <> 0 ORDER BY 1, 2`);
    assert.deepEqual(dayroll.map((r) => Object.values(r).map(String)), dayraw.map((r) => Object.values(r).map(String)));
    const araw = await q(`
      SELECT (r.start_time AT TIME ZONE 'UTC')::date::text AS day, r.application_num, r.service_num, count(*) sessions,
             count(*) FILTER (WHERE r.claimed > 0) wc, count(*) FILTER (WHERE r.claimed = 0) nw, sum(r.roster_size) rs,
             sum(r.claimed) cs, coalesce(sum(r.paid_upokt), 0) paid
      FROM ${S}.session_rosters r WHERE r.settled_height IS NOT NULL GROUP BY 1, 2, 3 ORDER BY 1, 2, 3`);
    const aroll = await q(`
      SELECT d.day::text, d.application_num, d.service_num, d.sessions, d.sessions_with_claim, d.sessions_no_work,
             d.roster_seats, d.claimed_seats, d.paid_upokt
      FROM ${S}.session_application_daily d WHERE d.sessions <> 0 ORDER BY 1, 2, 3`);
    assert.deepEqual(
      aroll.map((r) => Object.values(r).map(String)),
      araw.map((r) => Object.values(r).map(String))
    );
  };

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
    // without by_service: every settled session of the network
    const [all] = await q(`SELECT count(*) n FROM ${S}.session_rosters WHERE settled_height IS NOT NULL`);
    assert.equal(String(r.network_sessions), String(all.n));
    assert.ok(Number(net.n) < Number(all.n));
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
    // domains: the seats of members whose config is on the domain (session_domain_daily), and by_supplier through the
    // stored daily sets (a.net held p1 on the first day, p1 and p3 on the second)
    await q(`INSERT INTO ${S}.domain_service_daily_suppliers
             SELECT '2026-09-01'::date, 'a.net', 's1', ARRAY(SELECT supplier_num FROM ${S}.supplier_numbers WHERE supplier_id = 'p1'), 1, 24
             UNION ALL SELECT '2026-09-02'::date, 'a.net', 's1',
               ARRAY(SELECT supplier_num FROM ${S}.supplier_numbers WHERE supplier_id IN ('p1', 'p3') ORDER BY 1), 25, 48`);
    const [dm] = await q(
      `SELECT * FROM ${S}.get_supplier_session_funnel(NULL, $1, $2, domains => ARRAY['a.net'])`,
      RANGE
    );
    const [draw] =
      await q(`SELECT count(*) seats FROM ${S}.session_suppliers ss JOIN ${S}.supplier_numbers n USING (supplier_num)
                            WHERE n.supplier_id IN ('p1', 'p3') AND ss.state <> 0`);
    assert.equal(String(dm.seats), String(draw.seats));
    const [dses] = await q(`SELECT count(DISTINCT ss.session_num) n FROM ${S}.session_suppliers ss
      JOIN ${S}.supplier_numbers n USING (supplier_num) WHERE n.supplier_id IN ('p1', 'p3') AND ss.state <> 0`);
    assert.equal(String(dm.sessions_with_selected), String(dses.n));
    // two domains: a session with members on both counts once
    const [two] = await q(`SELECT * FROM ${S}.get_supplier_session_funnel(NULL, $1, $2, domains => ARRAY['a.net', 'b.io'])`, RANGE);
    const [tworaw] = await q(`SELECT count(DISTINCT ss.session_num) n, count(*) seats FROM ${S}.session_suppliers ss
      JOIN ${S}.supplier_numbers n USING (supplier_num) WHERE n.supplier_id IN ('p1', 'p2', 'p3') AND ss.state <> 0`);
    assert.deepEqual([String(two.sessions_with_selected), String(two.seats)], [String(tworaw.n), String(tworaw.seats)]);
    const bySup = await q(`SELECT * FROM ${S}.get_supplier_session_funnel(NULL, $1, $2, by_supplier => true, domains => ARRAY['a.net'])`, RANGE);
    assert.deepEqual(bySup.map((x) => x.supplier_id).sort(), ["p1", "p3"]);
    assert.equal(String(bySup.reduce((a, x) => a + Number(x.seats), 0)), String(draw.seats));
    // by service and supplier: the rows add up to the total
    const parts = await q(`SELECT * FROM ${S}.get_supplier_session_funnel($1, $2, $3, 'day', true, true)`, [
      P,
      ...RANGE,
    ]);
    assert.equal(String(parts.reduce((a, x) => a + Number(x.seats), 0)), String(raw.seats));
  });

  it("answers the network, the applications and the active sessions", async () => {
    const rows = await q(`SELECT * FROM ${S}.get_network_sessions($1, $2)`, RANGE);
    const s1 = rows.find((x) => x.service_id === "s1") as Row;
    const [raw] = await q(`SELECT count(*) n, count(*) FILTER (WHERE claimed = 0) nw FROM ${S}.session_rosters r
                           JOIN ${S}.service_numbers v USING (service_num) WHERE v.service_id = 's1' AND r.settled_height IS NOT NULL`);
    assert.deepEqual([String(s1.sessions), String(s1.no_work)], [String(raw.n), String(raw.nw)]);
    const act = await q(`SELECT * FROM ${S}.get_active_sessions(ARRAY['p1', 'p2', 'p3', 'p4', 'p5', 'p6'])`);
    // the starts 33, 37 and 41 (block 41 ran in the late-claim test), a1, a2 and a4 each
    assert.deepEqual(
      act.map((x) => [x.service_id, Number(x.network_active)]),
      [["s1", 9]]
    );
    assert.ok(Number(act[0].selected_active) > 0 && Number(act[0].selected_seats) >= Number(act[0].selected_active));
    const apps = await q(`SELECT * FROM ${S}.get_application_sessions($1, $2, ARRAY['a2'])`, RANGE);
    assert.ok(apps.every((x) => x.application_id === "a2"));
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
      get_application_sessions: "$1, $2",
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
  it("settles nothing where the money step has not written the outcomes", async () => {
    // the sessions of the start 33 settle at 42
    const due = async () =>
      Number((await q(`SELECT count(*) n FROM ${S}.session_rosters WHERE start_height = 33 AND settled_height IS NULL`))[0].n);
    assert.equal(await due(), 3);
    // the money step has not processed 42 (an override skipping heights): nothing moves
    await q(`UPDATE ${S}.money_progress SET height = 41`);
    assert.equal(await block(42), 0);
    assert.equal(await due(), 3);
    // processed, but 42 is a settlement gap: the sessions wait for it
    await q(`UPDATE ${S}.money_progress SET height = 999999999`);
    await q(`INSERT INTO ${S}.settlement_gaps (from_height, to_height) VALUES (42, 42)`);
    assert.equal(await block(42), 0);
    assert.equal(await due(), 3);
    // the gap written: they settle at the next block that finalizes, as idle (no claims)
    await q(`DELETE FROM ${S}.settlement_gaps`);
    assert.ok((await block(43)) > 0);
    assert.equal(await due(), 0);
    for (const m of await members("a1", "s1", 33)) assert.equal(await stateOf(m, "a1", "s1", 33), "idle_no_work");
    await checkRollups();
  });
});
