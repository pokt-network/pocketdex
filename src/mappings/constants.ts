import { ApplicationUnbondingReason as ApplicationUnbondingReasonEnum } from "../client/poktroll/application/event";

export const PREFIX = "pokt";
export const VALIDATOR_PREFIX = "poktvaloper";

// extending the enum to add a TRANSFERRED value
export const ApplicationUnbondingReason = {
  ...ApplicationUnbondingReasonEnum,
  TRANSFERRED: 2,
} as const
