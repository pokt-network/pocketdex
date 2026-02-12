import {
  CosmosEvent,
  CosmosMessage,
} from "@subql/types-cosmos";
import isEmpty from "lodash/isEmpty";
import { claimProofStatusFromJSON } from "../../client/pocket/proof/types";
import { claimExpirationReasonFromJSON } from "../../client/pocket/tokenomics/event";
import {
  ClaimExpirationReason,
  ClaimProofStatus,
  Coin,
  Param,
  ProofRequirementReason,
  SettlementOpReason,
} from "../../types";
import { EventApplicationOverservicedProps } from "../../types/models/EventApplicationOverserviced";
import { EventApplicationReimbursementRequestProps } from "../../types/models/EventApplicationReimbursementRequest";
import { EventClaimExpiredProps } from "../../types/models/EventClaimExpired";
import { EventClaimSettledProps } from "../../types/models/EventClaimSettled";
import { EventClaimUpdatedProps } from "../../types/models/EventClaimUpdated";
import { EventProofUpdatedProps } from "../../types/models/EventProofUpdated";
import { EventProofValidityCheckedProps } from "../../types/models/EventProofValidityChecked";
import { ModToAcctTransferProps } from "../../types/models/ModToAcctTransfer";
import { MsgCreateClaimProps } from "../../types/models/MsgCreateClaim";
import { MsgSubmitProofProps } from "../../types/models/MsgSubmitProof";
import { CoinSDKType } from "../../types/proto-interfaces/cosmos/base/v1beta1/coin";
import {
  MsgCreateClaim,
  MsgSubmitProof,
} from "../../types/proto-interfaces/pocket/proof/tx";
import {
  ClaimProofStatusSDKType,
  ClaimSDKType,
  proofRequirementReasonFromJSON,
  ProofRequirementReasonSDKType,
  ProofSDKType,
} from "../../types/proto-interfaces/pocket/proof/types";
import { ClaimExpirationReasonSDKType } from "../../types/proto-interfaces/pocket/tokenomics/event";
import {
  ClaimSettlementResultSDKType,
  SettlementOpReason as SettlementOpReasonSdk,
  settlementOpReasonFromJSON,
  SettlementOpReasonSDKType,
} from "../../types/proto-interfaces/pocket/tokenomics/types";
import { optimizedBulkCreate } from "../utils/db";
import {
  getBlockId,
  getEventId,
  getParamId,
  messageId,
} from "../utils/ids";
import {
  parseJson,
  stringify,
} from "../utils/json";
import { getDenomAndAmount } from "../utils/primitives";

// this can return undefined because older events do not have this attribute
export function getClaimProofStatusFromSDK(item: typeof ClaimProofStatusSDKType | string | number): ClaimProofStatus | undefined {
  if (!item) return undefined;

  switch (item) {
    case 0:
    case ClaimProofStatusSDKType.PENDING_VALIDATION:
    case "PENDING_VALIDATION":
      return ClaimProofStatus.PENDING_VALIDATION;
    case 1:
    case ClaimProofStatusSDKType.VALIDATED:
    case "VALIDATED":
      return ClaimProofStatus.VALIDATED;
    case 2:
    case ClaimProofStatusSDKType.INVALID:
    case "INVALID":
      return ClaimProofStatus.INVALID;
    default:
      throw new Error(`Unknown ClaimProofStatus=${item}`);
  }
}

