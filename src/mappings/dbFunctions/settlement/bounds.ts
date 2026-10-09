// The backfill of the rollups' first_height / last_height (schema.ts) for the settlement heights written before them:
// CALL fill_rollup_bounds(...) (scripts/fill_rollup_bounds.sql) walks the months that have a height without
// settlement_blocks.bounds_rollup, newest first. Per month: each day's daily and hourly rows, one rollup and one day per
// transaction, set from their base tables; then the monthly rows, from their daily twins or, for the two monthly rollups
// that have none, from the base by groups of suppliers; then the month's heights are marked. Every unit runs under the
// settlement writer's lock (taken as write_settlement takes it), sets only the rows whose bounds differ, and commits. A
// unit that set a day is recorded in rollup_bounds_fill, so a stopped run (Ctrl-C) resumes where it was; the monthly units
// are recomputed on a resume. Between units it waits while the replicas replay more than max_lag_seconds or
// max_lag_bytes behind the primary (pg_stat_replication, read live), and paces the WAL it writes when asked to.
// A reader trusts a row's bounds only once every height of its day, month or hour is marked (functions.ts), so a month
// in progress reads as NULL heights, never as a partial range.

// Per rollup filled by day: its key (with the period column), the period it is matched on, and the per-key lowest and
// highest height of [dlo, dhi] (the day's heights) from its base, as (key..., lo, hi).
interface DayFill {
  t: string;
  keys: string[];
  group: string;
}
// Per monthly rollup: from its daily twin (derived) or from the base for a group of suppliers (sups) over [mlo, mhi].
interface MonthFill {
  t: string;
  keys: string[];
  group: string;
  bySuppliers: boolean;
}

function dayFills(s: string): DayFill[] {
  const day = "height BETWEEN dlo AND dhi";
  return [
    {
      t: "daily_claims_by_application_service",
      keys: ["application_id", "service_id"],
      group: `SELECT application_id, service_id, min(height) lo, max(height) hi FROM ${s}.claim_settlements WHERE ${day} GROUP BY 1, 2`,
    },
    {
      t: "daily_claims_by_supplier",
      keys: ["supplier_id"],
      group: `SELECT supplier_id, min(height) lo, max(height) hi FROM ${s}.claim_settlements WHERE ${day} GROUP BY 1`,
    },
    {
      t: "daily_claims_by_supplier_application_service",
      keys: ["supplier_id", "application_id", "service_id"],
      group: `SELECT supplier_id, application_id, service_id, min(height) lo, max(height) hi FROM ${s}.claim_settlements
              WHERE ${day} GROUP BY 1, 2, 3`,
    },
    {
      t: "daily_income_by_address",
      keys: ["address", "role", "family"],
      group: `SELECT address, role, family, min(height) lo, max(height) hi FROM ${s}.v_income_base WHERE ${day} GROUP BY 1, 2, 3`,
    },
    {
      t: "daily_income_by_address_supplier",
      keys: ["supplier_id", "address", "role", "family"],
      group: `SELECT supplier_id, address, role, family, min(height) lo, max(height) hi FROM ${s}.v_income_base
              WHERE ${day} AND supplier_id <> '' GROUP BY 1, 2, 3, 4
              UNION ALL
              SELECT supplier_id, '', 'stakers', 'relay', min(height), max(height) FROM ${s}.claim_settlements WHERE ${day} GROUP BY 1`,
    },
    {
      t: "daily_income_by_address_service",
      keys: ["address", "role", "family", "service_id"],
      group: `SELECT address, role, family, service_id, min(height) lo, max(height) hi FROM ${s}.v_income_base
              WHERE ${day} AND service_id <> '' GROUP BY 1, 2, 3, 4`,
    },
    {
      // only the heights the rollup holds (settlement_blocks.claims_paid_rollup)
      t: "daily_claims_paid_by_address_service",
      keys: ["address", "service_id"],
      group: `SELECT p.address, c.service_id, min(p.height) lo, max(p.height) hi FROM ${s}.v_claims_paid p
              JOIN ${s}.claim_settlements c ON c.height = p.height AND c.event_idx = p.event_idx
              JOIN ${s}.settlement_blocks sb ON sb.height = p.height
              WHERE p.height BETWEEN dlo AND dhi AND sb.claims_paid_rollup GROUP BY 1, 2`,
    },
    {
      t: "daily_validator_rewards",
      keys: ["validator_operator", "family"],
      group: `SELECT validator_operator, family, min(height) lo, max(height) hi FROM ${s}.validator_distributions WHERE ${day} GROUP BY 1, 2`,
    },
    {
      t: "daily_delegator_rewards_by_validator",
      keys: ["delegator", "validator_operator", "family"],
      group: `SELECT delegator, validator_operator, family, min(height) lo, max(height) hi FROM ${s}.delegator_validator_payouts
              WHERE ${day} GROUP BY 1, 2, 3`,
    },
    {
      // matched on the hour (keys), not on the day
      t: "hourly_income_by_address_supplier",
      keys: ["address", "supplier_id", "hour"],
      group: `SELECT v.address, v.supplier_id, date_trunc('hour', sb.block_time, 'UTC') AS hour, min(v.height) lo, max(v.height) hi
              FROM ${s}.v_income_base v JOIN ${s}.settlement_blocks sb USING (height)
              WHERE v.height BETWEEN dlo AND dhi AND v.supplier_id <> '' GROUP BY 1, 2, 3`,
    },
  ];
}

