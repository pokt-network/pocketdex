// Unit tests for the params normalization contract. Pure: run with
//   yarn test:unit
// node:test's describe/it return promises the runner itself awaits.
/* eslint-disable @typescript-eslint/no-floating-promises */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BinaryWriter } from "@bufbuild/protobuf/wire";
import {
  extractParamsBytes,
  JsonOptions,
  normalizeParams,
  paramKey,
} from "./params_normalize";

function asMap(ns: string, input: Uint8Array | Record<string, unknown>, options: JsonOptions = {}): Record<string, string> {
  return Object.fromEntries(normalizeParams(ns, input, options).params.map((p) => [p.key, p.value]));
}

describe("paramKey", () => {
  it("snake-cases without splitting digits", () => {
    assert.equal(paramKey("sigVerifyCostSecp256k1"), "sig_verify_cost_secp256k1");
    assert.equal(paramKey("sigVerifyCostEd25519"), "sig_verify_cost_ed25519");
    assert.equal(paramKey("sourceOwner"), "source_owner");
    assert.equal(paramKey("num_blocks_per_session"), "num_blocks_per_session");
  });
});

describe("normalizeParams from JSON", () => {
  it("maps every legacy key spelling to the proto field name", () => {
    const out = asMap("auth", {
      sig_verify_cost_secp_256_k_1: "1",
      sigVerifyCostEd25519: 590,
      max_memo_characters: "256",
    });
    assert.deepEqual(out, {
      max_memo_characters: "256",
      tx_sig_limit: "0",
      tx_size_cost_per_byte: "0",
      sig_verify_cost_ed25519: "590",
      sig_verify_cost_secp256k1: "1",
    });
  });

  it("renders LegacyDec as an 18-decimal string whatever the legacy row form", () => {
    const legacyRows = { legacyRows: true };
    const mint = asMap("mint", {
      goal_bonded: "670000000000000000", // atoms (old message decoder)
      inflation_max: "0.0", // genesis
      inflation_min: "0", // atoms zero
      inflation_rate_change: "0.13",
    }, legacyRows);
    assert.equal(mint.goal_bonded, "0.670000000000000000");
    assert.equal(mint.inflation_max, "0.000000000000000000");
    assert.equal(mint.inflation_min, "0.000000000000000000");
    assert.equal(mint.inflation_rate_change, "0.130000000000000000");

    const slashing = asMap("slashing", {
      min_signed_per_window: "MTAwMDAwMDAwMDAwMDAwMDAw", // base64 of ASCII atoms (old message decoder)
      slash_fraction_double_sign: "MA==",
      slash_fraction_downtime: "0.010000000000000000",
      downtime_jail_duration: { seconds: "600", nanos: 0 },
      signed_blocks_window: 200,
    }, legacyRows);
    assert.equal(slashing.min_signed_per_window, "0.100000000000000000");
    assert.equal(slashing.slash_fraction_double_sign, "0.000000000000000000");
    assert.equal(slashing.slash_fraction_downtime, "0.010000000000000000");
    assert.equal(slashing.downtime_jail_duration, "600s");
    assert.equal(slashing.signed_blocks_window, "200");
  });

  it("formats durations like gogoproto jsonpb", () => {
    const consensus = asMap("consensus", {
      evidence: { max_age_num_blocks: "100000", max_age_duration: "172800000000000", max_bytes: "1048576" },
    });
    assert.equal(consensus.evidence, '{"max_age_num_blocks":"100000","max_age_duration":"172800s","max_bytes":"1048576"}');
    assert.equal(consensus.block, "null");
    assert.equal(asMap("staking", { unbonding_time: "1.5s" }).unbonding_time, "1.500s");
  });

  it("fills defaults and snake-cases nested objects in declaration order", () => {
    const out = asMap("tokenomics", {
      mint_allocation_percentages: { dao: 0.1, supplier: 0.8, sourceOwner: 0.1 },
      proof_request_probability: 1,
    });
    assert.equal(out.mint_allocation_percentages, '{"dao":0.1,"proposer":0,"supplier":0.8,"source_owner":0.1,"application":0}');
    assert.equal(out.mint_ratio, "0");
    assert.equal(out.overservicing_bonus_multiplier, "0");
    assert.deepEqual(normalizeParams("tokenomics", { proof_request_probability: 1 }).unknown, ["proof_request_probability"]);
  });

  it("orders coin fields denom, amount and keeps numbers as numbers", () => {
    const out = asMap("proof", {
      proof_request_probability: "0.25",
      proof_missing_penalty: { amount: "0", denom: "upokt" },
    });
    assert.equal(out.proof_request_probability, "0.25");
    assert.equal(out.proof_missing_penalty, '{"denom":"upokt","amount":"0"}');
    assert.equal(out.proof_submission_fee, "null");
  });
});

