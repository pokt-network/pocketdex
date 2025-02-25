/*
 * THIS FILE IS HERE JUST TO DEMONSTRATE THAN WE ARE ABLE TO REQUEST BLOCK AND BLOCK_REQUESTS
 * WITHOUT ISSUES WHEN THEY ARE SMALL OR WHEN THEY ARE BIGGER THAN 512MB WHICH IS JS STRING LIMIT SIZE.
 */

const axios = require("axios");
const { parser } = require("stream-json");
const Assembler = require("stream-json/Assembler");
const { PassThrough } = require("stream");
const { performance } = require("perf_hooks");

/**
 * Parses JSON stream response and reconstructs the entire JSON structure.
 * Handles large JSON files to conserve memory.
 *
 * @returns A promise resolving to the fully reconstructed JSON object.
 */
async function httpRequest(path, height) {

  const response = await axios({
    method: "GET",
    url: `https://shannon-testnet-grove-rpc.beta.poktroll.com/${path}?height=${height}`,
    responseType: "stream",
    headers: {
      "Accept-Encoding": "gzip,deflate",
    },
    decompress: true,
  });

  console.log(`[DEBUG:${height}] Received HTTP response as a stream`);

  let totalBytes = 0; // Tracking total bytes

  // Create a passthrough stream to measure stream size
  const sizeMeter = new PassThrough();
  sizeMeter.on("data", (chunk) => (totalBytes += chunk.length));

  return new Promise((resolve, reject) => {
    console.log(`[DEBUG:${height}] Starting JSON stream processing`);
    // Pipe the data through the sizeMeter, then into the JSON parser
    const jsonStream = response.data.pipe(sizeMeter).pipe(parser());
    jsonStream.on("error", reject);
    const asm = Assembler.connectTo(jsonStream);
    asm.on("done", asm => {
      if (asm.done) resolve(asm.current);
    });
  });
}

async function getBlock(height) {
  console.log(`-------------------------------------------------------------------------`);
  const start = performance.now();
  const blockResponse = await httpRequest("block", height);
  const blockResultsResponse = await httpRequest("block_results", height);
  if (blockResponse.result.block.data.txs.length !== (blockResultsResponse.result.txs_results || []).length) {
    throw new Error(`[ERROR:${height}] Block results length does not match block txs length`);
  } else {
    console.log(`[DEBUG:${height}] Block results length matches block txs length`);
  }
  console.log(`[DEBUG:${height}] JSON stream processing finished in ${(performance.now() - start).toFixed(2)}ms`);
  console.log(`-------------------------------------------------------------------------`);
}

(function() {
  const heights = [
    349, // first txs
    34123, // first claims
    55330, // too big
    58119, // even more
    58120, // the devil is on this block brother...
  ];

  heights.reduce((promise, height) => {
    return promise
      .then(() => getBlock(height)) // Wait for the current request
      .catch((error) => console.error(`[ERROR:${height}]`, error)); // Handle errors
  }, Promise.resolve()) // Start the chain with an already-resolved promise
    .then(() => {
      console.log("All requests completed serially!");
    });
})();