// eslint-disable-next-line complexity
function getSettlementOpReasonFromSDK(item: typeof SettlementOpReasonSDKType | number | string): SettlementOpReason {
  switch (item) {
    case "UNSPECIFIED":
    case SettlementOpReasonSDKType.UNSPECIFIED:
      return SettlementOpReason.UNSPECIFIED;

    case "TLM_RELAY_BURN_EQUALS_MINT_SUPPLIER_STAKE_MINT":
    case SettlementOpReasonSDKType.TLM_RELAY_BURN_EQUALS_MINT_SUPPLIER_STAKE_MINT:
      return SettlementOpReason.TLM_RELAY_BURN_EQUALS_MINT_SUPPLIER_STAKE_MINT;

    case "TLM_RELAY_BURN_EQUALS_MINT_APPLICATION_STAKE_BURN":
    case SettlementOpReasonSDKType.TLM_RELAY_BURN_EQUALS_MINT_APPLICATION_STAKE_BURN:
      return SettlementOpReason.TLM_RELAY_BURN_EQUALS_MINT_APPLICATION_STAKE_BURN;

    case "TLM_GLOBAL_MINT_INFLATION":
    case SettlementOpReasonSDKType.TLM_GLOBAL_MINT_INFLATION:
      return SettlementOpReason.TLM_GLOBAL_MINT_INFLATION;

    case "TLM_RELAY_BURN_EQUALS_MINT_SUPPLIER_SHAREHOLDER_REWARD_DISTRIBUTION":
    case SettlementOpReasonSDKType.TLM_RELAY_BURN_EQUALS_MINT_SUPPLIER_SHAREHOLDER_REWARD_DISTRIBUTION:
      return SettlementOpReason.TLM_RELAY_BURN_EQUALS_MINT_SUPPLIER_SHAREHOLDER_RD;

    case "TLM_GLOBAL_MINT_DAO_REWARD_DISTRIBUTION":
    case SettlementOpReasonSDKType.TLM_GLOBAL_MINT_DAO_REWARD_DISTRIBUTION:
      return SettlementOpReason.TLM_GLOBAL_MINT_DAO_REWARD_DISTRIBUTION;

    case "TLM_GLOBAL_MINT_PROPOSER_REWARD_DISTRIBUTION":
    case 6:
      return SettlementOpReason.TLM_GLOBAL_MINT_PROPOSER_REWARD_DISTRIBUTION;

    case "TLM_GLOBAL_MINT_SUPPLIER_SHAREHOLDER_REWARD_DISTRIBUTION":
    case SettlementOpReasonSDKType.TLM_GLOBAL_MINT_SUPPLIER_SHAREHOLDER_REWARD_DISTRIBUTION:
      return SettlementOpReason.TLM_GLOBAL_MINT_SUPPLIER_SHAREHOLDER_REWARD_DISTRIBUTION;

    case "TLM_GLOBAL_MINT_SOURCE_OWNER_REWARD_DISTRIBUTION":
    case SettlementOpReasonSDKType.TLM_GLOBAL_MINT_SOURCE_OWNER_REWARD_DISTRIBUTION:
      return SettlementOpReason.TLM_GLOBAL_MINT_SOURCE_OWNER_REWARD_DISTRIBUTION;

    case "TLM_GLOBAL_MINT_APPLICATION_REWARD_DISTRIBUTION":
    case SettlementOpReasonSDKType.TLM_GLOBAL_MINT_APPLICATION_REWARD_DISTRIBUTION:
      return SettlementOpReason.TLM_GLOBAL_MINT_APPLICATION_REWARD_DISTRIBUTION;

    case "TLM_GLOBAL_MINT_REIMBURSEMENT_REQUEST_ESCROW_DAO_TRANSFER":
    case SettlementOpReasonSDKType.TLM_GLOBAL_MINT_REIMBURSEMENT_REQUEST_ESCROW_DAO_TRANSFER:
      return SettlementOpReason.TLM_GLOBAL_MINT_REIMBURSEMENT_REQUEST_ESCROW_DAO_TRANSFER;

    case "UNSPECIFIED_TLM_SUPPLIER_SLASH_MODULE_TRANSFER":
    case SettlementOpReasonSDKType.UNSPECIFIED_TLM_SUPPLIER_SLASH_MODULE_TRANSFER:
      return SettlementOpReason.UNSPECIFIED_TLM_SUPPLIER_SLASH_MODULE_TRANSFER;

    case "UNSPECIFIED_TLM_SUPPLIER_SLASH_STAKE_BURN":
    case SettlementOpReasonSDKType.UNSPECIFIED_TLM_SUPPLIER_SLASH_STAKE_BURN:
      return SettlementOpReason.UNSPECIFIED_TLM_SUPPLIER_SLASH_STAKE_BURN;

    case "TLM_GLOBAL_MINT_SUPPLIER_SHAREHOLDER_REWARD_MODULE_TRANSFER":
    case SettlementOpReasonSDKType.TLM_GLOBAL_MINT_SUPPLIER_SHAREHOLDER_REWARD_MODULE_TRANSFER:
      return SettlementOpReason.TLM_GLOBAL_MINT_SUPPLIER_SHAREHOLDER_REWARD_MODULE_TRANSFER;

    case "TLM_GLOBAL_MINT_REIMBURSEMENT_REQUEST_ESCROW_MODULE_TRANSFER":
    case SettlementOpReasonSDKType.TLM_GLOBAL_MINT_REIMBURSEMENT_REQUEST_ESCROW_MODULE_TRANSFER:
      return SettlementOpReason.TLM_GLOBAL_MINT_REIMBURSEMENT_REQUEST_ESCROW_MODULE_TRANSFER;

    default:
      return SettlementOpReason.UNSPECIFIED;
  }
}

function parseAttribute(attribute: unknown = ""): string {
  return (attribute as string).replaceAll("\"", "");
}

