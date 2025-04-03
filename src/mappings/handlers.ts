import { CosmosEvent, CosmosMessage } from "@subql/types-cosmos";
import { handleAuthzExec } from "./authz/exec";
import { handleNativeTransfer } from "./bank";
import {
  handleApplicationUnbondingBeginEvent,
  handleApplicationUnbondingEndEvent,
  handleAppMsgStake,
  handleDelegateToGatewayMsg,
  handleTransferApplicationBeginEvent,
  handleTransferApplicationEndEvent,
  handleTransferApplicationErrorEvent,
  handleTransferApplicationMsg,
  handleUndelegateFromGatewayMsg,
  handleUnstakeApplicationMsg,
} from "./pocket/applications";
import {
  handleGatewayMsgStake,
  handleGatewayMsgUnstake,
  handleGatewayUnstakeEvent,
  handleEventGatewayUnbondingBegin,
  handleEventGatewayUnbondingEnd,
} from "./pocket/gateways";
import {
  handleEventApplicationOverserviced,
  handleEventApplicationReimbursementRequest,
  handleEventClaimExpired,
  handleEventClaimSettled,
  handleEventClaimUpdated,
  handleEventProofUpdated,
  handleEventProofValidityChecked,
  handleEventSupplierSlashed,
  handleMsgCreateClaim,
  handleMsgSubmitProof,
} from "./pocket/relays";
import { handleEventRelayMiningDifficultyUpdated, handleMsgAddService } from "./pocket/services";
import {
  handleSupplierStakeMsg,
  handleSupplierUnbondingBeginEvent,
  handleSupplierUnbondingEndEvent,
  handleUnstakeSupplierMsg,
} from "./pocket/suppliers";
import {
  handleValidatorCommission,
  handleValidatorMsgCreate,
  handleValidatorRewards,
} from "./pocket/validator";

const noOp = async function(): Promise<void> {
  await Promise.resolve();
};

export enum ByTxStatus {
  All,
  Success,
  Error,
}

export const MsgHandlers: Record<string, (messages: Array<CosmosMessage>) => Promise<void>> = {
  // bank
  "/cosmos.bank.v1beta1.MsgSend": handleNativeTransfer,
  // validator
  "/cosmos.staking.v1beta1.MsgCreateValidator": handleValidatorMsgCreate,
  // params
  "/cosmos.authz.v1beta1.MsgExec": handleAuthzExec,
  // application
  "/pocket.application.MsgStakeApplication": handleAppMsgStake,
  "/pocket.application.MsgDelegateToGateway": handleDelegateToGatewayMsg,
  "/pocket.application.MsgUndelegateFromGateway": handleUndelegateFromGatewayMsg,
  "/pocket.application.MsgUnstakeApplication": handleUnstakeApplicationMsg,
  "/pocket.application.MsgTransferApplication": handleTransferApplicationMsg,
  // service
  "/pocket.service.MsgAddService": handleMsgAddService,
  // supplier
  "/pocket.supplier.MsgStakeSupplier": handleSupplierStakeMsg,
  "/pocket.supplier.MsgUnstakeSupplier": handleUnstakeSupplierMsg,
  // gateway
  "/pocket.gateway.MsgStakeGateway": handleGatewayMsgStake,
  "/pocket.gateway.MsgUnstakeGateway": handleGatewayMsgUnstake,
  // relays
  "/pocket.proof.MsgCreateClaim": handleMsgCreateClaim,
  "/pocket.proof.MsgSubmitProof": handleMsgSubmitProof,
};

export const EventHandlers: Record<string, (events: Array<CosmosEvent>) => Promise<void>> = {
  // authz
  /*
  todo: handle this.
    type: cosmos.authz.v1beta1.EventGrant
    [
      {
        "key": "grantee",
        "value": "\"pokt1f0c9y7mahf2ya8tymy8g4rr75ezh3pkklu4c3e\""
      },
      {
        "key": "granter",
        "value": "\"pokt10d07y265gmmuvt4z0w9aw880jnsr700j8yv32t\""
      },
      {
        "key": "msg_type_url",
        "value": "\"/pocket.service.MsgUpdateParams\""
      }
    ]
    "cosmos.authz.v1beta1.EventGrant": async () => Promise.resolve(),
   */

  // Validator rewards
  // Represent the total rewards earned from block rewards and transaction fees.
  // Includes both the validator’s share and the portion allocated to delegators.
  // Shows the full earnings before any deductions.
  "rewards": handleValidatorRewards,
  // Validator commissions
  // Captures the cut taken by the validator before distributing the rest.
  // Based on the commission rate, the validator sets.
  // Separates validator earnings from what’s passed on to delegators.
  "commission": handleValidatorCommission,
  // TODO Handle: `withdraw_rewards`
  //  This event is emitted when a validator or delegator claims their staking rewards.
  //  It happens when they trigger a manual withdrawal, moving rewards from the staking module to their balance.
  //  This is the moment where rewards are actually turned into spendable tokens.
  // application
  "pocket.application.EventTransferBegin": handleTransferApplicationBeginEvent,
  "pocket.application.EventTransferEnd": handleTransferApplicationEndEvent,
  "pocket.application.EventTransferError": handleTransferApplicationErrorEvent,
  "pocket.application.EventApplicationUnbondingBegin": handleApplicationUnbondingBeginEvent,
  "pocket.application.EventApplicationUnbondingEnd": handleApplicationUnbondingEndEvent,
  // supplier
  "pocket.supplier.EventSupplierUnbondingBegin": handleSupplierUnbondingBeginEvent,
  "pocket.supplier.EventSupplierUnbondingEnd": handleSupplierUnbondingEndEvent,
  // service
  "pocket.service.EventRelayMiningDifficultyUpdated": handleEventRelayMiningDifficultyUpdated,
  // gateway
  "pocket.gateway.EventGatewayUnstaked": handleGatewayUnstakeEvent,
  "pocket.gateway.EventGatewayUnbondingBegin": handleEventGatewayUnbondingBegin,
  "pocket.gateway.EventGatewayUnbondingEnd": handleEventGatewayUnbondingEnd,
  // relay
  "pocket.tokenomics.EventClaimSettled": handleEventClaimSettled,
  "pocket.tokenomics.EventClaimExpired": handleEventClaimExpired,
  "pocket.tokenomics.EventSupplierSlashed": handleEventSupplierSlashed,
  "pocket.tokenomics.EventApplicationOverserviced": handleEventApplicationOverserviced,
  "pocket.tokenomics.EventApplicationReimbursementRequest": handleEventApplicationReimbursementRequest,
  "pocket.proof.EventClaimUpdated": handleEventClaimUpdated,
  "pocket.proof.EventProofUpdated": handleEventProofUpdated,
  "pocket.proof.EventProofValidityChecked": handleEventProofValidityChecked,
  // todo: implement this one
  "mint": noOp,
  "coinbase": noOp,
  "transfer": noOp,
  "burn": noOp,
};
