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
import { ParamProps } from "../../types/models/Param";
import { EncodedMsg } from "../types";
import { getParamId } from "../utils/ids";
import { sanitize } from "../utils/json";


const msgUpdateParamsMap: Record<string, {
  decode(bytes: BinaryReader | Uint8Array | unknown): unknown
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

export type UpdateParamResult = {
  decodedMsg: unknown
  params: Array<ParamProps>
}

export function _handleUpdateParam(encodedMsg: EncodedMsg, blockId: bigint): UpdateParamResult | null {
  if (!(encodedMsg.typeUrl in msgUpdateParamsMap)) {
    // this will help us to identify other param types without ignore them
    return null;
  }

  const params: Array<ParamProps> = [];

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

  const decodedJsonMsg = msgCodec.toJSON(decodedMsg) as Record<string, unknown>;
  const namespace: string = encodedMsg.typeUrl.split(".")[1];

  const entity: Pick<ParamProps, "namespace" | "blockId"> = {
    namespace,
    blockId,
  };

  if (encodedMsg.typeUrl.endsWith("MsgUpdateParams")) {
    for (const [key, value] of Object.entries(decodedJsonMsg.params as Record<string, unknown>)) {
      const snakeKey = snakeCase(key);
      params.push({
        id: getParamId(namespace, snakeKey, blockId),
        // we handle the key as snake case because is the same way it is coming on the genesis file.
        key: snakeKey,
        value: sanitize(value),
        ...entity,
      });
    }
  } else {
    for (const key of Object.keys(decodedJsonMsg)) {
      const value = decodedJsonMsg[key];
      if (key.startsWith("as")) {
        const snakeKey = snakeCase(decodedJsonMsg.name as string);
        params.push({
          id: getParamId(namespace, snakeKey, blockId),
          // we handle the key as snake case because is the same way it is coming on the genesis file.
          key: snakeKey,
          value: sanitize(value),
          ...entity,
        });
      }
    }
  }

  return {
    decodedMsg,
    params,
  };
}
