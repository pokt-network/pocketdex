// The x/bank events of a map-era settlement (poktroll v0.1.27–v0.1.32, mainnet 247,893–703,869), cut per claim.
// The map era's EventClaimSettled carries one total per recipient (reward_distribution) and no reasons; the bank
// events of the EndBlock carry every slice of every claim, in claim order. poktroll executes each claim's queued
// operations in turn: mints, module-to-module transfers, module-to-account transfers, burns
// (x/tokenomics/keeper/settle_pending_claims.go:208-240 at v0.1.27), so per claim the EndBlock has, in order:
//   coinbase M (relay mint), coinbase G (global mint), the module → account transfers, burn S (the settlement).
// The burns of supplier slashes come after the last claim's burn, one before each EventSupplierSlashed (or before the
// EventSupplierUnbondingBegin that precedes it when the slash takes the stake below the minimum).
// Measured on mainnet 250053, 260013, 270033, 300033, 350013, 430053 and 699993: 14,846/14,846 claims
// (.local/ab/eras/bank_segmentation.py, map_positional.py).
import { sha256 } from "@cosmjs/crypto";
import { toBech32 } from "@cosmjs/encoding";
import { PREFIX } from "../constants";
import type { RawEvent } from "./payload";

// A module account's address is the first 20 bytes of sha256(module name) (cosmos-sdk x/auth
// NewModuleAddress = address.Module(name) = crypto.AddressHash(name)).
export function moduleAddress(name: string): string {
  return toBech32(PREFIX, sha256(new TextEncoder().encode(name)).slice(0, 20));
}

export const TOKENOMICS_MODULE = moduleAddress("tokenomics");
export const SUPPLIER_MODULE = moduleAddress("supplier");
export const APPLICATION_MODULE = moduleAddress("application");
const MODULES: ReadonlySet<string> = new Set([TOKENOMICS_MODULE, SUPPLIER_MODULE, APPLICATION_MODULE]);

// The bank event types bankItems reads; buildSettlementPayload needs their attributes in the map eras only.
export const BANK_EVENT_TYPES: ReadonlySet<string> = new Set(["coinbase", "burn", "transfer"]);

export interface Leg {
  sender: string;
  recipient: string;
  amount: bigint;
}

interface BankItem {
  idx: number;
  kind: string;
  leg?: Leg;
  amount: bigint;
}

export interface ClaimBank {
  // coinbase M and G, burn S, and the module → account legs in chain order
  relayMint: bigint;
  globalMint: bigint;
  burn: bigint;
  legs: Leg[];
}

// A zero mint or burn prints an empty amount: sdk.NewCoins drops zero coins and the bank keeper emits the event with
// the empty Coins' text (cosmos-sdk v0.53.0 types/coin.go:194-206, x/bank/keeper/keeper.go:343-380).
const AMOUNT = /^(?:(\d+)upokt)?$/;

function attrs(e: RawEvent): Map<string, string> {
  return new Map(e.attributes.map((a) => [a.key, a.value]));
}

// keepBankEvent says whether segmentBank can use an event: the EndBlock coinbase and burn events, and the EndBlock
// transfers sent by one of the three module accounts. finalizeBlockEvents drops the attributes of the others, so a
// map-era block keeps ~1 of its ~3 bank events per leg (coin_spent and coin_received are never kept).
export function keepBankEvent(e: RawEvent): boolean {
  if (!BANK_EVENT_TYPES.has(e.type)) return false;
  const a = attrs(e);
  return a.get("mode") === "EndBlock" && (e.type !== "transfer" || MODULES.has(a.get("sender") ?? ""));
}

// The EndBlock coinbase and burn events, and the module → account transfers of a non-zero amount (poktroll skips
// zero slices: tlm_relay_burn_equals_mint.go:175-252 IsZero checks), in chain order.
function bankItems(height: number, events: ReadonlyArray<RawEvent>): BankItem[] {
  const items: BankItem[] = [];
  events.forEach((e, idx) => {
    if (!BANK_EVENT_TYPES.has(e.type)) return;
    const a = attrs(e);
    if (a.get("mode") !== "EndBlock") return;
    const fail = (msg: string) => new Error(`[money] height ${height} event ${idx} (${e.type}): ${msg}`);
    const raw = a.get("amount");
    if (raw === undefined) throw fail("has no amount attribute");
    const m = AMOUNT.exec(raw);
    if (!m) throw fail(`amount is not an upokt amount: ${JSON.stringify(a.get("amount"))}`);
    const amount = BigInt(m[1] ?? 0);
    if (e.type !== "transfer") {
      items.push({ idx, kind: e.type, amount });
      return;
    }
    const sender = a.get("sender") ?? "";
    const recipient = a.get("recipient") ?? "";
    if (!MODULES.has(sender) || MODULES.has(recipient) || amount === BigInt(0)) return;
    items.push({ idx, kind: "transfer", amount, leg: { sender, recipient, amount } });
  });
  return items;
}

