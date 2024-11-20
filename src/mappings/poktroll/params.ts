import { BinaryReader } from "@bufbuild/protobuf/wire";
import { MsgUpdateParams as MsgUpdateAuthParams } from "cosmjs-types/cosmos/auth/v1beta1/tx";
import { MsgUpdateParams as MsgUpdateBankParams } from "cosmjs-types/cosmos/bank/v1beta1/tx";
import { MsgUpdateParams as MsgUpdateConsensusParams } from "cosmjs-types/cosmos/consensus/v1/tx";
import { MsgUpdateParams as MsgUpdateDistributionParams } from "cosmjs-types/cosmos/distribution/v1beta1/tx";
import { MsgUpdateParams as MsgUpdateGovParams } from "cosmjs-types/cosmos/gov/v1/tx";
import { MsgUpdateParams as MsgUpdateMintParams } from "cosmjs-types/cosmos/mint/v1beta1/tx";
import { MsgUpdateParams as MsgUpdateSlashingParams } from "cosmjs-types/cosmos/slashing/v1beta1/tx";
import { MsgUpdateParams as MsgUpdateStakingParams } from "cosmjs-types/cosmos/staking/v1beta1/tx";
import { snakeCase } from "lodash";
import {
  MsgUpdateParam as MsgUpdateApplicationParam,
  MsgUpdateParams as MsgUpdateApplicationParams,
} from "../../client/poktroll/application/tx";
import {
  MsgUpdateParam as MsgUpdateGatewayParam,
  MsgUpdateParams as MsgUpdateGatewayParams,
} from "../../client/poktroll/gateway/tx";
import {
  MsgUpdateParam as MsgUpdateProofParam,
  MsgUpdateParams as MsgUpdateProofParams,
} from "../../client/poktroll/proof/tx";
import {
  MsgUpdateParam as MsgUpdateServiceParam,
  MsgUpdateParams as MsgUpdateServiceParams,
} from "../../client/poktroll/service/tx";
import { MsgUpdateParams as MsgUpdateSessionParams } from "../../client/poktroll/session/tx";
import {
  MsgUpdateParam as MsgUpdateSharedParam,
  MsgUpdateParams as MsgUpdateSharedParams,
} from "../../client/poktroll/shared/tx";
import {
  MsgUpdateParam as MsgUpdateSupplierParam,
  MsgUpdateParams as MsgUpdateSupplierParams,
} from "../../client/poktroll/supplier/tx";
import {
  MsgUpdateParam as MsgUpdateTokenomicsParam,
  MsgUpdateParams as MsgUpdateTokenomicsParams,
} from "../../client/poktroll/tokenomics/tx";
import { AppParamProps } from "../../types/models/AppParam";
import { EncodedMsg } from "../types";
import { getParamId } from "../utils/ids";
import { stringify } from "../utils/json";


const msgUpdateParamsMap: Record<string, {
  decode(bytes: BinaryReader | Uint8Array | any): unknown
  toJSON(obj: unknown): unknown
}> = {
  "/poktroll.application.MsgUpdateParam": MsgUpdateApplicationParam,
  "/poktroll.application.MsgUpdateParams": MsgUpdateApplicationParams,
  "/poktroll.service.MsgUpdateParam": MsgUpdateServiceParam,
  "/poktroll.service.MsgUpdateParams": MsgUpdateServiceParams,
  "/poktroll.supplier.MsgUpdateParam": MsgUpdateSupplierParam,
  "/poktroll.supplier.MsgUpdateParams": MsgUpdateSupplierParams,
  "/poktroll.gateway.MsgUpdateParam": MsgUpdateGatewayParam,
  "/poktroll.gateway.MsgUpdateParams": MsgUpdateGatewayParams,
  "/poktroll.proof.MsgUpdateParam": MsgUpdateProofParam,
  "/poktroll.proof.MsgUpdateParams": MsgUpdateProofParams,
  "/poktroll.shared.MsgUpdateParam": MsgUpdateSharedParam,
  "/poktroll.shared.MsgUpdateParams": MsgUpdateSharedParams,
  "/poktroll.tokenomics.MsgUpdateParam": MsgUpdateTokenomicsParam,
  "/poktroll.tokenomics.MsgUpdateParams": MsgUpdateTokenomicsParams,
  "/poktroll.session.MsgUpdateParams": MsgUpdateSessionParams,
  "/cosmos.auth.v1beta1.MsgUpdateParams": MsgUpdateAuthParams,
  "/cosmos.bank.v1beta1.MsgUpdateParams": MsgUpdateBankParams,
  "/cosmos.distribution.v1beta1.MsgUpdateParams": MsgUpdateDistributionParams,
  "/cosmos.mint.v1beta1.MsgUpdateParams": MsgUpdateMintParams,
  "/cosmos.slashing.v1beta1.MsgUpdateParams": MsgUpdateSlashingParams,
  "/cosmos.staking.v1beta1.MsgUpdateParams": MsgUpdateStakingParams,
  "/cosmos.consensus.v1.MsgUpdateParams": MsgUpdateConsensusParams,
  "/cosmos.gov.v1.MsgUpdateParams": MsgUpdateGovParams,
};

