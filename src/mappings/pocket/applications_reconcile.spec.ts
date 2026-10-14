// Unit test: when reconcileApplications closes out an Unstaking application the chain no longer has, it also closes
// the application's open ApplicationGateway and ApplicationService rows, as the chain's RemoveApplication deletes them
// (mainnet pokt1xw3ky479… stayed delegated to its gateway after removal at 930,480). Fake SubQuery globals (logger,
// store) and a fake chain query client. Run with
//   yarn test:unit
/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-var-requires */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

type Row = Record<string, unknown> & { id: string };
const tables: Record<string, Array<Row>> = {};
const removed: Record<string, Array<string>> = {};
let chainApps: Array<{ address: string; stake: { amount: string; denom: string }; unstakeSessionEndHeight: number }> = [];

const globals = globalThis as Record<string, unknown>;
globals.logger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };
globals.store = {
  get: async (entity: string, id: string) => (tables[entity] || []).find((row) => row.id === id),
  getByField: async (entity: string, field: string, value: unknown, { offset }: { offset: number }) =>
    offset > 0 ? [] : (tables[entity] || []).filter((row) => row[field] === value),
  bulkCreate: async (entity: string, docs: Array<Row>) => {
    for (const doc of docs) {
      tables[entity] = (tables[entity] || []).filter((row) => row.id !== doc.id).concat({ ...doc });
    }
  },
  bulkRemove: async (entity: string, ids: Array<string>) => {
    (removed[entity] = removed[entity] || []).push(...ids);
    tables[entity] = (tables[entity] || []).filter((row) => !ids.includes(row.id));
  },
};

// the chain query client reconcileApplications reads, replaced before applications.ts loads it
const queryClientPath = require.resolve("../utils/query_client");
require.cache[queryClientPath] = {
  id: queryClientPath,
  filename: queryClientPath,
  loaded: true,
  exports: { __esModule: true, default: () => ({ application: { allApplications: async () => chainApps } }) },
} as unknown as NodeJS.Module;

const { reconcileApplications } = require("./applications") as typeof import("./applications");

const GONE = "pokt1xw3ky479rcx5plv0dkuyw388mdrjtquvx5eu9g";
const LIVE = "pokt1028n9gs60079nf8f98gd5r9tecps7sd8s9uv93";
const GW = "pokt1swj0eaxmj90a6yf2fa52m23wyzzz3lq8l8yjwj";

const app = (id: string, stakeStatus: string): Row => ({ id, stakeStatus, stakeAmount: BigInt(1), stakeDenom: "upokt" });

describe("reconcileApplications close-out", () => {
  it("closes the delegations and services of an application the chain removed, and only those", async () => {
    tables.Application = [app(GONE, "Unstaking"), app(LIVE, "Staked")];
    tables.ApplicationGateway = [
      { id: `${GONE}-${GW}`, applicationId: GONE, gatewayId: GW },
      { id: `${LIVE}-${GW}`, applicationId: LIVE, gatewayId: GW },
    ];
    tables.ApplicationService = [
      { id: `${GONE}-eth`, applicationId: GONE, serviceId: "eth" },
      { id: `${LIVE}-eth`, applicationId: LIVE, serviceId: "eth" },
    ];
    chainApps = [{ address: LIVE, stake: { amount: "5", denom: "upokt" }, unstakeSessionEndHeight: 0 }];

    await reconcileApplications(930480);

    assert.equal(tables.Application.find((row) => row.id === GONE)?.stakeStatus, "Unstaked");
    assert.deepEqual(removed.ApplicationGateway, [`${GONE}-${GW}`]);
    assert.deepEqual(removed.ApplicationService, [`${GONE}-eth`]);
    assert.deepEqual(tables.ApplicationGateway.map((row) => row.id), [`${LIVE}-${GW}`]);
  });
});
