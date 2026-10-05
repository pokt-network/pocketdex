// The map era (poktroll v0.1.27–v0.1.32, mainnet 247,893–703,869): EventClaimSettled carries one total per
// recipient (reward_distribution) and no reasons, so each slice is read from the claim's bank legs (./bank.ts) by
// POSITION, with every amount checked against the formula of the chain's params at the height.
//
// Per claim the module → account legs come in the order the token logic modules queue them (TLMs run relay burn =
// mint, global mint, reimbursement: x/tokenomics/token_logic_module/types.go:99-105 at v0.1.27):
//   relay  (tlm_relay_burn_equals_mint.go:175-252): shareholders (sent by the supplier module), proposer — from
//          v0.1.29 every bonded validator and delegator (:205-220 there, distribution_validator.go) —, source owner,
//          DAO, application;
//   global (tlm_global_mint.go:166-250): shareholders (supplier module), application, source owner, proposer, DAO;
//   reimbursement (tlm_reimbursement_requests.go): the escrow G to the DAO.
// The slices are floor(amount × pct) (calculateAllocationAmount, tlm_global_mint.go:288-296) and the DAO takes the
// remainder (tlm_relay_burn_equals_mint.go:169, tlm_global_mint.go:235); zero slices emit no leg. The relay amount
// is M = S before v0.1.31 and floor(S × mint_ratio) after; G = ceil(S × global_inflation_per_claim)
// (CalculateGlobalPerClaimMintInflationFromSettlementAmount). Percentages are float64 params, which the chain turns
// into the rational of their shortest decimal text (pkg/encoding/decimal.go Float64ToRat).
// Measured: the walk is exact on 14,846/14,846 claims of 250053, 260013, 270033, 300033, 350013, 430053 and 699993
// (.local/ab/eras/map_positional.py).
import { sha256 } from "@cosmjs/crypto";
import { fromBech32, toBech32, toHex } from "@cosmjs/encoding";
import { PREFIX } from "../constants";
import { ClaimBank, Leg, SUPPLIER_MODULE, TOKENOMICS_MODULE } from "./bank";
import type { BatchRow, DetailedRow } from "./payload";
import { REASONS } from "./reasons";

// The four allocated shares of a split; the DAO takes what they leave. Decimal text, as the params hold them.
export interface MapShares {
  supplier: string;
  proposer: string;
  source_owner: string;
  application: string;
}

// The chain state a map-era height needs, as the chain used it at the height: the tokenomics params, and for the
// stakers the proposer's account (map_proposer_consensus, map_proposer_operator) or the bonded validators'
// accounts (map_all_bonded*), which decide role validator against delegator.
export interface MapState {
  meb: MapShares; // mint_equals_burn_claim_distribution
  mintAlloc: MapShares; // mint_allocation_percentages
  globalInflation: string; // global_inflation_per_claim
  mintRatio: string; // mint_ratio; 0 (absent before v0.1.31) means 1
  dao: string; // dao_reward_address
  proposerAccount?: string;
  validatorAccounts?: ReadonlySet<string>;
}

// proposerOperatorAccount is the account of the block proposer's operator in map_proposer_operator (poktroll v0.1.28,
// which looks the validator up by consensus address with GetValidatorByConsAddr, block_proposer.go:13-23, whatever its status: a proposer that
// leaves the bonded set in the same block is still found). The consensus address is sha256 of the ed25519 key, first
// 20 bytes; the key is the consensus_pubkey Any's PubKey message (field 1, 32 bytes).
export function proposerOperatorAccount(
  validators: ReadonlyArray<{ operatorAddress: string; consensusPubkey?: { value: Uint8Array } }>,
  proposer: Uint8Array
): string {
  const want = toHex(proposer);
  const v = validators.find((x) => {
    const key = x.consensusPubkey?.value;
    return key?.length === 34 && key[0] === 0x0a && key[1] === 32 && toHex(sha256(key.slice(2)).slice(0, 20)) === want;
  });
  if (!v) throw new Error(`[money] no validator has the consensus address of proposer ${want}`);
  return toBech32(PREFIX, fromBech32(v.operatorAddress).data);
}

interface Rat {
  num: bigint;
  den: bigint;
}

// A non-negative decimal as a rational: "0.045", "1", "1e-06" (the shortest text of a float64).
export function parseRat(text: string, what: string): Rat {
  const m = /^(\d+)(?:\.(\d+))?(?:e-(\d+))?$/.exec(text);
  if (!m) throw new Error(`[money] ${what} is not a non-negative decimal: ${JSON.stringify(text)}`);
  const frac = m[2] ?? "";
  const exp = frac.length + Number(m[3] ?? 0);
  return { num: BigInt(m[1] + frac), den: BigInt(10) ** BigInt(exp) };
}

