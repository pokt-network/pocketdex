import { fromHex } from "@cosmjs/encoding";
import { CosmosBlock, CosmosEvent, CosmosEventKind } from "@subql/types-cosmos";
import { recordMoneyProgressCall, recordMoneySkipCall, writeSettlementCalls } from "../dbFunctions/settlement/writer";
import type { ValidatorSnapshot } from "../pocket/validator";
import { Param } from "../../types";
import { getDbSchema, getSequelize } from "../utils/db";
import { getParamId } from "../utils/ids";
import { positiveIntFromEnv } from "../utils/env";
import { firstEraFrom } from "../utils/params_history";
import { BANK_EVENT_TYPES, keepBankEvent } from "./bank";
import { addDelegatorValidator, De2Validator } from "./de2";
import { STAKING_EVENT_TYPES } from "./delegations";
import { isMapEra, MapState } from "./map";
import {
  ATTRIBUTE_EVENT_TYPES,
  buildSettlementPayload,
  MONEY_EVENT_TYPES,
  PayloadSink,
  RawEvent,
  SettlementPayload,
} from "./payload";
import { addReplay, REPLAY_ERAS } from "./replay";
import {
  de2Validators as de2ValidatorsFrom,
  MAP_PARAM_KEYS,
  mapStateFrom,
  replayProposer,
  replayValidators,
  settlementEra,
} from "./state";

let loggedEraOverride = false;

// settlementEraAt is settlementEra (./state.ts), with one warning when POCKETDEX_SETTLEMENT_ERA overrides it.
export function settlementEraAt(chainId: string, height: number, env: NodeJS.ProcessEnv = process.env): string {
  const era = settlementEra(chainId, height, env);
  if (env.POCKETDEX_SETTLEMENT_ERA && !loggedEraOverride) {
    logger.warn(`[indexMoney] POCKETDEX_SETTLEMENT_ERA=${era}: every height is labelled with this settlement era`);
    loggedEraOverride = true;
  }
  return era;
}

// moneyFromHeight is the first height the indexer writes settlement money for. By default it is the first height
// of the oldest era known for the chain (settlement_result from 1 on mainnet, map_all_bonded from 1 on
// beta), or 1 with POCKETDEX_SETTLEMENT_ERA set; POCKETDEX_MONEY_FROM_HEIGHT overrides it. An override below the
// chain's first known era, or into an era the parser does not read yet, stops every settlement block from there
// (eraAtHeight or the parser throws): on purpose, since writing those heights under the wrong checks would be
// wrong money. The override is also the documented way to stop a block that fails a money check: set it above
// the failing height and redeploy. The history job fills the skipped heights only when no settlement was written
// before them (docs/money-history-job.md).
export function moneyFromHeight(chainId: string, env: NodeJS.ProcessEnv = process.env): number {
  const override = moneyFromHeightOverride(env);
  if (override > 0) return override;
  return env.POCKETDEX_SETTLEMENT_ERA ? 1 : firstEraFrom(chainId);
}

// POCKETDEX_MONEY_FROM_HEIGHT, or 0 when it is not set.
function moneyFromHeightOverride(env: NodeJS.ProcessEnv): number {
  return positiveIntFromEnv("POCKETDEX_MONEY_FROM_HEIGHT", env.POCKETDEX_MONEY_FROM_HEIGHT, 0);
}

function attrToString(value: string | Uint8Array): string {
  return typeof value === "string" ? value : Buffer.from(value).toString("utf8");
}

function toRaw(e: CosmosEvent): RawEvent {
  return {
    type: e.event.type,
    attributes: e.event.attributes.map((a) => ({
      key: attrToString(a.key as string | Uint8Array),
      value: attrToString(a.value as string | Uint8Array),
    })),
  };
}

// The block's staking events (any event kind), the only ones stakingEventValidators reads. Filtered before
// converting: this runs on every block.
export function blockStakingEvents(block: CosmosBlock): RawEvent[] {
  return block.events.filter((e) => STAKING_EVENT_TYPES.has(e.event.type)).map(toRaw);
}

