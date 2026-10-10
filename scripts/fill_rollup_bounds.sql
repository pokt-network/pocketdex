-- Fills the rollups' first_height / last_height for the settlement heights written before them
-- (settlement_blocks.bounds_rollup false), through fill_rollup_bounds (src/mappings/dbFunctions/settlement/bounds.ts):
-- the months newest first; per month each (rollup, day) in its own transaction, then the monthly rollups, then the month's
-- heights are marked. Readers answer NULL heights for a month until it is marked.
--
--   psql -v schema=mainnet -f scripts/fill_rollup_bounds.sql
--   psql -v schema=mainnet -v months=3 -v max_lag_seconds=2 -v pause_ms=200 -f scripts/fill_rollup_bounds.sql
--
-- Settings (psql -v): max_lag_seconds (5) and max_lag_bytes (67108864 = 64 MB): after every unit it waits while a replica
-- replays further behind than either; max_wal_bytes_per_minute (none): a pace for the WAL it writes; pause_ms (0): a pause
-- after every unit; months (all): how many months this run; suppliers_per_unit (200): the group of suppliers per unit of
-- the two monthly rollups filled from the base. It prints one line per unit (period, rollup, rows set, seconds, replica
-- lag), and the heights left unmarked at the end (0 when done).
--
-- Run it on the primary as the database superuser (kubectl exec ... psql -U postgres, as the other fills): it reads the
-- replicas' replay positions (pg_stat_replication), which a role without pg_monitor sees as NULL, and it stops instead of
-- running unthrottled then. Ctrl-C stops it cleanly: every unit is its own transaction, the one running is rolled back, and
-- running it again resumes after the days already done (the month's monthly units are redone).
\set ON_ERROR_STOP on
\if :{?max_lag_seconds} \else \set max_lag_seconds 5 \endif
\if :{?max_lag_bytes} \else \set max_lag_bytes 67108864 \endif
\if :{?max_wal_bytes_per_minute} \else \set max_wal_bytes_per_minute NULL \endif
\if :{?pause_ms} \else \set pause_ms 0 \endif
\if :{?months} \else \set months NULL \endif
\if :{?suppliers_per_unit} \else \set suppliers_per_unit 200 \endif
SET search_path = :schema;
CALL fill_rollup_bounds(max_lag_seconds => :max_lag_seconds, max_lag_bytes => :max_lag_bytes, pause_ms => :pause_ms,
                        max_wal_bytes_per_minute => :max_wal_bytes_per_minute, p_months => :months,
                        suppliers_per_unit => :suppliers_per_unit);
SELECT count(*) AS heights_unmarked FROM settlement_blocks WHERE NOT bounds_rollup;
