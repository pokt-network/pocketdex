import type { SettlementPayload } from "../../money/payload";

// write_settlement(h, payload) writes one settlement height into the tables of ./schema.ts and adds its
// contribution to the rollups. It is the only writer of those tables: the indexer calls it inside the
// block transaction, and history jobs call it one height per transaction. Writing a height that is
// already there first subtracts its old contribution, then rewrites it, so a block retry or a reindex
// leaves the same rows. A history job that writes the heights of a settlement_gaps row (./schema.ts)
// deletes that row in the same transaction as its last height.
//
// The payload is built by src/mappings/money/payload.ts and arrives as one jsonb bind parameter, or in parts
// when it has more than MAX_ROWS_PER_CALL rows (writeSettlementCalls). Chain
// strings only reach SQL through jsonb_to_recordset: no EXECUTE and no format() in these procedures.
//
// Every check raises, which fails the block. The identities checked are ones the chain emits itself
// (verified on mainnet 943,373 / 943,393 / 943,413):
// - the detailed rows of all claims, summed per (op_reason, recipient), equal the batch mod_to_acct rows;
// - per claim, the reimbursement request equals the claim's escrow-to-DAO leg;
// - Σ relay_to_stakers_upokt (minted minus the claim's relay legs) equals the batch relay validator and delegator rows,
//   and both families of those rows equal the validator distributions' pool shares.
// One exception, by the chain's design: poktroll v0.1.29–v0.1.33 paid a shareholder address listed twice in a
// supplier's rev share once per entry (mainnet 690,685–716,533, one supplier; map.ts takeShareholders). Its legs then
// exceed the shareholders' slice, so what they leave of the mint is not the stakers' share: the readers of those eras
// send each claim's share by the chain's rule (relay_to_stakers), and R1 below admits a difference only there.

// Bump when a rollup is added or computed differently. A height written under another version cannot be
// rewritten (its subtraction would use the new rules on rows added under the old ones); rebuild the
// rollups from the base tables with rebuild_rollups first.
// 2: daily_claims_by_supplier.claims_with_proof, and daily_validator_rewards.commission_na_count.
// 3: monthly_income_by_address_supplier_service.
// 4: daily_delegator_rewards_by_validator.replayed_count.
// daily_claims_paid_by_address_service came later without a bump (a bump makes every rollup read raise until
// rebuild_rollups ends): settlement_blocks.claims_paid_rollup says per height whether it holds that height (schema.ts).
// So did monthly_claims_by_supplier_service, with settlement_blocks.monthly_claims_rollup.
export const ROLLUP_VERSION = 4;

// The roles of staker_payouts (the batch staker rows and, in the settlement_result era, the proposer's legs): the income
// of validators and delegators, which no claim pays them (v_claims_paid does not read staker_payouts).
const STAKER_ROLES = ["validator", "delegator"] as const;
// as a SQL list: 'validator', 'delegator'
export const STAKER_ROLES_SQL = STAKER_ROLES.map((r) => `'${r}'`).join(", ");

export const writeSettlementProcName = "write_settlement";

// Rows per CALL. The largest mainnet settlement sampled (885,513: 4,172 claims) is ~38k rows and 9.4 MB of
// JSON, so today every height goes in one call. A bigger one goes in parts: one bind parameter must stay far
// from jsonb's size cap (~256 MB) and from V8's string length limit.
export const MAX_ROWS_PER_CALL = 50000;

// The money step's bookkeeping, in the block transaction before a height's money (src/mappings/money/write.ts), one
// statement:
// - with a POCKETDEX_MONEY_FROM_HEIGHT override, the heights it skipped, [progress + 1, override - 1], as a
//   settlement_gaps row (a no-op once the progress is past them, or before the money step processed any height:
//   then they are below what it covers anyway). It starts no lower than from_height: a skip can pull the progress
//   below it, and the heights under from_height are the history job's, which no override row may claim;
// - an override hole (a gap row not starting at 1) the height falls in: trimmed to end below it, deleted when it starts
//   there (the money step processes it now: a rewind, or an override lowered). The history job's row is never touched;
// - the progress, set to the height (money_progress).
// Every part reads the state from before the statement (one snapshot), so the gap starts above the old progress.
export function recordMoneyProgressCall(s: string, height: number, override: number): WriterCall {
  return {
    sql: `WITH gap AS (
       INSERT INTO ${s}.settlement_gaps (from_height, to_height)
       SELECT greatest(mp.height + 1, mp.from_height), $2::bigint - 1 FROM ${s}.money_progress mp
       WHERE $2::bigint > 0 AND greatest(mp.height + 1, mp.from_height) <= $2::bigint - 1
       -- two overrides past a rewind below from_height start at the same height: the later one extends the row (never
       -- the history job's, which starts at 1)
       ON CONFLICT (from_height) DO UPDATE SET to_height = greatest(settlement_gaps.to_height, EXCLUDED.to_height)
       WHERE settlement_gaps.from_height <> 1
       RETURNING 1
     ), dropped AS (
       DELETE FROM ${s}.settlement_gaps WHERE from_height <> 1 AND from_height = $1::bigint RETURNING 1
     ), trimmed AS (
       UPDATE ${s}.settlement_gaps SET to_height = $1::bigint - 1
       WHERE from_height <> 1 AND from_height < $1::bigint AND to_height >= $1::bigint RETURNING 1
     )
     INSERT INTO ${s}.money_progress AS mp (id, from_height, height) VALUES (true, $1, $1)
     ON CONFLICT (id) DO UPDATE SET height = EXCLUDED.height, from_height = least(mp.from_height, EXCLUDED.height)`,
    bind: [height, override],
  };
}

// A height the money step skips under a POCKETDEX_MONEY_FROM_HEIGHT override: the progress goes back below it if it was
// above (a rewind into the skipped heights), so the gap recorded past the override starts right after what is really
// processed.
export function recordMoneySkipCall(s: string, height: number): WriterCall {
  return {
    sql: `UPDATE ${s}.money_progress SET height = $1::bigint - 1 WHERE height > $1::bigint - 1`,
    bind: [height],
  };
}

const PAYLOAD_ARRAYS = [
  "claims",
  "detailed",
  "batch",
  "vrd",
  "reimb",
  "expired",
  "discarded",
  "slashed",
  "dv",
] as const;

export interface WriterCall {
  sql: string;
  bind: Array<number | string>;
}

// The statements that write one height, in order: _stage_settlement for every part but the last, then
// write_settlement with the last part, ts, era and row_source. Each part holds at most maxRows rows.
export function writeSettlementCalls(
  dbSchema: string,
  height: number,
  payload: SettlementPayload,
  maxRows = MAX_ROWS_PER_CALL
): WriterCall[] {
  const writeCall = (part: object): WriterCall => ({
    sql: `CALL ${dbSchema}.${writeSettlementProcName}($1::bigint, $2::jsonb)`,
    bind: [height, JSON.stringify(part)],
  });
  const total = PAYLOAD_ARRAYS.reduce((n, key) => n + payload[key].length, 0);
  // the rows of every array the whole height must have staged once the last part is in: write_settlement checks
  // them, so a part lost between calls (outside one transaction the staging tables drop at commit) stops the block
  const counts = Object.fromEntries(PAYLOAD_ARRAYS.map((key) => [key, payload[key].length]));
  if (total <= maxRows) return [writeCall({ ...payload, counts })];
  const parts: Array<Record<string, unknown[]>> = [{}];
  let rows = 0;
  for (const key of PAYLOAD_ARRAYS) {
    const all: unknown[] = payload[key];
    for (let i = 0; i < all.length; ) {
      if (rows === maxRows) {
        parts.push({});
        rows = 0;
      }
      const take = all.slice(i, i + maxRows - rows);
      const part = parts[parts.length - 1];
      part[key] = (part[key] ?? []).concat(take);
      rows += take.length;
      i += take.length;
    }
  }
  const last = parts.pop() as Record<string, unknown[]>;
  return [
    ...parts.map((part) => ({ sql: `CALL ${dbSchema}._stage_settlement($1::jsonb)`, bind: [JSON.stringify(part)] })),
    writeCall({ ...last, ts: payload.ts, era: payload.era, row_source: payload.row_source, counts }),
  ];
}