describe("normalizeParams from JSON is strict", () => {
  const rejects = (ns: string, input: Record<string, unknown>, pattern: RegExp, options: JsonOptions = {}) =>
    assert.throws(() => normalizeParams(ns, input, options), pattern);

  it("accepts only true or false for a bool (\"true\"/\"false\" only from legacy rows)", () => {
    for (const bad of ["yes", 1, 0, "", {}]) rejects("bank", { default_send_enabled: bad }, /default_send_enabled: .* is not a valid bool/);
    rejects("bank", { default_send_enabled: "true" }, /is not a valid bool/);
    assert.equal(asMap("bank", { default_send_enabled: "true" }, { legacyRows: true }).default_send_enabled, "true");
    assert.equal(asMap("bank", { default_send_enabled: false }).default_send_enabled, "false");
  });

  it("refuses NaN, empty and fractional numbers", () => {
    for (const bad of ["abc", "", " ", {}, true, "NaN"]) rejects("proof", { proof_request_probability: bad }, /is not a valid double/);
    for (const bad of ["", "1.5", "abc", {}, true]) rejects("staking", { max_validators: bad }, /is not a valid uint32/);
    for (const bad of ["", " ", "1.5", "1e3", {}, true]) rejects("auth", { tx_sig_limit: bad }, /is not a valid uint64/);
    assert.equal(asMap("proof", { proof_request_probability: "0.25" }).proof_request_probability, "0.25");
  });

  it("refuses an undotted LegacyDec outside legacy rows", () => {
    rejects("mint", { goal_bonded: "670000000000000000" }, /has no decimal point/);
    rejects("slashing", { min_signed_per_window: "MTAwMDAwMDAwMDAwMDAwMDAw" }, /has no decimal point/);
    rejects("mint", { goal_bonded: { amount: "1" } }, /invalid LegacyDec/);
  });

  it("refuses an object where a string or a message is expected", () => {
    rejects("tokenomics", { dao_reward_address: { address: "pokt1" } }, /dao_reward_address: .* is not a valid string/);
    rejects("proof", { proof_missing_penalty: "10upokt" }, /proof_missing_penalty\.: expected an object/);
  });
});