function monthFills(s: string): MonthFill[] {
  const fromDays = (twin: string, keys: string[], where = "") =>
    `SELECT ${keys.join(", ")}, CASE WHEN count(*) = count(first_height) THEN min(first_height) END lo,
            CASE WHEN count(*) = count(last_height) THEN max(last_height) END hi
     FROM ${s}.${twin} WHERE day >= m AND day < m2 ${where} GROUP BY ${keys.join(", ")}`;
  return [
    {
      t: "monthly_income_by_address_supplier",
      keys: ["supplier_id", "address", "role", "family"],
      group: fromDays(
        "daily_income_by_address_supplier",
        ["supplier_id", "address", "role", "family"],
        "AND role <> 'stakers'"
      ),
      bySuppliers: false,
    },
    {
      t: "monthly_income_by_address_service",
      keys: ["address", "role", "family", "service_id"],
      group: fromDays("daily_income_by_address_service", ["address", "role", "family", "service_id"]),
      bySuppliers: false,
    },
    {
      // only the heights the rollup holds (settlement_blocks.monthly_claims_rollup)
      t: "monthly_claims_by_supplier_service",
      keys: ["supplier_id", "service_id"],
      group: `SELECT c.supplier_id, c.service_id, min(c.height) lo, max(c.height) hi FROM ${s}.claim_settlements c
              JOIN ${s}.settlement_blocks sb ON sb.height = c.height
              WHERE c.supplier_id = ANY(sups) AND c.height BETWEEN mlo AND mhi AND sb.monthly_claims_rollup GROUP BY 1, 2`,
      bySuppliers: true,
    },
    {
      t: "monthly_income_by_address_supplier_service",
      keys: ["address", "supplier_id", "service_id", "role", "family"],
      group: `SELECT address, supplier_id, service_id, role, family, min(height) lo, max(height) hi FROM ${s}.v_income_base
              WHERE supplier_id = ANY(sups) AND height BETWEEN mlo AND mhi AND service_id <> '' GROUP BY 1, 2, 3, 4, 5`,
      bySuppliers: true,
    },
  ];
}

