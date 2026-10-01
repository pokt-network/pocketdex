// Canonical form of governance params, shared by the indexer (reconcileParams,
// genesis) and the offline history patch. PURE: no SubQuery globals, so it can
// be imported by a plain node script.
//
// The contract (what ends up in params.key / params.value):
//   key   = the proto field name in snake_case (the name the chain REST and the
//           genesis use): `sig_verify_cost_secp256k1`, never the lodash
//           `sig_verify_cost_secp_256_k_1`.
//   value = the JSON the chain REST (gogoproto jsonpb, OrigName + EmitDefaults)
//           returns for that field, stored like the column always did: a string
//           as-is, anything else as JSON text. So: 64-bit ints as strings, 32-bit
//           ints and doubles as numbers, LegacyDec as an 18-decimal string
//           ("0.670000000000000000") whatever its wire form (atoms string or
//           bytes), durations as "600s", nested objects with snake keys in proto
//           declaration order and every field present (defaults included).
//
// Why a hand-written schema instead of the generated ts-proto client: the
// generated client lags the chain (it has no overservicing_bonus_multiplier and
// no session_grid_anchor_height) and silently drops fields it does not know, and
// it maps uint64 and uint32 to the same JS number, so the REST shape cannot be
// recovered from its output. Here an unknown field is REPORTED instead of
// dropped (see NormalizedParams.unknown), and the readers turn it into an error
// (see unknownParamFieldsError): a chain upgrade that adds a param stops the
// indexer at that height instead of leaving a silently missing row.
//
// Field numbers and declaration order come from the protos the chain runs:
// poktroll a109dd0b (v0.1.35), cosmos-sdk v0.53.7, cometbft v0.38.21.
import { BinaryReader, BinaryWriter } from "@bufbuild/protobuf/wire";
import { sanitize } from "./json";

type ScalarType =
  | "string"
  | "bool"
  | "uint64"
  | "int64"
  | "uint32"
  | "int32"
  | "double"
  | "bytes"
  // cosmos LegacyDec stored as a string field holding the integer atoms (value × 1e18).
  | "legacyDec"
  // cosmos LegacyDec stored as a bytes field holding the ASCII atoms (slashing).
  | "legacyDecBytes"
  // google.protobuf.Duration
  | "duration";

interface Field {
  no: number;
  name: string;
  type: ScalarType | MessageSchema;
  repeated?: boolean;
  // gogoproto pointer field: jsonpb emits null when absent. Non-nullable
  // (gogoproto.nullable=false) message fields are emitted as their default.
  nullable?: boolean;
  // A nullable message that JSON input (genesis) may omit although the chain
  // always holds it, as its zero value: CometBFT completes the genesis
  // consensus params, and version/abci default to all zeros.
  jsonAbsentIsZero?: boolean;
}

type MessageSchema = Array<Field>;

const coin: MessageSchema = [
  { no: 1, name: "denom", type: "string" },
  { no: 2, name: "amount", type: "string" },
];

// tokenomics MintAllocationPercentages and MintEqualsBurnClaimDistribution share this shape.
const tokenomicsSplit: MessageSchema = [
  { no: 1, name: "dao", type: "double" },
  { no: 2, name: "proposer", type: "double" },
  { no: 3, name: "supplier", type: "double" },
  { no: 4, name: "source_owner", type: "double" },
  { no: 5, name: "application", type: "double" },
];

