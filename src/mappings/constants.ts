export const PREFIX = "poktroll";

export const StakeStatus = {
  Staked: 0,
  Unstaking: 1,
  Unstaked: 2,
} as const

export const TxStatus = {
  Success: 0,
  Error: 1,
} as const
