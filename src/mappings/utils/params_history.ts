// What a stored param means over time, and the per-block reconcile that writes
// it. Shared by the indexer (pocket/params.ts, pocket/relays.ts, genesis) and
// the offline history patch. PURE: no SubQuery globals, so it can be imported
// by a plain node script and tested with a fake transport and store.
//
// A Param version holds the RAW chain value (utils/params_normalize.ts) and two
// heights:
//   _block_range lower bound = changed_at: the first height whose state holds
//                              the value (what Query/Params returns there);
//   active_at                = the first height the chain USES the value.
// A MsgUpdateParam(s) at H on shared or session is recorded in that module's
// params history at the start of the next session (x/shared/keeper/
// msg_server_update_param.go, x/session/keeper/params.go RecordParamsHistory),
// and the consumers that read the history use it from there:
//   - session, since v0.1.31: the session hydrator reads the session params at
//     height (x/session/keeper/session_hydrator.go, #1882).
//   - shared non-timing params, since v0.1.35: claim pricing pins them at the
//     session start (poktroll a109dd0ba "session-start param pins"). Before,
//     settlement read the LIVE value, so it was used at H: measured on settled
//     claims (.local/ab/params_patch/check_cuttm_RESULT.md), e.g. the
//     compute_units_to_tokens_multiplier set at 642,497 priced every claim
//     settled at 642,513. That is measured for the multiplier only; for the
//     unbonding periods and compute_unit_cost_granularity the v0.1.35 gate is
//     NOT verified against their consumers (the only change of those in
//     v0.1.31..v0.1.35 was promoted with the timing change at 831,001, where
//     active_at is the change height either way).
//   - shared session-timing params change LIVE only when the EndBlocker promotes
//     a history entry, so they are used from their change height.
// Readers interpret raw values in SQL (e.g. session_grid_anchor_height 0 means
// the genesis grid, anchor 1).
import {
  AbciQuery,
  compactKey,
  ModuleParams,
  PARAM_MODULES,
  paramFieldNames,
  readAllModuleParams,
  readSharedParamsAtHeight,
} from "./params_normalize";

// Heights where the params semantics change, per chain id (the block header's
// chain_id, which is what reconcileParams gets). The store has no upgrade data,
// so they are constants, and a chain id with no entry stops the indexer at its
// first block rather than write active_at from a guess. localnet also runs as
// chain id "pocket"; it starts on a later version, so below these heights it
// only loses the next-session active_at and the strict mint_ratio check.
export interface ChainUpgradeHeights {
  // first height whose state holds tokenomics.mint_ratio (PIP-41); before it
  // the state reads 0 and the chain minted 1:1.
  mintRatioFrom: number;
  // first height running the session params history (poktroll v0.1.31 code).
  sessionHistoryFrom: number;
  // first height where claim pricing pins shared params at the session start
  // (poktroll v0.1.35).
  sharedPinsFrom: number;
}

export const CHAIN_UPGRADE_HEIGHTS: Record<string, ChainUpgradeHeights | undefined> = {
  // mainnet: AppliedPlan v0.1.31 = 635,506 (mint_ratio 0 → 1 there, measured by
  // the params history rebuild), v0.1.34 = 788,945 and v0.1.35 = 883,667.
  pocket: { mintRatioFrom: 635506, sessionHistoryFrom: 635506, sharedPinsFrom: 883667 },
  // beta (sauron-rpc.beta.infra.pocket.network), measured 2026-09-30 and
  // 2026-10-03. AppliedPlan v0.1.31-beta-2 = 16,570, v0.1.33 = 153,479,
  // v0.1.34 = 348,821, v0.1.35 = 553,663. The v0.1.31-beta-2 handler sets
  // mint_ratio to 1 where it is 0 (absent from genesis to 16,569) and starts the
  // session and shared params history at its height. The session params never
  // changed on beta (50 at every sampled height, no session MsgUpdateParam(s)
  // tx), so no row depends on sessionHistoryFrom.
  "pocket-lego-testnet": {
    mintRatioFrom: 16570, sessionHistoryFrom: 16570, sharedPinsFrom: 553663,
  },
  // TODO: chain id of the old beta network; no RPC known for it. Indexing it
  // throws until it is filled in.
  "pocket-beta": undefined,
};

