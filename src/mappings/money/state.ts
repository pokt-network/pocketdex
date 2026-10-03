// The chain state a settlement height is parsed with, built from plain inputs: the era, the tokenomics params and
// the validators at the height. Pure (no SubQuery globals), so the indexer (./write.ts) and the history job
// (./history) build it with the same code.
import { fromBech32, toBech32 } from "@cosmjs/encoding";
import { BondStatus, Validator as ChainValidator } from "../../client/cosmos/staking/v1beta1/staking";
import { PREFIX } from "../constants";
import { eraAtHeight, SETTLEMENT_ERAS } from "../utils/params_history";
import type { De2Validator } from "./de2";
import { DelegationShares, parseShares } from "./delegations";
import { MapShares, MapState, proposerOperatorAccount } from "./map";
import type { ReplayValidator } from "./replay";

const KNOWN_ERAS: ReadonlySet<string> = new Set(
  Object.values(SETTLEMENT_ERAS).flatMap((eras) => (eras ?? []).map((e) => e.era))
);

// settlementEra is the settlement era of `height`: POCKETDEX_SETTLEMENT_ERA when set, for every height, else
// eraAtHeight. The override is for localnet, which runs as chain id "pocket" from a recent poktroll: its low
// heights emit batched_vrd events that the mainnet table would label settlement_result. It must never be set in
// a production deployment: there it would label every height of the chain with one era.
export function settlementEra(chainId: string, height: number, env: NodeJS.ProcessEnv = process.env): string {
  const override = env.POCKETDEX_SETTLEMENT_ERA;
  if (!override) return eraAtHeight(chainId, height);
  if (!KNOWN_ERAS.has(override)) {
    throw new Error(`POCKETDEX_SETTLEMENT_ERA "${override}" is not a settlement era (${[...KNOWN_ERAS].join(", ")})`);
  }
  return override;
}

// The tokenomics params a map-era height reads, by key.
export const MAP_PARAM_KEYS = [
  "mint_equals_burn_claim_distribution",
  "mint_allocation_percentages",
  "global_inflation_per_claim",
  "mint_ratio",
  "dao_reward_address",
] as const;

// mapStateFrom is the state of a map-era height from the tokenomics params in force at it (values as the params
// table stores them), the block proposer's consensus address and the chain's validators at the height. Percentages
// are JSON numbers; their JS text is the shortest decimal, as Float64ToRat reads it.
export function mapStateFrom(
  params: Readonly<Record<typeof MAP_PARAM_KEYS[number], string>>,
  era: string,
  proposer: Uint8Array,
  validators: ReadonlyArray<ChainValidator> | undefined
): MapState {
  const shares = (raw: string): MapShares => {
    const o = JSON.parse(raw) as Record<string, number | string>;
    const text = (k: string) => {
      const v = o[k];
      if (v === undefined) throw new Error(`[money] allocation ${raw} has no ${k}`);
      return String(v);
    };
    return {
      supplier: text("supplier"),
      proposer: text("proposer"),
      source_owner: text("source_owner"),
      application: text("application"),
    };
  };
  const state: MapState = {
    meb: shares(params.mint_equals_burn_claim_distribution),
    mintAlloc: shares(params.mint_allocation_percentages),
    globalInflation: String(Number(params.global_inflation_per_claim)),
    mintRatio: String(Number(params.mint_ratio)),
    dao: params.dao_reward_address,
  };
  const bonded = (validators ?? []).filter((v) => v.status === BondStatus.BOND_STATUS_BONDED);
  if (era === "map_proposer_consensus") {
    // v0.1.27: the proposer's share went to the account of its consensus address (tlm_relay_burn_equals_mint.go:207)
    state.proposerAccount = toBech32(PREFIX, proposer);
  } else if (era === "map_proposer_operator") {
    state.proposerAccount = proposerOperatorAccount(validators ?? [], proposer);
  } else if (validators) {
    state.validatorAccounts = new Set(bonded.map((v) => toBech32(PREFIX, fromBech32(v.operatorAddress).data)));
  }
  return state;
}

// The bonded validators, with their delegations, in the shape the delegator × validator split takes; null without
// a delegation read.
export function de2Validators(
  chainValidators: ReadonlyArray<ChainValidator>,
  delegations: ReadonlyMap<string, DelegationShares[]> | null
): De2Validator[] | null {
  if (!delegations) return null;
  return chainValidators
    .filter((v) => v.status === BondStatus.BOND_STATUS_BONDED)
    .map((v) => {
      const rate = v.commission?.commissionRates?.rate;
      if (rate === undefined) throw new Error(`[money] validator ${v.operatorAddress} has no commission rate`);
      return {
        operator: v.operatorAddress,
        account: toBech32(PREFIX, fromBech32(v.operatorAddress).data),
        tokens: BigInt(parseShares(v.tokens, `${v.operatorAddress} tokens`)),
        delegatorShares: BigInt(parseShares(v.delegatorShares, `${v.operatorAddress} delegator_shares`)),
        rateAtoms: BigInt(parseShares(rate, `${v.operatorAddress} commission rate`)),
        delegations: (delegations.get(v.operatorAddress) ?? []).map((d) => ({
          delegator: d.delegator,
          shares: BigInt(d.shares),
        })),
      };
    });
}

function replayValidator(v: ChainValidator, delegations: ReadonlyMap<string, DelegationShares[]>): ReplayValidator {
  return {
    operator: v.operatorAddress,
    account: toBech32(PREFIX, fromBech32(v.operatorAddress).data),
    tokens: BigInt(parseShares(v.tokens, `${v.operatorAddress} tokens`)),
    delegatorShares: BigInt(parseShares(v.delegatorShares, `${v.operatorAddress} delegator_shares`)),
    delegations: (delegations.get(v.operatorAddress) ?? []).map((d) => ({
      delegator: d.delegator,
      shares: BigInt(d.shares),
      balance: d.balance === undefined ? undefined : BigInt(d.balance),
    })),
  };
}

// The bonded validators with their delegations, in the shape the replay of 288,180–788,944 takes (replay.ts). A bonded
// validator whose delegations were not read is an error: the replay would take it for one with none.
export function replayValidators(
  chainValidators: ReadonlyArray<ChainValidator>,
  delegations: ReadonlyMap<string, DelegationShares[]>
): ReplayValidator[] {
  return chainValidators
    .filter((v) => v.status === BondStatus.BOND_STATUS_BONDED)
    .map((v) => {
      if (!delegations.has(v.operatorAddress)) {
        throw new Error(`[money] the delegations of bonded validator ${v.operatorAddress} were not read`);
      }
      return replayValidator(v, delegations);
    });
}

// The block proposer's validator (any status), found by its consensus address, as the replay's M3 proposer.
export function replayProposer(chainValidators: ReadonlyArray<ChainValidator>, proposer: Uint8Array): ReplayValidator {
  const account = proposerOperatorAccount(chainValidators, proposer);
  const v = chainValidators.find((x) => toBech32(PREFIX, fromBech32(x.operatorAddress).data) === account);
  if (!v) throw new Error(`[money] no validator has the account ${account}`);
  return replayValidator(v, new Map());
}
