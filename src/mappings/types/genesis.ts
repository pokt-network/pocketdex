import type { BaseAccountSDKType } from "../../types/proto-interfaces/cosmos/auth/v1beta1/auth";
import type { Balance } from "../../types/proto-interfaces/cosmos/bank/v1beta1/genesis";
import type { Coin, CoinSDKType } from "../../types/proto-interfaces/cosmos/base/v1beta1/coin";
import type { GatewaySDKType } from "../../types/proto-interfaces/poktroll/gateway/types";
import type { SupplierSDKType } from "../../types/proto-interfaces/poktroll/shared/supplier";

type Supplier = Omit<SupplierSDKType, "stake"> & {stake: Required<CoinSDKType> }
type Params = Record<string, unknown>
type ObjectWithParams ={params: Params}

export interface Genesis {
  initial_height: number,
  app_state: {
    service: {
      params: Params
      serviceList: Array<{
        compute_units_per_relay: number,
        id: string,
        name: string,
        owner_address: string
      }>
    }
    application: {
      applicationList: Array<{
        address: string,
        delegatee_gateway_addresses: Array<string>,
        service_configs: Array<{
            service_id: string
          }>
        stake: Coin
      }>
      params: Params
    }
    supplier: {
      params: Params
      supplierList: Array<Supplier>
    }
    gateway: {
      params: Params
      gatewayList: Array<Required<GatewaySDKType>>
    }
    auth: {
      params: Params
      accounts: Array<BaseAccountSDKType>
    }
    bank: {
      params: Params
      balances: Array<Balance>
    },
    distribution: ObjectWithParams
    gov: ObjectWithParams
    mint: ObjectWithParams
    slashing: ObjectWithParams
    staking: ObjectWithParams
    proof: ObjectWithParams
    shared: ObjectWithParams
    tokenomics: ObjectWithParams
    consensus: ObjectWithParams
    session: ObjectWithParams
  }
}
