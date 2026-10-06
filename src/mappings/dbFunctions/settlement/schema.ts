// Settlement money tables: one fact per settled claim, shareholder and staker payouts, validator
// distributions, supplier penalties, and the rollups the catalog functions read. They are written only by
// write_settlement (./writer.ts), once per settlement height, inside the block transaction.
//
// Like mod_to_acct_transfers, these tables are plain DDL that SubQuery does not manage: no _block_range,
// no GiST indexes, and SubQuery's rewind does not touch them. A reindex or a history job rewrites a height
// through write_settlement, which first subtracts that height's old contribution from the rollups.
//
// Amounts are bigint upokt. Rollups carry k, the number of base rows that contribute to the row; a row
// whose k drops to 0 on a rewrite is deleted.
//
// Rules for changing these tables:
// - Schema changes are ALTER statements in a PR; CREATE ... IF NOT EXISTS here never alters an existing table.
// - Adding a rollup requires rebuilding it (rebuild_rollups) before any height is rewritten; otherwise
//   the subtract step of a rewrite runs against rows that never received that height's contribution.
//   Changing how a rollup is computed requires bumping ROLLUP_VERSION in ./writer.ts for the same reason.
export function createSettlementTablesFn(dbSchema: string): string {
  const s = dbSchema;
  return `
CREATE TABLE IF NOT EXISTS ${s}.settlement_blocks (
  height         BIGINT      PRIMARY KEY,
  block_time             TIMESTAMPTZ NOT NULL,
  era            TEXT        NOT NULL,
  dao_address    TEXT,
  day            DATE        NOT NULL,
  rollup_version INT         NOT NULL,
  -- the mint_ratio the height's claims settled with (NULL at a height without settled claims)
  mint_ratio     NUMERIC
);
CREATE INDEX IF NOT EXISTS settlement_blocks_block_time_idx ON ${s}.settlement_blocks (block_time);
CREATE INDEX IF NOT EXISTS settlement_blocks_day_idx ON ${s}.settlement_blocks (day);

-- Settlement heights left unwritten: the heights a POCKETDEX_MONEY_FROM_HEIGHT override skipped (recorded by the first
-- height the money step processes past it, src/mappings/money/write.ts), and the history job's [1, h-1].
-- Authoritative: the catalog functions cover what the money step processed minus these rows (functions.ts
-- _coverage). A history job that writes the gap's heights deletes its row.
-- How far the money is written: one row. height is the last height the indexer's money step processed, set in the block
-- transaction for every height it processes (written or legitimately without money), never while a
-- POCKETDEX_MONEY_FROM_HEIGHT override skips; it follows the indexer, rewinds included. from_height is the lowest height
-- covered: the first the money step processed, lowered by the history job as it walks (to 1 when it finishes).
-- Coverage (functions.ts _coverage) runs from the block at from_height to the block at height, and infers nothing else.
CREATE TABLE IF NOT EXISTS ${s}.money_progress (
  id          BOOLEAN PRIMARY KEY DEFAULT true CHECK (id),
  from_height BIGINT NOT NULL,
  height      BIGINT NOT NULL
);
-- The one inference, once: a database written before this table existed gets its row from what is there. from_height:
-- one above the history job's row [1, g]; else the first indexed block when the written history is complete (the
-- lowest written settlement is the chain's first one, the min block_id of event_claim_settleds); else the lowest
-- written settlement. height: the highest written settlement (the money step moves it on its next block). A fresh
-- database gets its row from the money step's first block.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM ${s}.money_progress) AND EXISTS (SELECT 1 FROM ${s}.settlement_blocks) THEN
    INSERT INTO ${s}.money_progress (id, from_height, height)
    SELECT true,
           CASE WHEN x.gap_top IS NOT NULL THEN x.gap_top + 1
                WHEN x.lowest <= coalesce(x.chain_first, x.lowest) THEN coalesce(x.first_block, x.lowest)
                ELSE x.lowest END,
           x.highest
    FROM (SELECT (SELECT gp.to_height FROM ${s}.settlement_gaps gp WHERE gp.from_height = 1) gap_top,
                 (SELECT sb.height FROM ${s}.settlement_blocks sb ORDER BY sb.height LIMIT 1) lowest,
                 (SELECT sb.height FROM ${s}.settlement_blocks sb ORDER BY sb.height DESC LIMIT 1) highest,
                 (SELECT e.block_id::bigint FROM ${s}.event_claim_settleds e ORDER BY e.block_id LIMIT 1) chain_first,
                 (SELECT bl.id::bigint FROM ${s}.blocks bl ORDER BY bl.id LIMIT 1) first_block) x;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS ${s}.settlement_gaps (
  from_height BIGINT PRIMARY KEY,
  to_height   BIGINT NOT NULL CHECK (to_height >= from_height)
);

-- What the history job (src/mappings/money/history/job.ts) found in a block that the indexer's raw event tables lack:
-- per height and event type, the events in the block and the rows in the raw table. A raw table with MORE rows than
-- the block stops the job instead (a parser or fetch bug); fewer is the indexer's gap, recorded here.
CREATE TABLE IF NOT EXISTS ${s}.settlement_history_findings (
  height      BIGINT      NOT NULL,
  event_type  TEXT        NOT NULL,
  chain_count INT         NOT NULL,
  raw_count   INT         NOT NULL,
  found_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (height, event_type)
);

-- The money heights whose bonded validators and delegations the history job read for the replay of validator rows
-- (map_proposer_operator through detailed_batch), with how many it read: written with the height. The snapshot
-- itself is in the job's cache; a replay checks it there against these counts, and reads the chain again for a
-- money height of those eras with no row here or whose cached snapshot is missing, instead of going on without it.
CREATE TABLE IF NOT EXISTS ${s}.settlement_replay_snapshots (
  height      BIGINT      PRIMARY KEY,
  era         TEXT        NOT NULL,
  bonded      INT         NOT NULL,
  delegations INT         NOT NULL,
  taken_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- mint_ratio_unminted_upokt is what the chain's EventClaimSettled calls deflation_loss_upokt: the settled amount minus
-- what the mint ratio minted back (settled x (1 - mint_ratio)), named after the flow the catalog reports.
CREATE TABLE IF NOT EXISTS ${s}.claim_settlements (
  height BIGINT NOT NULL, event_idx INT NOT NULL, block_time TIMESTAMPTZ NOT NULL,
  supplier_id TEXT NOT NULL, supplier_owner_id TEXT, application_id TEXT NOT NULL, service_id TEXT NOT NULL,
  session_id TEXT NOT NULL, session_end BIGINT NOT NULL, source_owner_id TEXT,
  claimed_upokt BIGINT NOT NULL, settled_upokt BIGINT NOT NULL, relay_minted_upokt BIGINT NOT NULL,
  overservicing_loss_upokt BIGINT NOT NULL, mint_ratio_unminted_upokt BIGINT NOT NULL, global_minted_upokt BIGINT NOT NULL,
  relays BIGINT NOT NULL, estimated_relays BIGINT NOT NULL,
  claimed_compute_units BIGINT NOT NULL, estimated_compute_units BIGINT NOT NULL,
  relay_to_supplier_upokt BIGINT NOT NULL, relay_to_dao_upokt BIGINT NOT NULL, relay_to_source_owner_upokt BIGINT NOT NULL, relay_to_application_upokt BIGINT NOT NULL,
  relay_to_stakers_upokt BIGINT NOT NULL CHECK (relay_to_stakers_upokt >= 0),
  global_to_supplier_upokt BIGINT NOT NULL, global_to_dao_upokt BIGINT NOT NULL, global_to_source_owner_upokt BIGINT NOT NULL, global_to_application_upokt BIGINT NOT NULL,
  reimbursement_to_dao_upokt BIGINT NOT NULL,
  row_source TEXT NOT NULL, calc_version INT NOT NULL,
  settled_with_proof BOOLEAN NOT NULL,
  PRIMARY KEY (height, event_idx)
);
CREATE INDEX IF NOT EXISTS claim_settlements_supplier_idx ON ${s}.claim_settlements (supplier_id, height);
CREATE INDEX IF NOT EXISTS claim_settlements_application_idx ON ${s}.claim_settlements (application_id, height);
CREATE INDEX IF NOT EXISTS claim_settlements_source_owner_idx ON ${s}.claim_settlements (source_owner_id, height);
-- by service, the readers use settlement_claims_by_application_service (service_id, height)

CREATE TABLE IF NOT EXISTS ${s}.shareholder_payouts (
  height BIGINT NOT NULL, event_idx INT NOT NULL, supplier_id TEXT NOT NULL, service_id TEXT NOT NULL,
  recipient_id TEXT NOT NULL, relay_upokt BIGINT NOT NULL, global_upokt BIGINT NOT NULL,
  row_source TEXT NOT NULL, calc_version INT NOT NULL,
  PRIMARY KEY (height, event_idx, recipient_id)
);
-- Covering: a shareholder's income by supplier and service over a few days reads the index alone, without visiting the
-- table (council 9).
CREATE INDEX IF NOT EXISTS shareholder_payouts_recipient_covering_idx ON ${s}.shareholder_payouts (recipient_id, height)
  INCLUDE (supplier_id, service_id, relay_upokt, global_upokt);
CREATE INDEX IF NOT EXISTS shareholder_payouts_supplier_idx ON ${s}.shareholder_payouts (supplier_id, height);

-- One row per (height, event_idx, recipient, family): the map era aggregates its staker legs per (height, recipient,
-- family) under event_idx -1 (no single event carries them).
CREATE TABLE IF NOT EXISTS ${s}.staker_payouts (
  height BIGINT NOT NULL, event_idx INT NOT NULL, recipient_id TEXT NOT NULL, op_reason TEXT NOT NULL,
  role TEXT NOT NULL, family TEXT NOT NULL, amount_upokt BIGINT NOT NULL CHECK (amount_upokt >= 0),
  row_source TEXT NOT NULL, calc_version INT NOT NULL,
  PRIMARY KEY (height, event_idx, recipient_id, family)
);
CREATE INDEX IF NOT EXISTS staker_payouts_recipient_idx ON ${s}.staker_payouts (recipient_id, height);

-- commission is NULL in the rows replayed for 288,180–788,944 (src/mappings/money/replay.ts): the protocol charged
-- none there, which is not a commission of 0.
CREATE TABLE IF NOT EXISTS ${s}.validator_distributions (
  height BIGINT NOT NULL, event_idx INT NOT NULL, op_reason TEXT NOT NULL, family TEXT NOT NULL,
  validator_operator TEXT NOT NULL, validator_account TEXT NOT NULL, commission_rate NUMERIC,
  pool_share_upokt BIGINT NOT NULL, commission_upokt BIGINT, self_delegation_upokt BIGINT NOT NULL, to_delegators_upokt BIGINT NOT NULL,
  total_delegated_stake_upokt BIGINT NOT NULL, delegator_count INT NOT NULL,
  row_source TEXT NOT NULL, calc_version INT NOT NULL,
  PRIMARY KEY (height, event_idx)
);
CREATE INDEX IF NOT EXISTS validator_distributions_validator_idx ON ${s}.validator_distributions (validator_operator, height);

-- (delegator, validator) per settlement. The chain does not emit it: in batched_vrd it is derived (two-level largest
-- remainder over the delegations at the settlement height) and checked against the totals the chain emits; in
-- 288,180–788,944 the replay writes it (src/mappings/money/replay.ts): row_source 'replay' where the chain's split is
-- reproduced, 'derived_split' where the chain paid an address without a per-validator split (detailed_batch) and the
-- split over its delegations is ours, 'unattributed' (validator_operator '') where the replay did not match the chain.
CREATE TABLE IF NOT EXISTS ${s}.delegator_validator_payouts (
  height BIGINT NOT NULL, delegator TEXT NOT NULL, validator_operator TEXT NOT NULL, family TEXT NOT NULL,
  amount_upokt BIGINT NOT NULL CHECK (amount_upokt >= 0), row_source TEXT NOT NULL, calc_version INT NOT NULL,
  PRIMARY KEY (height, delegator, validator_operator, family)
);
CREATE INDEX IF NOT EXISTS delegator_validator_payouts_delegator_idx ON ${s}.delegator_validator_payouts (delegator, height);

CREATE TABLE IF NOT EXISTS ${s}.claim_expirations (
  height BIGINT NOT NULL, event_idx INT NOT NULL, supplier_id TEXT NOT NULL, application_id TEXT NOT NULL,
  service_id TEXT NOT NULL, session_end BIGINT NOT NULL, claimed_upokt BIGINT NOT NULL, reason TEXT NOT NULL,
  relays BIGINT NOT NULL, estimated_relays BIGINT NOT NULL,
  claimed_compute_units BIGINT NOT NULL, estimated_compute_units BIGINT NOT NULL,
  PRIMARY KEY (height, event_idx)
);
CREATE INDEX IF NOT EXISTS claim_expirations_supplier_idx ON ${s}.claim_expirations (supplier_id, height);

-- EventClaimDiscarded carries no amount_upokt and no relay counts.
CREATE TABLE IF NOT EXISTS ${s}.claim_discards (
  height BIGINT NOT NULL, event_idx INT NOT NULL, supplier_id TEXT NOT NULL, application_id TEXT NOT NULL,
  service_id TEXT NOT NULL, session_end BIGINT NOT NULL, error TEXT NOT NULL,
  PRIMARY KEY (height, event_idx)
);
CREATE INDEX IF NOT EXISTS claim_discards_supplier_idx ON ${s}.claim_discards (supplier_id, height);

-- stake_after_upokt is NULL before poktroll v0.1.34 (detailed_batch): the slash event has no stake after the slash.
CREATE TABLE IF NOT EXISTS ${s}.supplier_slashes (
  height BIGINT NOT NULL, event_idx INT NOT NULL, supplier_id TEXT NOT NULL, application_id TEXT NOT NULL,
  service_id TEXT NOT NULL, session_end BIGINT NOT NULL, penalty_upokt BIGINT NOT NULL, stake_after_upokt BIGINT,
  PRIMARY KEY (height, event_idx)
);
CREATE INDEX IF NOT EXISTS supplier_slashes_supplier_idx ON ${s}.supplier_slashes (supplier_id, height);

-- Daily rollups (UTC days), incremental: each settlement adds its contribution. They have no CHECK
-- constraints: Postgres checks the proposed row of INSERT ... ON CONFLICT before the conflict, so the
-- negative row that subtracts a height would fail them. _rollup_apply checks the result instead.
CREATE TABLE IF NOT EXISTS ${s}.daily_claims_by_application_service (
  day DATE NOT NULL, application_id TEXT NOT NULL, service_id TEXT NOT NULL, claim_count BIGINT NOT NULL,
  claimed_upokt BIGINT NOT NULL, settled_upokt BIGINT NOT NULL, relay_minted_upokt BIGINT NOT NULL,
  overservicing_loss_upokt BIGINT NOT NULL, mint_ratio_unminted_upokt BIGINT NOT NULL, global_minted_upokt BIGINT NOT NULL,
  relays BIGINT NOT NULL, estimated_relays BIGINT NOT NULL, claimed_compute_units BIGINT NOT NULL, estimated_compute_units BIGINT NOT NULL,
  relay_to_supplier_upokt BIGINT NOT NULL, relay_to_dao_upokt BIGINT NOT NULL, relay_to_source_owner_upokt BIGINT NOT NULL, relay_to_application_upokt BIGINT NOT NULL,
  relay_to_stakers_upokt BIGINT NOT NULL,
  global_to_supplier_upokt BIGINT NOT NULL, global_to_dao_upokt BIGINT NOT NULL, global_to_source_owner_upokt BIGINT NOT NULL, global_to_application_upokt BIGINT NOT NULL,
  reimbursement_to_dao_upokt BIGINT NOT NULL,
  PRIMARY KEY (application_id, day, service_id)
);
CREATE INDEX IF NOT EXISTS daily_claims_by_application_service_day_idx ON ${s}.daily_claims_by_application_service (day);

CREATE TABLE IF NOT EXISTS ${s}.daily_claims_by_supplier (
  day DATE NOT NULL, supplier_id TEXT NOT NULL, claim_count BIGINT NOT NULL,
  claimed_upokt BIGINT NOT NULL, settled_upokt BIGINT NOT NULL, overservicing_loss_upokt BIGINT NOT NULL,
  relays BIGINT NOT NULL, estimated_relays BIGINT NOT NULL, claimed_compute_units BIGINT NOT NULL, estimated_compute_units BIGINT NOT NULL,
  claims_with_proof BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (supplier_id, day)
);

CREATE TABLE IF NOT EXISTS ${s}.daily_claims_by_supplier_application_service (
  day DATE NOT NULL, supplier_id TEXT NOT NULL, application_id TEXT NOT NULL, service_id TEXT NOT NULL,
  claim_count BIGINT NOT NULL,
  claimed_upokt BIGINT NOT NULL, settled_upokt BIGINT NOT NULL, overservicing_loss_upokt BIGINT NOT NULL, global_minted_upokt BIGINT NOT NULL,
  relays BIGINT NOT NULL, estimated_relays BIGINT NOT NULL, claimed_compute_units BIGINT NOT NULL, estimated_compute_units BIGINT NOT NULL,
  claims_with_proof BIGINT NOT NULL,
  PRIMARY KEY (supplier_id, day, application_id, service_id)
);
CREATE INDEX IF NOT EXISTS daily_claims_by_supplier_application_service_application_idx ON ${s}.daily_claims_by_supplier_application_service (application_id, day)
  INCLUDE (supplier_id, service_id, claim_count, settled_upokt, overservicing_loss_upokt, global_minted_upokt, relays, estimated_relays, claimed_compute_units, estimated_compute_units);

-- role: rev_share | dao | source_owner | validator | delegator | proposer | application | stakers;
-- family: relay | global | reimb_escrow.
CREATE TABLE IF NOT EXISTS ${s}.daily_income_by_address (
  day DATE NOT NULL, address TEXT NOT NULL, role TEXT NOT NULL, family TEXT NOT NULL,
  amount_upokt BIGINT NOT NULL, transfer_count BIGINT NOT NULL, contribution_count BIGINT NOT NULL,
  PRIMARY KEY (address, day, role, family)
);

-- Per settlement and address: the base for hourly buckets and day edges in get_income.
CREATE TABLE IF NOT EXISTS ${s}.settlement_income_by_address (
  height BIGINT NOT NULL, address TEXT NOT NULL, role TEXT NOT NULL, family TEXT NOT NULL,
  amount_upokt BIGINT NOT NULL CHECK (amount_upokt >= 0), transfer_count BIGINT NOT NULL,
  PRIMARY KEY (address, height, role, family)
);
CREATE INDEX IF NOT EXISTS settlement_income_by_address_height_idx ON ${s}.settlement_income_by_address (height);

-- Per settlement, application and service: the claims of claim_settlements summed to the grain the application,
-- gateway and service functions read at the edges of a range and for hourly buckets (~1/20 of the claim rows).
CREATE TABLE IF NOT EXISTS ${s}.settlement_claims_by_application_service (
  height BIGINT NOT NULL, block_time TIMESTAMPTZ NOT NULL, application_id TEXT NOT NULL, service_id TEXT NOT NULL,
  claim_count BIGINT NOT NULL, claimed_upokt BIGINT NOT NULL, settled_upokt BIGINT NOT NULL, overservicing_loss_upokt BIGINT NOT NULL,
  global_minted_upokt BIGINT NOT NULL, relays BIGINT NOT NULL, estimated_relays BIGINT NOT NULL,
  claimed_compute_units BIGINT NOT NULL, estimated_compute_units BIGINT NOT NULL,
  PRIMARY KEY (height, application_id, service_id)
);
CREATE INDEX IF NOT EXISTS settlement_claims_by_application_service_application_idx
  ON ${s}.settlement_claims_by_application_service (application_id, height);
CREATE INDEX IF NOT EXISTS settlement_claims_by_application_service_service_idx
  ON ${s}.settlement_claims_by_application_service (service_id, height);

CREATE TABLE IF NOT EXISTS ${s}.settlement_supply_flows (
  height BIGINT PRIMARY KEY, settled_upokt BIGINT NOT NULL, relay_minted_upokt BIGINT NOT NULL, mint_ratio_unminted_upokt BIGINT NOT NULL,
  overservicing_loss_upokt BIGINT NOT NULL, relay_to_supplier_upokt BIGINT NOT NULL, relay_to_dao_upokt BIGINT NOT NULL, relay_to_source_owner_upokt BIGINT NOT NULL,
  relay_to_application_upokt BIGINT NOT NULL, relay_to_stakers_upokt BIGINT NOT NULL, global_to_supplier_upokt BIGINT NOT NULL, global_to_dao_upokt BIGINT NOT NULL,
  global_to_source_owner_upokt BIGINT NOT NULL, global_to_application_upokt BIGINT NOT NULL, reimbursement_to_dao_upokt BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS ${s}.monthly_income_by_address_supplier (
  month DATE NOT NULL, supplier_id TEXT NOT NULL, address TEXT NOT NULL, role TEXT NOT NULL, family TEXT NOT NULL,
  amount_upokt BIGINT NOT NULL, transfer_count BIGINT NOT NULL, contribution_count BIGINT NOT NULL,
  PRIMARY KEY (address, month, supplier_id, role, family)
);

-- Per generating supplier; includes the 'stakers' row with address '' (= sum of relay_to_stakers_upokt).
CREATE TABLE IF NOT EXISTS ${s}.daily_income_by_address_supplier (
  day DATE NOT NULL, supplier_id TEXT NOT NULL, address TEXT NOT NULL, role TEXT NOT NULL, family TEXT NOT NULL,
  amount_upokt BIGINT NOT NULL, transfer_count BIGINT NOT NULL, contribution_count BIGINT NOT NULL,
  PRIMARY KEY (supplier_id, day, address, role, family)
);
CREATE INDEX IF NOT EXISTS daily_income_by_address_supplier_address_idx ON ${s}.daily_income_by_address_supplier (address, day)
  INCLUDE (supplier_id, role, family, amount_upokt, transfer_count);

CREATE TABLE IF NOT EXISTS ${s}.daily_income_by_address_service (
  day DATE NOT NULL, address TEXT NOT NULL, role TEXT NOT NULL, family TEXT NOT NULL, service_id TEXT NOT NULL,
  amount_upokt BIGINT NOT NULL, transfer_count BIGINT NOT NULL, contribution_count BIGINT NOT NULL,
  PRIMARY KEY (address, day, role, family, service_id)
);

-- Per month and service: what get_income by service sums for whole months (month / year buckets or a long total).
CREATE TABLE IF NOT EXISTS ${s}.monthly_income_by_address_service (
  month DATE NOT NULL, address TEXT NOT NULL, role TEXT NOT NULL, family TEXT NOT NULL, service_id TEXT NOT NULL,
  amount_upokt BIGINT NOT NULL, transfer_count BIGINT NOT NULL, contribution_count BIGINT NOT NULL,
  PRIMARY KEY (address, month, role, family, service_id)
);

-- Per month, generating supplier and service: what get_income by supplier and service sums for whole months. Monthly
-- only: a (supplier, service) pair settles ~2 claims a day on mainnet, so a daily one would be as large as its base.
-- No month index: its zero rows are deleted by the keys of the height (writer.ts), and only rebuild_rollups scans it.
CREATE TABLE IF NOT EXISTS ${s}.monthly_income_by_address_supplier_service (
  month DATE NOT NULL, address TEXT NOT NULL, supplier_id TEXT NOT NULL, service_id TEXT NOT NULL, role TEXT NOT NULL,
  family TEXT NOT NULL, amount_upokt BIGINT NOT NULL, transfer_count BIGINT NOT NULL, contribution_count BIGINT NOT NULL,
  PRIMARY KEY (address, month, supplier_id, service_id, role, family)
);

-- commission_upokt sums the contributions that have a commission; commission_na_count counts those that do not (the
-- replayed rows): NULL only when every contribution of the row is one of them, so a day that mixes both (788,944 and
-- 788,945) keeps the real commission instead of losing it to NULL + x.
CREATE TABLE IF NOT EXISTS ${s}.daily_validator_rewards (
  day DATE NOT NULL, validator_operator TEXT NOT NULL, family TEXT NOT NULL, contribution_count BIGINT NOT NULL,
  pool_share_upokt BIGINT NOT NULL, commission_upokt BIGINT, self_delegation_upokt BIGINT NOT NULL,
  to_delegators_upokt BIGINT NOT NULL, commission_na_count BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (validator_operator, day, family)
);

-- replayed_count: the contributions replayed from the delegations snapshot (row_source replay / derived_split), as
-- get_validator_rewards counts them.
CREATE TABLE IF NOT EXISTS ${s}.daily_delegator_rewards_by_validator (
  day DATE NOT NULL, delegator TEXT NOT NULL, validator_operator TEXT NOT NULL, family TEXT NOT NULL,
  amount_upokt BIGINT NOT NULL, contribution_count BIGINT NOT NULL, replayed_count BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (delegator, day, validator_operator, family)
);

-- Per address, UTC hour and generating supplier: the hourly series of what an address earned from a set of
-- suppliers (igniter's rewards-by-supplier chart). Only rows tied to a claim (supplier_id <> '').
CREATE TABLE IF NOT EXISTS ${s}.hourly_income_by_address_supplier (
  address TEXT NOT NULL, hour TIMESTAMPTZ NOT NULL, supplier_id TEXT NOT NULL,
  amount_upokt BIGINT NOT NULL, contribution_count BIGINT NOT NULL,
  PRIMARY KEY (address, hour, supplier_id)
);

-- Rewriting a height deletes the rollup rows left at 0 contributions, found through an index on the time column.
-- Plain, not partial on the count: a column in an index predicate counts as indexed, and every settlement changes
-- the count, so a partial index would stop every update of these rows from being HOT (measured 0 of ~45k in tilt).
CREATE INDEX IF NOT EXISTS daily_income_by_address_day_idx ON ${s}.daily_income_by_address (day);
CREATE INDEX IF NOT EXISTS daily_income_by_address_supplier_day_idx ON ${s}.daily_income_by_address_supplier (day);
CREATE INDEX IF NOT EXISTS daily_income_by_address_service_day_idx ON ${s}.daily_income_by_address_service (day);
CREATE INDEX IF NOT EXISTS daily_claims_by_supplier_day_idx ON ${s}.daily_claims_by_supplier (day);
CREATE INDEX IF NOT EXISTS daily_claims_by_supplier_application_service_day_idx ON ${s}.daily_claims_by_supplier_application_service (day);
CREATE INDEX IF NOT EXISTS monthly_income_by_address_service_month_idx ON ${s}.monthly_income_by_address_service (month);
CREATE INDEX IF NOT EXISTS monthly_income_by_address_supplier_month_idx ON ${s}.monthly_income_by_address_supplier (month);
CREATE INDEX IF NOT EXISTS daily_delegator_rewards_by_validator_day_idx ON ${s}.daily_delegator_rewards_by_validator (day);
CREATE INDEX IF NOT EXISTS daily_validator_rewards_day_idx ON ${s}.daily_validator_rewards (day);
CREATE INDEX IF NOT EXISTS hourly_income_by_address_supplier_hour_idx ON ${s}.hourly_income_by_address_supplier (hour);

-- The incremental rollups update the same rows at every settlement of their day (~70 per day on mainnet): free
-- space in each page lets an update stay in the page (HOT: no indexed column changes, except in the two tables
-- whose covering indexes include amounts), and vacuum runs after 2% of a table changed instead of 20%.
ALTER TABLE ${s}.daily_claims_by_application_service SET (fillfactor = 90, autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.02);
ALTER TABLE ${s}.daily_claims_by_supplier SET (fillfactor = 90, autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.02);
ALTER TABLE ${s}.daily_claims_by_supplier_application_service SET (fillfactor = 90, autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.02);
ALTER TABLE ${s}.daily_income_by_address SET (fillfactor = 90, autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.02);
ALTER TABLE ${s}.daily_income_by_address_supplier SET (fillfactor = 90, autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.02);
ALTER TABLE ${s}.daily_income_by_address_service SET (fillfactor = 90, autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.02);
ALTER TABLE ${s}.monthly_income_by_address_supplier SET (fillfactor = 90, autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.02);
ALTER TABLE ${s}.monthly_income_by_address_service SET (fillfactor = 90, autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.02);
ALTER TABLE ${s}.monthly_income_by_address_supplier_service SET (fillfactor = 90, autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.02);
ALTER TABLE ${s}.hourly_income_by_address_supplier SET (fillfactor = 90, autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.02);
ALTER TABLE ${s}.daily_validator_rewards SET (fillfactor = 90, autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.02);
ALTER TABLE ${s}.daily_delegator_rewards_by_validator SET (fillfactor = 90, autovacuum_vacuum_scale_factor = 0.02, autovacuum_analyze_scale_factor = 0.02);
`;
}