// eslint-disable-next-line complexity
export function getAttributes(attributes: CosmosEvent["event"]["attributes"]) {

  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  let proof: ProofSDKType = {},
    expirationReason: ClaimExpirationReason = ClaimExpirationReason.EXPIRATION_REASON_UNSPECIFIED,
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    claim: ClaimSDKType = {},
    proofRequirement: ProofRequirementReason = ProofRequirementReason.NOT_REQUIRED,
    numRelays = BigInt(0),
    numClaimedComputedUnits = BigInt(0),
    numEstimatedComputedUnits = BigInt(0),
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    claimed: CoinSDKType = {},
    failureReason: string | null = null,
    proofValidationStatus: ClaimProofStatus | undefined,
    settlementResult: ClaimSettlementResultSDKType | null = null,
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    proofMissingPenalty: CoinSDKType = {},
    rewardDistribution: Record<string, string> | undefined;

  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  const newClaim: ClaimSDKType = { session_header: {} };

  for (const attribute of attributes) {
    if (attribute.key === "proof") {
      proof = JSON.parse(attribute.value as string);
    }

    if (attribute.key === "claim") {
      claim = JSON.parse(attribute.value as string);
    }

    if (attribute.key === "supplier_operator_address") {
      newClaim.supplier_operator_address = parseAttribute(attribute.value);
    }

    if (attribute.key === "service_id") {
      newClaim.session_header!.service_id = parseAttribute(attribute.value);
    }

    if (attribute.key === "application_address") {
      newClaim.session_header!.application_address = parseAttribute(attribute.value);
    }

    if (attribute.key === "session_end_block_height") {
      newClaim.session_header!.session_end_block_height = BigInt(parseAttribute(attribute.value));
      newClaim.session_header!.session_start_block_height = BigInt(0);
      newClaim.session_header!.session_id = "";
    }

    if (attribute.key === "claim_proof_status_int") {
      newClaim.proof_validation_status = claimProofStatusFromJSON(Number(parseAttribute(attribute.value as string)));
      proofValidationStatus = getClaimProofStatusFromSDK(newClaim.proof_validation_status);
    }

    if (attribute.key === "num_relays") {
      numRelays = BigInt(parseAttribute(attribute.value));
    }

    // in older versions this is the key to get the number of claimed compute units
    if (attribute.key === "num_compute_units") {
      numClaimedComputedUnits = BigInt(parseAttribute(attribute.value));
    }

    if (attribute.key === "num_claimed_compute_units") {
      numClaimedComputedUnits = BigInt(parseAttribute(attribute.value));
    }

    if (attribute.key === "num_estimated_compute_units") {
      numEstimatedComputedUnits = BigInt(parseAttribute(attribute.value));
    }

    if (attribute.key === "claimed_upokt") {
      claimed = getDenomAndAmount(attribute.value as string);
    }

    if (attribute.key === "settlement_result") {
      settlementResult = JSON.parse(attribute.value as string);
    }

    if (attribute.key === "reward_distribution") {
      rewardDistribution = JSON.parse(attribute.value as string);
    }

    if (attribute.key === "proof_missing_penalty") {
      proofMissingPenalty = getDenomAndAmount(attribute.value as string);
    }

    if (attribute.key === "failure_reason") {
      failureReason = parseAttribute(attribute.value as string);
    }

    if (attribute.key === "proof_status") {
      proofValidationStatus = getClaimProofStatusFromSDK(parseAttribute(attribute.value as string));
    }

    if (["proof_requirement_int", "proof_requirement"].includes(attribute.key as string)) {
      const parsed = parseAttribute(attribute.value as string);

      const value = attribute.key === "proof_requirement_int" ? parseInt(parsed) : parsed;

      switch (proofRequirementReasonFromJSON(value)) {
        case ProofRequirementReasonSDKType.THRESHOLD:
          proofRequirement = ProofRequirementReason.THRESHOLD;
          break;
        case ProofRequirementReasonSDKType.NOT_REQUIRED:
          proofRequirement = ProofRequirementReason.NOT_REQUIRED;
          break;
        case ProofRequirementReasonSDKType.PROBABILISTIC:
          proofRequirement = ProofRequirementReason.PROBABILISTIC;
          break;
        default: {
          throw new Error(`Unknown ProofRequirementReason: ${attribute.value}`);
        }
      }
    }

    if (attribute.key === "expiration_reason") {
      switch (claimExpirationReasonFromJSON(parseAttribute(attribute.value))) {
        case ClaimExpirationReasonSDKType.EXPIRATION_REASON_UNSPECIFIED:
          expirationReason = ClaimExpirationReason.EXPIRATION_REASON_UNSPECIFIED;
          break;
        case ClaimExpirationReasonSDKType.PROOF_INVALID:
          expirationReason = ClaimExpirationReason.PROOF_INVALID;
          break;
        case ClaimExpirationReasonSDKType.PROOF_MISSING:
          expirationReason = ClaimExpirationReason.PROOF_MISSING;
          break;
        default: {
          throw new Error(`Unknown ClaimExpirationReason: ${attribute.value}`);
        }
      }
    }
  }

  if (isEmpty(claim) && Object.keys(newClaim).length > 1) {
    claim = newClaim;
  }

  return {
    claim,
    proof,
    numRelays,
    numClaimedComputedUnits,
    numEstimatedComputedUnits,
    claimed,
    proofRequirement,
    expirationReason,
    proofMissingPenalty,
    failureReason,
    proofValidationStatus,
    settlementResult,
    rewardDistribution,
  };
}

function _handleMsgCreateClaim(msg: CosmosMessage<MsgCreateClaim>): MsgCreateClaimProps {
  const { sessionHeader, supplierOperatorAddress } = msg.msg.decodedMsg;
  const applicationId = sessionHeader?.applicationAddress || "";
  const serviceId = sessionHeader?.serviceId || "";
  const sessionId = sessionHeader?.sessionId || "";

  // here we are looking for the right event because transactions
  // can have more than one claim
  const eventClaimCreated = msg.tx.tx.events.find(event => {
    if (event.type === "pocket.proof.EventClaimCreated" || event.type === "pocket.proof.EventClaimUpdated") {
      let supplier = "",
        app = "",
        service = "";

      for (const { key, value } of event.attributes) {
        if (key === "service_id") {
          service = parseAttribute(value);
        }

        if (key === "application_address") {
          app = parseAttribute(value);
        }

        if (key === "supplier_operator_address") {
          supplier = parseAttribute(value);
        }

        if (key === "claim") {
          const claim: ClaimSDKType = parseJson(value as string);

          app = claim.session_header?.application_address || "";
          service = claim.session_header?.service_id || "";
          supplier = claim.supplier_operator_address || "";
        }

        if (service && app && supplier) {
          break;
        }
      }

      return service === serviceId &&
        app === applicationId &&
        supplier === supplierOperatorAddress;
    }

    return false;
  });

  if (!eventClaimCreated) {
    logger.info(`[_handleMsgCreateClaim] EventClaimCreated not found for msg MsgCreateClaim ${msg.idx} ${msg.tx.hash} ${msg.block.block.header.height} ${stringify(msg.tx.tx.events)}`);
    throw new Error(`EventClaimCreated not found for msg MsgCreateClaim ${msg.idx} ${msg.tx.hash} ${msg.block.block.header.height}`);
  }

  /**
   *   {
   *     "type": "pocket.proof.EventClaimUpdated",
   *     "attributes": [
   *       {
   *         "key": "application_address",
   *         "value": "\"pokt16wwc45wjc4ulne7wmaawxhju00vwf900lscfld\""
   *       },
   *       {
   *         "key": "claim_proof_status_int",
   *         "value": "0"
   *       },
   *       {
   *         "key": "claimed_upokt",
   *         "value": "\"186upokt\""
   *       },
   *       {
   *         "key": "num_claimed_compute_units",
   *         "value": "\"6047\""
   *       },
   *       {
   *         "key": "num_estimated_compute_units",
   *         "value": "\"6047\""
   *       },
   *       {
   *         "key": "num_relays",
   *         "value": "\"6047\""
   *       },
   *       {
   *         "key": "service_id",
   *         "value": "\"hey\""
   *       },
   *       {
   *         "key": "session_end_block_height",
   *         "value": "\"363540\""
   *       },
   *       {
   *         "key": "supplier_operator_address",
   *         "value": "\"pokt1wua234ulad3vkcsqmasu845mn4ugu9aa6jcv23\""
   *       },
   *       {
   *         "key": "msg_index",
   *         "value": "0"
   *       }
   *     ]
   *   }
   * ]
   */

  const {
    claimed,
    numClaimedComputedUnits,
    numEstimatedComputedUnits,
    numRelays,
  } = getAttributes(eventClaimCreated.attributes);

  return {
    id: messageId(msg),
    transactionId: msg.tx.hash,
    blockId: getBlockId(msg.block),
    supplierId: supplierOperatorAddress,
    applicationId,
    serviceId,
    sessionId,
    numRelays,
    numClaimedComputedUnits,
    numEstimatedComputedUnits,
    claimedDenom: claimed?.denom || "",
    claimedAmount: BigInt(claimed?.amount || "0"),
    sessionStartHeight: BigInt(sessionHeader?.sessionStartBlockHeight?.toString() || 0),
    sessionEndHeight: BigInt(sessionHeader?.sessionEndBlockHeight?.toString() || 0),
    rootHash: undefined,
  };
}

