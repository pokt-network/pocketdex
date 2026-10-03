// Replay of the chain's validator and delegator reward split for 288,180–788,944, where it emits no validator
// distribution (Q2/Q3; .local/ab/eras/REPLAY-validators.md, council11-synthesis.md). Pure: the bonded validators
// and their delegations at the height come in (the history job reads them from the LCD), the rows go out.
//
//   M3 (map_proposer_operator, v0.1.28)  everything to the block proposer's operator account: one validator, no
//                                         delegators. Exact.
//   M4/M5 (map_all_bonded*, v0.1.29–31)  per claim, the claim's proposer share R over every bonded stakeholder by
//                                         largest remainder, with the chain's overwrite (an address that delegates to
//                                         several validators counts only its last delegation in power order). The
//                                         amounts are checked per (claim, address) against the claim's bank legs; the
//                                         attribution to a validator is the chain's own (exact, though not observable
//                                         where two delegations carry the same tokens).
//   D (detailed_batch, v0.1.33)          once per height and family, the summed proposer shares over every bonded
//                                         stakeholder, delegations summed per address; checked per (address, family)
//                                         against the settlement batch. The chain never splits an address's amount per
//                                         validator: our split (largest remainder over its delegations) is derived.
//
// No commission is charged in these versions (poktroll v0.1.29 distribution_validator.go:25): commission is null,
// "not charged", never 0. R is computed from the claims and the params, never from the legs or the batch it is
// checked against. A difference from the chain's amounts is a fact of the chain this replay does not reproduce: the
// family is written unattributed (validator '', the chain's exact amounts) and flagged. Anything else throws.
import { fromBech32 } from "@cosmjs/encoding";
import { floorMul, MapClaimStakerLegs, parseRat } from "./map";
import type { DelegatorValidatorRow, SettlementPayload, VrdRow } from "./payload";

const ZERO = BigInt(0);
const ONE = BigInt(1);
// LegacyDec scale and the consensus power reduction (sdk DefaultPowerReduction, not redefined by poktroll)
const DEC = BigInt("1000000000000000000");
const HALF_DEC = DEC / BigInt(2);
const DEC_SQUARED = DEC * DEC;
const POWER_REDUCTION = BigInt(1000000);

export type Family = "relay" | "global";
export const FAMILIES: ReadonlyArray<Family> = ["relay", "global"];

// The validator reason of each family, the op_reason of a replayed validator row.
const VALIDATOR_REASON: Readonly<Record<Family, string>> = {
  relay: "TLM_RELAY_BURN_EQUALS_MINT_VALIDATOR_REWARD_DISTRIBUTION",
  global: "TLM_GLOBAL_MINT_VALIDATOR_REWARD_DISTRIBUTION",
};

export interface ReplayDelegation {
  delegator: string;
  // LegacyDec atomics
  shares: bigint;
  // the LCD's balance.amount, when it was read: the same SDK computation, checked against ours
  balance?: bigint;
}

// A bonded validator at the height.
export interface ReplayValidator {
  operator: string;
  // the account of the operator (AccAddress of the operator's bytes)
  account: string;
  tokens: bigint;
  // LegacyDec atomics
  delegatorShares: bigint;
  delegations: ReadonlyArray<ReplayDelegation>;
}

// SDK Validator.TokensFromShares(shares).TruncateInt(): LegacyDec MulInt, then Quo (multiplied by 1e36, truncated
// division, then chopPrecisionAndRound: the last 18 digits by banker's rounding), then truncated to an integer
// (cosmossdk.io/math v1.5.3 legacy_dec.go:383-391, 628-650; staking types/validator.go:307-309).
export function tokensFromShares(shares: bigint, tokens: bigint, delegatorShares: bigint): bigint {
  if (delegatorShares <= ZERO) throw new Error(`[replay] delegator shares ${delegatorShares} are not positive`);
  const q = (shares * tokens * DEC_SQUARED) / delegatorShares;
  let quo = q / DEC;
  const rem = q % DEC;
  if (rem > HALF_DEC || (rem === HALF_DEC && quo % BigInt(2) === ONE)) quo += ONE;
  return quo / DEC;
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i];
  return a.length - b.length;
}

