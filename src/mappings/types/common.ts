import {
  CosmosEvent,
  CosmosMessage,
} from "@subql/types-cosmos";
import type { MsgCreateValidator } from "cosmjs-types/cosmos/staking/v1beta1/tx";
import { MsgAddService } from "../../client/pocket/service/tx";
import {
  MsgDelegateToGateway,
  MsgStakeApplication,
  MsgTransferApplication,
  MsgUndelegateFromGateway,
  MsgUnstakeApplication,
} from "../../types/proto-interfaces/pocket/application/tx";
import {
  MsgStakeGateway,
  MsgUnstakeGateway,
} from "../../types/proto-interfaces/pocket/gateway/tx";
import {
  MsgCreateClaim,
  MsgSubmitProof,
} from "../../types/proto-interfaces/pocket/proof/tx";
import { MsgUnstakeSupplier } from "../../types/proto-interfaces/pocket/supplier/tx";
import {
  AuthzExecMsg,
  NativeTransferMsg,
} from "./messages";

export interface Coin {
  amount: string,
  denom: string,
}

export type MessageByType = Record<string, Array<CosmosMessage>> & {
  // bank
  "/cosmos.bank.v1beta1.MsgSend": Array<CosmosMessage<NativeTransferMsg>>
  // validator
  "/cosmos.staking.v1beta1.MsgCreateValidator": Array<CosmosMessage<MsgCreateValidator>>
  // params
  "/cosmos.authz.v1beta1.MsgExec": Array<CosmosMessage<AuthzExecMsg>>
  // application
  "/pocket.application.MsgStakeApplication": Array<CosmosMessage<MsgStakeApplication>>
  "/pocket.application.MsgDelegateToGateway": Array<CosmosMessage<MsgDelegateToGateway>>
  "/pocket.application.MsgUndelegateFromGateway": Array<CosmosMessage<MsgUndelegateFromGateway>>
  "/pocket.application.MsgUnstakeApplication": Array<CosmosMessage<MsgUnstakeApplication>>
  "/pocket.application.MsgTransferApplication": Array<CosmosMessage<MsgTransferApplication>>
  // service
  "/pocket.service.MsgAddService": Array<CosmosMessage<MsgAddService>>
  // supplier
  "/pocket.supplier.MsgUnstakeSupplier": Array<CosmosMessage<MsgUnstakeSupplier>>
  // gateway
  "/pocket.gateway.MsgStakeGateway": Array<CosmosMessage<MsgStakeGateway>>
  "/pocket.gateway.MsgUnstakeGateway": Array<CosmosMessage<MsgUnstakeGateway>>
  // proof
  "/pocket.proof.MsgCreateClaim": Array<CosmosMessage<MsgCreateClaim>>
  "/pocket.proof.MsgSubmitProof": Array<CosmosMessage<MsgSubmitProof>>
};

// no mater the type the events are always the same structure.
export type EventByType = Record<string, Array<CosmosEvent>>;
