// History job CLI: walks every height below the live indexer's first written settlement down to 1 and writes the
// settlement money of those that have any (docs/money-history-job.md).
//
//   TS_NODE_FILES=true node --max-old-space-size=12000 -r ts-node/register scripts/money/history.ts \
//     --db postgres://… --schema mainnet --rpc http://archive:26657 --lcd http://archive:1317 \
//     [--workers 1] [--flush-every 2000] [--flush-ms 30000] [--start H] [--to H] [--cache-dir .local/money-history-cache] [--dry-run] [--localnet] [--allow-empty-blocks]
//
// Exit code 0 when every height in range is walked, 1 when the job stopped (the log line says where).
import { Chain } from "../../src/mappings/money/history/chain";
import { eraEnv, PgClient, runHistory } from "../../src/mappings/money/history/job";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Client } = require("pg") as {
  Client: new (o: {
    connectionString?: string;
    keepAlive?: boolean;
    keepAliveInitialDelayMillis?: number;
  }) => PgClient & { connect(): Promise<void>; end(): Promise<void> };
};

function args(argv: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) throw new Error(`unexpected argument ${a}`);
    if (a === "--dry-run" || a === "--localnet" || a === "--allow-empty-blocks") out.set(a.slice(2), "1");
    else out.set(a.slice(2), argv[++i]);
  }
  return out;
}

async function main(): Promise<number> {
  const a = args(process.argv.slice(2));
  const need = (k: string) => {
    const v = a.get(k);
    if (!v) throw new Error(`--${k} is required`);
    return v;
  };
  const int = (k: string) => (a.has(k) ? Number.parseInt(a.get(k) as string, 10) : undefined);
  const db = need("db");
  // TCP keepalive, so a session lost without a RST (a node gone) is noticed and its advisory lock released
  const writer = new Client({ connectionString: db, keepAlive: true, keepAliveInitialDelayMillis: 30_000 });
  const reader = new Client({ connectionString: db, keepAlive: true, keepAliveInitialDelayMillis: 30_000 });
  await writer.connect();
  await reader.connect();
  try {
    const chain = await new Chain({
      rpc: need("rpc"),
      lcd: a.get("lcd"),
      cacheDir: a.get("cache-dir") ?? ".local/money-history-cache",
      allowEmptyBlocks: a.has("allow-empty-blocks"),
    }).open();
    const r = await runHistory(writer, {
      schema: need("schema"),
      chain,
      env: eraEnv(process.env, chain, a.has("localnet")),
      start: int("start"),
      to: int("to"),
      workers: int("workers"),
      flushEvery: int("flush-every"),
      flushMs: int("flush-ms"),
      dryRun: a.has("dry-run"),
      reader,
    });
    return r.failed ? 1 : 0;
  } finally {
    await writer.end();
    await reader.end();
  }
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(e);
    process.exit(1);
  }
);
