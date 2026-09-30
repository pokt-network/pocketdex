// Unit test for the SubQuery adapter of reconcileParams (pocket/params.ts): the
// Param.getByFields read, the rows it writes (activeAt and blockId as BigInt)
// and bulkRemove, against fake SubQuery globals (logger, store, api) and the
// golden mainnet fixtures. Run with
//   yarn test:unit
/* eslint-disable @typescript-eslint/no-floating-promises, @typescript-eslint/require-await, @typescript-eslint/no-var-requires */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CURRENT, fixtureQuery, MAINNET, restState } from "../utils/fixtures/golden";

type Row = Record<string, unknown>;

const calls: { created: Array<Row>; removed: Array<string>; entities: Array<string> } = {
  created: [],
  entities: [],
  removed: [],
};
let stored = new Map<string, string>();

const globals = globalThis as Record<string, unknown>;
globals.logger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };
globals.store = {
  getByFields: async (entity: string, filter: Array<unknown>, options: { offset?: number; limit?: number }) => {
    calls.entities.push(entity);
    assert.deepEqual(filter, []);
    const rows = [...stored].map(([id, value]) => ({ id, value }));
    const offset = options.offset ?? 0;
    return rows.slice(offset, offset + (options.limit ?? rows.length));
  },
  bulkCreate: async (entity: string, rows: Array<Row>) => {
    calls.entities.push(entity);
    calls.created.push(...rows);
  },
  bulkRemove: async (entity: string, ids: Array<string>) => {
    calls.entities.push(entity);
    calls.removed.push(...ids);
  },
};
// The CometBFT client getQueryClient takes from the SubQuery api: answers from the fixtures.
const chain = fixtureQuery(CURRENT);
globals.api = {
  forceGetCometClient: () => ({
    abciQuery: async ({ data, height, path }: { path: string; data: Uint8Array; height: number }) => {
      const { height: answered, value } = await chain(path, height, data);
      return { code: 0, height: answered, value };
    },
  }),
};

const { reconcileParams } = require("./params") as typeof import("./params");

describe("reconcileParams (SubQuery adapter)", () => {
  it("reads the open Param rows, writes changed ones with BigInt heights and removes dropped keys", async () => {
    stored = restState(CURRENT, { "staking-max_validators": "21", "tokenomics-retired_param": "1" });
    await reconcileParams(CURRENT, MAINNET);
    assert.ok(calls.entities.every((e) => e === "Param"));
    assert.deepEqual(calls.created, [
      {
        id: "staking-max_validators",
        namespace: "staking",
        key: "max_validators",
        value: "22",
        activeAt: BigInt(CURRENT),
        blockId: BigInt(CURRENT),
      },
    ]);
    assert.deepEqual(calls.removed, ["tokenomics-retired_param"]);
  });
});