const schemas: Record<string, MessageSchema> = {
  application: [
    { no: 1, name: "max_delegated_gateways", type: "uint64" },
    { no: 2, name: "min_stake", type: coin, nullable: true },
  ],
  gateway: [
    { no: 1, name: "min_stake", type: coin, nullable: true },
  ],
  proof: [
    { no: 2, name: "proof_request_probability", type: "double" },
    { no: 3, name: "proof_requirement_threshold", type: coin, nullable: true },
    { no: 4, name: "proof_missing_penalty", type: coin, nullable: true },
    { no: 5, name: "proof_submission_fee", type: coin, nullable: true },
  ],
  service: [
    { no: 1, name: "add_service_fee", type: coin, nullable: true },
    { no: 2, name: "target_num_relays", type: "uint64" },
  ],
  session: [
    { no: 3, name: "num_suppliers_per_session", type: "uint64" },
  ],
  shared: [
    { no: 1, name: "num_blocks_per_session", type: "uint64" },
    { no: 2, name: "grace_period_end_offset_blocks", type: "uint64" },
    { no: 3, name: "claim_window_open_offset_blocks", type: "uint64" },
    { no: 4, name: "claim_window_close_offset_blocks", type: "uint64" },
    { no: 5, name: "proof_window_open_offset_blocks", type: "uint64" },
    { no: 6, name: "proof_window_close_offset_blocks", type: "uint64" },
    { no: 7, name: "supplier_unbonding_period_sessions", type: "uint64" },
    { no: 8, name: "application_unbonding_period_sessions", type: "uint64" },
    { no: 9, name: "compute_units_to_tokens_multiplier", type: "uint64" },
    { no: 10, name: "gateway_unbonding_period_sessions", type: "uint64" },
    { no: 11, name: "compute_unit_cost_granularity", type: "uint64" },
    { no: 12, name: "session_grid_anchor_height", type: "uint64" },
    { no: 13, name: "session_number_at_anchor", type: "uint64" },
  ],
  supplier: [
    { no: 1, name: "min_stake", type: coin, nullable: true },
    { no: 2, name: "staking_fee", type: coin, nullable: true },
  ],
  tokenomics: [
    { no: 6, name: "dao_reward_address", type: "string" },
    { no: 1, name: "mint_allocation_percentages", type: tokenomicsSplit },
    { no: 7, name: "global_inflation_per_claim", type: "double" },
    { no: 8, name: "mint_equals_burn_claim_distribution", type: tokenomicsSplit },
    { no: 9, name: "mint_ratio", type: "double" },
    { no: 10, name: "overservicing_bonus_multiplier", type: "uint64" },
  ],
  migration: [
    { no: 1, name: "waive_morse_claim_gas_fees", type: "bool" },
    { no: 2, name: "allow_morse_account_import_overwrite", type: "bool" },
    { no: 3, name: "morse_account_claiming_enabled", type: "bool" },
  ],
  auth: [
    { no: 1, name: "max_memo_characters", type: "uint64" },
    { no: 2, name: "tx_sig_limit", type: "uint64" },
    { no: 3, name: "tx_size_cost_per_byte", type: "uint64" },
    { no: 4, name: "sig_verify_cost_ed25519", type: "uint64" },
    { no: 5, name: "sig_verify_cost_secp256k1", type: "uint64" },
  ],
  bank: [
    {
      no: 1,
      name: "send_enabled",
      repeated: true,
      type: [
        { no: 1, name: "denom", type: "string" },
        { no: 2, name: "enabled", type: "bool" },
      ],
    },
    { no: 2, name: "default_send_enabled", type: "bool" },
  ],
  distribution: [
    { no: 1, name: "community_tax", type: "legacyDec" },
    { no: 2, name: "base_proposer_reward", type: "legacyDec" },
    { no: 3, name: "bonus_proposer_reward", type: "legacyDec" },
    { no: 4, name: "withdraw_addr_enabled", type: "bool" },
  ],
  mint: [
    { no: 1, name: "mint_denom", type: "string" },
    { no: 2, name: "inflation_rate_change", type: "legacyDec" },
    { no: 3, name: "inflation_max", type: "legacyDec" },
    { no: 4, name: "inflation_min", type: "legacyDec" },
    { no: 5, name: "goal_bonded", type: "legacyDec" },
    { no: 6, name: "blocks_per_year", type: "uint64" },
  ],
  slashing: [
    { no: 1, name: "signed_blocks_window", type: "int64" },
    { no: 2, name: "min_signed_per_window", type: "legacyDecBytes" },
    { no: 3, name: "downtime_jail_duration", type: "duration" },
    { no: 4, name: "slash_fraction_double_sign", type: "legacyDecBytes" },
    { no: 5, name: "slash_fraction_downtime", type: "legacyDecBytes" },
  ],
  staking: [
    { no: 1, name: "unbonding_time", type: "duration" },
    { no: 2, name: "max_validators", type: "uint32" },
    { no: 3, name: "max_entries", type: "uint32" },
    { no: 4, name: "historical_entries", type: "uint32" },
    { no: 5, name: "bond_denom", type: "string" },
    { no: 6, name: "min_commission_rate", type: "legacyDec" },
  ],
  // gov v1: the ratios are plain strings already in decimal form (cosmos.Dec scalar, not LegacyDec customtype).
  gov: [
    { no: 1, name: "min_deposit", type: coin, repeated: true },
    { no: 2, name: "max_deposit_period", type: "duration", nullable: true },
    { no: 3, name: "voting_period", type: "duration", nullable: true },
    { no: 4, name: "quorum", type: "string" },
    { no: 5, name: "threshold", type: "string" },
    { no: 6, name: "veto_threshold", type: "string" },
    { no: 7, name: "min_initial_deposit_ratio", type: "string" },
    { no: 8, name: "proposal_cancel_ratio", type: "string" },
    { no: 9, name: "proposal_cancel_dest", type: "string" },
    { no: 10, name: "expedited_voting_period", type: "duration", nullable: true },
    { no: 11, name: "expedited_threshold", type: "string" },
    { no: 12, name: "expedited_min_deposit", type: coin, repeated: true },
    { no: 13, name: "burn_vote_quorum", type: "bool" },
    { no: 14, name: "burn_proposal_deposit_prevote", type: "bool" },
    { no: 15, name: "burn_vote_veto", type: "bool" },
    { no: 16, name: "min_deposit_ratio", type: "string" },
  ],
  // cometbft.types.v1 ConsensusParams (v0.38)
  consensus: [
    {
      no: 1, name: "block", nullable: true, type: [
        { no: 1, name: "max_bytes", type: "int64" },
        { no: 2, name: "max_gas", type: "int64" },
      ],
    },
    {
      no: 2, name: "evidence", nullable: true, type: [
        { no: 1, name: "max_age_num_blocks", type: "int64" },
        { no: 2, name: "max_age_duration", type: "duration" },
        { no: 3, name: "max_bytes", type: "int64" },
      ],
    },
    {
      no: 3, name: "validator", nullable: true, type: [
        { no: 1, name: "pub_key_types", type: "string", repeated: true },
      ],
    },
    {
      no: 4, name: "version", nullable: true, jsonAbsentIsZero: true, type: [
        { no: 1, name: "app", type: "uint64" },
      ],
    },
    {
      no: 5, name: "abci", nullable: true, jsonAbsentIsZero: true, type: [
        { no: 1, name: "vote_extensions_enable_height", type: "int64" },
      ],
    },
  ],
};

