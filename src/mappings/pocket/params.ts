import { BinaryReader } from "@bufbuild/protobuf/wire";
import { MsgUpdateParams as MsgUpdateAuthParams } from "cosmjs-types/cosmos/auth/v1beta1/tx";
import { MsgUpdateParams as MsgUpdateBankParams } from "cosmjs-types/cosmos/bank/v1beta1/tx";
import { MsgUpdateParams as MsgUpdateConsensusParams } from "cosmjs-types/cosmos/consensus/v1/tx";
import { MsgUpdateParams as MsgUpdateDistributionParams } from "cosmjs-types/cosmos/distribution/v1beta1/tx";
import { MsgUpdateParams as MsgUpdateGovParams } from "cosmjs-types/cosmos/gov/v1/tx";
import { MsgUpdateParams as MsgUpdateMintParams } from "cosmjs-types/cosmos/mint/v1beta1/tx";
import { MsgUpdateParams as MsgUpdateSlashingParams } from "cosmjs-types/cosmos/slashing/v1beta1/tx";
import { MsgUpdateParams as MsgUpdateStakingParams } from "cosmjs-types/cosmos/staking/v1beta1/tx";
import {
  MsgUpdateParam as MsgUpdateApplicationParam,
  MsgUpdateParams as MsgUpdateApplicationParams,
} from "../../client/pocket/application/tx";
import {
  MsgUpdateParam as MsgUpdateGatewayParam,
  MsgUpdateParams as MsgUpdateGatewayParams,
} from "../../client/pocket/gateway/tx";
import {
  MsgUpdateParams as MsgUpdateMigrationParams,
} from "../../client/pocket/migration/tx";
import {
  MsgUpdateParam as MsgUpdateProofParam,
  MsgUpdateParams as MsgUpdateProofParams,
} from "../../client/pocket/proof/tx";
import {
  MsgUpdateParam as MsgUpdateServiceParam,
  MsgUpdateParams as MsgUpdateServiceParams,
} from "../../client/pocket/service/tx";
import {
  MsgUpdateParam as MsgUpdateSessionParam,
  MsgUpdateParams as MsgUpdateSessionParams,
} from "../../client/pocket/session/tx";
import {
  MsgUpdateParam as MsgUpdateSharedParam,
  MsgUpdateParams as MsgUpdateSharedParams,
} from "../../client/pocket/shared/tx";
import {
  MsgUpdateParam as MsgUpdateSupplierParam,
  MsgUpdateParams as MsgUpdateSupplierParams,
} from "../../client/pocket/supplier/tx";
import {
  MsgUpdateParam as MsgUpdateTokenomicsParam,
  MsgUpdateParams as MsgUpdateTokenomicsParams,
} from "../../client/pocket/tokenomics/tx";
import { Param } from "../../types";
import type { ParamProps } from "../../types/models/Param";
import { EncodedMsg } from "../types";
import { fetchPaginatedRecords } from "../utils/db";
import { reconcileParamsAt } from "../utils/params_history";
import getQueryClient from "../utils/query_client";