function _handleMsgSubmitProof(msg: CosmosMessage<MsgSubmitProof>): MsgSubmitProofProps {
  const { sessionHeader, supplierOperatorAddress } = msg.msg.decodedMsg;

  const applicationId = sessionHeader?.applicationAddress || "";
  const serviceId = sessionHeader?.serviceId || "";
  const sessionId = sessionHeader?.sessionId || "";
  const msgId = messageId(msg);

  return {
    id: msgId,
    transactionId: msg.tx.hash,
    blockId: getBlockId(msg.block),
    applicationId,
    supplierId: supplierOperatorAddress,
    sessionId,
    serviceId,
    sessionEndHeight: BigInt(sessionHeader?.sessionEndBlockHeight?.toString() || 0),
    sessionStartHeight: BigInt(sessionHeader?.sessionStartBlockHeight?.toString() || 0),
    proof: undefined,
  };
}

function _handleEventClaimSettled(
  event: CosmosEvent,
  mintRatio: number,
  getEffectiveBurn: (application: string, supplier: string) => string | null
): [EventClaimSettledProps, Array<ModToAcctTransferProps>] {
  const {
    claim,
    claimed,
    numClaimedComputedUnits,
    numEstimatedComputedUnits,
    numRelays,
    proofRequirement,
    rewardDistribution,
    settlementResult,
  } = getAttributes(event.event.attributes);

  const { proof_validation_status, session_header, supplier_operator_address } = claim;

  const eventId = getEventId(event);
  const blockId = getBlockId(event.block);

  // We need to see if there is an EventApplicationOverserviced event with effective_burn to use instead of claimed.amount
  // because if this event exists for this session, it means less was paid
  const effectiveBurn = getEffectiveBurn(session_header?.application_address || "", supplier_operator_address) || claimed.amount

  let
    modToAcctTransfers: Array<ModToAcctTransferProps> = [],
    mints: EventClaimSettledProps["mints"] = [],
    burns: EventClaimSettledProps["burns"] = [],
    modToModTransfers: EventClaimSettledProps["modToModTransfers"] = [];

  if (settlementResult) {
    modToAcctTransfers = settlementResult.mod_to_acct_transfers?.map((item, index) => ({
      id: `${eventId}-${index}`,
      blockId,
      eventClaimSettledId: eventId,
      senderModule: item.SenderModule,
      recipientId: item.RecipientAddress,
      amount: BigInt(item.coin.amount),
      denom: item.coin.denom,
      opReason: getSettlementOpReasonFromSDK(item.op_reason),
      relayId: "",
    })) || [];

    mints = settlementResult.mints?.map(mint => ({
      opReason: settlementOpReasonFromJSON(mint.op_reason),
      destinationModule: mint.DestinationModule,
      amount: BigInt(mint.coin.amount),
      denom: mint.coin.denom,
    })) || [];

    burns = settlementResult.burns?.map(burn => ({
      opReason: settlementOpReasonFromJSON(burn.op_reason),
      destinationModule: burn.DestinationModule,
      amount: BigInt(burn.coin.amount),
      denom: burn.coin.denom,
    })) || [];

    modToModTransfers = settlementResult.mod_to_mod_transfers?.map((item) => ({
      opReason: settlementOpReasonFromJSON(item.op_reason),
      senderModule: item.SenderModule,
      recipientModule: item.RecipientModule,
      amount: BigInt(item.coin.amount),
      denom: item.coin.denom,
    })) || [];
  } else if (rewardDistribution) {
    let totalFromRewardDistribution = BigInt(0);

    modToAcctTransfers = Object.entries(rewardDistribution).map(([address, coinString], index) => {
      const coin = getDenomAndAmount(coinString);
      const coinAmount = BigInt(coin.amount);
      totalFromRewardDistribution = totalFromRewardDistribution + coinAmount;

      return {
        id: `${eventId}-${index}`,
        blockId,
        eventClaimSettledId: eventId,
        senderModule: "",
        recipientId: address,
        opReason: SettlementOpReason.UNSPECIFIED,
        relayId: "",
        denom: coin.denom,
        amount: coinAmount,
      };
    });

    // it seems that global mint is being minted twice, one due to inflation and the other due to application reimbursement
    // see:
    //      https://github.com/pokt-network/poktroll/blob/main/x/tokenomics/token_logic_module/tlm_reimbursement_requests.go#L57
    //      https://github.com/pokt-network/poktroll/blob/main/x/tokenomics/token_logic_module/tlm_reimbursement_requests.go#L102-L112
    // so in order to get the inflation mint, we need to divide the difference between the total of the reward_distribution
    // and the claimed upokt
    const mintedAfterRatio = Math.floor(Number(effectiveBurn) * mintRatio);
    const inflationPlusReimbursementMint = totalFromRewardDistribution - BigInt(mintedAfterRatio);

    if (inflationPlusReimbursementMint < BigInt(0)) {
      throw new Error(
        `inflationAndReimbursementMint is negative, totalFromRewardDistribution: ${totalFromRewardDistribution}, claimed.amount: ${effectiveBurn}, inflationAndReimbursementMint: ${inflationPlusReimbursementMint}, mintRatio: ${mintRatio}`
      )
    }

    const inflationAndReimbursementMint = inflationPlusReimbursementMint / BigInt(2);

    burns = [
      {
        opReason: settlementOpReasonFromJSON(SettlementOpReasonSdk.TLM_RELAY_BURN_EQUALS_MINT_APPLICATION_STAKE_BURN),
        destinationModule: "",
        amount: BigInt(effectiveBurn),
        denom: claimed.denom,
      },
    ];

    mints = [
      {
        opReason: settlementOpReasonFromJSON(SettlementOpReasonSdk.TLM_GLOBAL_MINT_INFLATION),
        destinationModule: "",
        amount: inflationAndReimbursementMint,
        denom: claimed.denom,
      },
      {
        opReason: settlementOpReasonFromJSON(SettlementOpReasonSdk.TLM_GLOBAL_MINT_REIMBURSEMENT_REQUEST_ESCROW_DAO_TRANSFER),
        destinationModule: "",
        amount: inflationAndReimbursementMint,
        denom: claimed.denom,
      },
      {
        opReason: settlementOpReasonFromJSON(SettlementOpReasonSdk.TLM_RELAY_BURN_EQUALS_MINT_SUPPLIER_STAKE_MINT),
        destinationModule: "",
        amount: BigInt(mintedAfterRatio),
        denom: claimed.denom,
      },
    ];
  }

  const CUPR = Math.floor(Number(numClaimedComputedUnits) / Number(numRelays))
  const numEstimatedRelays = BigInt(Math.round(Number(numEstimatedComputedUnits) / CUPR))

  return [
    {
      supplierId: supplier_operator_address,
      applicationId: session_header?.application_address || "",
      serviceId: session_header?.service_id || "",
      sessionId: session_header?.session_id || "",
      sessionStartHeight: BigInt(session_header?.session_start_block_height?.toString() || 0),
      sessionEndHeight: BigInt(session_header?.session_end_block_height?.toString() || 0),
      numRelays,
      numEstimatedRelays,
      numClaimedComputedUnits,
      numEstimatedComputedUnits,
      claimedDenom: claimed?.denom || "",
      claimedAmount: BigInt(effectiveBurn || "0"),
      proofValidationStatus: getClaimProofStatusFromSDK(proof_validation_status),
      transactionId: event.tx?.hash,
      blockId: blockId,
      id: eventId,
      proofRequirement,
      mints,
      burns,
      modToModTransfers,
      rootHash: undefined,
    },
    modToAcctTransfers,
  ];
}