export const floorMul = (x: bigint, r: Rat): bigint => (x * r.num) / r.den;
const ceilMul = (x: bigint, r: Rat) => (x * r.num + r.den - BigInt(1)) / r.den;
const ZERO = BigInt(0);

const ERA_STAKERS: Readonly<Record<string, "proposer" | "none" | "bonded">> = {
  map_proposer_consensus: "proposer",
  map_no_stakers: "none",
  map_proposer_operator: "proposer",
  map_all_bonded: "bonded",
  map_all_bonded_deflation: "bonded",
};

export function isMapEra(era: string): boolean {
  return era in ERA_STAKERS;
}

export interface MapClaim {
  event_idx: number;
  application_id: string;
  claimed: bigint;
  // reward_distribution: recipient → amount, non-zero entries
  map: ReadonlyMap<string, bigint>;
}

// One claim's staker share and what the bank paid each staker for it, per family: the replay's input (replay.ts).
// The share is the formula's (floor(M · proposer), floor(G · proposer)), from the claim's mints and the params.
export interface MapClaimStakerLegs {
  event_idx: number;
  reward: Map<"relay" | "global", bigint>;
  legs: Map<"relay" | "global", Map<string, bigint>>;
}

export interface MapClaimAmounts {
  settled: bigint;
  minted: bigint;
  globalMint: bigint;
  // the relay staker slice, floor(M · proposer)
  relayToStakers: bigint;
  // what the global shareholder legs paid beyond their slice (a shareholder address listed twice); 0 otherwise
  globalOverpaid: bigint;
}

