import {
  CosmosEvent,
  CosmosMessage,
} from "@subql/types-cosmos";
import type { MsgCreateValidator } from "cosmjs-types/cosmos/staking/v1beta1/tx";
import { MsgAddService } from "../../client/poktroll/service/tx";
import {
  MsgDelegateToGateway,
  MsgStakeApplication,
  MsgTransferApplication,
  MsgUndelegateFromGateway,
  MsgUnstakeApplication,
} from "../../types/proto-interfaces/poktroll/application/tx";
import {
  MsgStakeGateway,
  MsgUnstakeGateway,
} from "../../types/proto-interfaces/poktroll/gateway/tx";
import {
  MsgCreateClaim,
  MsgSubmitProof,
} from "../../types/proto-interfaces/poktroll/proof/tx";
import { MsgUnstakeSupplier } from "../../types/proto-interfaces/poktroll/supplier/tx";
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
  "/poktroll.application.MsgStakeApplication": Array<CosmosMessage<MsgStakeApplication>>
  "/poktroll.application.MsgDelegateToGateway": Array<CosmosMessage<MsgDelegateToGateway>>
  "/poktroll.application.MsgUndelegateFromGateway": Array<CosmosMessage<MsgUndelegateFromGateway>>
  "/poktroll.application.MsgUnstakeApplication": Array<CosmosMessage<MsgUnstakeApplication>>
  "/poktroll.application.MsgTransferApplication": Array<CosmosMessage<MsgTransferApplication>>
  // service
  "/poktroll.service.MsgAddService": Array<CosmosMessage<MsgAddService>>
  // supplier
  "/poktroll.supplier.MsgUnstakeSupplier": Array<CosmosMessage<MsgUnstakeSupplier>>
  // gateway
  "/poktroll.gateway.MsgStakeGateway": Array<CosmosMessage<MsgStakeGateway>>
  "/poktroll.gateway.MsgUnstakeGateway": Array<CosmosMessage<MsgUnstakeGateway>>
  // proof
  "/poktroll.proof.MsgCreateClaim": Array<CosmosMessage<MsgCreateClaim>>
  "/poktroll.proof.MsgSubmitProof": Array<CosmosMessage<MsgSubmitProof>>
};

// no mater the type the events are always the same structure.
export type EventByType = Record<string, Array<CosmosEvent>>;
