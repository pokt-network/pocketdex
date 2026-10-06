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
import { CATALOG_FUNCTIONS, createSettlementFunctionsFn } from "../../src/mappings/dbFunctions/settlement/functions";
import { createSettlementTablesFn } from "../../src/mappings/dbFunctions/settlement/schema";
import { createSettlementSmartTagsFn } from "../../src/mappings/dbFunctions/settlement/smartTags";
import { createSettlementWriterFn, writeSettlementCalls } from "../../src/mappings/dbFunctions/settlement/writer";
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
    // a settlement height before the first written one: the money tables do not cover what precedes it
    await c.query(`INSERT INTO ${S}.event_claim_settleds (id, block_id) VALUES ('1-0', 1)`);
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
          covered_to: Date.parse("2026-09-01T13:00:00Z"), gaps: [] }, fn);
        const covered = await call(fn, WRITES[0][1], "2026-09-01T13:00:00Z");
        assert.deepEqual(r.data, covered.data, fn);
      }
      assert.equal(String((await call(calls[0], "2026-08-31T00:00:00Z", "2026-09-01T13:00:00Z")).data), live.rows[0].a);
      // a range that ends before it: nothing to read, and the range says why (covered_from after requested_to)
      // (data null in every one: nothing was read, so no total, series, breakdown or service list reads as zero)
      for (const fn of calls) {
        const r = await call(fn, "2026-08-30T00:00:00Z", "2026-08-31T00:00:00Z");
        assert.ok((r.range.covered_from as number) > (r.range.requested_to as number), fn);
        assert.deepEqual([r.range.covered_from, r.range.covered_to], [first, Date.parse("2026-08-31T00:00:00Z")], fn);
        assert.equal(r.data, null, fn);
      }
      // an inverted range still answers as the live function (the zero object)
      const inverted = await call("legacy_mint_breakdown_between_dates($2, $3)", "2026-09-03T00:00:00Z", "2026-09-01T00:00:00Z");
      assert.deepEqual(inverted.data, { reimbursement: 0, inflation: 0, mint_burn: 0 });
      // a range past the latest indexed block: covered_to is that block; a NULL end matches nothing, as before
      const past = await call(calls[0], WRITES[0][1], "2026-09-05T00:00:00Z");
      assert.deepEqual([past.range.covered_from, past.range.covered_to], [first, head]);
      const open = await call(calls[0], WRITES[0][1], null);
      assert.deepEqual([open.range.requested_to, open.data], [null, 0]);
      // a settlement gap inside the range: listed (between the written settlements around it, whose blocks the
      // fixture lacks), and its heights read nothing
      await c.query(`INSERT INTO ${S}.settlement_gaps VALUES (899740, 899745)`);
      try {
        for (const fn of calls) {
          const r = await call(fn, "2026-09-01T00:00:00Z", "2026-09-03T00:00:00Z");
          assert.deepEqual(r.range.gaps, [[Date.parse(WRITES[1][1]), Date.parse(WRITES[2][1])]], fn);
          assert.deepEqual(r.range.covered_to, head, fn);
          // a range that ends before the gap does not list it
          assert.deepEqual((await call(fn, "2026-09-01T00:00:00Z", "2026-09-01T13:00:00Z")).range.gaps, [], fn);
        }
      } finally {
        await c.query(`DELETE FROM ${S}.settlement_gaps`);
      }
    } finally {
      await c.query(`DELETE FROM ${S}.event_claim_settleds WHERE block_id = 1`);
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
      // the chain settled before the first written settlement: the money tables cover from it on
      await c.query(`INSERT INTO ${S}.event_claim_settleds (id, block_id) VALUES ('1-0', 1)`);
      for (const [fn, args] of CALLS) {
        // a covered range: the same rows
        const covered = await run(fn, args, WRITES[0][1], "2026-09-03T00:00:00Z");
        assert.deepEqual(covered.rows, complete[fn], fn);
        assert.deepEqual(covered.range, { requested_from: first, requested_to: T("2026-09-03T00:00:00Z"),
          covered_from: first, covered_to: head, gaps: [] }, fn);
        // a range that starts before it: the rows of the covered part; without a bucket, bucket_start is the requested
        // range_start (covered_from says where the data starts)
        const partial = await run(fn, args, "2026-08-31T00:00:00Z", "2026-09-03T00:00:00Z");
        if (fn !== "money_coverage" && !ON_BLOCKS.includes(fn)) {
          assert.deepEqual(partial.rows, covered.rows, fn);
          assert.deepEqual(partial.starts, [T("2026-08-31T00:00:00Z")], fn);
        }
        assert.deepEqual([partial.range.requested_from, partial.range.covered_from], [T("2026-08-31T00:00:00Z"), first], fn);
        // a range that ends before it: no rows, and covered_from after requested_to says why
        const before = await run(fn, args, "2026-08-30T00:00:00Z", "2026-08-31T00:00:00Z");
        if (fn !== "money_coverage") assert.deepEqual(before.rows, [], fn);
        assert.deepEqual([before.range.covered_from, before.range.covered_to], [first, T("2026-08-31T00:00:00Z")], fn);
        // NULL bounds: open-ended, from the first written settlement to the latest indexed block
        const open = await run(fn, args, null, null);
        assert.deepEqual(open.range, { requested_from: null, requested_to: null, covered_from: first, covered_to: head,
          gaps: [] }, fn);
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
      const partial = await flows("2026-08-31T00:00:00Z", "2026-09-03T00:00:00Z");
      assert.deepEqual(partial.covered, [first, head]);
      assert.deepEqual(partial.gaps, [[null, first]]);
      assert.ok(partial.rows > 0);
      // a range inside the gap: nothing read, and the gap says why
      const before = await flows("2026-08-30T00:00:00Z", "2026-08-31T00:00:00Z");
      assert.deepEqual(
        [before.covered, before.gaps, before.rows, before.burn],
        [[first, Date.parse("2026-08-31T00:00:00Z")], [[null, first]], 0, null]
      );
      // a block after the last written settlement: with the writer caught up (no settlement there) it is covered
      await c.query(`INSERT INTO ${S}.blocks VALUES (899800, '2026-09-02 10:00')`);
      assert.deepEqual((await flows("2026-08-31T00:00:00Z", "2026-09-03T00:00:00Z")).covered, [
        first,
        Date.parse("2026-09-02T10:00:00Z"),
      ]);
      // the chain settled there and it is not written (a writer behind): covered up to the last written settlement
      await c.query(`INSERT INTO ${S}.event_claim_settleds (id, block_id) VALUES ('899800-0', 899800)`);
      assert.deepEqual((await flows("2026-08-31T00:00:00Z", "2026-09-03T00:00:00Z")).covered, [first, head]);
      const after = await flows("2026-09-02T09:00:00Z", "2026-09-03T00:00:00Z");
      assert.deepEqual([after.covered, after.rows, after.burn], [[Date.parse("2026-09-02T09:00:00Z"), head], 0, null]);
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
