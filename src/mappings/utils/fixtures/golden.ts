// Test helpers over the golden fixtures. params_golden.json holds real mainnet
// Query/Params ABCI responses of the 17 modules and the same params read
// independently from the chain REST, both as stored (`rest`, sanitized) and as
// the raw REST JSON (`json`), captured by
// .local/ab/params_patch/capture_fixtures.js from seed-three at the first height
// with state on the archive (172,519), just before v0.1.31 (635,505), the
// v0.1.34 grid promotion (831,001) and a current height.
import assert from "node:assert/strict";
import { BinaryWriter } from "@bufbuild/protobuf/wire";
import { AbciQuery, PARAM_MODULES, PARAM_NAMESPACES } from "../params_normalize";
import golden from "./params_golden.json";

type Golden = Record<
  string,
  Record<
    string,
    { abci: { value: string; height: number }; rest: Record<string, string>; json: Record<string, unknown> }
  >
>;
export const fixtures = golden as Golden;
export const HEIGHTS = Object.keys(fixtures).map(Number);
export const CURRENT = Math.max(...HEIGHTS);
export const MAINNET = "pocket";

const namespaceOf = (path: string) => PARAM_NAMESPACES.find((ns) => PARAM_MODULES[ns].path === path);

// Shared Params fields in proto order (field number = index + 1), all uint64.
const SHARED_FIELDS = [
  "num_blocks_per_session",
  "grace_period_end_offset_blocks",
  "claim_window_open_offset_blocks",
  "claim_window_close_offset_blocks",
  "proof_window_open_offset_blocks",
  "proof_window_close_offset_blocks",
  "supplier_unbonding_period_sessions",
  "application_unbonding_period_sessions",
  "compute_units_to_tokens_multiplier",
  "gateway_unbonding_period_sessions",
  "compute_unit_cost_granularity",
  "session_grid_anchor_height",
  "session_number_at_anchor",
];

// A shared Query/Params (or ParamsAtHeight) response carrying `values`.
export function sharedResponse(values: Record<string, string>): Uint8Array {
  const params = new BinaryWriter();
  SHARED_FIELDS.forEach((name, i) => params.uint32(((i + 1) << 3) | 0).uint64(values[name] ?? "0"));
  return new BinaryWriter().uint32(10).bytes(params.finish()).finish();
}

// id → value as the chain REST reports it at `height`, with changes (null deletes).
export function restState(height: number, changes: Record<string, string | null> = {}): Map<string, string> {
  const state = new Map<string, string>();
  for (const ns of PARAM_NAMESPACES) {
    for (const [key, value] of Object.entries(fixtures[height][ns].rest)) state.set(`${ns}-${key}`, value);
  }
  for (const [id, value] of Object.entries(changes)) {
    if (value === null) state.delete(id);
    else state.set(id, value);
  }
  return state;
}

export function sharedAt(height: number, changes: Record<string, string> = {}): Record<string, string> {
  return { ...fixtures[height].shared.rest, ...changes };
}

export interface FixtureChain {
  // per-module Query/Params overrides, given the fixture bytes
  override?: Record<string, (value: Uint8Array) => { value: Uint8Array; height: number }>;
  // shared Query/ParamsAtHeight answer
  paramsAtHeight?: Record<string, string>;
  // every path queried, in order
  queried?: Array<string>;
}

// The chain as the golden fixtures saw it at `height`.
export function fixtureQuery(height: number, chain: FixtureChain = {}): AbciQuery {
  return (path, h, data) => {
    assert.equal(h, height);
    chain.queried?.push(path);
    if (path === "/pocket.shared.Query/ParamsAtHeight") {
      assert.ok(chain.paramsAtHeight, "unexpected ParamsAtHeight query");
      assert.deepEqual(data, new BinaryWriter().uint32(8).int64(height).finish());
      return Promise.resolve({ value: sharedResponse(chain.paramsAtHeight), height });
    }
    const ns = namespaceOf(path);
    assert.ok(ns, `unexpected path ${path}`);
    const { height: answered, value } = fixtures[height][ns].abci;
    const bytes = new Uint8Array(Buffer.from(value, "base64"));
    const override = chain.override?.[ns];
    return Promise.resolve(override ? override(bytes) : { value: bytes, height: answered });
  };
}
