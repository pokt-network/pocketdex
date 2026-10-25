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
// writes the final states and lowers from_height to FROM_HEIGHT. Only with the indexer stopped: those runs leave every
// session open, and the indexer's next block would settle all of them in its block transaction.
// FROM_HEIGHT below the chain's v0.1.33 height (sessionRostersFromHeight of the chain id: CHAIN_ID, or the blocks
// table's) is refused: the rosters before it are not the chain's. Run it on the primary once the indexer with the rosters
// is running. The sessions of claims with no roster are looked for LATE_CHUNK blocks of claims at a time (default
// 2000), one transaction each. test/money/session_rosters.db.spec.ts runs backfillSessionRosters over the spec's chain.
import {
  buildSessionRosters,
  SessionRosterInputs,
  sessionRostersFromHeight,
  writeClaimsWithoutRoster,
} from "../src/mappings/pocket/sessionRosters";

export type Query = (sql: string, params?: unknown[]) => Promise<Array<Record<string, unknown>>>;

export interface BackfillOptions {
  from: number;
  // default: the first start the rosters hold minus 1, or latest
  to?: number;
  // the last block processed (default: the latest block): claims and final states up to it
  latest?: number;
  skipFinalStates?: boolean;
  finalStatesOnly?: boolean;
  lateChunk?: number;
  log?: (line: string) => void;
  // awaited after each start's transaction (the spec checks there that no settled-due session is left open)
  afterStart?: (start: number) => Promise<void>;
}

// The open sessions of one session end settle as the indexer settles them: at each block before the predicted
// settlement height where one of their claims settled, expired or was discarded, then at the predicted one (the
// outcomes come after the session end: the height range reads the primary keys). Also scripts/rewrite_session_starts.ts.
export async function settleSessionsAt(q: Query, s: string, end: number, settle: number): Promise<void> {
  const early = await q(
    `SELECT DISTINCT x.height::bigint h FROM (
       SELECT height FROM ${s}.claim_settlements WHERE height > $1 AND height < $2 AND session_end = $1
       UNION SELECT height FROM ${s}.claim_expirations WHERE height > $1 AND height < $2 AND session_end = $1
       UNION SELECT height FROM ${s}.claim_discards WHERE height > $1 AND height < $2 AND session_end = $1) x ORDER BY 1`,
    [end, settle]
  );
  for (const { h: at } of [...early, { h: settle }]) await q(`SELECT ${s}.finalize_session_rosters($1::bigint)`, [at]);
}

