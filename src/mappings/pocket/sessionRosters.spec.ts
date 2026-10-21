// Unit tests for the session roster selection (sessionRosters.ts). Run with
//   yarn test:unit
/* eslint-disable @typescript-eslint/no-floating-promises */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildSessionRosters,
  selectMembers,
  sessionIdBytes,
  sessionIdOf,
  sessionRostersFromHeight,
} from "./sessionRosters";

// mainnet session bera 974,561-974,580 of application pokt1plxq...: its block hash (blocks.hash at 974,561) and the
// session_id the chain's get_session answered (2026-10-21)
const HASH = "8B9E27ADDB53FD245C5EC658C0CCE884FFE30D37C13142DA3766E86035A78C53";
const APP = "pokt1plxqkv8wacr3f003ldxwrhw7fvaz7axpppza7l";

describe("session rosters", () => {
  it("computes the chain's session id", () => {
    assert.equal(
      sessionIdOf(sessionIdBytes(HASH, "bera", APP, 974561)),
      "a6813dd39cbc8aa2b61f22ad724ad3f6d0963fe75c473ecf5eeb894551fb9683"
    );
  });

  it("selects the candidates with the lowest signed weights", () => {
    // expected from .local/consumers/session-funnel/recompute.py, the implementation checked against get_session
    const candidates = Array.from({ length: 10 }, (_, i) => `pokt1cand${String(i).padStart(2, "0")}`);
    const bz = sessionIdBytes(HASH, "bera", APP, 974561);
    assert.deepEqual(selectMembers(bz, candidates, 3), ["pokt1cand08", "pokt1cand09", "pokt1cand01"]);
    // the order of the candidates does not matter
    assert.deepEqual(selectMembers(bz, candidates.slice().reverse(), 3), ["pokt1cand08", "pokt1cand09", "pokt1cand01"]);
  });

  it("takes every candidate when there are fewer than the roster size", () => {
    const bz = sessionIdBytes(HASH, "bera", APP, 974561);
    assert.deepEqual(selectMembers(bz, ["b", "a"], 3), ["b", "a"]);
  });

  it("builds every session of a start, and none for a service without candidates", () => {
    const p = buildSessionRosters(974561, {
      block_hash: HASH,
      num_suppliers: 2,
      end_height: "974580",
      settlement_height: "974613",
      start_time: new Date("2026-10-21T15:00:00Z"),
      pairs: [
        [APP, "bera"],
        [APP, "eth"],
      ],
      candidates: { bera: ["pokt1cand00", "pokt1cand01", "pokt1cand02"] },
    });
    assert.equal(p.end, 974580);
    assert.equal(p.settlement, 974613);
    assert.equal(p.time, "2026-10-21T15:00:00.000Z");
    const sessions = p.sessions as Array<{ id: string; svc: string; candidates: number; members: string[] }>;
    assert.deepEqual(
      sessions.map((x) => [x.svc, x.candidates, x.members.length]),
      [["bera", 3, 2]]
    );
    assert.equal(sessions[0].id, "a6813dd39cbc8aa2b61f22ad724ad3f6d0963fe75c473ecf5eeb894551fb9683");
  });

  it("starts at v0.1.33 on mainnet and beta, at the first block elsewhere", () => {
    assert.equal(sessionRostersFromHeight("pocket"), 703870);
    assert.equal(sessionRostersFromHeight("pocket-lego-testnet"), 153479);
    assert.equal(sessionRostersFromHeight("pocket-localnet"), 1);
  });
});
