// Every settlement op_reason the money layer accepts, with the role of whoever receives it and the
// mint family it belongs to. One table drives both the allowlist and the classification, so the two
// cannot drift apart. Source: poktroll v0.1.35, x/tokenomics/types/types.proto SettlementOpReason and the
// token logic modules that emit each reason (tlm_relay_burn_equals_mint.go, tlm_global_mint.go,
// tlm_reimbursement_requests.go, distribution_validator.go).
//
// An op_reason that is not in this table fails the block. A new poktroll release that adds a reason
// therefore needs this table updated before it reaches the chain this indexer follows.
//
// Not listed, because no settlement event carries them: TLM_GLOBAL_MINT_SUPPLIER_SHAREHOLDER_REWARD_MODULE_TRANSFER
// (defined, never emitted), and the two supplier slash reasons (direct bank calls that only appear in error
// strings). TLM_RELAY_BURN_EQUALS_MINT_SUPPLIER_STAKE_MINT and TLM_GLOBAL_MINT_PROPOSER_REWARD_DISTRIBUTION only
// appear in the settlement_result era (poktroll v0.1.26 and earlier), in EventClaimSettled.settlement_result.

export type Role = "rev_share" | "dao" | "source_owner" | "application" | "validator" | "delegator" | "none";

export type Family = "relay" | "global" | "reimb_escrow";

export interface ReasonInfo {
  role: Role;
  family: Family;
  // Whether the reason appears in EventClaimSettled.reward_distribution_detailed (the claim's own
  // mod_to_acct legs). Validator and delegator rewards are paid once per settlement and only appear in
  // EventSettlementBatch.
  detailed: boolean;
  // The op_type values EventSettlementBatch may carry for this reason.
  batchOpTypes: ReadonlyArray<string>;
}

export const REASONS: Readonly<Record<string, ReasonInfo>> = {
  // relay family: burn the settlement from the application, mint settlement × mint_ratio, distribute it
  TLM_RELAY_BURN_EQUALS_MINT_APPLICATION_STAKE_BURN: {
    role: "none",
    family: "relay",
    detailed: false,
    batchOpTypes: ["burn"],
  },
  TLM_RELAY_BURN_EQUALS_MINT_TOKENOMICS_CLAIM_DISTRIBUTION_MINT: {
    role: "none",
    family: "relay",
    detailed: false,
    batchOpTypes: ["mint"],
  },
  // settlement_result era: the relay mint, into the supplier module
  TLM_RELAY_BURN_EQUALS_MINT_SUPPLIER_STAKE_MINT: { role: "none", family: "relay", detailed: false, batchOpTypes: [] },
  TLM_RELAY_BURN_EQUALS_MINT_SUPPLIER_SHAREHOLDER_REWARD_DISTRIBUTION: {
    role: "rev_share",
    family: "relay",
    detailed: true,
    batchOpTypes: ["mod_to_mod", "mod_to_acct"],
  },
  TLM_RELAY_BURN_EQUALS_MINT_DAO_REWARD_DISTRIBUTION: {
    role: "dao",
    family: "relay",
    detailed: true,
    batchOpTypes: ["mod_to_acct"],
  },
  TLM_RELAY_BURN_EQUALS_MINT_SOURCE_OWNER_REWARD_DISTRIBUTION: {
    role: "source_owner",
    family: "relay",
    detailed: true,
    batchOpTypes: ["mod_to_acct"],
  },
  TLM_RELAY_BURN_EQUALS_MINT_APPLICATION_REWARD_DISTRIBUTION: {
    role: "application",
    family: "relay",
    detailed: true,
    batchOpTypes: ["mod_to_acct"],
  },
  // A bonded validator's account receives everything under VALIDATOR, including what it earns as a
  // delegator of other validators; DELEGATOR only reaches accounts that are not bonded validators.
  TLM_RELAY_BURN_EQUALS_MINT_VALIDATOR_REWARD_DISTRIBUTION: {
    role: "validator",
    family: "relay",
    detailed: false,
    batchOpTypes: ["mod_to_acct"],
  },
  // map_proposer_consensus and map_proposer_operator (poktroll v0.1.27–v0.1.28): the block proposer's relay share
  // (tlm_relay_burn_equals_mint.go:205-215 at v0.1.27), read from the bank legs.
  TLM_RELAY_BURN_EQUALS_MINT_PROPOSER_REWARD_DISTRIBUTION: {
    role: "validator",
    family: "relay",
    detailed: false,
    batchOpTypes: ["mod_to_acct"],
  },
  TLM_RELAY_BURN_EQUALS_MINT_DELEGATOR_REWARD_DISTRIBUTION: {
    role: "delegator",
    family: "relay",
    detailed: false,
    batchOpTypes: ["mod_to_acct"],
  },

  // global mint family: mint ceil(settlement × global_inflation_per_claim), distribute it
  TLM_GLOBAL_MINT_INFLATION: { role: "none", family: "global", detailed: false, batchOpTypes: ["mint"] },
  TLM_GLOBAL_MINT_SUPPLIER_SHAREHOLDER_REWARD_DISTRIBUTION: {
    role: "rev_share",
    family: "global",
    detailed: true,
    batchOpTypes: ["mod_to_acct"],
  },
  TLM_GLOBAL_MINT_DAO_REWARD_DISTRIBUTION: {
    role: "dao",
    family: "global",
    detailed: true,
    batchOpTypes: ["mod_to_acct"],
  },
  TLM_GLOBAL_MINT_SOURCE_OWNER_REWARD_DISTRIBUTION: {
    role: "source_owner",
    family: "global",
    detailed: true,
    batchOpTypes: ["mod_to_acct"],
  },
  TLM_GLOBAL_MINT_APPLICATION_REWARD_DISTRIBUTION: {
    role: "application",
    family: "global",
    detailed: true,
    batchOpTypes: ["mod_to_acct"],
  },
  // settlement_result era: the block proposer's global share, paid to the account of its consensus address. A
  // claim leg (detailed) there; staker income as role validator.
  TLM_GLOBAL_MINT_PROPOSER_REWARD_DISTRIBUTION: {
    role: "validator",
    family: "global",
    detailed: true,
    batchOpTypes: [],
  },
  TLM_GLOBAL_MINT_VALIDATOR_REWARD_DISTRIBUTION: {
    role: "validator",
    family: "global",
    detailed: false,
    batchOpTypes: ["mod_to_acct"],
  },
  TLM_GLOBAL_MINT_DELEGATOR_REWARD_DISTRIBUTION: {
    role: "delegator",
    family: "global",
    detailed: false,
    batchOpTypes: ["mod_to_acct"],
  },

  // reimbursement: the application pays the global mint into escrow, which goes to the DAO
  TLM_GLOBAL_MINT_REIMBURSEMENT_REQUEST_ESCROW_DAO_TRANSFER: {
    role: "dao",
    family: "reimb_escrow",
    detailed: true,
    batchOpTypes: ["mod_to_acct"],
  },
  // mod_to_mod with two uses: application → tokenomics (the escrow) and tokenomics → supplier (the global
  // supplier slice, emitted under this reason instead of ..._SUPPLIER_SHAREHOLDER_REWARD_MODULE_TRANSFER)
  TLM_GLOBAL_MINT_REIMBURSEMENT_REQUEST_ESCROW_MODULE_TRANSFER: {
    role: "none",
    family: "global",
    detailed: false,
    batchOpTypes: ["mod_to_mod"],
  },
};
