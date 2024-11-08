import {
  CosmosDatasourceKind,
  CosmosHandlerKind,
  CosmosProject,
} from "@subql/types-cosmos";

import * as dotenv from "dotenv";
import path from "path";

const mode = process.env.NODE_ENV || 'production';

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
      version: ">=4.0.0",
    },
    query: {
      name: "@subql/query",
      version: "*",
    },
  },
  schema: {
    file: "./schema.graphql",
  },
  network: {
    /* The unique chainID of the Cosmos Zone */
    chainId: process.env.CHAIN_ID!,
    /**
     * These endpoint(s) should be public non-pruned archive node
     * We recommend providing more than one endpoint for improved reliability, performance, and uptime
     * Public nodes may be rate limited, which can affect indexing speed
     * When developing your project we suggest getting a private API key
     * If you use a rate limited endpoint, adjust the --batch-size and --workers parameters
     * These settings can be found in your docker-compose.yaml, they will slow indexing but prevent your project being rate limited
     */
    endpoint: process.env.ENDPOINT!?.split(',') as string[] | string,
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
        }
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
        }
      ],
      [
        "poktroll.application_params",
        {
          file: "./proto/poktroll/application/params.proto",
          messages: [
            "Params",
          ],
        }
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
      kind: CosmosDatasourceKind.Runtime,
      startBlock: 1,
      mapping: {
        file: "./dist/index.js",
        handlers: [
          // handleGenesis is called before handleBlock, and it's reading the genesis file from ./src/mappings/genesis.json
          {
            handler: "handleGenesis",
            kind: CosmosHandlerKind.Block,
          },
          // --- Primitives
          {
            handler: "handleTransaction",
            kind: CosmosHandlerKind.Transaction,
          },
          {
            handler: "handleMessage",
            kind: CosmosHandlerKind.Message,
          },
          {
            handler: "handleEvent",
            kind: CosmosHandlerKind.Event,
          },
          // --- Bank
          {
            handler: "handleNativeTransfer",
            kind: CosmosHandlerKind.Event,
            filter: {
              type: "transfer",
              messageFilter: {
                type: "/cosmos.bank.v1beta1.MsgSend"
              }
            }
          },
          {
            handler: "handleNativeBalanceDecrement",
            kind: CosmosHandlerKind.Event,
            filter: {
              type: "coin_spent",
            }
          },
          {
            handler: "handleNativeBalanceIncrement",
            kind: CosmosHandlerKind.Event,
            filter: {
              type: "coin_received",
            }
          },
          // --- Applications
          {
            handler: "handleAppMsgStake",
            kind: CosmosHandlerKind.Message,
            filter: {
              type: "/poktroll.application.MsgStakeApplication",
            }
          },
          {
            handler: "handleDelegateToGatewayMsg",
            kind: CosmosHandlerKind.Message,
            filter: {
              type: "/poktroll.application.MsgDelegateToGateway",
            }
          },
          {
            handler: "handleUndelegateFromGatewayMsg",
            kind: CosmosHandlerKind.Message,
            filter: {
              type: "/poktroll.application.MsgUndelegateFromGateway",
            }
          },
          {
            handler: "handleUnstakeApplicationMsg",
            kind: CosmosHandlerKind.Message,
            filter: {
              type: "/poktroll.application.MsgUnstakeApplication",
            }
          },
          {
            handler: "handleTransferApplicationMsg",
            kind: CosmosHandlerKind.Message,
            filter: {
              type: "/poktroll.application.MsgTransferApplication",
            }
          },
          {
            handler: "handleTransferApplicationBeginEvent",
            kind: CosmosHandlerKind.Event,
            filter: {
              type: "poktroll.application.EventTransferBegin",
            }
          },
          {
            handler: "handleTransferApplicationEndEvent",
            kind: CosmosHandlerKind.Event,
            filter: {
              type: "poktroll.application.EventTransferEnd",
            }
          },
          {
            handler: "handleTransferApplicationErrorEvent",
            kind: CosmosHandlerKind.Event,
            filter: {
              type: "poktroll.application.EventTransferError",
            }
          },
          {
            handler: "handleApplicationUnbondingBeginEvent",
            kind: CosmosHandlerKind.Event,
            filter: {
              type: "poktroll.application.EventApplicationUnbondingBegin",
            }
          },
          {
            handler: "handleApplicationUnbondingEndEvent",
            kind: CosmosHandlerKind.Event,
            filter: {
              type: "poktroll.application.EventApplicationUnbondingEnd",
            }
          },
          // --- Services
          {
            handler: "handleMsgAddService",
            kind: CosmosHandlerKind.Message,
            filter: {
              type: "/poktroll.service.MsgAddService",
            }
          },
          // --- Suppliers
          {
            handler: "handleSupplierStakeMsg",
            kind: CosmosHandlerKind.Message,
            filter: {
              type: "/poktroll.supplier.MsgStakeSupplier",
            }
          },
          {
            handler: "handleUnstakeSupplierMsg",
            kind: CosmosHandlerKind.Message,
            filter: {
              type: "/poktroll.supplier.MsgUnstakeSupplier",
            }
          },
          {
            handler: "handleSupplierUnbondingBeginEvent",
            kind: CosmosHandlerKind.Event,
            filter: {
              type: "poktroll.supplier.EventSupplierUnbondingBegin",
            }
          },
          {
            handler: "handleSupplierUnbondingEndEvent",
            kind: CosmosHandlerKind.Event,
            filter: {
              type: "poktroll.supplier.EventSupplierUnbondingEnd",
            }
          },
          // --- Gateways
          {
            handler: "handleGatewayMsgStake",
            kind: CosmosHandlerKind.Message,
            filter: {
              type: "/poktroll.gateway.MsgStakeGateway",
            }
          },
          {
            handler: "handleGatewayMsgUnstake",
            kind: CosmosHandlerKind.Message,
            filter: {
              type: "/poktroll.gateway.MsgUnstakeGateway",
            }
          },
          {
            handler: "handleGatewayUnstakeEvent",
            kind: CosmosHandlerKind.Event,
            filter: {
              type: "poktroll.gateway.EventGatewayUnstaked",
            }
          },
          // --- Authz
          {
            handler: "handleAuthzExec",
            kind: CosmosHandlerKind.Message,
            filter: {
              type: "/cosmos.authz.v1beta1.MsgExec",
            }
          },
          {
            handler: "handleBlock",
            kind: CosmosHandlerKind.Block,
          },
          // --- Relays
          {
            handler: "handleEventClaimSettled",
            kind: CosmosHandlerKind.Event,
            filter: {
              type: "poktroll.tokenomics.EventClaimSettled",
            }
          },
          {
            handler: "handleEventClaimExpired",
            kind: CosmosHandlerKind.Event,
            filter: {
              type: "poktroll.tokenomics.EventClaimExpired",
            }
          },
          {
            handler: "handleMsgCreateClaim",
            kind: CosmosHandlerKind.Message,
            filter: {
              type: "/poktroll.proof.MsgCreateClaim",
            }
          },
          {
            handler: "handleEventClaimUpdated",
            kind: CosmosHandlerKind.Event,
            filter: {
              type: "poktroll.proof.EventClaimUpdated",
            }
          },
          {
            handler: "handleEventProofUpdated",
            kind: CosmosHandlerKind.Event,
            filter: {
              type: "poktroll.proof.EventProofUpdated",
            }
          },
          {
            handler: "handleMsgSubmitProof",
            kind: CosmosHandlerKind.Message,
            filter: {
              type: "/poktroll.proof.MsgSubmitProof",
            }
          },
          {
            handler: "handleEventClaimCreated",
            kind: CosmosHandlerKind.Event,
            filter: {
              type: "poktroll.proof.EventClaimCreated",
            }
          },
          {
            handler: "handleEventProofSubmitted",
            kind: CosmosHandlerKind.Event,
            filter: {
              type: "poktroll.proof.EventProofSubmitted",
            }
          }
        ],
      },
    },
  ],
};

// Must set default to the project instance
export default project;