export function chainUpgradeHeights(chainId: string): ChainUpgradeHeights {
  const heights = CHAIN_UPGRADE_HEIGHTS[chainId];
  if (!heights) {
    throw new Error(
      `no upgrade heights for chain "${chainId}": add its mintRatioFrom, sessionHistoryFrom and sharedPinsFrom ` +
        '(abci_query /cosmos.upgrade.v1beta1.Query/AppliedPlan {name: "v0.1.31"} / {name: "v0.1.35"}, and the first ' +
        "height with a non-zero tokenomics mint_ratio) to CHAIN_UPGRADE_HEIGHTS in src/mappings/utils/params_history.ts"
    );
  }
  return heights;
}

// The settlement event format a height's settlements are emitted in, per chain id: an ordered list of the
// first height of each era. The money parser and writer read the era to know which events and checks
// apply. Mainnet boundaries are from the era survey (.local/ab/eras/REPORT.md §0, sampled block_results):
//   settlement_result         v0.1.26 and earlier: per-claim settlement_result with a reason per leg
//   map_proposer_consensus    v0.1.27: reward_distribution map, proposer paid at its consensus address
//   map_no_stakers            proposer allocation 0 (params at 263,093)
//   map_proposer_operator     v0.1.28: proposer paid at its operator account (params at 288,180)
//   map_all_bonded            v0.1.29: stakers = every bonded validator, mint 1:1
//   map_all_bonded_deflation  v0.1.31: mint_ratio 0.975 (params at 636,543)
//   detailed_batch            v0.1.33: reward_distribution_detailed and EventSettlementBatch, no validator distribution
//   batched_vrd               v0.1.34: EventValidatorRewardDistribution
// Beta started on the map format with every bonded validator as staker (its first settlement is at 3,333) and
// minted 1:1 until mint_ratio 0.975 (MsgUpdateParams at 19,672); it never applied v0.1.27–v0.1.30 or v0.1.32
// (.local/ab/eras/beta: block_results and params at 3,333–153,453).
export interface SettlementEraStart {
  from: number;
  era: string;
}

export const SETTLEMENT_ERAS: Record<string, ReadonlyArray<SettlementEraStart> | undefined> = {
  pocket: [
    { from: 1, era: "settlement_result" },
    { from: 247893, era: "map_proposer_consensus" },
    { from: 263093, era: "map_no_stakers" },
    { from: 288180, era: "map_proposer_operator" },
    { from: 382250, era: "map_all_bonded" },
    { from: 636543, era: "map_all_bonded_deflation" },
    { from: 703870, era: "detailed_batch" },
    { from: 788945, era: "batched_vrd" },
  ],
  "pocket-lego-testnet": [
    { from: 1, era: "map_all_bonded" },
    { from: 19672, era: "map_all_bonded_deflation" },
    { from: 153479, era: "detailed_batch" },
    { from: 348821, era: "batched_vrd" },
  ],
};

function settlementEras(chainId: string): ReadonlyArray<SettlementEraStart> {
  const eras = SETTLEMENT_ERAS[chainId];
  if (!eras) throw new Error(`unknown settlement era: no era table for chain "${chainId}" in SETTLEMENT_ERAS`);
  return eras;
}

// eraAtHeight is the settlement era of `height` on `chainId`; it throws below the first known era.
export function eraAtHeight(chainId: string, height: number): string {
  let era: string | undefined;
  for (const e of settlementEras(chainId)) {
    if (e.from > height) break;
    era = e.era;
  }
  if (era === undefined) throw new Error(`unknown settlement era at height ${height} on chain "${chainId}"`);
  return era;
}

// firstEraFrom is the first height of the oldest era known on `chainId`.
export function firstEraFrom(chainId: string): number {
  return settlementEras(chainId)[0].from;
}

// Shared params whose live value only changes when the EndBlocker promotes a
// history entry at a session start (poktroll sessionTimingParamsChanged, plus
// the grid-anchor fields derived there). Their changed_at is already the height
// the chain uses them from.
const SHARED_PROMOTED_PARAMS = new Set([
  "num_blocks_per_session",
  "grace_period_end_offset_blocks",
  "claim_window_open_offset_blocks",
  "claim_window_close_offset_blocks",
  "proof_window_open_offset_blocks",
  "proof_window_close_offset_blocks",
  "session_grid_anchor_height",
  "session_number_at_anchor",
]);

