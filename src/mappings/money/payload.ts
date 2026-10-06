// buildSettlementPayload turns the finalize-block events of one height into the payload write_settlement
// takes (src/mappings/dbFunctions/settlement/writer.ts). It reads the raw event attributes, not the
// records the rest of the indexer derives from them, and it is strict: an attribute that is missing or
// malformed throws, which fails the block. A silent zero here would become a wrong amount in every
// rollup that reads it.
//
// event_idx is the event's position in finalize_block_events, the same numbering the offline oracle
// (.local/ab/oracle/parse.py) uses. SubQuery's event.idx is unique within a block but assigned lazily, in
// the order the begin/tx/end/finalize getters are first read, so it is not a stable identity.

import { ClaimBank, segmentBank } from "./bank";
import { decodeMapClaims, isMapEra, MapClaim, MapClaimStakerLegs, MapState } from "./map";
import { REASONS, ReasonInfo } from "./reasons";

export interface RawAttribute {
  key: string;
  value: string;
}

export interface RawEvent {
  type: string;
  attributes: ReadonlyArray<RawAttribute>;
}

// Amounts and counts travel as decimal strings: they exceed Number's safe range, and Postgres casts them
// into the bigint columns of the staging tables.
export interface ClaimRow {
  event_idx: number;
  supplier_id: string;
  supplier_owner_id: string;
  application_id: string;
  service_id: string;
  session_id: string;
  session_end: string;
  claimed: string;
  settled: string;
  minted: string;
  overservicing_loss: string;
  deflation_loss: string;
  num_relays: string;
  num_estimated_relays: string;
  num_claimed_cu: string;
  num_estimated_cu: string;
  // claim_proof_status_int: 1 (VALIDATED) when the claim settled with a proof, 0 when it settled without one
  proof_status: string;
  // the tokenomics mint_ratio the claim settled with, as the chain prints it (e.g. "0.975")
  mint_ratio: string;
  // the claim's relay staker share by the chain's rule, floor(minted × proposer), where the reader knows the params
  // (the map eras and detailed_batch); absent, the writer takes what the claim's relay legs leave of its mint
  relay_to_stakers?: string;
  // the map eras: what the claim's global shareholder legs paid beyond their slice (map.ts takeShareholders); absent, 0
  global_overpaid?: string;
}

export interface DetailedRow {
  event_idx: number;
  recipient_id: string;
  op_reason: string;
  role: string;
  family: string;
  amount: string;
}

export interface BatchRow {
  event_idx: number;
  op_type: string;
  op_reason: string;
  sender_module: string;
  recipient_id: string;
  role: string;
  family: string;
  amount: string;
  num_claims: string;
}

export interface VrdRow {
  event_idx: number;
  op_reason: string;
  family: string;
  validator_operator: string;
  validator_account: string;
  // null where the protocol charged no commission (the replayed eras, 288,180–788,944)
  commission_rate: string | null;
  pool_share: string;
  commission: string | null;
  self_delegation: string;
  delegators: string;
  total_delegated_stake: string;
  num_delegators: string;
  // how the row was made where no event carries it: replay, derived_split (replay.ts); absent for an event's row
  row_source?: string;
}

export interface ReimbRow {
  event_idx: number;
  application_id: string;
  supplier_id: string;
  supplier_owner_id: string;
  service_id: string;
  session_id: string;
  amount: string;
}

export interface ExpiredRow {
  event_idx: number;
  supplier_id: string;
  application_id: string;
  service_id: string;
  session_end: string;
  claimed: string;
  reason: string;
  num_relays: string;
  num_estimated_relays: string;
  num_claimed_cu: string;
  num_estimated_cu: string;
}

export interface DiscardedRow {
  event_idx: number;
  supplier_id: string;
  application_id: string;
  service_id: string;
  session_end: string;
  error: string;
}

export interface SlashedRow {
  event_idx: number;
  supplier_id: string;
  application_id: string;
  service_id: string;
  session_end: string;
  penalty: string;
  // null before batched_vrd: the event has no supplier_stake_after_slash there
  stake_after: string | null;
}

export interface DelegatorValidatorRow {
  delegator: string;
  validator_operator: string;
  family: string;
  amount: string;
  // replay, derived_split or unattributed (replay.ts); absent where the era's rule names it (de2.ts)
  row_source?: string;
}

export interface SettlementPayload {
  ts: string;
  era: string;
  // the row_source written with the height's claim, shareholder and staker rows: 'event' where they are the
  // chain's event values
  row_source: string;
  claims: ClaimRow[];
  detailed: DetailedRow[];
  batch: BatchRow[];
  vrd: VrdRow[];
  reimb: ReimbRow[];
  expired: ExpiredRow[];
  discarded: DiscardedRow[];
  slashed: SlashedRow[];
  dv: DelegatorValidatorRow[];
}

export const EVENT_CLAIM_SETTLED = "pocket.tokenomics.EventClaimSettled";
export const EVENT_SETTLEMENT_BATCH = "pocket.tokenomics.EventSettlementBatch";
export const EVENT_VALIDATOR_REWARD_DISTRIBUTION = "pocket.tokenomics.EventValidatorRewardDistribution";
export const EVENT_APPLICATION_REIMBURSEMENT_REQUEST = "pocket.tokenomics.EventApplicationReimbursementRequest";
export const EVENT_CLAIM_EXPIRED = "pocket.tokenomics.EventClaimExpired";
export const EVENT_CLAIM_DISCARDED = "pocket.tokenomics.EventClaimDiscarded";
export const EVENT_SUPPLIER_SLASHED = "pocket.tokenomics.EventSupplierSlashed";
export const EVENT_APPLICATION_OVERSERVICED = "pocket.tokenomics.EventApplicationOverserviced";

