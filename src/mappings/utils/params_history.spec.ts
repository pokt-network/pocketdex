// Unit tests for the params reconcile and its history semantics. Pure: run with
//   yarn test:unit
// The golden fixtures (real mainnet ABCI responses and REST reads) are described
// in fixtures/golden.ts.
/* eslint-disable @typescript-eslint/no-floating-promises, @typescript-eslint/require-await */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BinaryWriter } from "@bufbuild/protobuf/wire";
import genesisMainnet from "./fixtures/genesis_params_mainnet.json";
import {
  CURRENT,
  FixtureChain,
  fixtureQuery,
  fixtures,
  HEIGHTS,
  MAINNET,
  restState,
  sharedAt,
  sharedResponse,
} from "./fixtures/golden";
import {
  effectiveMintRatio,
  nextSessionStartHeight,
  ParamsStore,
  ParamWrite,
  planParamsWrites,
  reconcileParamsAt,
} from "./params_history";
import {
  extractParamsBytes,
  GenesisParamsSource,
  normalizeGenesisParams,
  PARAM_NAMESPACES,
  readAllModuleParams,
} from "./params_normalize";
import { abciTimeoutFromEnv, queryAbci } from "./query_client";

class FakeStore implements ParamsStore {
  saved: Array<ParamWrite> = [];
  removed: Array<string> = [];
  constructor(private readonly rows: Map<string, string>) {}
  async current() {
    return new Map(this.rows);
  }
  async save(rows: Array<ParamWrite>) {
    this.saved.push(...rows);
  }
  async remove(ids: Array<string>) {
    this.removed.push(...ids);
  }
}

const withStored = (height: number, changes: Record<string, string | null>) =>
  new FakeStore(restState(height, changes));

describe("golden ABCI fixtures", () => {
  for (const height of HEIGHTS) {
    it(`decodes all 17 modules at ${height} exactly as the chain REST returns them`, async () => {
      const reads = await readAllModuleParams(fixtureQuery(height), height);
      assert.equal(reads.length, 17);
      const decoded = new Map(reads.flatMap((r) => r.params.map((p) => [`${r.namespace}-${p.key}`, p.value] as const)));
      assert.deepEqual(decoded, restState(height));
    });
  }
});

describe("genesis params", () => {
  for (const height of HEIGHTS) {
    it(`normalize like the chain state: the REST JSON at ${height} as a genesis gives 0 writes against its ABCI read`, async () => {
      const genesis: GenesisParamsSource = { app_state: {}, consensus_params: fixtures[height].consensus.json };
      for (const ns of PARAM_NAMESPACES) genesis.app_state[ns] = { params: fixtures[height][ns].json };
      const { missing, modules } = normalizeGenesisParams(genesis);
      assert.deepEqual(missing, []);
      const stored = new Map(
        modules.flatMap((m) => m.params.map((p) => [`${m.namespace}-${p.key}`, p.value] as const))
      );
      const reads = await readAllModuleParams(fixtureQuery(height), height);
      assert.deepEqual(planParamsWrites(height, MAINNET, reads, stored), { removes: [], upserts: [] });
    });
  }

  it("decodes the real mainnet genesis strictly, consensus params as the chain holds them", () => {
    const { missing, modules } = normalizeGenesisParams(genesisMainnet as unknown as GenesisParamsSource);
    assert.deepEqual(missing, []);
    assert.equal(modules.length, 17);
    const consensus = modules.find((m) => m.namespace === "consensus");
    assert.deepEqual(
      Object.fromEntries(consensus?.params.map((p) => [p.key, p.value]) ?? []),
      fixtures[HEIGHTS[0]].consensus.rest
    );
  });

  it("reads the consensus params of a cosmos-sdk AppGenesis (consensus.params), like the published genesis files", () => {
    const { consensus_params: params, ...rest } = genesisMainnet;
    const appGenesis = { ...rest, consensus: { params } } as unknown as GenesisParamsSource;
    const fromGenesisDoc = normalizeGenesisParams(genesisMainnet as unknown as GenesisParamsSource);
    const fromAppGenesis = normalizeGenesisParams(appGenesis);
    assert.deepEqual(fromAppGenesis.missing, []);
    assert.deepEqual(fromAppGenesis.modules, fromGenesisDoc.modules);
  });

  it("fills an omitted consensus version/abci with zeros, as CometBFT does, and lists missing modules", () => {
    const consensusParams = { ...genesisMainnet.consensus_params } as Record<string, unknown>;
    delete consensusParams.version;
    delete consensusParams.abci;
    const { missing, modules } = normalizeGenesisParams({
      app_state: { auth: genesisMainnet.app_state.auth },
      consensus_params: consensusParams,
    });
    assert.deepEqual(
      missing,
      PARAM_NAMESPACES.filter((ns) => ns !== "auth" && ns !== "consensus")
    );
    const consensus = Object.fromEntries(
      modules.find((m) => m.namespace === "consensus")?.params.map((p) => [p.key, p.value]) ?? []
    );
    assert.equal(consensus.version, '{"app":"0"}');
    assert.equal(consensus.abci, '{"vote_extensions_enable_height":"0"}');
  });
});

