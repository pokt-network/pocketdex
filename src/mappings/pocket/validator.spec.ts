// Unit test: reconcileValidators and handleModuleAccounts fail the block when the
// chain read fails, instead of logging and returning, against fake SubQuery
// globals (logger, store, api). Run with
//   yarn test:unit
/* eslint-disable @typescript-eslint/no-floating-promises, @typescript-eslint/require-await, @typescript-eslint/no-var-requires */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CosmosBlock } from "@subql/types-cosmos";

const storeCalls: Array<string> = [];
let abciCalls = 0;
let abciError = "";

const globals = globalThis as Record<string, unknown>;
globals.logger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };
globals.store = new Proxy(
  {},
  {
    get: (_, method: string) => async () => {
      storeCalls.push(method);
      return [];
    },
  }
);
globals.api = {
  forceGetCometClient: () => ({
    abciQuery: async ({ height }: { height: number }) => {
      abciCalls++;
      if (abciError === "code") {
        return { code: 26, log: `height ${height} is not available`, height: 0, value: new Uint8Array() };
      }
      throw new Error(abciError);
    },
  }),
};

const { reconcileValidators } = require("./validator") as typeof import("./validator");
const { handleModuleAccounts } = require("../bank/moduleAccounts") as typeof import("../bank/moduleAccounts");

const reset = (error: string) => {
  storeCalls.length = 0;
  abciCalls = 0;
  abciError = error;
};

describe("chain reads fail the block", () => {
  it("reconcileValidators throws on an unavailable height, after one query, and writes nothing", async () => {
    reset("code");
    await assert.rejects(reconcileValidators(5), /Query failed with \(26\): height 5 is not available/);
    assert.equal(abciCalls, 1);
    assert.deepEqual(storeCalls, []);
  });

  it("reconcileValidators throws after the transport's 3 attempts", async () => {
    reset("socket hang up");
    await assert.rejects(reconcileValidators(5), /failed \(attempt 3 of 3\): socket hang up/);
    assert.equal(abciCalls, 3);
    assert.deepEqual(storeCalls, []);
  });

  it("handleModuleAccounts throws after the transport's 3 attempts, with no outer retry", async () => {
    reset("socket hang up");
    const block = { header: { height: 5 }, block: { header: { height: 5 } } } as unknown as CosmosBlock;
    await assert.rejects(handleModuleAccounts(block), /failed \(attempt 3 of 3\)/);
    assert.equal(abciCalls, 3);
    assert.deepEqual(storeCalls, []);
  });
});