// The events that make a height a money height. A block with none of them writes nothing.
export const MONEY_EVENT_TYPES: ReadonlySet<string> = new Set([
  EVENT_CLAIM_SETTLED,
  EVENT_SETTLEMENT_BATCH,
  EVENT_VALIDATOR_REWARD_DISTRIBUTION,
  EVENT_APPLICATION_REIMBURSEMENT_REQUEST,
  EVENT_CLAIM_EXPIRED,
  EVENT_CLAIM_DISCARDED,
  EVENT_SUPPLIER_SLASHED,
]);

// The events whose attributes the parser reads: the money events, and EventApplicationOverserviced, which in the
// settlement_result era is the only record of how much an overserviced claim's application could pay, and in the map
// eras marks a claim its application could pay nothing of (effective_burn 0, readMapHeight). The readers of
// a block (write.ts finalizeBlockEvents, history/chain.ts) keep these whole and only the type of the others.
export const ATTRIBUTE_EVENT_TYPES: ReadonlySet<string> = new Set([
  ...MONEY_EVENT_TYPES,
  EVENT_APPLICATION_OVERSERVICED,
]);

// The EventApplicationOverserviced of a settlement_result height not yet matched to a claim, by
// (application, supplier operator), in block order. Each one precedes its claim's EventClaimSettled.
type Overserviced = Map<string, Array<{ idx: number; expected: bigint; effective: bigint }>>;

// A map-era EventApplicationOverserviced with effective_burn 0, which the next event must be its claim's (readMapHeight).
interface ZeroBurn {
  idx: number;
  application: string;
  supplier: string;
  expected: bigint;
}

// zeroBurns finds each EventApplicationOverserviced with effective_burn 0 of a map-era height, by the index of the
// EventClaimSettled right after it, which must be there.
function zeroBurns(height: number, events: ReadonlyArray<RawEvent>): Map<number, ZeroBurn> {
  const out = new Map<number, ZeroBurn>();
  events.forEach((event, idx) => {
    if (event.type !== EVENT_APPLICATION_OVERSERVICED) return;
    const r = new EventReader(height, event, idx);
    if (BigInt(r.coin("effective_burn")) !== BigInt(0)) return;
    if (events[idx + 1]?.type !== EVENT_CLAIM_SETTLED) throw r.error("effective_burn 0 is not followed by its claim");
    out.set(idx + 1, {
      idx,
      application: r.str("application_addr"),
      supplier: r.str("supplier_operator_addr"),
      expected: BigInt(r.coin("expected_burn")),
    });
  });
  return out;
}

const COIN = /^(\d+)upokt$/;
const UINT = /^\d+$/;
// cosmos LegacyDec as text: digits, a dot and exactly 18 decimals (e.g. "0.100000000000000000").
const LEGACY_DEC_TEXT = /^\d+\.\d{18}$/;
// mint_ratio is a float64 printed with strconv.FormatFloat(x, 'f', -1, 64): "1", "0.975".
const DECIMAL = /^\d+(\.\d+)?$/;

function unquote(v: string): string {
  if (v.length >= 2 && v[0] === '"' && v[v.length - 1] === '"') {
    return JSON.parse(v) as string;
  }
  return v;
}

// BigInt("") is 0n, so every amount is matched against the full pattern before it is used.
function parseCoin(v: string, error: (msg: string) => Error): string {
  const m = COIN.exec(v);
  if (!m) throw error(`is not an upokt amount: ${JSON.stringify(v)}`);
  return m[1];
}

function coinOf(v: unknown, error: (msg: string) => Error): string {
  const c = v as { denom?: unknown; amount?: unknown } | null;
  if (c?.denom !== "upokt" || typeof c.amount !== "string" || !UINT.test(c.amount)) {
    throw error(`is not an upokt Coin object: ${JSON.stringify(v)}`);
  }
  return c.amount;
}

interface NestedClaim {
  supplier_id: string;
  application_id: string;
  service_id: string;
  session_id: string;
  session_end: string;
  proof_status: string;
}

function reasonInfo(reason: string, error: (msg: string) => Error): ReasonInfo {
  const info = REASONS[reason];
  if (!info) throw error(`unknown op_reason ${JSON.stringify(reason)}`);
  return info;
}

class EventReader {
  private readonly attrs = new Map<string, string>();

  constructor(private readonly height: number, private readonly event: RawEvent, private readonly idx: number) {
    for (const a of event.attributes) {
      if (this.attrs.has(a.key)) throw this.error(`duplicate attribute "${a.key}"`);
      this.attrs.set(a.key, a.value);
    }
  }

  error(msg: string): Error {
    return new Error(`[money] height ${this.height} event ${this.idx} (${this.event.type}): ${msg}`);
  }

  private raw(key: string): string {
    const v = this.attrs.get(key);
    if (v === undefined) throw this.error(`missing attribute "${key}"`);
    return v;
  }

  // Attribute values are JSON: strings come quoted, numbers bare.
  str(key: string): string {
    const v = unquote(this.raw(key));
    if (v === "") throw this.error(`empty attribute "${key}"`);
    return v;
  }

  // An attribute this era's events never carry: present, it means the events are from another era.
  absent(key: string): void {
    if (this.attrs.has(key)) {
      throw this.error(`attribute "${key}" is not emitted in this era: the events do not match the height's era`);
    }
  }

