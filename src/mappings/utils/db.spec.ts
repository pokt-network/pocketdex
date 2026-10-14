// Unit test: optimizedBulkCreate and rawBulkInsert write only through the block transaction, one query at a time,
// and refuse to write without it, against fake SubQuery globals (logger, store). A write in its own transaction
// commits before the block does, so readers saw half-written settlement blocks (mainnet 964793). Run with
//   yarn test:unit
//
// The fake sequelize has no transaction(): opening a transaction of its own fails the test.
/* eslint-disable @typescript-eslint/no-floating-promises, @typescript-eslint/no-var-requires */
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

const BLOCK_TX = { block: "transaction" };
const HEIGHT = 964793;

type Write = { op: string; transaction: unknown; rows?: number; sql?: string };
let writes: Array<Write> = [];
let inFlight = 0;
let maxInFlight = 0;
let context: { getHistoricalUnit: () => number; transaction: unknown };

// Each write yields to the event loop before it ends, so writes issued together would overlap.
const write = async (entry: Write) => {
  inFlight++;
  maxInFlight = Math.max(maxInFlight, inFlight);
  await new Promise((resolve) => setImmediate(resolve));
  inFlight--;
  writes.push(entry);
};

const sequelize = {
  fn: (fn: string, ...args: Array<unknown>) => ({ fn, args }),
  col: (col: string) => ({ col }),
  where: (left: unknown, right: unknown) => ({ left, right }),
  query: (sql: string, { transaction }: { transaction?: unknown }) =>
    write({ op: sql.split(" ")[0], transaction, sql }),
};

const model = {
  sequelize,
  destroy: ({ transaction }: { transaction?: unknown }) => write({ op: "destroy", transaction }),
  bulkCreate: (docs: Array<unknown>, { transaction }: { transaction?: unknown }) =>
    write({ op: "bulkCreate", transaction, rows: docs.length }),
};

const globals = globalThis as Record<string, unknown>;
globals.logger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };
globals.store = {
  get context() {
    return context;
  },
  modelProvider: { getModel: () => ({ model }) },
};

process.env.POCKETDEX_DB_BATCH_SIZE = "2";
const { optimizedBulkCreate, rawBulkInsert } = require("./db") as typeof import("./db");

const docs = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `doc-${i}` }));
const rawArgs = (n: number) => ({
  table: "s.mod_to_acct_transfers",
  columns: ["id", "block_id"],
  rows: Array.from({ length: n }, (_, i) => `('t-${i}', ${HEIGHT})`),
  conflictCol: "id",
  blockId: HEIGHT,
});

describe("block writes", () => {
  beforeEach(() => {
    writes = [];
    inFlight = 0;
    maxInFlight = 0;
    context = { getHistoricalUnit: () => HEIGHT, transaction: BLOCK_TX };
  });

  for (const removeBy of ["block_id", "block_range"] as const) {
    it(`optimizedBulkCreate (${removeBy}) deletes and inserts in the block transaction, one batch at a time`, async () => {
      await optimizedBulkCreate("EventClaimSettled", docs(5), removeBy);
      assert.deepEqual(
        writes.map(({ op, rows }) => [op, rows]),
        [
          ["destroy", undefined],
          ["bulkCreate", 2],
          ["bulkCreate", 2],
          ["bulkCreate", 1],
        ]
      );
      for (const { op, transaction } of writes) {
        assert.equal(transaction, BLOCK_TX, `${op} outside the block transaction`);
      }
      assert.equal(maxInFlight, 1);
    });
  }

  it("optimizedBulkCreate (omit) inserts in the block transaction without deleting", async () => {
    await optimizedBulkCreate("Supplier", docs(3), "omit");
    assert.deepEqual(
      writes.map(({ op, transaction }) => [op, transaction]),
      [
        ["bulkCreate", BLOCK_TX],
        ["bulkCreate", BLOCK_TX],
      ]
    );
  });

  it("rawBulkInsert deletes the block's rows and inserts them in the block transaction, one batch at a time", async () => {
    await rawBulkInsert(rawArgs(5));
    assert.deepEqual(
      writes.map(({ op }) => op),
      ["DELETE", "INSERT", "INSERT", "INSERT"]
    );
    assert.match(
      writes[0].sql as string,
      new RegExp(`^DELETE FROM s.mod_to_acct_transfers WHERE block_id = ${HEIGHT}$`)
    );
    for (const { op, transaction } of writes) {
      assert.equal(transaction, BLOCK_TX, `${op} outside the block transaction`);
    }
    assert.equal(maxInFlight, 1);
  });

  it("both refuse to write without the block transaction (--enable-cache=true)", async () => {
    context.transaction = undefined;
    await assert.rejects(optimizedBulkCreate("Event", docs(1), "block_id"), /no block transaction/);
    await assert.rejects(rawBulkInsert(rawArgs(1)), /no block transaction/);
    assert.deepEqual(writes, []);
  });

  it("nothing to write needs no transaction", async () => {
    context.transaction = undefined;
    await optimizedBulkCreate("Event", [], "block_id");
    await rawBulkInsert(rawArgs(0));
    assert.deepEqual(writes, []);
  });
});
