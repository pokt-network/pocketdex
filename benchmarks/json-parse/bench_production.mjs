/**
 * Benchmark that replicates EXACTLY what parseLargeJsonBuffer does in production.
 * This should reproduce the 242s we see in k8s.
 *
 * Usage: node --max-old-space-size=16384 benchmarks/json-parse/bench_production.mjs
 */
import { readFileSync } from 'fs';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const simdjson = require('../../vendor/simdjson');

const FILE = process.env.FILE || './block_results_677853.json';
const MAX_CHUNK_BYTES = 400 * 1024 * 1024;

const BLOCK_RESULTS_FIELDS = [
  'height',
  'txs_results',
  'begin_block_events',
  'end_block_events',
  'finalize_block_events',
  'validator_updates',
  'consensus_param_updates',
  'app_hash',
];

console.log('=== Production Parse Replica ===\n');

// Step 1: Read file (simulates Buffer.concat of stream chunks)
let t = performance.now();
const buf = readFileSync(FILE);
console.log(`Read: ${(performance.now() - t).toFixed(0)}ms (${(buf.length / 1024 / 1024).toFixed(1)}MB)`);

// Step 2: lazyParse (exactly as production does)
t = performance.now();
const lazy = simdjson.lazyParse(buf);
console.log(`lazyParse: ${(performance.now() - t).toFixed(0)}ms`);

// Step 3: Extract envelope fields
t = performance.now();
const jsonrpc = lazy.valueForKeyPath('jsonrpc');
console.log(`valueForKeyPath('jsonrpc'): ${(performance.now() - t).toFixed(0)}ms → ${jsonrpc}`);

t = performance.now();
const id = lazy.valueForKeyPath('id');
console.log(`valueForKeyPath('id'): ${(performance.now() - t).toFixed(0)}ms → ${id}`);

// Step 4: Process each field exactly as production
const parsed = { jsonrpc, id, result: {} };
let totalFieldTime = 0;

for (const field of BLOCK_RESULTS_FIELDS) {
  const path = `result.${field}`;
  const fieldStart = performance.now();

  try {
    // Try chunked array parse first
    const boundaries = simdjson.findChunkBoundaries(buf, path, MAX_CHUNK_BYTES);
    let arr = [];
    for (const [s, e] of boundaries) {
      arr = arr.concat(JSON.parse('[' + buf.toString('utf8', s, e) + ']'));
    }
    parsed.result[field] = arr;
    const elapsed = performance.now() - fieldStart;
    totalFieldTime += elapsed;
    console.log(`${field}: CHUNKED ${boundaries.length} chunks, ${arr.length} items in ${elapsed.toFixed(0)}ms`);
  } catch (chunkErr) {
    // Fall back to valueForKeyPath
    try {
      const vfkStart = performance.now();
      parsed.result[field] = lazy.valueForKeyPath(path);
      const elapsed = performance.now() - fieldStart;
      totalFieldTime += elapsed;
      console.log(`${field}: valueForKeyPath in ${elapsed.toFixed(0)}ms`);
    } catch {
      const elapsed = performance.now() - fieldStart;
      totalFieldTime += elapsed;
      console.log(`${field}: NOT FOUND (${elapsed.toFixed(0)}ms scanning)`);
    }
  }
}

console.log(`\nTotal field processing: ${totalFieldTime.toFixed(0)}ms`);

// Verify data integrity
console.log(`\n=== Result ===`);
console.log(`jsonrpc: ${parsed.jsonrpc}`);
console.log(`id: ${parsed.id}`);
for (const [k, v] of Object.entries(parsed.result)) {
  if (Array.isArray(v)) {
    console.log(`result.${k}: ${v.length} items`);
  } else {
    console.log(`result.${k}: ${typeof v} = ${JSON.stringify(v).substring(0, 80)}`);
  }
}