export async function backfillSessionRosters(
  q: Query,
  s: string,
  o: BackfillOptions
): Promise<{ starts: number; late: number; unmatched: string[]; finalBlocks: number; changed: number }> {
  const log = o.log ?? (() => undefined);
  const from = o.from;
  const held = await q(`SELECT from_height FROM ${s}.session_roster_progress`);
  const latest = o.latest ?? Number((await q(`SELECT max(id) h FROM ${s}.blocks`))[0].h);
  const to = o.to ?? (held.length ? Number(held[0].from_height) - 1 : latest);
  const parallel = Boolean(o.skipFinalStates);
  // the starts of the range, from the grid (cheap), then written newest first
  const gridStarts = async (): Promise<number[]> => {
    const out: number[] = [];
    for (let h = from; h <= to; ) {
      const [g] = await q(`SELECT start_height, blocks_per_session FROM ${s}._session_grid($1::bigint)`, [h]);
      if (g.start_height === null) throw new Error(`no session params at ${h}`);
      const start = Number(g.start_height);
      if (start >= from && start <= to) out.push(start);
      h = start + Number(g.blocks_per_session);
    }
    return out;
  };
  const starts: number[] = o.finalStatesOnly ? [] : await gridStarts();
  // FINAL_STATES_ONLY lowers the coverage to FROM_HEIGHT: first every start of the range must hold its sessions (a
  // SKIP_FINAL_STATES run that failed or missed a stretch would otherwise be reported as covered). A start with no
  // rosters is a hole unless its inputs give no session (no application, or no candidate).
  if (o.finalStatesOnly) {
    const startsHeld = new Set(
      (await q(`SELECT DISTINCT start_height::bigint h FROM ${s}.session_rosters WHERE start_height BETWEEN $1 AND $2`, [
        from,
        to,
      ])).map((r) => Number(r.h))
    );
    const holes: number[] = [];
    for (const h of await gridStarts()) {
      if (startsHeld.has(h)) continue;
      const [inputs] = await q(`SELECT * FROM ${s}._session_roster_inputs($1::bigint)`, [h]);
      const sessions = buildSessionRosters(h, inputs as unknown as SessionRosterInputs).sessions as unknown[];
      if (sessions.length > 0) holes.push(h);
    }
    if (holes.length > 0)
      throw new Error(`${holes.length} session starts of ${from}..${to} hold no rosters (first: ${holes.slice(0, 5).join(", ")}); write them before FINAL_STATES_ONLY`);
  }
  const settleSessions = (end: number, settle: number) => settleSessionsAt(q, s, end, settle);
  const t0 = Date.now();
  let written = 0;
  for (const h of starts.reverse()) {
    const [inputs] = await q(`SELECT * FROM ${s}._session_roster_inputs($1::bigint)`, [h]);
    await q("BEGIN");
    await q(`SELECT ${s}._write_session_rosters($1::jsonb)`, [
      JSON.stringify(buildSessionRosters(h, inputs as unknown as SessionRosterInputs)),
    ]);
    // the start's sessions settle in the same transaction when their settlement block has come: left open, the
    // indexer's next block would settle every one of them in its block transaction (finalize_session_rosters takes
    // every open session whose settlement height has passed; beta 2026-10-25: 8,535 starts of 60 days, the block never
    // ended and the indexer was restarted over and over). Newest first, so only this start's sessions are due here.
    const settle = Number(inputs.settlement_height);
    if (!parallel && settle <= latest) await settleSessions(Number(inputs.end_height), settle);
    if (!parallel) {
      await q(
        `INSERT INTO ${s}.session_roster_progress AS t (singleton, from_height, height) VALUES (true, $1, $2)
         ON CONFLICT (singleton) DO UPDATE SET from_height = least(t.from_height, EXCLUDED.from_height)`,
        [h, to]
      );
    }
    await q("COMMIT");
    if (o.afterStart) await o.afterStart(h);
    written += 1;
    if (written % 100 === 0)
      log(`start ${h}: ${written} of ${starts.length}, ${Math.round((Date.now() - t0) / 1000)} s`);
  }
  log(`rosters: ${written} starts written, ${starts.length ? `${starts[starts.length - 1]}..${starts[0]}` : "none"}`);
  if (parallel) return { starts: written, late: 0, unmatched: [], finalBlocks: 0, changed: 0 };
  // the sessions of claims with no roster (applications staked during a session), as the indexer writes them at the
  // claim's block: claims up to the latest block, of the starts of the range, lateChunk blocks of claims a transaction
  const chunk = o.lateChunk ?? 2000;
  let late = 0;
  const unmatched: string[] = [];
  for (let a = from; a <= latest; a += chunk) {
    await q("BEGIN");
    const w = await writeClaimsWithoutRoster(
      q as (sql: string, params: unknown[]) => ReturnType<Query>,
      s,
      a,
      Math.min(a + chunk - 1, latest),
      from
    );
    // the sessions just written whose settlement block has come settle here, as the starts above do (in the normal run
    // the only open ones of the range; FINAL_STATES_ONLY leaves them to the final pass, with the indexer stopped)
    if (w.written > 0 && !o.finalStatesOnly) {
      const due = await q(
        `SELECT DISTINCT end_height::bigint e, settlement_height::bigint h FROM ${s}.session_rosters
         WHERE settled_height IS NULL AND settlement_height <= $1 AND start_height >= $2 ORDER BY 2`,
        [latest, from]
      );
      for (const { e, h: at } of due) await settleSessions(Number(e), Number(at));
    }
    await q("COMMIT");
    late += w.written;
    unmatched.push(...w.unmatched);
  }
  log(`claims with no roster: ${late} sessions written, ${unmatched.length} not reproduced`);
  if (o.finalStatesOnly) {
    await q(
      `INSERT INTO ${s}.session_roster_progress AS t (singleton, from_height, height) VALUES (true, $1, $2)
       ON CONFLICT (singleton) DO UPDATE SET from_height = least(t.from_height, EXCLUDED.from_height)`,
      [from, to]
    );
  }
  // the final states again, at every block where a session written here settles or a claim of one settled: the late
  // sessions, and claims settled at another height than the one predicted (a window param change)
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
  log(`final states: ${heights.length} blocks, ${changed} seats written`);
  return { starts: written, late, unmatched, finalBlocks: heights.length, changed };
}

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
  await backfillSessionRosters(q, s, {
    from,
    to: process.env.TO_HEIGHT ? Number(process.env.TO_HEIGHT) : undefined,
    skipFinalStates: Boolean(process.env.SKIP_FINAL_STATES),
    finalStatesOnly: Boolean(process.env.FINAL_STATES_ONLY),
    lateChunk: process.env.LATE_CHUNK ? Number(process.env.LATE_CHUNK) : undefined,
    log: (line) => console.log(line),
  });
  await c.end();
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