  optStr(key: string): string {
    return this.attrs.has(key) ? unquote(this.raw(key)) : "";
  }

  uint(key: string): string {
    const v = unquote(this.raw(key));
    if (!UINT.test(v)) throw this.error(`attribute "${key}" is not an unsigned integer: ${JSON.stringify(v)}`);
    return v;
  }

  coin(key: string): string {
    return parseCoin(unquote(this.raw(key)), (m) => this.error(`attribute "${key}" ${m}`));
  }

  decimal(key: string): string {
    const v = unquote(this.raw(key));
    if (!DECIMAL.test(v)) throw this.error(`attribute "${key}" is not a decimal: ${JSON.stringify(v)}`);
    return v;
  }

  // A cosmos Coin as a JSON object, {"denom":"upokt","amount":"N"} (settlement_result era).
  coinObject(key: string): string {
    return coinOf(this.json(key), (m) => this.error(`attribute "${key}" ${m}`));
  }

  // The claim the settlement_result era nests in its events: ids, session and proof status.
  nestedClaim(): NestedClaim {
    const c = this.json("claim") as Record<string, unknown> | null;
    const h = (c?.session_header ?? null) as Record<string, unknown> | null;
    const text = (o: Record<string, unknown> | null, k: string): string => {
      const v = o?.[k];
      if (typeof v !== "string" || v === "") throw this.error(`claim.${k} is missing or not a string`);
      return v;
    };
    const sessionEnd = text(h, "session_end_block_height");
    if (!UINT.test(sessionEnd)) throw this.error(`claim session_end_block_height is not an unsigned integer`);
    return {
      supplier_id: text(c, "supplier_operator_address"),
      application_id: text(h, "application_address"),
      service_id: text(h, "service_id"),
      session_id: text(h, "session_id"),
      session_end: sessionEnd,
      proof_status: text(c, "proof_validation_status"),
    };
  }

  legacyDec(key: string): string {
    const v = unquote(this.raw(key));
    if (!LEGACY_DEC_TEXT.test(v)) throw this.error(`attribute "${key}" is not a LegacyDec: ${JSON.stringify(v)}`);
    return v;
  }

  json(key: string): unknown {
    try {
      return JSON.parse(this.raw(key));
    } catch (e) {
      throw this.error(`attribute "${key}" is not JSON: ${e}`);
    }
  }
}

function readClaim(r: EventReader, idx: number, p: SettlementPayload): void {
  p.claims.push({
    event_idx: idx,
    supplier_id: r.str("supplier_operator_address"),
    supplier_owner_id: r.optStr("supplier_owner_address"),
    application_id: r.str("application_address"),
    service_id: r.str("service_id"),
    session_id: r.str("session_id"),
    session_end: r.uint("session_end_block_height"),
    claimed: r.coin("claimed_upokt"),
    settled: r.coin("settled_upokt"),
    minted: r.coin("minted_upokt"),
    overservicing_loss: r.coin("overservicing_loss_upokt"),
    deflation_loss: r.coin("deflation_loss_upokt"),
    num_relays: r.uint("num_relays"),
    num_estimated_relays: r.uint("num_estimated_relays"),
    num_claimed_cu: r.uint("num_claimed_compute_units"),
    num_estimated_cu: r.uint("num_estimated_compute_units"),
    proof_status: r.uint("claim_proof_status_int"),
    mint_ratio: r.decimal("mint_ratio"),
  });
  const detailed = r.json("reward_distribution_detailed");
  if (!Array.isArray(detailed)) throw r.error("reward_distribution_detailed is not an array");
  for (const d of detailed as Array<Record<string, unknown>>) {
    const { amount, op_reason: reason, recipient_address: recipient } = d;
    if (typeof recipient !== "string" || recipient === "") throw r.error("detailed row without recipient_address");
    if (typeof reason !== "string") throw r.error(`detailed op_reason is not a string: ${JSON.stringify(reason)}`);
    if (typeof amount !== "string") throw r.error(`detailed amount is not a string: ${JSON.stringify(amount)}`);
    const info = reasonInfo(reason, (m) => r.error(`detailed ${m}`));
    if (!info.detailed) throw r.error(`op_reason ${reason} is not expected in reward_distribution_detailed`);
    p.detailed.push({
      event_idx: idx,
      recipient_id: recipient,
      op_reason: reason,
      role: info.role,
      family: info.family,
      amount: parseCoin(amount, (m) => r.error(`detailed amount ${m}`)),
    });
  }
}

// The proof status the settlement_result era prints as a name, as claim_proof_status_int: 1 with a proof.
const E0_PROOF_STATUS: Readonly<Record<string, string>> = { VALIDATED: "1", PENDING_VALIDATION: "0" };

