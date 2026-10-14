// Unit test: a Morse recovery the authority sends inside a MsgExec (mainnet 99,504 to 650,357) writes its
// MsgRecoverMorseAccount and AuthzMsgExec rows and marks the Morse account claimed by that message, against fake
// SubQuery globals (logger, store). Run with
//   yarn test:unit
/* eslint-disable @typescript-eslint/no-floating-promises, @typescript-eslint/require-await, @typescript-eslint/no-var-requires */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CosmosMessage } from "@subql/types-cosmos";
import { MsgRecoverMorseAccount } from "../../client/pocket/migration/tx";

const created: Record<string, Array<Record<string, unknown>>> = {};
const updates: Array<{ values: Record<string, unknown>; where: Record<string, unknown> }> = [];

const globals = globalThis as Record<string, unknown>;
globals.logger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };
globals.store = {
  context: { getHistoricalUnit: () => 99504, transaction: undefined },
  bulkCreate: async (name: string, docs: Array<Record<string, unknown>>) => {
    (created[name] = created[name] || []).push(...docs);
  },
  modelProvider: {
    getModel: () => ({
      model: {
        update: async (values: Record<string, unknown>, { where }: { where: Record<string, unknown> }) => {
          updates.push({ values, where });
          return [1];
        },
      },
    }),
  },
};

const { handleAuthzExec } = require("./exec") as typeof import("./exec");

const AUTHORITY = "pokt10d07y265gmmuvt4z0w9aw880jnsr700j8yv32t";
const DEST = "pokt1sxn75fkfq042kusru0a5dwytw9hasqfvyk7qx4";
const MORSE = "3C7A0C26B00774D499639EA067E2575883988F12";
const HASH = "BCF5E3D17D4BFC7EBF7FA85CBF118A0971183078E6A9A97CA9DB535CC6572F7C";

// tx BCF5E3D1… of mainnet 99,504: one MsgExec carrying one MsgRecoverMorseAccount; the event's coin is a JSON
// object, as before poktroll v0.1.27
const recoveryExec = (): CosmosMessage => {
  const bytes = MsgRecoverMorseAccount.encode({
    authority: AUTHORITY,
    shannonDestAddress: DEST,
    morseSrcAddress: MORSE,
  }).finish();
  return {
    idx: 0,
    block: { block: { header: { height: 99504 } } },
    tx: {
      hash: HASH,
      tx: {
        code: 0,
        events: [
          {
            type: "pocket.migration.EventMorseAccountRecovered",
            attributes: [
              { key: "morse_src_address", value: `"${MORSE}"` },
              { key: "recovered_balance", value: '{"denom":"upokt","amount":"146840000"}' },
              { key: "session_end_height", value: '"99505"' },
              { key: "shannon_dest_address", value: `"${DEST}"` },
              { key: "authz_msg_index", value: "0" },
              { key: "msg_index", value: "0" },
            ],
          },
        ],
      },
    },
    msg: {
      typeUrl: "/cosmos.authz.v1beta1.MsgExec",
      decodedMsg: {
        grantee: "pokt18808wvw0h4t450t06uvauny8lvscsxjfyua7vh",
        msgs: [{ typeUrl: "/pocket.migration.MsgRecoverMorseAccount", value: { ...bytes } }],
      },
    },
  } as unknown as CosmosMessage;
};

describe("handleAuthzExec Morse recovery", () => {
  it("writes the recovery, its AuthzMsgExec row and the account's claim", async () => {
    await handleAuthzExec([recoveryExec()] as never);

    assert.deepEqual(
      (created.MsgRecoverMorseAccount || []).map((row) => [
        row.id, row.authorityId, row.shannonDestAddressId, row.morseSrcAddress,
        String(row.recoveredBalanceAmount), row.recoveredBalanceDenom, row.isAdmin,
      ]),
      [[`${HASH}-0`, AUTHORITY, DEST, MORSE.toLowerCase(), "146840000", "upokt", false]]
    );
    assert.deepEqual(
      (created.AuthzMsgExec || []).map((row) => [row.id, row.authzExecId]),
      [[`${HASH}-0-0`, `${HASH}-0`]]
    );
    assert.deepEqual(
      updates.map(({ values, where }) => [where.id, values.claimed, values.shannon_dest_address, values.claimed_msg_id]),
      [[MORSE.toLowerCase(), true, DEST, `${HASH}-0`]]
    );
  });
});
