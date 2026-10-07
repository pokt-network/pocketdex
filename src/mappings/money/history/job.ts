// The history job: walks EVERY height from the one below money_progress.from_height (where the indexer's money step
// started) down to height 1,
// reading each block's /block_results from an archive RPC, and writes the settlement money of the heights that have
// any with the indexer's own parser (buildSettlementPayload, the map state and the delegator × validator split) and
// writer (write_settlement, which takes the same advisory lock). A height with no money event writes nothing.
//
// Coverage stays honest at every moment: before the first height the job records settlement_gaps [1, start]. A
// height with money is written in one transaction that also lowers the gap's to_height below it; heights with none
// lower it in batches (every flushEvery heights or flushMs), and only over a contiguous run of heights already read
// and classified, so the gap may lag behind the walk but never runs ahead of it; each lowering also lowers
// money_progress.from_height, where the catalog functions' coverage starts. The heights the gap still holds read as not
// covered, never as zero; the row goes with height 1. The gap row is also the resume point.
//
// A height counts as having no money only on positive proof: the response is for the height asked, its body parsed
// whole, and finalize_block_events is there and not empty (every real block has at least the mint of its BeginBlock;
// chain.ts). Anything else is retried, then stops the job; it never counts as a height with no money.
// The job stops at the first height that fails and never skips one.
//
// Each block is checked against the indexer's raw event tables: a table with more rows at the height than the block
// has events stops the job (a parser or fetch bug); fewer is the indexer's gap, logged and recorded in
// settlement_history_findings. Only one job runs per schema: it holds a session advisory lock for the whole run.
import { createHash } from "node:crypto";
import { writeSettlementCalls } from "../../dbFunctions/settlement/writer";
import { getParamId } from "../../utils/ids";
import { SETTLEMENT_ERAS } from "../../utils/params_history";
import { addDelegatorValidator } from "../de2";
import { isMapEra } from "../map";
import {
  buildSettlementPayload,
  EVENT_APPLICATION_REIMBURSEMENT_REQUEST,
  EVENT_CLAIM_EXPIRED,
  EVENT_CLAIM_SETTLED,
  EVENT_SUPPLIER_SLASHED,
  EVENT_VALIDATOR_REWARD_DISTRIBUTION,
  MONEY_EVENT_TYPES,
  PayloadSink,
  RawEvent,
  SettlementPayload,
} from "../payload";
import { addReplay, REPLAY_ERAS } from "../replay";
import { de2Validators, MAP_PARAM_KEYS, mapStateFrom, replayProposer, replayValidators, settlementEra } from "../state";
import { Chain } from "./chain";

export interface PgClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>>; rowCount?: number | null }>;
}

// The lowest height the job walks to, and the from_height of the gap row it owns.
export const GAP_FROM = 1;

// The indexer's raw tables of the money events, with the event each row stands for: the per-height cross-check.
export const RAW_EVENT_TABLES: ReadonlyArray<[table: string, event: string]> = [
  ["event_claim_settleds", EVENT_CLAIM_SETTLED],
  ["event_claim_expireds", EVENT_CLAIM_EXPIRED],
  ["event_supplier_slasheds", EVENT_SUPPLIER_SLASHED],
  ["event_application_reimbursement_requests", EVENT_APPLICATION_REIMBURSEMENT_REQUEST],
  ["event_validator_reward_distributions", EVENT_VALIDATOR_REWARD_DISTRIBUTION],
];

// Heights of raw-table counts read per query.
const RAW_RANGE = 2000;

// The session lock that keeps one history job per schema.
const lockKey = (schema: string) => `pocketdex.history.${schema}`;

