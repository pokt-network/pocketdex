import { Coin } from "./common";

export interface NativeTransferMsg {
  toAddress: string;
  fromAddress: string;
  amount: Coin[];
}

export interface EncodedMsg {
  typeUrl: string;
  value: Uint8Array;
}

export interface AuthzExecMsg {
  grantee: string;
  msgs: EncodedMsg[];
}
