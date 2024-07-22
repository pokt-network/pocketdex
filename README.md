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

- [Docs](#docs)
- [Getting Started](#getting-started)
  - [1. Ensure submodules are updated](#1-ensure-submodules-are-updated)
  - [2. Install dependencies](#2-install-dependencies)
  - [3. Generate types](#3-generate-types)
  - [4. Run](#4-run)
    - [4.1 Errors running \& building](#41-errors-running--building)
    - [4.2 Using a pre-built image](#42-using-a-pre-built-image)
- [DB Migrations](#db-migrations)
  - [Install dependencies](#install-dependencies)
  - [Running Migrations](#running-migrations)
  - [Creating Migrations](#creating-migrations)
    - [New table schemas](#new-table-schemas)
      - [When `pg_dump` is insufficient](#when-pg_dump-is-insufficient)
    - [TypeScript migration](#typescript-migration)
  - [Committing Migrations](#committing-migrations)
  - [Cleanup](#cleanup)
  - [Debugging](#debugging)
- [End-to-end Testing](#end-to-end-testing)
- [Tracing](#tracing)

## Docs

See the [docs](./docs/introduction.md) directory.

## Getting Started

### 1. Ensure submodules are updated

```shell
git submodule update --init --recursive
```

### 2. Install dependencies

```shell
yarn install
```

### 3. Generate types

Types will need to be regenerated any time the `graphql.schema` is changed.

```shell
yarn run codegen
```

### 4. Run

Create a copy of `.env.sample` as `.env` which is required on the following commands.

You can modify `.env` as you wish.

**IMPORTANT: if you change WATCH value, you need to rebuild the image.**

```shell
cp .env.sample .env
```

Build & start:

```shell
# Run this ONLY IF indexing poktroll localnet.
# This will allows subquery-node to connect with the poktroll validator

# Leave this open in a separated terminal
yarn docker:tunnel

# Then build docker and start
yarn run docker:build

# By default subquery-node has WATCH=true and NODE_ENV=develop
# which mean that any change to code/schema/dotenv files will reload it and will be using .env.develop file
yarn run docker:start
```

Stop (without deleted data)

```shell
yarn run docker:stop
```

Or Stop & clean up (delete postgres data):

```shell
yarn run docker:clean
```

#### 4.1 Errors running & building

If you're hitting errors with the above command, try cleaning your cache:

```bash
yarn cache clean
```

And pick up from the `yarn run docker:build` step above

#### 4.2 Using a pre-built image

If you are unable to build locally, a pre-built image is available on Docker Hub: [bryanchriswhite/pocketdex-subquery-node:latest](https://hub.docker.com/r/bryanchriswhite/pocketdex-subquery-node).

To use this image, pull it down:

```shell
docker pull bryanchriswhite/pocketdex-subquery-node:latest
```

Then, re-tag the image to match what docker compose is expecting (assumes the repo root dir is `pocketdex`):

```shell
docker tag bryanchriswhite/pocketdex-subquery-node:latest pocketdex-subquery-node:latest
```

**Alternatively**, you may update the `docker-compose.yml` file, just remember not to commit this change:

```yaml
services:
  subquery-node:
    image: bryanchriswhite/pocketdex-subquery-node:latest
    ...
```

## DB Migrations

This repository uses [graphile-migrate](https://github.com/graphile/migrate) CLI to manage database migrations.

### Install dependencies

Install global npm dependencies:

- [graphile-migrate](https://github.com/graphile/migrate)
- [plv8ify](https://plv8.github.io/)

```bash
npm install -g graphile-migrate plv8ify
```

### Running Migrations

Given that you already have a database with some, potentially outdated, schema,
you can catch up to the latest state by running all committed but unapplied migrations:

```bash
graphile-migrate migrate
```

_(see: [graphile-migrate README](https://github.com/graphile/migrate#usage) for more)_

### Creating Migrations

#### New table schemas

When introducing schema change which adds an entity / table, it is currently most
convenient to allow the subquery node to initially generate any new tables (including indexes and constraints).

This schema can then be dumped for use in the accompanying migration.

The current schema sql file can be generated from an existing DB schema (optionally, including data) via [`pg_dump`](https://www.postgresql.org/docs/current/app-pgdump.html).

Package scripts are available for dumping the schema only or for dumping the schema plus any data present:

```bash
yarn db:dump:schema
# OR
yarn db:dump:all
```

Additional arguments may be forwarded to the underlying `pg_dump` command b
appending `-- <additional args / flags>` when running package scripts (see: [npm-run-script docs](https://docs.npmjs.com/cli/v6/commands/npm-run-script)). For example:

```bash
# Dumps schema only from blocks and messages tables
yarn db:dump:schema -- -t blocks -t messages
```

##### When `pg_dump` is insufficient

In some cases, `pg_dump` may not export a relevant DB object; for example, enums.

In these cases, it is necessary to manually extract the relevant data from the DB
and incorporate it into the initial_schema.sql file.

In the case of **enums**, the following queries expose the relevant records, the results
from which can be re-written as a COPY or INSERT statements into the respective tables from which they came:

```sql
# List enum types
SELECT oid, typname FROM pg_type WHERE typcategory = 'E';

# List values for a particular enum
SELECT * from pg_enum where enumtypid = <pg_type.oid>;
```

#### TypeScript migration

It is not necessary to add any TypeScript source as part of any migration (e.g. 000002).
In the event that the migration is too complex to be easily reasoned about it in SQL, it may be more straightforward to use the plv8ify workflow:

1. Write a migration in ./migrations/current.ts which exports a single function
   that kicks off the migration (see: [plv8 docs > built-ins](https://plv8.github.io/#plv8-built-ins)).

1. Transform the current typescript migration function to a .sql function:

   ```bash
   yarn plv8ify
   ```

   **This writes the generated SQL to ./migrations/current.sql.**

1. Since we're using a non-default schema name, it's prudent to prepend the following preamble to current.sql:

   ```sql
   CREATE SCHEMA IF NOT EXISTS app;
   SET SCHEMA 'app';
   ```

1. Lastly, in order for the migration function to execute when the migration is applied,
   append the following to current.sql (substituting labels identified by surrounding brackets with their respective values):

   ```sql
   SELECT * from <migration function>([arg, ...]);
   ```

### Committing Migrations

Once you're ready to test / apply the migration:

```bash
graphile-migrate commit
```

If it was successful, graphile-migrate will have moved the contents of current.sql (and reset it) into a file named by the next number in the migration count sequence.

_(see: [graphile-migrate README](https://github.com/graphile/migrate#usage) for more)_

### Cleanup

If the plv8ify workflow was used, until it is automated, it is conventional to manually move the contents of the current.ts file into a file in migrations/src named after its respective generated SQL file.
**It is against convention to update any import paths as a result of this move.**

### Debugging

When things aren't going perfectly, [`plv8.elog`](https://plv8.github.io/#plv8-built-ins) is extremely useful for getting more detail out of the running migration.
Be sure to be looking at the **postgres service's logs** (as opposed to the error message returned by `graphile-migrate`):

```bash
docker compose logs -f postgres
```

## End-to-end Testing

_TODO_

## Tracing

_TODO_
