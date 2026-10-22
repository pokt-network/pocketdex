// Backfills the session rosters (src/mappings/dbFunctions/sessionRosters.ts) for the session starts from FROM_HEIGHT to
// TO_HEIGHT, with the indexer's own code (src/mappings/pocket/sessionRosters.ts), then writes the final states of every
// session whose settlement block has come, in height order, as the indexer would have at each of them.
// The starts are written newest first, one transaction each, and each lowers session_roster_progress.from_height to
// itself: what the rosters say they cover is always written (a stopped run is resumed by running it again: TO_HEIGHT
// defaults to the first start held minus 1). Then one transaction per settlement block for the final states.
//
//   DATABASE_URL=postgres://... SCHEMA=mainnet FROM_HEIGHT=889001 npx ts-node --transpile-only scripts/backfill_session_rosters.ts
//
// TO_HEIGHT defaults to the first start the rosters already hold minus 1 (the indexer's), or the latest block.
// Several runs over disjoint ranges can write rosters at once with SKIP_FINAL_STATES=1, which leaves the progress
// alone (the ranges are not contiguous while they run); then one run with FINAL_STATES_ONLY=1 over the whole range
// writes the final states and lowers from_height to FROM_HEIGHT.
// FROM_HEIGHT below the chain's v0.1.33 height (sessionRostersFromHeight of the chain id: CHAIN_ID, or the blocks
// table's) is refused: the rosters before it are not the chain's. Run it on the primary once the indexer with the rosters
// is running.
import {
  buildSessionRosters,
  SessionRosterInputs,
  sessionRostersFromHeight,
} from "../src/mappings/pocket/sessionRosters";

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
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  await c.query("SET jit = off");
  const q = async (sql: string, params?: unknown[]) => (await c.query(sql, params)).rows;
  const chainId =
    process.env.CHAIN_ID ?? String((await q(`SELECT chain_id FROM ${s}.blocks ORDER BY id DESC LIMIT 1`))[0].chain_id);
  const from = Number(process.env.FROM_HEIGHT);
  const minFrom = sessionRostersFromHeight(chainId);
  if (!Number.isFinite(from) || from < minFrom)
    throw new Error(`FROM_HEIGHT must be at least ${minFrom} on ${chainId}`);
  const held = await q(`SELECT from_height FROM ${s}.session_roster_progress`);
  const latest = Number((await q(`SELECT max(id) h FROM ${s}.blocks`))[0].h);
  const to = Number(process.env.TO_HEIGHT ?? (held.length ? Number(held[0].from_height) - 1 : latest));
  const parallel = Boolean(process.env.SKIP_FINAL_STATES);
  // the starts of the range, from the grid (cheap), then written newest first
  const starts: number[] = [];
  for (let h = from; !process.env.FINAL_STATES_ONLY && h <= to; ) {
    const [g] = await q(`SELECT start_height, blocks_per_session FROM ${s}._session_grid($1::bigint)`, [h]);
    if (g.start_height === null) throw new Error(`no session params at ${h}`);
    const start = Number(g.start_height);
    if (start >= from && start <= to) starts.push(start);
    h = start + Number(g.blocks_per_session);
  }
  const t0 = Date.now();
  let written = 0;
  for (const h of starts.reverse()) {
    const [inputs] = await q(`SELECT * FROM ${s}._session_roster_inputs($1::bigint)`, [h]);
    await q("BEGIN");
    await q(`SELECT ${s}._write_session_rosters($1::jsonb)`, [
      JSON.stringify(buildSessionRosters(h, inputs as unknown as SessionRosterInputs)),
    ]);
    if (!parallel) {
      await q(
        `INSERT INTO ${s}.session_roster_progress AS t (singleton, from_height, height) VALUES (true, $1, $2)
         ON CONFLICT (singleton) DO UPDATE SET from_height = least(t.from_height, EXCLUDED.from_height)`,
        [h, to]
      );
    }
    await q("COMMIT");
    written += 1;
    if (written % 100 === 0)
      console.log(`start ${h}: ${written} of ${starts.length}, ${Math.round((Date.now() - t0) / 1000)} s`);
  }
  console.log(
    `rosters: ${written} starts written, ${starts.length ? `${starts[starts.length - 1]}..${starts[0]}` : "none"}`
  );
  if (parallel) {
    await c.end();
    return;
  }
  // the sessions of claims with no roster (applications staked during a session), as the indexer writes them at the
  // claim's block: claims up to the latest block, of the starts of the range
  let late = 0;
  for (const m of await q(`SELECT * FROM ${s}._claims_without_roster($1::bigint, $2::bigint, $3::bigint)`, [
    from,
    latest,
    from,
  ])) {
    if (Number(m.start_height) > to) continue;
    const [at] = await q(`SELECT * FROM ${s}._session_roster_inputs($1::bigint, $2::jsonb)`, [
      m.start_height,
      JSON.stringify(m.pairs),
    ]);
    if (!at.is_start) continue;
    await q(`SELECT ${s}._write_session_rosters($1::jsonb)`, [
      JSON.stringify(
        buildSessionRosters(Number(m.start_height), at as unknown as SessionRosterInputs, m.session_ids as string[])
      ),
    ]);
    late += 1;
  }
  console.log(`claims with no roster: sessions of ${late} starts written`);
  if (process.env.FINAL_STATES_ONLY) {
    await q(
      `INSERT INTO ${s}.session_roster_progress AS t (singleton, from_height, height) VALUES (true, $1, $2)
       ON CONFLICT (singleton) DO UPDATE SET from_height = least(t.from_height, EXCLUDED.from_height)`,
      [from, to]
    );
  }
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