function _handleEventClaimExpired(event: CosmosEvent): EventClaimExpiredProps {
  const {
    claim,
    claimed,
    expirationReason,
    numClaimedComputedUnits,
    numEstimatedComputedUnits,
    numRelays,
  } = getAttributes(event.event.attributes);

  const { proof_validation_status, session_header, supplier_operator_address } = claim;

  const CUPR = Math.floor(Number(numClaimedComputedUnits) / Number(numRelays))
  const numEstimatedRelays = BigInt(Math.round(Number(numEstimatedComputedUnits) / CUPR))

  return {
    supplierId: supplier_operator_address,
    applicationId: session_header?.application_address || "",
    serviceId: session_header?.service_id || "",
    sessionId: session_header?.session_id || "",
    sessionStartHeight: BigInt(session_header?.session_start_block_height?.toString() || 0),
    sessionEndHeight: BigInt(session_header?.session_end_block_height?.toString() || 0),
    numRelays,
    numEstimatedRelays,
    numClaimedComputedUnits,
    numEstimatedComputedUnits,
    claimedDenom: claimed?.denom || "",
    claimedAmount: BigInt(claimed?.amount || "0"),
    proofValidationStatus: getClaimProofStatusFromSDK(proof_validation_status),
    id: getEventId(event),
    expirationReason,
    transactionId: event.tx?.hash,
    blockId: getBlockId(event.block),
    rootHash: undefined,
  };
}