// GetBondedValidatorsByPower: the power index iterated in reverse, i.e. consensus power (tokens / 1e6) descending,
// then the operator's raw bytes ascending (sdk staking keeper/validator.go:308-338, types/keys.go:113-143).
export function byPower(validators: ReadonlyArray<ReplayValidator>): ReplayValidator[] {
  const bytes = new Map(validators.map((v) => [v.operator, fromBech32(v.operator).data]));
  return [...validators].sort((a, b) => {
    const pa = a.tokens / POWER_REDUCTION;
    const pb = b.tokens / POWER_REDUCTION;
    if (pa !== pb) return pa > pb ? -1 : 1;
    return compareBytes(bytes.get(a.operator) as Uint8Array, bytes.get(b.operator) as Uint8Array);
  });
}

// One stakeholder: its stake and where it came from, per validator.
export interface Stake {
  stake: bigint;
  byValidator: Map<string, bigint>;
}

// discoverStakeholderStakes (distribution_validator.go): the total bonded tokens, and per address its stake. With
// `accumulate` false (v0.1.29–v0.1.31) a later delegation of the same address replaces the earlier one; true
// (v0.1.33) adds them. A validator with no delegations is staked on its own account by assignment in both.
export function collectStakes(
  validators: ReadonlyArray<ReplayValidator>,
  accumulate: boolean
): { stakes: Map<string, Stake>; total: bigint } {
  const stakes = new Map<string, Stake>();
  let total = ZERO;
  for (const v of byPower(validators)) {
    total += v.tokens;
    if (v.tokens === ZERO) continue;
    if (v.delegations.length === 0) {
      stakes.set(v.account, { stake: v.tokens, byValidator: new Map([[v.operator, v.tokens]]) });
      continue;
    }
    for (const d of v.delegations) {
      if (d.shares === ZERO) continue;
      const t = tokensFromShares(d.shares, v.tokens, v.delegatorShares);
      if (d.balance !== undefined && d.balance !== t) {
        throw new Error(
          `[replay] delegation ${d.delegator} → ${v.operator}: the LCD's balance ${d.balance} differs from ` +
            `TokensFromShares ${t}`
        );
      }
      if (t === ZERO) continue;
      const prev = stakes.get(d.delegator);
      if (accumulate && prev) {
        prev.stake += t;
        prev.byValidator.set(v.operator, (prev.byValidator.get(v.operator) ?? ZERO) + t);
      } else {
        stakes.set(d.delegator, { stake: t, byValidator: new Map([[v.operator, t]]) });
      }
    }
  }
  return { stakes, total };
}

