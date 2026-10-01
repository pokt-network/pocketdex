// Unit tests for the strict env parsing and the db.ts settings that use it. Run with
//   yarn test:unit
/* eslint-disable @typescript-eslint/no-floating-promises, @typescript-eslint/no-var-requires */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { positiveIntFromEnv } from "./env";

describe("positiveIntFromEnv", () => {
  it("uses the default when unset, empty or blank (entrypoints pass unset as empty)", () => {
    assert.equal(positiveIntFromEnv("X", undefined, 7), 7);
    assert.equal(positiveIntFromEnv("X", "", 7), 7);
    assert.equal(positiveIntFromEnv("X", "  ", 7), 7);
  });

  it("parses a positive integer and throws on anything else, naming the variable", () => {
    assert.equal(positiveIntFromEnv("X", "10000", 7), 10000);
    for (const bad of ["0", "-1", "1.5", "abc", "1e3x", "9007199254740993"]) {
      assert.throws(
        () => positiveIntFromEnv("POCKETDEX_DB_PAGE_LIMIT", bad, 7),
        /POCKETDEX_DB_PAGE_LIMIT must be a positive integer/
      );
    }
  });
});

describe("db.ts settings", () => {
  const logged: Array<string> = [];
  (globalThis as Record<string, unknown>).logger = {
    debug: () => undefined,
    info: (message: string) => logged.push(message),
    warn: () => undefined,
    error: () => undefined,
  };
  const dbPath = require.resolve("./db");
  const load = (env: Record<string, string | undefined>) => {
    const saved = { ...process.env };
    Object.assign(process.env, env);
    for (const [k, v] of Object.entries(env)) if (v === undefined) delete process.env[k];
    delete require.cache[dbPath];
    try {
      require("./db");
    } finally {
      process.env = saved;
    }
    return logged[logged.length - 1];
  };

  it("reads the POCKETDEX_DB_* variables (they used to be ignored)", () => {
    assert.equal(
      load({
        POCKETDEX_DB_PAGE_LIMIT: "1234",
        POCKETDEX_DB_BATCH_SIZE: "",
        POCKETDEX_DB_BULK_WRITE_CONCURRENCY: undefined,
      }),
      "[Global] PAGE_LIMIT=1234 BATCH_SIZE=5000 CONCURRENCY=5"
    );
  });

  it("fails at load on a bad value", () => {
    assert.throws(
      () => load({ POCKETDEX_DB_BATCH_SIZE: "lots" }),
      /POCKETDEX_DB_BATCH_SIZE must be a positive integer/
    );
  });
});
