// get_network_rewards, get_network_claims, get_overserviced, get_domain_service_rewards and get_validator_blocks, checked
// against the old functions they replace (get_rewards_by_date, get_claim_proofs_data_by_time,
// get_overserviced_by_addresses_and_time, get_rewards_by_domains_and_time_group_by_service, get_produced_blocks_by_validator,
// get_missing_validator_blocks) on the same seeded tables; and the @deprecated comments on the old functions.
//   MONEY_TEST_PG=postgres://postgres:postgres@127.0.0.1:5432/postgres yarn test:money
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { createClaimsByBlockFn, getClaimProofsDataByTimeFn } from "../../src/mappings/dbFunctions/claimProofs";
import { createDeprecationsFn, DEPRECATED_OLD_FUNCTIONS } from "../../src/mappings/dbFunctions/deprecations";
import { createDomainServiceDailyRewardsTableFn } from "../../src/mappings/dbFunctions/domainRewards";
import { getOverservicedsByDelegatorAddressesAndTimesFn } from "../../src/mappings/dbFunctions/overserviced";
import { createSupplierRevShareWalletsFn } from "../../src/mappings/dbFunctions/revShareWallets";
import { getRewardsByDate, getRewardsByDomainsAndTimesGroupByServiceFn } from "../../src/mappings/dbFunctions/rewards";
import { createSettlementFunctionsFn } from "../../src/mappings/dbFunctions/settlement/functions";
import { createSettlementTablesFn } from "../../src/mappings/dbFunctions/settlement/schema";
import { createSettlementSmartTagsFn } from "../../src/mappings/dbFunctions/settlement/smartTags";
import { createSettlementWriterFn } from "../../src/mappings/dbFunctions/settlement/writer";
import { getMissingValidatorBlocksFn, getProducedBlocksByValidatorFn } from "../../src/mappings/dbFunctions/validators";

type Row = Record<string, unknown>;
interface PgClient {
  connect(): Promise<void>;
  end(): Promise<void>;
  query(sql: string, params?: unknown[]): Promise<{ rows: Row[] }>;
}
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Client } = require("pg") as { Client: new (options: { connectionString?: string }) => PgClient };

const URL = process.env.MONEY_TEST_PG;
const S = "old_fn_catalog_ci";

// six UTC days (2026-09-01..06, Tuesday to Sunday) of ten blocks each, every 140 minutes from 00:10: the ids 100..159
const oldStart = (iso: string) => iso.replace("T", " ").replace("Z", "");
// the old functions take an inclusive end without a zone: [a, b) is [a, b - 1 ms] for these whole-minute blocks
const oldEnd = (iso: string) => new Date(Date.parse(iso) - 1).toISOString().replace("T", " ").replace("Z", "");
const ms = (v: unknown) => (v instanceof Date ? v.getTime() : Date.parse(`${String(v).replace(" ", "T")}Z`));
const num = (v: unknown) => (v === null || v === undefined ? null : String(Number(v)));
const WINDOWS: Array<[string, string, string]> = [
  ["2026-09-01T00:00:00Z", "2026-09-07T00:00:00Z", "day"],
  ["2026-09-01T05:00:00Z", "2026-09-05T07:00:00Z", "day"],
  ["2026-09-02T03:00:00Z", "2026-09-02T21:00:00Z", "hour"],
  ["2026-08-31T00:00:00Z", "2026-09-14T00:00:00Z", "week"],
  ["2026-09-01T00:00:00Z", "2026-10-01T00:00:00Z", "month"],
];