// ABCI query path of each module's Params query and the field of its response
// that carries the Params message (gov v1 keeps the deprecated per-kind params
// in 1..3 and the full Params in 4).
export const PARAM_MODULES: Record<string, { path: string; responseField: number }> = {
  application: { path: "/pocket.application.Query/Params", responseField: 1 },
  gateway: { path: "/pocket.gateway.Query/Params", responseField: 1 },
  proof: { path: "/pocket.proof.Query/Params", responseField: 1 },
  service: { path: "/pocket.service.Query/Params", responseField: 1 },
  session: { path: "/pocket.session.Query/Params", responseField: 1 },
  shared: { path: "/pocket.shared.Query/Params", responseField: 1 },
  supplier: { path: "/pocket.supplier.Query/Params", responseField: 1 },
  tokenomics: { path: "/pocket.tokenomics.Query/Params", responseField: 1 },
  migration: { path: "/pocket.migration.Query/Params", responseField: 1 },
  auth: { path: "/cosmos.auth.v1beta1.Query/Params", responseField: 1 },
  bank: { path: "/cosmos.bank.v1beta1.Query/Params", responseField: 1 },
  distribution: { path: "/cosmos.distribution.v1beta1.Query/Params", responseField: 1 },
  mint: { path: "/cosmos.mint.v1beta1.Query/Params", responseField: 1 },
  slashing: { path: "/cosmos.slashing.v1beta1.Query/Params", responseField: 1 },
  staking: { path: "/cosmos.staking.v1beta1.Query/Params", responseField: 1 },
  gov: { path: "/cosmos.gov.v1.Query/Params", responseField: 4 },
  consensus: { path: "/cosmos.consensus.v1.Query/Params", responseField: 1 },
};

export const PARAM_NAMESPACES = Object.keys(PARAM_MODULES);

export interface NormalizedParam {
  key: string;
  value: string;
}

export interface NormalizedParams {
  params: Array<NormalizedParam>;
  // Fields present in the input that the schema does not know: "#<field number>"
  // for proto input, the input key for JSON input. Non-empty means the schema
  // here is behind the chain and a param is being dropped.
  unknown: Array<string>;
}