const paramMapping: Record<string, string> = {
  "/poktroll.application.MsgUpdateParams": "AppParam",
  "/poktroll.application.MsgUpdateParam": "AppParam",
  "/cosmos.auth.v1beta1.MsgUpdateParams": "AuthParam",
  "/cosmos.bank.v1beta1.MsgUpdateParams": "BankParam",
  "/cosmos.distribution.v1beta1.MsgUpdateParams": "DistributionParam",
  "/poktroll.gateway.MsgUpdateParams": "GatewayParam",
  "/poktroll.gateway.MsgUpdateParam": "GatewayParam",
  "/cosmos.gov.v1.MsgUpdateParams": "GovParam",
  "/cosmos.mint.v1beta1.MsgUpdateParams": "MintParam",
  "/poktroll.proof.MsgUpdateParams": "ProofParam",
  "/poktroll.proof.MsgUpdateParam": "ProofParam",
  "/poktroll.service.MsgUpdateParams": "ServiceParam",
  "/poktroll.service.MsgUpdateParam": "ServiceParam",
  "/poktroll.session.MsgUpdateParams": "SessionParam",
  "/poktroll.shared.MsgUpdateParams": "SharedParam",
  "/poktroll.shared.MsgUpdateParam": "SharedParam",
  "/cosmos.slashing.v1beta1.MsgUpdateParams": "SlashingParam",
  "/cosmos.staking.v1beta1.MsgUpdateParams": "StakingParam",
  "/poktroll.supplier.MsgUpdateParams": "SupplierParam",
  "/poktroll.supplier.MsgUpdateParam": "SupplierParam",
  "/poktroll.tokenomics.MsgUpdateParams": "TokenomicsParam",
  "/poktroll.tokenomics.MsgUpdateParam": "TokenomicsParam",
  "/cosmos.consensus.v1.MsgUpdateParams": "ConsensusParam",
};

function getEntityParamName(typeUrl: string): string {
  if (typeUrl in paramMapping) {
    return paramMapping[typeUrl];
  } else {
    throw new Error(`Unknown typeUrl: ${typeUrl}`);
  }
}

export async function _handleUpdateParam(encodedMsg: EncodedMsg, blockId: string): Promise<unknown> {
  if (!(encodedMsg.typeUrl in msgUpdateParamsMap)) {
    return;
  }

  const entityName = getEntityParamName(encodedMsg.typeUrl);
  const entities: Array<AppParamProps> = [];

  const msgCodec = msgUpdateParamsMap[encodedMsg.typeUrl];
  const uintArray = new Uint8Array(Object.values(encodedMsg.value));
  let decodedMsg: unknown;

  // We need to pass a BinaryReader to decode poktroll messages because
  // TextDecoder.decode can't decode the Uint8Array for some unknown reason
  if (encodedMsg.typeUrl.startsWith("/poktroll")) {
    decodedMsg = msgCodec.decode(
      new BinaryReader(
        uintArray,
        (bytes) => {
          return Buffer.from(bytes).toString("utf-8");
        }),
    );
  } else {
    decodedMsg = msgCodec.decode(
      uintArray,
    );
  }

  const decodedJsonMsg = msgCodec.toJSON(decodedMsg) as any;

  if (encodedMsg.typeUrl.endsWith("MsgUpdateParams")) {
    for (const [key, value] of Object.entries(decodedJsonMsg.params)) {
      // we need to convert the key to snake case. Or shall we do save it in camel case?
      const snakeKey = snakeCase(key);
      entities.push({
        id: getParamId(snakeKey, blockId),
        key: snakeKey,
        value: typeof value === "object" ? stringify(value) : (value || "").toString(),
        blockId,
      });
    }
  } else {
    for (const key of Object.keys(decodedJsonMsg)) {
      const value = decodedJsonMsg[key];
      if (key.startsWith("as")) {
        const snakeKey = snakeCase(decodedJsonMsg.name);
        entities.push({
          id: getParamId(snakeKey, blockId),
          key: snakeKey,
          value: typeof value === "object" ? stringify(value) : (value || "").toString(),
          blockId,
        });
      }
    }
  }

  await store.bulkCreate(entityName, entities);

  return decodedMsg;
}