export interface HistoryOptions {
  schema: string;
  // opened (Chain.open): its chain id labels the eras
  chain: Chain;
  // A second connection for the reads made ahead of the writer (params), so they never run inside a height's write
  // transaction.
  reader: PgClient;
  // First height to walk when no gap row exists yet and settlement_blocks is empty. With written heights the start
  // is always (lowest written height − 1); a different value is refused, since the heights between would be
  // neither walked nor in a gap.
  start?: number;
  // Lowest height to walk in this run (default 1). The gap keeps what is below it.
  to?: number;
  // Heights fetched and parsed ahead while the writer writes one (default 1): N + 1 heights in memory at most.
  workers?: number;
  // Heights with no money event between two lowerings of the gap (default 2000), and the longest wait between two
  // (default 30 s).
  flushEvery?: number;
  flushMs?: number;
  // Write every height in a transaction that is rolled back: every check runs, nothing stays, no gap row is touched.
  dryRun?: boolean;
  env?: NodeJS.ProcessEnv;
  log?: (line: string) => void;
}

export interface HistoryResult {
  // heights with money, written
  written: number[];
  // heights walked with no money event
  noMoney: number;
  // EventClaimDiscarded rows in the heights written
  discards: number;
  // event types per written height that the block has and the raw tables lack (settlement_history_findings)
  findings: number;
  // blocks walked without the mint event every mainnet block carries (each logged as a WARNING)
  mintless: number;
  // heights per era with a family the validator replay could not reproduce, written unattributed (validator '')
  unattributed: Record<string, number>;
  // set when the job stopped: at a height that failed ("height": not written, the gap still holds it), or while
  // lowering the gap over the heights with no money down to `height` ("gap": those heights stay in the gap)
  failed?: { stage: "height" | "gap"; height: number; era?: string; error: string };
}

// A block's events that the raw table lacks: the indexer's gap at the height.
interface Finding {
  type: string;
  chain: number;
  raw: number;
}

interface Prepared {
  height: number;
  era: string;
  payload: SettlementPayload;
  bytes: number;
  fetchMs: number;
  parseMs: number;
  findings: Finding[];
  // bonded validators and delegations read for the replay (REPLAY_ERAS), when the era has them
  snapshot?: { bonded: number; delegations: number };
  // how the replay wrote each family, and its time
  replay?: { modes: ReturnType<typeof addReplay>; ms: number };
}

// The rows per height of each raw table, read RAW_RANGE heights at a time as the walk goes down.
class RawCounts {
  private chunks = new Map<number, Promise<Map<number, Map<string, number>>>>();

  constructor(private readonly client: PgClient, private readonly schema: string) {}

  async get(height: number): Promise<Map<string, number>> {
    const key = Math.floor((height - 1) / RAW_RANGE);
    let chunk = this.chunks.get(key);
    if (!chunk) {
      chunk = this.load(key * RAW_RANGE + 1, (key + 1) * RAW_RANGE);
      this.chunks.set(key, chunk);
      // the walk only goes down: chunks above the one before are done
      for (const k of this.chunks.keys()) if (k > key + 1) this.chunks.delete(k);
    }
    return (await chunk).get(height) ?? new Map();
  }

  private async load(lo: number, hi: number): Promise<Map<number, Map<string, number>>> {
    const out = new Map<number, Map<string, number>>();
    for (const [table, event] of RAW_EVENT_TABLES) {
      const r = await this.client.query(
        `SELECT block_id::bigint AS h, count(*)::int AS n FROM ${this.schema}.${table}
         WHERE block_id BETWEEN $1 AND $2 GROUP BY 1`,
        [lo, hi]
      );
      for (const row of r.rows) {
        const h = Number(row.h);
        if (!out.has(h)) out.set(h, new Map());
        (out.get(h) as Map<string, number>).set(event, Number(row.n));
      }
    }
    return out;
  }
}

