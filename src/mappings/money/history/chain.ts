// What the history job reads from the chain for one settlement height: the finalize-block events (archive RPC
// /block_results), the header (/header: time, proposer) and the validators and delegations at the height (LCD with
// x-cosmos-block-height, the same ABCI state the indexer's reconcileValidators reads). Every response must say it
// is for the height asked: a node that answers for another height would write another block's money under this one.
// Responses can be kept on disk, so a rerun after a stop does not download a height twice.
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import * as zlib from "node:zlib";
import { fromHex } from "@cosmjs/encoding";
import {
  BondStatus,
  bondStatusFromJSON,
  Validator as ChainValidator,
} from "../../../client/cosmos/staking/v1beta1/staking";
import { BANK_EVENT_TYPES, keepBankEvent } from "../bank";
import type { DelegationShares } from "../delegations";
import { ATTRIBUTE_EVENT_TYPES, MONEY_EVENT_TYPES, RawEvent } from "../payload";

const gunzip = promisify(zlib.gunzip);
const gzip = promisify(zlib.gzip);

// The fork in vendor/simdjson (memory project_parse_speedup): findChunkBoundaries returns [start, end) byte ranges
// of the elements of the array at keyPath, grouped into chunks of at most maxBytes. Never lazyParse: it segfaults
// on Node 18 above 1 GB.
interface Simdjson {
  findChunkBoundaries(buf: Buffer, keyPath: string, maxBytes: number): number[][];
}

// V8 strings stop at ~512 MB: a block_results above PLAIN_PARSE_MAX is parsed per chunk of CHUNK_BYTES.
export const PLAIN_PARSE_MAX = 256 * 1024 * 1024;
export const CHUNK_BYTES = 256 * 1024 * 1024;

interface WireEvent {
  type: string;
  attributes?: Array<{ key: string; value: string }> | null;
}

// The event as indexMoney's finalizeBlockEvents has it: the events the parser reads (ATTRIBUTE_EVENT_TYPES) whole,
// in the map eras the bank events segmentBank reads whole, every other event only its type, so event_idx stays the
// position in the block.
function toRawEvent(e: WireEvent, withBank: boolean): RawEvent {
  const raw = { type: e.type, attributes: (e.attributes ?? []).map((a) => ({ key: a.key, value: a.value ?? "" })) };
  if (ATTRIBUTE_EVENT_TYPES.has(e.type)) return raw;
  if (withBank && BANK_EVENT_TYPES.has(e.type) && keepBankEvent(raw)) return raw;
  return { type: e.type, attributes: [] };
}

// The version of the reduction above: cached events written by other code (another keepBankEvent, another list of
// money events) are never read back.
export const EVENTS_FORMAT = createHash("sha256")
  .update(
    JSON.stringify([
      toRawEvent.toString(),
      keepBankEvent.toString(),
      [...ATTRIBUTE_EVENT_TYPES].sort(),
      [...BANK_EVENT_TYPES].sort(),
    ])
  )
  .digest("hex")
  .slice(0, 12);

