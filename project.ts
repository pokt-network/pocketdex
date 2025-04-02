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
        "pocket.application_tx",
        {
          file: "./proto/pocket/application/tx.proto",
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
        "pocket.application_events",
        {
          file: "./proto/pocket/application/event.proto",
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
        "pocket.application_types",
        {
          file: "./proto/pocket/application/types.proto",
          messages: [
            "Application",
            "UndelegatingGatewayList",
          ],
        },
      ],
      [
        "pocket.application_params",
        {
          file: "./proto/pocket/application/params.proto",
          messages: [
            "Params",
          ],
        },
      ],
      // --- Gateway
      [
        "pocket.gateway_tx",
        {
          file: "./proto/pocket/gateway/tx.proto",
          messages: [
            "MsgUpdateParams",
            "MsgStakeGateway",
            "MsgUnstakeGateway",
          ],
        },
      ],
      [
        "pocket.gateway_events",
        {
          file: "./proto/pocket/gateway/event.proto",
          messages: [
            "EventGatewayStaked",
            "EventGatewayUnbondingBegin",
            "EventGatewayUnbondingEnd",
            "EventGatewayUnbondingCanceled",
          ],
        },
      ],
      [
        "pocket.gateway_types",
        {
          file: "./proto/pocket/gateway/types.proto",
          messages: [
            "Gateway",
          ],
        },
      ],
      [
        "pocket.gateway_params",
        {
          file: "./proto/pocket/gateway/params.proto",
          messages: [
            "Params",
          ],
        },
      ],
      // --- Proof
      [
        "pocket.proof_tx",
        {
          file: "./proto/pocket/proof/tx.proto",
          messages: [
            "MsgUpdateParams",
            "MsgUpdateParam",
            "MsgCreateClaim",
            "MsgSubmitProof",
          ],
        },
      ],
      [
        "pocket.proof_events",
        {
          file: "./proto/pocket/proof/event.proto",
          messages: [
            "EventClaimCreated",
            "EventClaimUpdated",
            "EventProofSubmitted",
            "EventProofUpdated",
          ],
        },
      ],
      [
        "pocket.proof_types",
        {
          file: "./proto/pocket/proof/types.proto",
          messages: [
            "Proof",
            "Claim",
            "ProofRequirementReason",
            "ClaimProofStage",
          ],
        },
      ],
      [
        "pocket.proof_params",
        {
          file: "./proto/pocket/proof/params.proto",
          messages: [
            "Params",
          ],
        },
      ],
      // --- Service
      [
        "pocket.service_tx",
        {
          file: "./proto/pocket/service/tx.proto",
          messages: [
            "MsgUpdateParams",
            "MsgAddService",
          ],
        },
      ],
      [
        // TODO: We need this here?
        //  more does not hurt at this point, but we may want to clean it up in the future if not needed
        "pocket.service_relay",
        {
          file: "./proto/pocket/service/relay.proto",
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
        "pocket.service_params",
        {
          file: "./proto/pocket/service/params.proto",
          messages: [
            "Params",
          ],
        },
      ],
      // --- Session
      [
        "pocket.session_tx",
        {
          file: "./proto/pocket/session/tx.proto",
          messages: [
            "MsgUpdateParams",
          ],
        },
      ],
      [
        "pocket.session_types",
        {
          file: "./proto/pocket/session/types.proto",
          messages: [
            "SessionHeader",
            "Session",
          ],
        },
      ],
      [
        "pocket.session_params",
        {
          file: "./proto/pocket/session/params.proto",
          messages: [
            "Params",
          ],
        },
      ],
      // --- Shared
      [
        "pocket.shared_tx",
        {
          file: "./proto/pocket/shared/tx.proto",
          messages: [
            "MsgUpdateParams",
            "MsgUpdateParam",
          ],
        },
      ],
      [
        "pocket.shared_supplier",
        {
          file: "./proto/pocket/shared/supplier.proto",
          messages: [
            "Supplier",
          ],
        },
      ],
      [
        "pocket.shared_service",
        {
          file: "./proto/pocket/shared/service.proto",
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
        "pocket.shared_params",
        {
          file: "./proto/pocket/shared/params.proto",
          messages: [
            "Params",
          ],
        },
      ],
      // --- Supplier
      [
        "pocket.supplier_tx",
        {
          file: "./proto/pocket/supplier/tx.proto",
          messages: [
            "MsgUpdateParams",
            "MsgStakeSupplier",
            "MsgUnstakeSupplier",
          ],
        },
      ],
      [
        "pocket.supplier_events",
        {
          file: "./proto/pocket/supplier/event.proto",
          messages: [
            "EventSupplierStaked",
            "EventSupplierUnbondingBegin",
            "EventSupplierUnbondingEnd",
          ],
        },
      ],
      [
        "pocket.supplier_params",
        {
          file: "./proto/pocket/supplier/params.proto",
          messages: [
            "Params",
          ],
        },
      ],
      // --- Tokenomics
      [
        "pocket.tokenomics_tx",
        {
          file: "./proto/pocket/tokenomics/tx.proto",
          messages: [
            "MsgUpdateParams",
            "MsgUpdateParam",
          ],
        },
      ],
      [
        "pocket.tokenomics_events",
        {
          file: "./proto/pocket/tokenomics/event.proto",
          messages: [
            "EventClaimExpired",
            "EventClaimSettled",
            "EventSupplierSlashed",
            "EventApplicationOverserviced",
            "EventApplicationReimbursementRequest",
          ],
        },
      ],
      [
        "pocket.tokenomics_params",
        {
          file: "./proto/pocket/tokenomics/params.proto",
          messages: [
            "Params",
          ],
        },
      ],
      [
        "pocket.tokenomics_relay_mining_difficulty",
        {
          file: "./proto/pocket/service/relay_mining_difficulty.proto",
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