// sessionStartHeight mirrors poktroll GetSessionStartHeight (x/shared/types/
// session.go), with sessionGridAnchor's fallback: an anchor that is unset (0) or
// after `height` means the genesis grid, anchor 1.
function sessionStartHeight(shared: Record<string, string>, height: number): number {
  const numBlocksPerSession = Number(shared.num_blocks_per_session);
  if (!Number.isSafeInteger(numBlocksPerSession) || numBlocksPerSession <= 0) {
    throw new Error(`invalid shared num_blocks_per_session "${shared.num_blocks_per_session}" at height ${height}`);
  }
  let anchor = Number(shared.session_grid_anchor_height);
  if (!(anchor > 0) || anchor > height) anchor = 1;
  return anchor + Math.floor((height - anchor) / numBlocksPerSession) * numBlocksPerSession;
}

// nextSessionStartHeight mirrors poktroll GetSessionEndHeight(params, height)+1.
export function nextSessionStartHeight(shared: Record<string, string>, height: number): number {
  return sessionStartHeight(shared, height) + Number(shared.num_blocks_per_session);
}

export interface ParamWrite {
  id: string;
  namespace: string;
  key: string;
  value: string;
  activeAt: number;
}

export interface ParamsPlan {
  upserts: Array<ParamWrite>;
  // ids of keys the schema no longer has, to close.
  removes: Array<string>;
}

const asRecord = (read: ModuleParams | undefined) =>
  read ? Object.fromEntries(read.params.map((p) => [p.key, p.value])) : undefined;

const changedParams = (read: ModuleParams, stored: Map<string, string>) =>
  read.params.filter((p) => stored.get(`${read.namespace}-${p.key}`) !== p.value);

// sharedHistoryNeeded says whether planParamsWrites needs the shared params
// history entry effective at `height` (Query/ParamsAtHeight at `height`) to
// place a change. That is when a non-timing shared key changes at a session
// start, from v0.1.35: it is either a transaction at that height (used from the
// next session start) or a promoted history entry (used from `height`), and the
// live state alone cannot tell them apart. The EndBlocker's promotion rewrites
// the whole live params, so an entry promoted without any timing change (a
// transaction sent in the previous promotion block, whose live write that
// promotion overwrote) looks exactly like a transaction.
export function sharedHistoryNeeded(
  height: number,
  chainId: string,
  reads: Array<ModuleParams>,
  stored: Map<string, string>
): boolean {
  const shared = reads.find((r) => r.namespace === "shared");
  if (!shared || height < chainUpgradeHeights(chainId).sharedPinsFrom) return false;
  const nonTiming = changedParams(shared, stored).filter(
    (p) => !SHARED_PROMOTED_PARAMS.has(p.key) && stored.has(`shared-${p.key}`)
  );
  return nonTiming.length > 0 && sessionStartHeight(asRecord(shared) as Record<string, string>, height) === height;
}