// The value of result.height in a JSON-RPC response, read from its first bytes (the field precedes the events).
function resultHeight(buf: Buffer): string | undefined {
  const head = buf.toString("utf8", 0, Math.min(buf.length, 4096));
  return /"result":\{"height":"(\d+)"/.exec(head)?.[1];
}

// parseBlockResults reads the height and finalize_block_events out of a /block_results response. Above plainMax
// bytes the response is never turned into one string: simdjson finds the array's element boundaries and each
// chunk is parsed and reduced to RawEvents before the next one.
export function parseBlockResults(
  buf: Buffer,
  withBank: boolean,
  { chunkBytes = CHUNK_BYTES, plainMax = PLAIN_PARSE_MAX } = {}
): { height: number; events: RawEvent[] } {
  if (buf.length <= plainMax) {
    const doc = JSON.parse(buf.toString("utf8")) as {
      result?: { height?: string; finalize_block_events?: WireEvent[] | null };
      error?: unknown;
    };
    if (!doc.result) throw new Error(`block_results has no result: ${JSON.stringify(doc.error ?? doc).slice(0, 500)}`);
    // the list of the block's events must be there: an absent field is a response we cannot read, not a block
    // without events (null, CometBFT's empty list, reads as empty, which Chain.events refuses unless told otherwise)
    if (!("finalize_block_events" in doc.result)) {
      throw new Error(`block_results at height ${doc.result.height} has no finalize_block_events`);
    }
    return {
      height: Number(doc.result.height),
      events: (doc.result.finalize_block_events ?? []).map((e) => toRawEvent(e, withBank)),
    };
  }
  const height = resultHeight(buf);
  if (height === undefined) throw new Error("block_results: no result.height at the start of the response");
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const simdjson = require("simdjson") as Simdjson;
  const events: RawEvent[] = [];
  for (const [start, end] of simdjson.findChunkBoundaries(buf, "result.finalize_block_events", chunkBytes)) {
    const chunk = JSON.parse(`[${buf.toString("utf8", start, end)}]`) as WireEvent[];
    for (const e of chunk) events.push(toRawEvent(e, withBank));
  }
  return { height: Number(height), events };
}

// LegacyDec text as the LCD returns it ("0.100000000000000000") to its atomic integer (value × 1e18), the form
// gRPC returns and parseShares expects.
export function decToAtoms(text: string): string {
  const m = /^(\d+)(?:\.(\d{1,18}))?$/.exec(text);
  if (!m) throw new Error(`[history] ${JSON.stringify(text)} is not a LegacyDec`);
  return BigInt(m[1] + (m[2] ?? "").padEnd(18, "0")).toString();
}

interface LcdValidator {
  operator_address: string;
  consensus_pubkey?: { "@type"?: string; key?: string } | null;
  status: string;
  tokens: string;
  delegator_shares: string;
  commission?: { commission_rates?: { rate?: string } };
}

interface LcdDelegation {
  delegation: { delegator_address: string; validator_address: string; shares: string };
  // the delegation's tokens, TokensFromShares(shares).TruncateInt() computed by the node
  balance?: { amount?: string };
}

// The fields of a validator the money code reads (state.ts, map.ts), in the shape the indexer gets them over gRPC:
// LegacyDec as atomics, the consensus key as the Any value (PubKey message: field 1, 32 bytes).
export function chainValidatorFromLcd(v: LcdValidator): ChainValidator {
  const status = bondStatusFromJSON(v.status);
  if (status === BondStatus.UNRECOGNIZED) {
    throw new Error(`[history] validator ${v.operator_address} has an unknown status ${JSON.stringify(v.status)}`);
  }
  const key = v.consensus_pubkey?.key ? Buffer.from(v.consensus_pubkey.key, "base64") : undefined;
  const rate = v.commission?.commission_rates?.rate;
  return {
    operatorAddress: v.operator_address,
    consensusPubkey: key && {
      typeUrl: v.consensus_pubkey?.["@type"] ?? "",
      value: Uint8Array.from([0x0a, key.length, ...key]),
    },
    status,
    tokens: v.tokens,
    delegatorShares: decToAtoms(v.delegator_shares),
    commission: rate === undefined ? undefined : { commissionRates: { rate: decToAtoms(rate) } },
  } as unknown as ChainValidator;
}

export interface Header {
  time: Date;
  proposer: Uint8Array;
}

export interface ChainOptions {
  rpc: string;
  lcd?: string;
  // root of the cache; each chain and pair of endpoints gets its own directory under it
  cacheDir?: string;
  retries?: number;
  // Accept a block with no finalize-block events. Off: on mainnet every block has at least the mint of its
  // BeginBlock (66 heights from 1 to 946k measured, the fewest 5 events at height 1), so an empty or null list can
  // only be a broken response, and counting it as a block without money would leave a silent hole.
  allowEmptyBlocks?: boolean;
}

interface Response {
  body: Buffer;
  headers: http.IncomingHttpHeaders;
}

export class Chain {
  // the chain id the RPC node reports (/status), set by open()
  chainId = "";
  // the node's latest height (/status), set by open()
  latestHeight = 0;
  // this chain's cache directory under cacheDir, set by open()
  cache?: string;

  constructor(private readonly o: ChainOptions) {}

  // Reads the chain id and fixes the cache directory: <cacheDir>/<chain id>-<hash of the RPC and LCD URLs>.
  async open(): Promise<this> {
    const doc = this.json((await this.get(`${this.o.rpc}/status`)).body) as {
      result?: { node_info?: { network?: string }; sync_info?: { latest_block_height?: string } };
    };
    const chainId = doc.result?.node_info?.network;
    if (!chainId) throw new Error(`[history] ${this.o.rpc}/status has no node_info.network`);
    this.chainId = chainId;
    this.latestHeight = Number(doc.result?.sync_info?.latest_block_height ?? 0);
    if (this.o.cacheDir) {
      const endpoints = createHash("sha256")
        .update(`${this.o.rpc}\n${this.o.lcd ?? ""}`)
        .digest("hex")
        .slice(0, 12);
      this.cache = path.join(this.o.cacheDir, `${chainId}-${endpoints}`);
      sweepDownloads(this.cache);
    }
    return this;
  }

  // The finalize-block events of `height` and the size of the response they came from.
  async events(height: number, withBank: boolean): Promise<{ events: RawEvent[]; bytes: number }> {
    const file =
      this.cache && path.join(this.cache, `${height}.events${withBank ? ".bank" : ""}.${EVENTS_FORMAT}.ndjson.gz`);
    if (file && fs.existsSync(file)) return readEvents(file);
    const { body } = await this.get(`${this.o.rpc}/block_results?height=${height}`, {}, true);
    const parsed = parseBlockResults(body, withBank);
    if (parsed.height !== height) {
      throw new Error(`[history] block_results: asked for height ${height}, the node answered for ${parsed.height}`);
    }
    if (parsed.events.length === 0 && !this.o.allowEmptyBlocks) {
      throw new Error(
        `[history] block_results at height ${height}: empty finalize_block_events: real blocks have at least a mint ` +
          "(--allow-empty-blocks for a chain whose blocks can have none)"
      );
    }
    const out = { events: parsed.events, bytes: body.length };
    // only heights with money are kept: the walk reads every block, and most have none
    if (file && out.events.some((e) => MONEY_EVENT_TYPES.has(e.type))) await writeEvents(file, out);
    return out;
  }

  async header(height: number): Promise<Header> {
    const checkHeight = (got: string) => {
      if (got !== String(height)) {
        throw new Error(`[history] /header: asked for height ${height}, the node answered for ${got}`);
      }
    };
    const h = await this.cached(`${height}.header`, async () => {
      const doc = this.json((await this.get(`${this.o.rpc}/header?height=${height}`)).body) as {
        result?: { header: { chain_id: string; height: string; time: string; proposer_address: string } };
      };
      if (!doc.result) throw new Error(`[history] /header?height=${height} has no result`);
      // checked before it is cached: a header for another height must never be kept
      checkHeight(doc.result.header.height);
      return doc.result.header;
    });
    checkHeight(h.height);
    if (h.chain_id !== this.chainId) {
      throw new Error(`[history] /header at ${height} is for chain ${h.chain_id}, the node reports ${this.chainId}`);
    }
    // RFC 3339 with nanoseconds: the indexer's block time is the same instant cut to milliseconds
    const time = new Date(h.time.replace(/\.(\d{3})\d*Z$/, ".$1Z"));
    if (Number.isNaN(time.getTime())) throw new Error(`[history] height ${height}: bad header time ${h.time}`);
    return { time, proposer: fromHex(h.proposer_address) };
  }

  // Every validator at `height`, any status.
  async validators(height: number): Promise<ChainValidator[]> {
    const raw = await this.cached(`${height}.validators`, async () =>
      this.lcdPages<LcdValidator>(height, "/cosmos/staking/v1beta1/validators", "validators")
    );
    return raw.map(chainValidatorFromLcd);
  }

  // The delegations of each of `operators` at `height`, shares as atomics.
  async delegations(height: number, operators: ReadonlyArray<string>): Promise<Map<string, DelegationShares[]>> {
    const out = new Map<string, DelegationShares[]>();
    for (const op of operators) {
      const raw = await this.cached(`${height}.delegations.${op}`, async () =>
        this.lcdPages<LcdDelegation>(
          height,
          `/cosmos/staking/v1beta1/validators/${op}/delegations`,
          "delegation_responses"
        )
      );
      out.set(
        op,
        raw.map((d) => ({
          delegator: d.delegation.delegator_address,
          shares: decToAtoms(d.delegation.shares),
          balance: d.balance?.amount,
        }))
      );
    }
    return out;
  }

  // Checks, before anything is written, that the LCD serves state at `height` and says so: a node that ignores
  // x-cosmos-block-height answers with its latest state, and one pruned below `height` answers with an error.
  async preflightLcd(height: number): Promise<void> {
    await this.lcdGet(height, "/cosmos/staking/v1beta1/validators?pagination.limit=1");
  }

  private async lcdGet(height: number, pathAndQuery: string): Promise<unknown> {
    if (!this.o.lcd) throw new Error(`[history] height ${height} needs the LCD and no LCD URL is set`);
    const url = `${this.o.lcd}${pathAndQuery}`;
    const { body, headers } = await this.get(url, { "x-cosmos-block-height": String(height) });
    // the LCD reports the height it served in this header (gRPC gateway metadata); measured on mainnet's
    // sauron-api: it echoes an archive height, and without the request header it reports the latest height
    const served = headers["x-cosmos-block-height"] ?? headers["grpc-metadata-x-cosmos-block-height"];
    if (served !== String(height)) {
      throw new Error(`[history] ${url}: asked for height ${height}, the LCD answered for ${served ?? "no height"}`);
    }
    return this.json(body);
  }

  private async lcdPages<T>(height: number, route: string, field: string): Promise<T[]> {
    const out: T[] = [];
    const seen = new Set<string>();
    let key = "";
    for (;;) {
      const doc = (await this.lcdGet(
        height,
        `${route}?pagination.limit=1000${key ? `&pagination.key=${encodeURIComponent(key)}` : ""}`
      )) as Record<string, unknown> & { pagination?: { next_key?: string | null } };
      const page = doc[field];
      if (!Array.isArray(page)) throw new Error(`[history] ${route} at ${height}: no ${field}`);
      out.push(...(page as T[]));
      key = doc.pagination?.next_key ?? "";
      if (!key) return out;
      if (seen.has(key)) throw new Error(`[history] ${route} at ${height}: next_key ${key} repeats`);
      seen.add(key);
    }
  }

  private json(buf: Buffer): unknown {
    return JSON.parse(buf.toString("utf8"));
  }

  private async cached<T>(name: string, load: () => Promise<T>): Promise<T> {
    if (!this.cache) return load();
    const file = path.join(this.cache, `${name}.json.gz`);
    if (fs.existsSync(file)) {
      return JSON.parse((await gunzip(await fs.promises.readFile(file))).toString("utf8")) as T;
    }
    const value = await load();
    await fs.promises.mkdir(this.cache, { recursive: true });
    // written aside and renamed, so a stop mid-write never leaves a truncated file to be read back
    await fs.promises.writeFile(`${file}.tmp`, await gzip(JSON.stringify(value)));
    await fs.promises.rename(`${file}.tmp`, file);
    return value;
  }

  // GET with retries on network errors and HTTP errors. `large` bodies (block_results, up to ~1.5 GB in the map
  // eras) go through a file when the server sends no Content-Length, so the body is held once, never as a list of
  // chunks plus their concatenation.
  private async get(url: string, headers: Record<string, string> = {}, large = false): Promise<Response> {
    const retries = this.o.retries ?? 3;
    for (let attempt = 1; ; attempt++) {
      try {
        return await getOnce(url, headers, large ? this.cache ?? os.tmpdir() : undefined);
      } catch (e) {
        if (attempt >= retries) throw new Error(`[history] GET ${url} failed (attempt ${attempt} of ${retries}): ${e}`);
        await new Promise((r) => setTimeout(r, 1000 * attempt));
      }
    }
  }
}

// Bodies spilled to disk while downloading are named DOWNLOAD_PREFIX + this host's name in hex + "." + the
// downloading process's pid, so a cache directory shared between hosts never has one host sweep another's download
// in progress. Hex has no ".", so one host's prefix is never the start of another's ("node1" against "node1.lan").
const DOWNLOAD_PREFIX = ".download-";
export const downloadPrefix = (host = os.hostname()) => `${DOWNLOAD_PREFIX}${Buffer.from(host).toString("hex")}.`;

// Removes the spilled bodies a stopped process of this host left in `dir`: those whose pid is not running here.
// Other hosts' files, and names whose pid does not parse, are left alone.
export function sweepDownloads(dir: string): void {
  if (!fs.existsSync(dir)) return;
  const mine = downloadPrefix();
  for (const name of fs.readdirSync(dir)) {
    if (!name.startsWith(mine)) continue;
    const m = /^([1-9]\d{0,9})-/.exec(name.slice(mine.length));
    if (!m) continue;
    const pid = Number(m[1]);
    if (pid === process.pid) continue;
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch (e) {
      // EPERM: the process exists under another user
      alive = (e as NodeJS.ErrnoException).code === "EPERM";
    }
    if (!alive) fs.rmSync(path.join(dir, name), { force: true });
  }
}

// The events cache is one JSON line per event after a first line with the response size: a map-era block keeps
// ~850k bank events, too many for one JSON string.
async function writeEvents(file: string, { bytes, events }: { events: RawEvent[]; bytes: number }): Promise<void> {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const gz = zlib.createGzip();
  const done = new Promise<void>((resolve, reject) => {
    const out = fs.createWriteStream(`${file}.tmp`);
    out.on("finish", resolve).on("error", reject);
    gz.on("error", reject).pipe(out);
  });
  const write = async (line: string) =>
    gz.write(`${line}\n`) ? Promise.resolve() : new Promise<void>((r) => gz.once("drain", () => r()));
  await write(JSON.stringify({ bytes }));
  for (const e of events) await write(JSON.stringify(e));
  gz.end();
  await done;
  await fs.promises.rename(`${file}.tmp`, file);
}

async function readEvents(file: string): Promise<{ events: RawEvent[]; bytes: number }> {
  const buf = await gunzip(await fs.promises.readFile(file));
  const lines: string[] = [];
  for (let at = 0; at < buf.length; ) {
    const nl = buf.indexOf(0x0a, at);
    const end = nl === -1 ? buf.length : nl;
    if (end > at) lines.push(buf.toString("utf8", at, end));
    at = end + 1;
  }
  const { bytes } = JSON.parse(lines[0]) as { bytes: number };
  return { bytes, events: lines.slice(1).map((l) => JSON.parse(l) as RawEvent) };
}

// One GET. With Content-Length the body is written into one buffer of that size as it arrives; without it, and
// with `spillDir`, it goes to a file there and is read back whole (one buffer, the file's size); otherwise the
// chunks are joined at the end (small responses).
async function getOnce(url: string, headers: Record<string, string>, spillDir?: string): Promise<Response> {
  const client = url.startsWith("https:") ? https : http;
  // once the response has started, any transport error means the body was cut short; Node names that several ways
  // (aborted, socket hang up, ECONNRESET, premature close), so the error says it in one
  let receiving = false;
  const cut = (e: unknown) => new Error(`the response was cut short (${e instanceof Error ? e.message : String(e)})`);
  return new Promise((resolve, reject) => {
    const req = client.get(url, { headers }, (res) => {
      receiving = true;
      const fail = (body: Buffer) =>
        reject(new Error(`HTTP ${res.statusCode}: ${body.toString("utf8", 0, Math.min(body.length, 300))}`));
      const length = Number(res.headers["content-length"]);
      res.on("error", (e) => reject(cut(e)));
      if (Number.isSafeInteger(length) && length > 0) {
        const body = Buffer.allocUnsafe(length);
        let at = 0;
        res.on("data", (c: Buffer) => {
          if (at + c.length > length) return req.destroy(new Error(`body longer than its Content-Length ${length}`));
          c.copy(body, at);
          at += c.length;
        });
        res.on("end", () => {
          if (at !== length) return reject(new Error(`body of ${at} bytes, Content-Length ${length}`));
          if ((res.statusCode ?? 0) >= 400) return fail(body);
          resolve({ body, headers: res.headers });
        });
      } else if (spillDir && (res.statusCode ?? 0) < 400) {
        fs.mkdirSync(spillDir, { recursive: true });
        const file = path.join(
          spillDir,
          `${downloadPrefix()}${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
        );
        const out = fs.createWriteStream(file);
        // a response cut short or a failed write rejects once and leaves no partial file behind
        let settled = false;
        const abort = (e: unknown) => {
          if (settled) return;
          settled = true;
          // stop the transfer too: a retry must not start while this body is still arriving
          res.destroy();
          req.destroy();
          out.destroy();
          fs.rmSync(file, { force: true });
          reject(e);
        };
        res.on("error", (e) => abort(cut(e)));
        res.on("aborted", () => abort(cut("aborted")));
        req.on("error", (e) => abort(cut(e)));
        out.on("error", (e) => abort(new Error(`writing the download to ${file} failed: ${e.message}`)));
        res.pipe(out);
        out.on("finish", () => {
          if (!res.complete) return abort(cut("incomplete"));
          settled = true;
          // the file goes before the promise settles, so nothing awaiting it can see it
          fs.promises.readFile(file).then(
            (body) => {
              fs.rmSync(file, { force: true });
              resolve({ body, headers: res.headers });
            },
            (e) => {
              fs.rmSync(file, { force: true });
              reject(e);
            }
          );
        });
      } else {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const body = Buffer.concat(chunks);
          if ((res.statusCode ?? 0) >= 400) return fail(body);
          resolve({ body, headers: res.headers });
        });
      }
    });
    req.on("error", (e) => reject(receiving ? cut(e) : e));
    // the archive node can take minutes before the first byte of a large block_results (memory project_parse_speedup)
    req.setTimeout(600_000, () => req.destroy(new Error("no data for 600 s")));
  });
}
