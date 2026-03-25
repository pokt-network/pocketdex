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
import { getDbSchema, optimizedBulkCreate, rawBulkInsert } from "../utils/db";
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

type ModToAcctTransferRecord = {
  id: string;
  eventClaimSettledId: string;
  blockId: bigint;
  opReason: string;
  recipientId: string;
  amount: bigint;
  denom: string;
};

type SummarizedTransferRecord = {
  id: string;
  blockId: bigint;
  recipientId: string;
  opReason: string;
  denom: string;
  serviceId: string;
  amount: bigint;
  transferCount: bigint;
};

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

    case "TLM_RELAY_BURN_EQUALS_MINT_DAO_REWARD_DISTRIBUTION":
    case SettlementOpReasonSDKType.TLM_RELAY_BURN_EQUALS_MINT_DAO_REWARD_DISTRIBUTION:
      return SettlementOpReason.TLM_RELAY_BURN_EQUALS_MINT_DAO_REWARD_DISTRIBUTION;

    case "TLM_RELAY_BURN_EQUALS_MINT_SOURCE_OWNER_REWARD_DISTRIBUTION":
    case SettlementOpReasonSDKType.TLM_RELAY_BURN_EQUALS_MINT_SOURCE_OWNER_REWARD_DISTRIBUTION:
      return SettlementOpReason.TLM_RELAY_BURN_EQUALS_MINT_SOURCE_OWNER_RD;

    case "TLM_RELAY_BURN_EQUALS_MINT_APPLICATION_REWARD_DISTRIBUTION":
    case SettlementOpReasonSDKType.TLM_RELAY_BURN_EQUALS_MINT_APPLICATION_REWARD_DISTRIBUTION:
      return SettlementOpReason.TLM_RELAY_BURN_EQUALS_MINT_APPLICATION_RD;

    case "TLM_RELAY_BURN_EQUALS_MINT_TOKENOMICS_CLAIM_DISTRIBUTION_MINT":
    case SettlementOpReasonSDKType.TLM_RELAY_BURN_EQUALS_MINT_TOKENOMICS_CLAIM_DISTRIBUTION_MINT:
      return SettlementOpReason.TLM_RELAY_BURN_EQUALS_MINT_TOKENOMICS_MINT;

    case "TLM_RELAY_BURN_EQUALS_MINT_VALIDATOR_REWARD_DISTRIBUTION":
    case SettlementOpReasonSDKType.TLM_RELAY_BURN_EQUALS_MINT_VALIDATOR_REWARD_DISTRIBUTION:
      return SettlementOpReason.TLM_RELAY_BURN_EQUALS_MINT_VALIDATOR_RD;

    case "TLM_RELAY_BURN_EQUALS_MINT_DELEGATOR_REWARD_DISTRIBUTION":
    case SettlementOpReasonSDKType.TLM_RELAY_BURN_EQUALS_MINT_DELEGATOR_REWARD_DISTRIBUTION:
      return SettlementOpReason.TLM_RELAY_BURN_EQUALS_MINT_DELEGATOR_RD;

    case "TLM_GLOBAL_MINT_VALIDATOR_REWARD_DISTRIBUTION":
    case SettlementOpReasonSDKType.TLM_GLOBAL_MINT_VALIDATOR_REWARD_DISTRIBUTION:
      return SettlementOpReason.TLM_GLOBAL_MINT_VALIDATOR_REWARD_DISTRIBUTION;

    case "TLM_GLOBAL_MINT_DELEGATOR_REWARD_DISTRIBUTION":
    case SettlementOpReasonSDKType.TLM_GLOBAL_MINT_DELEGATOR_REWARD_DISTRIBUTION:
      return SettlementOpReason.TLM_GLOBAL_MINT_DELEGATOR_REWARD_DISTRIBUTION;

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
    rewardDistribution: Record<string, string> | undefined,
    rewardDistributionDetailed: Array<{ recipient_address: string; op_reason: number; amount: string }> | undefined,
    settledUpokt: CoinSDKType | undefined,
    mintRatioStr: string | undefined,
    supplierOwnerAddress: string | undefined,
    chainNumEstimatedRelays: bigint | undefined,
    mintedUpokt: CoinSDKType | undefined,
    overservicingLossUpokt: CoinSDKType | undefined,
    deflationLossUpokt: CoinSDKType | undefined;

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
      if (!newClaim.session_header!.session_id) {
        newClaim.session_header!.session_id = "";
      }
    }

    if (attribute.key === "session_id") {
      newClaim.session_header!.session_id = parseAttribute(attribute.value);
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

    if (attribute.key === "reward_distribution_detailed") {
      rewardDistributionDetailed = JSON.parse(attribute.value as string);
    }

    if (attribute.key === "settled_upokt") {
      settledUpokt = getDenomAndAmount(attribute.value as string);
    }

    if (attribute.key === "mint_ratio") {
      mintRatioStr = parseAttribute(attribute.value);
    }

    if (attribute.key === "supplier_owner_address") {
      supplierOwnerAddress = parseAttribute(attribute.value);
    }

    if (attribute.key === "num_estimated_relays") {
      chainNumEstimatedRelays = BigInt(parseAttribute(attribute.value));
    }

    if (attribute.key === "minted_upokt") {
      mintedUpokt = getDenomAndAmount(attribute.value as string);
    }

    if (attribute.key === "overservicing_loss_upokt") {
      overservicingLossUpokt = getDenomAndAmount(attribute.value as string);
    }

    if (attribute.key === "deflation_loss_upokt") {
      deflationLossUpokt = getDenomAndAmount(attribute.value as string);
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
    rewardDistributionDetailed,
    settledUpokt,
    mintRatioStr,
    supplierOwnerAddress,
    chainNumEstimatedRelays,
    mintedUpokt,
    overservicingLossUpokt,
    deflationLossUpokt,
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

  const CUPR = Math.floor(Number(numClaimedComputedUnits) / Number(numRelays))
  const numEstimatedRelays = BigInt(Math.round(Number(numEstimatedComputedUnits) / CUPR))

  return {
    id: messageId(msg),
    transactionId: msg.tx.hash,
    blockId: getBlockId(msg.block),
    supplierId: supplierOperatorAddress,
    applicationId,
    serviceId,
    sessionId,
    numRelays,
    numEstimatedRelays,
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

interface SettlementParts {
  modToAcctTransfers: Array<ModToAcctTransferRecord>;
  mints: EventClaimSettledProps["mints"];
  burns: EventClaimSettledProps["burns"];
  modToModTransfers: EventClaimSettledProps["modToModTransfers"];
  mintedUpokt: CoinSDKType | undefined;
}

// Builds burns and mints arrays from reward distribution totals.
// Global mint is minted twice: once for inflation, once for application reimbursement.
// See:
//   https://github.com/pokt-network/poktroll/blob/main/x/tokenomics/token_logic_module/tlm_reimbursement_requests.go#L57
//   https://github.com/pokt-network/poktroll/blob/main/x/tokenomics/token_logic_module/tlm_reimbursement_requests.go#L102-L112
function _buildBurnsAndMintsFromRewardTotal(
  totalFromRewardDistribution: bigint,
  effectiveBurn: string,
  mintRatio: number,
  claimed: CoinSDKType,
  mintedUpokt: CoinSDKType | undefined,
): { burns: EventClaimSettledProps["burns"]; mints: EventClaimSettledProps["mints"]; mintedUpokt: CoinSDKType | undefined } {
  const mintedAfterRatio = mintedUpokt ? Number(mintedUpokt.amount) : Math.floor(Number(effectiveBurn) * mintRatio);
  const inflationPlusReimbursementMint = totalFromRewardDistribution - BigInt(mintedAfterRatio);

  if (inflationPlusReimbursementMint < BigInt(0)) {
    throw new Error(
      `inflationAndReimbursementMint is negative, totalFromRewardDistribution: ${totalFromRewardDistribution}, claimed.amount: ${effectiveBurn}, inflationAndReimbursementMint: ${inflationPlusReimbursementMint}, mintRatio: ${mintRatio}`
    )
  }

  const inflationAndReimbursementMint = inflationPlusReimbursementMint / BigInt(2);

  const burns: EventClaimSettledProps["burns"] = [
    {
      opReason: settlementOpReasonFromJSON(SettlementOpReasonSdk.TLM_RELAY_BURN_EQUALS_MINT_APPLICATION_STAKE_BURN),
      destinationModule: "",
      amount: BigInt(effectiveBurn),
      denom: claimed.denom,
    },
  ];

  const mints: EventClaimSettledProps["mints"] = [
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

  if (!mintedUpokt) {
    mintedUpokt = {
      amount: mintedAfterRatio.toString(),
      denom: claimed.denom,
    }
  }

  return { burns, mints, mintedUpokt };
}

function _buildSettlementFromResult(
  settlementResult: ClaimSettlementResultSDKType,
  eventId: string,
  blockId: bigint,
  effectiveBurn: string,
  claimed: CoinSDKType,
  mintedUpokt: CoinSDKType | undefined,
): SettlementParts {
  const modToAcctTransfers = settlementResult.mod_to_acct_transfers?.map((item, index) => ({
    id: `${eventId}-${index}`,
    blockId,
    eventClaimSettledId: eventId,

    recipientId: item.RecipientAddress,
    amount: BigInt(item.coin.amount),
    denom: item.coin.denom,
    opReason: getSettlementOpReasonFromSDK(item.op_reason),

  })) || [];

  if (!mintedUpokt) {
    // if we get settlementResult that means mintRatio is equal to 1, so the amount minted will be equal to the settled amount, to the effective burn too due to burn being equal to mint
    mintedUpokt = {
      amount: effectiveBurn,
      denom: claimed.denom,
    }
  }

  const mints = settlementResult.mints?.map(mint => ({
    opReason: settlementOpReasonFromJSON(mint.op_reason),
    destinationModule: mint.DestinationModule,
    amount: BigInt(mint.coin.amount),
    denom: mint.coin.denom,
  })) || [];

  const burns = settlementResult.burns?.map(burn => ({
    opReason: settlementOpReasonFromJSON(burn.op_reason),
    destinationModule: burn.DestinationModule,
    amount: BigInt(burn.coin.amount),
    denom: burn.coin.denom,
  })) || [];

  const modToModTransfers = settlementResult.mod_to_mod_transfers?.map((item) => ({
    opReason: settlementOpReasonFromJSON(item.op_reason),
    senderModule: item.SenderModule,
    recipientModule: item.RecipientModule,
    amount: BigInt(item.coin.amount),
    denom: item.coin.denom,
  })) || [];

  return { modToAcctTransfers, mints, burns, modToModTransfers, mintedUpokt };
}

function _buildSettlementFromDetailedDistribution(
  rewardDistributionDetailed: Array<{ amount: string; op_reason: typeof SettlementOpReasonSDKType | number | string; recipient_address: string }>,
  eventId: string,
  blockId: bigint,
  effectiveBurn: string,
  claimed: CoinSDKType,
  mintedUpokt: CoinSDKType | undefined,
): SettlementParts {
  let inflationAmount = BigInt(0);
  let reimbursementAmount = BigInt(0);

  const modToAcctTransfers = rewardDistributionDetailed.map((item, index) => {
    const coin = getDenomAndAmount(item.amount)
    const coinAmount = BigInt(coin.amount);
    const reason = getSettlementOpReasonFromSDK(item.op_reason);

    if (reason === SettlementOpReason.TLM_GLOBAL_MINT_DAO_REWARD_DISTRIBUTION) {
      inflationAmount += coinAmount;
    } else if (reason === SettlementOpReason.TLM_GLOBAL_MINT_REIMBURSEMENT_REQUEST_ESCROW_DAO_TRANSFER) {
      reimbursementAmount += coinAmount;
    }

    return {
      opReason: reason,
      amount: coinAmount,
      id: `${eventId}-${index}`,
      blockId,
      eventClaimSettledId: eventId,
      senderModule: "",
      recipientId: item.recipient_address,
      relayId: "",
      denom: coin.denom,
    };
  });

  const resolvedMintedUpokt: CoinSDKType = mintedUpokt || {
    amount: effectiveBurn,
    denom: claimed.denom,
  };

  const burns: EventClaimSettledProps["burns"] = [
    {
      opReason: settlementOpReasonFromJSON(SettlementOpReasonSdk.TLM_RELAY_BURN_EQUALS_MINT_APPLICATION_STAKE_BURN),
      destinationModule: "",
      amount: BigInt(effectiveBurn),
      denom: claimed.denom,
    },
  ];

  if (inflationAmount === BigInt(0)) {
    throw new Error(`Missing TLM_GLOBAL_MINT_DAO_REWARD_DISTRIBUTION in reward_distribution_detailed for event ${eventId}`);
  }

  if (reimbursementAmount === BigInt(0)) {
    throw new Error(`Missing TLM_GLOBAL_MINT_REIMBURSEMENT_REQUEST_ESCROW_DAO_TRANSFER in reward_distribution_detailed for event ${eventId}`);
  }

  const mints: EventClaimSettledProps["mints"] = [
    {
      opReason: settlementOpReasonFromJSON(SettlementOpReasonSdk.TLM_RELAY_BURN_EQUALS_MINT_TOKENOMICS_CLAIM_DISTRIBUTION_MINT),
      destinationModule: "",
      amount: BigInt(resolvedMintedUpokt.amount),
      denom: claimed.denom,
    },
    {
      opReason: settlementOpReasonFromJSON(SettlementOpReasonSdk.TLM_GLOBAL_MINT_DAO_REWARD_DISTRIBUTION),
      destinationModule: "",
      amount: inflationAmount,
      denom: claimed.denom,
    },
    {
      opReason: settlementOpReasonFromJSON(SettlementOpReasonSdk.TLM_GLOBAL_MINT_REIMBURSEMENT_REQUEST_ESCROW_DAO_TRANSFER),
      destinationModule: "",
      amount: reimbursementAmount,
      denom: claimed.denom,
    },
  ];

  return { modToAcctTransfers, mints, burns, modToModTransfers: [], mintedUpokt: resolvedMintedUpokt };
}

function _buildSettlementFromDistribution(
  rewardDistribution: Record<string, string>,
  eventId: string,
  blockId: bigint,
  effectiveBurn: string,
  mintRatio: number,
  claimed: CoinSDKType,
): SettlementParts {
  let totalFromRewardDistribution = BigInt(0);

  const modToAcctTransfers = Object.entries(rewardDistribution).map(([address, coinString], index) => {
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

  const { burns, mintedUpokt, mints } =
    _buildBurnsAndMintsFromRewardTotal(totalFromRewardDistribution, effectiveBurn, mintRatio, claimed, undefined);

  return { modToAcctTransfers, mints, burns, modToModTransfers: [], mintedUpokt };
}

function _resolveSettlementParts(
  attributes: ReturnType<typeof getAttributes>,
  eventId: string,
  blockId: bigint,
  effectiveBurn: string,
  mintRatio: number,
): SettlementParts {
  const { claimed, mintedUpokt, rewardDistribution, rewardDistributionDetailed, settlementResult } = attributes;

  if (settlementResult) {
    return _buildSettlementFromResult(settlementResult, eventId, blockId, effectiveBurn, claimed, mintedUpokt);
  }

  if (rewardDistributionDetailed) {
    return _buildSettlementFromDetailedDistribution(
      rewardDistributionDetailed, eventId, blockId, effectiveBurn, claimed, mintedUpokt,
    );
  }

  if (rewardDistribution) {
    return _buildSettlementFromDistribution(rewardDistribution, eventId, blockId, effectiveBurn, mintRatio, claimed);
  }

  return { modToAcctTransfers: [], mints: [], burns: [], modToModTransfers: [], mintedUpokt };
}

function _computeNumEstimatedRelays(
  chainNumEstimatedRelays: bigint | undefined,
  numEstimatedComputedUnits: bigint,
  numClaimedComputedUnits: bigint,
  numRelays: bigint,
): bigint {
  if (chainNumEstimatedRelays !== undefined) {
    return chainNumEstimatedRelays;
  }
  return BigInt(Math.round(Number(numEstimatedComputedUnits) / Math.floor(Number(numClaimedComputedUnits) / Number(numRelays))));
}

function _computeDeflationLoss(
  deflationLossUpokt: CoinSDKType | undefined,
  effectiveBurn: string,
  mintedUpokt: CoinSDKType | undefined,
): bigint {
  return deflationLossUpokt
    ? BigInt(deflationLossUpokt.amount)
    : BigInt(effectiveBurn) - BigInt(mintedUpokt?.amount || 0);
}

function _computeOverservicingLoss(
  overservicingLossUpokt: CoinSDKType | undefined,
  claimedAmount: string,
  effectiveBurn: string,
): bigint {
  if (overservicingLossUpokt) {
    return BigInt(overservicingLossUpokt.amount);
  }
  return claimedAmount !== effectiveBurn
    ? BigInt(claimedAmount) - BigInt(effectiveBurn)
    : BigInt(0);
}

function _buildClaimSettledProps(
  event: CosmosEvent,
  attributes: ReturnType<typeof getAttributes>,
  settlement: SettlementParts,
  effectiveBurn: string,
  mintRatio: number,
): EventClaimSettledProps {
  const {
    chainNumEstimatedRelays,
    claim,
    claimed,
    deflationLossUpokt,
    numClaimedComputedUnits,
    numEstimatedComputedUnits,
    numRelays,
    overservicingLossUpokt,
    proofRequirement,
    settledUpokt,
    supplierOwnerAddress,
  } = attributes;
  const { proof_validation_status, session_header, supplier_operator_address } = claim;
  const { burns, mintedUpokt, mints, modToModTransfers } = settlement;

  const numEstimatedRelays = _computeNumEstimatedRelays(
    chainNumEstimatedRelays, numEstimatedComputedUnits, numClaimedComputedUnits, numRelays,
  );
  const overservicingLossAmount = _computeOverservicingLoss(overservicingLossUpokt, claimed.amount, effectiveBurn);
  const deflationLossAmount = _computeDeflationLoss(deflationLossUpokt, effectiveBurn, mintedUpokt);

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
    claimedAmount: BigInt(effectiveBurn || "0"),
    proofValidationStatus: getClaimProofStatusFromSDK(proof_validation_status),
    transactionId: event.tx?.hash,
    blockId: getBlockId(event.block),
    id: getEventId(event),
    proofRequirement,
    mints,
    burns,
    modToModTransfers,
    rootHash: undefined,
    settledAmount: BigInt(effectiveBurn),
    settledDenom: settledUpokt?.denom || claimed.denom,
    mintRatio: mintRatio.toString(),
    supplierOwnerId: supplierOwnerAddress,
    mintedAmount: mintedUpokt ? BigInt(mintedUpokt.amount) : undefined,
    mintedDenom: mintedUpokt?.denom || claimed.denom,
    overservicingLossAmount: overservicingLossAmount,
    overservicingLossDenom: overservicingLossUpokt?.denom || claimed.denom,
    deflationLossAmount: deflationLossAmount,
    deflationLossDenom: deflationLossUpokt?.denom || claimed.denom,
  };
}

function _handleEventClaimSettled(
  event: CosmosEvent,
  mintRatioFromParams: number,
  getEffectiveBurn: (application: string, supplier: string) => string | null
): [EventClaimSettledProps, Array<ModToAcctTransferRecord>] {
  const attributes = getAttributes(event.event.attributes);
  const { claim, claimed, mintRatioStr, settledUpokt } = attributes;

  const mintRatio = mintRatioStr ? parseFloat(mintRatioStr) : mintRatioFromParams;
  const { session_header, supplier_operator_address } = claim;

  const eventId = getEventId(event);
  const blockId = getBlockId(event.block);

  // Use chain-provided settled_upokt if available (post-aggregation upgrade),
  // otherwise fall back to overserviced effective_burn, then claimed amount
  const effectiveBurn = settledUpokt
    ? settledUpokt.amount
    : (getEffectiveBurn(session_header?.application_address || "", supplier_operator_address) || claimed.amount);

  const settlement = _resolveSettlementParts(attributes, eventId, blockId, effectiveBurn, mintRatio);
  const props = _buildClaimSettledProps(event, attributes, settlement, effectiveBurn, mintRatio);

  return [props, settlement.modToAcctTransfers];
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
    rootHash: undefined,
  };
}

function _handleEventApplicationOverserviced(event: CosmosEvent): EventApplicationOverservicedProps {
  let expectedBurn: Coin | null = null, effectiveBurn: Coin | null = null, applicationAddress = "",
    supplierAddress = "";
  let serviceId: string | undefined;
  let sessionEndBlockHeight: bigint | undefined;
  let spendLimitExceeded: boolean | undefined;

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

    if (attribute.key === "service_id") {
      serviceId = parseAttribute(attribute.value);
    }

    if (attribute.key === "session_end_block_height") {
      sessionEndBlockHeight = BigInt(parseAttribute(attribute.value));
    }

    if (attribute.key === "spend_limit_exceeded") {
      spendLimitExceeded = parseAttribute(attribute.value) === "true";
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
    // New fields (undefined for pre-upgrade blocks)
    serviceId,
    sessionEndBlockHeight,
    spendLimitExceeded,
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

async function bulkInsertModToAcctTransfers(records: ModToAcctTransferRecord[]): Promise<void> {
  if (records.length === 0) return;

  const schema = getDbSchema();
  const blockId = records[0].blockId;

  await rawBulkInsert({
    table: `${schema}.mod_to_acct_transfers`,
    columns: ['id', 'event_claim_settled_id', 'block_id', 'op_reason', 'recipient_id', 'amount', 'denom', '_block_range'],
    rows: records.map(r =>
      `('${r.id}', '${r.eventClaimSettledId}', ${r.blockId}, '${r.opReason}', '${r.recipientId}', ${r.amount}, '${r.denom}', int8range(${r.blockId}, null))`
    ),
    conflictCol: 'id',
    blockId,
  });
}

function summarizeTransfers(
  records: ModToAcctTransferRecord[],
  serviceIdByEventSettledId: Map<string, string>,
): SummarizedTransferRecord[] {
  if (records.length === 0) return [];

  const grouped = new Map<string, SummarizedTransferRecord>();
  const blockId = records[0].blockId;

  for (const r of records) {
    const serviceId = serviceIdByEventSettledId.get(r.eventClaimSettledId) || '';
    const key = `${r.recipientId}|${r.opReason}|${r.denom}|${serviceId}`;

    const existing = grouped.get(key);
    if (existing) {
      existing.amount += r.amount;
      existing.transferCount += BigInt(1);
    } else {
      grouped.set(key, {
        id: `${blockId}-${r.recipientId}-${r.opReason}-${r.denom}-${serviceId}`,
        blockId,
        recipientId: r.recipientId,
        opReason: r.opReason,
        denom: r.denom,
        serviceId,
        amount: r.amount,
        transferCount: BigInt(1),
      });
    }
  }

  return Array.from(grouped.values());
}

async function bulkInsertSummarizedTransfers(records: SummarizedTransferRecord[]): Promise<void> {
  if (records.length === 0) return;

  const schema = getDbSchema();
  const blockId = records[0].blockId;

  await rawBulkInsert({
    table: `${schema}.mod_to_acct_transfers_summarized`,
    columns: ['id', 'block_id', 'recipient_id', 'op_reason', 'denom', 'service_id', 'amount', 'transfer_count', '_block_range'],
    rows: records.map(r =>
      `('${r.id}', ${r.blockId}, '${r.recipientId}', '${r.opReason}', '${r.denom}', '${r.serviceId}', ${r.amount}, ${r.transferCount}, int8range(${r.blockId}, null))`
    ),
    conflictCol: 'id',
    blockId,
  });
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
  const serviceIdByEventSettledId = new Map<string, string>();

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
    serviceIdByEventSettledId.set(eventSettled.id as string, eventSettled.serviceId as string);

    if (modToAcctTransfers.length) {
      modToAcctTransfersToSave.push(...modToAcctTransfers);
    }
  }

  const summarized = summarizeTransfers(modToAcctTransfersToSave, serviceIdByEventSettledId);

  await Promise.all([
    optimizedBulkCreate("EventClaimSettled", eventsSettled, 'block_id'),
    bulkInsertModToAcctTransfers(modToAcctTransfersToSave),
    bulkInsertSummarizedTransfers(summarized),
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

const VALIDATOR_REWARD_OP_REASONS = new Set([
  "TLM_RELAY_BURN_EQUALS_MINT_VALIDATOR_REWARD_DISTRIBUTION",
  "TLM_RELAY_BURN_EQUALS_MINT_DELEGATOR_REWARD_DISTRIBUTION",
  "TLM_GLOBAL_MINT_VALIDATOR_REWARD_DISTRIBUTION",
  "TLM_GLOBAL_MINT_DELEGATOR_REWARD_DISTRIBUTION",
]);

export async function handleEventSettlementBatch(events: Array<CosmosEvent>): Promise<void> {
  const modToAcctTransfers: ModToAcctTransferRecord[] = [];

  for (const event of events) {
    let opType = '', opReason = '', recipient = '', totalAmount = '';

    for (const attr of event.event.attributes) {
      if (attr.key === 'op_type') opType = parseAttribute(attr.value);
      if (attr.key === 'op_reason') opReason = parseAttribute(attr.value);
      if (attr.key === 'recipient') recipient = parseAttribute(attr.value);
      if (attr.key === 'total_amount') totalAmount = attr.value as string;
    }

    // Only process mod_to_acct transfers for validator/delegator rewards
    if (opType !== 'mod_to_acct' || !VALIDATOR_REWARD_OP_REASONS.has(opReason)) continue;

    const coin = getDenomAndAmount(totalAmount);
    const eventId = getEventId(event);
    const blockId = getBlockId(event.block);

    modToAcctTransfers.push({
      id: eventId,
      eventClaimSettledId: '',
      blockId,
      opReason: getSettlementOpReasonFromSDK(opReason),
      recipientId: recipient,
      amount: BigInt(coin.amount),
      denom: coin.denom,
    });
  }

  if (modToAcctTransfers.length) {
    await bulkInsertModToAcctTransfers(modToAcctTransfers);
  }
}