// The block against the raw tables: a raw table with more rows than the block has events stops the height; the
// events the raw table lacks come back as findings.
function crossCheck(height: number, events: RawEvent[], raw: Map<string, number>): Finding[] {
  const findings: Finding[] = [];
  for (const [table, event] of RAW_EVENT_TABLES) {
    const chain = events.filter((e) => e.type === event).length;
    const rows = raw.get(event) ?? 0;
    if (rows > chain) {
      throw new Error(
        `[history] the indexer's ${table} has ${rows} rows at height ${height}, the block has ${chain} ${event}: ` +
          "more than the chain emitted, so the block or its parse is wrong"
      );
    }
    if (chain > rows) findings.push({ type: event, chain, raw: rows });
  }
  return findings;
}

// A height read and classified: no money event, or its payload.
type Classified = ({ height: number; money: false; bytes: number } | ({ money: true } & Prepared)) & {
  mintless: boolean;
};

// What classifyHeight needs besides the job's options: the raw-table counts.
type ClassifyOptions = Pick<HistoryOptions, "chain" | "env" | "schema"> & {
  raw: RawCounts;
  log: (line: string) => void;
};

// Reads `height` and classifies it, as indexMoney would: the payload when the block has a money event.
async function classifyHeight(client: PgClient, o: ClassifyOptions, height: number): Promise<Classified> {
  // the era comes from the chain id and the height alone; below a chain's first known era there is none, which is
  // only a problem if the height turns out to have money
  let era: string | undefined;
  let eraError: unknown;
  try {
    era = settlementEra(o.chain.chainId, height, o.env ?? process.env);
  } catch (e) {
    eraError = e;
  }
  try {
    const t0 = performance.now();
    const { bytes, events } = await o.chain.events(height, era !== undefined && isMapEra(era));
    // every mainnet block measured carries the mint of its BeginBlock: a block without it is read on, but flagged as
    // the first sign of a truncated event list
    const mintless = !events.some((e) => e.type === "mint");
    if (mintless) {
      o.log(`[history] WARNING height=${height}: no mint event in finalize_block_events (truncated response?)`);
    }
    const findings = crossCheck(height, events, await o.raw.get(height));
    if (!events.some((e) => MONEY_EVENT_TYPES.has(e.type))) return { height, money: false, bytes, mintless };
    if (era === undefined) {
      const cause = eraError instanceof Error ? eraError.message : String(eraError);
      throw new Error(`height ${height} has money events and no settlement era: ${cause}`);
    }
    const p = await preparePayload(client, o, height, era, events);
    return { money: true, ...p, bytes, findings, mintless, fetchMs: performance.now() - t0 - p.parseMs };
  } catch (e) {
    // the era goes with the error into the stop line
    throw Object.assign(e instanceof Error ? e : new Error(String(e)), { era });
  }
}