// Sets the bounds of the rows whose bounds differ from the group's: each row found by its key (a probe per key, LIMIT 1,
// never a scan of the rollup) and updated by its ctid.
function setBounds(s: string, t: string, keys: string[], group: string, period: string) {
  return `UPDATE ${s}.${t} t SET first_height = x.lo, last_height = x.hi
    FROM (SELECT x.lo, x.hi, r.tid FROM (${group}) x
          CROSS JOIN LATERAL (SELECT r.ctid tid, r.first_height f, r.last_height l FROM ${s}.${t} r
                              WHERE ${keys.map((k) => `r.${k} = x.${k}`).join(" AND ")}${
    period ? ` AND r.${period}` : ""
  } LIMIT 1) r
          WHERE r.f IS DISTINCT FROM x.lo OR r.l IS DISTINCT FROM x.hi) x
    WHERE t.ctid = x.tid`;
}

// The DDL: the unit function, the replica lag reader, the throttle and the driver.
export function createRollupBoundsFillFn(s: string, writerLock: string): string {
  const days = dayFills(s);
  const months = monthFills(s);
  const dayUnit = days
    .map(
      (f, i) => `  ${i === 0 ? "IF" : "ELSIF"} p_unit = '${f.t}' THEN
    ${setBounds(s, f.t, f.keys, f.group, f.t.startsWith("hourly_") ? "" : "day = p_period")};`
    )
    .join("\n");
  const monthUnit = months
    .map(
      (f) => `  ELSIF p_unit = '${f.t}' THEN
    ${setBounds(s, f.t, f.keys, f.group, "month = m")};`
    )
    .join("\n");
  const sqlList = (xs: string[]) => `ARRAY[${xs.map((x) => `'${x}'`).join(", ")}]::text[]`;
  return `
-- The settlement writer's lock, waited for as write_settlement waits (30 s a try whatever the session's lock_timeout), up
-- to 10 tries: the indexer and the history job hold it one height at a time.
CREATE OR REPLACE FUNCTION ${s}._writer_lock() RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_lock_timeout text := current_setting('lock_timeout');
BEGIN
  FOR i IN 1..10 LOOP
    BEGIN
      PERFORM set_config('lock_timeout', '30s', true);
      PERFORM pg_advisory_xact_lock(hashtext('${writerLock}'));
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      IF i = 10 THEN RAISE; END IF;
    END;
  END LOOP;
  PERFORM set_config('lock_timeout', v_lock_timeout, true);
END $$;

-- One unit of fill_rollup_bounds: the bounds of one rollup for one day (p_period, daily and hourly rollups) or one month
-- (p_period, the first day: monthly rollups; p_suppliers the group of suppliers for the two filled from the base).
-- Under the writer's lock. Returns the rows it set.
CREATE OR REPLACE FUNCTION ${s}._fill_rollup_bounds_unit(p_unit text, p_period date, p_suppliers text[] DEFAULT NULL)
RETURNS bigint LANGUAGE plpgsql SET plan_cache_mode = force_custom_plan AS $$
DECLARE n bigint; dlo bigint; dhi bigint; mlo bigint; mhi bigint; sups text[] := p_suppliers;
  m date := date_trunc('month', p_period::timestamp)::date; m2 date := (date_trunc('month', p_period::timestamp) + interval '1 month')::date;
BEGIN
  PERFORM ${s}._writer_lock();
  SELECT min(height), max(height) INTO dlo, dhi FROM ${s}.settlement_blocks WHERE day = p_period;
  SELECT min(height), max(height) INTO mlo, mhi FROM ${s}.settlement_blocks WHERE day >= m AND day < m2;
${dayUnit}
${monthUnit}
  ELSE
    RAISE EXCEPTION 'fill_rollup_bounds: no unit %', p_unit;
  END IF;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

-- How far behind the primary its replicas replay, read live (pg_stat_get_wal_senders, not the per-transaction snapshot of
-- pg_stat_activity): senders, how many of them show a replay position (a role without pg_monitor sees NULL), the
-- largest replay_lag in seconds and the largest distance in bytes from the current WAL position. A replica that has
-- replayed everything counts 0 s: replay_lag keeps its last measure for a while once the WAL goes quiet (measured on a
-- local delayed replica: 4.0 s shown for ~10 s with 0 bytes left).
CREATE OR REPLACE FUNCTION ${s}._replica_lag(OUT senders int, OUT readable int, OUT lag_seconds numeric, OUT lag_bytes numeric)
LANGUAGE sql VOLATILE AS $$
  SELECT count(*)::int, count(w.replay_lsn)::int,
         coalesce(max(CASE WHEN w.replay_lsn >= pg_current_wal_lsn() THEN 0 ELSE extract(epoch FROM w.replay_lag) END), 0),
         coalesce(max(pg_wal_lsn_diff(pg_current_wal_lsn(), w.replay_lsn)), 0)
  FROM pg_stat_get_wal_senders() w
$$;

-- Waits, one second at a time and committing between them (no snapshot held while waiting), while a replica is more than
-- max_lag_seconds or max_lag_bytes behind; then while the WAL written in the current minute is above
-- max_wal_bytes_per_minute (NULL: no pace). Raises when the replicas' positions cannot be read: the fill would otherwise
-- run unthrottled. Returns in waited the seconds it waited.
CREATE OR REPLACE PROCEDURE ${s}._fill_throttle(max_lag_seconds numeric, max_lag_bytes numeric, max_wal_bytes_per_minute numeric,
  INOUT window_start timestamptz, INOUT window_lsn pg_lsn, INOUT waited numeric)
LANGUAGE plpgsql AS $$
DECLARE r record; t0 timestamptz := clock_timestamp();
BEGIN
  LOOP
    r := ${s}._replica_lag();
    IF r.readable < r.senders THEN
      RAISE EXCEPTION 'fill_rollup_bounds: the replicas'' replay positions are not readable by this role (pg_monitor or a superuser needed)';
    END IF;
    EXIT WHEN r.lag_seconds <= max_lag_seconds AND r.lag_bytes <= max_lag_bytes;
    RAISE NOTICE 'fill_rollup_bounds: waiting, replica % s and % MB behind', round(r.lag_seconds, 1), round(r.lag_bytes / 1048576, 1);
    PERFORM pg_sleep(1);
    COMMIT;
  END LOOP;
  IF max_wal_bytes_per_minute IS NOT NULL THEN
    IF clock_timestamp() - window_start >= interval '1 minute' THEN
      window_start := clock_timestamp(); window_lsn := pg_current_wal_lsn();
    ELSIF pg_wal_lsn_diff(pg_current_wal_lsn(), window_lsn) > max_wal_bytes_per_minute THEN
      RAISE NOTICE 'fill_rollup_bounds: % MB of WAL this minute, pausing until it ends',
        round(pg_wal_lsn_diff(pg_current_wal_lsn(), window_lsn) / 1048576, 1);
      WHILE clock_timestamp() - window_start < interval '1 minute' LOOP
        PERFORM pg_sleep(1);
        COMMIT;
      END LOOP;
      window_start := clock_timestamp(); window_lsn := pg_current_wal_lsn();
    END IF;
  END IF;
  waited := extract(epoch FROM clock_timestamp() - t0);
END $$;

-- The driver (scripts/fill_rollup_bounds.sql). p_months: at most that many months this run (NULL: all). suppliers_per_unit:
-- the group of suppliers a monthly unit from the base takes. pause_ms: a pause after every unit.
CREATE OR REPLACE PROCEDURE ${s}.fill_rollup_bounds(max_lag_seconds numeric DEFAULT 5, max_lag_bytes numeric DEFAULT 67108864,
  pause_ms integer DEFAULT 0, max_wal_bytes_per_minute numeric DEFAULT NULL, p_months integer DEFAULT NULL,
  suppliers_per_unit integer DEFAULT 200)
LANGUAGE plpgsql AS $$
DECLARE m date; d date; u text; n bigint; t0 timestamptz; done integer := 0; sups text[]; k integer;
  ws timestamptz := clock_timestamp(); wl pg_lsn := pg_current_wal_lsn(); waited numeric := 0; r record;
BEGIN
  FOR m IN SELECT DISTINCT date_trunc('month', sb.day::timestamp)::date FROM ${s}.settlement_blocks sb WHERE NOT sb.bounds_rollup
           ORDER BY 1 DESC LOOP
    EXIT WHEN p_months IS NOT NULL AND done >= p_months;
    -- the days, newest first; each (rollup, day) once, also across runs
    FOR d IN SELECT DISTINCT sb.day FROM ${s}.settlement_blocks sb
             WHERE sb.day >= m AND sb.day < (m + interval '1 month')::date ORDER BY 1 DESC LOOP
      FOREACH u IN ARRAY ${sqlList(days.map((f) => f.t))} LOOP
        CONTINUE WHEN EXISTS (SELECT 1 FROM ${s}.rollup_bounds_fill f WHERE f.month = m AND f.unit = u || ' ' || d);
        t0 := clock_timestamp();
        n := ${s}._fill_rollup_bounds_unit(u, d);
        INSERT INTO ${s}.rollup_bounds_fill VALUES (m, u || ' ' || d);
        COMMIT;
        r := ${s}._replica_lag();
        RAISE NOTICE 'fill_rollup_bounds: % % % rows in % s, replica % s / % MB behind', d, u, n,
          round(extract(epoch FROM clock_timestamp() - t0), 2), round(r.lag_seconds, 1), round(r.lag_bytes / 1048576, 1);
        IF pause_ms > 0 THEN PERFORM pg_sleep(pause_ms / 1000.0); COMMIT; END IF;
        CALL ${s}._fill_throttle(max_lag_seconds, max_lag_bytes, max_wal_bytes_per_minute, ws, wl, waited);
      END LOOP;
    END LOOP;
    -- the monthly rows: after every day of the month; the ones from the base by groups of suppliers
    FOREACH u IN ARRAY ${sqlList(months.map((f) => f.t))} LOOP
      k := 0;
      FOR sups IN SELECT NULL::text[] WHERE u <> ALL(${sqlList(months.filter((f) => f.bySuppliers).map((f) => f.t))})
                  UNION ALL
                  SELECT array_agg(x.supplier_id ORDER BY x.supplier_id)
                  FROM (SELECT supplier_id, (row_number() OVER (ORDER BY supplier_id) - 1) / suppliers_per_unit g
                        FROM (SELECT DISTINCT supplier_id FROM ${s}.daily_claims_by_supplier
                              WHERE day >= m AND day < (m + interval '1 month')::date) y) x
                  WHERE u = ANY(${sqlList(months.filter((f) => f.bySuppliers).map((f) => f.t))})
                  GROUP BY x.g LOOP
        k := k + 1;
        t0 := clock_timestamp();
        n := ${s}._fill_rollup_bounds_unit(u, m, sups);
        COMMIT;
        r := ${s}._replica_lag();
        RAISE NOTICE 'fill_rollup_bounds: % % (part %) % rows in % s, replica % s / % MB behind', to_char(m, 'YYYY-MM'), u, k, n,
          round(extract(epoch FROM clock_timestamp() - t0), 2), round(r.lag_seconds, 1), round(r.lag_bytes / 1048576, 1);
        IF pause_ms > 0 THEN PERFORM pg_sleep(pause_ms / 1000.0); COMMIT; END IF;
        CALL ${s}._fill_throttle(max_lag_seconds, max_lag_bytes, max_wal_bytes_per_minute, ws, wl, waited);
      END LOOP;
    END LOOP;
    -- the month's heights: their bounds are held
    PERFORM ${s}._writer_lock();
    UPDATE ${s}.settlement_blocks SET bounds_rollup = true
    WHERE day >= m AND day < (m + interval '1 month')::date AND NOT bounds_rollup;
    GET DIAGNOSTICS n = ROW_COUNT;
    DELETE FROM ${s}.rollup_bounds_fill WHERE month = m;
    COMMIT;
    RAISE NOTICE 'fill_rollup_bounds: % done, % heights marked', to_char(m, 'YYYY-MM'), n;
    done := done + 1;
  END LOOP;
END $$;
`;
}