describe("normalizeParams from protobuf", () => {
  function tokenomicsBytes(withUnknown: boolean): Uint8Array {
    const w = new BinaryWriter();
    w.uint32(10).fork().uint32(9).double(0.1).uint32(25).double(0.8).uint32(33).double(0.1).join();
    w.uint32(50).string("pokt1dao");
    w.uint32(57).double(0.000001);
    w.uint32(73).double(0.975);
    w.uint32(80).uint64(2);
    if (withUnknown) w.uint32(88).uint64(7);
    return w.finish();
  }

  it("decodes fields the generated client does not know and matches the REST shape", () => {
    const out = normalizeParams("tokenomics", tokenomicsBytes(false));
    assert.deepEqual(out.unknown, []);
    const rest = {
      dao_reward_address: "pokt1dao",
      mint_allocation_percentages: { dao: 0.1, proposer: 0, supplier: 0.8, source_owner: 0.1, application: 0 },
      global_inflation_per_claim: 0.000001,
      mint_equals_burn_claim_distribution: { dao: 0, proposer: 0, supplier: 0, source_owner: 0, application: 0 },
      mint_ratio: 0.975,
      overservicing_bonus_multiplier: "2",
    };
    assert.deepEqual(out.params, normalizeParams("tokenomics", rest).params);
    assert.equal(asMap("tokenomics", tokenomicsBytes(false)).global_inflation_per_claim, "0.000001");
  });

  it("reports unknown field numbers instead of dropping them silently", () => {
    assert.deepEqual(normalizeParams("tokenomics", tokenomicsBytes(true)).unknown, ["#11"]);
  });

  it("decodes LegacyDec atoms (string and bytes) and durations", () => {
    const mint = new BinaryWriter().uint32(10).string("upokt").uint32(42).string("670000000000000000").uint32(48).uint64(6311520).finish();
    const m = asMap("mint", mint);
    assert.equal(m.goal_bonded, "0.670000000000000000");
    assert.equal(m.inflation_max, "0.000000000000000000");
    assert.equal(m.blocks_per_year, "6311520");

    const slashing = new BinaryWriter()
      .uint32(8).int64(200)
      .uint32(18).bytes(Buffer.from("100000000000000000"))
      .uint32(26).fork().uint32(8).int64(600).join()
      .finish();
    const s = asMap("slashing", slashing);
    assert.equal(s.min_signed_per_window, "0.100000000000000000");
    assert.equal(s.downtime_jail_duration, "600s");
    assert.equal(s.slash_fraction_downtime, "0.000000000000000000");
  });

  it("extracts the Params message from the gov v1 response field 4", () => {
    const params = new BinaryWriter().uint32(120).bool(true).finish();
    const response = new BinaryWriter().uint32(34).bytes(params).finish();
    assert.equal(asMap("gov", extractParamsBytes("gov", response)).burn_vote_veto, "true");
  });

  it("throws on a response without the params field, and accepts an empty one", () => {
    assert.throws(() => extractParamsBytes("gov", new BinaryWriter().uint32(10).bytes(new Uint8Array([8, 1])).finish()), /no params field \(#4\)/);
    assert.throws(() => extractParamsBytes("shared", new Uint8Array()), /no params field \(#1\)/);
    assert.deepEqual(extractParamsBytes("shared", new BinaryWriter().uint32(10).bytes(new Uint8Array()).finish()), new Uint8Array());
  });
});

describe("decoder edge cases", () => {
  it("keeps uint64 above 2^53 exact", () => {
    const max = "18446744073709551615";
    const shared = new BinaryWriter().uint32(72).uint64(max).uint32(8).uint64("9007199254740993").finish();
    const out = asMap("shared", shared);
    assert.equal(out.compute_units_to_tokens_multiplier, max);
    assert.equal(out.num_blocks_per_session, "9007199254740993");
    assert.equal(asMap("shared", { compute_units_to_tokens_multiplier: max }).compute_units_to_tokens_multiplier, max);
  });

  it("decodes negative int64 and durations", () => {
    const block = new BinaryWriter().uint32(8).int64(22020096).uint32(16).int64(-1).finish();
    const consensus = new BinaryWriter().uint32(10).bytes(block).finish();
    assert.equal(asMap("consensus", consensus).block, '{"max_bytes":"22020096","max_gas":"-1"}');
    const slashing = new BinaryWriter().uint32(8).int64(-5).uint32(26).fork().uint32(8).int64(-2).uint32(16).int32(-500000000).join().finish();
    const s = asMap("slashing", slashing);
    assert.equal(s.signed_blocks_window, "-5");
    assert.equal(s.downtime_jail_duration, "-2.500s");
  });

  it("renders doubles the same from the wire and from the REST JSON, and re-normalizing is a fixed point", () => {
    for (const d of [0.975, 0.001, 1e-7, 0.1 + 0.2, 1, 0, 123456789.125]) {
      const wire = asMap("proof", new BinaryWriter().uint32(17).double(d).finish()).proof_request_probability;
      assert.equal(wire, String(d));
      assert.equal(asMap("proof", { proof_request_probability: d }).proof_request_probability, wire);
      assert.equal(asMap("proof", { proof_request_probability: JSON.parse(wire) }).proof_request_probability, wire);
    }
  });
});
