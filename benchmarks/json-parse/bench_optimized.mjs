/**
 * Optimized parseLargeJsonBuffer — no lazyParse, no valueForKeyPath.
 *
 * Strategy:
 *   - Envelope (jsonrpc, id): regex on first 200 bytes
 *   - Array fields (txs_results, finalize_block_events): findChunkBoundaries + JSON.parse
 *   - Scalar/object fields (height, app_hash, etc): find key position in buffer, extract value, JSON.parse
 *   - Skip fields that don't exist in CometBFT 0.38 (begin_block_events, end_block_events)
 *
 * Tests with both small (70KB) and large (1.5GB) blocks.
 *
 * Usage: node --max-old-space-size=16384 benchmarks/json-parse/bench_optimized.mjs
 */
import { readFileSync } from 'fs';
import { createRequire } from 'module';
import { createReadStream } from 'fs';
import pkg from 'stream-json';
import AsmPkg from 'stream-json/Assembler.js';

const require = createRequire(import.meta.url);
const simdjson = require('../../vendor/simdjson');
const { parser } = pkg;
const Assembler = AsmPkg.default || AsmPkg;

const MAX_CHUNK_BYTES = 400 * 1024 * 1024;

// Fields that are arrays in block_results
const ARRAY_FIELDS = [
  'txs_results',
  'begin_block_events',
  'end_block_events',
  'finalize_block_events',
];

// Fields that are scalars or small objects
const SCALAR_FIELDS = [
  'height',
  'validator_updates',
  'consensus_param_updates',
  'app_hash',
];

/**
 * Extract a scalar value from the buffer by searching for its key.
 * Returns undefined if not found.
 */
function extractScalar(buf, field, searchFrom) {
  const key = `"${field}":`;
  const keyBuf = Buffer.from(key);
  const keyPos = buf.indexOf(keyBuf, searchFrom);
  if (keyPos === -1) return undefined;

  const valStart = keyPos + keyBuf.length;
  const firstByte = buf[valStart];

  let valEnd;

  if (firstByte === 0x22) {
    // String: find closing unescaped quote
    let pos = valStart + 1;
    while (pos < buf.length) {
      if (buf[pos] === 0x5c) { pos += 2; continue; } // skip escaped
      if (buf[pos] === 0x22) { pos++; break; }
      pos++;
    }
    valEnd = pos;
  } else if (firstByte === 0x7b) {
    // Object: track depth
    let depth = 1, pos = valStart + 1, inStr = false;
    while (pos < buf.length && depth > 0) {
      if (inStr) {
        if (buf[pos] === 0x5c) pos++;
        else if (buf[pos] === 0x22) inStr = false;
      } else {
        if (buf[pos] === 0x22) inStr = true;
        else if (buf[pos] === 0x7b) depth++;
        else if (buf[pos] === 0x7d) depth--;
      }
      pos++;
    }
    valEnd = pos;
  } else if (firstByte === 0x5b) {
    // Array: track depth
    let depth = 1, pos = valStart + 1, inStr = false;
    while (pos < buf.length && depth > 0) {
      if (inStr) {
        if (buf[pos] === 0x5c) pos++;
        else if (buf[pos] === 0x22) inStr = false;
      } else {
        if (buf[pos] === 0x22) inStr = true;
        else if (buf[pos] === 0x5b) depth++;
        else if (buf[pos] === 0x5d) depth--;
      }
      pos++;
    }
    valEnd = pos;
  } else if (firstByte === 0x6e) {
    // null
    valEnd = valStart + 4;
  } else if (firstByte === 0x74) {
    // true
    valEnd = valStart + 4;
  } else if (firstByte === 0x66) {
    // false
    valEnd = valStart + 5;
  } else {
    // number
    let pos = valStart;
    while (pos < buf.length && buf[pos] !== 0x2c && buf[pos] !== 0x7d && buf[pos] !== 0x5d) pos++;
    valEnd = pos;
  }

  return JSON.parse(buf.toString('utf8', valStart, valEnd));
}

/**
 * Parse block_results buffer without lazyParse.
 */