// The payload of a money height, as indexMoney builds it.
async function preparePayload(
  client: PgClient,
  o: Pick<HistoryOptions, "chain" | "schema">,
  height: number,
  era: string,
  events: RawEvent[]
): Promise<Prepared> {
  const t1 = performance.now();
  const header = await o.chain.header(height);
  const replayed = REPLAY_ERAS.has(era);
  // the map eras' state, and in detailed_batch (where claims settled) the proposer's shares the replay computes R from
  const stateAt = async () =>
    mapStateFrom(
      await tokenomicsParamsAt(client, o.schema, height),
      era,
      header.proposer,
      era === "map_proposer_operator" || era.startsWith("map_all_bonded") ? await o.chain.validators(height) : undefined
    );
  let state = isMapEra(era) ? await stateAt() : undefined;
  const sink: PayloadSink = {};
  const payload = buildSettlementPayload(height, header.time, era, events, state, sink);
  if (!payload) throw new Error(`height ${height} has money events but no payload`);
  if (replayed && !state && payload.claims.length > 0) state = await stateAt();
  let snapshot: Prepared["snapshot"];
  let replay: Prepared["replay"];
  if (payload.era === "batched_vrd") {
    const stakers =
      payload.vrd.length > 0 ||
      payload.batch.some((b) => b.op_type === "mod_to_acct" && (b.role === "validator" || b.role === "delegator"));
    let validators = null;
    if (stakers) {
      const all = await o.chain.validators(height);
      const bonded = de2Validators(all, new Map())?.map((v) => v.operator) ?? [];
      validators = de2Validators(all, await o.chain.delegations(height, bonded));
    }
    addDelegatorValidator(height, payload, validators);
  } else if (replayed && payload.claims.length > 0) {
    // the bonded validators and every delegation of each, fully paginated: from the cache when a run already read
    // them (chain.ts), else from the LCD; the same snapshot as any earlier run recorded, or the height stops
    const all = await o.chain.validators(height);
    const bonded = de2Validators(all, new Map())?.map((v) => v.operator) ?? [];
    const delegations = await o.chain.delegations(height, bonded);
    snapshot = { bonded: bonded.length, delegations: [...delegations.values()].reduce((n, d) => n + d.length, 0) };
    await checkSnapshot(client, o.schema, height, snapshot);
    const t2 = performance.now();
    const modes = addReplay(height, payload, {
      validators: replayValidators(all, delegations),
      proposer: era === "map_proposer_operator" ? replayProposer(all, header.proposer) : undefined,
      mapStakers: sink.mapStakers,
      proposerShares: state && { relay: state.meb.proposer, global: state.mintAlloc.proposer },
    });
    replay = { modes, ms: performance.now() - t2 };
  }
  return {
    height,
    era,
    payload,
    bytes: 0,
    fetchMs: 0,
    parseMs: performance.now() - t1,
    findings: [],
    snapshot,
    replay,
  };
}

// A snapshot read again (the cache lost, or a rewrite) must be the one an earlier run recorded for the height.
async function checkSnapshot(
  client: PgClient,
  schema: string,
  height: number,
  snapshot: NonNullable<Prepared["snapshot"]>
): Promise<void> {
  const r = await client.query(
    `SELECT bonded, delegations FROM ${schema}.settlement_replay_snapshots WHERE height = $1`,
    [height]
  );
  const row = r.rows[0];
  if (row && (Number(row.bonded) !== snapshot.bonded || Number(row.delegations) !== snapshot.delegations)) {
    throw new Error(
      `[history] height ${height}: the validators read now (${snapshot.bonded} bonded, ${snapshot.delegations} ` +
        `delegations) differ from the snapshot recorded (${row.bonded}, ${row.delegations})`
    );
  }
}

// Eras whose heights read the LCD: validators (map state), delegations (DE2), or the replay snapshot (REPLAY_ERAS).
function needsLcd(era: string): boolean {
  return REPLAY_ERAS.has(era) || era === "batched_vrd";
}

// The lowest height in [bottom, top] whose era reads the LCD, or null: where the preflight asks. It goes by era, not
// by the heights the run will find: a range inside an LCD era asks for the LCD even if its heights turn out not to
// read it (a batched_vrd height with no staker rows), which costs one request and needs --lcd set.
function lcdPreflightHeight(o: HistoryOptions, bottom: number, top: number): number | null {
  const env = o.env ?? process.env;
  if (env.POCKETDEX_SETTLEMENT_ERA) return needsLcd(env.POCKETDEX_SETTLEMENT_ERA) ? bottom : null;
  const eras = SETTLEMENT_ERAS[o.chain.chainId] ?? [];
  for (let i = 0; i < eras.length; i++) {
    const end = i + 1 < eras.length ? eras[i + 1].from - 1 : Infinity;
    if (needsLcd(eras[i].era) && eras[i].from <= top && end >= bottom) return Math.max(bottom, eras[i].from);
  }
  return null;
}