// The drift check of a subtraction, fed by the upserts themselves: on a subtraction (sg < 0) each rollup's INSERT ...
// ON CONFLICT DO UPDATE returns the rows it wrote as they are after it, so the check reads exactly the rows the height
// touched, with no second read of the table. No measure may go below 0, and a row whose contributions are all gone must
// have every measure back at 0 (its measures: the columns its ON CONFLICT sets, read from its SQL, so a new column is
// checked too), on top of the invariants between columns each rollup states: anything else means it was added under
// other rules than the ones subtracting it now. The error names the rollup, the row's key and the first rule it breaks.
// The rows left at zero contributions then go by their ctid among the returned rows: the height's keys and nothing
// else, with nothing to plan (a join of the keys to monthly_income_by_address_supplier_service, which has no month
// index, planned under statistics without zero rows a scan of the whole table per row left at zero: 57 s for one
// subtraction locally). An add (every new height, every height of rebuild_rollups) runs the plain upserts.
//
// Not swept any more, by decision: a zero row the height did not touch, which only a bug or a hand edit leaves (the
// writer deletes its own); rebuild_rollups rewrites it. monthly_claims_by_supplier_service and
// daily_claims_paid_by_address_service are written only for a held height, so a height not held leaves their rows as
// they are; fill_monthly_claims_month and fill_claims_paid_day rewrite a whole month or day, without its zero rows.
interface Checked {
  t: string;
  // its key without the period, as the error names it
  keys: string[];
  // its count of contributions: a row at 0 of it holds nothing
  count: string;
  // its invariants between columns (every measure at 0 or above, and at 0 with the count, are generated)
  rules: string[];
  // INSERT ... ON CONFLICT DO UPDATE SET ..., without RETURNING or ';'
  sql: string;
}
// the columns its ON CONFLICT DO UPDATE sets: its SET list split at the commas outside parentheses and CASE ... END, each
// item "column = ..."; anything else stops the generation
function measures(t: string, sql: string): string[] {
  const set = sql.slice(sql.indexOf("DO UPDATE")).replace(/^DO UPDATE\s+SET\b/, "");
  const items = [""];
  let depth = 0;
  for (const part of set.split(/(\bCASE\b|\bEND\b|[(),])/i)) {
    const word = part.toUpperCase();
    if (word === "CASE" || part === "(") depth++;
    if (word === "END" || part === ")") depth--;
    if (part === "," && depth === 0) items.push("");
    else items[items.length - 1] += part;
  }
  if (depth !== 0) throw new Error(`${t}: its SET list does not balance its parentheses and CASE ... END (depth ${depth} at its end)`);
  return items.map((item) => {
    const m = /^\s*(\w+)\s*=[^=]/.exec(item);
    if (!m) throw new Error(`${t}: cannot read a measure from its SET item "${item.trim()}"`);
    return m[1];
  });
}
function checkRules(u: Checked): string[] {
  const set = measures(u.t, u.sql);
  if (!set.includes(u.count)) throw new Error(`${u.t}: its ON CONFLICT does not set ${u.count}`);
  const others = set.filter((m) => m !== u.count);
  return [`${u.count} < 0`, ...others.map((m) => `${m} < 0`), ...u.rules, ...others.map((m) => `${u.count} = 0 AND ${m} <> 0`)];
}
const literal = (x: string) => `'${x.replace(/'/g, "''")}'`;
// v_zero1 .. v_zero<MAX_CHECKED> in _rollup_apply
const MAX_CHECKED = 2;
// The upserts of one statement after an optional prelude of plain CTEs: each a CTE r1, r2, ... but the last, which a later
// one may read. Plain on an add; on a subtraction checked, then cleared of their rows left at zero.
function upserts(s: string, prelude: string, list: Checked[]): string {
  if (list.length > MAX_CHECKED) throw new Error(`at most ${MAX_CHECKED} upserts in one statement`);
  const head = prelude ? [prelude] : [];
  const plain =
    list.length === 1 && !prelude
      ? `${list[0].sql};`
      : `WITH ${[...head, ...list.slice(0, -1).map((u, i) => `r${i + 1} AS (${u.sql})`)].join(", ")}
  ${list[list.length - 1].sql};`;
  const returning = list.map(
    (u, i) => `r${i + 1} AS (${u.sql}
    RETURNING ${literal(u.t)}::text AS rollup, concat_ws(' / ', ${u.keys.join(", ")}) AS row_key,
      CASE ${checkRules(u).map((r) => `WHEN ${r} THEN ${literal(r)}`).join(" ")} END AS broken,
      CASE WHEN ${u.count} = 0 THEN ctid END AS zero_row)`
  );
  const rows = list.length === 1 ? "r1" : `(${list.map((_, i) => `TABLE r${i + 1}`).join(" UNION ALL ")}) r`;
  return `IF sg < 0 THEN
  WITH ${[...head, ...returning].join(", ")}
  SELECT (SELECT format('%s row %s has %s', rollup, row_key, broken) FROM ${rows} WHERE broken IS NOT NULL LIMIT 1),
         ${list.map((_, i) => `ARRAY(SELECT zero_row FROM r${i + 1} WHERE zero_row IS NOT NULL)`).join(", ")}
  INTO v_drift, ${list.map((_, i) => `v_zero${i + 1}`).join(", ")};
  IF v_drift IS NOT NULL THEN
    RAISE EXCEPTION 'rollup drift at height %: % after subtracting the height', h, v_drift;
  END IF;
${list
  .map(
    (u, i) => `  IF cardinality(v_zero${i + 1}) > 0 THEN
    DELETE FROM ${s}.${u.t} WHERE ctid = ANY(v_zero${i + 1}) AND ${u.count} = 0;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    IF v_n <> cardinality(v_zero${i + 1}) THEN
      RAISE EXCEPTION 'rollup cleanup at height %: % deleted % of its % rows left at zero', h, ${literal(u.t)}, v_n, cardinality(v_zero${i + 1});
    END IF;
  END IF;`
  )
  .join("\n")}
  ELSE
  ${plain}
  END IF;`;
}
const CLAIMS = ["claims_with_proof > claim_count"];
const MONTHLY_CLAIMS = ["claims_with_proof > claim_count"];
const DELEGATOR = ["replayed_count > contribution_count"];
// with no contribution that has a commission left, what is left of the commission must be 0 (it becomes NULL below);
// anything else was added under other rules
const VALIDATOR = ["commission_na_count > contribution_count",
                   "commission_na_count = contribution_count AND coalesce(commission_upokt, 0) <> 0"];