const msgUpdateParamsMap: Record<string, {
  decode(bytes: BinaryReader | Uint8Array | unknown): unknown
  toJSON(obj: unknown): unknown
}> = {
  "/pocket.application.MsgUpdateParam": MsgUpdateApplicationParam,
  "/pocket.application.MsgUpdateParams": MsgUpdateApplicationParams,
  "/pocket.service.MsgUpdateParam": MsgUpdateServiceParam,
  "/pocket.service.MsgUpdateParams": MsgUpdateServiceParams,
  "/pocket.supplier.MsgUpdateParam": MsgUpdateSupplierParam,
  "/pocket.supplier.MsgUpdateParams": MsgUpdateSupplierParams,
  "/pocket.gateway.MsgUpdateParam": MsgUpdateGatewayParam,
  "/pocket.gateway.MsgUpdateParams": MsgUpdateGatewayParams,
  "/pocket.proof.MsgUpdateParam": MsgUpdateProofParam,
  "/pocket.proof.MsgUpdateParams": MsgUpdateProofParams,
  "/pocket.shared.MsgUpdateParam": MsgUpdateSharedParam,
  "/pocket.shared.MsgUpdateParams": MsgUpdateSharedParams,
  "/pocket.tokenomics.MsgUpdateParam": MsgUpdateTokenomicsParam,
  "/pocket.tokenomics.MsgUpdateParams": MsgUpdateTokenomicsParams,
  "/pocket.session.MsgUpdateParam": MsgUpdateSessionParam,
  "/pocket.session.MsgUpdateParams": MsgUpdateSessionParams,
  "/pocket.migration.MsgUpdateParams": MsgUpdateMigrationParams,
  "/cosmos.auth.v1beta1.MsgUpdateParams": MsgUpdateAuthParams,
  "/cosmos.bank.v1beta1.MsgUpdateParams": MsgUpdateBankParams,
  "/cosmos.distribution.v1beta1.MsgUpdateParams": MsgUpdateDistributionParams,
  "/cosmos.mint.v1beta1.MsgUpdateParams": MsgUpdateMintParams,
  "/cosmos.slashing.v1beta1.MsgUpdateParams": MsgUpdateSlashingParams,
  "/cosmos.staking.v1beta1.MsgUpdateParams": MsgUpdateStakingParams,
  "/cosmos.consensus.v1.MsgUpdateParams": MsgUpdateConsensusParams,
  "/cosmos.gov.v1.MsgUpdateParams": MsgUpdateGovParams,
};

// decodeUpdateParamMsg decodes a MsgUpdateParam(s) wrapped in an authz MsgExec so
// the sub-message can be stored as a Message row. It returns null for any other
// type. It no longer produces Param rows: the message only says what was
// requested, not what the chain applied or when (upgrades change params with no
// message at all, and some updates only take effect at the next session), so the
// params table is written by reconcileParams from the chain state instead.
export function decodeUpdateParamMsg(encodedMsg: EncodedMsg): unknown | null {
  if (!(encodedMsg.typeUrl in msgUpdateParamsMap)) {
    return null;
  }

  return msgUpdateParamsMap[encodedMsg.typeUrl].decode(new Uint8Array(Object.values(encodedMsg.value)));
}

// reconcileParams writes the params of every module as the chain holds them at
// `height`. Same shape as reconcileValidators: read the authoritative state
// pinned to the block height (every module in parallel), compare it with the
// value currently stored per key, and write a new Param version only for the
// keys whose value changed — same id `${namespace}-${key}`, so SubQuery closes
// the previous _block_range. The steady state is one read per module and zero
// writes.
//
// Reading state instead of decoding MsgUpdateParam(s) is what makes the history
// exact: chain upgrades change params without any message, deferred updates
// (shared/session) apply at a later height than their message, and gov
// proposals were never decoded at all.
//
// Nothing is tolerated: a read that fails after the transport's retries, or
// that cannot be verified, throws and fails the block (utils/params_history.ts
// reconcileParamsAt), because a skipped block would record a change late.
export async function reconcileParams(height: number, chainId: string): Promise<void> {
  const queryClient = getQueryClient(height);
  const blockId = BigInt(height);

  await reconcileParamsAt(height, chainId, (path, h, data) => queryClient.params.raw(path, h, data), {
    current: async () => new Map(
      (await fetchPaginatedRecords<Param>({
        fetchFn: (options) => Param.getByFields([], options),
        initialOptions: {},
      })).map((p) => [p.id, p.value]),
    ),
    save: (rows) => store.bulkCreate("Param", rows.map((row): ParamProps => ({
      id: row.id,
      namespace: row.namespace,
      key: row.key,
      value: row.value,
      activeAt: BigInt(row.activeAt),
      blockId,
    }))),
    remove: (ids) => store.bulkRemove("Param", ids),
  });
}