// The chain's largest remainder method (v0.1.29–v0.1.33 distribution_validator.go, distribution_sorting.go): each key
// gets floor(stake · reward / total); the remainder goes to the keys with a non-zero fraction, ordered by fraction
// descending then key ascending (string order), floor(rem / n) each and one more to the first rem mod n. With no
// fraction anywhere the remainder is not paid.
export function largestRemainder(
  stakes: ReadonlyMap<string, bigint>,
  total: bigint,
  reward: bigint
): Map<string, bigint> {
  const out = new Map<string, bigint>();
  if (total <= ZERO) throw new Error(`[replay] cannot split ${reward} over a total of ${total}`);
  let paid = ZERO;
  const fractions: Array<{ key: string; num: bigint }> = [];
  for (const [key, s] of stakes) {
    const exact = s * reward;
    const base = exact / total;
    out.set(key, base);
    paid += base;
    const num = exact % total;
    if (num > ZERO) fractions.push({ key, num });
  }
  const rem = reward - paid;
  if (rem > ZERO && fractions.length > 0) {
    fractions.sort((a, b) => (a.num !== b.num ? (a.num > b.num ? -1 : 1) : a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    const n = BigInt(fractions.length);
    const each = rem / n;
    const extra = rem % n;
    fractions.forEach(({ key }, i) => out.set(key, (out.get(key) as bigint) + each + (BigInt(i) < extra ? ONE : ZERO)));
  }
  return out;
}

// How a family of a height was written.
export type ReplayMode = "replay" | "derived_split" | "unattributed";

export interface ReplayResult {
  vrd: Array<VrdRow & { row_source: ReplayMode }>;
  dv: Array<DelegatorValidatorRow & { row_source: ReplayMode }>;
  // per family with stakers paid: how it was written, and why when unattributed
  modes: Map<Family, { mode: ReplayMode; reason?: string; amount: bigint }>;
}

// The rows of one family from the amount each (address, validator) got: one validator row per validator with any
// payout (pool = all its addresses, self = its own account's), and the (address, validator) rows.
function rowsOf(
  family: Family,
  paid: ReadonlyMap<string, ReadonlyMap<string, bigint>>,
  validators: ReadonlyArray<ReplayValidator>,
  mode: ReplayMode,
  out: ReplayResult
): void {
  const perValidator = new Map<string, { pool: bigint; self: bigint; delegators: number }>();
  for (const [address, byValidator] of [...paid].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    for (const [operator, amount] of byValidator) {
      if (amount === ZERO) continue;
      out.dv.push({
        delegator: address,
        validator_operator: operator,
        family,
        amount: amount.toString(),
        row_source: mode,
      });
      const v = perValidator.get(operator) ?? { pool: ZERO, self: ZERO, delegators: 0 };
      v.pool += amount;
      if (validators.find((x) => x.operator === operator)?.account === address) v.self += amount;
      else v.delegators++;
      perValidator.set(operator, v);
    }
  }
  for (const v of byPower(validators)) {
    const t = perValidator.get(v.operator);
    if (!t) continue;
    out.vrd.push({
      // synthetic, negative: no event carries the row; unique per (validator, family) within the height
      event_idx: -(out.vrd.length + 1),
      op_reason: VALIDATOR_REASON[family],
      family,
      validator_operator: v.operator,
      validator_account: v.account,
      commission_rate: null,
      pool_share: t.pool.toString(),
      commission: null,
      self_delegation: t.self.toString(),
      delegators: (t.pool - t.self).toString(),
      total_delegated_stake: v.tokens.toString(),
      num_delegators: String(t.delegators),
      row_source: mode,
    });
  }
}

// The chain's amounts of a family, written without a validator: what an unattributed family keeps.
function unattributed(family: Family, amounts: ReadonlyMap<string, bigint>, reason: string, out: ReplayResult): void {
  let total = ZERO;
  for (const [address, amount] of [...amounts].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (amount === ZERO) continue;
    total += amount;
    out.dv.push({
      delegator: address,
      validator_operator: "",
      family,
      amount: amount.toString(),
      row_source: "unattributed",
    });
  }
  out.modes.set(family, { mode: "unattributed", reason, amount: total });
}

const sumOf = (m: ReadonlyMap<string, bigint>) => [...m.values()].reduce((a, x) => a + x, ZERO);

function sameAmounts(a: ReadonlyMap<string, bigint>, b: ReadonlyMap<string, bigint>): string | null {
  for (const k of new Set([...a.keys(), ...b.keys()])) {
    const x = a.get(k) ?? ZERO;
    const y = b.get(k) ?? ZERO;
    if (x !== y) return `${k}: replay ${x}, chain ${y}`;
  }
  return null;
}

// M3: the proposer's operator gets every staker leg of every claim (the legs are checked against the proposer's
// account by the map decoding).
export function replayM3(proposer: ReplayValidator, legs: ReadonlyMap<Family, bigint>): ReplayResult {
  const out: ReplayResult = { vrd: [], dv: [], modes: new Map() };
  for (const family of FAMILIES) {
    const amount = legs.get(family) ?? ZERO;
    if (amount === ZERO) continue;
    rowsOf(family, new Map([[proposer.account, new Map([[proposer.operator, amount]])]]), [proposer], "replay", out);
    out.modes.set(family, { mode: "replay", amount });
  }
  return out;
}

// One claim of M4/M5: its proposer shares R per family, from the claim's mint and the params, and what the bank paid
// each staker address for it.
export interface MapClaimStakers {
  event_idx: number;
  reward: ReadonlyMap<Family, bigint>;
  legs: ReadonlyMap<Family, ReadonlyMap<string, bigint>>;
}

// M4/M5: per claim, R over the stakes with overwrite; per (claim, address) equal to the legs.
export function replayMap(
  height: number,
  claims: ReadonlyArray<MapClaimStakers>,
  validators: ReadonlyArray<ReplayValidator>
): ReplayResult {
  const out: ReplayResult = { vrd: [], dv: [], modes: new Map() };
  const { stakes, total } = collectStakes(validators, false);
  const weights = new Map([...stakes].map(([a, s]) => [a, s.stake]));
  for (const family of FAMILIES) {
    const paid = new Map<string, Map<string, bigint>>();
    const chain = new Map<string, bigint>();
    let mismatch: string | null = null;
    for (const c of claims) {
      const legs = c.legs.get(family) ?? new Map<string, bigint>();
      for (const [a, x] of legs) chain.set(a, (chain.get(a) ?? ZERO) + x);
      const r = c.reward.get(family) ?? ZERO;
      const got = r === ZERO ? new Map<string, bigint>() : largestRemainder(weights, total, r);
      const diff = sameAmounts(got, legs);
      if (diff !== null) {
        mismatch ??= `height ${height} event ${c.event_idx} ${family}: ${diff}`;
        continue;
      }
      for (const [a, x] of got) {
        if (x === ZERO) continue;
        // the overwrite leaves one delegation per address: the validator it was paid through
        const [operator] = (stakes.get(a) as Stake).byValidator.keys();
        const byValidator = paid.get(a) ?? new Map<string, bigint>();
        byValidator.set(operator, (byValidator.get(operator) ?? ZERO) + x);
        paid.set(a, byValidator);
      }
    }
    // checked before the empty case: a share R > 0 the chain paid nobody is a difference, not "nothing to do"
    if (mismatch !== null) {
      unattributed(family, chain, mismatch, out);
      continue;
    }
    if (sumOf(chain) === ZERO) continue;
    rowsOf(family, paid, validators, "replay", out);
    out.modes.set(family, { mode: "replay", amount: sumOf(chain) });
  }
  return out;
}

// D: per family, the height's summed R over the stakes accumulated per address; per (address, family) equal to the
// batch. Each address's amount is then split over the validators it delegates to by largest remainder over its
// tokens with each (ties by operator): a derived split, marked so.
export function replayD(
  height: number,
  reward: ReadonlyMap<Family, bigint>,
  batch: ReadonlyMap<Family, ReadonlyMap<string, bigint>>,
  validators: ReadonlyArray<ReplayValidator>
): ReplayResult {
  const out: ReplayResult = { vrd: [], dv: [], modes: new Map() };
  const { stakes, total } = collectStakes(validators, true);
  const weights = new Map([...stakes].map(([a, s]) => [a, s.stake]));
  // FlushBatchedValidatorRewards distributes the families in op_reason order; each distribution reads the same
  // stakes and is independent of the others, so the order changes no amount
  for (const family of FAMILIES) {
    const chain = batch.get(family) ?? new Map<string, bigint>();
    const r = reward.get(family) ?? ZERO;
    if (r === ZERO && sumOf(chain) === ZERO) continue;
    const got = r === ZERO ? new Map<string, bigint>() : largestRemainder(weights, total, r);
    const diff = sameAmounts(got, chain);
    if (diff !== null) {
      unattributed(family, chain, `height ${height} ${family}: ${diff}`, out);
      continue;
    }
    const paid = new Map<string, Map<string, bigint>>();
    for (const [a, x] of got) {
      if (x === ZERO) continue;
      const s = stakes.get(a) as Stake;
      paid.set(a, largestRemainder(s.byValidator, s.stake, x));
    }
    rowsOf(family, paid, validators, "derived_split", out);
    out.modes.set(family, { mode: "derived_split", amount: sumOf(chain) });
  }
  return out;
}

// The eras whose validator rows are replayed here.
export const REPLAY_ERAS: ReadonlySet<string> = new Set([
  "map_proposer_operator",
  "map_all_bonded",
  "map_all_bonded_deflation",
  "detailed_batch",
]);

export interface ReplayInput {
  // the bonded validators at the height, each with every delegation
  validators: ReadonlyArray<ReplayValidator>;
  // map_proposer_operator: the block proposer's validator, in any status
  proposer?: ReplayValidator;
  // the map eras: each claim's staker share and legs (buildSettlementPayload's sink)
  mapStakers?: ReadonlyArray<MapClaimStakerLegs>;
  // detailed_batch: the proposer's share of the relay mint (mint_equals_burn_claim_distribution.proposer) and of the
  // global mint (mint_allocation_percentages.proposer), as the params hold them
  proposerShares?: { relay: string; global: string };
}

// addReplay fills a replayed era's validator rows (payload.vrd) and (address, validator) rows (payload.dv), and returns
// how each family was written.
// M3: each family's legs, summed over the claims; every one must be the proposer's.
function proposerLegs(height: number, input: ReplayInput): { proposer: ReplayValidator; legs: Map<Family, bigint> } {
  if (!input.proposer || !input.mapStakers) {
    throw new Error(`[replay] height ${height}: M3 needs the proposer and the legs`);
  }
  const legs = new Map<Family, bigint>();
  for (const c of input.mapStakers) {
    for (const [family, byAddress] of c.legs) {
      for (const [address, amount] of byAddress) {
        if (address !== input.proposer.account) {
          throw new Error(
            `[replay] height ${height} event ${c.event_idx}: a staker leg to ${address}, not the proposer`
          );
        }
        legs.set(family, (legs.get(family) ?? ZERO) + amount);
      }
    }
  }
  return { proposer: input.proposer, legs };
}

// D: the share of each family from the claims and the params, and what the batch paid each staker.
function detailedInput(
  height: number,
  payload: SettlementPayload,
  input: ReplayInput
): { reward: Map<Family, bigint>; batch: Map<Family, Map<string, bigint>> } {
  const shares = input.proposerShares;
  if (!shares) throw new Error(`[replay] height ${height}: detailed_batch needs the proposer's shares`);
  // v0.1.33 pays no global staker share on mainnet; a non-zero one would be a family this replay does not compute
  if (parseRat(shares.global, "mint_allocation_percentages.proposer").num !== ZERO) {
    throw new Error(
      `[replay] height ${height}: the global mint gives the proposer ${shares.global}, which D never paid`
    );
  }
  const p = parseRat(shares.relay, "mint_equals_burn_claim_distribution.proposer");
  const reward = new Map<Family, bigint>([
    ["relay", payload.claims.reduce((a, c) => a + floorMul(BigInt(c.minted), p), ZERO)],
  ]);
  const batch = new Map<Family, Map<string, bigint>>();
  for (const b of payload.batch) {
    if (b.op_type !== "mod_to_acct" || (b.role !== "validator" && b.role !== "delegator")) continue;
    const family = b.family as Family;
    const m = batch.get(family) ?? new Map<string, bigint>();
    m.set(b.recipient_id, (m.get(b.recipient_id) ?? ZERO) + BigInt(b.amount));
    batch.set(family, m);
  }
  return { reward, batch };
}

// addReplay fills a replayed era's validator rows (payload.vrd) and (address, validator) rows (payload.dv), and returns
// how each family was written.
export function addReplay(height: number, payload: SettlementPayload, input: ReplayInput): ReplayResult["modes"] {
  let r: ReplayResult;
  const era = payload.era;
  if (era === "map_proposer_operator") {
    const { legs, proposer } = proposerLegs(height, input);
    r = replayM3(proposer, legs);
  } else if (era === "map_all_bonded" || era === "map_all_bonded_deflation") {
    if (!input.mapStakers) throw new Error(`[replay] height ${height}: ${era} needs each claim's staker legs`);
    r = replayMap(height, input.mapStakers, input.validators);
  } else if (era === "detailed_batch") {
    const { batch, reward } = detailedInput(height, payload, input);
    r = replayD(height, reward, batch, input.validators);
  } else {
    throw new Error(`[replay] height ${height}: era ${era} is not replayed`);
  }
  payload.vrd = r.vrd;
  payload.dv = r.dv;
  return r.modes;
}
