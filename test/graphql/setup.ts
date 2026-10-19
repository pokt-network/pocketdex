// Prepares the database test:graphql introspects: the entity tables SubQuery would have created (entities.sql), then the
// release's startup DDL (createDbFunctions) run for real, twice (a start and a restart), so the comments that hide
// tables and functions and describe the rest are the ones the indexer writes. Then run a subql-query over it and
//   GRAPHQL_URL=http://127.0.0.1:3000/graphql yarn test:graphql
// Usage: GRAPHQL_PG=postgres://postgres:postgres@127.0.0.1:5432/postgres TS_NODE_FILES=true \
//   node -r ts-node/register test/graphql/setup.ts
/* eslint-disable @typescript-eslint/no-var-requires, @typescript-eslint/no-explicit-any */
import * as fs from "node:fs";
import * as path from "node:path";

const SCHEMA = "mainnet";
const { Client } = require("pg");

async function main(): Promise<void> {
  const url = process.env.GRAPHQL_PG;
  if (!url) throw new Error("GRAPHQL_PG is not set");
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query(
      `CREATE EXTENSION IF NOT EXISTS btree_gist; CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
       DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE; CREATE SCHEMA ${SCHEMA};`
    );
    await client.query(fs.readFileSync(path.join(__dirname, "entities.sql"), "utf8"));

    // every entity of schema.graphql has its table in entities.sql
    const snake = (n: string) => n.replace(/(?<!^)([A-Z])/g, "_$1").toLowerCase();
    const entities = [
      ...fs.readFileSync(path.join(__dirname, "../../schema.graphql"), "utf8").matchAll(/^type (\w+) @entity/gm),
    ].map((m) => snake(m[1]));
    const have = new Set(
      (await client.query(`SELECT tablename FROM pg_tables WHERE schemaname = $1`, [SCHEMA])).rows.map(
        (r: { tablename: string }) => r.tablename
      )
    );
    const missing = entities.filter(
      (e) => ![e + "s", e + "es", e.replace(/y$/, "ies"), e].some((t) => have.has(t))
    );
    if (missing.length) throw new Error(`entities.sql has no table for: ${missing.join(", ")}; regenerate it`);

    // createDbFunctions with the database calls sent to the client: a transaction per createFunctions call, a bare
    // statement for each CONCURRENTLY index (transaction: null), as the indexer's sequelize sends them
    const g = globalThis as any;
    g.logger = { debug: () => undefined, info: () => undefined, warn: console.warn, error: console.error };
    g.cache = { get: async () => undefined, set: async () => undefined };
    const db = require("../../src/mappings/utils/db");
    db.getDbSchema = () => SCHEMA;
    db.getSequelize = () => ({
      query: async (sql: string, opts?: { transaction?: null }) => {
        if (opts && opts.transaction === null) await client.query(sql);
        else await client.query(`BEGIN;\n${sql}\nCOMMIT;`);
        return [];
      },
    });
    const { createDbFunctions } = require("../../src/mappings/dbFunctions");
    for (const start of ["start", "restart"]) {
      await createDbFunctions();
      console.log(`createDbFunctions: ${start} ok`);
    }
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