// paramFieldNames returns the keys a module's params are stored under: the
// top-level fields of its schema, in declaration order.
export function paramFieldNames(namespace: string): Array<string> {
  const schema = schemas[namespace];
  if (!schema) throw new Error(`unknown params namespace "${namespace}"`);
  return schema.map((f) => f.name);
}

// camelCase or snake_case → snake_case, WITHOUT splitting digits:
// sigVerifyCostSecp256k1 → sig_verify_cost_secp256k1, sourceOwner → source_owner.
export function paramKey(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

// Identity used to match an input key to a schema field. It tolerates every
// spelling the table has ever held (camelCase, snake_case, and lodash's
// digit-split `secp_256_k_1`).
export function compactKey(name: string): string {
  return name.replace(/_/g, "").toLowerCase();
}

const DEC_PRECISION = 18;

function atomsToDec(atoms: string): string {
  const s = atoms.trim();
  if (!/^-?\d+$/.test(s)) throw new Error(`invalid LegacyDec atoms "${atoms}"`);
  const negative = s.startsWith("-");
  const digits = (negative ? s.slice(1) : s).replace(/^0+/, "").padStart(DEC_PRECISION + 1, "0");
  const out = `${digits.slice(0, -DEC_PRECISION)}.${digits.slice(-DEC_PRECISION)}`;
  return negative && /[1-9]/.test(digits) ? `-${out}` : out;
}

function decimalToDec(dec: string): string {
  const m = /^(-?)(\d*)(?:\.(\d*))?$/.exec(dec.trim());
  if (!m || (m[2] === "" && (m[3] ?? "") === "")) throw new Error(`invalid LegacyDec "${dec}"`);
  const frac = m[3] ?? "";
  if (frac.length > DEC_PRECISION) throw new Error(`LegacyDec "${dec}" has more than ${DEC_PRECISION} decimals`);
  return atomsToDec(`${m[1]}${m[2] || "0"}${frac.padEnd(DEC_PRECISION, "0")}`);
}

function base64ToAscii(value: string): string {
  return Buffer.from(value, "base64").toString("utf8");
}

// LegacyDec from JSON. The chain (REST, genesis) writes it as a decimal string,
// always with a decimal point. The rows the message decoder used to write held
// the atoms, either as a plain integer string (cosmjs-types string field) or as
// base64 of the ASCII atoms (bytes field); those forms are only accepted with
// `legacyRows`, since anywhere else an undotted value is ambiguous.
function decFromJson(value: unknown, legacyRows: boolean): string {
  if (typeof value !== "string" && typeof value !== "number") throw new Error(`invalid LegacyDec ${JSON.stringify(value)}`);
  const s = String(value);
  if (s.includes(".")) return decimalToDec(s);
  if (!legacyRows) throw new Error(`LegacyDec "${s}" has no decimal point (atoms are only accepted from legacy table rows)`);
  if (/^-?\d+$/.test(s)) return atomsToDec(s);
  const decoded = base64ToAscii(s);
  if (/^-?\d+$/.test(decoded)) return atomsToDec(decoded);
  throw new Error(`invalid LegacyDec "${s}"`);
}

// gogoproto jsonpb Duration: "<seconds>[.<frac>]s", frac trimmed to 0/3/6/9 digits.
function formatDuration(seconds: bigint, nanos: number): string {
  const negative = seconds < BigInt(0) || nanos < 0;
  const absSeconds = seconds < BigInt(0) ? -seconds : seconds;
  let out = `${absSeconds}.${String(Math.abs(nanos)).padStart(9, "0")}`;
  out = out.replace(/000$/, "").replace(/000$/, "").replace(/\.000$/, "");
  return `${negative ? "-" : ""}${out}s`;
}

function durationFromJson(value: unknown): string {
  if (value !== null && typeof value === "object") {
    const d = value as { seconds?: unknown; nanos?: unknown };
    return formatDuration(BigInt(String(d.seconds ?? 0)), Number(d.nanos ?? 0));
  }
  const s = String(value).trim();
  // cometbft genesis writes durations as integer nanoseconds.
  if (/^-?\d+$/.test(s)) {
    const ns = BigInt(s);
    const billion = BigInt(1_000_000_000);
    return formatDuration(ns / billion, Number(ns % billion));
  }
  const m = /^(-?)(\d+)(?:\.(\d{1,9}))?s$/.exec(s);
  if (!m) throw new Error(`invalid duration "${s}"`);
  const nanos = Number((m[3] ?? "").padEnd(9, "0")) * (m[1] ? -1 : 1);
  return formatDuration(BigInt(`${m[1]}${m[2]}`), nanos);
}

function intString(value: unknown): string {
  // json-bigint hands big numbers over as BigNumber; toFixed avoids exponent notation.
  const v = value as { toFixed?: () => string };
  const bigNumber = value !== null && typeof value === "object" && typeof v.toFixed === "function";
  if (!bigNumber && typeof value !== "string" && typeof value !== "number") {
    throw new Error(`invalid integer ${JSON.stringify(value)}`);
  }
  const s = (bigNumber ? (v.toFixed as () => string)() : String(value)).trim();
  if (!/^-?\d+$/.test(s)) throw new Error(`invalid integer ${JSON.stringify(value)}`);
  return BigInt(s).toString();
}

function numberFromJson(value: unknown, integer: boolean): number {
  const n = typeof value === "number" || (typeof value === "string" && value.trim() !== "") ? Number(value) : NaN;
  if (Number.isNaN(n) || (integer && !Number.isInteger(n))) throw new Error(`invalid number ${JSON.stringify(value)}`);
  return n;
}

function scalarDefault(type: ScalarType): unknown {
  switch (type) {
    case "string":
      return "";
    case "bool":
      return false;
    case "uint64":
    case "int64":
      return "0";
    case "uint32":
    case "int32":
    case "double":
      return 0;
    case "bytes":
      return "";
    case "legacyDec":
    case "legacyDecBytes":
      // An empty LegacyDec is emitted by the chain as zero.
      return atomsToDec("0");
    case "duration":
      return "0s";
    default:
      throw new Error(`unhandled param field type "${type as string}"`);
  }
}

function fieldDefault(field: Field): unknown {
  if (field.repeated) return [];
  if (Array.isArray(field.type)) return field.nullable ? null : messageDefault(field.type);
  if (field.type === "duration" && field.nullable) return null;
  return scalarDefault(field.type as ScalarType);
}

function messageDefault(schema: MessageSchema): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of schema) out[f.name] = fieldDefault(f);
  return out;
}

