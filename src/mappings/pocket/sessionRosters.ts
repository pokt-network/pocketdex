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
  settlement_height: string | number;
  start_time: Date | string;
  pairs: [string, string][];
  candidates: Record<string, string[]>;
}

// The payload _write_session_rosters takes: every session of the start, with its members; with onlyIds, those sessions
// only (the sessions of claims with no roster: a pair whose computed id is not the claim's is not written).
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
    settlement: Number(inputs.settlement_height),
    time: inputs.start_time instanceof Date ? inputs.start_time.toISOString() : inputs.start_time,
    sessions: keep ? sessions.filter((x) => keep.has(x.id)) : sessions,
  };
}
