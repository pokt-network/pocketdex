import { createHash } from "crypto";

// The session rosters (src/mappings/dbFunctions/sessionRosters.ts): which suppliers the chain selects for each session,
// computed as poktroll's session hydrator does it (x/session/keeper/session_hydrator.go, main 6831f2cc4):
//   - session id bytes = block hash of the session start . service id . application address . start height as
//     8 bytes little endian ("." joins them), and the session id = hex(sha3_256(those bytes)) (GetSessionId);
//   - with fewer candidates than num_suppliers_per_session every candidate is a member; otherwise each candidate gets
//     the weight int64(big endian(sha3_256(session id bytes . operator address)[:8])), signed, and the members are the
//     num_suppliers_per_session lowest, ties by operator address (generateSupplierRandomWeight,
//     sortCandidateSupplierConfigsBySupplierWeight).
// It reproduces the chain from poktroll v0.1.33 on: before it the sort compared weightA - weightB, which overflows, so the
// order differed (mainnet 703,870; the claims of 102 sessions before it fall outside these rosters).
export const SESSION_ROSTERS_FROM_HEIGHT: Record<string, number> = {
  // mainnet: v0.1.33 upgrade height
  pocket: 703870,
  // beta: v0.1.33 is its earliest applied upgrade (pocketscribe docs/decisions/ADR-018-no-hardcoded-upgrades.md)
  "pocket-lego-testnet": 153479,
};

// any other chain (localnet) from its first block
export function sessionRostersFromHeight(chainId: string): number {
  return SESSION_ROSTERS_FROM_HEIGHT[chainId] ?? 1;
}

export function sessionIdBytes(blockHashHex: string, serviceId: string, applicationId: string, start: number): Buffer {
  const height = Buffer.alloc(8);
  height.writeBigUInt64LE(BigInt(start));
  const dot = Buffer.from(".");
  return Buffer.concat([
    Buffer.from(blockHashHex, "hex"),
    dot,
    Buffer.from(serviceId),
    dot,
    Buffer.from(applicationId),
    dot,
    height,
  ]);
}

export function sessionIdOf(idBytes: Buffer): string {
  return createHash("sha3-256").update(idBytes).digest("hex");
}

// The members among the candidates (distinct operator addresses), in the chain's order when it sorts them.
export function selectMembers(idBytes: Buffer, candidates: string[], numSuppliers: number): string[] {
  if (candidates.length < numSuppliers) return candidates.slice();
  const prefix = Buffer.concat([idBytes, Buffer.from(".")]);
  const weighted = candidates.map((c) => ({
    c,
    w: createHash("sha3-256").update(prefix).update(c).digest().readBigInt64BE(0),
  }));
  weighted.sort((a, b) => (a.w < b.w ? -1 : a.w > b.w ? 1 : Buffer.compare(Buffer.from(a.c), Buffer.from(b.c))));
  return weighted.slice(0, numSuppliers).map((x) => x.c);
}

// What _session_roster_inputs returns for a session start.
export interface SessionRosterInputs {
  block_hash: string;
  num_suppliers: number;
  end_height: string | number;
  grace_end_height: string | number;
  claim_open_height: string | number;
  claim_close_height: string | number;
  proof_open_height: string | number;
  settlement_height: string | number;
  start_time: Date | string;
  pairs: [string, string][];
  candidates: Record<string, string[]>;
}

// The payload _write_session_rosters takes: every session of the start, with its members; with onlyIds, those sessions
// only (the sessions of claims with no roster: a pair whose computed id is not the claim's is not written; late, so
// their gateways are read at the session end, where the application exists).
export function buildSessionRosters(
  start: number,
  inputs: SessionRosterInputs,
  onlyIds?: string[]
): Record<string, unknown> {
  // a service with no candidate has no session (the chain answers ErrSessionSuppliersNotFound)
  const sessions = inputs.pairs
    .filter(([, svc]) => (inputs.candidates[svc] ?? []).length > 0)
    .map(([app, svc]) => {
      const bz = sessionIdBytes(inputs.block_hash, svc, app, start);
      const candidates = inputs.candidates[svc] ?? [];
      return {
        id: sessionIdOf(bz),
        app,
        svc,
        candidates: candidates.length,
        members: selectMembers(bz, candidates, inputs.num_suppliers),
      };
    });
  const keep = onlyIds ? new Set(onlyIds) : undefined;
  return {
    start,
    end: Number(inputs.end_height),
    grace_end: Number(inputs.grace_end_height),
    claim_open: Number(inputs.claim_open_height),
    claim_close: Number(inputs.claim_close_height),
    proof_open: Number(inputs.proof_open_height),
    settlement: Number(inputs.settlement_height),
    time: inputs.start_time instanceof Date ? inputs.start_time.toISOString() : inputs.start_time,
    late: Boolean(onlyIds),
    sessions: keep ? sessions.filter((x) => keep.has(x.id)) : sessions,
  };
}