function _handleEventClaimUpdated(event: CosmosEvent): EventClaimUpdatedProps {
  logger.info(`[_handleEventClaimUpdated] ${stringify(event.event, undefined, 2)}`);
  logger.info(`[_handleEventClaimUpdated] ${stringify(event.msg?.msg.decodedMsg, undefined, 2)}`);

  /*
  2025-09-09T20:46:27.038Z <sandbox> INFO [_handleEventClaimUpdated] {
  "type": "pocket.proof.EventClaimUpdated",
  "attributes": [
    {
      "key": "application_address",
      "value": "\"pokt16wwc45wjc4ulne7wmaawxhju00vwf900lscfld\""
    },
    {
      "key": "claim_proof_status_int",
      "value": "0"
    },
    {
      "key": "claimed_upokt",
      "value": "\"186upokt\""
    },
    {
      "key": "num_claimed_compute_units",
      "value": "\"6047\""
    },
    {
      "key": "num_estimated_compute_units",
      "value": "\"6047\""
    },
    {
      "key": "num_relays",
      "value": "\"6047\""
    },
    {
      "key": "service_id",
      "value": "\"hey\""
    },
    {
      "key": "session_end_block_height",
      "value": "\"363540\""
    },
    {
      "key": "supplier_operator_address",
      "value": "\"pokt1wua234ulad3vkcsqmasu845mn4ugu9aa6jcv23\""
    },
    {
      "key": "msg_index",
      "value": "0"
    }
  ]
}
   */
  /*
2025-09-09T20:46:27.039Z <sandbox> INFO [_handleEventClaimUpdated] {
  "supplierOperatorAddress": "pokt1wua234ulad3vkcsqmasu845mn4ugu9aa6jcv23",
  "sessionHeader": {
    "applicationAddress": "pokt16wwc45wjc4ulne7wmaawxhju00vwf900lscfld",
    "serviceId": "hey",
    "sessionId": "76562a609b9cdbbad5807ac196ed9e7a843f1a2cb847ed88d34bef4c4b07102e",
    "sessionStartBlockHeight": "363481",
    "sessionEndBlockHeight": "363540"
  },
  "rootHash": "q105F+TC6Ja2G34niR0C5SxV0mj8B7vUq+c90GZQlakAAAAAAAAXnwAAAAAAABef"
}
   */

  const {
    claimed,
    numClaimedComputedUnits,
    numEstimatedComputedUnits,
    numRelays,
  } = getAttributes(event.event.attributes);

  // this assumes the code at mainnet
  const { sessionHeader, supplierOperatorAddress } = event.msg!.msg!.decodedMsg;
  const applicationId = sessionHeader?.applicationAddress || "";
  const serviceId = sessionHeader?.serviceId || "";
  const sessionId = sessionHeader?.sessionId || "";

  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  // const { proof_validation_status, session_header, supplier_operator_address } = claim;

  return {
    id: getEventId(event),
    transactionId: event.tx?.hash,
    blockId: getBlockId(event.block),
    supplierId: supplierOperatorAddress,
    applicationId: applicationId || "",
    serviceId: serviceId || "",
    sessionId: sessionId || "",
    sessionStartHeight: BigInt(sessionHeader?.sessionStartBlockHeight?.toString() || 0),
    sessionEndHeight: BigInt(sessionHeader?.sessionEndBlockHeight?.toString() || 0),
    numRelays,
    numClaimedComputedUnits,
    numEstimatedComputedUnits,
    claimedDenom: claimed?.denom || "",
    claimedAmount: BigInt(claimed?.amount || "0"),
    relayId: undefined,
    rootHash: undefined,
  };
}

function _handleEventProofUpdated(event: CosmosEvent): EventProofUpdatedProps {
  const {
    claim,
    claimed,
    numClaimedComputedUnits,
    numEstimatedComputedUnits,
    numRelays,
  } = getAttributes(event.event.attributes);

  const { proof_validation_status, session_header, supplier_operator_address } = claim;

  return {
    id: getEventId(event),
    transactionId: event.tx?.hash,
    blockId: getBlockId(event.block),
    supplierId: supplier_operator_address,
    applicationId: session_header?.application_address || "",
    serviceId: session_header?.service_id || "",
    sessionId: session_header?.session_id || "",
    sessionStartHeight: BigInt(session_header?.session_start_block_height?.toString() || 0),
    sessionEndHeight: BigInt(session_header?.session_end_block_height?.toString() || 0),
    numRelays,
    numClaimedComputedUnits,
    numEstimatedComputedUnits,
    claimedDenom: claimed?.denom || "",
    claimedAmount: BigInt(claimed?.amount || "0"),
    ...(proof_validation_status && {
      proofValidationStatus: getClaimProofStatusFromSDK(proof_validation_status),
    }),
    closestMerkleProof: undefined,
    relayId: undefined,
    rootHash: undefined,
  };
}

function _handleEventApplicationOverserviced(event: CosmosEvent): EventApplicationOverservicedProps {
  let expectedBurn: Coin | null = null, effectiveBurn: Coin | null = null, applicationAddress = "",
    supplierAddress = "";

  for (const attribute of event.event.attributes) {
    if (attribute.key === "application_addr") {
      applicationAddress = parseAttribute(attribute.value);
    }

    if (attribute.key === "supplier_operator_addr") {
      supplierAddress = parseAttribute(attribute.value as string);
    }

    if (attribute.key === "expected_burn") {
      expectedBurn = getDenomAndAmount(attribute.value as string);
    }

    if (attribute.key === "effective_burn") {
      effectiveBurn = getDenomAndAmount(attribute.value as string);
    }
  }

  if (!applicationAddress) {
    throw new Error(`[handleEventApplicationOverserviced] applicationAddress not found in event`);
  }

  if (!supplierAddress) {
    throw new Error(`[handleEventApplicationOverserviced] supplierAddress not found in event`);
  }

  if (!expectedBurn) {
    throw new Error(`[handleEventApplicationOverserviced] expectedBurn not found in event`);
  }

  if (!effectiveBurn) {
    throw new Error(`[handleEventApplicationOverserviced] effectiveBurn not found in event`);
  }

  return {
    id: getEventId(event),
    applicationId: applicationAddress,
    supplierId: supplierAddress,
    expectedBurn: BigInt(expectedBurn.amount),
    expectedBurnDenom: expectedBurn.denom,
    effectiveBurn: BigInt(effectiveBurn.amount),
    effectiveBurnDenom: effectiveBurn.denom,
    blockId: getBlockId(event.block),
    eventId: getEventId(event),
  };
}

