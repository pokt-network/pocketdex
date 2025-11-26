import { CosmosEvent, CosmosMessage } from "@subql/types-cosmos";
import { handleAuthzExec } from "./authz/exec";
import { handleEventGrant, handleMsgGrant } from "./authz/grants";
import { handleNativeTransfer } from "./bank";
import {
  handleApplicationUnbondingBeginEvent,
  handleApplicationUnbondingEndEvent,
  handleAppMsgStake,
  handleDelegateToGatewayMsg,
  handleMsgClaimMorseApplication,
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
import { handleMsgClaimMorseAccount } from "./pocket/migration";
import {
  handleEventApplicationOverserviced,
  handleEventApplicationReimbursementRequest,
  handleEventClaimExpired,
  handleEventClaimSettled,
  handleEventClaimUpdated,
  handleEventProofUpdated,
  handleEventProofValidityChecked,
  handleMsgCreateClaim,
  handleMsgSubmitProof,
} from "./pocket/relays";
import { handleEventRelayMiningDifficultyUpdated, handleMsgAddService } from "./pocket/services";
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
  // authz
  "/cosmos.authz.v1beta1.MsgGrant": handleMsgGrant,
  // migration
  "/pocket.migration.MsgClaimMorseAccount": handleMsgClaimMorseAccount,
  // this is currently being handle inside Authz handler
  "/pocket.migration.MsgRecoverMorseAccount": noOp,
  "/pocket.migration.MsgClaimMorseApplication": handleMsgClaimMorseApplication,
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
  // supplier - handled by batch processing in indexSupplier (called from indexStake)
  "/pocket.supplier.MsgStakeSupplier": noOp,// - now handled in indexSupplier
  "/pocket.supplier.MsgUnstakeSupplier": noOp,// - now handled in indexSupplier
  "/pocket.migration.MsgClaimMorseSupplier": noOp,// - now handled in indexSupplier
  // gateway
  "/pocket.gateway.MsgStakeGateway": handleGatewayMsgStake,
  "/pocket.gateway.MsgUnstakeGateway": handleGatewayMsgUnstake,
  // relays
  "/pocket.proof.MsgCreateClaim": handleMsgCreateClaim,
  "/pocket.proof.MsgSubmitProof": handleMsgSubmitProof,
};

export const EventHandlers: Record<string, (events: Array<CosmosEvent>) => Promise<void>> = {
  // authz
  "cosmos.authz.v1beta1.EventGrant": handleEventGrant,
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
  // supplier - handled by batch processing in indexSupplier (called from indexStake)
  "pocket.supplier.EventSupplierServiceConfigActivated": noOp, // - now handled in indexSupplier
  "pocket.supplier.EventSupplierUnbondingBegin": noOp, // - now handled in indexSupplier
  "pocket.supplier.EventSupplierUnbondingEnd": noOp, // - now handled in indexSupplier
  // service
  "pocket.service.EventRelayMiningDifficultyUpdated": handleEventRelayMiningDifficultyUpdated,
  // gateway
  "pocket.gateway.EventGatewayUnstaked": handleGatewayUnstakeEvent,
  "pocket.gateway.EventGatewayUnbondingBegin": handleEventGatewayUnbondingBegin,
  "pocket.gateway.EventGatewayUnbondingEnd": handleEventGatewayUnbondingEnd,
  // relay
  "pocket.tokenomics.EventClaimSettled": handleEventClaimSettled,
  "pocket.tokenomics.EventClaimExpired": handleEventClaimExpired,
  "pocket.tokenomics.EventSupplierSlashed": noOp, // - now handled in indexSupplier
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
