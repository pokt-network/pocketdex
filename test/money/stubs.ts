import { createTxCountsDailyTableFn, createTxCountsOfBlocksFn } from "../../src/mappings/dbFunctions/txCounts";

// The entity tables the newer catalog functions read (get_actor_lifecycle, get_relay_mining_difficulty, get_claims,
// get_created_claims, get_block_stats, get_morse_claims), reduced to their columns, with one row per height that the heights query
// returns (each height needs its blocks row): supplier sup-l, application app-l, service svc-d; and the blocks' report
// columns. Run inside the test's transaction.
export const entityStubsSql = (S: string, heights: string): string => `
      ALTER TABLE ${S}.blocks ADD COLUMN size int, ADD COLUMN time_to_block numeric, ADD COLUMN total_txs int,
        ADD COLUMN successful_txs int, ADD COLUMN failed_txs int, ADD COLUMN total_relays numeric,
        ADD COLUMN total_estimated_relays numeric, ADD COLUMN total_computed_units numeric,
        ADD COLUMN total_estimated_computed_units numeric;
      UPDATE ${S}.blocks SET size = 100, time_to_block = 60000, total_txs = 2, successful_txs = 1, failed_txs = 1,
        total_relays = 10, total_estimated_relays = 11, total_computed_units = 20, total_estimated_computed_units = 21;
      CREATE TABLE ${S}.msg_stake_suppliers (id text, supplier_id text, owner_id text, stake_amount numeric, block_id numeric, transaction_id text);
      CREATE TABLE ${S}.msg_unstake_suppliers (id text, supplier_id text, block_id numeric, transaction_id text);
      CREATE TABLE ${S}.event_supplier_unbonding_begins (id text, supplier_id text, reason text, unbonding_end_height numeric,
        session_end_height numeric, block_id numeric);
      CREATE TABLE ${S}.event_supplier_unbonding_ends (LIKE ${S}.event_supplier_unbonding_begins);
      CREATE TABLE ${S}.event_supplier_slasheds (id text, supplier_id text, application_id text, service_id text, session_id text,
        session_end_height numeric, proof_validation_status text, proof_missing_penalty numeric, previous_stake_amount numeric,
        after_stake_amount numeric, block_id numeric);
      CREATE TABLE ${S}.msg_stake_applications (id text, application_id text, stake_amount numeric, block_id numeric, transaction_id text);
      CREATE TABLE ${S}.msg_unstake_applications (id text, application_id text, block_id numeric, transaction_id text);
      CREATE TABLE IF NOT EXISTS ${S}.event_application_unbonding_begins (application_id text, reason int, block_id numeric);
      ALTER TABLE ${S}.event_application_unbonding_begins ADD COLUMN IF NOT EXISTS id text,
        ADD COLUMN IF NOT EXISTS session_end_height numeric, ADD COLUMN IF NOT EXISTS unstaking_end_height numeric;
      CREATE TABLE ${S}.event_application_unbonding_ends (LIKE ${S}.event_application_unbonding_begins);
      CREATE TABLE ${S}.msg_stake_gateways (id text, gateway_id text, stake_amount numeric, block_id numeric, transaction_id text);
      CREATE TABLE ${S}.msg_unstake_gateways (id text, gateway_id text, block_id numeric, transaction_id text);
      CREATE TABLE ${S}.event_gateway_unbonding_begins (id text, gateway_id text, unbonding_end_height numeric,
        session_end_height numeric, block_id numeric, transaction_id text);
      CREATE TABLE ${S}.event_gateway_unbonding_ends (id text, gateway_id text, unbonding_end_height numeric,
        session_end_height numeric, block_id numeric);
      CREATE TABLE ${S}.event_relay_mining_difficulty_updateds (service_id text, prev_target_hash_hex_encoded text,
        new_target_hash_hex_encoded text, prev_num_relays_ema numeric, new_num_relays_ema numeric, block_id numeric);
      CREATE TABLE ${S}.msg_delegate_to_gateways (id text, application_id text, gateway_id text, block_id numeric, transaction_id text);
      CREATE TABLE ${S}.msg_undelegate_from_gateways (LIKE ${S}.msg_delegate_to_gateways);
      CREATE TABLE ${S}.msg_claim_morse_accounts (id text, shannon_signing_address text, shannon_dest_address text,
        morse_src_address text, balance_amount numeric, block_id numeric, transaction_id text);
      CREATE TABLE ${S}.msg_claim_morse_applications (id text, shannon_signing_address text, shannon_dest_address text,
        morse_src_address text, stake_amount numeric, balance_amount numeric, block_id numeric, transaction_id text);
      CREATE TABLE ${S}.msg_claim_morse_application_services (id text, claim_msg_id text, service_id text);
      CREATE TABLE ${S}.msg_claim_morse_suppliers (id text, shannon_signing_address text, shannon_owner_address text,
        shannon_operator_address text, morse_src_address text, morse_node_address text, claim_signer_type text,
        stake_amount numeric, balance_amount numeric, block_id numeric, transaction_id text);
      CREATE TABLE ${S}.msg_claim_morse_supplier_services (id text, claim_msg_id text, service_id text);
      CREATE TABLE ${S}.msg_recover_morse_accounts (id text, shannon_dest_address_id text, morse_src_address text,
        recovered_balance_amount numeric, is_admin boolean, block_id numeric, transaction_id text);
      -- get_native_transfers: one transfer per height from acc-s to acc-r, and its transaction
      CREATE TABLE ${S}.native_transfers (id text, sender_id text, recipient_id text, denom text, amounts jsonb, status text,
        transaction_id text, block_id numeric, _block_range int8range);
      CREATE TABLE IF NOT EXISTS ${S}.transactions (id text, _block_range int8range);
      ALTER TABLE ${S}.transactions ADD COLUMN IF NOT EXISTS code integer, ADD COLUMN IF NOT EXISTS codespace text,
        ADD COLUMN IF NOT EXISTS fees jsonb, ADD COLUMN IF NOT EXISTS signer_address text, ADD COLUMN IF NOT EXISTS memo text,
        ADD COLUMN IF NOT EXISTS block_id numeric, ADD COLUMN IF NOT EXISTS amount_of_messages jsonb;
      -- get_morse_claims' supplier destination
      CREATE TABLE IF NOT EXISTS ${S}.morse_claimable_accounts (id text, _block_range int8range);
      ALTER TABLE ${S}.morse_claimable_accounts ADD COLUMN IF NOT EXISTS claimed_msg_id text,
        ADD COLUMN IF NOT EXISTS shannon_dest_address text;
      -- get_claims' current_owner_id
      CREATE TABLE IF NOT EXISTS ${S}.suppliers (id text, _block_range int8range);
      ALTER TABLE ${S}.suppliers ADD COLUMN IF NOT EXISTS owner_id text;
      CREATE TABLE ${S}.msg_create_claims (id text, supplier_id text, application_id text, service_id text, session_id text,
        session_end_height numeric, num_relays numeric, num_estimated_relays numeric, num_claimed_computed_units numeric,
        num_estimated_computed_units numeric, claimed_amount numeric, transaction_id text, block_id numeric);
      INSERT INTO ${S}.msg_stake_suppliers SELECT 'ms' || b.id, 'sup-l', 'own-l', 1000, b.id, 'tx' || b.id
        FROM (${heights}) b(id);
      INSERT INTO ${S}.msg_stake_applications SELECT 'ma' || b.id, 'app-l', 500, b.id, 'tx' || b.id
        FROM (${heights}) b(id);
      INSERT INTO ${S}.event_relay_mining_difficulty_updateds SELECT 'svc-d', 'ff', 'fe', 10, 20, b.id
        FROM (${heights}) b(id);
      INSERT INTO ${S}.msg_create_claims SELECT 'mc' || b.id, 'sup-l', 'app-l', 'svc-d', 'sess' || b.id, b.id, 5, 6, 7, 8, 9,
        'tx' || b.id, b.id FROM (${heights}) b(id);
      INSERT INTO ${S}.native_transfers SELECT 'nt' || b.id, 'acc-s', 'acc-r', 'upokt', '[{"denom": "upokt", "amount": "5"}]',
        'Success', 'tx' || b.id, b.id, int8range(b.id::bigint, NULL) FROM (${heights}) b(id);
      INSERT INTO ${S}.transactions (id, code, codespace, fees, signer_address, memo, block_id, amount_of_messages, _block_range)
        SELECT 'tx' || b.id, 0, '', '[{"denom": "upokt", "amount": "1"}]', 'acc-s', 'm', b.id,
          '[{"type": "/cosmos.bank.v1beta1.MsgSend", "amount": 1}]', int8range(b.id::bigint, NULL)
        FROM (${heights}) b(id);
      -- get_tx_counts: the rollup (empty here: every day is a gap) and the helper that reads the edges
      ${createTxCountsDailyTableFn(S)}
      ${createTxCountsOfBlocksFn(S)}
      INSERT INTO ${S}.msg_claim_morse_accounts SELECT 'mm' || b.id, 'pokt-sign', 'pokt-dest', 'MORSE' || b.id, 100, b.id,
        'tx' || b.id FROM (${heights}) b(id);`;