export function createSettlementWriterFn(dbSchema: string): string {
  const s = dbSchema;
  return `
CREATE OR REPLACE VIEW ${s}.v_income_base AS
SELECT sp.height, sp.recipient_id AS address, 'rev_share'::text AS role, 'relay'::text AS family, sp.supplier_id,
       sp.service_id, sp.relay_upokt AS amount_upokt, 1 AS transfer_count
FROM ${s}.shareholder_payouts sp WHERE sp.relay_upokt > 0
UNION ALL
SELECT sp.height, sp.recipient_id, 'rev_share', 'global', sp.supplier_id, sp.service_id, sp.global_upokt, 1
FROM ${s}.shareholder_payouts sp WHERE sp.global_upokt > 0
UNION ALL
SELECT c.height, sb.dao_address, 'dao', 'relay', c.supplier_id, c.service_id, c.relay_to_dao_upokt, 1
FROM ${s}.claim_settlements c JOIN ${s}.settlement_blocks sb USING (height) WHERE c.relay_to_dao_upokt > 0
UNION ALL
SELECT c.height, sb.dao_address, 'dao', 'global', c.supplier_id, c.service_id, c.global_to_dao_upokt, 1
FROM ${s}.claim_settlements c JOIN ${s}.settlement_blocks sb USING (height) WHERE c.global_to_dao_upokt > 0
UNION ALL
SELECT c.height, sb.dao_address, 'dao', 'reimb_escrow', c.supplier_id, c.service_id, c.reimbursement_to_dao_upokt, 1
FROM ${s}.claim_settlements c JOIN ${s}.settlement_blocks sb USING (height) WHERE c.reimbursement_to_dao_upokt > 0
UNION ALL
SELECT c.height, c.source_owner_id, 'source_owner', 'relay', c.supplier_id, c.service_id, c.relay_to_source_owner_upokt, 1
FROM ${s}.claim_settlements c WHERE c.relay_to_source_owner_upokt > 0
UNION ALL
SELECT c.height, c.source_owner_id, 'source_owner', 'global', c.supplier_id, c.service_id, c.global_to_source_owner_upokt, 1
FROM ${s}.claim_settlements c WHERE c.global_to_source_owner_upokt > 0
UNION ALL
SELECT c.height, c.application_id, 'application', 'relay', c.supplier_id, c.service_id, c.relay_to_application_upokt, 1
FROM ${s}.claim_settlements c WHERE c.relay_to_application_upokt > 0
UNION ALL
SELECT c.height, c.application_id, 'application', 'global', c.supplier_id, c.service_id, c.global_to_application_upokt, 1
FROM ${s}.claim_settlements c WHERE c.global_to_application_upokt > 0
UNION ALL
SELECT p.height, p.recipient_id, p.role, p.family, '', '', p.amount_upokt, 1
FROM ${s}.staker_payouts p;

-- The claims that paid an address, once per (address, claim): the claim branches of v_income_base (a shareholder leg, the
-- DAO, the service owner, the application) with an amount above 0. daily_claims_paid_by_address_service and
-- legacy_rewards_by_addresses_and_time_group_by_service both read it.
CREATE OR REPLACE VIEW ${s}.v_claims_paid AS
SELECT sp.recipient_id AS address, sp.height, sp.event_idx
FROM ${s}.shareholder_payouts sp WHERE sp.relay_upokt > 0 OR sp.global_upokt > 0
UNION
SELECT sb.dao_address, c.height, c.event_idx
FROM ${s}.claim_settlements c JOIN ${s}.settlement_blocks sb USING (height)
WHERE c.relay_to_dao_upokt > 0 OR c.global_to_dao_upokt > 0 OR c.reimbursement_to_dao_upokt > 0
UNION
SELECT c.source_owner_id, c.height, c.event_idx
FROM ${s}.claim_settlements c WHERE c.relay_to_source_owner_upokt > 0 OR c.global_to_source_owner_upokt > 0
UNION
SELECT c.application_id, c.height, c.event_idx
FROM ${s}.claim_settlements c WHERE c.relay_to_application_upokt > 0 OR c.global_to_application_upokt > 0;

-- Adds (sg = 1) or subtracts (sg = -1) the contribution of height h to every rollup.
CREATE OR REPLACE PROCEDURE ${s}._rollup_apply(h bigint, sg int) LANGUAGE plpgsql AS $$
DECLARE d date; hr timestamptz; v_held boolean; v_month_held boolean; v_drift text; v_n bigint;
  ${Array.from({ length: MAX_CHECKED }, (_, i) => `v_zero${i + 1} tid[];`).join(" ")}
BEGIN
  SELECT day, date_trunc('hour', block_time, 'UTC'), claims_paid_rollup, monthly_claims_rollup INTO d, hr, v_held, v_month_held
  FROM ${s}.settlement_blocks WHERE height = h;
  IF d IS NULL THEN RETURN; END IF;

  -- the claims that paid each address at h, per service: added and subtracted only for a held height
  -- (settlement_blocks.claims_paid_rollup; write_settlement and rebuild_rollups decide it before calling here)
  CREATE TEMP TABLE IF NOT EXISTS _paid (address text, service_id text, claim_count bigint, settled_upokt bigint,
                                         relays bigint, estimated_relays bigint, claimed_compute_units bigint,
                                         estimated_compute_units bigint) ON COMMIT DROP;
  TRUNCATE _paid;
  IF v_held THEN
    INSERT INTO _paid
    SELECT p.address, c.service_id, count(*), sum(c.settled_upokt), sum(c.relays), sum(c.estimated_relays),
           sum(c.claimed_compute_units), sum(c.estimated_compute_units)
    FROM ${s}.v_claims_paid p JOIN ${s}.claim_settlements c ON c.height = p.height AND c.event_idx = p.event_idx
    WHERE p.height = h GROUP BY p.address, c.service_id;
  END IF;

  CREATE TEMP TABLE IF NOT EXISTS _inc (address text, role text, family text, supplier_id text, service_id text,
                                        amount_upokt bigint, transfer_count bigint, contribution_count bigint) ON COMMIT DROP;
  TRUNCATE _inc;
  INSERT INTO _inc
  SELECT address, role, family, supplier_id, service_id, sum(amount_upokt), sum(transfer_count), count(*)
  FROM ${s}.v_income_base WHERE height = h
  GROUP BY address, role, family, supplier_id, service_id;

  -- per settlement: not incremental, a height owns its rows
  IF sg < 0 THEN
    DELETE FROM ${s}.settlement_income_by_address WHERE height = h;
    DELETE FROM ${s}.settlement_supply_flows WHERE height = h;
    DELETE FROM ${s}.settlement_claims_by_application_service WHERE height = h;
  ELSE
    INSERT INTO ${s}.settlement_claims_by_application_service
    SELECT h, min(block_time), application_id, service_id, count(*), sum(claimed_upokt), sum(settled_upokt), sum(overservicing_loss_upokt),
           sum(global_minted_upokt), sum(relays), sum(estimated_relays), sum(claimed_compute_units), sum(estimated_compute_units)
    FROM ${s}.claim_settlements WHERE height = h GROUP BY application_id, service_id;
    INSERT INTO ${s}.settlement_income_by_address
    SELECT h, address, role, family, sum(amount_upokt), sum(transfer_count) FROM _inc GROUP BY address, role, family;
    INSERT INTO ${s}.settlement_supply_flows
    SELECT h, coalesce(sum(settled_upokt),0), coalesce(sum(relay_minted_upokt),0), coalesce(sum(mint_ratio_unminted_upokt),0),
           coalesce(sum(overservicing_loss_upokt),0), coalesce(sum(relay_to_supplier_upokt),0), coalesce(sum(relay_to_dao_upokt),0),
           coalesce(sum(relay_to_source_owner_upokt),0), coalesce(sum(relay_to_application_upokt),0), coalesce(sum(relay_to_stakers_upokt),0),
           coalesce(sum(global_to_supplier_upokt),0), coalesce(sum(global_to_dao_upokt),0), coalesce(sum(global_to_source_owner_upokt),0),
           coalesce(sum(global_to_application_upokt),0), coalesce(sum(reimbursement_to_dao_upokt),0)
    FROM ${s}.claim_settlements WHERE height = h;
  END IF;

  ${upserts(s, "", [{ t: "monthly_income_by_address_supplier", keys: ["address", "supplier_id", "role", "family"], count: "contribution_count", rules: [], sql: `INSERT INTO ${s}.monthly_income_by_address_supplier AS t
  SELECT date_trunc('month', d)::date, supplier_id, address, role, family, sg * sum(amount_upokt), sg * sum(transfer_count), sg * sum(contribution_count)
  FROM _inc WHERE supplier_id <> '' GROUP BY supplier_id, address, role, family
  ON CONFLICT (address, month, supplier_id, role, family) DO UPDATE
    SET amount_upokt = t.amount_upokt + excluded.amount_upokt, transfer_count = t.transfer_count + excluded.transfer_count, contribution_count = t.contribution_count + excluded.contribution_count` }])}

  ${upserts(s, "", [{ t: "daily_income_by_address", keys: ["address", "role", "family"], count: "contribution_count", rules: [], sql: `INSERT INTO ${s}.daily_income_by_address AS t
  SELECT d, address, role, family, sg * sum(amount_upokt), sg * sum(transfer_count), sg * sum(contribution_count) FROM _inc GROUP BY address, role, family
  ON CONFLICT (address, day, role, family) DO UPDATE
    SET amount_upokt = t.amount_upokt + excluded.amount_upokt, transfer_count = t.transfer_count + excluded.transfer_count, contribution_count = t.contribution_count + excluded.contribution_count` }])}

  ${upserts(s, "", [{ t: "daily_income_by_address_supplier", keys: ["supplier_id", "address", "role", "family"], count: "contribution_count", rules: [], sql: `INSERT INTO ${s}.daily_income_by_address_supplier AS t
  SELECT d, supplier_id, address, role, family, sg * sum(amount_upokt), sg * sum(transfer_count), sg * sum(contribution_count)
  FROM _inc WHERE supplier_id <> '' GROUP BY supplier_id, address, role, family
  UNION ALL
  SELECT d, supplier_id, '', 'stakers', 'relay', sg * sum(relay_to_stakers_upokt),
         sg * count(*) FILTER (WHERE relay_to_stakers_upokt > 0), sg * count(*)
  FROM ${s}.claim_settlements WHERE height = h GROUP BY supplier_id
  ON CONFLICT (supplier_id, day, address, role, family) DO UPDATE
    SET amount_upokt = t.amount_upokt + excluded.amount_upokt, transfer_count = t.transfer_count + excluded.transfer_count, contribution_count = t.contribution_count + excluded.contribution_count` }])}

  ${upserts(s, "", [{ t: "hourly_income_by_address_supplier", keys: ["address", "supplier_id"], count: "contribution_count", rules: [], sql: `INSERT INTO ${s}.hourly_income_by_address_supplier AS t
  SELECT address, hr, supplier_id, sg * sum(amount_upokt), sg * sum(contribution_count)
  FROM _inc WHERE supplier_id <> '' GROUP BY address, supplier_id
  ON CONFLICT (address, hour, supplier_id) DO UPDATE
    SET amount_upokt = t.amount_upokt + excluded.amount_upokt, contribution_count = t.contribution_count + excluded.contribution_count` }])}

  ${upserts(s, "", [{ t: "daily_income_by_address_service", keys: ["address", "role", "family", "service_id"], count: "contribution_count", rules: [], sql: `INSERT INTO ${s}.daily_income_by_address_service AS t
  SELECT d, address, role, family, service_id, sg * sum(amount_upokt), sg * sum(transfer_count), sg * sum(contribution_count)
  FROM _inc WHERE service_id <> '' GROUP BY address, role, family, service_id
  ON CONFLICT (address, day, role, family, service_id) DO UPDATE
    SET amount_upokt = t.amount_upokt + excluded.amount_upokt, transfer_count = t.transfer_count + excluded.transfer_count, contribution_count = t.contribution_count + excluded.contribution_count` }])}

  ${upserts(s, "", [{ t: "monthly_income_by_address_service", keys: ["address", "role", "family", "service_id"], count: "contribution_count", rules: [], sql: `INSERT INTO ${s}.monthly_income_by_address_service AS t
  SELECT date_trunc('month', d)::date, address, role, family, service_id, sg * sum(amount_upokt), sg * sum(transfer_count), sg * sum(contribution_count)
  FROM _inc WHERE service_id <> '' GROUP BY address, role, family, service_id
  ON CONFLICT (address, month, role, family, service_id) DO UPDATE
    SET amount_upokt = t.amount_upokt + excluded.amount_upokt, transfer_count = t.transfer_count + excluded.transfer_count, contribution_count = t.contribution_count + excluded.contribution_count` }])}

  ${upserts(s, "", [{ t: "monthly_income_by_address_supplier_service", keys: ["address", "supplier_id", "service_id", "role", "family"], count: "contribution_count", rules: [], sql: `INSERT INTO ${s}.monthly_income_by_address_supplier_service AS t
  SELECT date_trunc('month', d)::date, address, supplier_id, service_id, role, family, sg * sum(amount_upokt), sg * sum(transfer_count), sg * sum(contribution_count)
  FROM _inc WHERE supplier_id <> '' AND service_id <> '' GROUP BY address, supplier_id, service_id, role, family
  ON CONFLICT (address, month, supplier_id, service_id, role, family) DO UPDATE
    SET amount_upokt = t.amount_upokt + excluded.amount_upokt, transfer_count = t.transfer_count + excluded.transfer_count, contribution_count = t.contribution_count + excluded.contribution_count` }])}

  ${upserts(s, "", [{ t: "daily_claims_by_application_service", keys: ["application_id", "service_id"], count: "claim_count", rules: [], sql: `INSERT INTO ${s}.daily_claims_by_application_service AS t
  SELECT d, application_id, service_id, sg * count(*), sg * sum(claimed_upokt), sg * sum(settled_upokt), sg * sum(relay_minted_upokt),
         sg * sum(overservicing_loss_upokt), sg * sum(mint_ratio_unminted_upokt), sg * sum(global_minted_upokt),
         sg * sum(relays), sg * sum(estimated_relays), sg * sum(claimed_compute_units), sg * sum(estimated_compute_units),
         sg * sum(relay_to_supplier_upokt), sg * sum(relay_to_dao_upokt), sg * sum(relay_to_source_owner_upokt), sg * sum(relay_to_application_upokt), sg * sum(relay_to_stakers_upokt),
         sg * sum(global_to_supplier_upokt), sg * sum(global_to_dao_upokt), sg * sum(global_to_source_owner_upokt), sg * sum(global_to_application_upokt), sg * sum(reimbursement_to_dao_upokt)
  FROM ${s}.claim_settlements WHERE height = h GROUP BY application_id, service_id
  ON CONFLICT (application_id, day, service_id) DO UPDATE SET
    claim_count = t.claim_count + excluded.claim_count, claimed_upokt = t.claimed_upokt + excluded.claimed_upokt, settled_upokt = t.settled_upokt + excluded.settled_upokt,
    relay_minted_upokt = t.relay_minted_upokt + excluded.relay_minted_upokt, overservicing_loss_upokt = t.overservicing_loss_upokt + excluded.overservicing_loss_upokt,
    mint_ratio_unminted_upokt = t.mint_ratio_unminted_upokt + excluded.mint_ratio_unminted_upokt, global_minted_upokt = t.global_minted_upokt + excluded.global_minted_upokt,
    relays = t.relays + excluded.relays, estimated_relays = t.estimated_relays + excluded.estimated_relays,
    claimed_compute_units = t.claimed_compute_units + excluded.claimed_compute_units, estimated_compute_units = t.estimated_compute_units + excluded.estimated_compute_units,
    relay_to_supplier_upokt = t.relay_to_supplier_upokt + excluded.relay_to_supplier_upokt, relay_to_dao_upokt = t.relay_to_dao_upokt + excluded.relay_to_dao_upokt,
    relay_to_source_owner_upokt = t.relay_to_source_owner_upokt + excluded.relay_to_source_owner_upokt, relay_to_application_upokt = t.relay_to_application_upokt + excluded.relay_to_application_upokt,
    relay_to_stakers_upokt = t.relay_to_stakers_upokt + excluded.relay_to_stakers_upokt,
    global_to_supplier_upokt = t.global_to_supplier_upokt + excluded.global_to_supplier_upokt, global_to_dao_upokt = t.global_to_dao_upokt + excluded.global_to_dao_upokt,
    global_to_source_owner_upokt = t.global_to_source_owner_upokt + excluded.global_to_source_owner_upokt, global_to_application_upokt = t.global_to_application_upokt + excluded.global_to_application_upokt,
    reimbursement_to_dao_upokt = t.reimbursement_to_dao_upokt + excluded.reimbursement_to_dao_upokt` }])}

  ${upserts(s, "", [{ t: "daily_delegator_rewards_by_validator", keys: ["delegator", "validator_operator", "family"], count: "contribution_count", rules: DELEGATOR, sql: `INSERT INTO ${s}.daily_delegator_rewards_by_validator AS t
  SELECT d, delegator, validator_operator, family, sg * sum(amount_upokt), sg * count(*),
         sg * count(*) FILTER (WHERE row_source IN ('replay', 'derived_split'))
  FROM ${s}.delegator_validator_payouts WHERE height = h GROUP BY delegator, validator_operator, family
  ON CONFLICT (delegator, day, validator_operator, family) DO UPDATE
    SET amount_upokt = t.amount_upokt + excluded.amount_upokt, contribution_count = t.contribution_count + excluded.contribution_count,
        replayed_count = t.replayed_count + excluded.replayed_count` }])}

  -- one aggregate of the height's claims feeds the daily rollup and the monthly one without the application; the monthly
  -- one only for a held height (settlement_blocks.monthly_claims_rollup), as daily_claims_paid_by_address_service
  ${upserts(s, `a AS (
    SELECT supplier_id, application_id, service_id, count(*) claim_count, sum(claimed_upokt) claimed_upokt,
           sum(settled_upokt) settled_upokt, sum(overservicing_loss_upokt) overservicing_loss_upokt,
           sum(global_minted_upokt) global_minted_upokt, sum(relays) relays, sum(estimated_relays) estimated_relays,
           sum(claimed_compute_units) claimed_compute_units, sum(estimated_compute_units) estimated_compute_units,
           count(*) FILTER (WHERE settled_with_proof) claims_with_proof
    FROM ${s}.claim_settlements WHERE height = h GROUP BY supplier_id, application_id, service_id
  )`, [
    { t: "daily_claims_by_supplier_application_service", keys: ["supplier_id", "application_id", "service_id"], count: "claim_count",
      rules: CLAIMS, sql: `INSERT INTO ${s}.daily_claims_by_supplier_application_service AS t
    SELECT d, supplier_id, application_id, service_id, sg * claim_count, sg * claimed_upokt, sg * settled_upokt,
           sg * overservicing_loss_upokt, sg * global_minted_upokt, sg * relays, sg * estimated_relays,
           sg * claimed_compute_units, sg * estimated_compute_units, sg * claims_with_proof
    FROM a
    ON CONFLICT (supplier_id, day, application_id, service_id) DO UPDATE SET
      claim_count = t.claim_count + excluded.claim_count, claimed_upokt = t.claimed_upokt + excluded.claimed_upokt, settled_upokt = t.settled_upokt + excluded.settled_upokt,
      overservicing_loss_upokt = t.overservicing_loss_upokt + excluded.overservicing_loss_upokt, global_minted_upokt = t.global_minted_upokt + excluded.global_minted_upokt,
      relays = t.relays + excluded.relays, estimated_relays = t.estimated_relays + excluded.estimated_relays,
      claimed_compute_units = t.claimed_compute_units + excluded.claimed_compute_units, estimated_compute_units = t.estimated_compute_units + excluded.estimated_compute_units,
      claims_with_proof = t.claims_with_proof + excluded.claims_with_proof` },
    { t: "monthly_claims_by_supplier_service", keys: ["supplier_id", "service_id"], count: "claim_count", rules: MONTHLY_CLAIMS,
      sql: `INSERT INTO ${s}.monthly_claims_by_supplier_service AS t
  SELECT date_trunc('month', d)::date, supplier_id, service_id, sg * sum(claim_count), sg * sum(claimed_upokt), sg * sum(settled_upokt),
         sg * sum(overservicing_loss_upokt), sg * sum(relays), sg * sum(estimated_relays), sg * sum(claimed_compute_units),
         sg * sum(estimated_compute_units), sg * sum(claims_with_proof)
  FROM a WHERE v_month_held GROUP BY supplier_id, service_id
  ON CONFLICT (supplier_id, month, service_id) DO UPDATE SET
    claim_count = t.claim_count + excluded.claim_count, claimed_upokt = t.claimed_upokt + excluded.claimed_upokt, settled_upokt = t.settled_upokt + excluded.settled_upokt,
    overservicing_loss_upokt = t.overservicing_loss_upokt + excluded.overservicing_loss_upokt,
    relays = t.relays + excluded.relays, estimated_relays = t.estimated_relays + excluded.estimated_relays,
    claimed_compute_units = t.claimed_compute_units + excluded.claimed_compute_units, estimated_compute_units = t.estimated_compute_units + excluded.estimated_compute_units,
    claims_with_proof = t.claims_with_proof + excluded.claims_with_proof` },
  ])}

  ${upserts(s, "", [{ t: "daily_claims_by_supplier", keys: ["supplier_id"], count: "claim_count", rules: CLAIMS, sql: `INSERT INTO ${s}.daily_claims_by_supplier AS t
  SELECT d, supplier_id, sg * count(*), sg * sum(claimed_upokt), sg * sum(settled_upokt), sg * sum(overservicing_loss_upokt),
         sg * sum(relays), sg * sum(estimated_relays), sg * sum(claimed_compute_units), sg * sum(estimated_compute_units),
         sg * count(*) FILTER (WHERE settled_with_proof)
  FROM ${s}.claim_settlements WHERE height = h GROUP BY supplier_id
  ON CONFLICT (supplier_id, day) DO UPDATE SET
    claim_count = t.claim_count + excluded.claim_count, claimed_upokt = t.claimed_upokt + excluded.claimed_upokt, settled_upokt = t.settled_upokt + excluded.settled_upokt,
    overservicing_loss_upokt = t.overservicing_loss_upokt + excluded.overservicing_loss_upokt,
    relays = t.relays + excluded.relays, estimated_relays = t.estimated_relays + excluded.estimated_relays,
    claimed_compute_units = t.claimed_compute_units + excluded.claimed_compute_units, estimated_compute_units = t.estimated_compute_units + excluded.estimated_compute_units,
    claims_with_proof = t.claims_with_proof + excluded.claims_with_proof` }])}

  -- commission: the sum of the contributions that have one, and how many have none (the replayed rows, NULL); NULL
  -- + x keeps x, so a day mixing both keeps the real commission. A row whose contributions all lack one is NULL.
  ${upserts(s, "", [{ t: "daily_validator_rewards", keys: ["validator_operator", "family"], count: "contribution_count", rules: VALIDATOR, sql: `INSERT INTO ${s}.daily_validator_rewards AS t
  SELECT d, validator_operator, family, sg * count(*),
         sg * sum(pool_share_upokt), sg * sum(commission_upokt), sg * sum(self_delegation_upokt), sg * sum(to_delegators_upokt),
         sg * count(*) FILTER (WHERE commission_upokt IS NULL)
  FROM ${s}.validator_distributions WHERE height = h GROUP BY validator_operator, family
  ON CONFLICT (validator_operator, day, family) DO UPDATE SET
    contribution_count = t.contribution_count + excluded.contribution_count, pool_share_upokt = t.pool_share_upokt + excluded.pool_share_upokt,
    commission_upokt = CASE WHEN t.commission_upokt IS NULL THEN excluded.commission_upokt
                            WHEN excluded.commission_upokt IS NULL THEN t.commission_upokt
                            ELSE t.commission_upokt + excluded.commission_upokt END,
    self_delegation_upokt = t.self_delegation_upokt + excluded.self_delegation_upokt, to_delegators_upokt = t.to_delegators_upokt + excluded.to_delegators_upokt,
    commission_na_count = t.commission_na_count + excluded.commission_na_count` }])}

  ${upserts(s, "", [{ t: "daily_claims_paid_by_address_service", keys: ["address", "service_id"], count: "claim_count", rules: [], sql: `INSERT INTO ${s}.daily_claims_paid_by_address_service AS t
  SELECT d, address, service_id, sg * claim_count, sg * settled_upokt, sg * relays, sg * estimated_relays,
         sg * claimed_compute_units, sg * estimated_compute_units
  FROM _paid
  ON CONFLICT (address, day, service_id) DO UPDATE SET
    claim_count = t.claim_count + excluded.claim_count, settled_upokt = t.settled_upokt + excluded.settled_upokt,
    relays = t.relays + excluded.relays, estimated_relays = t.estimated_relays + excluded.estimated_relays,
    claimed_compute_units = t.claimed_compute_units + excluded.claimed_compute_units,
    estimated_compute_units = t.estimated_compute_units + excluded.estimated_compute_units` }])}

  -- once the contributions with a commission are all gone, the row has none: NULL, as rebuild_rollups would write it
  UPDATE ${s}.daily_validator_rewards SET commission_upokt = NULL
  WHERE day = d AND commission_na_count = contribution_count AND commission_upokt IS NOT NULL;
END $$;

-- Appends one part of a settlement payload to the staging tables, which live until the end of the transaction.
-- A payload above MAX_ROWS_PER_CALL rows arrives as several _stage_settlement calls followed by
-- write_settlement with the last part (writeSettlementCalls below), so no single bind parameter nears jsonb's
-- size cap; write_settlement checks and writes the whole height and empties the staging tables.
CREATE OR REPLACE PROCEDURE ${s}._stage_settlement(p jsonb) LANGUAGE plpgsql AS $$
BEGIN
  CREATE TEMP TABLE IF NOT EXISTS _stg_claims (event_idx int, supplier_id text, supplier_owner_id text, application_id text,
    service_id text, session_id text, session_end bigint, claimed_upokt bigint, settled_upokt bigint, relay_minted_upokt bigint,
    overservicing_loss_upokt bigint, mint_ratio_unminted_upokt bigint, relays bigint, estimated_relays bigint,
    claimed_compute_units bigint, estimated_compute_units bigint, proof_status int, mint_ratio numeric,
    relay_to_stakers_upokt bigint, global_overpaid_upokt bigint) ON COMMIT DROP;
  CREATE TEMP TABLE IF NOT EXISTS _stg_detailed (event_idx int, recipient_id text, op_reason text, role text, family text,
    amount_upokt bigint) ON COMMIT DROP;
  CREATE TEMP TABLE IF NOT EXISTS _stg_batch (event_idx int, op_type text, op_reason text, sender_module text,
    recipient_id text, role text, family text, amount_upokt bigint, num_claims bigint) ON COMMIT DROP;
  CREATE TEMP TABLE IF NOT EXISTS _stg_vrd (event_idx int, op_reason text, family text, validator_operator text,
    validator_account text, commission_rate numeric, pool_share_upokt bigint, commission_upokt bigint, self_delegation_upokt bigint,
    to_delegators_upokt bigint, total_delegated_stake_upokt bigint, delegator_count int, row_source text) ON COMMIT DROP;
  CREATE TEMP TABLE IF NOT EXISTS _stg_reimb (event_idx int, application_id text, supplier_id text, supplier_owner_id text,
    service_id text, session_id text, amount_upokt bigint) ON COMMIT DROP;
  CREATE TEMP TABLE IF NOT EXISTS _stg_dv (delegator text, validator_operator text, family text, amount_upokt bigint,
    row_source text) ON COMMIT DROP;
  CREATE TEMP TABLE IF NOT EXISTS _stg_expired (event_idx int, supplier_id text, application_id text, service_id text,
    session_end bigint, claimed_upokt bigint, reason text, relays bigint, estimated_relays bigint,
    claimed_compute_units bigint, estimated_compute_units bigint) ON COMMIT DROP;
  CREATE TEMP TABLE IF NOT EXISTS _stg_discarded (event_idx int, supplier_id text, application_id text, service_id text,
    session_end bigint, error text) ON COMMIT DROP;
  CREATE TEMP TABLE IF NOT EXISTS _stg_slashed (event_idx int, supplier_id text, application_id text, service_id text,
    session_end bigint, penalty_upokt bigint, stake_after_upokt bigint) ON COMMIT DROP;
  INSERT INTO _stg_claims SELECT * FROM jsonb_to_recordset(p->'claims') AS x(event_idx int, supplier_id text,
    supplier_owner_id text, application_id text, service_id text, session_id text, session_end bigint, claimed bigint,
    settled bigint, minted bigint, overservicing_loss bigint, deflation_loss bigint, num_relays bigint,
    num_estimated_relays bigint, num_claimed_cu bigint, num_estimated_cu bigint, proof_status int, mint_ratio numeric,
    relay_to_stakers bigint, global_overpaid bigint);
  INSERT INTO _stg_detailed SELECT * FROM jsonb_to_recordset(p->'detailed') AS x(event_idx int, recipient_id text,
    op_reason text, role text, family text, amount bigint);
  INSERT INTO _stg_batch SELECT * FROM jsonb_to_recordset(p->'batch') AS x(event_idx int, op_type text, op_reason text,
    sender_module text, recipient_id text, role text, family text, amount bigint, num_claims bigint);
  INSERT INTO _stg_vrd SELECT * FROM jsonb_to_recordset(p->'vrd') AS x(event_idx int, op_reason text, family text,
    validator_operator text, validator_account text, commission_rate numeric, pool_share bigint, commission bigint,
    self_delegation bigint, delegators bigint, total_delegated_stake bigint, num_delegators int, row_source text);
  INSERT INTO _stg_reimb SELECT * FROM jsonb_to_recordset(p->'reimb') AS x(event_idx int, application_id text,
    supplier_id text, supplier_owner_id text, service_id text, session_id text, amount bigint);
  INSERT INTO _stg_dv SELECT * FROM jsonb_to_recordset(p->'dv') AS x(delegator text, validator_operator text,
    family text, amount bigint, row_source text);
  INSERT INTO _stg_expired SELECT * FROM jsonb_to_recordset(p->'expired') AS x(event_idx int, supplier_id text,
    application_id text, service_id text, session_end bigint, claimed bigint, reason text, num_relays bigint,
    num_estimated_relays bigint, num_claimed_cu bigint, num_estimated_cu bigint);
  INSERT INTO _stg_discarded SELECT * FROM jsonb_to_recordset(p->'discarded') AS x(event_idx int, supplier_id text,
    application_id text, service_id text, session_end bigint, error text);
  INSERT INTO _stg_slashed SELECT * FROM jsonb_to_recordset(p->'slashed') AS x(event_idx int, supplier_id text,
    application_id text, service_id text, session_end bigint, penalty bigint, stake_after bigint);
END $$;

CREATE OR REPLACE PROCEDURE ${s}.${writeSettlementProcName}(h bigint, p jsonb) LANGUAGE plpgsql AS $$
DECLARE
  v_ts timestamptz := (p->>'ts')::timestamptz;
  v_era text := p->>'era';
  v_row_source text := p->>'row_source';
  v_old_version int;
  v_held boolean;
  v_month_held boolean;
  v_bad text;
  v_lock_timeout text := current_setting('lock_timeout');
BEGIN
  -- One writer at a time: the indexer and the history jobs share this procedure. The wait is bounded so a
  -- live block queued behind a history job fails fast (SubQuery retries it) instead of stalling the
  -- indexer; the timeout applies to this lock only and the caller's value is restored after it.
  PERFORM set_config('lock_timeout', '30s', true);
  PERFORM pg_advisory_xact_lock(hashtext('pocketdex.${writeSettlementProcName}'));
  PERFORM set_config('lock_timeout', v_lock_timeout, true);
  IF v_ts IS NULL OR v_era IS NULL OR v_row_source IS NULL THEN
    RAISE EXCEPTION 'settlement payload for height % has no ts, era or row_source', h;
  END IF;

  CALL ${s}._stage_settlement(p);
  IF p->'counts' IS NULL
     OR (SELECT count(*) FROM _stg_claims) <> (p->'counts'->>'claims')::bigint
     OR (SELECT count(*) FROM _stg_detailed) <> (p->'counts'->>'detailed')::bigint
     OR (SELECT count(*) FROM _stg_batch) <> (p->'counts'->>'batch')::bigint
     OR (SELECT count(*) FROM _stg_vrd) <> (p->'counts'->>'vrd')::bigint
     OR (SELECT count(*) FROM _stg_reimb) <> (p->'counts'->>'reimb')::bigint
     OR (SELECT count(*) FROM _stg_expired) <> (p->'counts'->>'expired')::bigint
     OR (SELECT count(*) FROM _stg_discarded) <> (p->'counts'->>'discarded')::bigint
     OR (SELECT count(*) FROM _stg_slashed) <> (p->'counts'->>'slashed')::bigint
     OR (SELECT count(*) FROM _stg_dv) <> (p->'counts'->>'dv')::bigint THEN
    RAISE EXCEPTION 'settlement payload for height %: the staged rows differ from the counts sent with it (a part was lost, or the parts ran outside one transaction)', h;
  END IF;

  -- rewrite: subtract the old contribution from the rollups before deleting the base rows
  SELECT rollup_version, claims_paid_rollup, monthly_claims_rollup INTO v_old_version, v_held, v_month_held
  FROM ${s}.settlement_blocks WHERE height = h;
  -- daily_claims_paid_by_address_service takes the height only when it is new or was held: an existing height that is
  -- not held (written before the rollup, or rewritten by an image without it, which may have left its old contribution
  -- there) stays not held, and its day reads the claims until fill_claims_paid_day recomputes the day.
  -- monthly_claims_by_supplier_service likewise, its month read from the daily rollup until fill_monthly_claims_month.
  v_held := v_old_version IS NULL OR v_held;
  v_month_held := v_old_version IS NULL OR v_month_held;
  IF v_old_version IS NOT NULL THEN
    IF v_old_version <> ${ROLLUP_VERSION} THEN
      RAISE EXCEPTION 'height % was written with rollup version %, this code is version ${ROLLUP_VERSION}: run rebuild_rollups first',
        h, v_old_version;
    END IF;
    CALL ${s}._rollup_apply(h, -1);
  END IF;

  DELETE FROM ${s}.claim_settlements WHERE height = h;
  DELETE FROM ${s}.shareholder_payouts WHERE height = h;
  DELETE FROM ${s}.staker_payouts WHERE height = h;
  DELETE FROM ${s}.validator_distributions WHERE height = h;
  DELETE FROM ${s}.delegator_validator_payouts WHERE height = h;
  DELETE FROM ${s}.claim_expirations WHERE height = h;
  DELETE FROM ${s}.claim_discards WHERE height = h;
  DELETE FROM ${s}.supplier_slashes WHERE height = h;
  DELETE FROM ${s}.settlement_blocks WHERE height = h;

  IF (SELECT count(DISTINCT recipient_id) FROM _stg_detailed WHERE role = 'dao') > 1 THEN
    RAISE EXCEPTION 'more than one DAO address at height %', h;
  END IF;
  IF (SELECT count(DISTINCT mint_ratio) FROM _stg_claims) > 1 THEN
    RAISE EXCEPTION 'height %: the claims settled with more than one mint_ratio', h;
  END IF;

  -- I1: the claims' detailed legs, per (op_reason, recipient), are exactly the batch mod_to_acct rows. The
  -- settlement_result era has no batch: E0 below checks its legs against the claims instead. The map eras' batch rows
  -- are only their staker legs, aggregated from the bank: M1 below checks the global family instead.
  IF v_era <> 'settlement_result' AND left(v_era, 4) <> 'map_' THEN
    SELECT string_agg(coalesce(dd.op_reason, bb.op_reason) || ' ' || coalesce(dd.recipient_id, bb.recipient_id), ', ')
    INTO v_bad
    FROM (SELECT op_reason, recipient_id, sum(amount_upokt) AS amount_upokt FROM _stg_detailed GROUP BY 1, 2) dd
    FULL JOIN (SELECT op_reason, recipient_id, sum(amount_upokt) AS amount_upokt FROM _stg_batch
               WHERE op_type = 'mod_to_acct' AND role NOT IN (${STAKER_ROLES_SQL}) GROUP BY 1, 2) bb
      ON bb.op_reason = dd.op_reason AND bb.recipient_id = dd.recipient_id
    WHERE dd.amount_upokt IS DISTINCT FROM bb.amount_upokt;
    IF v_bad IS NOT NULL THEN
      RAISE EXCEPTION 'height %: detailed legs differ from the settlement batch for %', h, left(v_bad, 500);
    END IF;
  END IF;

  -- claims_paid_rollup / monthly_claims_rollup: when held, _rollup_apply below adds the height to
  -- daily_claims_paid_by_address_service / monthly_claims_by_supplier_service
  INSERT INTO ${s}.settlement_blocks (height, block_time, era, dao_address, day, rollup_version, mint_ratio, claims_paid_rollup,
                                      monthly_claims_rollup)
  VALUES (h, v_ts, v_era, (SELECT min(recipient_id) FROM _stg_detailed WHERE role = 'dao'),
          (v_ts AT TIME ZONE 'UTC')::date, ${ROLLUP_VERSION}, (SELECT min(mint_ratio) FROM _stg_claims), v_held, v_month_held);

  INSERT INTO ${s}.claim_settlements
  SELECT h, c.event_idx, v_ts, c.supplier_id, nullif(c.supplier_owner_id, ''), c.application_id, c.service_id,
         c.session_id, c.session_end, d.source_owner_id,
         c.claimed_upokt, c.settled_upokt, c.relay_minted_upokt, c.overservicing_loss_upokt, c.mint_ratio_unminted_upokt, coalesce(r.amount_upokt, 0),
         c.relays, c.estimated_relays, c.claimed_compute_units, c.estimated_compute_units,
         coalesce(d.relay_to_supplier_upokt, 0), coalesce(d.relay_to_dao_upokt, 0), coalesce(d.relay_to_source_owner_upokt, 0), coalesce(d.relay_to_application_upokt, 0),
         coalesce(c.relay_to_stakers_upokt,
                  c.relay_minted_upokt - coalesce(d.relay_to_supplier_upokt, 0) - coalesce(d.relay_to_dao_upokt, 0)
                  - coalesce(d.relay_to_source_owner_upokt, 0) - coalesce(d.relay_to_application_upokt, 0)),
         coalesce(d.global_to_supplier_upokt, 0), coalesce(d.global_to_dao_upokt, 0), coalesce(d.global_to_source_owner_upokt, 0), coalesce(d.global_to_application_upokt, 0),
         coalesce(d.reimbursement_to_dao_upokt, 0),
         v_row_source, 1, c.proof_status = 1
  FROM _stg_claims c
  LEFT JOIN (
    SELECT event_idx,
      sum(amount_upokt) FILTER (WHERE family = 'relay' AND role = 'rev_share') relay_to_supplier_upokt,
      sum(amount_upokt) FILTER (WHERE family = 'relay' AND role = 'dao') relay_to_dao_upokt,
      sum(amount_upokt) FILTER (WHERE family = 'relay' AND role = 'source_owner') relay_to_source_owner_upokt,
      sum(amount_upokt) FILTER (WHERE family = 'relay' AND role = 'application') relay_to_application_upokt,
      sum(amount_upokt) FILTER (WHERE family = 'global' AND role = 'rev_share') global_to_supplier_upokt,
      sum(amount_upokt) FILTER (WHERE family = 'global' AND role = 'dao') global_to_dao_upokt,
      sum(amount_upokt) FILTER (WHERE family = 'global' AND role = 'source_owner') global_to_source_owner_upokt,
      sum(amount_upokt) FILTER (WHERE family = 'global' AND role = 'application') global_to_application_upokt,
      sum(amount_upokt) FILTER (WHERE family = 'reimb_escrow') reimbursement_to_dao_upokt,
      min(recipient_id) FILTER (WHERE role = 'source_owner') source_owner_id
    FROM _stg_detailed GROUP BY event_idx
  ) d ON d.event_idx = c.event_idx
  LEFT JOIN _stg_reimb r ON r.supplier_id = c.supplier_id AND r.session_id = c.session_id
                        AND r.application_id = c.application_id;

  -- the CHECK on claim_settlements.relay_to_stakers_upokt rejects a claim whose relay legs exceed what it minted

  -- R1: a staker share sent by the reader is what the claim's relay legs leave of its mint, unless the claim paid a
  -- shareholder address twice (the exception at the top of this file)
  SELECT string_agg(c.event_idx::text, ', ') INTO v_bad
  FROM ${s}.claim_settlements c
  WHERE c.height = h
    AND c.relay_to_stakers_upokt <> c.relay_minted_upokt - c.relay_to_supplier_upokt - c.relay_to_dao_upokt
                                    - c.relay_to_source_owner_upokt - c.relay_to_application_upokt
    AND NOT EXISTS (SELECT 1 FROM _stg_detailed d WHERE d.event_idx = c.event_idx AND d.family = 'relay' AND d.role = 'rev_share'
                    GROUP BY d.recipient_id HAVING count(*) > 1);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'height %: the staker share differs from what the relay legs leave of the mint at events %', h, left(v_bad, 500);
  END IF;

  -- I2: per claim, the reimbursement request equals the claim's escrow-to-DAO leg
  IF EXISTS (SELECT 1 FROM ${s}.claim_settlements WHERE height = h AND global_minted_upokt <> reimbursement_to_dao_upokt) THEN
    RAISE EXCEPTION 'height %: a claim''s reimbursement request differs from its escrow-to-DAO leg', h;
  END IF;

  INSERT INTO ${s}.shareholder_payouts
  SELECT h, d.event_idx, c.supplier_id, c.service_id, d.recipient_id,
         coalesce(sum(d.amount_upokt) FILTER (WHERE d.family = 'relay'), 0),
         coalesce(sum(d.amount_upokt) FILTER (WHERE d.family = 'global'), 0),
         v_row_source, 1
  FROM _stg_detailed d JOIN _stg_claims c ON c.event_idx = d.event_idx
  WHERE d.role = 'rev_share'
  GROUP BY d.event_idx, c.supplier_id, c.service_id, d.recipient_id;

  -- the batch staker rows (in the map eras, the staker legs aggregated per recipient and family); in the
  -- settlement_result era, the proposer's leg of each claim
  INSERT INTO ${s}.staker_payouts
  SELECT h, event_idx, recipient_id, op_reason, role, family, amount_upokt, v_row_source, 1
  FROM _stg_batch WHERE op_type = 'mod_to_acct' AND role IN (${STAKER_ROLES_SQL})
  UNION ALL
  SELECT h, event_idx, recipient_id, op_reason, role, family, amount_upokt, v_row_source, 1
  FROM _stg_detailed WHERE role IN (${STAKER_ROLES_SQL});

  INSERT INTO ${s}.validator_distributions
  SELECT h, event_idx, op_reason, family, validator_operator, validator_account, commission_rate, pool_share_upokt, commission_upokt,
         self_delegation_upokt, to_delegators_upokt, total_delegated_stake_upokt, delegator_count, coalesce(row_source, 'event'), 1
  FROM _stg_vrd;

  -- each row says how it was made: replay, derived_split or unattributed for 288,180–788,944 (replay.ts); batched_vrd
  -- derives the split per validator (de2.ts)
  INSERT INTO ${s}.delegator_validator_payouts
  SELECT h, delegator, validator_operator, family, amount_upokt,
         coalesce(row_source, CASE WHEN v_era = 'batched_vrd' THEN 'derived' ELSE v_row_source END), 1
  FROM _stg_dv;

  INSERT INTO ${s}.claim_expirations
  SELECT h, event_idx, supplier_id, application_id, service_id, session_end, claimed_upokt, reason,
         relays, estimated_relays, claimed_compute_units, estimated_compute_units
  FROM _stg_expired;
  INSERT INTO ${s}.claim_discards
  SELECT h, event_idx, supplier_id, application_id, service_id, session_end, error FROM _stg_discarded;
  INSERT INTO ${s}.supplier_slashes
  SELECT h, event_idx, supplier_id, application_id, service_id, session_end, penalty_upokt, stake_after_upokt FROM _stg_slashed;

  -- E0: in the settlement_result era, per claim, the relay legs sum to the relay mint and the global legs (the
  -- proposer's included) to the global mint, which is the reimbursement request (I2 ties it to the escrow leg)
  IF v_era = 'settlement_result' THEN
    SELECT string_agg(c.event_idx::text, ', ') INTO v_bad
    FROM ${s}.claim_settlements c
    LEFT JOIN (SELECT event_idx, sum(amount_upokt) FILTER (WHERE family = 'relay') relay_upokt,
                      sum(amount_upokt) FILTER (WHERE family = 'global') global_upokt
               FROM _stg_detailed GROUP BY 1) d USING (event_idx)
    WHERE c.height = h AND (coalesce(d.relay_upokt, 0) <> c.relay_minted_upokt OR coalesce(d.global_upokt, 0) <> c.global_minted_upokt);
    IF v_bad IS NOT NULL THEN
      RAISE EXCEPTION 'height %: settlement_result legs differ from the claims'' mints at events %', h, left(v_bad, 500);
    END IF;
  END IF;

  -- M1's exception: a claim may report a global overpayment only if it paid a global shareholder address twice
  SELECT string_agg(c.event_idx::text, ', ') INTO v_bad
  FROM _stg_claims c
  WHERE coalesce(c.global_overpaid_upokt, 0) <> 0
    AND NOT EXISTS (SELECT 1 FROM _stg_detailed d WHERE d.event_idx = c.event_idx AND d.family = 'global' AND d.role = 'rev_share'
                    GROUP BY d.recipient_id HAVING count(*) > 1);
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'height %: a global overpayment without a repeated shareholder address at events %', h, left(v_bad, 500);
  END IF;

  -- M1: in the map eras, the global legs of the claims plus the global staker rows equal the claims' global mints, and
  -- what a shareholder address listed twice was overpaid (the exception at the top of this file)
  -- (the relay family is I3a: relay_to_stakers_upokt is what the claims' relay legs leave of their mint, or R1's exception)
  IF left(v_era, 4) = 'map_' AND (SELECT coalesce(sum(amount_upokt), 0) FROM _stg_detailed WHERE family = 'global')
       + (SELECT coalesce(sum(amount_upokt), 0) FROM _stg_batch WHERE family = 'global')
       <> (SELECT coalesce(sum(global_minted_upokt), 0) FROM ${s}.claim_settlements WHERE height = h)
          + (SELECT coalesce(sum(global_overpaid_upokt), 0) FROM _stg_claims) THEN
    RAISE EXCEPTION 'height %: map global legs and staker rows differ from the claims'' global mints', h;
  END IF;

  -- I3a: Σ relay_to_stakers_upokt = the batch relay staker rows
  IF (SELECT coalesce(sum(relay_to_stakers_upokt), 0) FROM ${s}.claim_settlements WHERE height = h)
     <> (SELECT coalesce(sum(amount_upokt), 0) FROM ${s}.staker_payouts WHERE height = h AND family = 'relay') THEN
    RAISE EXCEPTION 'height %: sum of relay_to_stakers_upokt differs from the batch relay staker rows', h;
  END IF;
  -- D1: in the replayed eras (288,180–788,944), Σ delegator_validator_payouts per (address, family) = the batch staker
  -- rows of both roles, validator and delegator (in the map eras, the staker legs aggregated from the bank). The rows
  -- come from the replay, checked against the same amounts; this guards the payload → SQL path.
  IF v_era IN ('map_proposer_operator', 'map_all_bonded', 'map_all_bonded_deflation', 'detailed_batch') THEN
    SELECT string_agg(coalesce(dv.delegator, bb.recipient_id) || ' ' || coalesce(dv.family, bb.family), ', ') INTO v_bad
    FROM (SELECT delegator, family, sum(amount_upokt) AS amount_upokt FROM _stg_dv GROUP BY 1, 2) dv
    FULL JOIN (SELECT recipient_id, family, sum(amount_upokt) AS amount_upokt FROM _stg_batch
               WHERE op_type = 'mod_to_acct' AND role IN (${STAKER_ROLES_SQL}) GROUP BY 1, 2) bb
      ON bb.recipient_id = dv.delegator AND bb.family = dv.family
    WHERE dv.amount_upokt IS DISTINCT FROM bb.amount_upokt;
    IF v_bad IS NOT NULL THEN
      RAISE EXCEPTION 'height %: staker payouts per validator differ from the settlement batch for %', h, left(v_bad, 500);
    END IF;
  END IF;

  -- I3b: per family, the batch staker rows = Σ pool_share_upokt. batched_vrd has a validator distribution for every
  -- family it pays; a replayed era has one for every family it attributed (an unattributed family has none).
  SELECT string_agg(coalesce(sp.family, vd.family), ', ') INTO v_bad
  FROM (SELECT family, sum(amount_upokt) AS amount_upokt FROM ${s}.staker_payouts WHERE height = h GROUP BY 1) sp
  FULL JOIN (SELECT family, sum(pool_share_upokt) AS amount_upokt FROM ${s}.validator_distributions WHERE height = h GROUP BY 1) vd
    USING (family)
  WHERE (v_era = 'batched_vrd' OR vd.family IS NOT NULL) AND sp.amount_upokt IS DISTINCT FROM vd.amount_upokt;
  IF v_bad IS NOT NULL THEN
    RAISE EXCEPTION 'height %: batch staker rows differ from the validator distributions for %', h, v_bad;
  END IF;

  CALL ${s}._rollup_apply(h, 1);
  -- the parts staged for this height are consumed: the next height in the transaction starts empty
  TRUNCATE _stg_claims, _stg_detailed, _stg_batch, _stg_vrd, _stg_reimb, _stg_dv, _stg_expired, _stg_discarded,
    _stg_slashed;
END $$;

-- Recomputes every rollup from the base tables, from the first day of from_day's month on (the monthly
-- rollup cannot be rebuilt from mid-month). Needed after adding a rollup or bumping the rollup version.
CREATE OR REPLACE PROCEDURE ${s}.rebuild_rollups(from_day date) LANGUAGE plpgsql AS $$
DECLARE m date := date_trunc('month', from_day)::date; h bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('pocketdex.${writeSettlementProcName}'));
  DELETE FROM ${s}.settlement_income_by_address WHERE height IN (SELECT height FROM ${s}.settlement_blocks WHERE day >= m);
  DELETE FROM ${s}.settlement_supply_flows WHERE height IN (SELECT height FROM ${s}.settlement_blocks WHERE day >= m);
  DELETE FROM ${s}.settlement_claims_by_application_service WHERE height IN (SELECT height FROM ${s}.settlement_blocks WHERE day >= m);
  DELETE FROM ${s}.monthly_income_by_address_supplier WHERE month >= m;
  DELETE FROM ${s}.monthly_income_by_address_service WHERE month >= m;
  DELETE FROM ${s}.monthly_income_by_address_supplier_service WHERE month >= m;
  DELETE FROM ${s}.daily_income_by_address WHERE day >= m;
  DELETE FROM ${s}.daily_income_by_address_supplier WHERE day >= m;
  DELETE FROM ${s}.daily_income_by_address_service WHERE day >= m;
  DELETE FROM ${s}.daily_claims_by_application_service WHERE day >= m;
  DELETE FROM ${s}.daily_claims_by_supplier WHERE day >= m;
  DELETE FROM ${s}.daily_claims_by_supplier_application_service WHERE day >= m;
  DELETE FROM ${s}.hourly_income_by_address_supplier WHERE hour >= m::timestamp AT TIME ZONE 'UTC';
  DELETE FROM ${s}.daily_delegator_rewards_by_validator WHERE day >= m;
  DELETE FROM ${s}.daily_validator_rewards WHERE day >= m;
  DELETE FROM ${s}.daily_claims_paid_by_address_service WHERE day >= m;
  DELETE FROM ${s}.monthly_claims_by_supplier_service WHERE month >= m;
  -- held before the loop: _rollup_apply adds only a held height to daily_claims_paid_by_address_service and
  -- monthly_claims_by_supplier_service
  UPDATE ${s}.settlement_blocks SET claims_paid_rollup = true, monthly_claims_rollup = true
  WHERE day >= m AND NOT (claims_paid_rollup AND monthly_claims_rollup);
  FOR h IN SELECT height FROM ${s}.settlement_blocks WHERE day >= m ORDER BY height LOOP
    CALL ${s}._rollup_apply(h, 1);
  END LOOP;
  UPDATE ${s}.settlement_blocks SET rollup_version = ${ROLLUP_VERSION} WHERE day >= m;
END $$;

-- Writes daily_claims_paid_by_address_service for one UTC day from the base tables, and marks every height of the day as
-- held (claims_paid_rollup): for the heights written before the rollup existed, or by an image without it. A day whose
-- heights are all marked is left as it is, so a stopped fill resumes by running again (scripts/fill_claims_paid.sql).
-- The whole day is recomputed, not only its unmarked heights: an image without the rollup that rewrote a marked height
-- left its old contribution in the rollup and the height unmarked. It takes the writer's lock, so no height of the day
-- is written meanwhile. Returns the heights it marked.
CREATE OR REPLACE FUNCTION ${s}.fill_claims_paid_day(p_day date) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE marked integer; lo bigint; hi bigint;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('pocketdex.${writeSettlementProcName}'));
  IF NOT EXISTS (SELECT 1 FROM ${s}.settlement_blocks WHERE day = p_day AND NOT claims_paid_rollup) THEN
    -- a held day is kept, but not its rows left at zero claims
    DELETE FROM ${s}.daily_claims_paid_by_address_service WHERE day = p_day AND claim_count = 0;
    RETURN 0;
  END IF;
  -- the day's heights as a range (days follow heights): a join on the view would compute it for every height first
  SELECT min(height), max(height) INTO lo, hi FROM ${s}.settlement_blocks WHERE day = p_day;
  DELETE FROM ${s}.daily_claims_paid_by_address_service WHERE day = p_day;
  INSERT INTO ${s}.daily_claims_paid_by_address_service
  SELECT p_day, p.address, c.service_id, count(*), sum(c.settled_upokt), sum(c.relays), sum(c.estimated_relays),
         sum(c.claimed_compute_units), sum(c.estimated_compute_units)
  FROM ${s}.v_claims_paid p JOIN ${s}.claim_settlements c ON c.height = p.height AND c.event_idx = p.event_idx
  WHERE p.height BETWEEN lo AND hi GROUP BY p.address, c.service_id;
  UPDATE ${s}.settlement_blocks SET claims_paid_rollup = true WHERE day = p_day AND NOT claims_paid_rollup;
  GET DIAGNOSTICS marked = ROW_COUNT;
  RETURN marked;
END $$;

-- Writes monthly_claims_by_supplier_service for the UTC month of p_month, and marks every height of it as held
-- (monthly_claims_rollup), as fill_claims_paid_day does for its day: a month whose heights are all marked is left as it is
-- (but its rows left at zero claims), and otherwise the whole month is recomputed (scripts/fill_monthly_claims.sql). From
-- daily_claims_by_supplier_application_service, which every image keeps for every height: the same claims summed per day,
-- read through its day index (a mainnet month: 3.1M rows in 2 s, against ~3.5M claims in an 18 GB table). Returns the
-- heights it marked.
-- It holds the writer's lock while it works, so no height of the month is written meanwhile, and waits for it as
-- write_settlement does: at most 30 s per try, whatever the session's lock_timeout, up to 10 tries (the indexer and the
-- history job hold it for one height at a time).
CREATE OR REPLACE FUNCTION ${s}.fill_monthly_claims_month(p_month date) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE marked integer; m1 date := date_trunc('month', p_month::timestamp)::date;
  m2 date := (date_trunc('month', p_month::timestamp) + interval '1 month')::date;
  v_lock_timeout text := current_setting('lock_timeout');
BEGIN
  FOR i IN 1..10 LOOP
    BEGIN
      PERFORM set_config('lock_timeout', '30s', true);
      PERFORM pg_advisory_xact_lock(hashtext('pocketdex.${writeSettlementProcName}'));
      EXIT;
    EXCEPTION WHEN lock_not_available THEN
      IF i = 10 THEN RAISE; END IF;
    END;
  END LOOP;
  PERFORM set_config('lock_timeout', v_lock_timeout, true);
  IF NOT EXISTS (SELECT 1 FROM ${s}.settlement_blocks WHERE day >= m1 AND day < m2 AND NOT monthly_claims_rollup) THEN
    DELETE FROM ${s}.monthly_claims_by_supplier_service WHERE month = m1 AND claim_count = 0;
    RETURN 0;
  END IF;
  DELETE FROM ${s}.monthly_claims_by_supplier_service WHERE month = m1;
  INSERT INTO ${s}.monthly_claims_by_supplier_service
  SELECT m1, supplier_id, service_id, sum(claim_count), sum(claimed_upokt), sum(settled_upokt), sum(overservicing_loss_upokt),
         sum(relays), sum(estimated_relays), sum(claimed_compute_units), sum(estimated_compute_units), sum(claims_with_proof)
  FROM ${s}.daily_claims_by_supplier_application_service WHERE day >= m1 AND day < m2 GROUP BY supplier_id, service_id;
  UPDATE ${s}.settlement_blocks SET monthly_claims_rollup = true WHERE day >= m1 AND day < m2 AND NOT monthly_claims_rollup;
  GET DIAGNOSTICS marked = ROW_COUNT;
  RETURN marked;
END $$;
`;
}