// ---- proto (wire) input ----

function readScalar(reader: BinaryReader, type: ScalarType): unknown {
  switch (type) {
    case "string":
      return reader.string();
    case "bool":
      return reader.bool();
    case "uint64":
      return reader.uint64().toString();
    case "int64":
      return reader.int64().toString();
    case "uint32":
      return reader.uint32();
    case "int32":
      return reader.int32();
    case "double":
      return reader.double();
    case "bytes":
      return Buffer.from(reader.bytes()).toString("base64");
    case "legacyDec": {
      const s = reader.string();
      return atomsToDec(s === "" ? "0" : s);
    }
    case "legacyDecBytes": {
      const s = Buffer.from(reader.bytes()).toString("utf8");
      return atomsToDec(s === "" ? "0" : s);
    }
    case "duration": {
      const sub = new BinaryReader(reader.bytes());
      let seconds = BigInt(0);
      let nanos = 0;
      while (sub.pos < sub.len) {
        const [no, wt] = sub.tag();
        if (no === 1) seconds = BigInt(sub.int64().toString());
        else if (no === 2) nanos = sub.int32();
        else sub.skip(wt, no);
      }
      return formatDuration(seconds, nanos);
    }
    default:
      throw new Error(`unhandled param field type "${type as string}"`);
  }
}

function decodeMessage(bytes: Uint8Array, schema: MessageSchema, path: string, unknown: Array<string>): Record<string, unknown> {
  const out = messageDefault(schema);
  const byNo = new Map(schema.map((f) => [f.no, f]));
  const reader = new BinaryReader(bytes);
  while (reader.pos < reader.len) {
    const [no, wireType] = reader.tag();
    const field = byNo.get(no);
    if (!field) {
      unknown.push(`${path}#${no}`);
      reader.skip(wireType, no);
      continue;
    }
    const value = Array.isArray(field.type)
      ? decodeMessage(reader.bytes(), field.type, `${path}${field.name}.`, unknown)
      : readScalar(reader, field.type);
    if (field.repeated) (out[field.name] as Array<unknown>).push(value);
    else out[field.name] = value;
  }
  return out;
}

// ---- JSON input (genesis, REST, rows written by older indexer versions) ----