// The tokenomics params in force at `height`: the version whose block range holds it, what Param.get returns to
// indexMoney once indexParams has run for the block.
async function tokenomicsParamsAt(
  client: PgClient,
  schema: string,
  height: number
): Promise<Record<typeof MAP_PARAM_KEYS[number], string>> {
  const ids = MAP_PARAM_KEYS.map((k) => getParamId("tokenomics", k));
  const r = await client.query(
    `SELECT id, value FROM ${schema}.params WHERE id = ANY($1) AND _block_range @> $2::bigint`,
    [ids, height]
  );
  const byId = new Map(r.rows.map((x) => [x.id as string, x.value as string]));
  const out = {} as Record<typeof MAP_PARAM_KEYS[number], string>;
  for (const k of MAP_PARAM_KEYS) {
    const v = byId.get(getParamId("tokenomics", k));
    if (v === undefined) throw new Error(`[history] tokenomics param ${k} has no version at height ${height}`);
    out[k] = v;
  }
  return out;
}

// The gap row this job owns (from_height = 1). Returns the highest height left to walk, and whether the row is still
// to be created (runHistory does it after the LCD preflight). The job walks only below money_progress.from_height,
// where coverage starts: [1, from_height - 1], never heights the indexer's money step processed. Only that row is the
// job's: another gap row (the heights a POCKETDEX_MONEY_FROM_HEIGHT override skipped) is not its territory, and the
// job does not fill it (reindexing those heights does). Without a money_progress row it stops: the indexer creates it.
export async function planGap(client: PgClient, o: HistoryOptions): Promise<{ top: number; create: boolean }> {
  const s = o.schema;
  const progress = await client.query(`SELECT from_height::bigint AS f FROM ${s}.money_progress`);
  if (progress.rows.length === 0) {
    throw new Error(
      `[history] ${s}.money_progress has no row: the indexer's money step creates it (or its start-up seeds it over ` +
        "written settlements); run the indexer first"
    );
  }
  const fromHeight = Number(progress.rows[0].f);
  const gaps = await client.query(
    `SELECT from_height::bigint AS f, to_height::bigint AS t FROM ${s}.settlement_gaps WHERE from_height = $1`,
    [GAP_FROM]
  );
  const list = gaps.rows.map((r) => `[${r.f}, ${r.t}]`).join(", ");
  if (gaps.rows.length === 1) {
    if (o.start !== undefined) throw new Error(`[history] the gap ${list} exists: resume without --start`);
    return { top: Number(gaps.rows[0].t), create: false };
  }
  const start = fromHeight - 1;
  if (o.start !== undefined && o.start !== start) {
    throw new Error(`[history] --start must be ${start}, one below money_progress.from_height`);
  }
  return { top: start, create: start >= GAP_FROM };
}

// Lowers the gap to below `height` (deleting it past height 1), inside the caller's transaction, and with it
// money_progress.from_height (the start of coverage: functions.ts _coverage) to `height`, 1 when it finishes. The gap
// must still hold `height`: if it does not, another run moved it.
async function lowerGap(client: PgClient, schema: string, height: number): Promise<void> {
  const gap = await client.query(
    `SELECT to_height::bigint AS t FROM ${schema}.settlement_gaps WHERE from_height = $1 FOR UPDATE`,
    [GAP_FROM]
  );
  if (gap.rows.length === 0 || Number(gap.rows[0].t) < height) {
    throw new Error(`[history] the gap from ${GAP_FROM} no longer holds height ${height}: another run moved it`);
  }
  if (height - 1 < GAP_FROM) {
    await client.query(`DELETE FROM ${schema}.settlement_gaps WHERE from_height = $1`, [GAP_FROM]);
  } else {
    await client.query(`UPDATE ${schema}.settlement_gaps SET to_height = $2 WHERE from_height = $1`, [
      GAP_FROM,
      height - 1,
    ]);
  }
  await client.query(`UPDATE ${schema}.money_progress SET from_height = least(from_height, $1::bigint)`, [
    height - 1 < GAP_FROM ? GAP_FROM : height,
  ]);
}

