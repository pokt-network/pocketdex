![poketdex.png](docs%2Fassets%2Fpoketdex.png)
<br/>
![pocketdex-mono.png](docs%2Fassets%2Fpocketdex-mono.png)
<br/>
![gotta-cache-em-all2.png](docs%2Fassets%2Fgotta-cache-em-all2.png)

# Pocketdex <!-- omit in toc -->

Pocketdex is an indexer for the Shannon implementation of the pocket network protocol.

It is built using the [SubQuery](https://subquery.network) SDK, which wraps
[postgraphile](https://www.graphile.org/postgraphile/) to provide a robust GraphQL
API to the indexed data.

To learn more about SubQuery, [see their docs](https://academy.subquery.network).

- [Usage \& Query Docs](#usage--query-docs)
  - [Explore via postgres](#explore-via-postgres)
  - [Explore via GraphQL](#explore-via-graphql)
- [Getting Started](#getting-started)
  - [tl;dr local development (if not your first time)](#tldr-local-development-if-not-your-first-time)
  - [1. Install dependencies](#1-install-dependencies)
  - [2. Generate types](#2-generate-types)
  - [3a. Run via Tilt](#3a-run-via-tilt)
  - [3b. Run via docker-compose](#3b-run-via-docker-compose) 
    - [Localnet ONLY](#localnet-only)
    - [3b.1 Debugging, errors running \& building](#31-debugging-errors-running--building)
    - [3b.2 Using a pre-built image](#32-using-a-pre-built-image)
    - [3b.3 Available Scripts breakdown](#33-available-scripts-breakdown)
  - [3c. Using k8s](#3c-using-k8s)

## Usage & Query Docs

See the [introduction docs](./docs/introduction.md) directory for details
on how to use indexed data after you're fully set up.

### Explore via postgres

Connect to the postgres container, update the schema, and explore!
NOTE: this assumes you have psql cli.

```bash
psql -- psql -U postgres -d postgres
SET SCHEMA "testnet";
# OR, if indexing localnet:
# SET SCHEMA "localnet";
SET search_path TO app;
\dt
```

### Explore via PgAdmin4

Navigate to: http://localhost:5050 or into Tilt UI under `pocketdex-db` section and look for the pgadmin resource,
which will have the admin email and password at top-left of it.

### Explore via GraphQL

Navigate to http://localhost:3000 or the port you specified in .env.development at `SUBQUERY_GRAPHQL_ENGINE_PORT` var.

<details>
  <summary>Click to expand sample query</summary>

  ```graphql
    query  {
        distinct_poktroll_event_types: events (distinct: TYPE, filter: {type: {includes: "poktroll"}}){
        totalCount
        nodes {
          type
        }
      }

      distinct_poktroll_message_types: messages (distinct: TYPE_URL, filter:{typeUrl: {includes: "poktroll"}}) {
        totalCount
        nodes {
          typeUrl
          # transactionId
        }
      }

      unprocessedEntities (distinct: ERROR) {
        totalCount
        nodes {
          eventId
          messageId
          transactionId
          error
        }
      }

      indexer_metadata: _metadata {
        targetHeight
        lastProcessedHeight
      }


      # tx_events: events(filter: {type: {equalTo: "tx"}}) {
      #   nodes {
      #     attributes {
      #       nodes {
      #         key
      #         value
      #       }
      #     }
      #   }
      # }

      # begin_block_events: events (filter: {attributes: {some: {key: {equalTo: "mode"}, value: {equalTo: "BeginBlock"}}}}) {
      #   nodes {
      #     attributes {
      #       nodes {
      #         key
      #         value
      #       }
      #     }
      #   }
      # }

      # events (distinct: TYPE) {
      #   nodes {
      #     type
      #   }
      # }

      # claims: messages(filter: {typeUrl: {equalTo: "/poktroll.proof.MsgCreateClaim"}}) {
      #   nodes {
      #     typeUrl
      #     json
      #   }
      # }

      # eventAttributes(distinct: KEY) {
      #   nodes {
      #     key
      #   }
      # }
  }
  ```

</details>

## Getting Started

This is the bare minimum to be here.

Only the first time:

```bash
cp .env.sample .env
```

```bash
yarn install
yarn run codegen
yarn run local-registry
# use --port if you already running other tilt like the poktroll one.
tilt up [--port 10351]
```

`ctrl+c` Interrupt to stop the Tilt UI

Cleanup

```bash
tilt down
```

### 1. Install dependencies

```shell
yarn install
```

### 2. Generate types

Types will need to be regenerated any time the `graphql.schema` is changed.

```shell
yarn run codegen
```

### 3. Switch between networks:

Modify .env `NETWORK` value between: `mainnet`, `beta`, `alpha` or `localnet`

For this last one you can do this in two ways:

1. Run this from `poktroll` repository using `make localnet_up` and modify `indexer.enabled=true` at
   `localnet_config.yaml` on that repository.
2. Copy a localnet genesis file here and uncomment `ENDPOINT` which you should point to a `localnet` fullnode RPC
   endpoint.