export interface JsonOptions {
  // The input is a row the MsgUpdateParam decoder wrote (the history patch):
  // accept LegacyDec atoms and "true"/"false" strings.
  legacyRows?: boolean;
}

function boolFromJson(value: unknown, options: JsonOptions, bad: () => Error): boolean {
  if (value === true || value === false) return value;
  if (options.legacyRows && (value === "true" || value === "false")) return value === "true";
  throw bad();
}

// Strict: anything that is not the JSON the chain writes for the field throws,
// instead of becoming a plausible default (false, 0, NaN, "[object Object]").
function scalarFromJson(value: unknown, type: ScalarType, path: string, options: JsonOptions): unknown {
  const bad = () => new Error(`${path}: ${JSON.stringify(value)} is not a valid ${type}`);
  switch (type) {
    case "string":
    case "bytes":
      if (value !== null && typeof value === "object") throw bad();
      return String(value);
    case "bool":
      return boolFromJson(value, options, bad);
    case "uint64":
    case "int64":
      try {
        return intString(value);
      } catch (_) {
        throw bad();
      }
    case "uint32":
    case "int32":
    case "double":
      try {
        return numberFromJson(value, type !== "double");
      } catch (_) {
        throw bad();
      }
    case "legacyDec":
    case "legacyDecBytes":
      return decFromJson(value, options.legacyRows === true);
    case "duration":
      return durationFromJson(value);
    default:
      throw new Error(`unhandled param field type "${type as string}"`);
  }
}

function fieldFromJson(value: unknown, field: Field, path: string, unknown: Array<string>, options: JsonOptions): unknown {
  if (value === null || value === undefined) {
    return field.jsonAbsentIsZero && Array.isArray(field.type) ? messageDefault(field.type) : fieldDefault(field);
  }
  const one = (v: unknown) =>
    Array.isArray(field.type)
      ? messageFromJson(v, field.type, `${path}${field.name}.`, unknown, options)
      : scalarFromJson(v, field.type as ScalarType, `${path}${field.name}`, options);
  if (field.repeated) {
    if (!Array.isArray(value)) throw new Error(`${path}${field.name}: expected an array`);
    return value.map(one);
  }
  return one(value);
}

function messageFromJson(obj: unknown, schema: MessageSchema, path: string, unknown: Array<string>, options: JsonOptions): Record<string, unknown> {
  if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
    throw new Error(`${path || "params"}: expected an object, got ${JSON.stringify(obj)}`);
  }
  const byKey = new Map(schema.map((f) => [compactKey(f.name), f]));
  const given = new Map<string, unknown>();
  for (const [k, v] of Object.entries(obj)) {
    const field = byKey.get(compactKey(k));
    if (!field) {
      unknown.push(`${path}${k}`);
      continue;
    }
    given.set(field.name, v);
  }
  const out: Record<string, unknown> = {};
  for (const f of schema) out[f.name] = fieldFromJson(given.get(f.name), f, path, unknown, options);
  return out;
}

// unknownParamFieldsError is the error for params carrying fields the schema
// above does not know. It is thrown, never logged and skipped: a skipped field
// would first appear at whatever height pocketdex learns about it instead of
// the height the chain set it.
export function unknownParamFieldsError(namespace: string, unknown: Array<string>, where: string): Error {
  return new Error(
    `${namespace} params at ${where} carry fields pocketdex does not know (${unknown.join(", ")}). ` +
    "The indexer stops here on purpose: a pocketdex release that adds them to the schema in " +
    "src/mappings/utils/params_normalize.ts ships before each chain release and is validated on beta first; " +
    "deploy that release to continue."
  );
}

// extractParamsBytes returns the Params message carried by a module's
// Query/Params ABCI response. A response without that field throws: decoding
// it anyway would store every param as its zero default.
export function extractParamsBytes(namespace: string, response: Uint8Array): Uint8Array {
  const module = PARAM_MODULES[namespace];
  if (!module) throw new Error(`unknown params namespace "${namespace}"`);
  const reader = new BinaryReader(response);
  let params: Uint8Array | undefined;
  while (reader.pos < reader.len) {
    const [no, wireType] = reader.tag();
    if (no === module.responseField) params = reader.bytes();
    else reader.skip(wireType, no);
  }
  if (!params) throw new Error(`${namespace} Query/Params response has no params field (#${module.responseField})`);
  return params;
}

// The ABCI transport: the response value and the height the node answered for.
export type AbciQuery = (path: string, height: number, data?: Uint8Array) => Promise<{ value: Uint8Array; height: number }>;