// The lock order of the indexer's money step: money_progress first, then the settlement writer. The indexer holds
// that row for its whole block transaction (the daily domain refresh alone takes ~15 s on mainnet), longer than the
// server's lock_timeout of 10 s, which stopped the job at 688173: the wait gets its own bound, whatever the session's,
// sent with the lock in one query, and the caller's transaction gets its own value back after it.
async function lockProgress(client: PgClient, schema: string): Promise<void> {
  const saved = (await client.query("SELECT current_setting('lock_timeout') AS v")).rows[0].v;
  await client.query(`SET LOCAL lock_timeout = '120s'; SELECT 1 FROM ${schema}.money_progress FOR UPDATE`);
  await client.query("SELECT set_config('lock_timeout', $1, true)", [saved]);
}

// One height, one transaction: the CALLs of write_settlement, then the gap lowered below the height (which also
// covers the heights with no money above it, already classified).
async function writeHeight(client: PgClient, o: HistoryOptions, p: Prepared): Promise<void> {
  await client.query("BEGIN");
  try {
    await lockProgress(client, o.schema);
    for (const { bind, sql } of writeSettlementCalls(o.schema, p.height, p.payload)) await client.query(sql, bind);
    // a rewrite replaces what an earlier run recorded for the height, so no row claims what this one did not find
    for (const t of ["settlement_history_findings", "settlement_replay_snapshots"]) {
      await client.query(`DELETE FROM ${o.schema}.${t} WHERE height = $1`, [p.height]);
    }
    for (const f of p.findings) {
      await client.query(
        `INSERT INTO ${o.schema}.settlement_history_findings (height, event_type, chain_count, raw_count)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (height, event_type) DO UPDATE
         SET chain_count = excluded.chain_count, raw_count = excluded.raw_count, found_at = now()`,
        [p.height, f.type, f.chain, f.raw]
      );
    }
    if (p.snapshot) {
      await client.query(
        `INSERT INTO ${o.schema}.settlement_replay_snapshots (height, era, bonded, delegations) VALUES ($1, $2, $3, $4)
         ON CONFLICT (height) DO UPDATE
         SET era = excluded.era, bonded = excluded.bonded, delegations = excluded.delegations, taken_at = now()`,
        [p.height, p.era, p.snapshot.bonded, p.snapshot.delegations]
      );
    }
    if (o.dryRun) {
      await client.query("ROLLBACK");
      return;
    }
    await lowerGap(client, o.schema, p.height);
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  }
}

// Writes a money height and returns its log line. Everything the line needs is computed before the commit: once the
// height is written, nothing may fail and report it as a stop.
async function writeLogged(client: PgClient, o: HistoryOptions, p: Prepared): Promise<string> {
  const rows = (["claims", "detailed", "batch", "vrd", "reimb", "expired", "discarded", "slashed", "dv"] as const)
    .map((k) => `${k}=${p.payload[k].length}`)
    .join(" ");
  const md5 = createHash("md5").update(JSON.stringify(p.payload)).digest("hex");
  const snapshot = p.snapshot ? ` snapshot=${p.snapshot.bonded}/${p.snapshot.delegations}` : "";
  const replay = p.replay
    ? ` replay=${
        [...p.replay.modes].map(([f, m]) => `${f}:${m.mode}`).join(",") || "none"
      } replay_ms=${p.replay.ms.toFixed(0)}`
    : "";
  const t0 = performance.now();
  await writeHeight(client, o, p);
  return (
    `[history] height=${p.height} era=${p.era} ${rows} bytes=${p.bytes} fetch_ms=${p.fetchMs.toFixed(0)} ` +
    `parse_ms=${p.parseMs.toFixed(0)} write_ms=${(performance.now() - t0).toFixed(0)}${snapshot}${replay} md5=${md5}`
  );
}

