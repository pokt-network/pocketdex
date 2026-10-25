// Rewrites the session rosters of some session starts (STARTS, comma separated) with the indexer's current code: for a
// start whose rosters were written with a rule since fixed (the activation of a config restaked in the start block,
// 2026-10-25: mainnet 975821, 975981, 976021, 979961). Each start in one transaction: its sessions and seats deleted,
// written again (src/mappings/pocket/sessionRosters.ts), the sessions of its claims with no roster written, all of them
// settled as the indexer settles them once their settlement block has come, and the rollups of the start's UTC day
// rebuilt from the facts (rebuild_session_rollups: ~26 s for a busy mainnet day). Safe with the indexer running: the
// indexer writes only the day of the sessions settling now, and nothing else reads these starts' rows meanwhile.
//
//   DATABASE_URL=postgres://... SCHEMA=mainnet STARTS=975821,975981 npx ts-node --transpile-only scripts/rewrite_session_starts.ts
import { buildSessionRosters, SessionRosterInputs, writeClaimsWithoutRoster } from "../src/mappings/pocket/sessionRosters";
import { Query, settleSessionsAt } from "./backfill_session_rosters";

export async function rewriteSessionStarts(
  q: Query,
  s: string,
  starts: number[],
  log: (line: string) => void = () => undefined
): Promise<number> {
  const latest = Number((await q(`SELECT max(id) h FROM ${s}.blocks`))[0].h);
  let rows = 0;
  for (const start of starts) {
    const [inputs] = await q(`SELECT * FROM ${s}._session_roster_inputs($1::bigint)`, [start]);
    if (!inputs?.is_start) throw new Error(`${start} is no session start`);
    const settle = Number(inputs.settlement_height);
    const day = new Date(inputs.start_time as string | Date).toISOString().slice(0, 10);
    await q("BEGIN");
    try {
      const [gone] = await q(
        `WITH r AS (DELETE FROM ${s}.session_rosters WHERE start_height = $1 RETURNING session_num),
              ss AS (DELETE FROM ${s}.session_suppliers WHERE session_num IN (SELECT session_num FROM r) RETURNING 1)
         SELECT (SELECT count(*) FROM r) sessions, (SELECT count(*) FROM ss) seats`,
        [start]
      );
      await q(`SELECT ${s}._write_session_rosters($1::jsonb)`, [
        JSON.stringify(buildSessionRosters(start, inputs as unknown as SessionRosterInputs)),
      ]);
      const late = await writeClaimsWithoutRoster(
        q as (sql: string, params: unknown[]) => ReturnType<Query>,
        s,
        start,
        Math.min(settle, latest),
        start
      );
      if (settle <= latest) await settleSessionsAt(q, s, Number(inputs.end_height), settle);
      const [rb] = await q(`SELECT ${s}.rebuild_session_rollups($1::date) n`, [day]);
      await q("COMMIT");
      rows += Number(rb.n);
      log(`start ${start}: ${gone.sessions} sessions (${gone.seats} seats) rewritten, ${late.written} late, ` +
        `${late.unmatched.length} not reproduced; ${rb.n} rollup rows of ${day} rebuilt`);
    } catch (e) {
      await q("ROLLBACK");
      throw e;
    }
  }
  return rows;
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
  const starts = (process.env.STARTS ?? "").split(",").filter(Boolean).map(Number);
  if (starts.length === 0 || starts.some((x) => !Number.isFinite(x))) throw new Error("STARTS=<height>,<height>...");
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  await c.query("SET jit = off");
  const q: Query = async (sql, params) => (await c.query(sql, params)).rows;
  await rewriteSessionStarts(q, s, starts, (line) => console.log(line));
  await c.end();
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
