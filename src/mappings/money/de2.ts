import type { SettlementPayload } from "./payload";

// deriveDelegatorValidator splits a settlement's validator and delegator rewards per (delegator, validator),
// which the chain does not emit: the batch carries one total per recipient, and a delegator of several
// validators gets one sum. It replays poktroll's split (x/tokenomics distribution_validator.go, v0.1.34 and
// later) over the delegations at the settlement height, per family (relay, global):
//   1. the family total R goes to the bonded validators by largest remainder over their tokens;
//   2. each validator keeps floor(pool × commission_rate) as commission (all of it when the rate is >= 1);
//   3. the rest goes to its delegators by largest remainder over floor(shares × tokens / delegator_shares).
// Largest remainder: floor shares first, then the leftover one unit each to the largest remainders, ties by
// address (codepoint order). The offline oracle .local/ab/oracle/derive_dv.py implements the same rules and
// matched mainnet on 45,659 validator distributions.
//
// The result is checked against what the chain does emit, and a difference throws (fails the block):
// per validator, (pool share, commission, self-delegation reward) equal the validator distribution event;
// per recipient, Σ over validators of its rewards plus its commission equal its batch rows.

export interface De2Validator {
  operator: string;
  account: string;
  tokens: bigint;
  delegatorShares: bigint;
  // commission rate as LegacyDec atomics (rate × 1e18)
  rateAtoms: bigint;
  delegations: ReadonlyArray<{ delegator: string; shares: bigint }>;
}

export interface De2Row {
  delegator: string;
  validator_operator: string;
  family: string;
  amount: string;
}

export interface VrdTotals {
  family: string;
  account: string;
  pool: bigint;
  commission: bigint;
  self: bigint;
}

const ZERO = BigInt(0);
const ONE_UNIT = BigInt(1);
// LegacyDec scale
const ONE = BigInt("1000000000000000000");

export function largestRemainder(stakes: ReadonlyMap<string, bigint>, r: bigint): Map<string, bigint> {
  let total = ZERO;
  for (const s of stakes.values()) total += s;
  const out = new Map<string, bigint>();
  if (r === ZERO) {
    for (const k of stakes.keys()) out.set(k, ZERO);
    return out;
  }
  if (total <= ZERO) throw new Error(`[de2] cannot split ${r} over a zero total`);
  let assigned = ZERO;
  const fractional: Array<{ key: string; rem: bigint }> = [];
  for (const [key, s] of stakes) {
    const base = (s * r) / total;
    out.set(key, base);
    assigned += base;
    const rem = (s * r) % total;
    if (rem !== ZERO) fractional.push({ key, rem });
  }
  fractional.sort((a, b) => (a.rem === b.rem ? (a.key < b.key ? -1 : a.key > b.key ? 1 : 0) : a.rem > b.rem ? -1 : 1));
  const left = r - assigned;
  if (left > ZERO && fractional.length > 0) {
    const n = BigInt(fractional.length);
    const each = left / n;
    const extra = left % n;
    fractional.forEach((f, i) =>
      out.set(f.key, (out.get(f.key) as bigint) + each + (BigInt(i) < extra ? ONE_UNIT : ZERO))
    );
  }
  return out;
}

interface DerivedVrd {
  pool: bigint;
  commission: bigint;
  self: bigint;
}

// One validator's share of one family: its commission, and the rest split over its delegators.
function splitValidator(
  v: De2Validator,
  family: string,
  pool: bigint,
  rows: De2Row[],
  add: (key: string, v: bigint) => void
): DerivedVrd {
  const commission = v.rateAtoms >= ONE ? pool : (pool * v.rateAtoms) / ONE;
  add(`${family}|${v.account}`, commission);
  const rest = pool - commission;
  const tokens = new Map<string, bigint>();
  if (v.delegatorShares > ZERO) {
    for (const d of v.delegations) {
      const t = (d.shares * v.tokens) / v.delegatorShares;
      if (t > ZERO) tokens.set(d.delegator, t);
    }
  }
  let self = ZERO;
  if (rest > ZERO && tokens.size > 0) {
    for (const [delegator, amount] of largestRemainder(tokens, rest)) {
      if (amount <= ZERO) continue;
      add(`${family}|${delegator}`, amount);
      rows.push({ delegator, validator_operator: v.operator, family, amount: amount.toString() });
      if (delegator === v.account) self = amount;
    }
  }
  return { pool, commission, self };
}