function _handleEventApplicationReimbursementRequest(event: CosmosEvent): EventApplicationReimbursementRequestProps {
  let applicationAddress = "", supplierAddress = "", serviceId = "", sessionId = "", coin: CoinSDKType | null = null;

  for (const { key, value } of event.event.attributes) {
    if (key === "amount") {
      coin = getDenomAndAmount(value as string);
      continue;
    }

    const parsedValue = parseAttribute(value);

    if (key === "application_addr") {
      applicationAddress = parsedValue;
    }

    if (key === "supplier_operator_addr") {
      supplierAddress = parsedValue;
    }

    if (key === "service_id") {
      serviceId = parsedValue;
    }

    if (key === "session_id") {
      sessionId = parsedValue;
    }
  }

  if (!coin) {
    throw new Error(`[handleEventApplicationReimbursementRequest] coin not found in event`);
  }

  /*
    [
    {"key":"amount","value":"\"1upokt\""},
    {"key":"application_addr","value":"\"pokt1vmm5n6nhes97wels7ghnwnnr8cfkpsxasa7aj3\""},
    {"key":"service_id","value":"\"op-sepolia-testnet\""},
    {"key":"session_id","value":"\"0ed20693e27b81b3a8ec049a2386b88e6f5f419537e4e7642af25d9c6d651477\""},
    {"key":"supplier_operator_addr","value":"\"pokt10l3xtjvmwxpxv6f00fvhtyht80rs26957klqs7\""},
    {"key":"supplier_owner_addr","value":"\"pokt1m3rxtzugp5hvdx40te72cwp9hmpm0zs0kwypmn\""},
    {"key":"mode","value":"EndBlock"}
    ]
   */

  try {
    return {
      id: getEventId(event),
      applicationId: applicationAddress,
      supplierId: supplierAddress,
      serviceId,
      sessionId,
      amount: BigInt(coin.amount),
      denom: coin.denom,
      blockId: getBlockId(event.block),
      eventId: getEventId(event),
    };
  } catch (e) {
    logger.info(`[handleEventApplicationReimbursementRequest] error parsing event: ${stringify(event.event.attributes)}`);
    throw e;
  }
}

// eslint-disable-next-line complexity
function _handleEventProofValidityChecked(event: CosmosEvent): EventProofValidityCheckedProps {
  let supplierOperatorAddress = "",
    failReason = "",
    applicationAddress = "",
    serviceId = "",
    sessionId = "";

  let sessionStartBlockHeight = BigInt(0),
    sessionEndBlockHeight = BigInt(0);

  let validationStatus: ClaimProofStatus | undefined;

  // in the current proto files of this event, proof does not come, but in the older version of this event it comes.
  const { claim, failureReason, proof, proofValidationStatus } = getAttributes(event.event.attributes);

  if (!claim?.session_header && !proof?.session_header) {
    // then we are in a higher block with a new structure.
    /*
      [
        {"key":"application_address","value":"\"pokt1vmm5n6nhes97wels7ghnwnnr8cfkpsxasa7aj3\""},
        {"key":"block_height","value":"\"363564\""},
        {"key":"claim_proof_status_int","value":"1"},
        {"key":"failure_reason","value":"\"\""},
        {"key":"service_id","value":"\"op-sepolia-testnet\""},
        {"key":"session_end_block_height","value":"\"363540\""},
        {"key":"supplier_operator_address","value":"\"pokt12yfuputzl082knnjc0pwrjpuxw43u272u02vj4\""},
        {"key":"mode","value":"EndBlock"}
      ]
   */
    for (const attribute of event.event.attributes) {
      if (attribute.key === "claim_proof_status_int") {
        validationStatus = getClaimProofStatusFromSDK(JSON.parse(parseAttribute(attribute.value)));
      }
      if (attribute.key === "failure_reason") {
        failReason = attribute.value as string;
      }
      if (attribute.key === "supplier_operator_address") {
        supplierOperatorAddress = attribute.value as string;
      }
      if (attribute.key === "service_id") {
        serviceId = attribute.value as string;
      }
      if (attribute.key === "application_address") {
        applicationAddress = attribute.value as string;
      }
      if (attribute.key === "session_end_block_height") {
        sessionEndBlockHeight = BigInt(parseAttribute(attribute.value as string || "0"));
      }
      if (attribute.key === "session_start_block_height") {
        sessionStartBlockHeight = BigInt(parseAttribute(attribute.value as string || "0"));
      }
    }
  } else {
    supplierOperatorAddress = proof?.supplier_operator_address || claim?.supplier_operator_address;
    validationStatus = proofValidationStatus || getClaimProofStatusFromSDK(parseAttribute(claim?.proof_validation_status));
    const sessionHeader = proof?.session_header || claim?.session_header;
    if (!sessionHeader) {
      throw new Error(`[handleEventProofValidityChecked] session_header not found in event ${stringify(event.event.attributes)}`);
    }
    sessionId = sessionHeader.session_id;
    serviceId = sessionHeader.service_id;
    applicationAddress = sessionHeader.application_address;
    sessionStartBlockHeight = sessionHeader.session_start_block_height;
    sessionEndBlockHeight = sessionHeader.session_end_block_height;
    failReason = failureReason || "";
  }

  if (!supplierOperatorAddress) {
    throw new Error(`[handleEventProofValidityChecked] supplier_operator_address not found in event ${stringify(event.event.attributes)}`);
  }

  if (!validationStatus) {
    logger.error(`[handleEventProofValidityChecked] proofValidationStatus not found in event: ${stringify(event.event.attributes)}`);
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    return [];
    // throw new Error(`[handleEventProofValidityChecked] proofValidationStatus not found in event`);
  }

  if (failureReason === null) {
    logger.error(`[handleEventProofValidityChecked] failureReason not found in event: ${stringify(event.event.attributes)}`);
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    return [];
    // throw new Error(`[handleEventProofValidityChecked] failureReason not found in event`);
  }
  return {
    id: getEventId(event),
    blockId: getBlockId(event.block),
    supplierId: supplierOperatorAddress as string,
    applicationId: applicationAddress as unknown as string,
    serviceId: serviceId as unknown as string,
    sessionId: sessionId as unknown as string,
    sessionStartHeight: sessionStartBlockHeight,
    sessionEndHeight: sessionEndBlockHeight,
    proofValidationStatus: validationStatus as ClaimProofStatus,
    failureReason: failReason,
    eventId: getEventId(event),
  };
}