// readClaimE0 reads a settlement_result-era EventClaimSettled (poktroll v0.1.26 and earlier): every leg of the
// claim with its reason, in settlement_result.{burns, mints, mod_to_acct_transfers, mod_to_mod_transfers}. The
// mod_to_acct legs become the detailed rows (the proposer's global share as role validator), and the claim's
// identities are checked here, because the writer does not receive the burn and the mints: burn = claimed,
// relay mint = burn, Σ relay legs = relay mint, Σ global legs = global mint = Σ escrow legs. The settled amount
// is the burn, the mint ratio is 1 and there is no deflation; the supplier owner comes from the reimbursement
// request (attachE0Owners).
function readClaimE0(r: EventReader, idx: number, p: SettlementPayload, overserviced: Overserviced): void {
  const claim = r.nestedClaim();
  const claimed = r.coinObject("claimed_upokt");
  const proofStatus = E0_PROOF_STATUS[claim.proof_status];
  if (proofStatus === undefined) throw r.error(`unexpected claim.proof_validation_status ${claim.proof_status}`);
  const sr = r.json("settlement_result") as Record<string, unknown> | null;
  const legs = (k: string): Array<Record<string, unknown>> => {
    const v = sr?.[k] ?? [];
    if (!Array.isArray(v)) throw r.error(`settlement_result.${k} is not an array`);
    return v as Array<Record<string, unknown>>;
  };
  const amountOf = (leg: Record<string, unknown>, k: string) => coinOf(leg.coin, (m) => r.error(`${k} coin ${m}`));
  // the one leg of `k` with `reason`; any other reason in `k` is refused
  const single = (k: string, reasons: ReadonlyArray<string>): Map<string, bigint> => {
    const got = new Map<string, bigint>();
    for (const leg of legs(k)) {
      const reason = leg.op_reason;
      if (typeof reason !== "string" || !reasons.includes(reason)) {
        throw r.error(`unexpected ${k} op_reason ${JSON.stringify(reason)}`);
      }
      if (got.has(reason)) throw r.error(`more than one ${k} leg ${reason}`);
      got.set(reason, BigInt(amountOf(leg, k)));
    }
    for (const reason of reasons) if (!got.has(reason)) throw r.error(`no ${k} leg ${reason}`);
    return got;
  };
  const burn = single("burns", ["TLM_RELAY_BURN_EQUALS_MINT_APPLICATION_STAKE_BURN"]).get(
    "TLM_RELAY_BURN_EQUALS_MINT_APPLICATION_STAKE_BURN"
  ) as bigint;
  const mints = single("mints", ["TLM_RELAY_BURN_EQUALS_MINT_SUPPLIER_STAKE_MINT", "TLM_GLOBAL_MINT_INFLATION"]);
  const relayMint = mints.get("TLM_RELAY_BURN_EQUALS_MINT_SUPPLIER_STAKE_MINT") as bigint;
  const globalMint = mints.get("TLM_GLOBAL_MINT_INFLATION") as bigint;
  for (const leg of legs("mod_to_mod_transfers")) {
    const reason = leg.op_reason;
    if (typeof reason !== "string") throw r.error(`mod_to_mod op_reason is not a string`);
    if (!reasonInfo(reason, (m) => r.error(`mod_to_mod ${m}`)).batchOpTypes.includes("mod_to_mod")) {
      throw r.error(`op_reason ${reason} is not expected in mod_to_mod_transfers`);
    }
    amountOf(leg, "mod_to_mod");
  }
  const sums: Record<string, bigint> = { relay: BigInt(0), global: BigInt(0), reimb_escrow: BigInt(0) };
  let proposerLegs = 0;
  for (const leg of legs("mod_to_acct_transfers")) {
    const { RecipientAddress: recipient, op_reason: reason } = leg;
    // one block proposer per claim; staker_payouts keeps one row per (height, event_idx)
    if (reason === "TLM_GLOBAL_MINT_PROPOSER_REWARD_DISTRIBUTION" && ++proposerLegs > 1) {
      throw r.error("more than one proposer leg TLM_GLOBAL_MINT_PROPOSER_REWARD_DISTRIBUTION");
    }
    if (typeof recipient !== "string" || recipient === "") throw r.error("mod_to_acct leg without RecipientAddress");
    if (typeof reason !== "string") throw r.error(`mod_to_acct op_reason is not a string: ${JSON.stringify(reason)}`);
    const info = reasonInfo(reason, (m) => r.error(`mod_to_acct ${m}`));
    if (!info.detailed) throw r.error(`op_reason ${reason} is not expected in mod_to_acct_transfers`);
    const amount = amountOf(leg, "mod_to_acct");
    sums[info.family] += BigInt(amount);
    p.detailed.push({
      event_idx: idx,
      recipient_id: recipient,
      op_reason: reason,
      role: info.role,
      family: info.family,
      amount,
    });
  }
  // An application whose stake could not cover the claim burns what it had (measured on mainnet 96,845–96,860, where
  // every claim is overserviced): the claim then has an EventApplicationOverserviced before it, whose effective_burn
  // is the burn and whose expected_burn is above the claimed amount (claimed × 1.01 there: the global inflation the
  // application also pays). The difference is the claim's overservicing loss.
  let overservicingLoss = BigInt(0);
  if (burn < BigInt(claimed)) {
    const pending = overserviced.get(`${claim.application_id}|${claim.supplier_id}`) ?? [];
    const os = pending.shift();
    if (!os) throw r.error(`burn ${burn} < claimed ${claimed} and no EventApplicationOverserviced for the claim`);
    if (os.effective !== burn || os.expected < BigInt(claimed)) {
      throw r.error(
        `EventApplicationOverserviced (event ${os.idx}) effective_burn ${os.effective}, expected_burn ${os.expected} ` +
          `do not match the claim: burn ${burn}, claimed ${claimed}`
      );
    }
    overservicingLoss = BigInt(claimed) - burn;
  }
  const identities: Array<[string, bigint, bigint]> = [
    ["burn + overservicing loss = claimed", burn + overservicingLoss, BigInt(claimed)],
    ["relay mint = burn", relayMint, burn],
    ["relay legs = relay mint", sums.relay, relayMint],
    ["global legs = global mint", sums.global, globalMint],
    ["escrow legs = global mint", sums.reimb_escrow, globalMint],
  ];
  for (const [name, got, want] of identities) {
    if (got !== want) throw r.error(`settlement_result identity ${name} fails: ${got} <> ${want}`);
  }
  p.claims.push({
    event_idx: idx,
    supplier_id: claim.supplier_id,
    supplier_owner_id: "",
    application_id: claim.application_id,
    service_id: claim.service_id,
    session_id: claim.session_id,
    session_end: claim.session_end,
    claimed,
    settled: burn.toString(),
    minted: relayMint.toString(),
    overservicing_loss: overservicingLoss.toString(),
    deflation_loss: "0",
    num_relays: r.uint("num_relays"),
    num_estimated_relays: estimatedRelays(
      r.uint("num_relays"),
      r.uint("num_claimed_compute_units"),
      r.uint("num_estimated_compute_units")
    ),
    num_claimed_cu: r.uint("num_claimed_compute_units"),
    num_estimated_cu: r.uint("num_estimated_compute_units"),
    proof_status: proofStatus,
    mint_ratio: "1",
  });
}

