// Unit tests for the map-era bank segmentation. Run with
//   yarn test:unit
/* eslint-disable @typescript-eslint/no-floating-promises */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { APPLICATION_MODULE, segmentBank, SUPPLIER_MODULE, TOKENOMICS_MODULE } from "./bank";
import type { RawEvent } from "./payload";

const ev = (type: string, attrs: Record<string, string>): RawEvent => ({
  type,
  attributes: Object.entries({ mode: "EndBlock", ...attrs }).map(([key, value]) => ({ key, value })),
});
const coinbase = (n: number) => ev("coinbase", { minter: TOKENOMICS_MODULE, amount: `${n}upokt` });
const burn = (n: number) => ev("burn", { burner: APPLICATION_MODULE, amount: `${n}upokt` });
const transfer = (sender: string, recipient: string, n: number) =>
  ev("transfer", { sender, recipient, amount: `${n}upokt` });
const map = (o: Record<string, number>) => new Map(Object.entries(o).map(([k, v]) => [k, BigInt(v)]));

describe("segmentBank", () => {
  it("derives the module accounts from their names, as the chain does", () => {
    assert.equal(TOKENOMICS_MODULE, "pokt14cvnmzrt9cz4qdf5lhs0xn3u0a3gymla9cc6ft");
    assert.equal(SUPPLIER_MODULE, "pokt1j40dzzmn6cn9kxku7a5tjnud6hv37vesr5ccaa");
    assert.equal(APPLICATION_MODULE, "pokt1rl3gjgzexmplmds3tq3r3yk84zlwdl6djzgsvm");
  });

  // two claims: shareholder a twice (relay and global) in the first, then a slash burn
  const events = [
    coinbase(100),
    coinbase(1),
    transfer(TOKENOMICS_MODULE, SUPPLIER_MODULE, 70), // module → module: not a leg
    transfer(SUPPLIER_MODULE, "a", 70),
    transfer(TOKENOMICS_MODULE, "dao", 30),
    transfer(SUPPLIER_MODULE, "a", 1),
    transfer(TOKENOMICS_MODULE, "dao", 1),
    ev("transfer", { sender: TOKENOMICS_MODULE, recipient: "x", amount: "5upokt", mode: "BeginBlock" }),
    burn(100),
    coinbase(10),
    coinbase(1),
    transfer(SUPPLIER_MODULE, "b", 10),
    transfer(TOKENOMICS_MODULE, "dao", 1),
    burn(10),
    burn(1),
    { type: "pocket.tokenomics.EventSupplierSlashed", attributes: [] },
  ];
  const maps = [map({ a: 71, dao: 31 }), map({ b: 10, dao: 1 })];

  it("cuts the EndBlock bank events per claim, in claim order", () => {
    const out = segmentBank(1, events, maps, 1);
    assert.deepEqual(
      out.map((c) => [c.relayMint, c.globalMint, c.burn, c.legs.length]),
      [
        [BigInt(100), BigInt(1), BigInt(100), 4],
        [BigInt(10), BigInt(1), BigInt(10), 2],
      ]
    );
    assert.deepEqual(out[0].legs[0], { sender: SUPPLIER_MODULE, recipient: "a", amount: BigInt(70) });
  });

  it("stops on a transfer the claim's map does not have, a missing mint or burn, or extra items", () => {
    assert.throws(
      () => segmentBank(1, events, [map({ a: 70, dao: 31 }), maps[1]], 1),
      /exceeds its reward_distribution/
    );
    assert.throws(() => segmentBank(1, events.slice(1), maps, 1), /expected coinbase/);
    assert.throws(
      () =>
        segmentBank(
          1,
          events.filter((e, i) => i !== 8),
          maps,
          1
        ),
      /expected burn|expected coinbase/
    );
    assert.throws(() => segmentBank(1, events, maps, 0), /1 slash burns after the last claim, expected 0/);
    assert.throws(
      () => segmentBank(1, [...events, transfer(TOKENOMICS_MODULE, "z", 1)], maps, 1),
      /outside the settlement run/
    );
    assert.throws(
      () => segmentBank(1, [ev("coinbase", { amount: "1uatom" })], maps, 0),
      /amount is not an upokt amount/
    );
    assert.throws(() => segmentBank(1, [ev("coinbase", {})], maps, 0), /has no amount attribute/);
    assert.throws(
      () => segmentBank(1, [transfer(TOKENOMICS_MODULE, "z", 1), ...events], maps, 1),
      /outside the settlement run/
    );
  });

  it("skips other end blockers' bank events around the settlement run, and reads an empty amount as 0", () => {
    const unbonding = transfer(SUPPLIER_MODULE, "owner", 5000); // a supplier unbonding returning stake
    const govBurn = burn(7); // a burn not followed by EventSupplierSlashed
    const around = [
      unbonding,
      ...events.slice(0, -2),
      govBurn,
      ...events.slice(-2),
      transfer(APPLICATION_MODULE, "app", 9),
    ];
    assert.deepEqual(segmentBank(1, around, maps, 1), segmentBank(1, events, maps, 1));
    const zero = [ev("coinbase", { amount: "" }), ev("coinbase", { amount: "" }), ev("burn", { amount: "" })];
    assert.deepEqual(segmentBank(1, zero, [new Map()], 0), [
      { relayMint: BigInt(0), globalMint: BigInt(0), burn: BigInt(0), legs: [] },
    ]);
  });

  it("matches a claim with many legs per recipient", () => {
    const n = 20000;
    const many = [coinbase(n), coinbase(1)];
    for (let k = 0; k < n; k++) many.push(transfer(TOKENOMICS_MODULE, `s${k % 500}`, 1));
    many.push(burn(n));
    const need = new Map(Array.from({ length: 500 }, (_, k) => [`s${k}`, BigInt(n / 500)] as [string, bigint]));
    assert.equal(segmentBank(1, many, [need], 0)[0].legs.length, n);
  });
});
