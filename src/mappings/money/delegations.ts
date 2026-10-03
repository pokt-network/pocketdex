// Pure helpers for the delegation history kept by reconcileValidators (src/mappings/pocket/validator.ts).
//
// A delegation's shares change only through x/staking's Delegate and Unbond (cosmos-sdk v0.53.7
// delegation.go), which back MsgDelegate, MsgUndelegate, MsgBeginRedelegate, MsgCancelUnbondingDelegation
// and the self-delegation of MsgCreateValidator, plus SlashRedelegation, which unbonds from the destination
// validator without emitting any staking event. Every one of them changes the validator's delegator_shares,
// which reconcileValidators already reads on every block, so a validator whose delegator_shares moved has
// its delegations re-read. The staking events of the block name the validators too: they cover two
// opposite moves in one block that leave delegator_shares where it was. Rewards are not compounded into
// shares, and slashes move tokens, not shares.

import { RawEvent } from "./payload";

export interface DelegationShares {
  delegator: string;
  shares: string;
  // the tokens the node reports for the delegation (LCD balance.amount), where it was read
  balance?: string;
}

export interface StoredDelegation extends DelegationShares {
  id: string;
}

export interface DelegationDiff {
  upserts: DelegationShares[];
  removes: string[];
}

const STAKING_EVENT_VALIDATOR_KEYS: Readonly<Record<string, ReadonlyArray<string>>> = {
  delegate: ["validator"],
  unbond: ["validator"],
  redelegate: ["source_validator", "destination_validator"],
  create_validator: ["validator"],
  cancel_unbonding_delegation: ["validator"],
};

// The event types stakingEventValidators reads: the caller filters a block's events by them before converting.
export const STAKING_EVENT_TYPES: ReadonlySet<string> = new Set(Object.keys(STAKING_EVENT_VALIDATOR_KEYS));

const UINT = /^\d+$/;

export function delegationId(validatorOperator: string, delegator: string): string {
  return `${validatorOperator}-${delegator}`;
}

// LegacyDec over gRPC is the atomic integer (value × 1e18) as a string.
export function parseShares(shares: string, where: string): string {
  if (!UINT.test(shares)) {
    throw new Error(`[delegations] ${where}: shares ${JSON.stringify(shares)} are not LegacyDec atomics`);
  }
  return shares;
}

// The validators named by the staking events of a block (any event kind).
export function stakingEventValidators(events: ReadonlyArray<RawEvent>): Set<string> {
  const out = new Set<string>();
  for (const e of events) {
    const keys = STAKING_EVENT_VALIDATOR_KEYS[e.type];
    if (!keys) continue;
    for (const a of e.attributes) {
      if (keys.includes(a.key) && a.value !== "") out.add(a.value.replace(/^"|"$/g, ""));
    }
  }
  return out;
}

// What to write so the stored delegations of one validator equal what the chain returned.
export function diffDelegations(
  validatorOperator: string,
  chain: ReadonlyArray<DelegationShares>,
  stored: ReadonlyArray<StoredDelegation>
): DelegationDiff {
  const byDelegator = new Map<string, string>();
  for (const c of chain) {
    if (byDelegator.has(c.delegator)) {
      throw new Error(`[delegations] validator ${validatorOperator}: delegator ${c.delegator} returned twice`);
    }
    byDelegator.set(c.delegator, parseShares(c.shares, `${validatorOperator}/${c.delegator}`));
  }
  const upserts: DelegationShares[] = [];
  const removes: string[] = [];
  const storedDelegators = new Set<string>();
  for (const s of stored) {
    storedDelegators.add(s.delegator);
    const shares = byDelegator.get(s.delegator);
    if (shares === undefined) removes.push(s.id);
    else if (shares !== s.shares) upserts.push({ delegator: s.delegator, shares });
  }
  for (const [delegator, shares] of byDelegator) {
    if (!storedDelegators.has(delegator)) upserts.push({ delegator, shares });
  }
  return { upserts, removes };
}