export async function runHistory(client: PgClient, o: HistoryOptions): Promise<HistoryResult> {
  if (!o.chain.chainId) throw new Error("[history] the chain reader is not opened (Chain.open)");
  const lock = await client.query("SELECT pg_try_advisory_lock(hashtext($1)) AS ok", [lockKey(o.schema)]);
  if (!lock.rows[0].ok) {
    throw new Error(`[history] another history job holds the lock for schema ${o.schema} (${lockKey(o.schema)})`);
  }
  let result: HistoryResult;
  try {
    result = await walk(client, o);
  } catch (e) {
    // the lock goes with the session anyway; an unlock that fails must not hide the run's own error
    await client.query("SELECT pg_advisory_unlock(hashtext($1))", [lockKey(o.schema)]).catch(() => undefined);
    throw e;
  }
  try {
    await client.query("SELECT pg_advisory_unlock(hashtext($1))", [lockKey(o.schema)]);
  } catch (e) {
    // the run is done and the lock goes with the session anyway: a failed unlock is reported, not a failed run
    (o.log ?? console.log)(
      `[history] WARNING: releasing the lock failed: ${e instanceof Error ? e.message : String(e)}`
    );
  }
  return result;
}

async function walk(client: PgClient, o: HistoryOptions): Promise<HistoryResult> {
  const log = o.log ?? ((line: string) => console.log(line));
  const result: HistoryResult = { written: [], noMoney: 0, discards: 0, findings: 0, mintless: 0, unattributed: {} };
  const { create, top } = await planGap(client, o);
  const bottom = Math.max(GAP_FROM, o.to ?? GAP_FROM);
  log(`[history] chain ${o.chain.chainId}; walking ${top} down to ${bottom}${o.dryRun ? " (dry run)" : ""}`);
  if (top < bottom) return result;
  const preflight = lcdPreflightHeight(o, bottom, top);
  if (preflight !== null) {
    await o.chain.preflightLcd(preflight);
    log(`[history] the LCD serves state at height ${preflight}`);
  }
  if (create && !o.dryRun) {
    await client.query(`INSERT INTO ${o.schema}.settlement_gaps (from_height, to_height) VALUES ($1, $2)`, [
      GAP_FROM,
      top,
    ]);
  }

  // Heights with no money classified since the gap was last lowered: the gap goes below the lowest of them (all
  // heights above it are classified, since heights are handled in order).
  const flushEvery = o.flushEvery ?? 2000;
  const flushMs = o.flushMs ?? 30_000;
  let pendingLow: number | null = null;
  let pendingCount = 0;
  let lastFlush = Date.now();
  const flush = async () => {
    if (pendingLow === null) return;
    const low = pendingLow;
    if (!o.dryRun) {
      await client.query("BEGIN");
      try {
        await lockProgress(client, o.schema);
        await lowerGap(client, o.schema, low);
        await client.query("COMMIT");
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      }
    }
    log(`[history] covered down to ${low} (${pendingCount} heights with no money event since the last lowering)`);
    pendingLow = null;
    pendingCount = 0;
    lastFlush = Date.now();
  };

  // Handled one at a time in descending order; while one is written, the next N are fetched and parsed (on the
  // reader connection), so download and write overlap even with one worker.
  let next = top;
  const raw = new RawCounts(o.reader, o.schema);
  const ahead: Array<{ height: number; classified: Promise<Classified> }> = [];
  const fill = () => {
    while (ahead.length < Math.max(1, o.workers ?? 1) && next >= bottom) {
      const classified = classifyHeight(o.reader, { ...o, raw, log }, next);
      classified.catch(() => undefined); // awaited in order below; a later height's failure waits its turn
      ahead.push({ height: next, classified });
      next--;
    }
  };
  const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
  // Every stop goes through here: the classified heights above the failing one still lower the gap, the log line,
  // and the prefetch awaited, so nothing outlives the run on the caller's connections.
  const stop = async (failed: NonNullable<HistoryResult["failed"]>) => {
    result.failed = failed;
    if (failed.stage === "height") {
      try {
        await flush();
      } catch (e) {
        log(`[history] could not lower the gap over the heights with no money above ${failed.height}: ${message(e)}`);
      }
      log(`[history] STOPPED at height=${failed.height} era=${failed.era ?? "?"}: ${failed.error}`);
    } else {
      log(
        `[history] STOPPED lowering the gap over the heights with no money down to ${failed.height}: ${failed.error}`
      );
    }
    await Promise.allSettled(ahead.map((a) => a.classified));
    return result;
  };
  fill();
  while (ahead.length > 0) {
    const { classified, height } = ahead.shift() as { height: number; classified: Promise<Classified> };
    fill();
    let line: string;
    let c: Classified | undefined;
    try {
      c = await classified;
      result.mintless += Number(c.mintless);
      if (!c.money) {
        result.noMoney++;
        pendingLow = height;
        pendingCount++;
        if (pendingCount >= flushEvery || Date.now() - lastFlush >= flushMs) {
          try {
            await flush();
          } catch (e) {
            // the height is classified; it is the gap that could not be lowered over it
            return stop({ stage: "gap", height, error: message(e) });
          }
        }
        continue;
      }
      line = await writeLogged(client, o, c);
      // the written height's transaction lowered the gap below it, over the heights with no money above too
      pendingLow = null;
      pendingCount = 0;
      lastFlush = Date.now();
    } catch (e) {
      const era = (c?.money ? c.era : undefined) ?? (e as { era?: string }).era;
      return stop({ stage: "height", height, era, error: message(e) });
    }
    log(line);
    for (const f of c.findings) {
      log(`[history] FINDING height=${height} type=${f.type} chain=${f.chain} raw=${f.raw}`);
    }
    result.written.push(height);
    result.discards += c.payload.discarded.length;
    result.findings += c.findings.length;
    countUnattributed(log, result, c);
  }
  try {
    await flush();
  } catch (e) {
    return stop({ stage: "gap", height: bottom, error: message(e) });
  }
  log(
    `[history] done: ${result.written.length} heights written, ${result.noMoney} with no money event, ` +
      `${result.discards} discards in the heights written, ${result.findings} findings, ` +
      `${result.mintless} blocks without a mint event, unattributed heights ${JSON.stringify(result.unattributed)}`
  );
  return result;
}