export async function handleMsgCreateClaim(messages: Array<CosmosMessage<MsgCreateClaim>>): Promise<void> {
  await optimizedBulkCreate("MsgCreateClaim", messages.map(_handleMsgCreateClaim), 'block_id');
}

export async function handleMsgSubmitProof(messages: Array<CosmosMessage<MsgSubmitProof>>): Promise<void> {
  await optimizedBulkCreate("MsgSubmitProof", messages.map(_handleMsgSubmitProof), 'block_id');
}

export async function handleEventClaimExpired(events: Array<CosmosEvent>): Promise<void> {
  await optimizedBulkCreate("EventClaimExpired", events.map(_handleEventClaimExpired), 'block_id');
}

export async function handleEventClaimSettled(events: Array<CosmosEvent>, overservices: Array<CosmosEvent>): Promise<void> {
  // Load the min_ratio parameter from tokenomics module
  // This parameter is updated via AuthzExecMsg (transactions) and EventClaimSettled events are block events
  // Block events run after params are changed, so the param should already be updated in the database
  const mintRatioParam = await Param.get(getParamId("tokenomics", "mint_ratio"));

  const mintRatio = mintRatioParam ? parseFloat(mintRatioParam.value) : 1; // Default to 1 if not found, meaning it was before the PIP-41

  const eventsSettled = [];
  const modToAcctTransfersToSave = [];

  const effectiveBurnPerAppAndSupplier = overservices.reduce((acc, overservice) => {
    let effectiveBurn: CoinSDKType | undefined, application = '', supplier = '';

    for (const attribute of overservice.event.attributes) {
      if (attribute.key === "application_addr") {
        application = parseAttribute(attribute.value);
      }

      if (attribute.key === "supplier_operator_addr") {
        supplier = parseAttribute(attribute.value);
      }

      if (attribute.key === "effective_burn") {
        effectiveBurn = getDenomAndAmount(attribute.value as string);
      }
    }

    if (effectiveBurn && application && supplier) {
      acc[`${application}-${supplier}`] = effectiveBurn.amount;
    }

    return acc;
  }, {} as Record<string, string>);

  function getEffectiveBurn(application: string, supplier: string): string | null {
    return effectiveBurnPerAppAndSupplier[`${application}-${supplier}`] || null;
  }

  for (const event of events) {
    const [eventSettled, modToAcctTransfers] = _handleEventClaimSettled(event, mintRatio, getEffectiveBurn);
    eventsSettled.push(eventSettled);

    if (modToAcctTransfers.length) {
      modToAcctTransfersToSave.push(...modToAcctTransfers);
    }
  }

  await Promise.all([
    optimizedBulkCreate("EventClaimSettled", eventsSettled, 'block_id'),
    optimizedBulkCreate("ModToAcctTransfer", modToAcctTransfersToSave, 'block_id'),
  ]);
}

export async function handleEventClaimUpdated(events: Array<CosmosEvent>): Promise<void> {
  await optimizedBulkCreate("EventClaimUpdated", events.map(_handleEventClaimUpdated), 'block_id');
}

export async function handleEventProofUpdated(events: Array<CosmosEvent>): Promise<void> {
  await optimizedBulkCreate("EventProofUpdated", events.map(_handleEventProofUpdated), 'block_id');
}

export async function handleEventApplicationOverserviced(events: Array<CosmosEvent>): Promise<void> {
  const eventsUpdated = events.map(_handleEventApplicationOverserviced);

  await optimizedBulkCreate("EventApplicationOverserviced", eventsUpdated, 'block_id');
}

export async function handleEventApplicationReimbursementRequest(events: Array<CosmosEvent>): Promise<void> {
  const eventsUpdated = events.map(_handleEventApplicationReimbursementRequest);

  await optimizedBulkCreate("EventApplicationReimbursementRequest", eventsUpdated, 'block_id');
}

export async function handleEventProofValidityChecked(events: Array<CosmosEvent>): Promise<void> {
  await optimizedBulkCreate("EventProofValidityChecked", events.map(_handleEventProofValidityChecked), 'block_id');
}