export interface ModuleParams {
  namespace: string;
  params: Array<NormalizedParam>;
}

// readAllModuleParams reads every module's params at `height`, all modules in
// parallel, through the given ABCI query transport (the indexer passes its
// height-pinned QueryClient, whose retries and concurrency limit live in
// utils/query_client.ts; the offline scripts plain HTTP abci_query). It only
// returns reads it can vouch for and throws on anything else: a failed query,
// an answer for another height, a response without params, a decode error or
// a field the schema does not know.
export async function readAllModuleParams(query: AbciQuery, height: number): Promise<Array<ModuleParams>> {
  return Promise.all(PARAM_NAMESPACES.map(async (namespace): Promise<ModuleParams> => {
    const response = await query(PARAM_MODULES[namespace].path, height);
    if (Number(response.height) !== height) {
      throw new Error(`${namespace} params: asked for height ${height}, the node answered for ${response.height}`);
    }
    const { params, unknown } = normalizeParams(namespace, extractParamsBytes(namespace, response.value));
    if (unknown.length > 0) throw unknownParamFieldsError(namespace, unknown, `height ${height}`);
    return { namespace, params };
  }));
}

// readSharedParamsAtHeight reads the shared params history entry effective at
// `height` (shared Query/ParamsAtHeight, v0.1.34+) on the state at `height`,
// with the same checks as readAllModuleParams.
export async function readSharedParamsAtHeight(query: AbciQuery, height: number): Promise<Record<string, string>> {
  const request = new BinaryWriter().uint32(8).int64(height).finish();
  const response = await query("/pocket.shared.Query/ParamsAtHeight", height, request);
  if (Number(response.height) !== height) {
    throw new Error(`shared ParamsAtHeight: asked for height ${height}, the node answered for ${response.height}`);
  }
  const { params, unknown } = normalizeParams("shared", extractParamsBytes("shared", response.value));
  if (unknown.length > 0) throw unknownParamFieldsError("shared", unknown, `height ${height} (ParamsAtHeight)`);
  return Object.fromEntries(params.map((p) => [p.key, p.value]));
}

// The params part of a genesis file: app_state.<module>.params, and the CometBFT
// consensus params, at `consensus_params` in a CometBFT GenesisDoc (what a node's
// /genesis returns) or at `consensus.params` in a cosmos-sdk AppGenesis (the
// files published in pokt-network/pocket-network-genesis).
export interface GenesisParamsSource {
  app_state: Record<string, unknown>;
  consensus_params?: unknown;
  consensus?: { params?: unknown };
}

// normalizeGenesisParams normalizes the params of every module the genesis
// carries, strictly (see scalarFromJson), and lists the modules it does not
// carry: those get their first row from the first reconcile instead.
export function normalizeGenesisParams(genesis: GenesisParamsSource): { modules: Array<ModuleParams>; missing: Array<string> } {
  const modules: Array<ModuleParams> = [];
  const missing: Array<string> = [];
  for (const namespace of PARAM_NAMESPACES) {
    const module = genesis.app_state[namespace] as { params?: unknown } | undefined;
    const input = namespace === "consensus" ? genesis.consensus_params ?? genesis.consensus?.params : module?.params;
    if (input === undefined || input === null) {
      missing.push(namespace);
      continue;
    }
    const { params, unknown } = normalizeParams(namespace, input as Record<string, unknown>);
    if (unknown.length > 0) throw unknownParamFieldsError(namespace, unknown, "genesis");
    modules.push({ namespace, params });
  }
  return { missing, modules };
}

// normalizeParams turns one module's params — the Params protobuf message or a
// JSON object (genesis, REST, a legacy table row) — into the canonical
// key/value rows described at the top of this file, one per top-level field,
// in proto declaration order.
export function normalizeParams(
  namespace: string,
  input: Uint8Array | Record<string, unknown>,
  options: JsonOptions = {},
): NormalizedParams {
  const schema = schemas[namespace];
  if (!schema) throw new Error(`unknown params namespace "${namespace}"`);
  const unknown: Array<string> = [];
  const canonical = input instanceof Uint8Array
    ? decodeMessage(input, schema, "", unknown)
    : messageFromJson(input, schema, "", unknown, options);
  return {
    params: schema.map((f) => ({ key: f.name, value: sanitize(canonical[f.name]) })),
    unknown,
  };
}
