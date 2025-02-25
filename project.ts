import {
  CosmosDatasourceKind,
  CosmosHandlerKind,
  CosmosProject,
} from "@subql/types-cosmos";

import * as dotenv from "dotenv";
import * as path from "path";

const mode = process.env.NODE_ENV || "production";

// Load the appropriate .env file
const dotenvPath = path.resolve(__dirname, `.env.${mode}`);
dotenv.config({ path: dotenvPath });

// Can expand the Datasource processor types via the generic param
const project: CosmosProject = {
  specVersion: "1.0.0",
  version: "0.0.1",
  name: "pocketdex",
  description:
    "Pocketdex is an indexer for the Shannon implementation of the pocket network protocol.",
  runner: {
    node: {
      name: "@subql/node-cosmos",
      version: ">=4.5.1",
    },
    query: {
      name: "@subql/query",
      version: ">=2.20.2",
    },
  },
  schema: {
    file: "./schema.graphql",
  },
  network: {
    /* The unique chainID of the Cosmos Zone */
    chainId: process.env.CHAIN_ID!,
    endpoint: process.env.ENDPOINT!?.split(",") as string[] | string,
    chaintypes: new Map([
      [
        "cosmos.slashing.v1beta1",
        {
          file: "./proto/cosmos/slashing/v1beta1/tx.proto",
          messages: ["MsgUnjail"],
        },
      ],
      [
        "cosmos.gov.v1beta1",
        {
          file: "./proto/cosmos/gov/v1beta1/tx.proto",
          messages: ["MsgVoteWeighted"],
        },
      ],
      [
        "cosmos.gov.v1beta1.gov",
        {
          file: "./proto/cosmos/gov/v1beta1/gov.proto",
          messages: ["WeightedVoteOption"],
        },
      ],
      [
        "cosmos.base.v1beta1",
        {
          file: "./proto/cosmos/base/v1beta1/coin.proto",
          messages: ["Coin"],
        },
      ],
      // --- Application
      [
        "poktroll.application_tx",
        {
          file: "./proto/poktroll/application/tx.proto",
          messages: [
            "MsgUpdateParam",
            "MsgUpdateParams",
            "MsgStakeApplication",
            "MsgUnstakeApplication",
            "MsgTransferApplication",
            "MsgDelegateToGateway",
            "MsgUndelegateFromGateway",
          ],
        },
      ],
      [
        "poktroll.application_events",
        {
          file: "./proto/poktroll/application/event.proto",
          messages: [
            "EventRedelegation",
            "EventTransferBegin",
            "EventTransferEnd",
            "EventTransferError",
            "EventApplicationStaked",
            "EventApplicationUnbondingEnd",
            "EventApplicationUnbondingBegin",
            "EventApplicationUnbondingCanceled",
          ],
        },
      ],
      [
        "poktroll.application_types",
        {
          file: "./proto/poktroll/application/types.proto",
          messages: [
            "Application",
            "UndelegatingGatewayList",
          ],
        },
      ],
      [
        "poktroll.application_params",
        {
          file: "./proto/poktroll/application/params.proto",
          messages: [
            "Params",
          ],
        },
      ],
      // --- Gateway
      [
        "poktroll.gateway_tx",
        {
          file: "./proto/poktroll/gateway/tx.proto",
          messages: [
            "MsgUpdateParams",
            "MsgStakeGateway",
            "MsgUnstakeGateway",
          ],
        },
      ],
      [
        "poktroll.gateway_events",
        {
          file: "./proto/poktroll/gateway/event.proto",
          messages: [
            "EventGatewayUnstaked",
          ],
        },
      ],
      [
        "poktroll.gateway_types",
        {
          file: "./proto/poktroll/gateway/types.proto",
          messages: [
            "Gateway",
          ],
        },
      ],
      [
        "poktroll.gateway_params",
        {
          file: "./proto/poktroll/gateway/params.proto",
          messages: [
            "Params",
          ],
        },
      ],
      // --- Proof
      [
        "poktroll.proof_tx",
        {
          file: "./proto/poktroll/proof/tx.proto",
          messages: [
            "MsgUpdateParams",
            "MsgUpdateParam",
            "MsgCreateClaim",
            "MsgSubmitProof",
          ],
        },
      ],
      [
        "poktroll.proof_events",
        {
          file: "./proto/poktroll/proof/event.proto",
          messages: [
            "EventClaimCreated",
            "EventClaimUpdated",
            "EventProofSubmitted",
            "EventProofUpdated",
          ],
        },
      ],
      [
        "poktroll.proof_types",
        {
          file: "./proto/poktroll/proof/types.proto",
          messages: [
            "Proof",
            "Claim",
            "ProofRequirementReason",
            "ClaimProofStage",
          ],
        },
      ],
      [
        "poktroll.proof_params",
        {
          file: "./proto/poktroll/proof/params.proto",
          messages: [
            "Params",
          ],
        },
      ],
      // --- Service
      [
        "poktroll.service_tx",
        {
          file: "./proto/poktroll/service/tx.proto",
          messages: [
            "MsgUpdateParams",
            "MsgAddService",
          ],
        },
      ],
      [
        // TODO: We need this here?
        //  more does not hurt at this point, but we may want to clean it up in the future if not needed
        "poktroll.service_relay",
        {
          file: "./proto/poktroll/service/relay.proto",
          messages: [
            "Relay",
            "RelayRequestMetadata",
            "RelayRequest",
            "RelayResponse",
            "RelayResponseMetadata",
          ],
        },
      ],
      [
        "poktroll.service_params",
        {
          file: "./proto/poktroll/service/params.proto",
          messages: [
            "Params",
          ],
        },
      ],
      // --- Session
      [
        "poktroll.session_tx",
        {
          file: "./proto/poktroll/session/tx.proto",
          messages: [
            "MsgUpdateParams",
          ],
        },
      ],
      [
        "poktroll.session_types",
        {
          file: "./proto/poktroll/session/types.proto",
          messages: [
            "SessionHeader",
            "Session",
          ],
        },
      ],
      [
        "poktroll.session_params",
        {
          file: "./proto/poktroll/session/params.proto",
          messages: [
            "Params",
          ],
        },
      ],
      // --- Shared
      [
        "poktroll.shared_tx",
        {
          file: "./proto/poktroll/shared/tx.proto",
          messages: [
            "MsgUpdateParams",
            "MsgUpdateParam",
          ],
        },
      ],
      [
        "poktroll.shared_supplier",
        {
          file: "./proto/poktroll/shared/supplier.proto",
          messages: [
            "Supplier",
          ],
        },
      ],
      [
        "poktroll.shared_service",
        {
          file: "./proto/poktroll/shared/service.proto",
          messages: [
            "Service",
            "ApplicationServiceConfig",
            "SupplierServiceConfig",
            "SupplierEndpoint",
            "ServiceRevenueShare",
            "ConfigOption",
          ],
        },
      ],
      [
        "poktroll.shared_params",
        {
          file: "./proto/poktroll/shared/params.proto",
          messages: [
            "Params",
          ],
        },
      ],
      // --- Supplier
      [
        "poktroll.supplier_tx",
        {
          file: "./proto/poktroll/supplier/tx.proto",
          messages: [
            "MsgUpdateParams",
            "MsgStakeSupplier",
            "MsgUnstakeSupplier",
          ],
        },
      ],
      [
        "poktroll.supplier_events",
        {
          file: "./proto/poktroll/supplier/event.proto",
          messages: [
            "EventSupplierStaked",
            "EventSupplierUnbondingBegin",
            "EventSupplierUnbondingEnd",
          ],
        },
      ],
      [
        "poktroll.supplier_params",
        {
          file: "./proto/poktroll/supplier/params.proto",
          messages: [
            "Params",
          ],
        },
      ],
      // --- Tokenomics
      [
        "poktroll.tokenomics_tx",
        {
          file: "./proto/poktroll/tokenomics/tx.proto",
          messages: [
            "MsgUpdateParams",
            "MsgUpdateParam",
          ],
        },
      ],
      [
        "poktroll.tokenomics_events",
        {
          file: "./proto/poktroll/tokenomics/event.proto",
          messages: [
            "EventClaimExpired",
            "EventClaimSettled",
            "EventApplicationOverserviced",
          ],
        },
      ],
      [
        "poktroll.tokenomics_params",
        {
          file: "./proto/poktroll/tokenomics/params.proto",
          messages: [
            "Params",
          ],
        },
      ],
      [
        "poktroll.tokenomics_relay_mining_difficulty",
        {
          file: "./proto/poktroll/service/relay_mining_difficulty.proto",
          messages: [
            "RelayMiningDifficulty",
          ],
        },
      ],
    ]),
  },
  dataSources: [
    {
      startBlock: 1,
      // startBlock: 349, // first set of txs
      // startBlock: 34123, // first set of claims
      // startBlock: 55330, // damn big block 176k events
      // startBlock: 58120, // more than 570 mb in response
      kind: CosmosDatasourceKind.Runtime,
      mapping: {
        file: "./dist/index.js",
        handlers: [
          {
            // See the definition in "src/mappings/indexer.manager.ts"
            // This is the responsible to call all the other handlers using BlockHandler to maximize performance
            // and parallel operations.
            handler: "indexingHandler",
            kind: CosmosHandlerKind.Block,
          }
        ],
      },
    },
  ],
};

// Must set default to the project instance
export default project;
