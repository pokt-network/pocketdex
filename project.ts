import {
  CosmosDatasourceKind,
  CosmosHandlerKind,
  CosmosProject,
} from "@subql/types-cosmos";

import * as dotenv from 'dotenv';
import path from 'path';

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
      // --- Application module messages and events
      [
        "poktroll.application_messages",
        {
          file: "./proto/poktroll/application/tx.proto",
          messages: [
            "MsgUpdateParams",
            "MsgStakeApplication",
            "MsgUnstakeApplication",
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
            "EventRedelegation"
          ],
        },
      ],
      // --- Gateway module messages
      [
        "poktroll.gateway",
        {
          file: "./proto/poktroll/gateway/tx.proto",
          messages: [
            "MsgUpdateParams",
            "MsgStakeGateway",
            "MsgUnstakeGateway",
          ],
        },
      ],
      // --- Proof module messages
      [
        "poktroll.proof",
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
      // --- Session module types
      [
        "poktroll.session",
        {
          file: "./proto/poktroll/session/session.proto",
          messages: [
            "SessionHeader",
          ],
        },
      ],
      // // --- Shared module messages
      [
        "poktroll.shared_messages",
        {
          file: "./proto/poktroll/shared/tx.proto",
          messages: [
            "MsgUpdateParams",
            "MsgUpdateParam",
          ],
        },
      ],
      // --- Shared module types
      [
        "poktroll.shared_types",
        {
          file: "./proto/poktroll/shared/service.proto",
          messages: [
            "Service",
          ],
        },
      ],
      // --- Supplier module messages
      [
        "poktroll.supplier",
        {
          file: "./proto/poktroll/supplier/tx.proto",
          messages: [
            "MsgUpdateParams",
            "MsgStakeSupplier",
            "MsgUnstakeSupplier",
          ],
        },
      ],
      // --- Tokenomics module messages
      [
        "poktroll.tokenomics_messages",
        {
          file: "./proto/poktroll/tokenomics/tx.proto",
          messages: [
            "MsgUpdateParams",
            "MsgUpdateParam",
          ],
        },
      ],
      // --- Tokenomics module events
      [
        "poktroll.tokenomics_events",
        {
          file: "./proto/poktroll/tokenomics/event.proto",
          messages: [
            "EventClaimSettled",
            "EventClaimExpired",
            "EventRelayMiningDifficultyUpdated",
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
          // --- Primitives
          {
            handler: "handleBlock",
            kind: CosmosHandlerKind.Block,
          },
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
        ],
      },
    },
  ],
};

// Must set default to the project instance
export default project;
