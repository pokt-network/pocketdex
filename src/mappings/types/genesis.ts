import { BaseAccountSDKType } from "../../types/proto-interfaces/cosmos/auth/v1beta1/auth";
import { Balance } from "../../types/proto-interfaces/cosmos/bank/v1beta1/genesis";

export interface Genesis {
  initial_height: number,
  app_state: {
    auth: {
      accounts: Array<BaseAccountSDKType>
    }
    bank: {
      balances: Array<Balance>
    },
  }
}
