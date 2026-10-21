// Backfills the session rosters (src/mappings/dbFunctions/sessionRosters.ts) for the session starts from FROM_HEIGHT to
// TO_HEIGHT, with the indexer's own code (src/mappings/pocket/sessionRosters.ts), then writes the final states of every
// session whose settlement block has come, in height order, as the indexer would have at each of them.
// One transaction per session start and per settlement block; a start already written is left as it is, so a stopped run
// is resumed by running it again. session_roster_progress.from_height is lowered to the first start written.
//
//   DATABASE_URL=postgres://... SCHEMA=mainnet FROM_HEIGHT=889001 npx ts-node --transpile-only scripts/backfill_session_rosters.ts
//
// TO_HEIGHT defaults to the first start the rosters already hold minus 1 (the indexer's), or the latest block.
// FROM_HEIGHT below the chain's v0.1.33 height (SESSION_ROSTERS_FROM_HEIGHT) is refused: the rosters before it are not
// the chain's. Run it on the primary once the indexer with the rosters is running.
import { buildSessionRosters, SessionRosterInputs } from "../src/mappings/pocket/sessionRosters";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Client } = require("pg") as {
  Client: new (o: { connectionString?: string }) => {
    connect(): Promise<void>;
    end(): Promise<void>;
    query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
  };
};

async function main(): Promise<void> {
  const s = process.env.SCHEMA ?? "mainnet";
  const from = Number(process.env.FROM_HEIGHT);
  const minFrom = Number(process.env.MIN_FROM_HEIGHT ?? (s === "mainnet" ? 703870 : 1));
  if (!Number.isFinite(from) || from < minFrom) throw new Error(`FROM_HEIGHT must be at least ${minFrom}`);
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  await c.query("SET jit = off");
  const q = async (sql: string, params?: unknown[]) => (await c.query(sql, params)).rows;
  const held = await q(`SELECT from_height FROM ${s}.session_roster_progress`);
  const latest = Number((await q(`SELECT max(id) h FROM ${s}.blocks`))[0].h);
  const to = Number(process.env.TO_HEIGHT ?? (held.length ? Number(held[0].from_height) - 1 : latest));
  let h = from;
  let first: number | undefined;
  let starts = 0;
  const t0 = Date.now();
  while (h <= to) {
    const [inputs] = await q(`SELECT * FROM ${s}._session_roster_inputs($1::bigint)`, [h]);
    if (!inputs.is_start) {
      h += 1;
      continue;
    }
    first ??= h;
    await q("BEGIN");
    await q(`SELECT ${s}._write_session_rosters($1::jsonb)`, [
      JSON.stringify(buildSessionRosters(h, inputs as unknown as SessionRosterInputs)),
    ]);
    await q(
      `INSERT INTO ${s}.session_roster_progress AS t (singleton, from_height, height) VALUES (true, $1, $2)
       ON CONFLICT (singleton) DO UPDATE SET from_height = least(t.from_height, EXCLUDED.from_height)`,
      [first, h]
    );
    await q("COMMIT");
    starts += 1;
    if (starts % 100 === 0) console.log(`start ${h}: ${starts} starts, ${Math.round((Date.now() - t0) / 1000)} s`);
    h += Number(inputs.blocks_per_session);
  }
  console.log(`rosters: ${starts} starts written from ${first} to ${to}`);
  // the final states, at every block where a session written here settles or a claim of one settled
  const heights = await q(
    `SELECT h FROM (SELECT DISTINCT r.settlement_height::bigint h FROM ${s}.session_rosters r
                    WHERE r.settled_height IS NULL AND r.start_height BETWEEN $1 AND $2
                    UNION SELECT b.height FROM ${s}.settlement_blocks b WHERE b.height > $1) x
     WHERE x.h <= $3 ORDER BY 1`,
    [from, to, latest]
  );
  let changed = 0;
  for (const { h: sh } of heights) {
    await q("BEGIN");
    changed += Number((await q(`SELECT ${s}.finalize_session_rosters($1::bigint) n`, [sh]))[0].n);
    await q("COMMIT");
  }
  console.log(`final states: ${heights.length} blocks, ${changed} seats written`);
  await c.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
