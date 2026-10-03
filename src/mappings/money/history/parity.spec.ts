// The history job and the indexer must read the same events from one block. The indexer gets them through cosmjs
// (comet38 Responses.decodeBlockResults, then stargate fromTendermintEvent, as SubQuery's wrapBlockBeginAndEndEvents
// does: vendor/subql-cosmos/packages/node/src/utils/cosmos.ts) and keeps the FinalizeBlock ones (write.ts
// finalizeBlockEvents); the job parses the RPC JSON itself (chain.ts parseBlockResults). Both are run here on a full
// beta block_results (batched_vrd, height 400,983, every finalize-block event kept in its position).
/* eslint-disable @typescript-eslint/no-floating-promises, @typescript-eslint/no-var-requires */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import * as zlib from "node:zlib";
import { CosmosBlock, CosmosEventKind } from "@subql/types-cosmos";
import { buildSettlementPayload } from "../payload";
import { parseBlockResults } from "./chain";

const globals = globalThis as Record<string, unknown>;
globals.logger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };
globals.store = {};
const { finalizeBlockEvents } = require("../write") as typeof import("../write");
const { Responses } = require("@cosmjs/tendermint-rpc/build/comet38/adaptor/responses") as {
  Responses: { decodeBlockResults(r: unknown): { finalizeBlockEvents: unknown[] } };
};
const { fromTendermintEvent } = require("@cosmjs/stargate") as { fromTendermintEvent(e: unknown): unknown };

const FIXTURE = path.join(__dirname, "../../../../test/money/fixtures/block_results_beta_400983.json.gz");

describe("history job and indexer read the same block", () => {
  const buf = zlib.gunzipSync(fs.readFileSync(FIXTURE));
  const decoded = Responses.decodeBlockResults(JSON.parse(buf.toString("utf8")));
  const block = {
    events: decoded.finalizeBlockEvents.map((e) => ({
      event: fromTendermintEvent(e),
      kind: CosmosEventKind.FinalizeBlock,
    })),
  } as unknown as CosmosBlock;

  for (const withBank of [false, true]) {
    it(`gives the same events in the same positions${withBank ? " with the bank events" : ""}`, () => {
      const indexer = finalizeBlockEvents(block, withBank);
      const job = parseBlockResults(buf, withBank);
      assert.equal(job.height, 400983);
      assert.equal(job.events.length, 146);
      assert.deepEqual(job.events, indexer);
      assert.deepEqual(parseBlockResults(buf, withBank, { chunkBytes: 4096, plainMax: 0 }), job);
    });
  }

  it("builds the same payload from either", () => {
    const ts = new Date("2026-01-01T00:00:00.000Z");
    const job = buildSettlementPayload(400983, ts, "batched_vrd", parseBlockResults(buf, false).events);
    const indexer = buildSettlementPayload(400983, ts, "batched_vrd", finalizeBlockEvents(block, false));
    assert.ok(job);
    assert.equal(job.claims.length, 12);
    assert.equal(job.vrd.length, 2);
    assert.deepEqual(job, indexer);
  });
});
