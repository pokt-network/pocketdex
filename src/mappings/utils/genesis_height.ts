// genesisInitialHeight is the height of the genesis block. The published genesis
// files carry initial_height as a number (0 or 1) and a node's /genesis as a
// string ("1", the way CometBFT writes it); 0 means 1. Anything else throws: a
// value that never matches a block height would skip the genesis silently.
export function genesisInitialHeight(value: unknown): number {
  const height =
    typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value) : NaN;
  if (!Number.isSafeInteger(height) || height < 0) {
    throw new Error(`invalid genesis initial_height ${JSON.stringify(value)}`);
  }
  return height === 0 ? 1 : height;
}