describe("reconcileParamsAt", () => {
  it("writes nothing when every value is unchanged", async () => {
    const store = withStored(CURRENT, {});
    await reconcileParamsAt(CURRENT, MAINNET, fixtureQuery(CURRENT), store);
    assert.deepEqual(store.saved, []);
    assert.deepEqual(store.removed, []);
  });

  it("writes one version for one changed value", async () => {
    const store = withStored(CURRENT, { "staking-max_validators": "21" });
    await reconcileParamsAt(CURRENT, MAINNET, fixtureQuery(CURRENT), store);
    assert.deepEqual(store.saved, [
      { id: "staking-max_validators", namespace: "staking", key: "max_validators", value: "22", activeAt: CURRENT },
    ]);
  });

  it("throws and writes nothing when a read still fails after the transport's retries", async () => {
    const store = withStored(CURRENT, { "staking-max_validators": "21" });
    const query = fixtureQuery(CURRENT, {
      override: {
        bank: () => {
          throw new Error("abci query failed (attempt 3 of 3): 429");
        },
      },
    });
    await assert.rejects(reconcileParamsAt(CURRENT, MAINNET, query, store), /attempt 3 of 3/);
    assert.deepEqual(store.saved, []);
  });

  it("throws on a response without the params field", async () => {
    const query = fixtureQuery(CURRENT, {
      override: { tokenomics: () => ({ value: new Uint8Array(), height: CURRENT }) },
    });
    await assert.rejects(
      reconcileParamsAt(CURRENT, MAINNET, query, withStored(CURRENT, {})),
      /tokenomics .*no params field/
    );
  });

  it("throws on a response for another height", async () => {
    const query = fixtureQuery(CURRENT, { override: { shared: (value) => ({ value, height: CURRENT - 1 }) } });
    await assert.rejects(
      reconcileParamsAt(CURRENT, MAINNET, query, withStored(CURRENT, {})),
      /asked for height .* answered for/
    );
  });

  it("throws on a field the schema does not know, saying a release must ship first", async () => {
    const query = fixtureQuery(CURRENT, {
      override: {
        tokenomics: (value) => {
          const params = extractParamsBytes("tokenomics", value);
          const extended = new BinaryWriter()
            .raw(params)
            .uint32((11 << 3) | 0)
            .uint64(7)
            .finish();
          return { value: new BinaryWriter().uint32(10).bytes(extended).finish(), height: CURRENT };
        },
      },
    });
    const store = withStored(CURRENT, {});
    await assert.rejects(
      reconcileParamsAt(CURRENT, MAINNET, query, store),
      /tokenomics params at height \d+ carry fields pocketdex does not know \(#11\).*ships before each chain release and is validated on beta first/
    );
    assert.deepEqual(store.saved, []);
  });

  it("refuses a table with legacy ids (history patch not applied)", async () => {
    for (const legacy of ["auth-sig_verify_cost_secp_256_k_1", "tokenomics-mintAllocationPercentages", "foo-bar"]) {
      const store = withStored(CURRENT, { [legacy]: "1" });
      await assert.rejects(
        reconcileParamsAt(CURRENT, MAINNET, fixtureQuery(CURRENT), store),
        /run the params history patch/
      );
      assert.deepEqual(store.saved, []);
    }
  });

  it("closes a stored key the schema no longer has", async () => {
    const store = withStored(CURRENT, { "tokenomics-retired_param": "1" });
    await reconcileParamsAt(CURRENT, MAINNET, fixtureQuery(CURRENT), store);
    assert.deepEqual(store.removed, ["tokenomics-retired_param"]);
    assert.deepEqual(store.saved, []);
  });

  it("writes every key with active_at = height on an empty table", async () => {
    const store = new FakeStore(new Map());
    await reconcileParamsAt(CURRENT, MAINNET, fixtureQuery(CURRENT), store);
    assert.equal(store.saved.length, restState(CURRENT).size);
    assert.ok(store.saved.every((w) => w.activeAt === CURRENT));
  });

  it("refuses a chain with no upgrade heights, naming them", async () => {
    for (const chainId of ["pocket-beta", "somewhere-else"]) {
      const store = withStored(CURRENT, { "staking-max_validators": "21" });
      await assert.rejects(
        reconcileParamsAt(CURRENT, chainId, fixtureQuery(CURRENT), store),
        new RegExp(
          `no upgrade heights for chain "${chainId}": add its mintRatioFrom, sessionHistoryFrom and sharedPinsFrom`
        )
      );
      assert.deepEqual(store.saved, []);
    }
  });
});

describe("active_at", () => {
  // Shared at CURRENT: 20 blocks per session on the grid anchored at 831,001.
  const nextStart = 831001 + (Math.floor((CURRENT - 831001) / 20) + 1) * 20;

  // active_at per written id, with the shared read at `height` replaced by `shared`
  // (stored with the same values, so only `changes` differ).
  const activeAtOf = async (
    height: number,
    changes: Record<string, string>,
    shared?: Record<string, string>,
    chain: FixtureChain = {}
  ) => {
    const stored = restState(height, changes);
    if (shared) {
      for (const [key, value] of Object.entries(shared)) {
        if (!(`shared-${key}` in changes)) stored.set(`shared-${key}`, value);
      }
      chain.override = { shared: () => ({ value: sharedResponse(shared), height }) };
    }
    const store = new FakeStore(stored);
    await reconcileParamsAt(height, MAINNET, fixtureQuery(height, chain), store);
    return Object.fromEntries(store.saved.map((w) => [w.id, w.activeAt]));
  };

  it("is the next session start for a shared change that is not session timing, from v0.1.35", async () => {
    const queried: Array<string> = [];
    assert.deepEqual(
      await activeAtOf(CURRENT, { "shared-compute_units_to_tokens_multiplier": "1" }, undefined, { queried }),
      {
        "shared-compute_units_to_tokens_multiplier": nextStart,
      }
    );
    assert.ok(!queried.includes("/pocket.shared.Query/ParamsAtHeight"));
  });

  it("is the change height for a shared non-timing change before v0.1.35", async () => {
    // 831,001: after v0.1.34, before v0.1.35 (883,667); 635,505: before v0.1.31.
    for (const height of [635505, 831001]) {
      assert.deepEqual(await activeAtOf(height, { "shared-compute_units_to_tokens_multiplier": "1" }), {
        "shared-compute_units_to_tokens_multiplier": height,
      });
    }
  });

  it("is the next session start for a session module change from v0.1.31, the change height before", async () => {
    const at831001 = 831001 + 20; // 831,001 starts a 20-block session on its own anchor
    assert.deepEqual(await activeAtOf(831001, { "session-num_suppliers_per_session": "25" }), {
      "session-num_suppliers_per_session": at831001,
    });
    assert.deepEqual(await activeAtOf(CURRENT, { "session-num_suppliers_per_session": "25" }), {
      "session-num_suppliers_per_session": nextStart,
    });
    assert.deepEqual(await activeAtOf(635505, { "session-num_suppliers_per_session": "25" }), {
      "session-num_suppliers_per_session": 635505,
    });
  });

  it("is the change height for a session-timing change, and for anything promoted with it", async () => {
    // 831,001 is the promotion of num_blocks_per_session 60 → 20 (MsgUpdateParams at 830,991),
    // which carried unbonding periods along.
    assert.deepEqual(
      await activeAtOf(831001, {
        "shared-num_blocks_per_session": "60",
        "shared-session_grid_anchor_height": "0",
        "shared-session_number_at_anchor": "0",
        "shared-supplier_unbonding_period_sessions": "504",
      }),
      {
        "shared-num_blocks_per_session": 831001,
        "shared-supplier_unbonding_period_sessions": 831001,
        "shared-session_grid_anchor_height": 831001,
        "shared-session_number_at_anchor": 831001,
      }
    );
  });

  it("uses the genesis grid for a live anchor of 0 after v0.1.35", async () => {
    // 7 blocks per session from block 1 (the anchored grid would give a different start).
    const shared = sharedAt(CURRENT, {
      num_blocks_per_session: "7",
      session_grid_anchor_height: "0",
      session_number_at_anchor: "0",
    });
    const expected = 1 + (Math.floor((CURRENT - 1) / 7) + 1) * 7;
    assert.deepEqual(await activeAtOf(CURRENT, { "shared-compute_units_to_tokens_multiplier": "1" }, shared), {
      "shared-compute_units_to_tokens_multiplier": expected,
    });
  });

  it("uses the genesis grid for an anchor after the height", async () => {
    const shared = sharedAt(CURRENT, {
      num_blocks_per_session: "7",
      session_grid_anchor_height: String(CURRENT + 100),
    });
    const expected = 1 + (Math.floor((CURRENT - 1) / 7) + 1) * 7;
    assert.deepEqual(await activeAtOf(CURRENT, { "shared-compute_units_to_tokens_multiplier": "1" }, shared), {
      "shared-compute_units_to_tokens_multiplier": expected,
    });
  });

  it("asks the chain's history about a non-timing change at a session start: promoted entry or transaction", async () => {
    // CURRENT starts a session on a grid anchored at CURRENT.
    const shared = sharedAt(CURRENT, { session_grid_anchor_height: String(CURRENT) });
    const changes = { "shared-compute_units_to_tokens_multiplier": "1" };
    const live = shared.compute_units_to_tokens_multiplier;

    // The history entry effective here carries the value: a promotion (e.g. a change sent in the previous
    // promotion block, whose live write that promotion overwrote), used from this height.
    const promoted: Array<string> = [];
    assert.deepEqual(await activeAtOf(CURRENT, changes, shared, { paramsAtHeight: shared, queried: promoted }), {
      "shared-compute_units_to_tokens_multiplier": CURRENT,
    });
    assert.ok(promoted.includes("/pocket.shared.Query/ParamsAtHeight"));

    // It does not: a transaction in this block, recorded at the next start of the epoch now in force.
    const history = { ...shared, compute_units_to_tokens_multiplier: "1" };
    assert.notEqual(history.compute_units_to_tokens_multiplier, live);
    assert.deepEqual(await activeAtOf(CURRENT, changes, shared, { paramsAtHeight: history }), {
      "shared-compute_units_to_tokens_multiplier": CURRENT + 20,
    });
  });

  it("uses each chain's own heights (beta pins shared params from 553,663)", async () => {
    const reads = await readAllModuleParams(fixtureQuery(CURRENT), CURRENT);
    const stored = restState(CURRENT, { "shared-compute_units_to_tokens_multiplier": "1" });
    const at = (height: number) => planParamsWrites(height, "pocket-lego-testnet", reads, stored).upserts[0].activeAt;
    assert.equal(at(553662), 553662);
    // anchor 831,001 is after 553,663, so the genesis grid: 553,661 starts a 20-block session.
    assert.equal(at(553663), 553681);
  });

  it("is the change height for every other module", async () => {
    assert.deepEqual(await activeAtOf(CURRENT, { "tokenomics-mint_ratio": "1" }), { "tokenomics-mint_ratio": CURRENT });
  });
});

describe("nextSessionStartHeight", () => {
  it("uses the genesis grid when the anchor is unset or after the height", () => {
    // 60 blocks per session from block 1: 830,941 starts a session, 831,001 the next.
    assert.equal(
      nextSessionStartHeight({ num_blocks_per_session: "60", session_grid_anchor_height: "0" }, 830991),
      831001
    );
    assert.equal(
      nextSessionStartHeight({ num_blocks_per_session: "60", session_grid_anchor_height: "900000" }, 830991),
      831001
    );
    assert.equal(nextSessionStartHeight({ num_blocks_per_session: "4", session_grid_anchor_height: "0" }, 4), 5);
    assert.equal(nextSessionStartHeight({ num_blocks_per_session: "4", session_grid_anchor_height: "0" }, 5), 9);
  });

  it("counts from the anchor when it is set", () => {
    assert.equal(
      nextSessionStartHeight({ num_blocks_per_session: "20", session_grid_anchor_height: "831001" }, 831001),
      831021
    );
    assert.equal(
      nextSessionStartHeight({ num_blocks_per_session: "20", session_grid_anchor_height: "831001" }, 831020),
      831021
    );
  });

  it("throws on a non-positive session length", () => {
    assert.throws(() => nextSessionStartHeight({ num_blocks_per_session: "0" }, 10), /num_blocks_per_session/);
  });
});

describe("effectiveMintRatio", () => {
  it("reads 0 or absent as 1 only before v0.1.31", () => {
    assert.equal(effectiveMintRatio("0", 635505, MAINNET), 1);
    assert.equal(effectiveMintRatio(undefined, 635505, MAINNET), 1);
    assert.throws(() => effectiveMintRatio("0", 635506, MAINNET), /mint_ratio exists from 635506/);
    assert.throws(() => effectiveMintRatio(undefined, 635506, MAINNET), /not usable/);
  });

  it("throws on a value outside (0, 1], at any height", () => {
    for (const raw of ["NaN", "abc", "-0.5", "1.0001", "2"]) {
      assert.throws(() => effectiveMintRatio(raw, 635505, MAINNET), /not usable/);
      assert.throws(() => effectiveMintRatio(raw, 900000, MAINNET), /not usable/);
    }
  });

  it("uses each chain's own mint_ratio height (beta: 16,570)", () => {
    assert.equal(effectiveMintRatio("0", 16569, "pocket-lego-testnet"), 1);
    assert.throws(() => effectiveMintRatio("0", 16570, "pocket-lego-testnet"), /mint_ratio exists from 16570/);
    assert.throws(() => effectiveMintRatio("0", 16569, "pocket-x"), /no upgrade heights/);
  });

  it("returns a valid value as is, and refuses a chain with no upgrade heights", () => {
    assert.equal(effectiveMintRatio("0.975", 900000, MAINNET), 0.975);
    assert.equal(effectiveMintRatio("1", 900000, MAINNET), 1);
    assert.throws(() => effectiveMintRatio("0.975", 10, "pocket-beta"), /no upgrade heights for chain "pocket-beta"/);
  });
});

describe("queryAbci transport", () => {
  it("retries a failure and returns the first success", async () => {
    let calls = 0;
    const base = {
      queryAbci: () => {
        if (++calls < 3) return Promise.reject(new Error("429"));
        return Promise.resolve({ value: new Uint8Array([1]), height: 7 });
      },
    };
    assert.deepEqual(await queryAbci(base, "/p", new Uint8Array(), 7), { value: new Uint8Array([1]), height: 7 });
    assert.equal(calls, 3);
  });

  it("throws after 3 attempts, keeping the original error as cause", async () => {
    let calls = 0;
    const original = new Error("socket hang up");
    const base = {
      queryAbci: (): Promise<{ value: Uint8Array; height: number }> => {
        calls++;
        return Promise.reject(original);
      },
    };
    await assert.rejects(queryAbci(base, "/p", new Uint8Array(), 7), (error: Error & { cause?: unknown }) => {
      assert.match(error.message, /abci query \/p at height 7 failed \(attempt 3 of 3\): socket hang up/);
      assert.equal(error.cause, original);
      return true;
    });
    assert.equal(calls, 3);
  });

  it("fails fast, without retrying, on an error code from the node", async () => {
    let calls = 0;
    const base = {
      queryAbci: (): Promise<{ value: Uint8Array; height: number }> => {
        calls++;
        return Promise.reject(new Error("Query failed with (6): unknown query path"));
      },
    };
    await assert.rejects(queryAbci(base, "/p", new Uint8Array(), 5), /failed \(node error\): Query failed with \(6\)/);
    assert.equal(calls, 1);
  });

  it("retries a node that has not reached the height yet (load-balanced RPC lag)", async () => {
    let calls = 0;
    const base = {
      queryAbci: () => {
        if (++calls < 2) {
          return Promise.reject(new Error("Query failed with (18): cannot query with height in the future; please provide a valid height: invalid request"));
        }
        return Promise.resolve({ value: new Uint8Array([1]), height: 5 });
      },
    };
    assert.deepEqual(await queryAbci(base, "/p", new Uint8Array(), 5), { value: new Uint8Array([1]), height: 5 });
    assert.equal(calls, 2);
  });

  it("defaults the timeout to 120 s, overridable, and refuses a bad value", () => {
    assert.equal(abciTimeoutFromEnv(undefined), 120_000);
    // the entrypoints pass an unset variable as POCKETDEX_ABCI_TIMEOUT_MS= (empty)
    assert.equal(abciTimeoutFromEnv(""), 120_000);
    assert.equal(abciTimeoutFromEnv("  "), 120_000);
    assert.equal(abciTimeoutFromEnv("30000"), 30_000);
    for (const bad of ["0", "-1", "1.5", "abc"]) {
      assert.throws(() => abciTimeoutFromEnv(bad), /POCKETDEX_ABCI_TIMEOUT_MS/);
    }
  });

  it("times out a node that never answers, and frees its slot", async () => {
    let calls = 0;
    const never = {
      queryAbci: (): Promise<{ value: Uint8Array; height: number }> => {
        calls++;
        return new Promise(() => undefined);
      },
    };
    // More hung queries than slots: all of them must still time out.
    const hung = Array.from({ length: 10 }, () => queryAbci(never, "/p", new Uint8Array(), 1, 30));
    await Promise.all(hung.map((query) => assert.rejects(query, /timed out after 30 ms/)));
    assert.equal(calls, 30);
  });

  it("sleeps the backoff outside its slot", async () => {
    const order: Array<string> = [];
    const failedOnce = new Set<number>();
    let next = 0;
    const flaky = {
      queryAbci: (path: string) => {
        if (path === "/fail") {
          const id = next++;
          if (!failedOnce.has(id % 6)) {
            failedOnce.add(id % 6);
            return Promise.reject(new Error("429"));
          }
        }
        return Promise.resolve({ value: new Uint8Array(), height: 1 });
      },
    };
    // 6 queries (every slot) fail once and back off (≥ 125 ms) while a 7th arrives: it must not wait for them.
    const failing = Array.from({ length: 6 }, () =>
      queryAbci(flaky, "/fail", new Uint8Array(), 1).then(() => order.push("fail"))
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    await queryAbci(flaky, "/ok", new Uint8Array(), 1).then(() => order.push("ok"));
    await Promise.all(failing);
    assert.equal(order[0], "ok");
  });

  it("keeps at most 6 queries in flight", async () => {
    let inFlight = 0;
    let peak = 0;
    const base = {
      queryAbci: async () => {
        peak = Math.max(peak, ++inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight--;
        return { value: new Uint8Array(), height: 1 };
      },
    };
    await Promise.all(Array.from({ length: 40 }, () => queryAbci(base, "/p", new Uint8Array(), 1)));
    assert.equal(peak, 6);
  });
});
