// Unit test: indexSupplier writes SupplierServiceConfig rows as the chain orders the block (BeginBlock
// activations, then txs) and keeps one open row per id, against fake SubQuery globals (logger, store).
// Run with
//   yarn test:unit
//
// The fake store keeps an in-memory versioned table per model. It does not evaluate Sequelize predicates:
// it reads only the shapes this handler sends and applies their meaning by hand, so a change to those
// shapes needs this fake changed too:
//   destroy  lower(_block_range) = height, optionally AND id IN (...)  -> drop the rows created at height
//   update   id IN (...) AND __block_range @> height                  -> close those open rows at height
//   bulkCreate                                                        -> insert at [height, null)
//   getByFields [field, "in", values]                                 -> the rows open at height
/* eslint-disable @typescript-eslint/no-floating-promises, @typescript-eslint/require-await, @typescript-eslint/no-var-requires */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CosmosEvent, CosmosMessage } from "@subql/types-cosmos";

type Row = Record<string, unknown> & { lo: number; hi: number | null };

const tables: Record<string, Array<Row>> = {};
let height = 0;

const openAt = (row: Row, block: number) => row.lo <= block && (row.hi === null || block < row.hi);

const sequelize = {
  fn: (fn: string, ...args: Array<unknown>) => ({ fn, args }),
  col: (col: string) => ({ col }),
  where: (left: unknown, right: unknown) => ({ left, right }),
  transaction: async (_: unknown, cb: (tx: unknown) => Promise<unknown>) => cb({}),
};

type IdIn = { id: Record<symbol, Array<string>> };

const model = (name: string) => {
  tables[name] = tables[name] || [];
  return {
    sequelize,
    destroy: async ({ where }: { where: Record<symbol, [unknown, IdIn]> }) => {
      const and = where[Symbol.for("and")];
      const ids = and ? and[1].id[Symbol.for("in")] : null;
      tables[name] = tables[name].filter(
        (row) => row.lo !== height || (ids !== null && !ids.includes(row.id as string))
      );
    },
    update: async (_: unknown, { where }: { where: IdIn }) => {
      const ids = where.id[Symbol.for("in")];
      for (const row of tables[name]) {
        if (ids.includes(row.id as string) && openAt(row, height)) row.hi = height;
      }
    },
    bulkCreate: async (docs: Array<Record<string, unknown>>) => {
      for (const { __block_range, ...doc } of docs) {
        const [lo, hi] = __block_range as [number, number | null];
        tables[name].push({ ...doc, lo: Number(lo), hi });
      }
    },
  };
};

const globals = globalThis as Record<string, unknown>;
globals.logger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };
globals.store = {
  context: { getHistoricalUnit: () => height, transaction: undefined },
  modelProvider: { getModel: (name: string) => ({ model: model(name) }) },
  getByFields: async (
    name: string,
    filter: Array<[string, string, Array<string>]>,
    { limit, offset }: { limit: number; offset: number }
  ) => {
    const [[field, , values]] = filter;
    return (tables[name] || [])
      .filter((row) => openAt(row, height) && values.includes(row[field] as string))
      .slice(offset, offset + limit)
      .map((row) => ({ ...row })); // bulkCreate overwrites lo/hi of a row saved again
  },
};

const { indexSupplier } = require("./suppliers") as typeof import("./suppliers");

const S1 = "pokt139eww6ul8dxcfvgp9z5xtnnhc2n30vnka6pm3p";
const S2 = "pokt1xgjlnqqmrmc7v2hp0sc6xx46lr7z4y6j406ue9";
const block = (h: number) => ({ block: { header: { height: h } } });

const stake = (h: number, operator: string, services: Array<string>, txIdx = 0): CosmosMessage =>
  ({
    idx: 0,
    block: block(h),
    tx: { hash: `STAKE${h}${operator}`, idx: txIdx, tx: { code: 0, events: [] } },
    msg: {
      typeUrl: "/pocket.supplier.MsgStakeSupplier",
      decodedMsg: {
        operatorAddress: operator,
        ownerAddress: operator,
        signer: operator,
        stake: { amount: "60000000000", denom: "upokt" },
        services: services.map((serviceId) => ({ serviceId, endpoints: [], revShare: [] })),
      },
    },
  } as unknown as CosmosMessage);

const unstake = (h: number, operator: string): CosmosMessage =>
  ({
    idx: 0,
    block: block(h),
    tx: { hash: `UNSTAKE${h}${operator}`, idx: 0, tx: { code: 0, events: [] } },
    msg: {
      typeUrl: "/pocket.supplier.MsgUnstakeSupplier",
      decodedMsg: { operatorAddress: operator, signer: operator },
    },
  } as unknown as CosmosMessage);

const activation = (h: number, idx: number, attributes: Array<{ key: string; value: string }>): CosmosEvent =>
  ({
    idx,
    kind: "finalize_block",
    block: block(h),
    event: {
      type: "pocket.supplier.EventSupplierServiceConfigActivated",
      attributes: [{ key: "activation_height", value: `"${h}"` }, ...attributes, { key: "mode", value: "BeginBlock" }],
    },
  } as unknown as CosmosEvent);

