import {
  handleNativeBalanceDecrement,
  handleNativeBalanceIncrement,
  handleNativeTransfer,
} from "./bank";
import { handleValidatorMsgCreate } from "./poktroll/validator";

export const MsgHandlers = {
  "/cosmos.bank.v1beta1.MsgSend": handleNativeTransfer,
  "/cosmos.staking.v1beta1.MsgCreateValidator": handleValidatorMsgCreate,
};

export const EventHandlers = {
  "coin_received": handleNativeBalanceIncrement,
  "coin_spent": handleNativeBalanceDecrement,
};