// The block's finalize-block events in chain order: the index into this list is the event_idx stored with
// every row. Only the events the parser reads (ATTRIBUTE_EVENT_TYPES) are converted, and in the map eras the bank
// events (coinbase, burn, transfer) the payload reads the slices from; the others keep their position with their
// type and no attributes, which buildSettlementPayload skips by type.
//
// Size: the map eras' settlement blocks are large: 77 MB to 636 MB of block_results from 382,250 and up to 1.45 GB
// from 636,543, with ~850k transfers at 699,993 (.local/ab/eras/REPORT.md §4). This converts every EndBlock bank
// event of such a block; whether the indexer receives and parses those blocks at all (node strings cap at ~512 MB;
// never simdjson lazyParse above 1 GB) is not addressed here, and is the open risk of indexing them live.
// a bank event with its attributes when segmentBank can use it, else only its type (keepBankEvent)
function bankRaw(e: CosmosEvent): RawEvent {
  const raw = toRaw(e);
  return keepBankEvent(raw) ? raw : { type: raw.type, attributes: [] };
}

export function finalizeBlockEvents(block: CosmosBlock, withBank = false): RawEvent[] {
  return block.events
    .filter((e) => e.kind === CosmosEventKind.FinalizeBlock)
    .map((e) =>
      ATTRIBUTE_EVENT_TYPES.has(e.event.type)
        ? toRaw(e)
        : withBank && BANK_EVENT_TYPES.has(e.event.type)
        ? bankRaw(e)
        : { type: e.event.type, attributes: [] }
    );
}

async function tokenomicsParam(key: string): Promise<string> {
  const p = await Param.get(getParamId("tokenomics", key));
  if (!p) throw new Error(`[money] tokenomics param ${key} is not indexed`);
  return p.value;
}

// The tokenomics params at the settlement height: indexParams runs before indexMoney, so the stored version is the
// one whose range holds this height, the value the chain's EndBlock used (tokenomics changes apply at their height;
// params_history.ts).
async function mapStateAt(
  block: CosmosBlock,
  era: string,
  validators: ValidatorSnapshot | undefined
): Promise<MapState> {
  const params = {} as Record<typeof MAP_PARAM_KEYS[number], string>;
  for (const key of MAP_PARAM_KEYS) params[key] = await tokenomicsParam(key);
  return mapStateFrom(params, era, proposerOf(block), validators?.chainValidators);
}

// The block proposer's consensus address.
function proposerOf(block: CosmosBlock): Uint8Array {
  const raw = block.header.proposerAddress as unknown as Uint8Array | string;
  return typeof raw === "string" ? fromHex(raw) : raw;
}

// Without the block transaction a write would autocommit, and a block that fails later would leave its
// settlement written. The transaction only exists with --enable-cache=false.
function blockTransaction() {
  const transaction = store.context.transaction;
  if (!transaction) {
    throw new Error("[money] no block transaction: the indexer must run with --enable-cache=false");
  }
  return transaction;
}

// Returns the number of CALLs and the bytes of JSON sent, for the settlement profile line of indexMoney.
export async function writeSettlement(
  height: number,
  payload: SettlementPayload
): Promise<{ calls: number; bytes: number }> {
  const transaction = blockTransaction();
  const calls = writeSettlementCalls(getDbSchema(), height, payload);
  let bytes = 0;
  for (const { bind, sql } of calls) {
    bytes += bind.reduce((n: number, b) => n + (typeof b === "string" ? Buffer.byteLength(b) : 0), 0);
    await getSequelize("Block").query(sql, { bind, transaction, useMaster: true, raw: true });
  }
  return { calls: calls.length, bytes };
}