function readEventE0(r: EventReader, idx: number, type: string, p: SettlementPayload, os: Overserviced): void {
  switch (type) {
    case EVENT_CLAIM_SETTLED:
      readClaimE0(r, idx, p, os);
      break;
    case EVENT_APPLICATION_REIMBURSEMENT_REQUEST:
      p.reimb.push({
        event_idx: idx,
        application_id: r.str("application_addr"),
        supplier_id: r.str("supplier_operator_addr"),
        supplier_owner_id: r.str("supplier_owner_addr"),
        service_id: r.str("service_id"),
        session_id: r.str("session_id"),
        amount: r.coinObject("amount"),
      });
      break;
    case EVENT_CLAIM_EXPIRED: {
      const c = r.nestedClaim();
      r.absent("num_estimated_relays");
      p.expired.push({
        event_idx: idx,
        supplier_id: c.supplier_id,
        application_id: c.application_id,
        service_id: c.service_id,
        session_end: c.session_end,
        claimed: r.coinObject("claimed_upokt"),
        reason: r.str("expiration_reason"),
        num_relays: r.uint("num_relays"),
        num_estimated_relays: estimatedRelays(
          r.uint("num_relays"),
          r.uint("num_claimed_compute_units"),
          r.uint("num_estimated_compute_units")
        ),
        num_claimed_cu: r.uint("num_claimed_compute_units"),
        num_estimated_cu: r.uint("num_estimated_compute_units"),
      });
      break;
    }
    case EVENT_CLAIM_DISCARDED: {
      const c = r.nestedClaim();
      p.discarded.push({
        event_idx: idx,
        supplier_id: c.supplier_id,
        application_id: c.application_id,
        service_id: c.service_id,
        session_end: c.session_end,
        error: r.str("error"),
      });
      break;
    }
    case EVENT_SUPPLIER_SLASHED: {
      const c = r.nestedClaim();
      r.absent("supplier_stake_after_slash");
      p.slashed.push({
        event_idx: idx,
        supplier_id: c.supplier_id,
        application_id: c.application_id,
        service_id: c.service_id,
        session_end: c.session_end,
        penalty: r.coinObject("proof_missing_penalty"),
        stake_after: null,
      });
      break;
    }
    default:
      throw r.error("event type is not emitted in the settlement_result era");
  }
}

// attachE0Owners gives each settlement_result-era claim the supplier owner of its reimbursement request. Claims
// and requests match one to one on (supplier, application, session), as the writer joins them: a claim without
// exactly one request, or a request without exactly one claim, stops the height.
function attachE0Owners(height: number, p: SettlementPayload): void {
  const byKey = new Map<string, ReimbRow[]>();
  const claimsByKey = new Map<string, number>();
  for (const x of p.reimb) {
    const k = `${x.supplier_id}|${x.application_id}|${x.session_id}`;
    byKey.set(k, [...(byKey.get(k) ?? []), x]);
  }
  for (const c of p.claims) {
    const k = `${c.supplier_id}|${c.application_id}|${c.session_id}`;
    claimsByKey.set(k, (claimsByKey.get(k) ?? 0) + 1);
  }
  for (const x of p.reimb) {
    const n = claimsByKey.get(`${x.supplier_id}|${x.application_id}|${x.session_id}`) ?? 0;
    if (n !== 1) {
      throw new Error(
        `[money] height ${height} event ${x.event_idx}: ${n} claims for the reimbursement request, expected 1`
      );
    }
  }
  for (const c of p.claims) {
    const found = byKey.get(`${c.supplier_id}|${c.application_id}|${c.session_id}`) ?? [];
    if (found.length !== 1) {
      throw new Error(
        `[money] height ${height} event ${c.event_idx}: ${found.length} reimbursement requests for the claim, expected 1`
      );
    }
    c.supplier_owner_id = found[0].supplier_owner_id;
  }
}

function readBatch(r: EventReader, idx: number, p: SettlementPayload): void {
  const reason = r.str("op_reason");
  const opType = r.str("op_type");
  const info = reasonInfo(reason, (m) => r.error(m));
  if (!info.batchOpTypes.includes(opType)) throw r.error(`op_type ${opType} is not expected for op_reason ${reason}`);
  p.batch.push({
    event_idx: idx,
    op_type: opType,
    op_reason: reason,
    sender_module: r.optStr("sender_module"),
    recipient_id: r.optStr("recipient"),
    role: info.role,
    family: info.family,
    amount: r.coin("total_amount"),
    num_claims: r.uint("num_claims"),
  });
}