function checkAgainstChain(
  fail: (msg: string) => Error,
  derivedVrd: Map<string, DerivedVrd>,
  emitted: ReadonlyMap<string, bigint>,
  batchByRecipient: ReadonlyMap<string, bigint>,
  vrd: ReadonlyArray<VrdTotals>
): void {
  for (const e of vrd) {
    const key = `${e.family}|${e.account}`;
    const d = derivedVrd.get(key);
    if (!d || d.pool !== e.pool || d.commission !== e.commission || d.self !== e.self) {
      const got = d ? `pool ${d.pool} commission ${d.commission} self ${d.self}` : "no pool share";
      throw fail(
        `validator ${e.account} (${e.family}): derived ${got}, the chain emitted pool ${e.pool} ` +
          `commission ${e.commission} self ${e.self}`
      );
    }
    derivedVrd.delete(key);
  }
  if (derivedVrd.size > 0) {
    throw fail(`validators with a derived pool share but no distribution event: ${[...derivedVrd.keys()].join(", ")}`);
  }
  for (const key of new Set([...emitted.keys(), ...batchByRecipient.keys()])) {
    const got = emitted.get(key) ?? ZERO;
    const want = batchByRecipient.get(key) ?? ZERO;
    if (got !== want) throw fail(`recipient ${key}: derived ${got}, batch ${want}`);
  }
}

export function deriveDelegatorValidator(
  height: number,
  validators: ReadonlyArray<De2Validator>,
  totals: ReadonlyMap<string, bigint>,
  batchByRecipient: ReadonlyMap<string, bigint>,
  vrd: ReadonlyArray<VrdTotals>
): De2Row[] {
  const rows: De2Row[] = [];
  const emitted = new Map<string, bigint>();
  const derivedVrd = new Map<string, DerivedVrd>();
  const add = (key: string, v: bigint) => emitted.set(key, (emitted.get(key) ?? ZERO) + v);

  for (const [family, r] of totals) {
    const pools = largestRemainder(new Map(validators.map((v) => [v.account, v.tokens])), r);
    for (const v of validators) {
      const d = splitValidator(v, family, pools.get(v.account) as bigint, rows, add);
      if (d.pool > ZERO) derivedVrd.set(`${family}|${v.account}`, d);
    }
  }
  checkAgainstChain((msg) => new Error(`[de2] height ${height}: ${msg}`), derivedVrd, emitted, batchByRecipient, vrd);
  return rows;
}

// addDelegatorValidator fills payload.dv for a settlement that pays validators and delegators, from the
// bonded validators and their delegations at the settlement height. A settlement with no staker rows
// (beta's claims are too small for the proposer share to reach 1 upokt) has nothing to split.
export function addDelegatorValidator(
  height: number,
  payload: SettlementPayload,
  validators: ReadonlyArray<De2Validator> | null
): void {
  const totals = new Map<string, bigint>();
  const byRecipient = new Map<string, bigint>();
  for (const b of payload.batch) {
    if (b.op_type !== "mod_to_acct" || (b.role !== "validator" && b.role !== "delegator")) continue;
    const amount = BigInt(b.amount);
    totals.set(b.family, (totals.get(b.family) ?? ZERO) + amount);
    const key = `${b.family}|${b.recipient_id}`;
    byRecipient.set(key, (byRecipient.get(key) ?? ZERO) + amount);
  }
  if (totals.size === 0 && payload.vrd.length === 0) return;
  if (!validators) throw new Error(`[de2] height ${height}: staker rewards but no delegation snapshot`);
  const vrd = payload.vrd.map((v) => {
    // every EventValidatorRewardDistribution carries its commission; null is only the replayed eras'
    if (v.commission === null) {
      throw new Error(`[de2] height ${height}: validator ${v.validator_operator} has no commission`);
    }
    return {
      family: v.family,
      account: v.validator_account,
      pool: BigInt(v.pool_share),
      commission: BigInt(v.commission),
      self: BigInt(v.self_delegation),
    };
  });
  payload.dv = deriveDelegatorValidator(height, validators, totals, byRecipient, vrd);
}
