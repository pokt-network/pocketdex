// Unit test: indexSupplier keeps one open SupplierServiceConfig row per id, against fake SubQuery globals
// (logger, store) backed by an in-memory versioned table that applies the same delete / close / insert
// operations the handler sends to Postgres. Run with
//   yarn test:unit
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

const model = (name: string) => {
  tables[name] = tables[name] || [];
  return {
    sequelize,
    // removeRecords: rows created at this block
    destroy: async () => {
      tables[name] = tables[name].filter((row) => row.lo !== height);
    },
    // close the open rows of these ids at this block
    update: async (_: unknown, { where }: { where: { id: Record<symbol, Array<string>> } }) => {
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

const OPERATOR = "pokt139eww6ul8dxcfvgp9z5xtnnhc2n30vnka6pm3p";
const block = (h: number) => ({ block: { header: { height: h } } });

const stake = (h: number, services: Array<string>): CosmosMessage =>
  ({
    idx: 0,
    block: block(h),
    tx: { hash: `STAKE${h}`, idx: 0, tx: { code: 0, events: [] } },
    msg: {
      typeUrl: "/pocket.supplier.MsgStakeSupplier",
      decodedMsg: {
        operatorAddress: OPERATOR,
        ownerAddress: OPERATOR,
        signer: OPERATOR,
        stake: { amount: "60000000000", denom: "upokt" },
        services: services.map((serviceId) => ({ serviceId, endpoints: [], revShare: [] })),
      },
    },
  }) as unknown as CosmosMessage;

const unstake = (h: number): CosmosMessage =>
  ({
    idx: 0,
    block: block(h),
    tx: { hash: `UNSTAKE${h}`, idx: 0, tx: { code: 0, events: [] } },
    msg: {
      typeUrl: "/pocket.supplier.MsgUnstakeSupplier",
      decodedMsg: { operatorAddress: OPERATOR, signer: OPERATOR },
    },
  }) as unknown as CosmosMessage;

// EventSupplierServiceConfigActivated as the chain emits it: one per service, in finalize_block_events
// with mode=BeginBlock (block_results of mainnet 947061 and 947081).
const activations = (h: number, services: Array<string>): Array<CosmosEvent> =>
  services.map(
    (serviceId, i) =>
      ({
        idx: 100 + i,
        kind: "finalize_block",
        block: block(h),
        event: {
          type: "pocket.supplier.EventSupplierServiceConfigActivated",
          attributes: [
            { key: "activation_height", value: `"${h}"` },
            { key: "operator_address", value: `"${OPERATOR}"` },
            { key: "service_id", value: `"${serviceId}"` },
            { key: "mode", value: "BeginBlock" },
          ],
        },
      }) as unknown as CosmosEvent
  );

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

const configs = () => tables.SupplierServiceConfig || [];

// the open rows at the current height, as "<service>@<activatedAt>", plus the ids with more than one
const openConfigs = () => {
  const open = configs().filter((row) => openAt(row, height));
  const ids = open.map((row) => row.id as string);
  return {
    open: open.map((row) => `${row.serviceId}@${row.activatedAtId ?? "-"}`).sort(),
    duplicatedIds: ids.filter((id, i) => ids.indexOf(id) !== i),
  };
};

const reset = () => {
  for (const name of Object.keys(tables)) delete tables[name];
};

describe("indexSupplier service configs", () => {
  it("a stake in the block where the previous stake activates leaves one open row per config (mainnet 947060/61/81)", async () => {
    reset();
    await index(947060, [stake(947060, ["akash", "eth"])], []);
    // the activation of the 947060 stake and a new stake land in the same block
    await index(947061, [stake(947061, ["akash", "eth"])], activations(947061, ["akash", "eth"]));
    assert.deepEqual(openConfigs().duplicatedIds, []);

    // the activation of the 947061 stake, one session later: the configs are already activated
    await index(947081, [], activations(947081, ["akash", "eth"]));
    const { duplicatedIds, open } = openConfigs();
    assert.deepEqual(duplicatedIds, []);
    assert.equal(open.length, 2);
  });

  it("stake, activation, restake that changes services, activation, unstake", async () => {
    reset();
    await index(100, [stake(100, ["akash", "eth"])], []);
    assert.deepEqual(openConfigs(), { open: ["akash@-", "eth@-"], duplicatedIds: [] });

    await index(120, [], activations(120, ["akash", "eth"]));
    assert.deepEqual(openConfigs(), { open: ["akash@120", "eth@120"], duplicatedIds: [] });

    await index(130, [stake(130, ["akash", "base"])], []);
    assert.deepEqual(openConfigs(), { open: ["akash@-", "base@-"], duplicatedIds: [] });
    assert.deepEqual(
      configs().filter((row) => row.serviceId === "eth").map((row) => [row.lo, row.hi]),
      [[100, 120], [120, 130]]
    );

    await index(140, [], activations(140, ["akash", "base"]));
    assert.deepEqual(openConfigs(), { open: ["akash@140", "base@140"], duplicatedIds: [] });

    // the unstake changes the supplier only
    await index(150, [unstake(150)], []);
    assert.deepEqual(openConfigs(), { open: ["akash@140", "base@140"], duplicatedIds: [] });
  });
});