// The money step's bookkeeping for every height it processes, before its money: with POCKETDEX_MONEY_FROM_HEIGHT, the
// heights the override skipped become a settlement_gaps row ([progress + 1, override - 1]: the first height past the
// override records it, written or not), and the progress moves to the height (money_progress), so the catalog
// functions cover what was processed and report the skipped heights as not covered instead of reading them as zero.
// A height the override skips pulls the progress back below it (a rewind). Inside the block transaction, so a block
// that rolls back cannot lose either; one statement (dbFunctions/settlement/writer.ts). This runs on EVERY block the money step processes, not only on settlement blocks,
// so the money step now needs the block transaction (--enable-cache=false) on every block: without it it throws, and
// the indexer stops instead of moving the progress outside the block's transaction.
async function recordMoneyProgress(height: number, skipped = false): Promise<void> {
  const s = getDbSchema();
  const { bind, sql } = skipped
    ? recordMoneySkipCall(s, height)
    : recordMoneyProgressCall(s, height, moneyFromHeightOverride(process.env));
  await getSequelize("Block").query(sql, { bind, transaction: blockTransaction(), useMaster: true, raw: true });
}

let loggedBelowThreshold = false;

// The bonded validators of the snapshot, in the shape the delegator × validator split takes.
export function de2Validators(snapshot: ValidatorSnapshot | undefined): De2Validator[] | null {
  if (!snapshot?.delegations) return null;
  return de2ValidatorsFrom(snapshot.chainValidators, snapshot.delegations);
}

export async function indexMoney(block: CosmosBlock, validators?: ValidatorSnapshot): Promise<void> {
  const height = block.header.height;
  const from = moneyFromHeight(block.header.chainId);
  if (height < from) {
    if (moneyFromHeightOverride(process.env) > 0) await recordMoneyProgress(height, true);
    if (!loggedBelowThreshold) {
      logger.info(`[indexMoney] settlement money is written from height ${from}; height ${height} is below it`);
      loggedBelowThreshold = true;
    }
    return;
  }
  await recordMoneyProgress(height);
  const t0 = performance.now();
  const era = settlementEraAt(block.header.chainId, height);
  const map = isMapEra(era);
  const replayed = REPLAY_ERAS.has(era);
  const events = finalizeBlockEvents(block, map);
  // the map eras' state, and in detailed_batch the proposer's shares the replay computes its total from
  const state =
    (map || replayed) && events.some((e) => MONEY_EVENT_TYPES.has(e.type))
      ? await mapStateAt(block, era, validators)
      : undefined;
  const sink: PayloadSink = {};
  const payload = buildSettlementPayload(
    height,
    new Date(block.header.time.toISOString()),
    era,
    events,
    map ? state : undefined,
    sink
  );
  if (!payload) return;
  const t1 = performance.now();
  // batched_vrd: the delegator × validator split, checked against EventValidatorRewardDistribution. 288,180–788,944:
  // the chain's own split replayed (replay.ts) over the delegations at the height. Before: no stakers split.
  if (payload.era === "batched_vrd") {
    addDelegatorValidator(height, payload, de2Validators(validators));
  } else if (replayed && payload.claims.length > 0) {
    if (!validators?.delegations) {
      throw new Error(`[indexMoney] height ${height}: ${era} needs the delegations at the height for the replay`);
    }
    addReplay(height, payload, {
      validators: replayValidators(validators.chainValidators, validators.delegations),
      proposer:
        era === "map_proposer_operator" ? replayProposer(validators.chainValidators, proposerOf(block)) : undefined,
      mapStakers: sink.mapStakers,
      proposerShares: state && { relay: state.meb.proposer, global: state.mintAlloc.proposer },
    });
  }
  const t2 = performance.now();
  const written = await writeSettlement(height, payload);
  const t3 = performance.now();
  // One line per settlement height: the payload's size and where indexMoney's time went, so the settlement
  // block's cost can be related to its claims (input for the settlement performance work).
  const rows = (["claims", "detailed", "batch", "vrd", "reimb", "expired", "discarded", "slashed", "dv"] as const)
    .map((k) => `${k}=${payload[k].length}`)
    .join(" ");
  logger.info(
    `[indexMoney] settlement height=${height} ${rows} json_kb=${Math.round(written.bytes / 1024)} calls=${
      written.calls
    } parse_ms=${(t1 - t0).toFixed(0)} de2_ms=${(t2 - t1).toFixed(0)} write_ms=${(t3 - t2).toFixed(0)}`
  );
}