// planParamsWrites compares the params read at `height` with the currently
// stored value of each id and returns the versions to write: only keys whose
// value changed, each with its active_at. `sharedHistory` is the shared params
// history entry effective at `height`, required when sharedHistoryNeeded.
//
// It refuses a table this code did not write: an id in a namespace it does not
// know, or a legacy spelling of a known key (camelCase, digit-split
// `sig_verify_cost_secp_256_k_1`) left by the MsgUpdateParam decoder. Writing
// canonical rows next to those would leave both open forever, so the history
// patch has to run first. A stored key the schema no longer has (a field a
// newer release dropped) is closed instead, for the modules in `reads`.
export function planParamsWrites(
  height: number,
  chainId: string,
  reads: Array<ModuleParams>,
  stored: Map<string, string>,
  sharedHistory?: Record<string, string>
): ParamsPlan {
  const upgrades = chainUpgradeHeights(chainId);
  const readNamespaces = new Set(reads.map((r) => r.namespace));
  const removes: Array<string> = [];
  for (const id of stored.keys()) {
    const dash = id.indexOf("-");
    const namespace = id.slice(0, dash);
    const key = id.slice(dash + 1);
    if (dash <= 0 || !(namespace in PARAM_MODULES)) {
      throw new Error(
        `params table holds id "${id}" in no known module: run the params history patch before this release`
      );
    }
    const fields = paramFieldNames(namespace);
    if (fields.includes(key)) continue;
    if (fields.some((f) => compactKey(f) === compactKey(key))) {
      throw new Error(`params table holds legacy id "${id}": run the params history patch before this release`);
    }
    if (readNamespaces.has(namespace)) removes.push(id);
  }

  const sharedNow = asRecord(reads.find((r) => r.namespace === "shared"));
  const nextSessionStart = () => {
    if (!sharedNow) throw new Error(`shared params are needed to place a shared/session change at height ${height}`);
    return nextSessionStartHeight(sharedNow, height);
  };
  const historyNeeded = sharedHistoryNeeded(height, chainId, reads, stored);
  if (historyNeeded && !sharedHistory) {
    throw new Error(`the shared params history at height ${height} is needed to place a shared change there`);
  }

  const activeAt = (namespace: string, key: string, value: string, id: string): number => {
    // First version of a key (genesis, a module or field added by an upgrade):
    // used as soon as set.
    if (!stored.has(id)) return height;
    if (namespace === "session") return height < upgrades.sessionHistoryFrom ? height : nextSessionStart();
    if (namespace !== "shared" || SHARED_PROMOTED_PARAMS.has(key) || height < upgrades.sharedPinsFrom) return height;
    // A promoted entry already carries the value at `height`.
    if (historyNeeded && sharedHistory?.[key] === value) return height;
    return nextSessionStart();
  };

  const upserts: Array<ParamWrite> = [];
  for (const read of reads) {
    for (const { key, value } of changedParams(read, stored)) {
      const id = `${read.namespace}-${key}`;
      upserts.push({ id, namespace: read.namespace, key, value, activeAt: activeAt(read.namespace, key, value, id) });
    }
  }
  return { upserts, removes };
}

// The Param table as reconcileParamsAt needs it; pocket/params.ts implements it
// over the SubQuery store.
export interface ParamsStore {
  // id → value of every currently open version.
  current(): Promise<Map<string, string>>;
  save(rows: Array<ParamWrite>): Promise<void>;
  remove(ids: Array<string>): Promise<void>;
}

// reconcileParamsAt writes the params of every module as the chain holds them
// at `height`. A row is only ever written from a verified read at that height:
// any failed read throws (after the transport's retries) and fails the block,
// which SubQuery retries. Skipping a read instead would record a change at a
// later height, permanently.
export async function reconcileParamsAt(
  height: number,
  chainId: string,
  query: AbciQuery,
  paramsStore: ParamsStore
): Promise<void> {
  chainUpgradeHeights(chainId);
  const [reads, stored] = await Promise.all([readAllModuleParams(query, height), paramsStore.current()]);
  const sharedHistory = sharedHistoryNeeded(height, chainId, reads, stored)
    ? await readSharedParamsAtHeight(query, height)
    : undefined;
  const { removes, upserts } = planParamsWrites(height, chainId, reads, stored, sharedHistory);
  if (upserts.length > 0) await paramsStore.save(upserts);
  if (removes.length > 0) await paramsStore.remove(removes);
}

// effectiveMintRatio is the tokenomics mint_ratio a settlement at `height`
// uses, from the stored raw value. The field did not exist before v0.1.31
// (PIP-41), where the state reads as the proto default 0 and the chain minted
// 1:1; from v0.1.31 on the chain enforces 0 < mint_ratio <= 1, so anything
// else is a decoding bug and throws instead of settling at a guess.
export function effectiveMintRatio(raw: string | undefined, height: number, chainId: string): number {
  const { mintRatioFrom } = chainUpgradeHeights(chainId);
  const value = raw === undefined ? NaN : Number(raw);
  if (value > 0 && value <= 1) return value;
  if ((raw === undefined || value === 0) && height < mintRatioFrom) return 1;
  throw new Error(
    `tokenomics mint_ratio "${raw}" is not usable at height ${height} on chain "${chainId}" ` +
      `(mint_ratio exists from ${mintRatioFrom}; the chain requires 0 < mint_ratio <= 1, and 0 or absent only means 1 before it)`
  );
}
