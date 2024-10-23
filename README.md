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
  - [3. Run](#3-run)
    - [Localnet ONLY](#localnet-only)
    - [3.1 Debugging, errors running \& building](#31-debugging-errors-running--building)
    - [3.2 Using a pre-built image](#32-using-a-pre-built-image)
    - [3.3 Available Scripts breakdown](#33-available-scripts-breakdown)
    - [3.4 Using k8s](#34-using-k8s)

## Usage & Query Docs

See the [introduction docs](./docs/introduction.md) directory for details
on how to use indexed data after you're fully set up.

### Explore via postgres

Connect to the postgres container, update the schema, and explore!

```bash
docker exec -it pocketdex_development-postgres-1 psql -U postgres -d postgres
SET SCHEMA "testnet";
# OR, if indexing localnet:
# SET SCHEMA "localnet";
SET search_path TO app;
\dt
```

### Explore via GraphQL

The [poktscan](poktscan.com) team put together a playground to explore the testnet data.

You can access at [shannon-testnet.poktscan.com](https://shannon-testnet.poktscan.com/) and use
the sample query below to get started.

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

### tl;dr local development (if not your first time)

Run the following:

```bash
yarn install
yarn run codegen
docker context use default # Optional
yarn run docker:build:development
yarn poktroll:proxy:start
yarn run docker:start:development
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

### 3a. Run via [Tilt](https://tilt.dev/)

```bash
# Start tilt
tilt up

# Delete tilt resources
tilt down
```

#### Running against localnet

NOTE: 🚨 The [poktroll](https://github.com/pokt-network/poktroll) localnet includes pocketdex in its tilt environment. 🚨

If you need to run pocketdex against poktroll localnet, but can't use the poktroll repo's tilt environment for whatever reason, update (_but don't commit_) the `indexer_values_path` in the `Tiltfile`:

```diff
  load("./tiltfiles/pocketdex.tilt", "pocketdex")
  pocketdex("./",
            genesis_file_name="testnet.json",
            postgres_values_path="./tiltfiles/k8s/postgres/postgres-values.yaml",
            pgadmin_values_path="./tiltfiles/k8s/pgadmin/pgadmin-values.yaml",
-           indexer_values_path="./tiltfiles/k8s/indexer/dev-testnet-indexer-values.yaml",
+           indexer_values_path="./tiltfiles/k8s/indexer/dev-localnet-indexer-values.yaml",
            gql_engine_values_path="./tiltfiles/k8s/gql-engine/dev-gql-engine-values.yaml")
```

Tilt will automatically apply the change on save.

### 3b. Run via docker-compose

Dotenv files will be automatically created after the `yarn install` thanks to the `postinstall` script.
After that, feel free to modify them as you wish.

You will see three dotenv files, each for the corresponding script and environment:

* `.env.production`
* `.env.development`
* `.env.test`

Alternatively, you can manually create them running:

```shell
yarn run env:prepare
```

For this README we will be running all the commands in `development` but you can also run them in `test` or `production`.
Following this structure, you can run every docker command `docker:<cmd>:<production|development|test>`,

#### Localnet ONLY

```shell
# Run this ONLY IF indexing poktroll localnet.
# This will allows subquery-node to connect with the poktroll validator

# Leave this open in a separated terminal. Interrupting the terminal will stop the container.
yarn poktroll:proxy:start

# To stop and remove the proxy
yarn poktroll:proxy:stop
```

Build & start:

```shell
# Then build docker and start
yarn run docker:build:development
# This will turn on the process under a WATCHER so any change to the project.ts schema.graphql or src will trigger
# the needed builds again.
yarn run docker:start:development
```

Stop (without deleted data)

```shell
yarn run docker:stop:development
```

Or Stop & clean up (delete postgres data):

```shell
yarn run docker:clean:development
```

#### 3b.1 Debugging, errors running & building

If you're hitting errors with the above command, do a nuclear clean of all potential issues:

```bash
yarn cache clean
docker builder prune --all
docker context use default
```

Now pick up from the `yarn run docker:build` step above.

#### 3b.2 Using a pre-built image

If you are unable to build locally, a pre-built image is available on Docker Hub: [bryanchriswhite/pocketdex-subquery-node:latest](https://hub.docker.com/r/bryanchriswhite/pocketdex-subquery-node).

To use this image, pull it down:

```shell
docker pull bryanchriswhite/pocketdex-subquery-node:latest
```

Then, re-tag the image to match what docker compose is expecting (assumes the repo root dir is `pocketdex`):

```shell
docker tag bryanchriswhite/pocketdex-subquery-node:latest pocketdex-subquery-node:latest
```

**Alternatively**, you may update the `docker-compose.<env>.yml` file, just remember not to commit this change:

```yaml
services:
  subquery-node:
    image: bryanchriswhite/pocketdex-subquery-node:latest
    ...
```

#### 3b.3 Available Scripts breakdown

* `preinstall` - Enforces the use of Yarn as the package manager.
* `postinstall` - Executes the `env:prepare` script after the installation process.
* `env:prepare` - Runs the `prepare-dotenv.sh` script. It prepares .env files for `development`, `test` and `production` environments using `.env.sample`.
* `codegen` - Executes the SubQL Codegen.
* `build` - Triggers a custom build script written in shell due to its complexity.
* `watch:build` - Acts similar to the build script, but it also disables the linter for real-time coding with nodemon.
* `lint` - Executes the source code linter.
* `lint:fix` - Executes the linter with automatic fixing of solvable issues.
* `format` - Applies Prettier to the code according to the rules defined in `.prettierrc`.
* `format:ci` - Checks the code formatting with Prettier without modifying it.
* `vendor:setup` - Runs the `vendor.sh` shell script to prepare, run, and build vendor packages.
* `vendor:clean-cache` - Removes the `.yarn/cache` files from vendor packages that can potentially lead to errors.
* `vendor:install` - Executes the `vendor.sh` shell script to install dependencies for each vendor package.
* `vendor:build` - Executes the `vendor.sh` script to build each vendor package.
* `vendor:lint` - Executes the `vendor.sh` script to lint each vendor package.
* `vendor:clean` - Executes the `vendor.sh` script to recursively remove `node_modules` for each vendor package.
* `docker:compose` - Runs the `docker-compose.sh` script, which forms the base for all other `docker:<action>:<environment>` scripts.
* `poktroll:proxy:start` and `poktroll:proxy:stop` - Executes `proxy-tunnel.sh` starting and stopping the proxy tunnel to poktroll localnet validator, respectively.
* `docker:check-env:<environment>` - Ensures the required `.env.<environment>` exists by running `dotenv-check.sh`.
* `docker:build:<environment>` - Builds docker images for the specified environment.
* `docker:build:no-cache:<environment>` - Builds docker images for the specified environment without using Docker's cache.
* `docker:start:<environment>` - Starts all services for the specified environment.
* `docker:ps:<environment>` - Shows the status of services for the specified environment.
* `docker:stop:<environment>` - Stops all active services for the specified environment without removing them.
* `docker:clean:<environment>` - Stops and removes all services, volumes, and networks for the specified environment.

### 3c. Using k8s

See the instructions in [docs/kubernetes.md](./docs/kubernetes.md) for deploying using Kubernetes.