// Writes the sessions of the claims created in blocks from..to that have no roster (_claims_without_roster: an
// application staked during the session, which the chain validated with the state of the claim's block), with the
// suppliers of their start. Used by handleAddBlockReports (one block), the backfill and the spec, through their own
// query function. Returns the sessions written and the claimed session ids it could not reproduce (not written).
export async function writeClaimsWithoutRoster(
  query: (sql: string, params: unknown[]) => Promise<Array<Record<string, unknown>>>,
  schema: string,
  from: number,
  to: number,
  minStart: number
): Promise<{ written: number; unmatched: string[] }> {
  let written = 0;
  const unmatched: string[] = [];
  const missing = await query(`SELECT * FROM ${schema}._claims_without_roster($1::bigint, $2::bigint, $3::bigint)`, [
    from,
    to,
    minStart,
  ]);
  for (const m of missing) {
    const start = Number(m.start_height);
    const ids = m.session_ids as string[];
    const [at] = await query(`SELECT * FROM ${schema}._session_roster_inputs($1::bigint, $2::jsonb)`, [
      start,
      JSON.stringify(m.pairs),
    ]);
    const payload = at?.is_start ? buildSessionRosters(start, at as unknown as SessionRosterInputs, ids) : undefined;
    const got = new Set(((payload?.sessions as Array<{ id: string }>) ?? []).map((x) => x.id));
    unmatched.push(...ids.filter((id) => !got.has(id)));
    if (!payload || got.size === 0) continue;
    await query(`SELECT ${schema}._write_session_rosters($1::jsonb)`, [JSON.stringify(payload)]);
    written += got.size;
  }
  return { written, unmatched };
}

// The last session start the roster step wrote, per schema: the blocks after it and before its next start are no start,
// and the step reads no inputs for them. The session timing params take effect only at the next start of the current
// grid (since v0.1.31, before every roster height: poktroll x/shared/keeper/msg_server_update_param.go:154-185), so
// start + num_blocks_per_session is the next start. The start itself is always read again (a block retried after its
// transaction rolled back).
const lastStart = new Map<string, { start: number; next: number }>();

// The roster step of a block, in the block transaction after the money step (handleAddBlockReports; the spec runs it
// as the indexer does): at a session start, its sessions with their members, and the coverage (session_roster_progress)
// moves to it; at a block with claims (hasClaims: a MsgCreateClaim, maybe inside an authz MsgExec), the sessions of its
// claims that have no roster (writeClaimsWithoutRoster); at every block, the final states of the sessions it settles.
// Returns the seats whose state changed and the claims' session ids whose roster could not be reproduced.
export async function sessionRosterStep(
  query: (sql: string, params: unknown[]) => Promise<Array<Record<string, unknown>>>,
  schema: string,
  height: number,
  minStart: number,
  hasClaims: boolean
): Promise<{ changed: number; unmatched: string[] }> {
  const g = lastStart.get(schema);
  if (!g || height <= g.start || height >= g.next) {
    const [inputs] = await query(`SELECT * FROM ${schema}._session_roster_inputs($1::bigint)`, [height]);
    if (inputs?.is_start) {
      await query(`SELECT ${schema}._write_session_rosters($1::jsonb)`, [
        JSON.stringify(buildSessionRosters(height, inputs as unknown as SessionRosterInputs)),
      ]);
      await query(`SELECT ${schema}._session_roster_progress($1::bigint)`, [height]);
      lastStart.set(schema, { start: height, next: height + Number(inputs.blocks_per_session) });
    }
  }
  const unmatched = hasClaims
    ? (await writeClaimsWithoutRoster(query, schema, height, height, minStart)).unmatched
    : [];
  const [f] = await query(`SELECT ${schema}.finalize_session_rosters($1::bigint) n`, [height]);
  return { changed: Number(f.n), unmatched };
}