function parseLargeJsonBuffer(buf) {
  // Envelope: jsonrpc and id from first 200 bytes
  const header = buf.toString('utf8', 0, Math.min(200, buf.length));
  const jsonrpc = header.match(/"jsonrpc":"([^"]+)"/)?.[1] || '2.0';
  const idMatch = header.match(/"id":(-?[0-9]+)/);
  const id = idMatch ? parseInt(idMatch[1]) : -1;

  const parsed = { jsonrpc, id, result: {} };

  // Find where "result":{ starts
  const resultKeyBuf = Buffer.from('"result":{');
  const resultStart = buf.indexOf(resultKeyBuf);
  if (resultStart === -1) return parsed;

  // All known block_results fields
  const ALL_FIELDS = [...new Set([...ARRAY_FIELDS, ...SCALAR_FIELDS])];

  for (const field of ALL_FIELDS) {
    // Try as chunked array first (fast for large arrays)
    try {
      const boundaries = simdjson.findChunkBoundaries(buf, `result.${field}`, MAX_CHUNK_BYTES);
      let arr = [];
      for (const [s, e] of boundaries) {
        arr = arr.concat(JSON.parse('[' + buf.toString('utf8', s, e) + ']'));
      }
      parsed.result[field] = arr;
      continue;
    } catch {
      // Not an array or not found — try as scalar
    }

    const val = extractScalar(buf, field, resultStart);
    if (val !== undefined) parsed.result[field] = val;
  }

  return parsed;
}

// ---- Benchmarks ----

async function streamJsonParse(file) {
  return new Promise((resolve, reject) => {
    const t = performance.now();
    const s = createReadStream(file);
    const j = s.pipe(parser());
    j.on('error', reject);
    const asm = Assembler.connectTo(j);
    asm.on('done', (a) => resolve({ time: performance.now() - t, data: a.current }));
  });
}

async function benchFile(file, label) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`${label}: ${file}`);
  console.log(`${'='.repeat(60)}`);

  const buf = readFileSync(file);
  console.log(`Size: ${(buf.length / 1024 / 1024).toFixed(1)}MB`);

  // Method 1: Our optimized parse
  const t1 = performance.now();
  const result1 = parseLargeJsonBuffer(buf);
  const time1 = performance.now() - t1;
  console.log(`\nOptimized parse: ${time1.toFixed(0)}ms`);
  for (const [k, v] of Object.entries(result1.result)) {
    if (Array.isArray(v)) console.log(`  ${k}: ${v.length} items`);
    else console.log(`  ${k}: ${JSON.stringify(v).substring(0, 60)}`);
  }

  // Method 2: Direct JSON.parse (only if < 512MB)
  if (buf.length < 500 * 1024 * 1024) {
    const t2 = performance.now();
    const result2 = JSON.parse(buf.toString());
    const time2 = performance.now() - t2;
    console.log(`\nJSON.parse: ${time2.toFixed(0)}ms`);

    // Verify match
    const r1 = result1.result;
    const r2 = result2.result;
    let match = true;
    for (const k of Object.keys(r2)) {
      const a = JSON.stringify(r1[k]);
      const b = JSON.stringify(r2[k]);
      if (a !== b) { console.log(`  MISMATCH: ${k}`); match = false; }
    }
    console.log(`  Data match: ${match ? 'YES' : 'NO'}`);
  }

  // Method 3: stream-json (only for small files)
  if (buf.length < 500 * 1024 * 1024) {
    const { time: time3, data: result3 } = await streamJsonParse(file);
    console.log(`\nstream-json: ${time3.toFixed(0)}ms`);
  }

  return { time: time1, events: result1.result.finalize_block_events?.length || 0 };
}

// Run
const smallFile = 'block_results_679532.json';
const largeFile = 'block_results_679533.json';

const hasSmall = (() => { try { readFileSync(smallFile, { flag: 'r' }); return true; } catch { return false; } })();
const hasLarge = (() => { try { readFileSync(largeFile, { flag: 'r' }); return true; } catch { return false; } })();

if (hasSmall) await benchFile(smallFile, 'Normal block (679532)');
if (hasLarge) await benchFile(largeFile, 'Settlement block (679533)');

if (!hasSmall && !hasLarge) {
  console.log('No block files found. Download with:');
  console.log("  curl -s 'https://rpc-seed-one.infra.pocket.network/block_results?height=679532' -o block_results_679532.json");
  console.log("  curl -s 'https://rpc-seed-one.infra.pocket.network/block_results?height=679533' -o block_results_679533.json");
}