function readVrd(r: EventReader, idx: number, p: SettlementPayload): void {
  const reason = r.str("op_reason");
  const info = reasonInfo(reason, (m) => r.error(m));
  if (info.role !== "validator") throw r.error(`op_reason ${reason} is not a validator reason`);
  p.vrd.push({
    event_idx: idx,
    op_reason: reason,
    family: info.family,
    validator_operator: r.str("validator_operator_address"),
    validator_account: r.str("validator_account_address"),
    commission_rate: r.legacyDec("commission_rate"),
    pool_share: r.uint("pool_share_upokt"),
    commission: r.uint("commission_upokt"),
    self_delegation: r.uint("self_delegation_reward_upokt"),
    delegators: r.uint("delegators_reward_upokt"),
    total_delegated_stake: r.uint("total_delegated_stake_upokt"),
    num_delegators: r.uint("num_delegators"),
  });
}

// estimatedRelays is the chain's num_estimated_relays for a claim, for the events that do not carry it
// (EventClaimExpired before v0.1.34): poktroll v0.1.33 settle_pending_claims.go computes it as
// num_estimated_compute_units / (num_claimed_compute_units / num_relays) in uint64 integer division, 0 when
// either divisor is 0 (v0.1.34 moved the same code to Claim.GetNumEstimatedRelays).
export function estimatedRelays(numRelays: string, numClaimedCu: string, numEstimatedCu: string): string {
  const relays = BigInt(numRelays);
  if (relays === BigInt(0)) return "0";
  const cuPerRelay = BigInt(numClaimedCu) / relays;
  if (cuPerRelay === BigInt(0)) return "0";
  return (BigInt(numEstimatedCu) / cuPerRelay).toString();
}

// The eras whose event format this parser and the writer support; assertFormatMatchesEra checks each.
const SUPPORTED_ERAS: ReadonlySet<string> = new Set([
  "settlement_result",
  "map_proposer_consensus",
  "map_no_stakers",
  "map_proposer_operator",
  "map_all_bonded",
  "map_all_bonded_deflation",
  "detailed_batch",
  "batched_vrd",
]);

// readClaimMap reads a map-era EventClaimSettled (poktroll v0.1.27–v0.1.32): the claim's ids, counts and
// reward_distribution. Its session, supplier owner and amounts come later, from the reimbursement request and the
// bank events (readMapHeight). `unpaid` is the EventApplicationOverserviced with effective_burn 0 right before it.
function readClaimMap(
  r: EventReader,
  idx: number,
  p: SettlementPayload,
  maps: MapClaim[],
  unpaid: ZeroBurn | undefined
): void {
  let rd = r.json("reward_distribution");
  if (typeof rd === "string") rd = JSON.parse(rd) as unknown;
  if (rd === null || typeof rd !== "object" || Array.isArray(rd)) throw r.error("reward_distribution is not an object");
  const map = new Map<string, bigint>();
  for (const [recipient, amount] of Object.entries(rd as Record<string, unknown>)) {
    if (typeof amount !== "string") {
      throw r.error(`reward_distribution amount is not a string: ${JSON.stringify(amount)}`);
    }
    const x = BigInt(parseCoin(amount, (m) => r.error(`reward_distribution amount ${m}`)));
    if (x > BigInt(0)) map.set(recipient, x);
  }
  const claimed = r.coin("claimed_upokt");
  const relays = r.uint("num_relays");
  const claimedCu = r.uint("num_claimed_compute_units");
  const estimatedCu = r.uint("num_estimated_compute_units");
  const application = r.str("application_address");
  const supplier = r.str("supplier_operator_address");
  if (unpaid && (unpaid.application !== application || unpaid.supplier !== supplier)) {
    throw r.error(
      `the EventApplicationOverserviced with effective_burn 0 before it (event ${unpaid.idx}) is not its own`
    );
  }
  maps.push({
    event_idx: idx,
    application_id: application,
    claimed: BigInt(claimed),
    map,
    unpaidExpectedBurn: unpaid?.expected,
  });
  p.claims.push({
    event_idx: idx,
    supplier_id: supplier,
    supplier_owner_id: "",
    application_id: application,
    service_id: r.str("service_id"),
    session_id: "",
    session_end: r.uint("session_end_block_height"),
    claimed,
    settled: "",
    minted: "",
    overservicing_loss: "",
    deflation_loss: "",
    num_relays: relays,
    num_estimated_relays: estimatedRelays(relays, claimedCu, estimatedCu),
    num_claimed_cu: claimedCu,
    num_estimated_cu: estimatedCu,
    proof_status: r.uint("claim_proof_status_int"),
    mint_ratio: "",
  });
}