// decodeMapClaims checks every claim's bank legs against its map entry and the formula slices, and returns the
// claim legs (detailed rows, as the later eras name them) and the staker legs aggregated per (recipient, family)
// into batch-shaped rows with event_idx -1: no single event carries them, and per claim they would be ~840k rows
// at 699993. Any difference stops the height.
export function decodeMapClaims(
  height: number,
  era: string,
  claims: ReadonlyArray<MapClaim>,
  banks: ReadonlyArray<ClaimBank>,
  reimbursements: ReadonlyArray<bigint>,
  state: MapState | undefined
): { amounts: MapClaimAmounts[]; detailed: DetailedRow[]; stakers: BatchRow[]; claimStakers: MapClaimStakerLegs[] } {
  const stakersMode = ERA_STAKERS[era];
  if (!stakersMode) throw new Error(`[money] height ${height}: ${era} is not a map era`);
  if (!state) throw new Error(`[money] height ${height}: era ${era} needs the map state (params at the height)`);
  if (stakersMode === "proposer" && !state.proposerAccount) {
    throw new Error(`[money] height ${height}: era ${era} needs the block proposer's account`);
  }
  if (stakersMode === "bonded" && !state.validatorAccounts) {
    throw new Error(`[money] height ${height}: era ${era} needs the bonded validators' accounts`);
  }
  const share = (s: MapShares, what: string) => ({
    supplier: parseRat(s.supplier, `${what}.supplier`),
    proposer: parseRat(s.proposer, `${what}.proposer`),
    source_owner: parseRat(s.source_owner, `${what}.source_owner`),
    application: parseRat(s.application, `${what}.application`),
  });
  const meb = share(state.meb, "mint_equals_burn_claim_distribution");
  const alloc = share(state.mintAlloc, "mint_allocation_percentages");
  if (stakersMode === "none" && (meb.proposer.num !== ZERO || alloc.proposer.num !== ZERO)) {
    throw new Error(`[money] height ${height}: era ${era} pays no stakers, but the params give the proposer a share`);
  }
  const gi = parseRat(state.globalInflation, "global_inflation_per_claim");
  const ratio = parseRat(state.mintRatio, "mint_ratio");
  const oneToOne = ratio.num === ZERO || ratio.num === ratio.den;

  const detailed: DetailedRow[] = [];
  const stakers = new Map<string, BatchRow & { claims: Set<number> }>();
  const claimStakers: MapClaimStakerLegs[] = [];
  const amounts = claims.map((c, k) => {
    const b = banks[k];
    const fail = (msg: string) => new Error(`[money] height ${height} event ${c.event_idx}: map claim ${msg}`);
    const S = b.burn;
    const M = oneToOne ? S : floorMul(S, ratio);
    const G = ceilMul(S, gi);
    if (S > c.claimed) throw fail(`burns ${S}, more than it claimed (${c.claimed})`);
    if (b.relayMint !== M || b.globalMint !== G) {
      throw fail(`mints (${b.relayMint}, ${b.globalMint}), expected (${M}, ${G})`);
    }
    if (reimbursements[k] !== G) {
      throw fail(`reimbursement request ${reimbursements[k]} differs from the global mint ${G}`);
    }

    const slices = (x: bigint, s: ReturnType<typeof share>) => {
      const out = {
        supplier: floorMul(x, s.supplier),
        proposer: floorMul(x, s.proposer),
        source_owner: floorMul(x, s.source_owner),
        application: floorMul(x, s.application),
        dao: ZERO,
      };
      out.dao = x - out.supplier - out.proposer - out.source_owner - out.application;
      return out;
    };
    const rel = slices(M, meb);
    const glo = slices(G, alloc);
    let j = 0;
    const legs = b.legs;
    // the legs from `sender` summing to `amount`: one leg unless `multi`, to `to` when given
    const takeLegs = (what: string, amount: bigint, sender: string, multi: boolean, to?: string): Leg[] => {
      if (amount === ZERO) return [];
      const got: Leg[] = [];
      let sum = ZERO;
      while (sum < amount && j < legs.length && legs[j].sender === sender && (multi || got.length === 0)) {
        sum += legs[j].amount;
        got.push(legs[j++]);
      }
      if (sum !== amount) throw fail(`${what}: the bank legs at position ${j} do not pay the formula amount ${amount}`);
      if (to !== undefined && got.some((l) => l.recipient !== to)) throw fail(`${what} is not paid to ${to}`);
      return got;
    };
    // The shareholder legs. poktroll v0.1.29–v0.1.33 pays each rev-share ENTRY the amount of its address in a map keyed
    // by address (x/tokenomics/token_logic_module/distribution_supplier.go:27-50, :88 at v0.1.33): an address listed
    // twice is paid its last entry's amount once per entry, so the legs differ from the slice (mainnet 690,685–716,533,
    // one supplier). Only then may they: every supplier module leg at the position is the shareholders', and a
    // recipient must repeat with equal legs.
    const overpaid = { relay: ZERO, global: ZERO };
    const takeShareholders = (family: "relay" | "global", amount: bigint): Leg[] => {
      if (amount === ZERO) return [];
      const start = j;
      let sum = ZERO;
      while (sum < amount && j < legs.length && legs[j].sender === SUPPLIER_MODULE) sum += legs[j++].amount;
      if (sum !== amount) {
        while (j < legs.length && legs[j].sender === SUPPLIER_MODULE) sum += legs[j++].amount;
        const byRecipient = new Map<string, bigint[]>();
        for (const l of legs.slice(start, j)) {
          byRecipient.set(l.recipient, [...(byRecipient.get(l.recipient) ?? []), l.amount]);
        }
        const repeated = [...byRecipient.values()].filter((a) => a.length > 1);
        if (repeated.length === 0 || repeated.some((a) => a.some((x) => x !== a[0]))) {
          throw fail(`${family} shareholders: the bank legs at position ${j} do not pay the formula amount ${amount}`);
        }
        overpaid[family] = sum - amount;
      }
      return legs.slice(start, j);
    };
    const legRow = (l: Leg, reason: string) => {
      const info = REASONS[reason];
      detailed.push({
        event_idx: c.event_idx,
        recipient_id: l.recipient,
        op_reason: reason,
        role: info.role,
        family: info.family,
        amount: l.amount.toString(),
      });
    };
    const mine: MapClaimStakerLegs = {
      event_idx: c.event_idx,
      reward: new Map([
        ["relay", rel.proposer],
        ["global", glo.proposer],
      ]),
      legs: new Map(),
    };
    claimStakers.push(mine);
    const stakerRows = (got: Leg[], family: "relay" | "global") => {
      const legs = mine.legs.get(family) ?? new Map<string, bigint>();
      mine.legs.set(family, legs);
      for (const l of got) {
        legs.set(l.recipient, (legs.get(l.recipient) ?? ZERO) + l.amount);
        let reason: string;
        if (stakersMode === "proposer") {
          if (l.recipient !== state.proposerAccount) {
            throw fail(`proposer leg paid to ${l.recipient}, not the proposer`);
          }
          reason =
            family === "relay"
              ? "TLM_RELAY_BURN_EQUALS_MINT_PROPOSER_REWARD_DISTRIBUTION"
              : "TLM_GLOBAL_MINT_PROPOSER_REWARD_DISTRIBUTION";
        } else {
          // distribution_validator.go:445-462 at v0.1.29: a bonded validator's account is paid as validator
          const v = state.validatorAccounts?.has(l.recipient) ? "VALIDATOR" : "DELEGATOR";
          reason =
            family === "relay"
              ? `TLM_RELAY_BURN_EQUALS_MINT_${v}_REWARD_DISTRIBUTION`
              : `TLM_GLOBAL_MINT_${v}_REWARD_DISTRIBUTION`;
        }
        const key = `${l.recipient}|${family}`;
        const row = stakers.get(key);
        if (row) {
          row.amount = (BigInt(row.amount) + l.amount).toString();
          row.claims.add(c.event_idx);
        } else {
          const info = REASONS[reason];
          stakers.set(key, {
            event_idx: -1,
            op_type: "mod_to_acct",
            op_reason: reason,
            sender_module: "tokenomics",
            recipient_id: l.recipient,
            role: info.role,
            family,
            amount: l.amount.toString(),
            num_claims: "",
            claims: new Set([c.event_idx]),
          });
        }
      }
    };
    const multi = stakersMode === "bonded";
    for (const l of takeShareholders("relay", rel.supplier)) {
      legRow(l, "TLM_RELAY_BURN_EQUALS_MINT_SUPPLIER_SHAREHOLDER_REWARD_DISTRIBUTION");
    }
    stakerRows(takeLegs("relay stakers", rel.proposer, TOKENOMICS_MODULE, multi), "relay");
    const owner = takeLegs("relay source owner", rel.source_owner, TOKENOMICS_MODULE, false);
    owner.forEach((l) => legRow(l, "TLM_RELAY_BURN_EQUALS_MINT_SOURCE_OWNER_REWARD_DISTRIBUTION"));
    for (const l of takeLegs("relay DAO", rel.dao, TOKENOMICS_MODULE, false, state.dao)) {
      legRow(l, "TLM_RELAY_BURN_EQUALS_MINT_DAO_REWARD_DISTRIBUTION");
    }
    for (const l of takeLegs("relay application", rel.application, TOKENOMICS_MODULE, false, c.application_id)) {
      legRow(l, "TLM_RELAY_BURN_EQUALS_MINT_APPLICATION_REWARD_DISTRIBUTION");
    }
    for (const l of takeShareholders("global", glo.supplier)) {
      legRow(l, "TLM_GLOBAL_MINT_SUPPLIER_SHAREHOLDER_REWARD_DISTRIBUTION");
    }
    for (const l of takeLegs("global application", glo.application, TOKENOMICS_MODULE, false, c.application_id)) {
      legRow(l, "TLM_GLOBAL_MINT_APPLICATION_REWARD_DISTRIBUTION");
    }
    // the owner's global leg is checked against its relay leg; with no relay leg there is nothing to check it
    // against (not seen: a global owner slice needs G >= 10, so S >= 9e6 and a relay slice far above 1)
    if (owner.length === 0 && glo.source_owner > ZERO) throw fail("global source owner slice without a relay one");
    const ownerTo = owner.length > 0 ? owner[0].recipient : undefined;
    for (const l of takeLegs("global source owner", glo.source_owner, TOKENOMICS_MODULE, false, ownerTo)) {
      legRow(l, "TLM_GLOBAL_MINT_SOURCE_OWNER_REWARD_DISTRIBUTION");
    }
    stakerRows(takeLegs("global stakers", glo.proposer, TOKENOMICS_MODULE, multi), "global");
    for (const l of takeLegs("global DAO", glo.dao, TOKENOMICS_MODULE, false, state.dao)) {
      legRow(l, "TLM_GLOBAL_MINT_DAO_REWARD_DISTRIBUTION");
    }
    for (const l of takeLegs("escrow", G, TOKENOMICS_MODULE, false, state.dao)) {
      legRow(l, "TLM_GLOBAL_MINT_REIMBURSEMENT_REQUEST_ESCROW_DAO_TRANSFER");
    }
    if (j !== legs.length) throw fail(`${legs.length - j} bank legs left after the escrow`);
    const mapTotal = [...c.map.values()].reduce((a, x) => a + x, ZERO);
    const want = M + BigInt(2) * G + overpaid.relay + overpaid.global;
    if (mapTotal !== want) {
      throw fail(`reward_distribution sums to ${mapTotal}, expected M + 2G (+ shareholders overpaid) = ${want}`);
    }
    return { settled: S, minted: M, globalMint: G, relayToStakers: rel.proposer, globalOverpaid: overpaid.global };
  });
  const rows = [...stakers.values()].map(({ claims: n, ...row }) => ({ ...row, num_claims: String(n.size) }));
  return { amounts, detailed, stakers: rows, claimStakers };
}
