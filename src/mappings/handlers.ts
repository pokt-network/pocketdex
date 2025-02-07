import { handleAuthzExec } from "./authz/exec";
import {
  handleNativeTransfer,
} from "./bank";
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
} from "./poktroll/applications";
import {
  handleGatewayMsgStake,
  handleGatewayMsgUnstake,
  handleGatewayUnstakeEvent,
} from "./poktroll/gateways";
import {
  handleEventClaimExpired,
  handleEventClaimSettled,
  handleEventClaimUpdated,
  handleEventProofUpdated,
  handleMsgCreateClaim,
  handleMsgSubmitProof,
} from "./poktroll/relays";
import { handleMsgAddService } from "./poktroll/services";
import {
  handleSupplierStakeMsg,
  handleSupplierUnbondingBeginEvent,
  handleSupplierUnbondingEndEvent,
  handleUnstakeSupplierMsg,
} from "./poktroll/suppliers";
import {
  handleValidatorCommission,
  handleValidatorMsgCreate,
  handleValidatorRewards,
} from "./poktroll/validator";

export const MsgHandlers = {
  // bank
  "/cosmos.bank.v1beta1.MsgSend": handleNativeTransfer,
  // validator
  "/cosmos.staking.v1beta1.MsgCreateValidator": handleValidatorMsgCreate,
  // params
  "/cosmos.authz.v1beta1.MsgExec": handleAuthzExec,
  // application
  "/poktroll.application.MsgStakeApplication": handleAppMsgStake,
  "/poktroll.application.MsgDelegateToGateway": handleDelegateToGatewayMsg,
  "/poktroll.application.MsgUndelegateFromGateway": handleUndelegateFromGatewayMsg,
  "/poktroll.application.MsgUnstakeApplication": handleUnstakeApplicationMsg,
  "/poktroll.application.MsgTransferApplication": handleTransferApplicationMsg,
  // service
  "/poktroll.service.MsgAddService": handleMsgAddService,
  // supplier
  "/poktroll.supplier.MsgStakeSupplier": handleSupplierStakeMsg,
  "/poktroll.supplier.MsgUnstakeSupplier": handleUnstakeSupplierMsg,
  // gateway
  "/poktroll.gateway.MsgStakeGateway": handleGatewayMsgStake,
  "/poktroll.gateway.MsgUnstakeGateway": handleGatewayMsgUnstake,
  // relays
  "/poktroll.proof.MsgCreateClaim": handleMsgCreateClaim,
  "/poktroll.proof.MsgSubmitProof": handleMsgSubmitProof,
};

export const EventHandlers = {
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
        "value": "\"/poktroll.service.MsgUpdateParams\""
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
  "poktroll.application.EventTransferBegin": handleTransferApplicationBeginEvent,
  "poktroll.application.EventTransferEnd": handleTransferApplicationEndEvent,
  "poktroll.application.EventTransferError": handleTransferApplicationErrorEvent,
  "poktroll.application.EventApplicationUnbondingBegin": handleApplicationUnbondingBeginEvent,
  "poktroll.application.EventApplicationUnbondingEnd": handleApplicationUnbondingEndEvent,
  // supplier
  "poktroll.supplier.EventSupplierUnbondingBegin": handleSupplierUnbondingBeginEvent,
  "poktroll.supplier.EventSupplierUnbondingEnd": handleSupplierUnbondingEndEvent,
  // gateway
  "poktroll.gateway.EventGatewayUnstaked": handleGatewayUnstakeEvent,
  // relay
  "poktroll.tokenomics.EventClaimSettled": handleEventClaimSettled,
  "poktroll.tokenomics.EventClaimExpired": handleEventClaimExpired,
  "poktroll.proof.EventClaimUpdated": handleEventClaimUpdated,
  "poktroll.proof.EventProofUpdated": handleEventProofUpdated,
};