// readMapHeight completes a map-era height: each claim's single reimbursement request (on supplier, application and
// service, both ways: map-era requests carry the session id the claim lacks), its bank legs and the slices they pay.
// Two claims of one supplier, application and service in one height cannot be told apart (the request has no
// session end), so they stop the height; none of the samples has one. A claim of 0 upokt has no request and no bank
// events: the chain skips the token logic modules when the settlement amount is zero (poktroll v0.1.29–v0.1.30
// ProcessTokenLogicModules), and still emits EventClaimSettled (9 claims at beta 3,333). Its session id is unknown.
// The settlement amount is also zero when the application can pay nothing of a claim: ensureClaimAmountLimits caps it
// at 0 and emits EventApplicationOverserviced with effective_burn 0, then the TLMs are skipped and EventClaimSettled
// follows at once with an empty reward_distribution (token_logic_modules.go:176-181, identical v0.1.27–v0.1.32;
// mainnet 689,253: 36 claims of one application). That claim settles 0 and loses all it claimed to overservicing.
function readMapHeight(
  height: number,
  p: SettlementPayload,
  maps: MapClaim[],
  events: ReadonlyArray<RawEvent>,
  state: MapState | undefined,
  sink: PayloadSink | undefined
): void {
  const key = (supplier: string, application: string, service: string) => `${supplier}|${application}|${service}`;
  const byKey = new Map<string, ReimbRow[]>();
  for (const x of p.reimb) {
    const k = key(x.supplier_id, x.application_id, x.service_id);
    byKey.set(k, [...(byKey.get(k) ?? []), x]);
  }
  const claimKeys = new Map<string, number>();
  for (const c of p.claims) {
    const k = key(c.supplier_id, c.application_id, c.service_id);
    claimKeys.set(k, (claimKeys.get(k) ?? 0) + 1);
  }
  for (const x of p.reimb) {
    const n = claimKeys.get(key(x.supplier_id, x.application_id, x.service_id)) ?? 0;
    if (n !== 1) {
      throw new Error(
        `[money] height ${height} event ${x.event_idx}: ${n} claims for the reimbursement request, expected 1`
      );
    }
  }
  const zero = p.claims.map((c, k) => BigInt(c.claimed) === BigInt(0) || maps[k].unpaidExpectedBurn !== undefined);
  const reimbs = p.claims.map((c, k) => {
    const found = byKey.get(key(c.supplier_id, c.application_id, c.service_id)) ?? [];
    const expected = zero[k] ? 0 : 1;
    if (found.length !== expected) {
      throw new Error(
        `[money] height ${height} event ${c.event_idx}: ${found.length} reimbursement requests for the claim, expected ${expected}`
      );
    }
    return found[0] ?? { supplier_owner_id: "", session_id: "", amount: "0" };
  });
  const paid = segmentBank(
    height,
    events,
    maps.filter((_, k) => !zero[k]).map((m) => m.map),
    p.slashed.length
  );
  const none: ClaimBank = { relayMint: BigInt(0), globalMint: BigInt(0), burn: BigInt(0), legs: [] };
  const banks = zero.map((z) => (z ? none : (paid.shift() as ClaimBank)));
  const decoded = decodeMapClaims(
    height,
    p.era,
    maps,
    banks,
    reimbs.map((x) => BigInt(x.amount)),
    state
  );
  const ratio = state?.mintRatio === "0" || state?.mintRatio === "1" ? "1" : (state?.mintRatio as string);
  p.claims.forEach((c, k) => {
    const { minted, settled } = decoded.amounts[k];
    c.session_id = reimbs[k].session_id;
    c.supplier_owner_id = reimbs[k].supplier_owner_id;
    c.settled = settled.toString();
    c.minted = minted.toString();
    c.overservicing_loss = (BigInt(c.claimed) - settled).toString();
    c.deflation_loss = (settled - minted).toString();
    c.mint_ratio = ratio;
    c.relay_to_stakers = decoded.amounts[k].relayToStakers.toString();
    c.global_overpaid = decoded.amounts[k].globalOverpaid.toString();
  });
  p.detailed = decoded.detailed;
  p.batch = decoded.stakers;
  p.row_source = "bank";
  if (sink) sink.mapStakers = decoded.claimStakers;
}

// assertFormatMatchesEra stops a height whose events do not have the shape its era (eraAtHeight) says, so
// a wrong era boundary cannot write one era's events under another's checks: batched_vrd pays the stakers
// through EventValidatorRewardDistribution, detailed_batch has the settlement batch and no validator
// distribution. A detailed_batch staker row of the global family also stops the height: get_supply_flows reads
// the global staker share from the validator distributions only, relying on it being 0 before batched_vrd.
function assertFormatMatchesEra(height: number, p: SettlementPayload): void {
  const fail = (msg: string) => new Error(`[money] height ${height}: era ${p.era} ${msg}`);
  if (p.era === "batched_vrd") {
    const stakerRows = p.batch.some((b) => b.role === "validator" || b.role === "delegator");
    if (stakerRows && p.vrd.length === 0) {
      throw fail("has staker rows in the settlement batch but no EventValidatorRewardDistribution");
    }
  } else if (isMapEra(p.era)) {
    // the batch rows are the staker legs aggregated from the bank (event_idx -1), never an EventSettlementBatch
    if (p.vrd.length > 0 || p.batch.some((b) => b.event_idx !== -1)) {
      throw fail("has EventSettlementBatch or EventValidatorRewardDistribution, which this era does not emit");
    }
  } else if (p.era === "settlement_result") {
    if (p.batch.length > 0 || p.vrd.length > 0) {
      throw fail("has EventSettlementBatch or EventValidatorRewardDistribution, which this era does not emit");
    }
  } else {
    if (p.vrd.length > 0) throw fail("has EventValidatorRewardDistribution, which this era does not emit");
    if (p.claims.length > 0 && p.batch.length === 0) throw fail("has settled claims but no EventSettlementBatch");
    if (p.batch.some((b) => (b.role === "validator" || b.role === "delegator") && b.family === "global")) {
      throw fail("has a global staker row in the settlement batch, which this era never paid");
    }
  }
}

