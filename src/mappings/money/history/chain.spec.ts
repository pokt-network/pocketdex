/* eslint-disable @typescript-eslint/no-floating-promises */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import * as zlib from "node:zlib";
import { sha256 } from "@cosmjs/crypto";
import { fromBech32, toBech32 } from "@cosmjs/encoding";
import { BondStatus } from "../../../client/cosmos/staking/v1beta1/staking";
import { proposerOperatorAccount } from "../map";
import type { RawEvent } from "../payload";
import { Chain, chainValidatorFromLcd, decToAtoms, downloadPrefix, parseBlockResults } from "./chain";

const FIXTURE = path.join(__dirname, "../../../../test/money/fixtures/settlement_699993.json.gz");

function blockResults(events: RawEvent[]): Buffer {
  const wire = events.map((e) => ({ type: e.type, attributes: e.attributes.map((a) => ({ ...a, index: true })) }));
  return Buffer.from(
    JSON.stringify({
      jsonrpc: "2.0",
      id: -1,
      result: { height: "699993", txs_results: null, finalize_block_events: wire, validator_updates: [], app_hash: "" },
    })
  );
}

describe("history chain reader", () => {
  const fx = JSON.parse(zlib.gunzipSync(fs.readFileSync(FIXTURE)).toString()) as { events: RawEvent[] };
  // an event the money code does not read, with attributes: it must keep its position and lose them
  const events: RawEvent[] = [{ type: "message", attributes: [{ key: "module", value: "bank" }] }, ...fx.events];

  it("parses block_results in chunks to the same events as one JSON.parse", () => {
    const buf = blockResults(events);
    const plain = parseBlockResults(buf, true);
    const chunked = parseBlockResults(buf, true, { chunkBytes: 64 * 1024, plainMax: 0 });
    assert.equal(chunked.events.length, events.length);
    assert.deepEqual(chunked, plain);
    assert.equal(chunked.height, 699993);
    assert.deepEqual(plain.events[0], { type: "message", attributes: [] });
  });

  it("keeps bank attributes only in the map eras", () => {
    const buf = blockResults(events);
    const bank = (list: RawEvent[]) => list.filter((e) => e.type === "transfer" && e.attributes.length > 0).length;
    assert.ok(bank(parseBlockResults(buf, true).events) > 0);
    assert.equal(bank(parseBlockResults(buf, false, { chunkBytes: 64 * 1024, plainMax: 0 }).events), 0);
  });

  it("refuses a response with no result", () => {
    assert.throws(
      () => parseBlockResults(Buffer.from('{"jsonrpc":"2.0","error":{"message":"height 5 is not available"}}'), false),
      /no result.*not available/
    );
  });

  it("reads LegacyDec text as atomics", () => {
    assert.equal(decToAtoms("0.100000000000000000"), "100000000000000000");
    assert.equal(decToAtoms("12"), "12000000000000000000");
    assert.equal(decToAtoms("0.5"), "500000000000000000");
    assert.throws(() => decToAtoms("1e-6"), /not a LegacyDec/);
  });

  it("turns an LCD validator into what the map state and the delegator split read", () => {
    const key = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
    const account = "pokt1zdyjlf9ytwahsaawwym0uzq7z8eu9me87jvgm9";
    const lcd = {
      operator_address: toBech32("poktvaloper", fromBech32(account).data),
      consensus_pubkey: { "@type": "/cosmos.crypto.ed25519.PubKey", key: Buffer.from(key).toString("base64") },
      status: "BOND_STATUS_BONDED",
      tokens: "1000",
      delegator_shares: "1000.000000000000000000",
      commission: { commission_rates: { rate: "0.050000000000000000" } },
    };
    const v = chainValidatorFromLcd(lcd);
    assert.equal(v.status, BondStatus.BOND_STATUS_BONDED);
    assert.equal(v.delegatorShares, "1000000000000000000000");
    assert.equal(v.commission?.commissionRates?.rate, "50000000000000000");
    assert.equal(proposerOperatorAccount([v], sha256(key).slice(0, 20)), account);
    assert.throws(
      () => chainValidatorFromLcd({ ...lcd, status: "BOND_STATUS_SOMETHING" }),
      /unknown status "BOND_STATUS_SOMETHING"/
    );
  });
});

describe("history chain reader downloads without Content-Length", () => {
  const fx = JSON.parse(zlib.gunzipSync(fs.readFileSync(FIXTURE)).toString()) as { events: RawEvent[] };
  const body = blockResults(fx.events);
  // "chunked": the body in 64 KB writes with no Content-Length, as mainnet's RPC sends block_results;
  // "cut": half the body, then the connection is destroyed
  let mode: "chunked" | "cut" = "chunked";
  const server = http.createServer((req, res) => {
    if (req.url?.startsWith("/status")) {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ result: { node_info: { network: "pocket" } } }));
    }
    res.writeHead(200, { "content-type": "application/json" });
    const end = mode === "cut" ? body.length >> 1 : body.length;
    for (let at = 0; at < end; at += 65536) res.write(body.subarray(at, Math.min(at + 65536, end)));
    // cut only once the headers and the first half have left, so the client is inside the response when it breaks
    if (mode === "cut") return res.write("", () => setTimeout(() => res.destroy(), 50));
    res.end();
  });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "money-history-chain-"));
  // the spill files in the chain's own cache directory, where downloads without Content-Length go
  const leftovers = (chain: Chain) =>
    fs.readdirSync(chain.cache as string).filter((f) => f.startsWith(".download-")).length;
  let base = "";

  // in a hook, so a failing test still lets the process exit
  after(() => {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("spills the body to a file, reads it back whole and removes the file", async () => {
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    mode = "chunked";
    const chain = await new Chain({ rpc: base, cacheDir: root, retries: 1 }).open();
    const got = await chain.events(699993, true);
    assert.equal(got.bytes, body.length);
    assert.deepEqual(got.events, parseBlockResults(body, true).events);
    assert.equal(leftovers(chain), 0);
  });

  it("rejects a response cut short and leaves no partial file", async () => {
    mode = "cut";
    const chain = await new Chain({ rpc: base, cacheDir: path.join(root, "cut"), retries: 1 }).open();
    await assert.rejects(
      chain.events(699993, true),
      /height=699993 failed \(attempt 1 of 1\): Error: the response was cut short/
    );
    // the directory exists only because the body was being spilled there
    assert.ok(fs.existsSync(chain.cache as string));
    assert.equal(leftovers(chain), 0);
  });

  it("opening removes this host's partial files of processes that are gone, and keeps its own and other hosts'", async () => {
    const chain = await new Chain({ rpc: base, cacheDir: path.join(root, "sweep"), retries: 1 }).open();
    const dir = chain.cache as string;
    fs.mkdirSync(dir, { recursive: true });
    const mine = downloadPrefix();
    // pid 2147483646 is above Linux's pid_max: never a running process. A host whose name extends this one's
    // ("node1" and "node1.lan") is another host, and a name whose pid does not parse is never removed.
    const keep = [
      `${mine}${process.pid}-1-x`,
      `${downloadPrefix(`${os.hostname()}.lan`)}2147483646-1-x`,
      `${downloadPrefix("another-host")}2147483646-1-x`,
      `${mine}not-a-pid-1-x`,
    ];
    for (const name of [...keep, `${mine}2147483646-1-x`]) fs.writeFileSync(path.join(dir, name), "x");
    await chain.open();
    assert.deepEqual(fs.readdirSync(dir).sort(), keep.sort());
  });
});
