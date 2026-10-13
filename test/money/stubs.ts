// The entity tables the newer catalog functions read (get_actor_lifecycle, get_relay_mining_difficulty,
// get_created_claims, get_block_stats), reduced to their columns, with one row per height that the heights query
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
        'tx' || b.id, b.id FROM (${heights}) b(id);`;