// What buildSettlementPayload can hand back besides the payload, for the validator replay (replay.ts): in the map eras,
// each claim's staker share and legs, which the payload only keeps aggregated.
export interface PayloadSink {
  mapStakers?: MapClaimStakerLegs[];
}

export function buildSettlementPayload(
  height: number,
  ts: Date,
  era: string,
  finalizeEvents: ReadonlyArray<RawEvent>,
  mapState?: MapState,
  sink?: PayloadSink
): SettlementPayload | null {
  const p: SettlementPayload = {
    ts: ts.toISOString(),
    era,
    row_source: "event",
    claims: [],
    detailed: [],
    batch: [],
    vrd: [],
    reimb: [],
    expired: [],
    discarded: [],
    slashed: [],
    dv: [],
  };
  if (!finalizeEvents.some((e) => MONEY_EVENT_TYPES.has(e.type))) return null;
  if (!SUPPORTED_ERAS.has(era)) {
    throw new Error(`[money] height ${height}: era ${era} is not supported by the money parser yet`);
  }
  const map = isMapEra(era);
  const mapClaims: MapClaim[] = [];
  const overserviced: Overserviced = new Map();
  const unpaid = map ? zeroBurns(height, finalizeEvents) : new Map<number, ZeroBurn>();

  finalizeEvents.forEach((event, idx) => {
    if (era === "settlement_result" && event.type === EVENT_APPLICATION_OVERSERVICED) {
      const r = new EventReader(height, event, idx);
      const key = `${r.str("application_addr")}|${r.str("supplier_operator_addr")}`;
      const list = overserviced.get(key) ?? [];
      list.push({
        idx,
        expected: BigInt(r.coinObject("expected_burn")),
        effective: BigInt(r.coinObject("effective_burn")),
      });
      overserviced.set(key, list);
      return;
    }
    if (!MONEY_EVENT_TYPES.has(event.type)) return;
    const r = new EventReader(height, event, idx);
    if (era === "settlement_result") {
      readEventE0(r, idx, event.type, p, overserviced);
      return;
    }
    if (map && (event.type === EVENT_SETTLEMENT_BATCH || event.type === EVENT_VALIDATOR_REWARD_DISTRIBUTION)) {
      throw r.error("event type is not emitted in the map era");
    }
    if (map && event.type === EVENT_CLAIM_SETTLED) {
      readClaimMap(r, idx, p, mapClaims, unpaid.get(idx));
      return;
    }

    switch (event.type) {
      case EVENT_CLAIM_SETTLED:
        readClaim(r, idx, p);
        break;
      case EVENT_SETTLEMENT_BATCH:
        readBatch(r, idx, p);
        break;
      case EVENT_VALIDATOR_REWARD_DISTRIBUTION:
        readVrd(r, idx, p);
        break;
      case EVENT_APPLICATION_REIMBURSEMENT_REQUEST:
        p.reimb.push({
          event_idx: idx,
          application_id: r.str("application_addr"),
          supplier_id: r.str("supplier_operator_addr"),
          supplier_owner_id: r.optStr("supplier_owner_addr"),
          service_id: r.str("service_id"),
          session_id: r.str("session_id"),
          amount: r.coin("amount"),
        });
        break;
      case EVENT_CLAIM_EXPIRED:
        p.expired.push({
          event_idx: idx,
          supplier_id: r.str("supplier_operator_address"),
          application_id: r.str("application_address"),
          service_id: r.str("service_id"),
          session_end: r.uint("session_end_block_height"),
          claimed: r.coin("claimed_upokt"),
          reason: r.str("expiration_reason"),
          num_relays: r.uint("num_relays"),
          num_estimated_relays:
            era !== "batched_vrd"
              ? (r.absent("num_estimated_relays"),
                estimatedRelays(
                  r.uint("num_relays"),
                  r.uint("num_claimed_compute_units"),
                  r.uint("num_estimated_compute_units")
                ))
              : r.uint("num_estimated_relays"),
          num_claimed_cu: r.uint("num_claimed_compute_units"),
          num_estimated_cu: r.uint("num_estimated_compute_units"),
        });
        break;
      case EVENT_CLAIM_DISCARDED:
        p.discarded.push({
          event_idx: idx,
          supplier_id: r.str("supplier_operator_address"),
          application_id: r.str("application_address"),
          service_id: r.str("service_id"),
          session_end: r.uint("session_end_block_height"),
          error: r.str("error"),
        });
        break;
      case EVENT_SUPPLIER_SLASHED:
        p.slashed.push({
          event_idx: idx,
          supplier_id: r.str("supplier_operator_address"),
          application_id: r.str("application_address"),
          service_id: r.str("service_id"),
          session_end: r.uint("session_end_block_height"),
          penalty: r.coin("proof_missing_penalty"),
          stake_after:
            era !== "batched_vrd"
              ? (r.absent("supplier_stake_after_slash"), null)
              : r.coin("supplier_stake_after_slash"),
        });
        break;
      default:
        throw r.error("event type is in MONEY_EVENT_TYPES but has no reader");
    }
  });

  if (era === "settlement_result") {
    const left = [...overserviced.values()].flat();
    if (left.length > 0) {
      throw new Error(`[money] height ${height} event ${left[0].idx}: EventApplicationOverserviced matches no claim`);
    }
    attachE0Owners(height, p);
  }
  if (map) readMapHeight(height, p, mapClaims, finalizeEvents, mapState, sink);
  assertFormatMatchesEra(height, p);
  return p;
}
