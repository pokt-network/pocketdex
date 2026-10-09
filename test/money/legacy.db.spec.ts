// The legacy_* functions must answer what the live get_* functions answer over the same settlements. Run with
//   MONEY_TEST_PG=postgres://postgres:postgres@127.0.0.1:5432/postgres yarn test:money
//
// The settlements are the 899713 fixture written at four block times (two days, a midnight and an hour edge). The
// SubQuery tables the live functions read (blocks, event_claim_settleds, mod_to_acct_transfers, suppliers,
// supplier_service_configs) are derived here from what the writer wrote: one transfer per income leg, linked to its
// claim, as the indexer records them. So this checks the windows, the edges and the JSON, not the writer (writer.db.spec.ts
// does that); the equality on the chain's own tables was measured on the explorer replica.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import * as zlib from "node:zlib";
import { fromBech32, toBech32 } from "@cosmjs/encoding";
import {
  getRewardsByAddressesAndTime,
  getRewardsByAddressesAndTimeGroupByDate,
  getRewardsByAddressesAndTimeGroupByDateAndAddress,
  getRewardsBySuppliersAndTime,
  getRewardsBySuppliersAndTimeGroupByDateAndAddress,
} from "../../src/mappings/dbFunctions/rewardsByAddressesAndTime";
import { getRewardsByDelegatorAddressesAndTimesGroupByServiceFn } from "../../src/mappings/dbFunctions/rewardsByServicesAddressesAndTime";
import { getRewardsByOperatorAddressesAndTimesGroupByServiceFn } from "../../src/mappings/dbFunctions/rewards";
import {
  CATALOG_FUNCTIONS,
  createSettlementFunctionsFn,
  HELPER_SIGNATURES,
} from "../../src/mappings/dbFunctions/settlement/functions";
import { createSettlementTablesFn } from "../../src/mappings/dbFunctions/settlement/schema";
import { createSettlementSmartTagsFn, OMITTED_TABLES } from "../../src/mappings/dbFunctions/settlement/smartTags";
import {
  createSettlementWriterFn,
  recordMoneyProgressCall,
  recordMoneySkipCall,
  writeSettlementCalls,
} from "../../src/mappings/dbFunctions/settlement/writer";
import { planGap } from "../../src/mappings/money/history/job";
import { getBurnBreakdownBetweenDatesFn } from "../../src/mappings/dbFunctions/supply";
import { addDelegatorValidator, De2Validator } from "../../src/mappings/money/de2";
import { buildSettlementPayload } from "../../src/mappings/money/payload";
import { eraAtHeight } from "../../src/mappings/utils/params_history";

interface PgClient {
  connect(): Promise<void>;
  end(): Promise<void>;
  query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, string | null>> }>;
}
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Client } = require("pg") as { Client: new (options: { connectionString?: string }) => PgClient };

const URL = process.env.MONEY_TEST_PG;
const S = "legacy_ci";
const FIXTURES = path.join(__dirname, "fixtures");
// the same block's settlements at four times: 1 Sep 12:00 and 23:30, 2 Sep 00:00 (midnight), 2 Sep 08:20
const WRITES: Array<[number, string]> = [
  [899713, "2026-09-01T12:00:00Z"],
  [899733, "2026-09-01T23:30:00Z"],
  [899753, "2026-09-02T00:00:00Z"],
  [899773, "2026-09-02T08:20:00Z"],
];

function gz(file: string): Record<string, unknown> {
  return JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString());
}

function validators(): De2Validator[] {
  const de2 = gz(path.join(__dirname, "../../src/mappings/money/fixtures/de2_899713.json.gz")) as {
    validators: Array<{
      operator: string;
      tokens: string;
      delegator_shares: string;
      rate: string;
      delegations: Array<{ delegator: string; shares: string }>;
    }>;
  };
  return de2.validators.map((v) => ({
    operator: v.operator,
    account: toBech32("pokt", fromBech32(v.operator).data),
    tokens: BigInt(v.tokens),
    delegatorShares: BigInt(v.delegator_shares),
    rateAtoms: BigInt(v.rate),
    delegations: v.delegations.map((d) => ({ delegator: d.delegator, shares: BigInt(d.shares) })),
  }));
}

