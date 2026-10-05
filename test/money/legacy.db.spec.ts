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
import { createSettlementFunctionsFn } from "../../src/mappings/dbFunctions/settlement/functions";
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
    await c.query(`DROP SCHEMA IF EXISTS ${S} CASCADE; CREATE SCHEMA ${S};`);
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
        LANGUAGE sql AS 'SELECT 0';`);
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
    await c.query(`DROP SCHEMA IF EXISTS ${S} CASCADE`);
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
  const both = async (live: string, legacy: string, args: unknown[]) => {
    const r = (await c.query(`SELECT (${S}.${live})::text l, (${S}.${legacy})::text n`, args)).rows[0];
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
    ).rows[0].j as unknown as Array<Record<string, string | number>>;
    assert.deepEqual(
      j.find((x) => x.service_id === "idle-service"),
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
        // the claim columns: the claims of the suppliers that paid the addresses, each once
        const paying = (
          await c.query(
            `SELECT array_agg(DISTINCT supplier_id) s FROM ${S}.shareholder_payouts sp JOIN ${S}.settlement_blocks sb USING (height)
                         WHERE recipient_id = ANY($1) AND sb.block_time BETWEEN $2 AND $3`,
            [addrs, s, e]
          )
        ).rows[0].s as unknown as string[];
        const once = sorted(
          (
            await c.query(`SELECT ${S}.get_rewards_by_suppliers_and_time_group_by_service($1, $2, $3)::text j`, [
              paying,
              s,
              e,
            ])
          ).rows[0].j
        ) as unknown as Row[];
        const cols = ["relays", "estimated_relays", "computed_units", "estimated_computed_units", "gross_rewards"];
        const pick = (rows: Row[]) =>
          Object.fromEntries(rows.map((x) => [x.service_id, cols.map((k) => String(x[k]))]));
        assert.deepEqual(
          Object.fromEntries(Object.entries(pick(n)).filter(([, v]) => v.some((x) => x !== "0"))),
          Object.fromEntries(Object.entries(pick(once)).filter(([sv, v]) => sv in pick(n) && v.some((x) => x !== "0")))
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

  it("every legacy_ function raises on a range the money tables do not cover, where the live one answers", async () => {
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
      for (const call of calls) {
        await assert.rejects(
          c.query(`SELECT ${S}.${call}, $1::text[]`, [[shareholder], "2026-08-31T00:00:00Z", "2026-09-01T13:00:00Z"]),
          /before the first written settlement/,
          call
        );
      }
      const live = await c.query(`SELECT ${S}.get_rewards_by_addresses_and_time($1, $2, $3)::text a`, [
        [shareholder],
        "2026-08-31T00:00:00Z",
        "2026-09-01T13:00:00Z",
      ]);
      assert.notEqual(live.rows[0].a, "0");
    } finally {
      await c.query(`DELETE FROM ${S}.event_claim_settleds WHERE block_id = 1`);
    }
  });

  it("GraphQL publishes every legacy_ function with what it replaces, and the start drops the money_* names", async () => {
    const { rows } = await c.query(
      `SELECT p.proname, obj_description(p.oid, 'pg_proc') tag FROM pg_proc p
       WHERE p.pronamespace = $1::regnamespace AND (p.proname LIKE '%legacy%' OR p.proname LIKE 'money\\_r%' OR p.proname LIKE 'money\\_m%')
       ORDER BY 1`,
      [S]
    );
    assert.equal(rows.length, 10);
    for (const r of rows) {
      if (r.proname === "_legacy_claims_by_service") assert.equal(r.tag, "@omit");
      else
        assert.match(
          String(r.tag),
          /^Replaces get_[a-z_]+ \(get[A-Za-z]+\)\. Same arguments and the same JSON/,
          String(r.proname)
        );
    }
  });
});
