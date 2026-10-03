/* eslint-disable @typescript-eslint/no-floating-promises */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { eraEnv } from "./job";

describe("history job era override", () => {
  const mainnet = { chainId: "pocket", latestHeight: 946558 };
  const localnet = { chainId: "pocket", latestHeight: 1200 };
  const set = { POCKETDEX_SETTLEMENT_ERA: "batched_vrd" };

  it("passes the environment through when nothing overrides the era", () => {
    assert.deepEqual(eraEnv({}, mainnet, false), {});
  });

  it("refuses POCKETDEX_SETTLEMENT_ERA unless the target is said to be, and looks like, a localnet", () => {
    assert.throws(() => eraEnv(set, mainnet, false), /would label every height with one era/);
    assert.throws(() => eraEnv(set, localnet, false), /pass --localnet/);
    assert.throws(() => eraEnv(set, mainnet, true), /chain pocket at height 946558: not a localnet/);
    assert.throws(() => eraEnv(set, { chainId: "pocket-lego-testnet", latestHeight: 10 }, true), /not a localnet/);
    assert.equal(eraEnv(set, localnet, true), set);
  });

  it("refuses --localnet with no era to override", () => {
    assert.throws(() => eraEnv({}, localnet, true), /nothing to override/);
  });
});
