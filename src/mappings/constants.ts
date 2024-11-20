import { ApplicationUnbondingReason as ApplicationUnbondingReasonEnum } from "../client/poktroll/application/event";

export const PREFIX = "pokt";

export enum StakeStatus {
  Staked = 0,
  Unstaking = 1,
  Unstaked = 2,
}

export enum TxStatus {
  Success = 0,
  Error = 1,
}

// extending the enum to add a TRANSFERRED value
export const ApplicationUnbondingReason = {
  ...ApplicationUnbondingReasonEnum,
  TRANSFERRED: 2,
} as const

export enum RelayStatus {
  PENDING = 0,
  SUCCESSFUL = 1,
  FAILED = 2,
}
