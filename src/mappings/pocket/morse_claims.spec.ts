// Unit test: a tx carrying several Morse account or application claims stores each claim with the amounts of
// its own events (tagged with msg_index, as in block_results of mainnet 158648), not the last claim's, against
// fake SubQuery globals (logger, store). Run with
//   yarn test:unit
/* eslint-disable @typescript-eslint/no-floating-promises, @typescript-eslint/require-await, @typescript-eslint/no-var-requires */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CosmosMessage } from "@subql/types-cosmos";

const created: Record<string, Array<Record<string, unknown>>> = {};

const sequelize = {
  fn: (fn: string, ...args: Array<unknown>) => ({ fn, args }),
  col: (col: string) => ({ col }),
  where: (left: unknown, right: unknown) => ({ left, right }),
  transaction: async (_: unknown, cb: (tx: unknown) => Promise<unknown>) => cb({}),
};

const globals = globalThis as Record<string, unknown>;
globals.logger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };
globals.store = {
  context: { getHistoricalUnit: () => 150, transaction: undefined },
  get: async () => undefined,
  bulkCreate: async (name: string, docs: Array<Record<string, unknown>>) => {
    (created[name] = created[name] || []).push(...docs);
  },
  modelProvider: {
    getModel: (name: string) => ({
      model: {
        sequelize,
        update: async () => [0],
        destroy: async () => 0,
        bulkCreate: async (docs: Array<Record<string, unknown>>) => {
          (created[name] = created[name] || []).push(...docs);
        },
      },
    }),
  },
};

const { handleMsgClaimMorseAccount } = require("./migration") as typeof import("./migration");
const { handleMsgClaimMorseApplication } = require("./applications") as typeof import("./applications");

const A1 = "pokt1xgjlnqqmrmc7v2hp0sc6xx46lr7z4y6j406ue9";
const A2 = "pokt139eww6ul8dxcfvgp9z5xtnnhc2n30vnka6pm3p";

// one tx, one claim per destination; every claim's events carry its msg_index
const claimsTx = (
  typeUrl: string,
  eventType: string,
  claims: Array<[string, Array<{ key: string; value: string }>]>
): Array<CosmosMessage> => {
  const events = claims.map(([, attributes], i) => ({
    type: eventType,
    attributes: [...attributes, { key: "msg_index", value: `${i}` }],
  }));
  const tx = { hash: "MULTICLAIM", idx: 0, tx: { code: 0, events } };
  return claims.map(
    ([destination], i) =>
      ({
        idx: i,
        block: { block: { header: { height: 150 } } },
        tx,
        msg: {
          typeUrl,
          decodedMsg: {
            shannonDestAddress: destination,
            shannonSigningAddress: destination,
            morsePublicKey: new Uint8Array(32).fill(i + 1),
            morseSignature: new Uint8Array(64),
            serviceConfig: { serviceId: "eth" },
          },
        },
      } as unknown as CosmosMessage)
  );
};

const amounts = (name: string, field: string) =>
  (created[name] || []).map((row) => [row.id, String(row[field])]).sort();

describe("Morse claims in one tx", () => {
  it("each account claim stores its own balance", async () => {
    for (const name of Object.keys(created)) delete created[name];
    const msgs = claimsTx("/pocket.migration.MsgClaimMorseAccount", "pocket.migration.EventMorseAccountClaimed", [
      [A1, [{ key: "claimed_balance", value: '"111upokt"' }]],
      [A2, [{ key: "claimed_balance", value: '"222upokt"' }]],
    ]);
    await handleMsgClaimMorseAccount(msgs as never);
    assert.deepEqual(amounts("MsgClaimMorseAccount", "balanceAmount"), [
      ["MULTICLAIM-0", "111"],
      ["MULTICLAIM-1", "222"],
    ]);
  });

  it("each application claim stores its own stake and balance", async () => {
    for (const name of Object.keys(created)) delete created[name];
    const msgs = claimsTx(
      "/pocket.migration.MsgClaimMorseApplication",
      "pocket.migration.EventMorseApplicationClaimed",
      [
        [
          A1,
          [
            { key: "claimed_balance", value: '"111upokt"' },
            { key: "claimed_application_stake", value: '"1000upokt"' },
          ],
        ],
        [
          A2,
          [
            { key: "claimed_balance", value: '"222upokt"' },
            { key: "claimed_application_stake", value: '"2000upokt"' },
          ],
        ],
      ]
    );
    await handleMsgClaimMorseApplication(msgs as never);
    assert.deepEqual(amounts("MsgClaimMorseApplication", "balanceAmount"), [
      ["MULTICLAIM-0", "111"],
      ["MULTICLAIM-1", "222"],
    ]);
    assert.deepEqual(amounts("MsgClaimMorseApplication", "stakeAmount"), [
      ["MULTICLAIM-0", "1000"],
      ["MULTICLAIM-1", "2000"],
    ]);
    assert.deepEqual(amounts("Application", "stakeAmount"), [
      [A2, "2000"],
      [A1, "1000"],
    ]);
  });
});