describe("legacy_* functions answer as the live get_* (PostgreSQL)", { skip: !URL && "MONEY_TEST_PG not set" }, () => {
  const c = new Client({ connectionString: URL });
  const fx = () => gz(path.join(FIXTURES, "settlement_899713.json.gz")) as { height: number; events: [] };
  let shareholder = "";
  let pair: string[] = [];
  let suppliers: string[] = [];

  before(async () => {
    await c.connect();
    // as the indexer's role in pnf, not a superuser: the DDL must install without superuser rights (beta, 2026-10-05)
    await c.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${S}_owner') THEN CREATE ROLE ${S}_owner NOSUPERUSER; END IF;
    END $$`);
    await c.query(`DROP SCHEMA IF EXISTS ${S} CASCADE; CREATE SCHEMA ${S} AUTHORIZATION ${S}_owner; SET ROLE ${S}_owner;`);
    await c.query(createSettlementTablesFn(S));
    await c.query(createSettlementWriterFn(S));
    await c.query(`
      CREATE TABLE ${S}.event_claim_settleds (id text, block_id numeric, supplier_id text, service_id text,
        claimed_amount numeric, num_relays numeric, num_estimated_relays numeric, num_claimed_computed_units numeric,
        num_estimated_computed_units numeric, burns jsonb);
      CREATE TABLE ${S}.blocks (id numeric, timestamp timestamp);
      CREATE TABLE ${S}.mod_to_acct_transfers (recipient_id text, amount numeric, block_id numeric, event_claim_settled_id text);
      CREATE TABLE ${S}.suppliers (id text, stake_status text, _block_range int8range);
      CREATE TABLE ${S}.supplier_service_configs (supplier_id text, service_id text, rev_share jsonb, _block_range int8range);
      CREATE TABLE ${S}.application_gateways (gateway_id text, application_id text, _block_range int8range);
      CREATE TABLE ${S}.params (id text, namespace text, key text, value text, active_at numeric, _block_range int8range);
      CREATE TABLE ${S}.delegations (id text);
      -- the name the compat functions had before: the start drops it
      CREATE FUNCTION ${S}.money_rewards_by_addresses_and_time(text[], timestamp, timestamp) RETURNS numeric
        LANGUAGE sql AS 'SELECT 0';
      -- the return types before covered_from / covered_to and {range, data}, and the coverage check that raised: the
      -- start replaces them
      CREATE FUNCTION ${S}.get_income(addresses text[], range_start timestamptz, range_end timestamptz,
        bucket text DEFAULT NULL, by_reason boolean DEFAULT false, by_supplier boolean DEFAULT false,
        by_service boolean DEFAULT false, by_address boolean DEFAULT true, fill_empty_buckets boolean DEFAULT false)
        RETURNS TABLE(bucket_start timestamptz) LANGUAGE sql AS 'SELECT now()';
      CREATE FUNCTION ${S}.legacy_rewards_by_addresses_and_time(addresses text[], start_date timestamp, end_date timestamp)
        RETURNS numeric LANGUAGE sql AS 'SELECT 0';
      CREATE FUNCTION ${S}._check_coverage(range_start timestamptz, range_end timestamptz) RETURNS void
        LANGUAGE sql AS 'SELECT';`);
    await c.query(createSettlementFunctionsFn(S));
    await c.query(createSettlementSmartTagsFn(S));
    for (const fn of [
      getRewardsByAddressesAndTime,
      getRewardsByAddressesAndTimeGroupByDate,
      getRewardsByAddressesAndTimeGroupByDateAndAddress,
      getRewardsBySuppliersAndTime,
      getRewardsBySuppliersAndTimeGroupByDateAndAddress,
      getRewardsByDelegatorAddressesAndTimesGroupByServiceFn,
      getRewardsByOperatorAddressesAndTimesGroupByServiceFn,
      getBurnBreakdownBetweenDatesFn,
    ])
      await c.query(fn(S));

    const vals = validators();
    for (const [height, ts] of WRITES) {
      const f = fx();
      const payload = buildSettlementPayload(height, new Date(ts), eraAtHeight("pocket", f.height), f.events);
      assert.ok(payload);
      addDelegatorValidator(height, payload, vals);
      await c.query("BEGIN");
      for (const { bind, sql } of writeSettlementCalls(S, height, payload)) await c.query(sql, bind);
      await c.query("COMMIT");
    }
    // the indexer's tables, from what was written: a claim per claim_settlements row, a transfer per income leg
    await c.query(`
      INSERT INTO ${S}.blocks SELECT height, block_time AT TIME ZONE 'UTC' FROM ${S}.settlement_blocks;
      -- the indexer's money step processed them all (money/write.ts)
      INSERT INTO ${S}.money_progress VALUES (true, 899713, 899773);
      INSERT INTO ${S}.event_claim_settleds
        SELECT height || '-' || event_idx, height, supplier_id, service_id, settled_upokt, relays, estimated_relays,
               claimed_compute_units, estimated_compute_units, jsonb_build_array(jsonb_build_object('amount', settled_upokt || 'n'))
        FROM ${S}.claim_settlements;
      INSERT INTO ${S}.mod_to_acct_transfers
        SELECT recipient_id, relay_upokt, height, height || '-' || event_idx FROM ${S}.shareholder_payouts WHERE relay_upokt > 0
        UNION ALL
        SELECT recipient_id, global_upokt, height, height || '-' || event_idx FROM ${S}.shareholder_payouts WHERE global_upokt > 0
        UNION ALL
        SELECT x.address, x.amount, c.height, c.height || '-' || c.event_idx
        FROM ${S}.claim_settlements c JOIN ${S}.settlement_blocks sb USING (height)
        CROSS JOIN LATERAL (VALUES (sb.dao_address, c.relay_to_dao_upokt), (sb.dao_address, c.global_to_dao_upokt),
          (sb.dao_address, c.reimbursement_to_dao_upokt), (c.source_owner_id, c.relay_to_source_owner_upokt),
          (c.source_owner_id, c.global_to_source_owner_upokt), (c.application_id, c.relay_to_application_upokt),
          (c.application_id, c.global_to_application_upokt)) x(address, amount)
        WHERE x.amount > 0
        UNION ALL
        SELECT recipient_id, amount_upokt, height, NULL FROM ${S}.staker_payouts;
      INSERT INTO ${S}.suppliers SELECT DISTINCT supplier_id, 'Staked', int8range(1, NULL) FROM ${S}.claim_settlements;
      INSERT INTO ${S}.supplier_service_configs
        SELECT supplier_id, service_id, jsonb_agg(DISTINCT jsonb_build_object('address', recipient_id)), int8range(1, NULL)
        FROM ${S}.shareholder_payouts GROUP BY 1, 2;
      -- a service configured now that settled nothing: the live functions list it with zeros
      INSERT INTO ${S}.supplier_service_configs
        SELECT supplier_id, 'idle-service', rev_share, int8range(1, NULL) FROM ${S}.supplier_service_configs
        WHERE supplier_id = (SELECT min(supplier_id) FROM ${S}.supplier_service_configs) LIMIT 1;`);
    // the indexer's claimed_amount is the settled amount; the money tables keep the claim before overservicing apart.
    // Every claim of this fixture settled whole, so make them differ: gross_rewards must follow settled_upokt.
    await c.query(`
      UPDATE ${S}.claim_settlements SET claimed_upokt = claimed_upokt + 1000;
      UPDATE ${S}.daily_claims_by_supplier_application_service SET claimed_upokt = claimed_upokt + 1000 * claim_count;`);
    // a shareholder paid by several suppliers, in both families (the live group_by_service counts its claims twice)
    shareholder = (
      await c.query(`SELECT recipient_id FROM ${S}.shareholder_payouts WHERE relay_upokt > 0 AND global_upokt > 0
                     GROUP BY 1 ORDER BY count(DISTINCT supplier_id) DESC, 1 LIMIT 1`)
    ).rows[0].recipient_id as string;
    // two shareholders of the same claims
    pair = (
      await c.query(`SELECT array_agg(recipient_id ORDER BY recipient_id) a FROM (
                       SELECT DISTINCT recipient_id FROM ${S}.shareholder_payouts
                       WHERE (height, event_idx) = (SELECT height, event_idx FROM ${S}.shareholder_payouts
                                                    GROUP BY 1, 2 HAVING count(*) >= 2 ORDER BY 1, 2 LIMIT 1)) x`)
    ).rows[0].a as unknown as string[];
    suppliers = (
      await c.query(
        `SELECT array_agg(DISTINCT supplier_id ORDER BY supplier_id) s FROM ${S}.shareholder_payouts
                     WHERE recipient_id = $1`,
        [shareholder]
      )
    ).rows[0].s as unknown as string[];
    assert.ok(suppliers.length >= 2 && pair.length >= 2, `${suppliers.length} suppliers, ${pair.length} shareholders`);
  });
  after(async () => {
    await c.query(`RESET ROLE; DROP SCHEMA IF EXISTS ${S} CASCADE`);
    await c.end();
  });

  // the money step's bookkeeping for a height it processes (money/write.ts), with an override when given
  const step = async (height: number, override = 0) => {
    const { sql, bind } = recordMoneyProgressCall(S, height, override);
    await c.query(sql, bind);
  };
  const one = async (sql: string, params: unknown[] = []) => (await c.query(sql, params)).rows[0];
  // [start, end] BETWEEN inclusive, as the consumers send them: whole history, a day, across midnight, partial hours
  const WINDOWS = [
    ["2026-09-01T00:00:00Z", "2026-09-03T00:00:00Z", "day"],
    ["2026-09-01T00:00:00Z", "2026-09-01T23:59:59.999Z", "hour"],
    ["2026-09-01T23:00:00Z", "2026-09-02T00:00:00Z", "hour"],
    ["2026-09-01T11:30:00Z", "2026-09-02T08:20:00Z", "hour"],
    ["2026-09-02T00:00:00.001Z", "2026-09-02T08:20:00Z", "day"],
  ];
  // a legacy_ function answers {range, data}: data is the live function's answer over the covered part of the range
  const both = async (live: string, legacy: string, args: unknown[]) => {
    const r = (await c.query(`SELECT (${S}.${live})::text l, (${S}.${legacy})->>'data' n`, args)).rows[0];
    return [r.l, r.n];
  };
  // the live group_by_service functions aggregate without an order: compare their elements by service
  const sorted = (j: string | null) =>
    j === null
      ? null
      : (JSON.parse(j) as Array<{ service_id: string }>).sort((a, b) => a.service_id.localeCompare(b.service_id));

  it("the renamed rewards functions give the live JSON (by address: the same elements, whose order within a date the live one leaves to the plan)", async () => {
    for (const [s, e, tr] of WINDOWS) {
      for (const addrs of [[shareholder], pair]) {
        const total = await both(
          "get_rewards_by_addresses_and_time($1, $2, $3)",
          "legacy_rewards_by_addresses_and_time($1, $2, $3)",
          [addrs, s, e]
        );
        assert.notEqual(total[0], "0", `${s}..${e}`);
        assert.equal(total[1], total[0], `total ${s}..${e}`);
        const byDate = await both(
          "get_rewards_by_addresses_and_time_group_by_date($1, $2, $3, $4)",
          "legacy_rewards_by_addresses_and_time_group_by_date($1, $2, $3, $4)",
          [addrs, s, e, tr]
        );
        assert.equal(byDate[1], byDate[0], `by date ${s}..${e} ${tr}`);
        // the live function orders by date only: the order of two addresses within a date is the plan's
        const byAddress = await both(
          "get_rewards_by_addresses_and_time_group_by_address_and_date($1, $2, $3, $4)",
          "legacy_rewards_by_addresses_and_time_group_by_address_and_date($1, $2, $3, $4)",
          [addrs, s, e, tr]
        );
        const key = (j: string | null) =>
          (JSON.parse(j ?? "[]") as Array<Record<string, unknown>>).map((x) => JSON.stringify(x)).sort();
        assert.deepEqual(key(byAddress[1]), key(byAddress[0]), `by address ${s}..${e} ${tr}`);
        const some = suppliers.slice(0, 1);
        const d6 = await both(
          "get_rewards_of_addresses_by_suppliers_and_time($1, $2, $3, $4)",
          "legacy_rewards_of_addresses_by_suppliers_and_time($1, $2, $3, $4)",
          [addrs, some, s, e]
        );
        assert.equal(d6[1], d6[0], `D6 ${s}..${e}`);
        const d5 = await both(
          "get_rewards_by_suppliers_and_time_group_by_address_and_date($1, $2, $3, $4, $5)",
          "legacy_rewards_by_suppliers_and_time_group_by_address_and_date($1, $2, $3, $4, $5)",
          [addrs, some, s, e, tr]
        );
        assert.deepEqual(key(d5[1]), key(d5[0]), `D5 ${s}..${e} ${tr}`);
      }
    }
  });

  it("legacy_burn_breakdown_between_dates and legacy_rewards_by_suppliers_and_time_group_by_service give the live JSON", async () => {
    for (const [s, e] of WINDOWS) {
      const burn = await both(
        "get_burn_breakdown_between_dates($1, $2)",
        "legacy_burn_breakdown_between_dates($1, $2)",
        [s, e]
      );
      assert.notEqual(burn[0], '{"burn_mint" : 0}');
      assert.equal(burn[1], burn[0], `burn ${s}..${e}`);
      for (const list of [suppliers, suppliers.slice(0, 1), ["pokt1nosuchsupplier"]]) {
        const [live, legacy] = await both(
          "get_rewards_by_suppliers_and_time_group_by_service($1, $2, $3)",
          "legacy_rewards_by_suppliers_and_time_group_by_service($1, $2, $3)",
          [list, s, e]
        );
        assert.deepEqual(sorted(legacy), sorted(live), `${list.length} suppliers ${s}..${e}`);
      }
    }
    // the idle service is listed with zeros, as the live function lists it
    const owner = (
      await c.query(`SELECT supplier_id FROM ${S}.supplier_service_configs WHERE service_id = 'idle-service'`)
    ).rows[0].supplier_id as string;
    const j = (
      await c.query(
        `SELECT ${S}.legacy_rewards_by_suppliers_and_time_group_by_service($1, '2026-09-01', '2026-09-03') j`,
        [[owner]]
      )
    ).rows[0].j as unknown as { data: Array<Record<string, string | number>> };
    assert.deepEqual(
      j.data.find((x) => x.service_id === "idle-service"),
      {
        service_id: "idle-service",
        relays: 0,
        estimated_relays: 0,
        computed_units: 0,
        estimated_computed_units: 0,
        gross_rewards: 0,
      }
    );
  });

  it("an operator with no open config (unstaked) still lists the services it settled claims on, in both", async () => {
    const op = suppliers[0];
    const settled = (
      await c.query(
        `SELECT array_agg(DISTINCT service_id ORDER BY service_id) s FROM ${S}.claim_settlements WHERE supplier_id = $1`,
        [op]
      )
    ).rows[0].s as unknown as string[];
    assert.ok(settled.length > 0);
    await c.query("BEGIN");
    try {
      // the unstake closed every config of the operator before the window
      await c.query(`UPDATE ${S}.supplier_service_configs SET _block_range = int8range(1, 2) WHERE supplier_id = $1`, [
        op,
      ]);
      const [live, legacy] = await both(
        "get_rewards_by_suppliers_and_time_group_by_service($1, $2, $3)",
        "legacy_rewards_by_suppliers_and_time_group_by_service($1, $2, $3)",
        [[op], "2026-09-01T00:00:00Z", "2026-09-03T00:00:00Z"]
      );
      assert.deepEqual(sorted(legacy), sorted(live));
      const services = (sorted(live) ?? []) as Array<{ service_id: string; gross_rewards: number }>;
      assert.deepEqual(
        services.map((x) => x.service_id),
        settled
      );
      assert.ok(services.every((x) => Number(x.gross_rewards) > 0));
    } finally {
      await c.query("ROLLBACK");
    }
  });

  it("legacy_rewards_by_addresses_and_time_group_by_service: the live services and net, each claim once", async () => {
    for (const [s, e] of WINDOWS) {
      for (const addrs of [[shareholder], pair]) {
        const [live, legacy] = await both(
          "get_rewards_by_addresses_and_time_group_by_service($1, $2, $3)",
          "legacy_rewards_by_addresses_and_time_group_by_service($1, $2, $3)",
          [addrs, s, e]
        );
        type Row = Record<string, string | number>;
        const l = sorted(live) as unknown as Row[];
        const n = sorted(legacy) as unknown as Row[];
        assert.deepEqual(
          n.map((x) => [x.service_id, String(x.net_rewards)]),
          l.map((x) => [x.service_id, String(x.net_rewards)])
        );
        // the claim columns: each claim that paid the addresses once (distinct claims of their transfers)
        const once = (
          await c.query(
            `SELECT e.service_id, sum(e.num_relays)::text relays, sum(e.num_estimated_relays)::text estimated_relays,
                    sum(e.num_claimed_computed_units)::text computed_units,
                    sum(e.num_estimated_computed_units)::text estimated_computed_units, sum(e.claimed_amount)::text gross_rewards
             FROM ${S}.event_claim_settleds e
             WHERE e.id IN (SELECT m.event_claim_settled_id FROM ${S}.mod_to_acct_transfers m JOIN ${S}.blocks b ON b.id = m.block_id
                            WHERE m.recipient_id = ANY($1) AND b.timestamp BETWEEN $2 AND $3)
             GROUP BY 1`,
            [addrs, s, e]
          )
        ).rows as unknown as Row[];
        assert.ok(once.length > 0);
        const cols = ["relays", "estimated_relays", "computed_units", "estimated_computed_units", "gross_rewards"];
        const pick = (rows: Row[]) =>
          Object.fromEntries(rows.map((x) => [x.service_id, cols.map((k) => String(x[k]))]));
        assert.deepEqual(
          Object.fromEntries(Object.entries(pick(n)).filter(([, v]) => v.some((x) => x !== "0"))),
          Object.fromEntries(Object.entries(pick(once)).filter(([sv]) => sv in pick(n)))
        );
        // and the live function counts a claim once per transfer that paid an address: never less, and more where a
        // claim paid twice (both families, or both addresses of the pair)
        const withClaims = l.filter((r) => String(r.gross_rewards) !== "0");
        const more = withClaims.filter((x) => {
          const m = n.find((y) => y.service_id === x.service_id) as Row;
          assert.ok(BigInt(String(x.gross_rewards)) >= BigInt(String(m.gross_rewards)), `${x.service_id} ${s}..${e}`);
          return BigInt(String(x.gross_rewards)) > BigInt(String(m.gross_rewards));
        });
        assert.ok(more.length > 0, `${addrs.length} addresses ${s}..${e}`);
      }
    }
  });

  it("legacy_rewards_by_addresses_and_time_group_by_service reads the days its rollup holds, and answers as from the claims", async () => {
    // a shareholder in both families, and a pair of shareholders of the same claims (the DAO lists no service here: no
    // configuration names it, so its answer is null either way; writer.db.spec.ts checks its rollup rows)
    const answer = async (addrs: string[], s: string, e: string) =>
      (await one(`SELECT ${S}.legacy_rewards_by_addresses_and_time_group_by_service($1, $2, $3)->>'data' d`, [addrs, s, e])).d;
    await c.query("BEGIN");
    try {
      for (const [s, e] of WINDOWS)
        for (const addrs of [[shareholder], pair]) {
          const d = await answer(addrs, s, e);
          assert.ok(d !== null && /"gross_rewards": [1-9]/.test(d), `${addrs} ${s}..${e}: ${d}`);
          await c.query("SET LOCAL money.no_rollup = on");
          assert.equal(d, await answer(addrs, s, e), `${addrs} ${s}..${e}`);
          await c.query("SET LOCAL money.no_rollup = off");
        }
      // 1 and 2 Sep are whole days of WINDOWS[0]: a rollup row of 1 Sep changed by hand changes the answer, for one address
      // and for a list
      const [s, e] = WINDOWS[0];
      const truth = await answer([shareholder], s, e);
      const pairTruth = await answer(pair, s, e);
      const corrupt = (day: string) =>
        c.query(`UPDATE ${S}.daily_claims_paid_by_address_service SET settled_upokt = settled_upokt + 7
                 WHERE address = ANY($1) AND day = $2`, [[shareholder, ...pair], day]);
      await corrupt("2026-09-01");
      assert.notEqual(await answer([shareholder], s, e), truth);
      assert.notEqual(await answer(pair, s, e), pairTruth);
      // a height of 1 Sep the rollup does not hold: 1 Sep is read from the claims, 2 Sep still from the rollup
      await c.query(`UPDATE ${S}.settlement_blocks SET claims_paid_rollup = false WHERE height = 899733`);
      assert.equal(await answer([shareholder], s, e), truth);
      await corrupt("2026-09-02");
      assert.notEqual(await answer([shareholder], s, e), truth);
      // per day: with a height of 2 Sep not held instead, 2 Sep comes from the claims and 1 Sep, held again, from the
      // rollup (whose changed row shows), never every day before the one not held
      await c.query(`UPDATE ${S}.settlement_blocks SET claims_paid_rollup = true WHERE height = 899733`);
      await c.query(`UPDATE ${S}.settlement_blocks SET claims_paid_rollup = false WHERE height = 899773`);
      assert.notEqual(await answer([shareholder], s, e), truth);
      await c.query(`UPDATE ${S}.daily_claims_paid_by_address_service SET settled_upokt = settled_upokt - 7
                     WHERE address = ANY($1) AND day = '2026-09-01'`, [[shareholder, ...pair]]);
      assert.equal(await answer([shareholder], s, e), truth);
      // a row left at zero claims on 1 Sep (held, read from the rollup) is not read; the same row with one claim is.
      // Its service is one the shareholder's supplier is configured for now and that settled nothing, listed with 0.
      await c.query(
        `INSERT INTO ${S}.supplier_service_configs VALUES ($1, 'zero-svc', jsonb_build_array(jsonb_build_object('address', $2::text)), int8range(1, NULL))`,
        [suppliers[0], shareholder]
      );
      const listed = await answer([shareholder], s, e);
      assert.match(String(listed), /"service_id": "zero-svc", "net_rewards": 0, "gross_rewards": 0/);
      await c.query(
        `INSERT INTO ${S}.daily_claims_paid_by_address_service VALUES ('2026-09-01', $1, 'zero-svc', 0, 999, 5, 5, 5, 5)`,
        [shareholder]
      );
      assert.equal(await answer([shareholder], s, e), listed);
      await c.query(`UPDATE ${S}.daily_claims_paid_by_address_service SET claim_count = 1 WHERE service_id = 'zero-svc'`);
      assert.match(String(await answer([shareholder], s, e)), /"service_id": "zero-svc", "net_rewards": 0, "gross_rewards": 999/);
    } finally {
      await c.query("ROLLBACK");
    }
  });

  it("legacy_rewards_by_addresses_and_time_group_by_service counts once a claim paid by several addresses of a list", async () => {
    const answer = async (addrs: string[], s: string, e: string) =>
      (await one(`SELECT ${S}.legacy_rewards_by_addresses_and_time_group_by_service($1, $2, $3)->>'data' d`, [addrs, s, e])).d;
    const fromClaims = async (addrs: string[], s: string, e: string) => {
      await c.query("SAVEPOINT b");
      try {
        await c.query("SET LOCAL money.no_rollup = on");
        return await answer(addrs, s, e);
      } finally {
        await c.query("ROLLBACK TO SAVEPOINT b");
      }
    };
    // the supplier-days whose claims paid k >= 2 of the list, and of those, the ones where some listed shareholder was
    // not paid by every claim of the supplier that day (read per claim)
    const groups = async (addrs: string[]) =>
      (
        await c.query(
          `SELECT count(*)::int n, count(*) FILTER (WHERE NOT coalesce(cardinality(g.rn) = g.k AND c.claim_count = ALL(g.rn), false))::int unclean
           FROM (SELECT supplier_id, day, count(DISTINCT address) k, array_agg(transfer_count) FILTER (WHERE family = 'relay') rn
                 FROM ${S}.daily_income_by_address_supplier WHERE address = ANY($1) AND role = 'rev_share'
                 GROUP BY 1, 2 HAVING count(DISTINCT address) >= 2) g
           JOIN ${S}.daily_claims_by_supplier c USING (supplier_id, day)`,
          [addrs]
        )
      ).rows[0];
    await c.query("BEGIN");
    try {
      // every shareholder of the suppliers that paid `shareholder`: many overlap on the same claims
      const fleet = (
        await c.query(`SELECT array_agg(DISTINCT recipient_id ORDER BY recipient_id) a FROM ${S}.shareholder_payouts
                       WHERE supplier_id = ANY($1)`, [suppliers])
      ).rows[0].a as unknown as string[];
      const g = await groups(fleet);
      assert.ok(fleet.length > 2 && Number(g.n) > 0, `${fleet.length} addresses, ${JSON.stringify(g)}`);
      // a supplier-day not paid whole by one of its listed shareholders: one relay leg less counted than claims
      const k = (
        await c.query(`SELECT supplier_id, day, address FROM ${S}.daily_income_by_address_supplier
                       WHERE address = ANY($1) AND role = 'rev_share' AND family = 'relay' ORDER BY 1, 2, 3 LIMIT 1`, [fleet])
      ).rows[0];
      const lists: Array<[string, string[]]> = [
        ["pair", pair],
        ["fleet", fleet],
        ["fleet twice", [...fleet, ...fleet]],
      ];
      const check = async (label: string) => {
        for (const [name, addrs] of lists)
          for (const [s, e] of [...WINDOWS, ["2026-08-01T00:00:00Z", "2026-09-30T23:59:59.999999Z"]]) {
            const [r, b] = [await answer(addrs, s, e), await fromClaims(addrs, s, e)];
            assert.ok(b !== null && /"gross_rewards": [1-9]/.test(b), `${label} ${name} ${s}..${e}: ${b}`);
            assert.equal(r, b, `${label} ${name} ${s}..${e}`);
          }
      };
      // September whole: by supplier-month from monthly_claims_by_supplier_service
      await check("by month");
      // a September height monthly_claims_by_supplier_service does not hold: by supplier-day
      await c.query(`UPDATE ${S}.settlement_blocks SET monthly_claims_rollup = false WHERE height = 899773`);
      await check("by day");
      // per claim where a supplier-day (or its month) is not whole for a listed shareholder
      await c.query(`UPDATE ${S}.daily_income_by_address_supplier SET transfer_count = transfer_count - 1
                     WHERE supplier_id = $1 AND day = $2 AND address = $3 AND role = 'rev_share' AND family = 'relay'`,
                    [k.supplier_id, k.day, k.address]);
      assert.ok(Number((await groups(fleet)).unclean) > 0);
      await check("per claim");
      await c.query(`UPDATE ${S}.settlement_blocks SET monthly_claims_rollup = true WHERE height = 899773`);
      await c.query(`UPDATE ${S}.monthly_income_by_address_supplier SET transfer_count = transfer_count - 1
                     WHERE supplier_id = $1 AND month = '2026-09-01' AND address = $2 AND role = 'rev_share' AND family = 'relay'`,
                    [k.supplier_id, k.address]);
      await check("month not whole, per day and claim");
      // the DAO in the list (an address paid other than as a shareholder): every claim, the rollup not read
      const dao = (await one(`SELECT dao_address d FROM ${S}.settlement_blocks WHERE dao_address IS NOT NULL LIMIT 1`)).d as string;
      const [s, e] = WINDOWS[0];
      const withDao = await answer([...pair, dao], s, e);
      assert.equal(withDao, await fromClaims([...pair, dao], s, e));
      await c.query(`UPDATE ${S}.daily_claims_paid_by_address_service SET settled_upokt = settled_upokt + 7 WHERE address = ANY($1)`, [pair]);
      assert.equal(await answer([...pair, dao], s, e), withDao);
      assert.notEqual(await answer(pair, s, e), await fromClaims(pair, s, e));
    } finally {
      await c.query("ROLLBACK");
    }
  });

  it("every legacy_ function accepts the ranges and units the live one accepts, and answers the same at the edges", async () => {
    // [start, end, trunc]: longer than the catalog's caps, exactly 7 days by hour (end + 1 µs is past 7 days), units the
    // catalog has no bucket for, an inverted range and a NULL end: the live function answers all of them
    const EDGES: Array<[string | null, string | null, string | null]> = [
      ["2026-06-01T00:00:00Z", "2026-09-02T12:00:00Z", "day"], // 93 days
      ["2026-08-27T00:00:00Z", "2026-09-03T00:00:00Z", "hour"], // exactly 7 days
      ["2026-01-01T00:00:00Z", "2026-12-31T00:00:00Z", "week"], // 364 days
      ["2025-01-01T00:00:00Z", "2026-12-31T00:00:00Z", "week"], // past 366 days
      ["2026-09-01T00:00:00Z", "2026-09-03T00:00:00Z", "quarter"],
      ["2026-09-01T00:00:00Z", "2026-09-03T00:00:00Z", "DAY"],
      ["2026-09-01T11:00:00Z", "2026-09-02T09:00:00Z", "minute"],
      // date_trunc's aliases take the path of the unit they mean (days -> day rollups, hrs -> hour, ...)
      ["2026-06-01T00:00:00Z", "2026-09-02T12:00:00Z", "days"],
      ["2026-08-27T00:00:00Z", "2026-09-03T00:00:00Z", "hrs"],
      ["2026-01-01T00:00:00Z", "2026-12-31T00:00:00Z", "mon"],
      ["2025-01-01T00:00:00Z", "2026-12-31T00:00:00Z", "y"],
      ["2026-09-01T00:00:00Z", "2026-09-03T00:00:00Z", "qtr"],
      ["2026-09-01T00:00:00Z", "2026-09-03T00:00:00Z", null],
      ["2026-09-03T00:00:00Z", "2026-09-01T00:00:00Z", "day"], // inverted
      [null, "2026-09-03T00:00:00Z", "day"],
      ["2026-09-01T00:00:00Z", null, "day"],
      ["2026-09-01T12:00:00Z", "2026-09-01T12:00:00Z", "hour"], // start = end: the settlement at that instant
    ];
    type Row = Record<string, unknown>;
    const elements = (j: string | null) =>
      j === null ? null : (JSON.parse(j) as Row[]).map((x) => JSON.stringify(x)).sort();
    const some = suppliers.slice(0, 1);
    for (const [s, e, tr] of EDGES) {
      const at = `${s}..${e} ${tr}`;
      for (const addrs of [[shareholder], pair]) {
        for (const [live, legacy, args] of [
          [
            "get_rewards_by_addresses_and_time($1, $2, $3)",
            "legacy_rewards_by_addresses_and_time($1, $2, $3)",
            [addrs, s, e],
          ],
          [
            "get_rewards_of_addresses_by_suppliers_and_time($1, $2, $3, $4)",
            "legacy_rewards_of_addresses_by_suppliers_and_time($1, $2, $3, $4)",
            [addrs, some, s, e],
          ],
          [
            "get_rewards_by_addresses_and_time_group_by_date($1, $2, $3, $4)",
            "legacy_rewards_by_addresses_and_time_group_by_date($1, $2, $3, $4)",
            [addrs, s, e, tr],
          ],
        ] as Array<[string, string, unknown[]]>) {
          const [l, n] = await both(live, legacy, args);
          assert.equal(n, l, `${legacy} ${at}`);
        }
        for (const [live, legacy, args] of [
          [
            "get_rewards_by_addresses_and_time_group_by_address_and_date($1, $2, $3, $4)",
            "legacy_rewards_by_addresses_and_time_group_by_address_and_date($1, $2, $3, $4)",
            [addrs, s, e, tr],
          ],
          [
            "get_rewards_by_suppliers_and_time_group_by_address_and_date($1, $2, $3, $4, $5)",
            "legacy_rewards_by_suppliers_and_time_group_by_address_and_date($1, $2, $3, $4, $5)",
            [addrs, some, s, e, tr],
          ],
        ] as Array<[string, string, unknown[]]>) {
          const [l, n] = await both(live, legacy, args);
          assert.deepEqual(elements(n), elements(l), `${legacy} ${at}`);
        }
        const [l, n] = await both(
          "get_rewards_by_addresses_and_time_group_by_service($1, $2, $3)",
          "legacy_rewards_by_addresses_and_time_group_by_service($1, $2, $3)",
          [addrs, s, e]
        );
        const net = (j: string | null) =>
          sorted(j)?.map((x) => [x.service_id, String((x as unknown as Row).net_rewards)]);
        assert.deepEqual(net(n), net(l), `addresses by service ${at}`);
        if (s === null || e === null || s > e) assert.deepEqual(sorted(n), sorted(l), `addresses by service ${at}`);
      }
      const [l, n] = await both(
        "get_rewards_by_suppliers_and_time_group_by_service($1, $2, $3)",
        "legacy_rewards_by_suppliers_and_time_group_by_service($1, $2, $3)",
        [suppliers, s, e]
      );
      assert.deepEqual(sorted(n), sorted(l), `suppliers by service ${at}`);
      const burn = await both(
        "get_burn_breakdown_between_dates($1, $2)",
        "legacy_burn_breakdown_between_dates($1, $2)",
        [s, e]
      );
      assert.equal(burn[1], burn[0], `burn ${at}`);
      if (s === null || e === null || s > e) {
        const mint = await c.query(`SELECT ${S}.legacy_mint_breakdown_between_dates($1, $2)->>'data' m`, [s, e]);
        assert.equal(mint.rows[0].m, '{"reimbursement" : 0, "inflation" : 0, "mint_burn" : 0}');
      }
    }
    // the catalog keeps its caps: only the legacy_ functions read _income uncapped
    await assert.rejects(
      c.query(`SELECT * FROM ${S}.get_income($1, '2026-06-01T00:00:00Z', '2026-09-02T12:00:00Z', 'day')`, [
        [shareholder],
      ]),
      /bucket=day allows ranges up to 92 days/
    );
  });

  it("every legacy_ function answers {range, data}: what is covered, the range it used, and the gaps", async () => {
    // the heights before the first written settlement are not written (the history job's gap row)
    await c.query(`INSERT INTO ${S}.settlement_gaps VALUES (1, 899712)`);
    try {
      const calls = [
        "legacy_rewards_by_addresses_and_time($1, $2, $3)",
        "legacy_rewards_by_addresses_and_time_group_by_date($1, $2, $3, 'day')",
        "legacy_rewards_by_addresses_and_time_group_by_address_and_date($1, $2, $3, 'day')",
        "legacy_rewards_of_addresses_by_suppliers_and_time($1, $1, $2, $3)",
        "legacy_rewards_by_suppliers_and_time_group_by_address_and_date($1, $1, $2, $3, 'hour')",
        "legacy_rewards_by_suppliers_and_time_group_by_service($1, $2, $3)",
        "legacy_rewards_by_addresses_and_time_group_by_service($1, $2, $3)",
        "legacy_mint_breakdown_between_dates($2, $3)",
        "legacy_burn_breakdown_between_dates($2, $3)",
      ];
      const fns = (
        await c.query(
          `SELECT array_agg(proname::text ORDER BY proname) f FROM pg_proc WHERE pronamespace = $1::regnamespace
                       AND proname LIKE 'legacy\\_%'`,
          [S]
        )
      ).rows[0].f as unknown as string[];
      assert.deepEqual(fns, calls.map((x) => x.split("(")[0]).sort());
      type Range = { requested_from: string | null; requested_to: string | null; covered_from: string | null;
        covered_to: string | null; gaps: Array<{ from: string; to: string }> };
      const ms = (t: string | null) => (t === null ? null : Date.parse(t));
      const call = async (fn: string, start: string | null, end: string | null) => {
        const r = (await c.query(`SELECT (${S}.${fn})::jsonb j, $1::text[]`, [[shareholder], start, end])).rows[0]
          .j as unknown as { range: Range; data: unknown };
        assert.deepEqual(Object.keys(r).sort(), ["data", "range"], fn);
        const g = r.range;
        return { data: r.data, range: { ...g, requested_from: ms(g.requested_from), requested_to: ms(g.requested_to),
          covered_from: ms(g.covered_from), covered_to: ms(g.covered_to),
          gaps: g.gaps.map((x) => [ms(x.from), ms(x.to)]) } };
      };
      const first = Date.parse(WRITES[0][1]);
      const head = Date.parse(WRITES[WRITES.length - 1][1]);
      // a range that starts before the first written settlement: the data of the covered part, from that settlement on
      const live = await c.query(`SELECT ${S}.get_rewards_by_addresses_and_time($1, $2, $3)::text a`, [
        [shareholder], "2026-08-31T00:00:00Z", "2026-09-01T13:00:00Z"]);
      assert.notEqual(live.rows[0].a, "0");
      for (const fn of calls) {
        const r = await call(fn, "2026-08-31T00:00:00Z", "2026-09-01T13:00:00Z");
        assert.deepEqual(r.range, { requested_from: Date.parse("2026-08-31T00:00:00Z"),
          requested_to: Date.parse("2026-09-01T13:00:00Z"), covered_from: first,
          covered_to: Date.parse("2026-09-01T13:00:00Z"), gaps: [[null, first]], end_inclusive: true }, fn);
        const covered = await call(fn, WRITES[0][1], "2026-09-01T13:00:00Z");
        assert.deepEqual(r.data, covered.data, fn);
      }
      assert.equal(String((await call(calls[0], "2026-08-31T00:00:00Z", "2026-09-01T13:00:00Z")).data), live.rows[0].a);
      // a range that ends before it: nothing covered (covered_from / covered_to null), nothing read
      // (data null in every one: no total, series, breakdown or service list reads as zero)
      for (const fn of calls) {
        const r = await call(fn, "2026-08-30T00:00:00Z", "2026-08-31T00:00:00Z");
        assert.deepEqual([r.range.covered_from, r.range.covered_to], [null, null], fn);
        assert.equal(r.data, null, fn);
      }
      // an inverted range still answers as the live function (the zero object)
      const inverted = await call("legacy_mint_breakdown_between_dates($2, $3)", "2026-09-03T00:00:00Z", "2026-09-01T00:00:00Z");
      assert.deepEqual(inverted.data, { reimbursement: 0, inflation: 0, mint_burn: 0 });
      // a range past the latest indexed block: covered_to is that block; a NULL end matches nothing, as before
      const past = await call(calls[0], WRITES[0][1], "2026-09-05T00:00:00Z");
      assert.deepEqual([past.range.covered_from, past.range.covered_to], [first, head]);
      const open = await call(calls[0], WRITES[0][1], null);
      assert.deepEqual([open.range.requested_to, open.data], [null, "0"]);
      // a settlement gap inside the range: listed (between the written settlements around it, whose blocks the
      // fixture lacks), and its heights read nothing
      await c.query(`INSERT INTO ${S}.settlement_gaps VALUES (899740, 899745)`);
      try {
        for (const fn of calls) {
          const r = await call(fn, "2026-09-01T00:00:00Z", "2026-09-03T00:00:00Z");
          // (half-open between the covered heights around it, here the written settlements: 1 µs after the one before,
          // JavaScript keeps ms, up to the one after)
          assert.deepEqual(r.range.gaps, [[null, first], [Date.parse(WRITES[1][1]), Date.parse(WRITES[2][1])]], fn);
          assert.deepEqual(r.range.covered_to, head, fn);
          // a range that ends before the gap does not list it
          assert.deepEqual((await call(fn, "2026-09-01T00:00:00Z", "2026-09-01T13:00:00Z")).range.gaps, [[null, first]], fn);
        }
      } finally {
        await c.query(`DELETE FROM ${S}.settlement_gaps WHERE from_height = 899740`);
      }
    } finally {
      await c.query(`DELETE FROM ${S}.settlement_gaps`);
    }
  });

  it("every catalog function answers for what is covered: covered_from / covered_to on its rows, {range, data} in _json", async () => {
    const one = async (sql: string) => (await c.query(sql)).rows[0];
    const application = (await one(`SELECT min(application_id) a FROM ${S}.claim_settlements`)).a as string;
    const supplier = (await one(`SELECT min(supplier_id) s FROM ${S}.claim_settlements`)).s as string;
    // [function, arguments: $1 range_start, $2 range_end]
    const CALLS: Array<[string, string]> = [
      ["money_coverage", "$1, $2"],
      ["get_application_spend", `ARRAY['${application}'], $1, $2`],
      ["get_gateway_spend", "ARRAY['gw'], $1, $2, fill_empty_buckets => true"],
      ["get_supplier_earnings", "NULL, $1, $2"],
      ["get_supplier_distribution", `ARRAY['${supplier}'], $1, $2, by_reason => true`],
      ["get_income", `ARRAY['${shareholder}'], $1, $2, by_reason => true`],
      ["get_validator_rewards", "NULL, $1, $2"],
      ["get_delegator_income", "NULL, $1, $2"],
      ["get_supply_flows", "$1, $2, by_role => true"],
      ["get_supplier_penalties", `ARRAY['${supplier}'], $1, $2, fill_empty_buckets => true`],
      ["get_service_usage", "NULL, $1, $2, top_by_settled => 3"],
      ["get_app_auto_unstakes", "NULL, $1, $2"],
      ["get_supplier_proofs", "NULL, $1, $2"],
      ["get_param_history", "NULL, NULL, $1, $2"],
    ];
    const ON_BLOCKS = ["get_app_auto_unstakes", "get_param_history"];
    assert.deepEqual(CALLS.map(([f]) => f).sort(), [...CATALOG_FUNCTIONS].sort());
    // and each starts from _coverage (functions.ts covered()): a new one cannot skip it
    const bodies = await c.query(
      `SELECT p.proname, p.prosrc FROM pg_proc p WHERE p.pronamespace = $1::regnamespace AND p.proname = ANY($2::text[])`,
      [S, [...CATALOG_FUNCTIONS]]
    );
    assert.equal(bodies.rows.length, CATALOG_FUNCTIONS.length);
    for (const r of bodies.rows) assert.match(String(r.prosrc), /\._coverage\(range_start, range_end/, String(r.proname));
    const ms = (v: unknown) => (v === null || v === undefined ? null : Date.parse(String(v)));
    // the rows without what the range repeats; bucket_start apart: without a bucket it echoes the requested range_start
    const strip = (r: Record<string, unknown>) =>
      JSON.stringify(
        Object.fromEntries(
          Object.entries(r).filter(([k]) => !["covered_from", "covered_to", "covered_gaps", "bucket_start"].includes(k))
        )
      );
    const run = async (fn: string, args: string, from: string | null, to: string | null) => {
      const rows = (await c.query(`SELECT to_jsonb(r) j FROM ${S}.${fn}(${args}) r`, [from, to])).rows.map(
        (r) => r.j as unknown as Record<string, unknown>
      );
      const j = (await c.query(`SELECT ${S}.${fn}_json(${args}) j`, [from, to])).rows[0].j as unknown as {
        range: Record<string, unknown>;
        data: unknown[];
      };
      const g = j.range;
      const range = {
        requested_from: ms(g.requested_from),
        requested_to: ms(g.requested_to),
        covered_from: ms(g.covered_from),
        covered_to: ms(g.covered_to),
        gaps: (g.gaps as Array<{ from: string; to: string }>).map((x) => [ms(x.from), ms(x.to)]),
        end_inclusive: g.end_inclusive,
      };
      // the _list columns: the same covered_from / covered_to / covered_gaps on every row as in range
      for (const r of rows) {
        assert.deepEqual([ms(r.covered_from), ms(r.covered_to)], [range.covered_from, range.covered_to], fn);
        assert.deepEqual(r.covered_gaps, g.gaps, fn);
      }
      assert.equal(j.data.length, rows.length, fn);
      const starts = [...new Set(rows.map((r) => ms(r.bucket_start ?? null)))];
      return { rows: rows.map(strip), range, starts };
    };
    const first = Date.parse(WRITES[0][1]);
    const head = Date.parse(WRITES[WRITES.length - 1][1]);
    const T = (t: string) => Date.parse(t);
    await c.query("BEGIN");
    try {
      await c.query(`
        CREATE TABLE ${S}.msg_submit_proofs (supplier_id text, service_id text, block_id numeric);
        CREATE TABLE ${S}.event_proof_validity_checkeds (supplier_id text, service_id text, block_id numeric,
          proof_validation_status text, failure_reason text);
        CREATE TABLE ${S}.event_application_unbonding_begins (application_id text, reason int, block_id numeric);
        INSERT INTO ${S}.msg_submit_proofs SELECT supplier_id, service_id, height FROM ${S}.claim_settlements;
        INSERT INTO ${S}.event_application_unbonding_begins SELECT application_id, 1, height FROM ${S}.claim_settlements;`);
      // the whole history is written (the first written settlement is the chain's first): the answers as they were
      const complete: Record<string, string[]> = {};
      for (const [fn, args] of CALLS) {
        const r = await run(fn, args, WRITES[0][1], "2026-09-03T00:00:00Z");
        complete[fn] = r.rows;
        assert.deepEqual([r.range.covered_from, r.range.covered_to, r.range.gaps], [first, head, []], fn);
        if (fn !== "get_gateway_spend" && fn !== "get_param_history") assert.ok(r.rows.length > 0, fn);
      }
      // the heights before the first written settlement are not written (the history job's gap row)
      await c.query(`INSERT INTO ${S}.settlement_gaps VALUES (1, 899712)`);
      for (const [fn, args] of CALLS) {
        // a covered range: the same rows
        const covered = await run(fn, args, WRITES[0][1], "2026-09-03T00:00:00Z");
        assert.deepEqual(covered.rows, complete[fn], fn);
        assert.deepEqual(covered.range, { requested_from: first, requested_to: T("2026-09-03T00:00:00Z"),
          covered_from: first, covered_to: head, gaps: [], end_inclusive: false }, fn);
        // a range that starts before it: the rows of the covered part; without a bucket, bucket_start is the requested
        // range_start (covered_from says where the data starts)
        const partial = await run(fn, args, "2026-08-31T00:00:00Z", "2026-09-03T00:00:00Z");
        if (fn !== "money_coverage" && !ON_BLOCKS.includes(fn)) {
          assert.deepEqual(partial.rows, covered.rows, fn);
          assert.deepEqual(partial.starts, [T("2026-08-31T00:00:00Z")], fn);
        }
        assert.deepEqual([partial.range.requested_from, partial.range.covered_from], [T("2026-08-31T00:00:00Z"), first], fn);
        // a range that ends before it: no rows, and nothing covered (null bounds)
        const before = await run(fn, args, "2026-08-30T00:00:00Z", "2026-08-31T00:00:00Z");
        if (fn !== "money_coverage") assert.deepEqual(before.rows, [], fn);
        assert.deepEqual([before.range.covered_from, before.range.covered_to], [null, null], fn);
        // NULL bounds: open-ended, from the first written settlement to the latest indexed block
        const open = await run(fn, args, null, null);
        assert.deepEqual(open.range, { requested_from: null, requested_to: null, covered_from: first, covered_to: head,
          gaps: ON_BLOCKS.includes(fn) ? [] : [[null, first]], end_inclusive: false }, fn);
        // an open start: a row without a bucket reports covered_from as its bucket_start
        if (fn !== "money_coverage") assert.ok(open.starts.every((x) => x === first), `${fn}: ${JSON.stringify(open.starts)}`);
      }
      // a settlement gap inside the range (heights not written, between 1 Sep 23:30 and 2 Sep 00:00): listed, and the
      // data is what is written around it
      await c.query(`INSERT INTO ${S}.settlement_gaps VALUES (899740, 899745)`);
      for (const [fn, args] of CALLS) {
        const r = await run(fn, args, WRITES[0][1], "2026-09-03T00:00:00Z");
        // (money_coverage reports the gap in its own gaps column too)
        if (fn !== "money_coverage") assert.deepEqual(r.rows, complete[fn], fn);
        const gaps = ON_BLOCKS.includes(fn) ? [] : [[T(WRITES[1][1]), T(WRITES[2][1])]];
        assert.deepEqual(r.range.gaps, gaps, fn);
        assert.deepEqual((await run(fn, args, WRITES[0][1], "2026-09-01T13:00:00Z")).range.gaps, [], fn);
      }
      // the rollup version still raises: an operational fault, not coverage
      await c.query(`UPDATE ${S}.settlement_blocks SET rollup_version = 0`);
      await assert.rejects(
        c.query(`SELECT * FROM ${S}.get_supply_flows('2026-08-31T00:00:00Z', '2026-09-03T00:00:00Z')`),
        /run rebuild_rollups first/
      );
    } finally {
      await c.query("ROLLBACK");
    }
  });

  it("coverage starts after a leading gap, and stops at the last written settlement while later ones are not written", async () => {
    const ms = (v: unknown) => (v === null ? null : Date.parse(String(v)));
    const flows = async (from: string, to: string) => {
      const j = (await c.query(`SELECT ${S}.get_supply_flows_json($1, $2) j`, [from, to])).rows[0].j as unknown as {
        range: { covered_from: string; covered_to: string; gaps: Array<{ from: string | null; to: string }> };
        data: unknown[];
      };
      const burn = (await c.query(`SELECT ${S}.legacy_burn_breakdown_between_dates($1, $2)::jsonb j`, [from, to])).rows[0]
        .j as unknown as { data: unknown };
      return {
        covered: [ms(j.range.covered_from), ms(j.range.covered_to)],
        gaps: j.range.gaps.map((g) => [ms(g.from), ms(g.to)]),
        rows: j.data.length,
        burn: burn.data,
      };
    };
    const first = Date.parse(WRITES[0][1]);
    const head = Date.parse(WRITES[WRITES.length - 1][1]);
    await c.query("BEGIN");
    try {
      // the indexer started at S = 899733 (its raw tables begin there) and the history job wrote down to h = 899713,
      // keeping the gap [1, h - 1]: the raw tables alone would call the history complete
      await c.query(`DELETE FROM ${S}.event_claim_settleds WHERE block_id < 899733;
                     INSERT INTO ${S}.settlement_gaps VALUES (1, 899712)`);
      // the fixture has no block 1 or h - 1: the gap starts at no known time and ends at the first written settlement
      // (half-open)
      const partial = await flows("2026-08-31T00:00:00Z", "2026-09-03T00:00:00Z");
      assert.deepEqual(partial.covered, [first, head]);
      assert.deepEqual(partial.gaps, [[null, first]]);
      assert.ok(partial.rows > 0);
      // a range inside the gap: nothing read, and the gap says why
      const before = await flows("2026-08-30T00:00:00Z", "2026-08-31T00:00:00Z");
      assert.deepEqual(
        [before.covered, before.gaps, before.rows, before.burn],
        [[null, null], [[null, first]], 0, null]
      );
      // the job has classified the heights below h down to h0 = 899701 (11:00) as settling nothing, and lowered its gap
      // to [1, h0 - 1]: coverage starts at h0, and a range there is covered with nothing in it (a zero, not null)
      // (the job lowers money_progress.from_height with its row: job.ts lowerGap)
      await c.query(`UPDATE ${S}.settlement_gaps SET to_height = 899700; INSERT INTO ${S}.blocks VALUES (899701, '2026-09-01 11:00');
                     UPDATE ${S}.money_progress SET from_height = 899701`);
      const h0 = Date.parse("2026-09-01T11:00:00Z");
      const quiet = await flows("2026-09-01T11:00:00Z", "2026-09-01T11:30:00Z");
      assert.deepEqual([quiet.covered, quiet.rows, quiet.burn], [[h0, Date.parse("2026-09-01T11:30:00Z")], 0, { burn_mint: 0 }]);
      assert.deepEqual((await flows("2026-08-31T00:00:00Z", "2026-09-03T00:00:00Z")).covered, [h0, head]);
      // the money step processed a block after the last written settlement (no settlement there): covered up to it
      await c.query(`INSERT INTO ${S}.blocks VALUES (899800, '2026-09-02 10:00')`);
      await step(899800);
      const ten = Date.parse("2026-09-02T10:00:00Z");
      assert.deepEqual((await flows("2026-08-31T00:00:00Z", "2026-09-03T00:00:00Z")).covered, [h0, ten]);
      // the indexer restarts with POCKETDEX_MONEY_FROM_HEIGHT = 899900: while it skips, the progress stays at 899800,
      // so a slash-only height it indexes at 10:30 is not covered (not a zero), though no claim is there
      await c.query(`INSERT INTO ${S}.blocks VALUES (899850, '2026-09-02 10:30')`);
      const skipping = await flows("2026-09-02T10:15:00Z", "2026-09-02T10:45:00Z");
      assert.deepEqual([skipping.covered, skipping.rows, skipping.burn], [[null, null], 0, null]);
      // the first height past the override (899900, 11:00) records [899801, 899899] and moves the progress
      await c.query(`INSERT INTO ${S}.blocks VALUES (899900, '2026-09-02 11:00')`);
      await step(899900, 899900);
      const rows = (await c.query(`SELECT from_height::int f, to_height::int t FROM ${S}.settlement_gaps ORDER BY 1`)).rows;
      assert.deepEqual(rows, [{ f: 1, t: 899700 }, { f: 899801, t: 899899 }]);
      const eleven = Date.parse("2026-09-02T11:00:00Z");
      const all = await flows("2026-08-31T00:00:00Z", "2026-09-03T00:00:00Z");
      assert.deepEqual([all.covered, all.gaps], [[h0, eleven], [[null, h0], [ten, eleven]]]);
      const slash = await flows("2026-09-02T10:15:00Z", "2026-09-02T10:45:00Z");
      assert.deepEqual([slash.covered, slash.rows, slash.burn, slash.gaps], [[null, null], 0, null, [[ten, eleven]]]);
    } finally {
      await c.query("ROLLBACK");
    }
  });

  it("a range inside a gap reads nothing, a bucket over a gap is not zero-filled, and covered_to is half-open", async () => {
    const one = async (sql: string, params: unknown[] = []) => (await c.query(sql, params)).rows[0];
    const first = Date.parse(WRITES[0][1]);
    await c.query("BEGIN");
    try {
      // heights not written between 1 Sep 12:00 and 23:30 (the fixture has no blocks there): [12:00 + 1 µs, 23:30), so
      // a range made only of written heights does not list it
      await c.query(`INSERT INTO ${S}.settlement_gaps VALUES (899720, 899730)`);
      const g = (await one(`SELECT ${S}.get_supply_flows_json('2026-09-01T00:00:00Z', '2026-09-03T00:00:00Z') j`))
        .j as unknown as { range: { gaps: Array<{ from: string; to: string }> } };
      assert.deepEqual(
        await one(
          `SELECT ($1::jsonb->0->>'from')::timestamptz = timestamptz '${WRITES[0][1]}' + interval '1 microsecond' a,
                  ($1::jsonb->0->>'to')::timestamptz = timestamptz '${WRITES[1][1]}' b`,
          [JSON.stringify(g.range.gaps)]
        ),
        { a: true, b: true }
      );
      const at23 = (await one(`SELECT ${S}.get_supply_flows_json($1, '2026-09-03T00:00:00Z') j`, [WRITES[1][1]]))
        .j as unknown as { range: { gaps: unknown[] } };
      assert.deepEqual(at23.range.gaps, []);
      // a range inside the gap: no rows, and data null in every legacy_ function (not a zero)
      const flows = (await one(`SELECT ${S}.get_supply_flows_json('2026-09-01T13:00:00Z', '2026-09-01T14:00:00Z') j`))
        .j as unknown as { data: unknown[] };
      assert.deepEqual(flows.data, []);
      const legacy = [
        `legacy_rewards_by_addresses_and_time($1, $2, $3)`,
        `legacy_rewards_of_addresses_by_suppliers_and_time($1, $1, $2, $3)`,
        `legacy_rewards_by_addresses_and_time_group_by_date($1, $2, $3, 'hour')`,
        `legacy_rewards_by_suppliers_and_time_group_by_service($1, $2, $3)`,
        `legacy_rewards_by_addresses_and_time_group_by_service($1, $2, $3)`,
        `legacy_mint_breakdown_between_dates($2, $3)`,
        `legacy_burn_breakdown_between_dates($2, $3)`,
      ];
      for (const fn of legacy) {
        const r = await one(`SELECT (${S}.${fn})::jsonb->'data' d, $1::text[]`, [
          [shareholder],
          "2026-09-01T13:00:00Z",
          "2026-09-01T14:00:00Z",
        ]);
        assert.equal(r.d, null, fn);
      }
      // by hour with fill_empty_buckets: the hours inside the gap get no zero row, only 12:00 and 23:00 (with data)
      const hours = await c.query(
        `SELECT DISTINCT bucket_start FROM ${S}.get_supply_flows('2026-09-01T12:00:00Z', '2026-09-02T00:00:00Z', 'hour',
           fill_empty_buckets => true) ORDER BY 1`
      );
      assert.deepEqual(
        hours.rows.map((r) => new Date(String(r.bucket_start)).toISOString()),
        ["2026-09-01T12:00:00.000Z", "2026-09-01T23:00:00.000Z"]
      );
      // nor does a requested id with no activity: its zero rows go only to the buckets that intersect what is covered
      const idle = await c.query(
        `SELECT DISTINCT bucket_start FROM ${S}.get_application_spend(ARRAY['app-idle'], '2026-09-01T12:00:00Z',
           '2026-09-02T02:00:00Z', 'hour', fill_empty_buckets => true) WHERE application_id = 'app-idle' ORDER BY 1`
      );
      assert.deepEqual(
        idle.rows.map((r) => new Date(String(r.bucket_start)).toISOString()),
        ["2026-09-01T12:00:00.000Z", "2026-09-01T23:00:00.000Z", "2026-09-02T00:00:00.000Z", "2026-09-02T01:00:00.000Z"]
      );
      const inside = await c.query(
        `SELECT count(*)::int n FROM ${S}.get_application_spend(ARRAY['app-idle'], '2026-09-01T13:00:00Z',
           '2026-09-01T20:00:00Z', 'hour', fill_empty_buckets => true)`
      );
      assert.equal(inside.rows[0].n, 0);
      await c.query(`DELETE FROM ${S}.settlement_gaps`);
      const all = await c.query(
        `SELECT DISTINCT bucket_start FROM ${S}.get_supply_flows('2026-09-01T12:00:00Z', '2026-09-02T00:00:00Z', 'hour',
           fill_empty_buckets => true)`
      );
      assert.equal(all.rows.length, 12);
      // covered_to is half-open like range_end in the catalog (the latest block + 1 µs), inclusive like end_date in legacy_
      const head = `timestamptz '${WRITES[WRITES.length - 1][1]}'`;
      assert.deepEqual(
        await one(
          `SELECT (${S}.get_supply_flows_json(NULL, NULL)->'range'->>'covered_to')::timestamptz
                    = ${head} + interval '1 microsecond' a,
                  (${S}.legacy_burn_breakdown_between_dates('2026-09-01', '2026-09-05')::jsonb->'range'->>'covered_to')::timestamptz
                    = ${head} b`
        ),
        { a: true, b: true }
      );
      // from_height below the indexer's first block (the history job walked there): coverage starts at the first
      // indexed block at or after it, the only times the blocks table has
      await c.query(`DELETE FROM ${S}.event_claim_settleds WHERE block_id < 899733; DELETE FROM ${S}.blocks WHERE id < 899733;
                     UPDATE ${S}.money_progress SET from_height = 899713`);
      const r = (await one(`SELECT ${S}.get_supply_flows_json(NULL, NULL) j`)).j as unknown as {
        range: { covered_from: string };
      };
      assert.equal(Date.parse(r.range.covered_from), Date.parse(WRITES[1][1]));
      assert.ok(first < Date.parse(WRITES[1][1]));
    } finally {
      await c.query("ROLLBACK");
    }
  });

  it("one covered set: gap edges, fills before the first block, after the writer and past the history, merged gaps", async () => {
    const one = async (sql: string, params: unknown[] = []) => (await c.query(sql, params)).rows[0];
    const ms = (v: unknown) => (v === null || v === undefined ? null : Date.parse(String(v)));
    const T = (t: string) => Date.parse(t);
    const range = async (sql: string, params: unknown[] = []) => {
      const j = (await one(`SELECT (${sql})::jsonb j`, params)).j as unknown as {
        range: { covered_from: string | null; covered_to: string | null; gaps: Array<{ from: string | null; to: string | null }> };
        data: unknown;
      };
      return {
        covered: [ms(j.range.covered_from), ms(j.range.covered_to)],
        gaps: j.range.gaps.map((g) => [ms(g.from), ms(g.to)]),
        data: j.data,
      };
    };
    const buckets = async (sql: string) =>
      (await c.query(`SELECT DISTINCT bucket_start FROM ${sql} ORDER BY 1`)).rows.map((r) =>
        new Date(String(r.bucket_start)).toISOString().slice(0, 10)
      );
    await c.query("BEGIN");
    try {
      await c.query(`
        CREATE TABLE ${S}.msg_submit_proofs (supplier_id text, service_id text, block_id numeric);
        CREATE TABLE ${S}.event_proof_validity_checkeds (supplier_id text, service_id text, block_id numeric,
          proof_validation_status text, failure_reason text);
        CREATE TABLE ${S}.event_application_unbonding_begins (application_id text, reason int, block_id numeric);`);
      // the complete history (the first written settlement is the chain's first) by month: only the month that has
      // indexed blocks, not July and August before the first one
      assert.deepEqual(
        await buckets(`${S}.get_supply_flows('2026-07-01T00:00:00Z', '2026-10-01T00:00:00Z', 'month', fill_empty_buckets => true)`),
        ["2026-09-01"]
      );
      // over the indexer's own tables (beta: complete from the first block), an idle id by day from before that block:
      // its zero rows start on the day of the first block
      assert.deepEqual(
        await buckets(`${S}.get_app_auto_unstakes(ARRAY['app-idle'], '2026-08-28T00:00:00Z', '2026-09-03T00:00:00Z', 'day',
          fill_empty_buckets => true)`),
        ["2026-09-01", "2026-09-02"]
      );
      // the gap edge: heights not written whose last block is at 15:00:00, the next block (covered, no settlement) at
      // 15:00:20. A range between the two is inside the gap: nothing covered (null bounds, data null), not a zero
      await c.query(`INSERT INTO ${S}.settlement_gaps VALUES (899720, 899725);
                     INSERT INTO ${S}.blocks VALUES (899725, '2026-09-01 15:00:00'), (899726, '2026-09-01 15:00:20')`);
      const edge = await range(`${S}.legacy_burn_breakdown_between_dates($1, $2)`, ["2026-09-01 15:00:10", "2026-09-01 15:00:15"]);
      assert.deepEqual([edge.covered, edge.data], [[null, null], null]);
      assert.deepEqual(edge.gaps, [[T(WRITES[0][1]), T("2026-09-01T15:00:20Z")]]);
      const after = await range(`${S}.legacy_burn_breakdown_between_dates($1, $2)`, ["2026-09-01 15:00:20", "2026-09-01 16:00"]);
      assert.deepEqual([after.covered, after.data, after.gaps], [[T("2026-09-01T15:00:20Z"), T("2026-09-01T16:00:00Z")], { burn_mint: 0 }, []]);
      const flows = await range(`${S}.get_supply_flows_json($1, $2)`, ["2026-09-01T15:00:10Z", "2026-09-01T15:00:15Z"]);
      assert.deepEqual([flows.covered, flows.data], [[null, null], []]);
      // a second gap right after it (its first block before is 15:00:00, its last block after at 16:00): one merged gap
      await c.query(`INSERT INTO ${S}.settlement_gaps VALUES (899726, 899730); INSERT INTO ${S}.blocks VALUES (899731, '2026-09-01 16:00')`);
      const merged = await range(`${S}.get_supply_flows_json($1, $2)`, ["2026-09-01T00:00:00Z", "2026-09-03T00:00:00Z"]);
      assert.deepEqual(merged.gaps, [[T(WRITES[0][1]), T("2026-09-01T16:00:00Z")]]);
      // a range the live function matches nothing for (a NULL end): no coverage to report, no gaps, the live answer (0)
      const half = await range(`${S}.legacy_rewards_by_addresses_and_time($3, $1, $2)`, ["2026-09-01", null, [shareholder]]);
      assert.deepEqual([half.covered, half.gaps, half.data], [[null, null], [], "0"]);
      // the override window after the last written settlement (POCKETDEX_MONEY_FROM_HEIGHT = 899900), the latest block
      // on 3 Sep 10:00. By day, an idle supplier's zero rows stop at the last written settlement's day (2 Sep), although
      // the proofs' span runs to the latest block (3 Sep)
      // (the money step skips: its progress stays at 899773)
      await c.query(`INSERT INTO ${S}.blocks VALUES (899800, '2026-09-03 10:00')`);
      assert.deepEqual(
        await buckets(`${S}.get_supplier_proofs(ARRAY['sup-idle'], '2026-09-01T00:00:00Z', '2026-09-05T00:00:00Z', 'day',
          fill_empty_buckets => true)`),
        ["2026-09-01", "2026-09-02"]
      );
    } finally {
      await c.query("ROLLBACK");
    }
  });

  it("the start-up DDL is idempotent: a second run replaces nothing but the _json twins", async () => {
    // a drop guard that misreads a signature drops and recreates the function on every start (a new oid each time)
    const oids = async () =>
      (
        await c.query(
          `SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' f, p.oid::text o FROM pg_proc p
           WHERE p.pronamespace = $1::regnamespace AND p.proname NOT LIKE '%\\_json' ORDER BY 1`,
          [S]
        )
      ).rows;
    const before = await oids();
    assert.ok(before.some((r) => String(r.f).startsWith("_coverage(")) && before.some((r) => String(r.f).startsWith("_legacy_range(")));
    // every reshaped helper has exactly its current signature (HELPER_SIGNATURES), and the gone ones are gone
    const helpers = await c.query(
      `SELECT p.proname, pg_get_function_arguments(p.oid) args FROM pg_proc p
       WHERE p.pronamespace = $1::regnamespace AND p.proname = ANY($2::text[]) ORDER BY 1`,
      [S, Object.keys(HELPER_SIGNATURES)]
    );
    assert.deepEqual(
      helpers.rows.map((r) => [r.proname, r.args]),
      Object.entries(HELPER_SIGNATURES)
        .filter(([, args]) => args !== null)
        .sort(([a], [b]) => (a < b ? -1 : 1))
    );
    // the twins of the functions over the indexer's own tables report that coverage
    const twins = await c.query(
      `SELECT p.proname FROM pg_proc p WHERE p.pronamespace = $1::regnamespace AND p.proname LIKE '%\\_json'
         AND position('_range_json(range_start, range_end, true)' in p.prosrc) > 0 ORDER BY 1`,
      [S]
    );
    assert.deepEqual(twins.rows.map((r) => r.proname), ["get_app_auto_unstakes_json", "get_param_history_json"]);
    // an earlier build's overloads (installed here by hand) are dropped by the next start, and the calls stay unambiguous
    await c.query(`
      CREATE FUNCTION ${S}._income(addresses text[], range_start timestamptz, range_end timestamptz, bucket text,
        by_reason boolean, by_supplier boolean, by_service boolean, by_address boolean, fill_empty_buckets boolean,
        suppliers text[], capped boolean, p_covered tstzmultirange, p_span_from timestamptz)
        RETURNS TABLE(bucket_start timestamptz) LANGUAGE sql AS 'SELECT now()';
      CREATE FUNCTION ${S}._covered_buckets(bucket text, span_first timestamptz, span_last timestamptz, gaps jsonb)
        RETURNS SETOF timestamptz LANGUAGE sql AS 'SELECT now()';
      -- a supplier function from before operators
      CREATE FUNCTION ${S}.get_supplier_earnings(suppliers text[], range_start timestamptz, range_end timestamptz,
        bucket text DEFAULT NULL, by_service boolean DEFAULT false, by_application boolean DEFAULT false,
        by_supplier boolean DEFAULT true, owners text[] DEFAULT NULL, fill_empty_buckets boolean DEFAULT false)
        RETURNS TABLE(bucket_start timestamptz) LANGUAGE sql AS 'SELECT now()';`);
    await c.query(createSettlementFunctionsFn(S));
    await c.query(createSettlementSmartTagsFn(S));
    assert.deepEqual(await oids(), before);
    await c.query(`SELECT * FROM ${S}.get_income($1, '2026-09-01T00:00:00Z', '2026-09-03T00:00:00Z', 'hour', fill_empty_buckets => true)`, [
      [shareholder],
    ]);
    await c.query(`SELECT * FROM ${S}.get_supplier_earnings($1, '2026-09-01T00:00:00Z', '2026-09-03T00:00:00Z')`, [
      suppliers.slice(0, 200),
    ]);
  });

  it("a covered range after the last settlement returns the zero rows of idle ids, up to what is covered", async () => {
    await c.query("BEGIN");
    try {
      // the latest indexed block at 10:00 on 2 Sep, the last settlement at 08:20: the last 30 minutes are covered and
      // settled nothing, so each requested id has its zero row
      await c.query(`INSERT INTO ${S}.blocks VALUES (899800, '2026-09-02 10:00')`);
      await step(899800);
      for (const [fn, bucket, n] of [
        ["get_application_spend", "'hour'", 1],
        ["get_application_spend", "NULL", 1],
        ["get_income", "'hour'", 1],
        ["get_income", "NULL", 1],
      ] as const) {
        const { rows } = await c.query(
          `SELECT bucket_start, to_jsonb(r) j FROM ${S}.${fn}(ARRAY['pokt1idle'], '2026-09-02T09:30:00Z', '2026-09-02T10:00:00Z',
             bucket => ${bucket}, fill_empty_buckets => true) r`
        );
        assert.equal(rows.length, n, `${fn} ${bucket}`);
        const start = new Date(String(rows[0].bucket_start)).toISOString();
        assert.equal(start, bucket === "NULL" ? "2026-09-02T09:30:00.000Z" : "2026-09-02T09:00:00.000Z", `${fn} ${bucket}`);
        assert.ok(Object.values(rows[0].j as unknown as Record<string, unknown>).includes("pokt1idle"), `${fn} ${bucket}`);
      }
      // past the latest indexed block nothing is covered: no rows
      const after = await c.query(
        `SELECT count(*)::int n FROM ${S}.get_application_spend(ARRAY['pokt1idle'], '2026-09-02T10:30:00Z',
           '2026-09-02T11:00:00Z', 'hour', fill_empty_buckets => true)`
      );
      assert.equal(after.rows[0].n, 0);
    } finally {
      await c.query("ROLLBACK");
    }
  });

  it("money_progress: an override freezes coverage, the job walks below it, a chain without settlements is covered", async () => {
    const one = async (sql: string, params: unknown[] = []) => (await c.query(sql, params)).rows[0];
    const ms = (v: unknown) => (v === null || v === undefined ? null : Date.parse(String(v)));
    const T = (t: string) => Date.parse(t);
    const range = async (from: string | null, to: string | null) => {
      const j = (await one(`SELECT ${S}.get_supply_flows_json($1, $2) j`, [from, to])).j as unknown as {
        range: { covered_from: string | null; covered_to: string | null; gaps: Array<{ from: string | null; to: string | null }> };
        data: unknown[];
      };
      const burn = (await one(`SELECT ${S}.legacy_burn_breakdown_between_dates($1, $2)::jsonb j`, [from, to])).j as unknown as {
        data: unknown;
      };
      return { covered: [ms(j.range.covered_from), ms(j.range.covered_to)], gaps: j.range.gaps.map((g) => [ms(g.from), ms(g.to)]), rows: j.data.length, burn: burn.data };
    };
    const gapRows = async () =>
      (await c.query(`SELECT from_height::int f, to_height::int t FROM ${S}.settlement_gaps ORDER BY 1`)).rows;
    const plan = () => planGap(c as unknown as Parameters<typeof planGap>[0], { schema: S } as unknown as Parameters<typeof planGap>[1]);
    const head = T(WRITES[WRITES.length - 1][1]);
    const first = T(WRITES[0][1]);
    await c.query("BEGIN");
    try {
      // the writer at head: the progress is the latest block, so covered_to is it (+ 1 µs, half-open)
      assert.deepEqual((await range(null, null)).covered, [first, head]);
      assert.equal(
        (await one(`SELECT (${S}.get_supply_flows_json(NULL, NULL)->'range'->>'covered_to')::timestamptz
                           = timestamptz '${WRITES[WRITES.length - 1][1]}' + interval '1 microsecond' a`)).a,
        true
      );
      await c.query("SAVEPOINT s");
      // the override raised twice before any write (restarted at 899850, then at 899900, before reaching either): the
      // progress stays at 899773 and the first height processed past it records one gap, [899774, 899899]
      await c.query(`INSERT INTO ${S}.blocks VALUES (899800, '2026-09-02 10:00'), (899900, '2026-09-02 11:00'),
                                                    (899901, '2026-09-02 11:01')`);
      // a slash-only height in the window (10:00) is not covered while the override skips
      const slash = await range("2026-09-02T09:45:00Z", "2026-09-02T10:15:00Z");
      assert.deepEqual([slash.covered, slash.rows, slash.burn], [[null, null], 0, null]);
      await step(899900, 899900);
      await step(899901, 899900);
      assert.deepEqual(await gapRows(), [{ f: 899774, t: 899899 }]);
      assert.deepEqual((await range("2026-09-02T09:45:00Z", "2026-09-02T10:15:00Z")).covered, [null, null]);
      assert.deepEqual(await plan(), { top: 899712, create: true });
      await c.query("ROLLBACK TO SAVEPOINT s");
      // START_BLOCK > 1 with an override, then the job: the indexer's money step started at 899753 (nothing below it
      // written), so a range before it is not covered and no gap is recorded (no progress to record from)
      await c.query(`DELETE FROM ${S}.money_progress; DELETE FROM ${S}.settlement_blocks WHERE height < 899753`);
      await step(899753, 899753);
      await step(899773, 899753);
      assert.deepEqual(await gapRows(), []);
      assert.deepEqual((await range("2026-09-01T00:00:00Z", "2026-09-03T00:00:00Z")).covered, [T(WRITES[2][1]), head]);
      assert.deepEqual((await range("2026-09-01T00:00:00Z", "2026-09-01T23:00:00Z")).covered, [null, null]);
      // the job starts below the lowest written height: its row is [1, 899752], which planGap accepts
      assert.deepEqual(await plan(), { top: 899752, create: true });
      await c.query(`INSERT INTO ${S}.settlement_gaps VALUES (1, 899752)`);
      assert.deepEqual(await plan(), { top: 899752, create: false });
      // it walks below the indexer's start, writing 899733 and lowering its row: covered from what it walked
      await c.query(`INSERT INTO ${S}.settlement_blocks (height, block_time, era, day, rollup_version)
                     VALUES (899733, '${WRITES[1][1]}', 'batched_vrd', '2026-09-01', 99);
                     UPDATE ${S}.settlement_gaps SET to_height = 899732;
                     UPDATE ${S}.money_progress SET from_height = least(from_height, 899733)`);
      assert.deepEqual((await range("2026-09-01T00:00:00Z", "2026-09-03T00:00:00Z")).covered, [T(WRITES[1][1]), head]);
      assert.deepEqual(await plan(), { top: 899732, create: false });
      // a restart of the indexer touches neither the job's row nor its progress
      await step(899773, 899753);
      assert.deepEqual(await gapRows(), [{ f: 1, t: 899732 }]);
      // the job finishes (writes 899713, deletes its row): covered from the first indexed block
      await c.query(`INSERT INTO ${S}.settlement_blocks (height, block_time, era, day, rollup_version)
                     VALUES (899713, '${WRITES[0][1]}', 'batched_vrd', '2026-09-01', 99);
                     DELETE FROM ${S}.settlement_gaps; UPDATE ${S}.money_progress SET from_height = 1`);
      assert.deepEqual((await range("2026-09-01T00:00:00Z", "2026-09-03T00:00:00Z")).covered, [first, head]);
      assert.deepEqual(await plan(), { top: 0, create: false });
      await c.query("ROLLBACK TO SAVEPOINT s");
      // no settlement ever (a localnet): the progress advances, so a range over indexed blocks is covered, and 0
      for (const t of OMITTED_TABLES.filter((x) => x !== "delegations" && x !== "money_progress")) await c.query(`DELETE FROM ${S}.${t}`);
      const none = await range("2026-09-01T00:00:00Z", "2026-09-03T00:00:00Z");
      assert.deepEqual([none.covered, none.rows, none.burn], [[first, head], 0, { burn_mint: 0 }]);
      const total = (await one(`SELECT ${S}.legacy_rewards_by_addresses_and_time($1, '2026-09-01', '2026-09-03')::jsonb->'data' d`, [
        [shareholder],
      ])).d;
      assert.equal(total, "0");
    } finally {
      await c.query("ROLLBACK");
    }
  });

  it("money_progress: seeded once from an existing database, override holes trimmed, nothing read past covered_to", async () => {
    const one = async (sql: string, params: unknown[] = []) => (await c.query(sql, params)).rows[0];
    const seed = async () => {
      await c.query(`DELETE FROM ${S}.money_progress`);
      await c.query(createSettlementTablesFn(S));
      return (await c.query(`SELECT from_height::int f, height::int h FROM ${S}.money_progress`)).rows;
    };
    await c.query("BEGIN");
    try {
      // seeded once: one above the history job's row
      await c.query(`INSERT INTO ${S}.settlement_gaps VALUES (1, 899650); INSERT INTO ${S}.blocks VALUES (899600, '2026-09-01 08:00')`);
      assert.deepEqual(await seed(), [{ f: 899651, h: 899773 }]);
      // a second start keeps the row it has
      await c.query(`UPDATE ${S}.money_progress SET height = 899800`);
      await c.query(createSettlementTablesFn(S));
      assert.deepEqual((await c.query(`SELECT height::int h FROM ${S}.money_progress`)).rows, [{ h: 899800 }]);
      // complete history (the lowest written settlement is the chain's first): the first indexed block
      await c.query(`DELETE FROM ${S}.settlement_gaps`);
      assert.deepEqual(await seed(), [{ f: 899600, h: 899773 }]);
      // the chain settled before the lowest written settlement, no job row: the lowest written settlement
      await c.query(`INSERT INTO ${S}.event_claim_settleds (id, block_id) VALUES ('1-0', 1)`);
      assert.deepEqual(await seed(), [{ f: 899713, h: 899773 }]);
      await c.query(`DELETE FROM ${S}.event_claim_settleds WHERE block_id = 1; DELETE FROM ${S}.blocks WHERE id = 899600;
                     UPDATE ${S}.money_progress SET from_height = 899713`);
      // an override hole the money step processes again (a rewind, or the override lowered): trimmed below the height,
      // deleted when it starts there; the history job's row is never touched
      await c.query(`INSERT INTO ${S}.settlement_gaps VALUES (1, 899700), (899774, 899899)`);
      await step(899800);
      assert.deepEqual(
        (await c.query(`SELECT from_height::int f, to_height::int t FROM ${S}.settlement_gaps ORDER BY 1`)).rows,
        [{ f: 1, t: 899700 }, { f: 899774, t: 899799 }]
      );
      await step(899774);
      assert.deepEqual(
        (await c.query(`SELECT from_height::int f, to_height::int t FROM ${S}.settlement_gaps ORDER BY 1`)).rows,
        [{ f: 1, t: 899700 }]
      );
      await c.query(`DELETE FROM ${S}.settlement_gaps`);
      // a rewind: the progress went back to 899753 and the rows of 899773 are still there until it is rewritten; they
      // are past covered_to, so nothing reads them, catalog or legacy_
      await c.query(`UPDATE ${S}.money_progress SET height = 899753`);
      const upTo = (end: string) =>
        one(`SELECT ${S}.get_income_json($1, '2026-09-01T00:00:00Z', $2)->'data' d,
                    ${S}.legacy_rewards_by_addresses_and_time($1, '2026-09-01', $3)::jsonb->'data' l`, [
          [shareholder],
          end,
          end.replace("T", " ").replace("Z", ""),
        ]);
      const all = await upTo("2026-09-03T00:00:00Z");
      const covered = await upTo("2026-09-02T00:00:00.000001Z");
      assert.deepEqual(all.d, covered.d);
      assert.equal(all.l, covered.l);
      const live = (await one(`SELECT ${S}.get_rewards_by_addresses_and_time($1, '2026-09-01', '2026-09-03')::text a`, [[shareholder]])).a;
      assert.notEqual(all.l, live);
    } finally {
      await c.query("ROLLBACK");
    }
  });

  it("the money step: a rewind then an override records the gap from where it really is; the job never walks processed heights", async () => {
    const plan = () => planGap(c as unknown as Parameters<typeof planGap>[0], { schema: S } as unknown as Parameters<typeof planGap>[1]);
    const skip = async (height: number) => {
      const { sql, bind } = recordMoneySkipCall(S, height);
      await c.query(sql, bind);
    };
    const rows = async () =>
      (await c.query(`SELECT from_height::int f, to_height::int t FROM ${S}.settlement_gaps ORDER BY 1`)).rows;
    await c.query("BEGIN");
    try {
      // processed up to 899773; the indexer rewinds to 899750 and runs on with POCKETDEX_MONEY_FROM_HEIGHT = 899900:
      // each skipped height pulls the progress back, so the gap starts right after 899750, not after 899773
      await skip(899751);
      await skip(899752);
      assert.equal((await one(`SELECT height::int h FROM ${S}.money_progress`)).h, 899750);
      await step(899900, 899900);
      assert.deepEqual(await rows(), [{ f: 899751, t: 899899 }]);
      // a skip that pulls the progress below from_height: the override row starts at from_height, the heights under
      // it stay the history job's
      await c.query(`TRUNCATE ${S}.settlement_gaps; UPDATE ${S}.money_progress SET height = 899773, from_height = 899760`);
      await skip(899751);
      await step(899900, 899900);
      assert.deepEqual(await rows(), [{ f: 899760, t: 899899 }]);
      // a second rewind below from_height and a higher override: the row that starts there grows, nothing is lost
      await skip(899751);
      await step(899950, 899950);
      assert.deepEqual(await rows(), [{ f: 899760, t: 899949 }]);
      // the progress went back past the 899753 and 899773 settlements, so they are not covered until rewritten
      await c.query(`DELETE FROM ${S}.settlement_gaps; UPDATE ${S}.money_progress SET height = 899773`);
      // the money step processed 899700 to 899712 without money (its first height 899700, the lowest written 899713):
      // the job plans [1, 899699], never over what the money step processed
      await c.query(`UPDATE ${S}.money_progress SET from_height = 899700`);
      assert.deepEqual(await plan(), { top: 899699, create: true });
      // no money_progress row: the job stops with a clear message
      await c.query(`DELETE FROM ${S}.money_progress`);
      await assert.rejects(plan(), /money_progress has no row: the indexer's money step creates it/);
    } finally {
      await c.query("ROLLBACK");
    }
  });

  it("GraphQL publishes every legacy_ function with what it replaces, and the start drops the money_* names", async () => {
    const { rows } = await c.query(
      `SELECT p.proname, obj_description(p.oid, 'pg_proc') tag FROM pg_proc p
       WHERE p.pronamespace = $1::regnamespace AND (p.proname LIKE '%legacy%' OR p.proname LIKE 'money\\_r%' OR p.proname LIKE 'money\\_m%')
       ORDER BY 1`,
      [S]
    );
    assert.equal(rows.length, 12);
    for (const r of rows) {
      if (String(r.proname).startsWith("_legacy_")) assert.equal(r.tag, "@omit");
      else
        assert.match(
          String(r.tag),
          /^Replaces get_[a-z_]+ \(get[A-Za-z]+\)\. Same arguments, the same ranges and date_trunc units accepted/,
          String(r.proname)
        );
    }
  });
});