// Since v0.1.27: one event per service, as in block_results of mainnet 947061 and 947081.
const activations = (h: number, operator: string, services: Array<string>): Array<CosmosEvent> =>
  services.map((serviceId, i) =>
    activation(h, 100 + i, [
      { key: "operator_address", value: `"${operator}"` },
      { key: "service_id", value: `"${serviceId}"` },
    ])
  );

// Before v0.1.27: one event per supplier, carrying the supplier and no service_id.
const legacyActivation = (h: number, operator: string): CosmosEvent =>
  activation(h, 100, [{ key: "supplier", value: JSON.stringify({ operator_address: operator }) }]);

const index = async (h: number, msgs: Array<CosmosMessage>, events: Array<CosmosEvent>) => {
  height = h;
  const msgByType: Record<string, Array<CosmosMessage>> = {
    "/pocket.supplier.MsgUnstakeSupplier": [],
    "/pocket.migration.MsgClaimMorseSupplier": [],
    "/pocket.supplier.MsgStakeSupplier": [],
  };
  const eventByType: Record<string, Array<CosmosEvent>> = {
    "pocket.supplier.EventSupplierUnbondingBegin": [],
    "pocket.supplier.EventSupplierUnbondingEnd": [],
    "pocket.supplier.EventSupplierServiceConfigActivated": [],
    "pocket.tokenomics.EventSupplierSlashed": [],
  };
  for (const msg of msgs) msgByType[msg.msg.typeUrl].push(msg);
  for (const event of events) eventByType[event.event.type].push(event);
  await indexSupplier(msgByType as never, eventByType as never);
};

const configs = (operator: string) => (tables.SupplierServiceConfig || []).filter((row) => row.supplierId === operator);

// the configs open at the current height, as "<service>@<activatedAt>"
const open = (operator: string) =>
  configs(operator)
    .filter((row) => openAt(row, height))
    .map((row) => `${row.serviceId}@${row.activatedAtId ?? "-"}`)
    .sort();

// every row of one config, as [from, to, activatedAt]
const history = (operator: string, serviceId: string) =>
  configs(operator)
    .filter((row) => row.serviceId === serviceId)
    .map((row) => [row.lo, row.hi, row.activatedAtId === undefined ? null : Number(row.activatedAtId)]);

const reset = () => {
  for (const name of Object.keys(tables)) delete tables[name];
};

describe("indexSupplier service configs", () => {
  it("a stake in the block where the previous stake activates waits for its own activation (mainnet 947060/61/81)", async () => {
    reset();
    await index(947060, [stake(947060, S1, ["akash", "eth"])], []);

    // the BeginBlock activation of the 947060 stake, then a new stake in tx 0 of the same block
    await index(947061, [stake(947061, S1, ["akash", "eth"])], activations(947061, S1, ["akash", "eth"]));
    assert.deepEqual(open(S1), ["akash@-", "eth@-"]);

    // the activation of the 947061 stake, one session later
    await index(947081, [], activations(947081, S1, ["akash", "eth"]));
    assert.deepEqual(open(S1), ["akash@947081", "eth@947081"]);
    assert.deepEqual(history(S1, "akash"), [
      [947060, 947061, null],
      [947061, 947081, null],
      [947081, null, 947081],
    ]);
  });

  it("stake, activation, restake that changes services, activation, unstake", async () => {
    reset();
    await index(100, [stake(100, S1, ["akash", "eth"])], []);
    assert.deepEqual(open(S1), ["akash@-", "eth@-"]);

    await index(120, [], activations(120, S1, ["akash", "eth"]));
    assert.deepEqual(open(S1), ["akash@120", "eth@120"]);

    await index(130, [stake(130, S1, ["akash", "base"])], []);
    assert.deepEqual(open(S1), ["akash@-", "base@-"]);
    assert.deepEqual(history(S1, "eth"), [
      [100, 120, null],
      [120, 130, 120],
    ]);

    await index(140, [], activations(140, S1, ["akash", "base"]));
    assert.deepEqual(open(S1), ["akash@140", "base@140"]);

    // the unstake changes the supplier only
    await index(150, [unstake(150, S1)], []);
    assert.deepEqual(open(S1), ["akash@140", "base@140"]);
  });

  it("an activation carrying service_id activates that service only; one without it activates them all", async () => {
    reset();
    await index(100, [stake(100, S1, ["akash", "eth"])], []);

    await index(120, [], activations(120, S1, ["akash"]));
    assert.deepEqual(open(S1), ["akash@120", "eth@-"]);

    await index(140, [], [legacyActivation(140, S1)]);
    assert.deepEqual(open(S1), ["akash@120", "eth@140"]);
  });

  it("processing the same block twice leaves the same rows", async () => {
    reset();
    await index(190, [stake(190, S1, ["akash", "eth"])], []);

    // S1 activates and S2 stakes in the same block, so the block deletes and re-inserts S2's configs only
    const block200 = () => index(200, [stake(200, S2, ["akash"])], activations(200, S1, ["akash", "eth"]));
    await block200();
    const once = JSON.stringify([open(S1), open(S2), configs(S1).length, configs(S2).length]);
    await block200();

    assert.equal(JSON.stringify([open(S1), open(S2), configs(S1).length, configs(S2).length]), once);
    assert.deepEqual(open(S1), ["akash@200", "eth@200"]);
    assert.deepEqual(open(S2), ["akash@-"]);
  });
});
