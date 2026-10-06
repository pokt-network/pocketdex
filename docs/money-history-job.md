# Settlement money history job — runbook

The live indexer writes settlement money from its deploy height on. The history job walks EVERY height below that,
down to height 1, reading each block's `/block_results` from an archive RPC, and writes the heights that have money
with the indexer's own parser and writer (`src/mappings/money/history`, CLI `scripts/money/history.ts`).

## What it does

1. Takes a session advisory lock (`pocketdex.history.<schema>`) for the whole run: one job per schema. A second one
   exits with "another history job holds the lock".
2. Reads the chain id from the RPC (`/status`). The eras are labelled from that chain id and the height.
3. Checks that the LCD serves state at the lowest height of the run that needs it (map_proposer_operator through
   batched_vrd) and reports that height back. Nothing is recorded if it does not. The check goes by
   era: a run inside one of those eras needs `--lcd` even if its heights turn out not to read it.
4. Plans from `money_progress` (one row: `from_height`, where the money tables start, and `height`, the last height
   the indexer's money step processed). The job owns only the `settlement_gaps` row that starts at 1: with it, it
   resumes from its `to_height`; without it, it records `[1, from_height − 1]` and walks from there down. It never walks
   heights the money step processed, and another gap row (the heights a `POCKETDEX_MONEY_FROM_HEIGHT` override
   skipped) is not its territory, wherever it lies: reindexing those heights fills it. Without a `money_progress` row
   it stops (the indexer creates it, or its start-up seeds it over written settlements). As it lowers its row the job
   lowers `money_progress.from_height` to the lowest height it has walked, and to 1 when it finishes; each height's
   transaction locks `money_progress` before writing, in the indexer's order. A job running an older version does not
   lower `from_height`: when it finishes, the heights it walked read as not covered (never as zero) until a job of this
   version runs or `from_height` is set by hand. The catalog functions cover the block at `from_height` to the block at
   `money_progress.height` + 1 µs, minus the gap rows: the heights not walked yet read as not covered in their
   `range`, never as zero.
5. Walks down one height at a time. For each it reads `/block_results`. **A height counts as read only on positive
   proof**: the response is for the height asked (`result.height`), the body arrived whole and parsed, and
   `finalize_block_events` is there and not empty. Every real block has at least the mint of its BeginBlock (66
   mainnet heights from 1 to 946k measured, the fewest 5 events at height 1), so an absent, `null` or empty list
   stops the height as a broken response (`--allow-empty-blocks` for a chain whose blocks can be empty). Any RPC
   error is retried, then stops the job; nothing counts as a height without money unless its events were read. The archive has blocks from height 1 (measured on
   mainnet's sauron, 2026-10-02); a height it cannot serve stops the job with the node's message.
6. Checks the block against the indexer's raw event tables (settled, expired, slashed, reimbursement requests,
   validator reward distributions), 2,000 heights per query (each an index range scan; at most 0.31 s on pnf's
   replica for the reimbursement requests of 900,001–902,000, measured 2026-10-02): a table with MORE rows at the height than the block
   has events **stops** the job (a parser or fetch bug); FEWER is the indexer's gap: logged as `FINDING …` and kept
   in `settlement_history_findings` (height, event type, chain count, raw count), and the job goes on.
7. A height with no money event writes nothing; the gap is lowered over such heights in batches (`--flush-every`,
   `--flush-ms`), only over heights already read and classified, so it may lag behind the walk but never leads it.
8. A height with money (settlements, expirations, slashes, or only discards: `EventClaimDiscarded` exists from
   161,109, with the claim nested up to v0.1.26 and flat from v0.1.27) reads `/header`, the params in force from the
   `params` table, and the validators (and in `batched_vrd` their delegations) from the LCD when the era needs them.
   **Every LCD response must report the height asked** (`x-cosmos-block-height`). It builds the payload exactly as
   `indexMoney` does (`parity.spec.ts`) and writes it in **one transaction** with the gap lowered below it.
9. In the eras whose validator rows are replayed (map_proposer_operator to detailed_batch, `REPLAY_ERAS` in
   `src/mappings/money/replay.ts`), a height with settled claims also reads the validators at the height and every
   delegation of each bonded one, fully paginated, into the cache; replays the chain's split over them into the
   validator and delegator rows, as the live indexer does; and records the snapshot in `settlement_replay_snapshots`
   (height, era, bonded, delegations) with the height. A snapshot read again must match the recorded counts, or the
   height stops. **The cache directory must
   outlive the run** (a persistent volume for the Job); a replay checks each money height of those eras against that
   table and the cache, and reads the chain again where either is missing.
10. **Stops at the first height that fails** and prints `STOPPED at height=… era=…: <error>`. It never skips a
    height. Rerunning resumes from the gap row.

One line per written height: era, row counts, `block_results` bytes, fetch/parse/write ms, the snapshot read
(`snapshot=bonded/delegations`) and the md5 of the payload (a determinism log, not a check); one line per batch of
empty heights (`covered down to …`).

## Running it

Run it from a machine close to the archive node: the map eras' settlement blocks are 77 MB–1.45 GB each.

```sh
TS_NODE_FILES=true node --max-old-space-size=12000 -r ts-node/register scripts/money/history.ts \
  --db postgres://USER@HOST/DB --schema <indexer schema> \
  --rpc http://<archive>:26657 --lcd http://<archive>:1317 --cache-dir .local/money-history-cache
```

| Option | Meaning |
|---|---|
| `--start H` | Optional: the start is always `money_progress.from_height − 1`; another value stops the job. |
| `--to H` | Lowest height to walk in this run (default 1). The gap keeps what is below. |
| `--workers N` | Heights downloaded and parsed ahead while one is written (default 1): up to N + 1 heights in memory. |
| `--flush-every N`, `--flush-ms T` | Empty heights between two lowerings of the gap (default 2000), and the longest wait (default 30,000 ms). A crash re-reads at most that many. |
| `--dry-run` | Writes each height in a transaction that is rolled back: every check runs, nothing is kept. |
| `--cache-dir` | Responses of heights with money kept on disk (empty blocks are not), under `<chain id>-<hash of the RPC and LCD URLs>/`. Cached events carry the version of the event-reduction code in their name, so a change there never reads old files. |
| `--allow-empty-blocks` | Count a block with an empty event list as read (off: mainnet never has one). |
| `--localnet` | Required for `POCKETDEX_SETTLEMENT_ERA`, which is otherwise refused. Accepted only on chain `pocket` with a tip below 247,893 (localnet and mainnet share the chain id). |

Exit code 0 when the range is written, 1 when it stopped.

## Cost per era

From `.local/ab/eras/REPORT.md` §4 (settlement heights and `block_results` size, mainnet):

| Era | Heights | block_results | Notes |
|---|---|---|---|
| batched_vrd (788,945 →) | ~6,470 | 11–21 MB | LCD: validators + delegations at heights with staker rows |
| detailed_batch | 1,418 | 7–14 MB | LCD: validators + delegations at heights with settled claims (replay) |
| map_all_bonded_deflation (M5) | 1,122 | 0.8–1.45 GB | LCD: validators; + delegations at heights with settled claims (replay) |
| map_all_bonded (M4) | ~4,240 | 77–636 MB | LCD: validators; + delegations at heights with settled claims (replay) |
| map M1–M3 | ~2,240 | 23–26 MB | LCD only in map_proposer_operator (M3): as M4 |
| settlement_result (E0) | ~5,440 | 75 KB–25 MB | no LCD |

M4 and M5 are most of the bytes (0.5–2 TB, inferred). Measured on a developer machine far from the archive node: one
636 MB block downloaded in 58 s. Expect the M4/M5 stretch to take days at one worker. The other eras are hours.
None of these totals has been measured end to end. Mainnet's LCD (sauron-api) serves state from 168,810 on and
refuses heights 1 and 100 as pruned (2026-10-02): enough for every era that needs it.

## Memory

Per worker, for the largest block:

- **Download:** the body is held once. With `Content-Length` it is written into one buffer of that size; without
  it (mainnet's RPC sends none for `/block_results`) it goes to a file in the cache directory and is read back
  whole; a response cut short removes the file, and a new run removes the ones a stopped run on the same host left
  (files carry the host name and pid; another host's are never touched). Use one `--cache-dir` per host or
  container all the same. Up to 1.45 GB.
- **Parse:** blocks up to 256 MB are parsed with one `JSON.parse`. Above that, simdjson's `findChunkBoundaries`
  (the vendor fork, as in the indexer's `HttpClient`) splits `finalize_block_events` and each chunk is parsed and
  reduced before the next one. Never `lazyParse`. Measured on 699,993 (M5, 827 MB): 6.4 s and 4.0 GB peak RSS,
  download buffer included (`.local/ab/money/measure_parse.ts`).
- Then the payload and its JSON for the write.

Give node `--max-old-space-size` for about 5 GB per height in memory (workers + 1) on the M5 stretch; keep
`--workers 1` there (about 10 GB).

## Deploying a new rollup version

Each settlement height records the `ROLLUP_VERSION` (writer.ts) it was rolled up with. Rewriting a height written
with another version raises `run rebuild_rollups first`. After any `ROLLUP_VERSION` bump over tables that already
hold settlements, run `CALL <schema>.rebuild_rollups('<first month written>')` once, before reading the new rollup
columns or tables and before rewriting old heights. It recomputes every rollup height by height (estimated, not
measured: 8–10 h for all of mainnet) and holds the writer's lock while it runs.

First deploy to pnf: not needed. On 2026-10-02 neither `explorer-mainnet` nor `explorer-testnet` had the settlement
tables or `write_settlement` (checked on the replica, `pg-ha-cluster-1`), so the first write is already the current
version. This holds only while no indexer with the money layer has started against those databases: the indexer
creates the tables when it starts, so check again before the first deploy.

## Next to the live indexer

- `write_settlement` takes one advisory lock for the indexer and the job, with `lock_timeout` 30 s. A live block
  waiting behind a long history height fails after 30 s and SubQuery retries it. With the M5 blocks, watch the
  indexer's log for lock timeouts.
- **To pause:** stop the process (Ctrl-C). The height in progress rolls back, and the gap row still covers it.
  Start it again to resume.
- One job per schema: the session lock refuses a second one, and a run that finds the gap moved stops instead of
  writing. A Kubernetes pod replaced mid-run waits for the old session to end before it can take the lock.
- The lock is a session lock: connect **directly** to PostgreSQL, never through pgbouncer in transaction mode (the
  session would not be the job's). The CLI turns TCP keepalive on, so a session left by a pod that died without a
  RST ends once the keepalives fail; to free it at once, `SELECT pg_terminate_backend(pid) FROM pg_locks WHERE
  locktype = 'advisory' AND objid = hashtext('pocketdex.history.<schema>')::oid` (as superuser, on the primary).

## When a money check fails on the live indexer

A settlement block whose money cannot be written (the parser or one of its checks throws, or a chain read fails)
fails the whole block, and SubQuery retries it: the indexer does not get past that height until the
cause is fixed. To let it go on without that money, set `POCKETDEX_MONEY_FROM_HEIGHT` above the failing height and
redeploy (`src/mappings/money/write.ts`). The money step records its progress (`money_progress`) on every block it
processes, inside the block transaction, so the indexer must run with `--enable-cache=false` (production does: the
writer already needs it); without it the money step throws and the indexer stops. While the override skips, the
progress does not move, so the catalog functions report the skipped heights as not covered, whatever money event they hold, instead
of reading them as zero. The first height the money step processes past the override records them as the
`settlement_gaps` row `[progress + 1, O − 1]`.

Filling those heights depends on where they are. If the money step had processed nothing when the override was set (a
fresh database), no gap row is recorded: the skipped heights are below what it covers, and this job walks them. A gap
**above** written heights is not filled by this job today: it only owns the gap that starts at height 1 (`planGap` in
`job.ts`), so that range stays not covered until a tool to rewrite a middle range exists.

## Known limits

- **Setups outside the default** (documented, not handled in code):
  - `START_BLOCK` > 1 plus this job: the job writes heights the indexer never indexed, and coverage starts at the first
    indexed block at or after `money_progress.from_height`, so the history it writes below the indexer's start is
    written but reads as not covered.
  - The start-up seed (a database written before `money_progress` existed) on a database whose money started under an
    override, with money events (expirations, slashes, reimbursements) before the first settled claim: the seed takes
    the lowest written settlement or the chain's first settled claim as the start, and such earlier heights are not
    covered, or are covered with what was written there. The seed was checked on mainnet (the job's row exists: start
    one above it) and beta (no override start, no gap row, no money event below the first settlement, 3333: start at the
    first block), read-only, 2026-10-06.
  - A reindex from genesis with `POCKETDEX_MONEY_FROM_HEIGHT` still set: the heights below it are skipped again and the
    progress is pulled back once at the first of them, so what a previous run wrote below the override stays written but
    reads as not covered until the override is removed and those heights are processed again.

- **Discards the chain never emitted.** If `expiringClaimsIterator.Value()` fails (poktroll settle_pending_claims.go
  ~70) the claim is counted as discarded with no event; no block shows it. Only the claims identity (created =
  settled + expired + discarded + still in state) can bound it (council10-synthesis.md).
- **One archive.** `finalize_block_events` is not covered by `LastResultsHash` (CometBFT 0.38): nothing checks the
  archive's answer cryptographically.
- The params must be indexed for every map height (`params` versions whose `_block_range` holds it). A missing
  version stops the job at that height.
- Not run against pnf yet; the full run is meant as a Job in the pnf cluster. Tested against a fake archive serving
  the CI fixtures (`test/money/history.db.spec.ts`) and by range against mainnet's archive (`.local/ab/money/history/v2`).