// A slash burn is followed by its EventSupplierSlashed, with the supplier's EventSupplierUnbondingBegin in between when
// the slash takes its stake below the minimum (poktroll x/tokenomics/keeper/settle_pending_claims.go emits both
// events after the burn, unbonding first; beta 133,593).
function isSlashBurn(events: ReadonlyArray<RawEvent>, idx: number): boolean {
  let next = idx + 1;
  if (events[next]?.type === "pocket.supplier.EventSupplierUnbondingBegin") next++;
  return events[next]?.type === "pocket.tokenomics.EventSupplierSlashed";
}

// segmentBank cuts the EndBlock bank events into one ClaimBank per claim, in claim order: for claim k, two
// coinbases, then the transfers whose per-recipient sums equal its reward_distribution (`maps[k]`, non-zero entries),
// then one burn. The settlement is one run inside the tokenomics end blocker, from the first claim's coinbase to its
// last burn, and nothing else interleaves with it. Other end blockers' bank events may come before or after it: a
// supplier or application unbonding returning stake (sent by the supplier or application module), a gov deposit
// burn. Those are skipped; a transfer sent by the tokenomics module outside the run stops the height, since only the
// settlement pays from it. Each slash burn comes right before its EventSupplierSlashed (measured on 270033, 300033,
// 350013, 430053) or before the EventSupplierUnbondingBegin that precedes it (isSlashBurn), and there must be one per
// slash. No sample has an unbonding return or a gov burn in a settlement block, so the skipping is reasoned from the
// end blocker order, not measured.
export function segmentBank(
  height: number,
  events: ReadonlyArray<RawEvent>,
  maps: ReadonlyArray<ReadonlyMap<string, bigint>>,
  slashes: number
): ClaimBank[] {
  const items = bankItems(height, events);
  const outside = (it: BankItem) => {
    if (it.leg?.sender === TOKENOMICS_MODULE) {
      throw new Error(`[money] height ${height}: tokenomics transfer (event ${it.idx}) outside the settlement run`);
    }
  };
  let i = 0;
  if (maps.length > 0) {
    while (i < items.length && items[i].kind !== "coinbase") outside(items[i++]);
  }
  const fail = (k: number, msg: string) => new Error(`[money] height ${height}: bank events of claim ${k}: ${msg}`);
  const take = (k: number, kind: string): bigint => {
    const it = items[i];
    if (it?.kind !== kind) {
      throw fail(k, `expected ${kind} at bank item ${i}, found ${it ? `${it.kind} (event ${it.idx})` : "the end"}`);
    }
    i++;
    return it.amount;
  };
  const out = maps.map((need, k) => {
    const relayMint = take(k, "coinbase");
    const globalMint = take(k, "coinbase");
    const got = new Map<string, bigint>();
    const legs: Leg[] = [];
    // recipients whose sum already equals their entry: the claim is matched when all are
    let matched = 0;
    while (matched < need.size) {
      const it = items[i];
      if (it?.kind !== "transfer" || !it.leg) throw fail(k, `the transfers end before reward_distribution is matched`);
      const sum = (got.get(it.leg.recipient) ?? BigInt(0)) + it.amount;
      if (sum > (need.get(it.leg.recipient) ?? BigInt(0))) {
        throw fail(k, `transfer to ${it.leg.recipient} (event ${it.idx}) exceeds its reward_distribution entry`);
      }
      got.set(it.leg.recipient, sum);
      if (sum === need.get(it.leg.recipient)) matched++;
      legs.push(it.leg);
      i++;
    }
    const burn = take(k, "burn");
    return { relayMint, globalMint, burn, legs };
  });
  let slashBurns = 0;
  for (const it of items.slice(i)) {
    outside(it);
    if (it.kind === "burn" && isSlashBurn(events, it.idx)) slashBurns++;
  }
  if (slashBurns !== slashes) {
    throw new Error(`[money] height ${height}: ${slashBurns} slash burns after the last claim, expected ${slashes}`);
  }
  return out;
}