// A height whose replay left a family unattributed: a WARNING with the chain's reason, and one more for its era.
function countUnattributed(log: (line: string) => void, result: HistoryResult, p: Prepared): void {
  const left = [...(p.replay?.modes ?? [])].filter(([, m]) => m.mode === "unattributed");
  for (const [family, m] of left) {
    log(`[history] WARNING height=${p.height} ${family} unattributed (${m.amount} upokt): ${m.reason ?? ""}`);
  }
  if (left.length > 0) result.unattributed[p.era] = (result.unattributed[p.era] ?? 0) + 1;
}

// The environment the job labels eras with. POCKETDEX_SETTLEMENT_ERA labels every height with one era; it exists for
// localnet, which runs as chain id "pocket" like mainnet, so the chain id cannot tell them apart. It is honoured only
// when the operator says the target is a localnet AND the node agrees: chain id "pocket" and a tip below mainnet's
// first map era (247,893), which mainnet passed long ago. Anything else with the variable set is refused.
export function eraEnv(env: NodeJS.ProcessEnv, chain: Pick<Chain, "chainId" | "latestHeight">, localnet: boolean) {
  const override = env.POCKETDEX_SETTLEMENT_ERA;
  if (!override) {
    if (localnet) throw new Error("[history] --localnet without POCKETDEX_SETTLEMENT_ERA: nothing to override");
    return env;
  }
  if (!localnet) {
    throw new Error(
      `[history] POCKETDEX_SETTLEMENT_ERA=${override} is set: it would label every height with one era. ` +
        "Unset it, or pass --localnet when the target really is a localnet"
    );
  }
  if (chain.chainId !== "pocket" || chain.latestHeight >= 247893) {
    throw new Error(
      `[history] --localnet, but the node is chain ${chain.chainId} at height ${chain.latestHeight}: not a localnet`
    );
  }
  return env;
}