describe("catalog versions of the old functions (PostgreSQL)", { skip: !URL && "MONEY_TEST_PG not set" }, () => {
  const c = new Client({ connectionString: URL });
  const q = async (sql: string, params?: unknown[]) => (await c.query(sql, params)).rows;

  before(async () => {
    await c.connect();
    await c.query("SET statement_timeout = '30s'");
    await c.query(`DROP SCHEMA IF EXISTS ${S} CASCADE; CREATE SCHEMA ${S};`);
    await c.query(createSettlementTablesFn(S));
    await c.query(createSettlementWriterFn(S));
    await c.query(`
      CREATE TABLE ${S}.event_claim_settleds (block_id numeric);
      CREATE TABLE ${S}.blocks (id numeric, timestamp timestamp, proposer_address text);
      CREATE INDEX ON ${S}.blocks (timestamp, id);
      CREATE TABLE ${S}.application_gateways (gateway_id text, application_id text, _block_range int8range);
      CREATE TABLE ${S}.params (id text, namespace text, key text, value text, active_at numeric, _block_range int8range);
      CREATE TABLE ${S}.delegations (id text);
      INSERT INTO ${S}.money_progress VALUES (true, 1, 999999999);
      INSERT INTO ${S}.blocks
        SELECT 100 + d * 10 + i, timestamp '2026-09-01 00:10' + d * interval '1 day' + i * interval '140 minutes',
               (ARRAY['VA', 'VB', 'VC'])[(100 + d * 10 + i) % 3 + 1]
        FROM generate_series(0, 5) d, generate_series(0, 9) i;
      -- VA misses every fourth block's commit, VB every seventh
      CREATE TABLE ${S}.block_metadata (id numeric, last_commit jsonb);
      INSERT INTO ${S}.block_metadata
        SELECT b.id, jsonb_build_object('signatures', (SELECT jsonb_agg(jsonb_build_object('validatorAddress', v))
          FROM unnest(ARRAY['VA', 'VB', 'VC']) v WHERE NOT (v = 'VA' AND b.id % 4 = 0) AND NOT (v = 'VB' AND b.id % 7 = 0)))
        FROM ${S}.blocks b;
      -- the per-block relay totals of the settled claims: two services on the even blocks
      CREATE TABLE ${S}.relay_by_block_and_services (relays numeric, estimated_relays numeric, computed_units numeric,
        estimated_computed_units numeric, claimed_upokt numeric, amount integer, block_id numeric, service_id text, _id uuid);
      INSERT INTO ${S}.relay_by_block_and_services
        SELECT b.id * 3 + k, b.id * 4 + k, b.id * 5 + k, b.id * 6 + k, b.id * 7 + k, 1, b.id, 'svc-' || k, gen_random_uuid()
        FROM ${S}.blocks b, generate_series(1, 2) k WHERE b.id % 2 = 0;
      -- overservicing: s1 and s2 share revenue with op-a, s2 with op-b too, s3 with op-a but is Unstaking now, and s4
      -- only through a config that is no longer live
      CREATE TABLE ${S}.suppliers (id text, stake_status text, _block_range int8range);
      INSERT INTO ${S}.suppliers VALUES ('s1', 'Staked', '[1,)'), ('s2', 'Staked', '[1,)'), ('s3', 'Staked', '[1,120)'),
        ('s3', 'Unstaking', '[120,)'), ('s4', 'Staked', '[1,)');
      CREATE TABLE ${S}.supplier_service_configs (supplier_id text, service_id text, rev_share jsonb, _block_range int8range);
      INSERT INTO ${S}.supplier_service_configs VALUES
        ('s1', 'svc-1', '[{"address": "op-a", "revSharePercentage": 100}]', '[1,)'),
        ('s2', 'svc-1', '[{"address": "op-b", "revSharePercentage": 50}, {"address": "op-a", "revSharePercentage": 50}]', '[1,)'),
        ('s3', 'svc-2', '[{"address": "op-a", "revSharePercentage": 100}]', '[1,)'),
        ('s4', 'svc-2', '[{"address": "op-a", "revSharePercentage": 100}]', '[1,130)');
      CREATE TABLE ${S}.event_application_overserviceds (id text, application_id text, supplier_id text, expected_burn numeric,
        effective_burn numeric, block_id numeric, _block_range int8range);
      INSERT INTO ${S}.event_application_overserviceds
        SELECT 'ov' || b.id || s, 'app', s, b.id * 10 + length(s), b.id * 9, b.id, int8range(b.id::bigint, NULL)
        FROM ${S}.blocks b, unnest(ARRAY['s1', 's2', 's3', 's4']) s WHERE (b.id + ascii(substr(s, 2))) % 3 = 0;`);
    await c.query(createClaimsByBlockFn(S));
    await c.query(`
      UPDATE ${S}.claims_by_block_coverage SET covered_from_height = 1;
      INSERT INTO ${S}.claims_by_block
        SELECT b.id, b.timestamp, b.id % 5, b.id, b.id + 1, b.id + 2, b.id + 3, b.id * 10, b.id % 3, b.id * 2, b.id * 2 + 1,
               b.id * 2 + 2, b.id * 2 + 3, b.id * 20, b.id % 2, b.id * 3, NULL, b.id * 3 + 2, b.id * 3 + 3, b.id * 30
        FROM ${S}.blocks b WHERE b.id % 4 <> 1;`);
    await c.query(createDomainServiceDailyRewardsTableFn(S));
    await c.query(`
      INSERT INTO ${S}.domain_service_daily_rewards
        SELECT dm, 'svc-' || k, date '2026-09-01' + d, d * 10 + k, d * 11 + k, d * 12 + k, d * 13 + k, d * 100 + k * 7 + length(dm),
               d + k + length(dm), 100 + d * 10, 109 + d * 10
        FROM unnest(ARRAY['a.net', 'b.io', 'c.org']) dm, generate_series(0, 5) d, generate_series(1, 3) k
        WHERE (d + k + length(dm)) % 4 <> 0;`);
    await c.query(createSupplierRevShareWalletsFn(S));
    await c.query(createSettlementFunctionsFn(S));
    await c.query(createSettlementSmartTagsFn(S));
    for (const f of [
      getRewardsByDate,
      getClaimProofsDataByTimeFn,
      getOverservicedsByDelegatorAddressesAndTimesFn,
      getRewardsByDomainsAndTimesGroupByServiceFn,
      getMissingValidatorBlocksFn,
      getProducedBlocksByValidatorFn,
    ])
      await c.query(f(S));
  });
  after(async () => {
    await c.query(`DROP SCHEMA IF EXISTS ${S} CASCADE`);
    await c.end();
  });

  const oldJson = async (sql: string, params: unknown[]) => JSON.parse(String((await q(`SELECT (${sql})::text j`, params))[0].j));
  const sortRows = (rows: unknown[][]) => rows.map((r) => JSON.stringify(r)).sort();

  it("get_network_rewards answers what get_rewards_by_date answers, newest first", async () => {
    for (const [a, b, bucket] of WINDOWS) {
      const o = ((await oldJson(`${S}.get_rewards_by_date($1, $2, $3)`, [oldStart(a), oldEnd(b), bucket])) ?? []) as Row[];
      const n = await q(`SELECT * FROM ${S}.get_network_rewards($1::timestamptz, $2::timestamptz, $3)`, [a, b, bucket]);
      assert.ok(n.length > 0, `${a} ${bucket}`);
      assert.deepEqual(
        n.map((r) => [ms(r.bucket_start), num(r.relays), num(r.estimated_relays), num(r.compute_units), num(r.estimated_compute_units), num(r.claimed_upokt)]),
        o.reverse().map((r) => [ms(r.date_truncated), num(r.relays), num(r.estimated_relays), num(r.computed_units), num(r.estimated_computed_units), num(r.claimed_amount)]),
        `${a} ${b} ${bucket}`
      );
      for (let i = 1; i < n.length; i++) assert.ok(ms(n[i].bucket_start) < ms(n[i - 1].bucket_start));
    }
    // without a bucket: one total, whose bucket is the range
    const one = await q(`SELECT * FROM ${S}.get_network_rewards('2026-09-01T05:00:00Z', '2026-09-05T07:00:00Z')`);
    const o = (await oldJson(`${S}.get_rewards_by_date($1, $2, 'year')`, [oldStart("2026-09-01T05:00:00Z"), oldEnd("2026-09-05T07:00:00Z")])) as Row[];
    assert.deepEqual([one.length, num(one[0].claimed_upokt), ms(one[0].bucket_start)], [1, num(o[0].claimed_amount), Date.parse("2026-09-01T05:00:00Z")]);
  });

  const CLAIM_KEYS: Array<[string, string]> = [
    ["claims", "claim_amount"], ["claimed_relays", "claim_relays"], ["claimed_estimated_relays", "claim_estimated_relays"],
    ["claimed_compute_units", "claim_computed_units"], ["claimed_estimated_compute_units", "claim_estimated_computed_units"],
    ["claimed_upokt", "claim_upokt"], ["settled_claims", "proof_amount"], ["settled_relays", "proof_relays"],
    ["settled_estimated_relays", "proof_estimated_relays"], ["settled_compute_units", "proof_computed_units"],
    ["settled_estimated_compute_units", "proof_estimated_computed_units"], ["settled_upokt", "proof_upokt"],
    ["expired_claims", "expired_proof_amount"], ["expired_relays", "expired_proof_relays"],
    ["expired_estimated_relays", "expired_proof_estimated_relays"], ["expired_compute_units", "expired_proof_computed_units"],
    ["expired_estimated_compute_units", "expired_proof_estimated_computed_units"], ["expired_upokt", "expired_proof_upokt"],
  ];
  it("get_network_claims answers what get_claim_proofs_data_by_time answers", async () => {
    for (const [a, b, bucket] of WINDOWS) {
      const o = ((await oldJson(`${S}.get_claim_proofs_data_by_time($1, $2, $3)`, [oldStart(a), oldEnd(b), bucket])) ?? []) as Row[];
      const n = await q(`SELECT * FROM ${S}.get_network_claims($1::timestamptz, $2::timestamptz, $3)`, [a, b, bucket]);
      assert.ok(n.length > 0, `${a} ${bucket}`);
      // the old function says 0 where the new one sums only NULLs (expired_estimated_relays here)
      assert.deepEqual(
        n.map((r) => [ms(r.bucket_start), ...CLAIM_KEYS.map(([k]) => num(r[k]) ?? "0")]),
        o.reverse().map((r) => [ms(r.date), ...CLAIM_KEYS.map(([, k]) => num(r[k]))]),
        `${a} ${b} ${bucket}`
      );
      assert.deepEqual(n[0].covered_gaps, []);
    }
  });

  it("get_network_claims reports the heights the per-block table does not hold yet as a gap, never zeros", async () => {
    await c.query(`UPDATE ${S}.claims_by_block_coverage SET covered_from_height = 130`);
    try {
      const n = await q(`SELECT * FROM ${S}.get_network_claims('2026-09-01T00:00:00Z', '2026-09-07T00:00:00Z', 'day')`);
      const at130 = Date.parse("2026-09-04T00:10:00Z");
      assert.deepEqual(
        (n[0].covered_gaps as Array<{ from: string; to: string }>).map((g) => [Date.parse(g.from), Date.parse(g.to)]),
        [[Date.parse("2026-09-01T00:10:00Z"), at130]]
      );
      assert.ok(n.every((r) => ms(r.bucket_start) >= Date.parse("2026-09-04T00:00:00Z")));
      assert.ok(n.every((r) => Number(r.first_height) >= 130));
      // nothing held in the range: one row of NULLs carries the gap, out of the twin's data
      const none = await q(`SELECT bucket_start, covered_gaps FROM ${S}.get_network_claims('2026-09-01T00:00:00Z', '2026-09-02T00:00:00Z')`);
      assert.deepEqual([none.length, none[0].bucket_start], [1, null]);
      const twin = JSON.parse(String((await q(`SELECT ${S}.get_network_claims_json('2026-09-01T00:00:00Z', '2026-09-02T00:00:00Z')::text j`))[0].j)) as {
        data: unknown[];
        range: { gaps: unknown[] };
      };
      assert.deepEqual([twin.data.length, twin.range.gaps.length], [0, 1]);
    } finally {
      await c.query(`UPDATE ${S}.claims_by_block_coverage SET covered_from_height = 1`);
    }
  });

  it("get_overserviced answers what get_overserviced_by_addresses_and_time answers, for the suppliers the operators have now", async () => {
    for (const ops of [["op-a"], ["op-b"], ["op-a", "op-b"], ["op-x"]]) {
      for (const [a, b, bucket] of WINDOWS) {
        const o = ((await oldJson(`${S}.get_overserviced_by_addresses_and_time($1, $2, $3, $4)`, [ops, oldStart(a), oldEnd(b), bucket])) ?? []) as Row[];
        const n = await q(`SELECT * FROM ${S}.get_overserviced($1::text[], $2::timestamptz, $3::timestamptz, $4)`, [ops, a, b, bucket]);
        assert.deepEqual(
          n.map((r) => [ms(r.bucket_start), num(r.expected_burn_upokt), num(r.effective_burn_upokt)]),
          o.reverse().map((r) => [ms(r.date_truncated), num(r.expected_burn), num(r.effective_burn)]),
          `${ops} ${a} ${b} ${bucket}`
        );
        if (ops[0] !== "op-x") assert.ok(n.length > 0);
      }
    }
    // s3 (Unstaking now) and s4 (no live config) are not op-a's: their events are not counted
    const ev = await q(`SELECT sum(events)::int n FROM ${S}.get_overserviced(ARRAY['op-a'], NULL, NULL)`);
    const want = await q(`SELECT count(*)::int n FROM ${S}.event_application_overserviceds WHERE supplier_id IN ('s1', 's2')`);
    assert.equal(ev[0].n, want[0].n);
    await assert.rejects(q(`SELECT * FROM ${S}.get_overserviced(ARRAY[]::text[], NULL, NULL)`), /operators must have between 1 and 200/);
  });

  it("get_domain_service_rewards answers what the old function answers for the same days", async () => {
    // old (start, end) reads the dates of start..end; new [range_start, range_end) the days that start inside it
    const cases: Array<[string[], string, string, string, string]> = [
      [["a.net"], "2026-09-01 00:00", "2026-09-07 00:00", "2026-09-01T00:00:00Z", "2026-09-08T00:00:00Z"],
      [["a.net", "c.org"], "2026-09-02 13:00", "2026-09-04 02:00", "2026-09-02T00:00:00Z", "2026-09-05T00:00:00Z"],
      [["b.io"], "2026-09-03 00:00", "2026-09-03 23:59", "2026-09-03T00:00:00Z", "2026-09-04T00:00:00Z"],
    ];
    for (const [domains, os, oe, ns, ne] of cases) {
      const o = ((await oldJson(`${S}.get_rewards_by_domains_and_time_group_by_service($1, $2, $3)`, [domains, os, oe])) as { services: Row[] }).services;
      const n = await q(`SELECT * FROM ${S}.get_domain_service_rewards($1::text[], $2::timestamptz, $3::timestamptz)`, [domains, ns, ne]);
      assert.ok(n.length > 0);
      assert.deepEqual(
        sortRows(n.map((r) => [r.service_id, num(r.relays), num(r.estimated_relays), num(r.compute_units), num(r.estimated_compute_units), num(r.claimed_upokt)])),
        sortRows(o.map((r) => [r.service_id, num(r.relays), num(r.estimated_relays), num(r.computed_units), num(r.estimated_computed_units), num(r.gross_rewards)])),
        `${domains} ${ns} ${ne}`
      );
      // staked_suppliers: the old function's for one domain; for several, the sum over the domains of the service's last
      // day (the old one took one of them, whichever came first)
      const last = await q(
        `SELECT service_id, sum(suppliers_count) FILTER (WHERE day = last_day)::text n
         FROM (SELECT d.*, max(d.day) OVER (PARTITION BY d.service_id) last_day FROM ${S}.domain_service_daily_rewards d
               WHERE d.domain = ANY($1::text[]) AND d.day >= $2::date AND d.day < $3::date) x GROUP BY 1`,
        [domains, ns.slice(0, 10), ne.slice(0, 10)]
      );
      const want = domains.length === 1 ? o.map((r) => [r.service_id, num(r.staked_suppliers)]) : last.map((r) => [r.service_id, r.n]);
      assert.deepEqual(sortRows(n.map((r) => [r.service_id, num(r.staked_suppliers)])), sortRows(want), `${domains} staked`);
    }
    // a range that starts mid-day leaves that day out (the old function read it)
    const mid = await q(`SELECT min(first_day)::text d FROM ${S}.get_domain_service_rewards(ARRAY['a.net'], '2026-09-02T13:00:00Z', '2026-09-05T00:00:00Z')`);
    assert.equal(mid[0].d, "2026-09-03");
  });

  it("get_validator_blocks lists what the old functions list, newest first, a page at a time", async () => {
    for (const [kind, old] of [
      ["produced", "get_produced_blocks_by_validator"],
      ["missed", "get_missing_validator_blocks"],
    ]) {
      for (const v of ["VA", "VB", "VX"]) {
        const o = (await oldJson(`${S}.${old}($1, $2)`, [117, v])) as number[];
        const all = await q(`SELECT height::int h FROM ${S}.get_validator_blocks($1, 117, kind => $2, row_limit => 1000)`, [v, kind]);
        assert.deepEqual(all.map((r) => r.h), [...o].reverse(), `${kind} ${v}`);
        // pages of 3 through before_height give the same list
        const paged: unknown[] = [];
        let before: unknown = null;
        for (;;) {
          const page = await q(`SELECT height::int h FROM ${S}.get_validator_blocks($1, 117, NULL, $2, 3, $3)`, [v, kind, before]);
          paged.push(...page.map((r) => r.h));
          if (page.length < 3) break;
          before = page[page.length - 1].h;
        }
        assert.deepEqual(paged, all.map((r) => r.h), `${kind} ${v} paged`);
      }
    }
    // to_height bounds the newest
    const upTo = await q(`SELECT height::int h, block_time FROM ${S}.get_validator_blocks('VA', 100, 130, 'produced')`);
    assert.equal(upTo[0].h, 129);
    assert.equal(ms(upTo[0].block_time), Date.parse("2026-09-03T21:10:00Z"));
    await assert.rejects(q(`SELECT * FROM ${S}.get_validator_blocks('VA', 100, kind => 'signed')`), /kind must be produced or missed/);
    await assert.rejects(q(`SELECT * FROM ${S}.get_validator_blocks('VA', 100, row_limit => 1001)`), /row_limit must be between 1 and 1000/);
  });

  it("marks the old functions @deprecated with their replacement, keeps their comment, and rewrites nothing on a second run", async () => {
    const comments = async () =>
      Object.fromEntries(
        (await q(`SELECT p.proname, obj_description(p.oid, 'pg_proc') c FROM pg_proc p WHERE p.pronamespace = $1::regnamespace
                    AND p.proname = ANY($2::text[])`, [S, Object.keys(DEPRECATED_OLD_FUNCTIONS)])).map((r): [string, string] => [String(r.proname), String(r.c)])
      );
    const before = await comments();
    await c.query(createDeprecationsFn(S));
    const after = await comments();
    assert.ok(Object.keys(after).length >= 6);
    for (const [f, c0] of Object.entries(after)) {
      const [first, ...rest] = c0.split("\n");
      assert.match(first, new RegExp(`^@deprecated Will be removed from the schema\\. Use ${DEPRECATED_OLD_FUNCTIONS[f].replace(/[()[\]]/g, "\\$&")}\\.`), f);
      assert.equal(rest.join("\n"), before[f], f);
    }
    const xmin = async () => (await q(`SELECT xmin::text x FROM pg_description WHERE classoid = 'pg_proc'::regclass AND objoid = $1::regprocedure`, [`${S}.get_rewards_by_date(timestamp, timestamp, text)`]))[0].x;
    const x1 = await xmin();
    await c.query(createDeprecationsFn(S));
    assert.deepEqual(await comments(), after);
    assert.equal(await xmin(), x1);
  });
});
