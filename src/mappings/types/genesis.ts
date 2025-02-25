import type { BaseAccountSDKType } from "../../types/proto-interfaces/cosmos/auth/v1beta1/auth";
import { GrantAuthorization } from "../../types/proto-interfaces/cosmos/authz/v1beta1/authz";
import type { Balance } from "../../types/proto-interfaces/cosmos/bank/v1beta1/genesis";
import type {
  Coin,
  CoinSDKType,
} from "../../types/proto-interfaces/cosmos/base/v1beta1/coin";
import type { GatewaySDKType } from "../../types/proto-interfaces/poktroll/gateway/types";
import type { SupplierSDKType } from "../../types/proto-interfaces/poktroll/shared/supplier";

type Supplier = Omit<SupplierSDKType, "stake"> & { stake: Required<CoinSDKType> }
type Params = Record<string, unknown>
type ObjectWithParams = { params: Params }

export type FakeTxType = "app" | "supplier" | "gateway" | "service" | "validator"

// Base interface representing a transaction message
interface TxMessage {
  "@type": string;
}

// Specific message types
interface MsgCreateValidator extends TxMessage {
  "@type": "/cosmos.staking.v1beta1.MsgCreateValidator";
  description: {
    moniker: string;
    identity: string;
    website: string;
    security_contact?: string;
    details?: string;
  };
  commission: {
    rate: string;
    max_rate: string;
    max_change_rate: string;
  };
  min_self_delegation: string;
  delegator_address: string;
  validator_address: string;
  pubkey: {
    "@type": "/cosmos.crypto.ed25519.PubKey";
    key: string;
  };
  value: {
    denom: string;
    amount: string;
  };
}

// Add other specific message types below here

// Union of all message types
export type AllMessages = MsgCreateValidator; // Add other message types to this union as needed

// Generic interface for wrapping messages
export interface TransactionBody<T extends AllMessages = AllMessages> {
  messages: T[];
  memo: string;
  timeout_height: string;
  extension_options?: never[];
  non_critical_extension_options?: never[];
}

// Signer info in auth_info
export interface SignerInfo {
  public_key: {
    "@type": string;
    key: string;
  };
  mode_info: {
    single: {
      mode: string; // E.g., "SIGN_MODE_DIRECT"
    };
  };
  sequence: string;
}

// Fee info in auth_info
interface Fee {
  amount: Coin[];
  gas_limit: string;
  payer: string;
  granter: string;
}

// Authorization information for transactions
interface AuthInfo {
  signer_infos: SignerInfo[];
  fee: Fee;
  tip?: null;
}

// Interface for the `gen_txs` array
export interface GenesisTransaction<T extends AllMessages = AllMessages> {
  body: TransactionBody<T>;
  auth_info: AuthInfo;
  signatures: string[];
}

// `genutil` including the `gen_txs` array
interface GenUtil<T extends AllMessages = AllMessages> {
  gen_txs: GenesisTransaction<T>[];
}

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
    authz: {
      authorization: Array<GrantAuthorization>
    },
    bank: {
      params: Params
      balances: Array<Balance>
      supply: Array<Coin>
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
    genutil: GenUtil
  }
}
