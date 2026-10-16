-- The entity tables SubQuery creates for schema.graphql (73 of them, with their indexes and the @foreignKey comments
-- SubQuery writes), for the schema "mainnet": the starting point test/graphql/setup.ts applies the release's startup DDL
-- to. Schema only, no data. Regenerate when schema.graphql changes:
--   pg_dump -s --no-owner --no-privileges -d <a database that has run the indexer> -t 'mainnet.<table>' ... (the 73
--   tables of the entities in schema.graphql, plus mainnet._metadata) and the enum types of the schema
-- test/graphql/setup.ts fails when a table of an entity in schema.graphql is missing here.
--
-- PostgreSQL database dump
--


-- Dumped from database version 16.15 (Debian 16.15-1.pgdg13+2)
-- Dumped by pg_dump version 16.15 (Debian 16.15-1.pgdg13+2)

-- the enum types the tables use (SubQuery names them by hash)
CREATE TYPE mainnet."1a17296b39" AS ENUM ('Staked', 'Unstaking', 'Unstaked');
CREATE TYPE mainnet."1c563c52f4" AS ENUM ('Success', 'Error');
CREATE TYPE mainnet."307ae33cc6" AS ENUM ('MORSE_SUPPLIER_CLAIM_SIGNER_TYPE_UNSPECIFIED', 'MORSE_SUPPLIER_CLAIM_CUSTODIAL_SIGNED_BY_NODE_ADDR', 'MORSE_SUPPLIER_CLAIM_NON_CUSTODIAL_SIGNED_BY_NODE_ADDR', 'MORSE_SUPPLIER_CLAIM_NON_CUSTODIAL_SIGNED_BY_OWNER');
CREATE TYPE mainnet."3c255f32dd" AS ENUM ('EXPIRATION_REASON_UNSPECIFIED', 'PROOF_MISSING', 'PROOF_INVALID');
CREATE TYPE mainnet."bc79f39c65" AS ENUM ('UNSPECIFIED', 'VOLUNTARY', 'BELOW_MIN_STAKE', 'MIGRATION');
CREATE TYPE mainnet."bf92ec2576" AS ENUM ('Pending', 'Success', 'Fail');
CREATE TYPE mainnet."c8206fb405" AS ENUM ('UNSPECIFIED', 'TLM_RELAY_BURN_EQUALS_MINT_SUPPLIER_STAKE_MINT', 'TLM_RELAY_BURN_EQUALS_MINT_APPLICATION_STAKE_BURN', 'TLM_GLOBAL_MINT_INFLATION', 'TLM_RELAY_BURN_EQUALS_MINT_SUPPLIER_SHAREHOLDER_RD', 'TLM_GLOBAL_MINT_DAO_REWARD_DISTRIBUTION', 'TLM_GLOBAL_MINT_PROPOSER_REWARD_DISTRIBUTION', 'TLM_GLOBAL_MINT_SUPPLIER_SHAREHOLDER_REWARD_DISTRIBUTION', 'TLM_GLOBAL_MINT_SOURCE_OWNER_REWARD_DISTRIBUTION', 'TLM_GLOBAL_MINT_APPLICATION_REWARD_DISTRIBUTION', 'TLM_GLOBAL_MINT_REIMBURSEMENT_REQUEST_ESCROW_DAO_TRANSFER', 'UNSPECIFIED_TLM_SUPPLIER_SLASH_MODULE_TRANSFER', 'UNSPECIFIED_TLM_SUPPLIER_SLASH_STAKE_BURN', 'TLM_GLOBAL_MINT_SUPPLIER_SHAREHOLDER_REWARD_MODULE_TRANSFER', 'TLM_GLOBAL_MINT_REIMBURSEMENT_REQUEST_ESCROW_MODULE_TRANSFER', 'TLM_RELAY_BURN_EQUALS_MINT_DAO_REWARD_DISTRIBUTION', 'TLM_RELAY_BURN_EQUALS_MINT_SOURCE_OWNER_RD', 'TLM_RELAY_BURN_EQUALS_MINT_APPLICATION_RD', 'TLM_RELAY_BURN_EQUALS_MINT_TOKENOMICS_MINT', 'TLM_RELAY_BURN_EQUALS_MINT_VALIDATOR_RD', 'TLM_RELAY_BURN_EQUALS_MINT_DELEGATOR_RD', 'TLM_GLOBAL_MINT_VALIDATOR_REWARD_DISTRIBUTION', 'TLM_GLOBAL_MINT_DELEGATOR_REWARD_DISTRIBUTION');
CREATE TYPE mainnet."d2ebb7b2be" AS ENUM ('NOT_REQUIRED', 'PROBABILISTIC', 'THRESHOLD');
CREATE TYPE mainnet."f8e3effa3a" AS ENUM ('Genesis', 'Message', 'Transaction', 'BeginBlock', 'EndBlock', 'FinalizeBlock');
CREATE TYPE mainnet."fdbe532f64" AS ENUM ('ELECTIVE', 'BELOW_MINIMUM_STAKE', 'TRANSFER', 'MIGRATION');
CREATE TYPE mainnet."fe879004fe" AS ENUM ('PENDING_VALIDATION', 'VALIDATED', 'INVALID');

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: balances; Type: TABLE; Schema: mainnet; Owner: -
--

CREATE TABLE mainnet.balances (
    id text NOT NULL,
    account_id text NOT NULL,
    denom text NOT NULL,
    amount numeric NOT NULL,
    last_updated_block_id numeric NOT NULL,
    _id uuid NOT NULL,
    _block_range int8range NOT NULL
);


--
-- Name: TABLE balances; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON TABLE mainnet.balances IS '@foreignKey (last_updated_block_id) REFERENCES blocks (id)|@foreignFieldName balancesOfAccountByDenom|@deprecated Relations will be removed from the schema: query the related entity by its key. See https://github.com/pokt-network/pocketdex/blob/main/docs/graphql-migration.md
@foreignKey (account_id) REFERENCES accounts (id)|@foreignFieldName balances|@deprecated Relations will be removed from the schema: query the related entity by its key. See https://github.com/pokt-network/pocketdex/blob/main/docs/graphql-migration.md
One row per address and denom with the balance after its last change. SubQuery keeps its history; GraphQL lists show the current version of each row unless asked for an earlier height.';


--
-- Name: COLUMN balances.id; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.balances.id IS 'Address and denom joined by ''-''.';


--
-- Name: COLUMN balances.account_id; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.balances.account_id IS 'The holder''s address (Account id).';


--
-- Name: COLUMN balances.denom; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.balances.denom IS 'Coin denom.';


--
-- Name: COLUMN balances.amount; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.balances.amount IS 'Balance in the denom''s base unit (upokt for upokt). Module account balances are read from the chain every block; other balances are the running sum of the chain''s coin_received and coin_spent events.';


--
-- Name: COLUMN balances.last_updated_block_id; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.balances.last_updated_block_id IS 'Height of the block where the balance last changed.';


--
-- Name: native_transfers; Type: TABLE; Schema: mainnet; Owner: -
--

CREATE TABLE mainnet.native_transfers (
    id text NOT NULL,
    sender_id text NOT NULL,
    recipient_id text NOT NULL,
    amounts jsonb NOT NULL,
    denom text NOT NULL,
    status mainnet."1c563c52f4" NOT NULL,
    event_id text NOT NULL,
    message_id text NOT NULL,
    transaction_id text NOT NULL,
    block_id numeric NOT NULL,
    _id uuid NOT NULL,
    _block_range int8range NOT NULL
);


--
-- Name: TABLE native_transfers; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON TABLE mainnet.native_transfers IS '@foreignKey (recipient_id) REFERENCES accounts (id)|@deprecated Relations will be removed from the schema: query the related entity by its key. See https://github.com/pokt-network/pocketdex/blob/main/docs/graphql-migration.md
@foreignKey (sender_id) REFERENCES accounts (id)|@deprecated Relations will be removed from the schema: query the related entity by its key. See https://github.com/pokt-network/pocketdex/blob/main/docs/graphql-migration.md
@foreignKey (event_id) REFERENCES events (id)|@deprecated Relations will be removed from the schema: query the related entity by its key. See https://github.com/pokt-network/pocketdex/blob/main/docs/graphql-migration.md
@foreignKey (message_id) REFERENCES messages (id)|@deprecated Relations will be removed from the schema: query the related entity by its key. See https://github.com/pokt-network/pocketdex/blob/main/docs/graphql-migration.md
@foreignKey (transaction_id) REFERENCES transactions (id)|@deprecated Relations will be removed from the schema: query the related entity by its key. See https://github.com/pokt-network/pocketdex/blob/main/docs/graphql-migration.md
@foreignKey (block_id) REFERENCES blocks (id)|@deprecated Relations will be removed from the schema: query the related entity by its key. See https://github.com/pokt-network/pocketdex/blob/main/docs/graphql-migration.md
One row per bank MsgSend message, from successful and failed transactions alike. Rows are not updated after they are written.';


--
-- Name: COLUMN native_transfers.id; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.native_transfers.id IS 'Message id: the transaction hash and the message index joined by ''-''.';


--
-- Name: COLUMN native_transfers.sender_id; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.native_transfers.sender_id IS 'Address that sends the coins, the MsgSend from_address (Account id).';


--
-- Name: COLUMN native_transfers.recipient_id; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.native_transfers.recipient_id IS 'Address that receives the coins, the MsgSend to_address (Account id).';


--
-- Name: COLUMN native_transfers.amounts; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.native_transfers.amounts IS 'Coins sent, as a JSON list [{denom, amount}], amount a string in the denom''s base unit (upokt for upokt).';


--
-- Name: COLUMN native_transfers.denom; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.native_transfers.denom IS 'Denom of the first coin in amounts.';


--
-- Name: COLUMN native_transfers.status; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.native_transfers.status IS 'TxStatus of the transaction that carries the message: Success or Error.';


--
-- Name: COLUMN native_transfers.event_id; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.native_transfers.event_id IS 'Same value as message_id.';


--
-- Name: COLUMN native_transfers.message_id; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.native_transfers.message_id IS 'Id of the MsgSend message; same value as id.';


--
-- Name: COLUMN native_transfers.transaction_id; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.native_transfers.transaction_id IS 'Hash of the transaction that carries the message.';


--
-- Name: COLUMN native_transfers.block_id; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.native_transfers.block_id IS 'Height of the block that includes the transaction.';


--
-- Name: transactions; Type: TABLE; Schema: mainnet; Owner: -
--

CREATE TABLE mainnet.transactions (
    id text NOT NULL,
    block_id numeric NOT NULL,
    gas_used numeric NOT NULL,
    gas_wanted numeric NOT NULL,
    fees jsonb NOT NULL,
    memo text,
    status mainnet."1c563c52f4" NOT NULL,
    log text,
    code integer NOT NULL,
    idx integer NOT NULL,
    codespace text,
    timeout_height numeric,
    signer_address text,
    is_multisig boolean NOT NULL,
    multisig jsonb,
    _id uuid NOT NULL,
    _block_range int8range NOT NULL,
    amount_of_messages jsonb,
    amount_sent_by_denom jsonb
);


--
-- Name: TABLE transactions; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON TABLE mainnet.transactions IS '@foreignKey (block_id) REFERENCES blocks (id)|@foreignFieldName transactions|@deprecated Relations will be removed from the schema: query the related entity by its key. See https://github.com/pokt-network/pocketdex/blob/main/docs/graphql-migration.md
One row per transaction, successful or failed, plus placeholder rows the indexer creates at the genesis height for the genesis state. Rows are not updated after they are written.';


--
-- Name: COLUMN transactions.id; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.transactions.id IS 'Transaction hash, uppercase hex. Genesis placeholder rows use a made-up hash: zeros followed by a counter and a letter.';


--
-- Name: COLUMN transactions.block_id; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.transactions.block_id IS 'Height of the block that includes the transaction.';


--
-- Name: COLUMN transactions.gas_used; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.transactions.gas_used IS 'Gas the transaction consumed.';


--
-- Name: COLUMN transactions.gas_wanted; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.transactions.gas_wanted IS 'Gas limit the transaction requested.';


--
-- Name: COLUMN transactions.fees; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.transactions.fees IS 'Fee paid, as a JSON list of coins [{denom, amount}], amount a string in the denom''s base unit (upokt for upokt); empty list when no fee was set.';


--
-- Name: COLUMN transactions.memo; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.transactions.memo IS 'Memo from the transaction body; may be empty.';


--
-- Name: COLUMN transactions.status; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.transactions.status IS 'TxStatus: Success when code is 0, Error otherwise.';


--
-- Name: COLUMN transactions.log; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.transactions.log IS 'Raw log the chain returned for the transaction; empty string when there is none.';


--
-- Name: COLUMN transactions.code; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.transactions.code IS 'Result code: 0 is success, any other value is an error of the module named in codespace.';


--
-- Name: COLUMN transactions.idx; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.transactions.idx IS 'Index of the transaction within its block.';


--
-- Name: COLUMN transactions.codespace; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.transactions.codespace IS 'Module namespace of a non-zero result code; may be empty.';


--
-- Name: COLUMN transactions.timeout_height; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.transactions.timeout_height IS 'Height after which the sender asked the chain not to include the transaction; 0 when unset, null on some genesis placeholder rows.';


--
-- Name: COLUMN transactions.signer_address; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.transactions.signer_address IS 'Address of the first signer (pokt prefix, or poktvaloper for validator-related messages); for a multisig, the multisig address. Null on most genesis placeholder rows.';


--
-- Name: COLUMN transactions.is_multisig; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.transactions.is_multisig IS 'True when the transaction is signed with a legacy amino multisig key.';


--
-- Name: COLUMN transactions.multisig; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.transactions.multisig IS 'Null unless is_multisig. JSON with from (multisig address), all (member addresses), signed (addresses that signed), indices, threshold, multisigPubKey, bitarrayElems and extraBitsStored.';


--
-- Name: COLUMN transactions.amount_of_messages; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.transactions.amount_of_messages IS 'Message count per type, as a JSON list [{type, amount}]: type is the message type URL (e.g. /cosmos.bank.v1beta1.MsgSend), amount how many the transaction carries. Null on genesis placeholder rows.';


--
-- Name: COLUMN transactions.amount_sent_by_denom; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.transactions.amount_sent_by_denom IS 'Total sent by the transaction''s MsgSend messages per denom, as a JSON list [{denom, amount}], amount a string; empty list when there is no MsgSend. Null on genesis placeholder rows.';


--
-- Name: accounts; Type: TABLE; Schema: mainnet; Owner: -
--

CREATE TABLE mainnet.accounts (
    id text NOT NULL,
    chain_id text NOT NULL,
    module_id text,
    _id uuid NOT NULL,
    _block_range int8range NOT NULL
);


--
-- Name: TABLE accounts; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON TABLE mainnet.accounts IS '@foreignKey (module_id) REFERENCES module_accounts (id)|@deprecated Relations will be removed from the schema: query the related entity by its key. See https://github.com/pokt-network/pocketdex/blob/main/docs/graphql-migration.md
One row per address the indexer has seen: in a coin movement, as a module account, in the genesis state, or as a validator signer. Each address is written once and not updated.';


--
-- Name: COLUMN accounts.id; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.accounts.id IS 'Bech32 address (pokt..., or poktvaloper... for a validator operator).';


--
-- Name: COLUMN accounts.chain_id; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.accounts.chain_id IS 'Chain id of the block where the address was first written.';


--
-- Name: COLUMN accounts.module_id; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.accounts.module_id IS 'Not populated (null).';


--
-- Name: application_gateways; Type: TABLE; Schema: mainnet; Owner: -
--

CREATE TABLE mainnet.application_gateways (
    id text NOT NULL,
    gateway_id text NOT NULL,
    application_id text NOT NULL,
    _id uuid NOT NULL,
    _block_range int8range NOT NULL
);


--
-- Name: TABLE application_gateways; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON TABLE mainnet.application_gateways IS '@foreignKey (gateway_id) REFERENCES gateways (id)|@deprecated Relations will be removed from the schema: query the related entity by its key. See https://github.com/pokt-network/pocketdex/blob/main/docs/graphql-migration.md
@foreignKey (application_id) REFERENCES applications (id)|@deprecated Relations will be removed from the schema: query the related entity by its key. See https://github.com/pokt-network/pocketdex/blob/main/docs/graphql-migration.md
One row per application and gateway the application delegates to. A row leaves the current list on undelegation, when the application finishes unbonding or is transferred, or when the gateway finishes unbonding; SubQuery keeps its history; GraphQL lists show the current version of each row unless asked for an earlier height.';


--
-- Name: COLUMN application_gateways.id; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.application_gateways.id IS 'Application address and gateway address joined by ''-''.';


--
-- Name: COLUMN application_gateways.gateway_id; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.application_gateways.gateway_id IS 'The gateway''s address (Gateway id).';


--
-- Name: COLUMN application_gateways.application_id; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.application_gateways.application_id IS 'The application''s address (Application id).';


--
-- Name: application_services; Type: TABLE; Schema: mainnet; Owner: -
--

CREATE TABLE mainnet.application_services (
    id text NOT NULL,
    application_id text NOT NULL,
    service_id text NOT NULL,
    _id uuid NOT NULL,
    _block_range int8range NOT NULL
);


--
-- Name: TABLE application_services; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON TABLE mainnet.application_services IS '@foreignKey (application_id) REFERENCES applications (id)|@deprecated Relations will be removed from the schema: query the related entity by its key. See https://github.com/pokt-network/pocketdex/blob/main/docs/graphql-migration.md
@foreignKey (service_id) REFERENCES services (id)|@deprecated Relations will be removed from the schema: query the related entity by its key. See https://github.com/pokt-network/pocketdex/blob/main/docs/graphql-migration.md
One row per application and service the application is staked for. A row leaves the current list when a new stake drops the service, the application finishes unbonding, or it is transferred; SubQuery keeps its history; GraphQL lists show the current version of each row unless asked for an earlier height.';


--
-- Name: COLUMN application_services.id; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.application_services.id IS 'Application address and service id joined by ''-''.';


--
-- Name: COLUMN application_services.application_id; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.application_services.application_id IS 'The application''s address (Application id).';


--
-- Name: COLUMN application_services.service_id; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.application_services.service_id IS 'The service''s id (Service id).';


--
-- Name: applications; Type: TABLE; Schema: mainnet; Owner: -
--

CREATE TABLE mainnet.applications (
    id text NOT NULL,
    account_id text NOT NULL,
    stake_amount numeric NOT NULL,
    stake_denom text NOT NULL,
    stake_status mainnet."1a17296b39" NOT NULL,
    unstaking_begin_block_id numeric,
    unstaking_end_height numeric,
    unstaking_reason mainnet.fdbe532f64,
    unstaking_end_block_id numeric,
    transferred_from_at_id numeric,
    source_application_id text,
    destination_application_id text,
    transfer_begin_block_id numeric,
    transfer_end_block_id numeric,
    transferring_to_id text,
    transfer_end_height numeric,
    _id uuid NOT NULL,
    _block_range int8range NOT NULL
);


--
-- Name: TABLE applications; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON TABLE mainnet.applications IS '@foreignKey (account_id) REFERENCES accounts (id)|@deprecated Relations will be removed from the schema: query the related entity by its key. See https://github.com/pokt-network/pocketdex/blob/main/docs/graphql-migration.md
@foreignKey (unstaking_begin_block_id) REFERENCES blocks (id)|@deprecated Relations will be removed from the schema: query the related entity by its key. See https://github.com/pokt-network/pocketdex/blob/main/docs/graphql-migration.md
@foreignKey (unstaking_end_block_id) REFERENCES blocks (id)|@deprecated Relations will be removed from the schema: query the related entity by its key. See https://github.com/pokt-network/pocketdex/blob/main/docs/graphql-migration.md
@foreignKey (transferred_from_at_id) REFERENCES blocks (id)|@deprecated Relations will be removed from the schema: query the related entity by its key. See https://github.com/pokt-network/pocketdex/blob/main/docs/graphql-migration.md
@foreignKey (source_application_id) REFERENCES applications (id)|@deprecated Relations will be removed from the schema: query the related entity by its key. See https://github.com/pokt-network/pocketdex/blob/main/docs/graphql-migration.md
@foreignKey (destination_application_id) REFERENCES applications (id)|@deprecated Relations will be removed from the schema: query the related entity by its key. See https://github.com/pokt-network/pocketdex/blob/main/docs/graphql-migration.md
@foreignKey (transfer_begin_block_id) REFERENCES blocks (id)|@deprecated Relations will be removed from the schema: query the related entity by its key. See https://github.com/pokt-network/pocketdex/blob/main/docs/graphql-migration.md
@foreignKey (transfer_end_block_id) REFERENCES blocks (id)|@deprecated Relations will be removed from the schema: query the related entity by its key. See https://github.com/pokt-network/pocketdex/blob/main/docs/graphql-migration.md
@foreignKey (transferring_to_id) REFERENCES accounts (id)|@deprecated Relations will be removed from the schema: query the related entity by its key. See https://github.com/pokt-network/pocketdex/blob/main/docs/graphql-migration.md
One row per application, keyed by address, with its stake, unstaking and transfer state. SubQuery keeps its history; GraphQL lists show the current version of each row unless asked for an earlier height.';


--
-- Name: COLUMN applications.id; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.applications.id IS 'Application address.';


--
-- Name: COLUMN applications.account_id; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.applications.account_id IS 'The application''s address (Account id); same as id.';


--
-- Name: COLUMN applications.stake_amount; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.applications.stake_amount IS 'Stake in upokt, re-read from the chain on every block with an application message, an unbonding or transfer event, or a claim settlement; 0 once Unstaked.';


--
-- Name: COLUMN applications.stake_denom; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.applications.stake_denom IS 'Denom of stake_amount.';


--
-- Name: COLUMN applications.stake_status; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.applications.stake_status IS 'StakeStatus read from the chain: Staked, Unstaking while an unstake is pending, Unstaked once the chain no longer holds the application.';


--
-- Name: COLUMN applications.unstaking_begin_block_id; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.applications.unstaking_begin_block_id IS 'Height of the block with the application''s MsgUnstakeApplication; null otherwise, cleared by a new stake.';


--
-- Name: COLUMN applications.unstaking_end_height; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.applications.unstaking_end_height IS 'Height at which unbonding ends, from the chain''s unbonding-begin event; null otherwise, cleared by a new stake.';


--
-- Name: COLUMN applications.unstaking_reason; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.applications.unstaking_reason IS 'ApplicationUnbondingReason: ELECTIVE, BELOW_MINIMUM_STAKE, TRANSFER or MIGRATION. Set from the unbonding-begin event, and to TRANSFER on the source application when a transfer completes.';


--
-- Name: COLUMN applications.unstaking_end_block_id; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.applications.unstaking_end_block_id IS 'Height of the block where unbonding ended, or for a transferred source application where the transfer ended; null until then.';


--
-- Name: COLUMN applications.transferred_from_at_id; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.applications.transferred_from_at_id IS 'On an application created by a transfer: height of the block where the transfer completed; null otherwise.';


--
-- Name: COLUMN applications.source_application_id; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.applications.source_application_id IS 'On an application created by a transfer: the source application''s address; null otherwise.';


--
-- Name: COLUMN applications.destination_application_id; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.applications.destination_application_id IS 'On a source application whose transfer completed: the destination application''s address; null otherwise.';


--
-- Name: COLUMN applications.transfer_begin_block_id; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.applications.transfer_begin_block_id IS 'Not populated (null).';


--
-- Name: COLUMN applications.transfer_end_block_id; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.applications.transfer_end_block_id IS 'On a source application whose transfer completed: height of the block where it completed; null otherwise.';


--
-- Name: COLUMN applications.transferring_to_id; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.applications.transferring_to_id IS 'Destination address while a transfer is pending; null otherwise.';


--
-- Name: COLUMN applications.transfer_end_height; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.applications.transfer_end_height IS 'Height at which a pending transfer completes, from the chain''s transfer-begin event; null when no transfer is pending.';


--
-- Name: authz_execs; Type: TABLE; Schema: mainnet; Owner: -
--

CREATE TABLE mainnet.authz_execs (
    id text NOT NULL,
    grantee text NOT NULL,
    message_id text NOT NULL,
    transaction_id text NOT NULL,
    block_id numeric NOT NULL,
    _id uuid NOT NULL,
    _block_range int8range NOT NULL
);


--
-- Name: TABLE authz_execs; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON TABLE mainnet.authz_execs IS '@omit
@foreignKey (message_id) REFERENCES messages (id)
@foreignKey (transaction_id) REFERENCES transactions (id)
@foreignKey (block_id) REFERENCES blocks (id)';


--
-- Name: authz_msg_execs; Type: TABLE; Schema: mainnet; Owner: -
--

CREATE TABLE mainnet.authz_msg_execs (
    id text NOT NULL,
    authz_exec_id text NOT NULL,
    message_id text NOT NULL,
    _id uuid NOT NULL,
    _block_range int8range NOT NULL
);


--
-- Name: TABLE authz_msg_execs; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON TABLE mainnet.authz_msg_execs IS '@omit
@foreignKey (authz_exec_id) REFERENCES authz_execs (id)|@foreignFieldName subMessages
@foreignKey (message_id) REFERENCES messages (id)';


--
-- Name: authzs; Type: TABLE; Schema: mainnet; Owner: -
--

CREATE TABLE mainnet.authzs (
    id text NOT NULL,
    granter_id text NOT NULL,
    grantee_id text NOT NULL,
    type text NOT NULL,
    msg text NOT NULL,
    expiration timestamp without time zone,
    event_id text NOT NULL,
    block_id numeric NOT NULL,
    _id uuid NOT NULL,
    _block_range int8range NOT NULL
);


--
-- Name: TABLE authzs; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON TABLE mainnet.authzs IS '@foreignKey (granter_id) REFERENCES accounts (id)|@deprecated Relations will be removed from the schema: query the related entity by its key. See https://github.com/pokt-network/pocketdex/blob/main/docs/graphql-migration.md
@foreignKey (grantee_id) REFERENCES accounts (id)|@deprecated Relations will be removed from the schema: query the related entity by its key. See https://github.com/pokt-network/pocketdex/blob/main/docs/graphql-migration.md
@foreignKey (event_id) REFERENCES events (id)|@deprecated Relations will be removed from the schema: query the related entity by its key. See https://github.com/pokt-network/pocketdex/blob/main/docs/graphql-migration.md
@foreignKey (block_id) REFERENCES blocks (id)|@deprecated Relations will be removed from the schema: query the related entity by its key. See https://github.com/pokt-network/pocketdex/blob/main/docs/graphql-migration.md
One row per authz grant (granter, message type, grantee), from the grant message or, for a grant made outside a transaction, the grant event; a later grant of the same key replaces it. Revocations are not indexed: a revoked grant keeps its row. SubQuery keeps its history; GraphQL lists show the current version of each row unless asked for an earlier height.';


--
-- Name: COLUMN authzs.id; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.authzs.id IS 'granter:message type (without the leading slash)-grantee.';


--
-- Name: COLUMN authzs.granter_id; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.authzs.granter_id IS 'Granter address (Account id).';


--
-- Name: COLUMN authzs.grantee_id; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.authzs.grantee_id IS 'Grantee address (Account id).';


--
-- Name: COLUMN authzs.type; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.authzs.type IS 'Authorization type URL (/cosmos.authz.v1beta1.GenericAuthorization, ...); cosmos.authz.v1beta1.EventGrant when the grant came from an event, whose authorization the indexer does not see.';


--
-- Name: COLUMN authzs.msg; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.authzs.msg IS 'Type URL of the message the grant authorizes.';


--
-- Name: COLUMN authzs.expiration; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.authzs.expiration IS 'When the grant expires, UTC; null when it has none or came from an event.';


--
-- Name: COLUMN authzs.event_id; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.authzs.event_id IS 'Id of the grant event (Event id).';


--
-- Name: COLUMN authzs.block_id; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.authzs.block_id IS 'Height of the grant (Block id).';


--
-- Name: block_metadata; Type: TABLE; Schema: mainnet; Owner: -
--

CREATE TABLE mainnet.block_metadata (
    id numeric NOT NULL,
    block_id jsonb NOT NULL,
    header jsonb NOT NULL,
    last_commit jsonb,
    _id uuid NOT NULL,
    _block_range int8range NOT NULL
);


--
-- Name: TABLE block_metadata; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON TABLE mainnet.block_metadata IS 'One row per indexed block, keyed by height: its CometBFT block id, header and last commit as JSON, as the indexer received them.';


--
-- Name: COLUMN block_metadata.id; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.block_metadata.id IS 'Block height.';


--
-- Name: COLUMN block_metadata.block_id; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.block_metadata.block_id IS 'The block''s CometBFT BlockID: hash and part set header (parts), JSON.';


--
-- Name: COLUMN block_metadata.header; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.block_metadata.header IS 'The block''s CometBFT header, JSON.';


--
-- Name: COLUMN block_metadata.last_commit; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.block_metadata.last_commit IS 'The block''s last commit (the signatures of the previous block), JSON.';


--
-- Name: block_supplies; Type: TABLE; Schema: mainnet; Owner: -
--

CREATE TABLE mainnet.block_supplies (
    id text NOT NULL,
    block_id numeric NOT NULL,
    supply_id text NOT NULL,
    _id uuid NOT NULL,
    _block_range int8range NOT NULL
);


--
-- Name: TABLE block_supplies; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON TABLE mainnet.block_supplies IS '@foreignKey (block_id) REFERENCES blocks (id)|@foreignFieldName supplies|@deprecated Relations will be removed from the schema: query the related entity by its key. See https://github.com/pokt-network/pocketdex/blob/main/docs/graphql-migration.md
@foreignKey (supply_id) REFERENCES supplies (id)|@foreignFieldName blocks|@deprecated Relations will be removed from the schema: query the related entity by its key. See https://github.com/pokt-network/pocketdex/blob/main/docs/graphql-migration.md
One row per block and denom, linking the block to the total supply in force at that block. Rows are not updated after they are written.';


--
-- Name: COLUMN block_supplies.id; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.block_supplies.id IS 'Denom and block height joined by ''@''.';


--
-- Name: COLUMN block_supplies.block_id; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.block_supplies.block_id IS 'Block height.';


--
-- Name: COLUMN block_supplies.supply_id; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.block_supplies.supply_id IS 'Id of the supplies row that holds the denom''s total supply at this block.';


--
-- Name: blocks; Type: TABLE; Schema: mainnet; Owner: -
--

CREATE TABLE mainnet.blocks (
    id numeric NOT NULL,
    chain_id text NOT NULL,
    hash text NOT NULL,
    "timestamp" timestamp without time zone NOT NULL,
    proposer_address text NOT NULL,
    metadata_id numeric NOT NULL,
    size integer NOT NULL,
    total_computed_units numeric,
    total_relays numeric,
    failed_txs integer,
    successful_txs integer,
    total_txs integer,
    staked_suppliers integer,
    staked_suppliers_tokens numeric,
    unstaking_suppliers integer,
    unstaking_suppliers_tokens numeric,
    time_to_block bigint,
    unstaked_suppliers integer,
    unstaked_suppliers_tokens numeric,
    staked_apps integer,
    staked_apps_tokens numeric,
    unstaking_apps integer,
    unstaking_apps_tokens numeric,
    unstaked_apps integer,
    unstaked_apps_tokens numeric,
    staked_gateways integer,
    staked_gateways_tokens numeric,
    unstaked_gateways integer,
    unstaked_gateways_tokens numeric,
    staked_validators integer,
    staked_validators_tokens numeric,
    unstaking_validators integer,
    unstaking_validators_tokens numeric,
    _id uuid NOT NULL,
    _block_range int8range NOT NULL,
    total_estimated_computed_units numeric,
    total_estimated_relays numeric
);


--
-- Name: TABLE blocks; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON TABLE mainnet.blocks IS '@foreignKey (metadata_id) REFERENCES block_metadata (id)|@deprecated Relations will be removed from the schema: query the related entity by its key. See https://github.com/pokt-network/pocketdex/blob/main/docs/graphql-migration.md
One row per indexed block, keyed by height, with per-block totals (transactions, settled relays, staked actors) computed when the block is indexed.';


--
-- Name: COLUMN blocks.id; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.blocks.id IS 'Block height.';


--
-- Name: COLUMN blocks.chain_id; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.blocks.chain_id IS 'Chain id from the block header.';


--
-- Name: COLUMN blocks.hash; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.blocks.hash IS 'Block hash, uppercase hex.';


--
-- Name: COLUMN blocks."timestamp"; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.blocks."timestamp" IS 'Block time from the block header, UTC.';


--
-- Name: COLUMN blocks.proposer_address; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.blocks.proposer_address IS 'Consensus address of the validator that proposed the block, uppercase hex; matches validators.ed25519_id.';


--
-- Name: COLUMN blocks.metadata_id; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.blocks.metadata_id IS 'Id of the block''s metadata record (block id, full header, last commit); equal to the height.';


--
-- Name: COLUMN blocks.size; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.blocks.size IS 'Approximate block size in bytes, computed by the indexer from the block id, header, transactions, evidence and last commit.';


--
-- Name: COLUMN blocks.total_computed_units; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.blocks.total_computed_units IS 'Sum of the claimed compute units of the claims settled in this block.';


--
-- Name: COLUMN blocks.total_relays; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.blocks.total_relays IS 'Sum of the relays of the claims settled in this block.';


--
-- Name: COLUMN blocks.failed_txs; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.blocks.failed_txs IS 'Number of transactions in this block with a non-zero result code.';


--
-- Name: COLUMN blocks.successful_txs; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.blocks.successful_txs IS 'Number of transactions in this block with result code 0.';


--
-- Name: COLUMN blocks.total_txs; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.blocks.total_txs IS 'Number of transactions in this block.';


--
-- Name: COLUMN blocks.staked_suppliers; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.blocks.staked_suppliers IS 'Number of suppliers with stake status Staked at this block.';


--
-- Name: COLUMN blocks.staked_suppliers_tokens; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.blocks.staked_suppliers_tokens IS 'Total stake of the suppliers with status Staked at this block, in upokt.';


--
-- Name: COLUMN blocks.unstaking_suppliers; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.blocks.unstaking_suppliers IS 'Number of suppliers with stake status Unstaking at this block.';


--
-- Name: COLUMN blocks.unstaking_suppliers_tokens; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.blocks.unstaking_suppliers_tokens IS 'Total stake of the suppliers with status Unstaking at this block, in upokt.';


--
-- Name: COLUMN blocks.time_to_block; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.blocks.time_to_block IS 'Milliseconds between this block''s time and the previous block''s time; 0 when the previous block is not indexed.';


--
-- Name: COLUMN blocks.unstaked_suppliers; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.blocks.unstaked_suppliers IS 'Number of suppliers that became Unstaked in this block.';


--
-- Name: COLUMN blocks.unstaked_suppliers_tokens; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.blocks.unstaked_suppliers_tokens IS 'Stake those suppliers held just before they became Unstaked, in upokt.';


--
-- Name: COLUMN blocks.staked_apps; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.blocks.staked_apps IS 'Number of applications with stake status Staked at this block.';


--
-- Name: COLUMN blocks.staked_apps_tokens; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.blocks.staked_apps_tokens IS 'Total stake of the applications with status Staked at this block, in upokt.';


--
-- Name: COLUMN blocks.unstaking_apps; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.blocks.unstaking_apps IS 'Number of applications with stake status Unstaking at this block.';


--
-- Name: COLUMN blocks.unstaking_apps_tokens; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.blocks.unstaking_apps_tokens IS 'Total stake of the applications with status Unstaking at this block, in upokt.';


--
-- Name: COLUMN blocks.unstaked_apps; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.blocks.unstaked_apps IS 'Number of applications that became Unstaked in this block.';


--
-- Name: COLUMN blocks.unstaked_apps_tokens; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.blocks.unstaked_apps_tokens IS 'Stake those applications held just before they became Unstaked, in upokt.';


--
-- Name: COLUMN blocks.staked_gateways; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.blocks.staked_gateways IS 'Number of gateways with stake status Staked at this block.';


--
-- Name: COLUMN blocks.staked_gateways_tokens; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.blocks.staked_gateways_tokens IS 'Total stake of the gateways with status Staked at this block, in upokt.';


--
-- Name: COLUMN blocks.unstaked_gateways; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.blocks.unstaked_gateways IS 'Number of gateways that became Unstaked in this block.';


--
-- Name: COLUMN blocks.unstaked_gateways_tokens; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.blocks.unstaked_gateways_tokens IS 'Stake those gateways held just before they became Unstaked, in upokt.';


--
-- Name: COLUMN blocks.staked_validators; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.blocks.staked_validators IS 'Number of validators with stake status Staked (bonded) at this block.';


--
-- Name: COLUMN blocks.staked_validators_tokens; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.blocks.staked_validators_tokens IS 'Total tokens of the validators with status Staked at this block, in upokt.';


--
-- Name: COLUMN blocks.unstaking_validators; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.blocks.unstaking_validators IS 'Number of validators with stake status Unstaking (unbonding) at this block.';


--
-- Name: COLUMN blocks.unstaking_validators_tokens; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.blocks.unstaking_validators_tokens IS 'Total tokens of the validators with status Unstaking at this block, in upokt.';


--
-- Name: COLUMN blocks.total_estimated_computed_units; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.blocks.total_estimated_computed_units IS 'Sum of the estimated compute units of the claims settled in this block.';


--
-- Name: COLUMN blocks.total_estimated_relays; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.blocks.total_estimated_relays IS 'Sum of the estimated relays of the claims settled in this block.';


--
-- Name: delegations; Type: TABLE; Schema: mainnet; Owner: -
--

CREATE TABLE mainnet.delegations (
    id text NOT NULL,
    validator_operator text NOT NULL,
    delegator text NOT NULL,
    shares text NOT NULL,
    _id uuid NOT NULL,
    _block_range int8range NOT NULL
);


--
-- Name: TABLE delegations; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON TABLE mainnet.delegations IS '@omit';


--
-- Name: event_application_overserviceds; Type: TABLE; Schema: mainnet; Owner: -
--

CREATE TABLE mainnet.event_application_overserviceds (
    id text NOT NULL,
    application_id text NOT NULL,
    supplier_id text NOT NULL,
    expected_burn numeric NOT NULL,
    expected_burn_denom text NOT NULL,
    effective_burn numeric NOT NULL,
    effective_burn_denom text NOT NULL,
    block_id numeric NOT NULL,
    event_id text NOT NULL,
    _id uuid NOT NULL,
    _block_range int8range NOT NULL,
    service_id text,
    session_end_block_height numeric,
    spend_limit_exceeded boolean
);


--
-- Name: TABLE event_application_overserviceds; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON TABLE mainnet.event_application_overserviceds IS '@deprecated Will be removed from the schema. Use getApplicationSpendJson. See https://github.com/pokt-network/pocketdex/blob/main/docs/graphql-migration.md
@foreignKey (application_id) REFERENCES applications (id)
@foreignKey (supplier_id) REFERENCES suppliers (id)
@foreignKey (block_id) REFERENCES blocks (id)
@foreignKey (event_id) REFERENCES events (id)
@foreignKey (service_id) REFERENCES services (id)';


--
-- Name: event_application_reimbursement_requests; Type: TABLE; Schema: mainnet; Owner: -
--

CREATE TABLE mainnet.event_application_reimbursement_requests (
    id text NOT NULL,
    application_id text NOT NULL,
    supplier_id text NOT NULL,
    service_id text NOT NULL,
    session_id text NOT NULL,
    amount numeric NOT NULL,
    denom text NOT NULL,
    block_id numeric NOT NULL,
    event_id text NOT NULL,
    _id uuid NOT NULL,
    _block_range int8range NOT NULL
);


--
-- Name: TABLE event_application_reimbursement_requests; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON TABLE mainnet.event_application_reimbursement_requests IS '@omit
@foreignKey (application_id) REFERENCES applications (id)
@foreignKey (supplier_id) REFERENCES suppliers (id)
@foreignKey (service_id) REFERENCES services (id)
@foreignKey (block_id) REFERENCES blocks (id)
@foreignKey (event_id) REFERENCES events (id)';


--
-- Name: event_application_unbonding_begins; Type: TABLE; Schema: mainnet; Owner: -
--

CREATE TABLE mainnet.event_application_unbonding_begins (
    id text NOT NULL,
    application_id text NOT NULL,
    reason integer NOT NULL,
    session_end_height numeric NOT NULL,
    unstaking_end_height numeric NOT NULL,
    block_id numeric NOT NULL,
    event_id text NOT NULL,
    _id uuid NOT NULL,
    _block_range int8range NOT NULL
);


--
-- Name: TABLE event_application_unbonding_begins; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON TABLE mainnet.event_application_unbonding_begins IS '@deprecated Will be removed from the schema. Use getActorLifecycleList with kind application. See https://github.com/pokt-network/pocketdex/blob/main/docs/graphql-migration.md
@foreignKey (application_id) REFERENCES applications (id)|@foreignFieldName unstakingBeginEvents
@foreignKey (block_id) REFERENCES blocks (id)
@foreignKey (event_id) REFERENCES events (id)';


--
-- Name: event_application_unbonding_ends; Type: TABLE; Schema: mainnet; Owner: -
--

CREATE TABLE mainnet.event_application_unbonding_ends (
    id text NOT NULL,
    application_id text NOT NULL,
    reason integer NOT NULL,
    session_end_height numeric NOT NULL,
    unstaking_end_height numeric NOT NULL,
    block_id numeric NOT NULL,
    event_id text NOT NULL,
    _id uuid NOT NULL,
    _block_range int8range NOT NULL
);


--
-- Name: TABLE event_application_unbonding_ends; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON TABLE mainnet.event_application_unbonding_ends IS '@deprecated Will be removed from the schema. Use getActorLifecycleList with kind application. See https://github.com/pokt-network/pocketdex/blob/main/docs/graphql-migration.md
@foreignKey (application_id) REFERENCES applications (id)|@foreignFieldName unstakingEndEvents
@foreignKey (block_id) REFERENCES blocks (id)
@foreignKey (event_id) REFERENCES events (id)';


--
-- Name: event_claim_expireds; Type: TABLE; Schema: mainnet; Owner: -
--

CREATE TABLE mainnet.event_claim_expireds (
    id text NOT NULL,
    supplier_id text NOT NULL,
    application_id text NOT NULL,
    service_id text NOT NULL,
    session_id text NOT NULL,
    session_start_height numeric NOT NULL,
    session_end_height numeric NOT NULL,
    root_hash text,
    expiration_reason mainnet."3c255f32dd",
    proof_validation_status mainnet.fe879004fe,
    num_relays numeric,
    num_claimed_computed_units numeric,
    num_estimated_computed_units numeric,
    claimed_amount numeric,
    claimed_denom text,
    transaction_id text,
    block_id numeric NOT NULL,
    _id uuid NOT NULL,
    _block_range int8range NOT NULL,
    num_estimated_relays numeric
);


--
-- Name: TABLE event_claim_expireds; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON TABLE mainnet.event_claim_expireds IS '@deprecated Will be removed from the schema. Use getClaimsList or getClaimsJson with statuses [expired]; totals in getSupplierPenaltiesJson. See https://github.com/pokt-network/pocketdex/blob/main/docs/graphql-migration.md
@foreignKey (supplier_id) REFERENCES suppliers (id)
@foreignKey (application_id) REFERENCES applications (id)
@foreignKey (service_id) REFERENCES services (id)
@foreignKey (transaction_id) REFERENCES transactions (id)
@foreignKey (block_id) REFERENCES blocks (id)';


--
-- Name: event_claim_settleds; Type: TABLE; Schema: mainnet; Owner: -
--

CREATE TABLE mainnet.event_claim_settleds (
    id text NOT NULL,
    supplier_id text NOT NULL,
    application_id text NOT NULL,
    service_id text NOT NULL,
    session_id text NOT NULL,
    session_start_height numeric NOT NULL,
    session_end_height numeric NOT NULL,
    root_hash text,
    proof_requirement mainnet.d2ebb7b2be,
    proof_validation_status mainnet.fe879004fe,
    num_relays numeric,
    num_claimed_computed_units numeric,
    num_estimated_computed_units numeric,
    claimed_amount numeric,
    claimed_denom text,
    transaction_id text,
    mints jsonb NOT NULL,
    burns jsonb NOT NULL,
    mod_to_mod_transfers jsonb NOT NULL,
    block_id numeric NOT NULL,
    _id uuid NOT NULL,
    _block_range int8range NOT NULL,
    num_estimated_relays numeric,
    settled_amount numeric,
    settled_denom text,
    mint_ratio text,
    supplier_owner_id text,
    minted_amount numeric,
    minted_denom text,
    overservicing_loss_amount numeric,
    overservicing_loss_denom text,
    deflation_loss_amount numeric,
    deflation_loss_denom text
);


--
-- Name: TABLE event_claim_settleds; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON TABLE mainnet.event_claim_settleds IS '@deprecated Will be removed from the schema. Use getClaimsList or getClaimsJson; sums in getSupplierEarningsJson, getApplicationSpendJson, getGatewaySpendJson, getServiceUsageJson. See https://github.com/pokt-network/pocketdex/blob/main/docs/graphql-migration.md
@foreignKey (supplier_id) REFERENCES suppliers (id)
@foreignKey (application_id) REFERENCES applications (id)
@foreignKey (service_id) REFERENCES services (id)
@foreignKey (transaction_id) REFERENCES transactions (id)
@foreignKey (block_id) REFERENCES blocks (id)
@foreignKey (supplier_owner_id) REFERENCES accounts (id)';


--
-- Name: event_claim_updateds; Type: TABLE; Schema: mainnet; Owner: -
--

CREATE TABLE mainnet.event_claim_updateds (
    id text NOT NULL,
    supplier_id text NOT NULL,
    application_id text NOT NULL,
    service_id text NOT NULL,
    session_id text NOT NULL,
    session_start_height numeric NOT NULL,
    session_end_height numeric NOT NULL,
    root_hash text,
    num_relays numeric,
    num_claimed_computed_units numeric,
    num_estimated_computed_units numeric,
    claimed_amount numeric,
    claimed_denom text,
    transaction_id text,
    block_id numeric NOT NULL,
    relay_id text,
    _id uuid NOT NULL,
    _block_range int8range NOT NULL
);


--
-- Name: TABLE event_claim_updateds; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON TABLE mainnet.event_claim_updateds IS '@omit
@foreignKey (supplier_id) REFERENCES suppliers (id)
@foreignKey (application_id) REFERENCES applications (id)
@foreignKey (service_id) REFERENCES services (id)
@foreignKey (transaction_id) REFERENCES transactions (id)
@foreignKey (block_id) REFERENCES blocks (id)';


--
-- Name: event_gateway_unbonding_begins; Type: TABLE; Schema: mainnet; Owner: -
--

CREATE TABLE mainnet.event_gateway_unbonding_begins (
    id text NOT NULL,
    gateway_id text NOT NULL,
    unbonding_end_height numeric NOT NULL,
    session_end_height numeric NOT NULL,
    block_id numeric NOT NULL,
    event_id text NOT NULL,
    transaction_id text NOT NULL,
    _id uuid NOT NULL,
    _block_range int8range NOT NULL
);


--
-- Name: TABLE event_gateway_unbonding_begins; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON TABLE mainnet.event_gateway_unbonding_begins IS '@deprecated Will be removed from the schema. Use getActorLifecycleList with kind gateway. See https://github.com/pokt-network/pocketdex/blob/main/docs/graphql-migration.md
@foreignKey (gateway_id) REFERENCES gateways (id)|@foreignFieldName unstakingBeginEvents
@foreignKey (block_id) REFERENCES blocks (id)
@foreignKey (event_id) REFERENCES events (id)
@foreignKey (transaction_id) REFERENCES transactions (id)';


--
-- Name: event_gateway_unbonding_ends; Type: TABLE; Schema: mainnet; Owner: -
--

CREATE TABLE mainnet.event_gateway_unbonding_ends (
    id text NOT NULL,
    gateway_id text NOT NULL,
    unbonding_end_height numeric NOT NULL,
    session_end_height numeric NOT NULL,
    block_id numeric NOT NULL,
    event_id text NOT NULL,
    _id uuid NOT NULL,
    _block_range int8range NOT NULL
);


--
-- Name: TABLE event_gateway_unbonding_ends; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON TABLE mainnet.event_gateway_unbonding_ends IS '@deprecated Will be removed from the schema. Use getActorLifecycleList with kind gateway. See https://github.com/pokt-network/pocketdex/blob/main/docs/graphql-migration.md
@foreignKey (gateway_id) REFERENCES gateways (id)|@foreignFieldName unstakingEndEvents
@foreignKey (block_id) REFERENCES blocks (id)
@foreignKey (event_id) REFERENCES events (id)';


--
-- Name: event_gateway_unstakeds; Type: TABLE; Schema: mainnet; Owner: -
--

CREATE TABLE mainnet.event_gateway_unstakeds (
    id text NOT NULL,
    gateway_id text NOT NULL,
    transaction_id text NOT NULL,
    block_id numeric NOT NULL,
    event_id text NOT NULL,
    _id uuid NOT NULL,
    _block_range int8range NOT NULL
);


--
-- Name: TABLE event_gateway_unstakeds; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON TABLE mainnet.event_gateway_unstakeds IS '@omit
@foreignKey (gateway_id) REFERENCES gateways (id)|@foreignFieldName unstakedEvents
@foreignKey (transaction_id) REFERENCES transactions (id)
@foreignKey (block_id) REFERENCES blocks (id)
@foreignKey (event_id) REFERENCES events (id)';


--
-- Name: event_proof_updateds; Type: TABLE; Schema: mainnet; Owner: -
--

CREATE TABLE mainnet.event_proof_updateds (
    id text NOT NULL,
    supplier_id text NOT NULL,
    application_id text NOT NULL,
    service_id text NOT NULL,
    session_id text NOT NULL,
    session_start_height numeric NOT NULL,
    session_end_height numeric NOT NULL,
    root_hash text,
    closest_merkle_proof text,
    num_relays numeric,
    num_claimed_computed_units numeric,
    num_estimated_computed_units numeric,
    claimed_amount numeric,
    claimed_denom text,
    transaction_id text,
    block_id numeric NOT NULL,
    relay_id text,
    _id uuid NOT NULL,
    _block_range int8range NOT NULL
);


--
-- Name: TABLE event_proof_updateds; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON TABLE mainnet.event_proof_updateds IS '@omit
@foreignKey (supplier_id) REFERENCES suppliers (id)
@foreignKey (application_id) REFERENCES applications (id)
@foreignKey (service_id) REFERENCES services (id)
@foreignKey (transaction_id) REFERENCES transactions (id)
@foreignKey (block_id) REFERENCES blocks (id)';


--
-- Name: event_proof_validity_checkeds; Type: TABLE; Schema: mainnet; Owner: -
--

CREATE TABLE mainnet.event_proof_validity_checkeds (
    id text NOT NULL,
    supplier_id text NOT NULL,
    application_id text NOT NULL,
    service_id text NOT NULL,
    session_id text NOT NULL,
    session_start_height numeric NOT NULL,
    session_end_height numeric NOT NULL,
    proof_validation_status mainnet.fe879004fe NOT NULL,
    failure_reason text,
    block_id numeric NOT NULL,
    event_id text NOT NULL,
    _id uuid NOT NULL,
    _block_range int8range NOT NULL
);


--
-- Name: TABLE event_proof_validity_checkeds; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON TABLE mainnet.event_proof_validity_checkeds IS '@omit
@foreignKey (supplier_id) REFERENCES suppliers (id)
@foreignKey (application_id) REFERENCES applications (id)
@foreignKey (service_id) REFERENCES services (id)
@foreignKey (block_id) REFERENCES blocks (id)
@foreignKey (event_id) REFERENCES events (id)';


--
-- Name: event_relay_mining_difficulty_updateds; Type: TABLE; Schema: mainnet; Owner: -
--

CREATE TABLE mainnet.event_relay_mining_difficulty_updateds (
    id text NOT NULL,
    service_id text NOT NULL,
    prev_target_hash_hex_encoded text NOT NULL,
    new_target_hash_hex_encoded text NOT NULL,
    prev_num_relays_ema numeric NOT NULL,
    new_num_relays_ema numeric NOT NULL,
    block_id numeric NOT NULL,
    event_id text NOT NULL,
    _id uuid NOT NULL,
    _block_range int8range NOT NULL
);


--
-- Name: TABLE event_relay_mining_difficulty_updateds; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON TABLE mainnet.event_relay_mining_difficulty_updateds IS '@deprecated Will be removed from the schema. Use getRelayMiningDifficultyList. See https://github.com/pokt-network/pocketdex/blob/main/docs/graphql-migration.md
@foreignKey (service_id) REFERENCES services (id)|@foreignFieldName relayMiningDifficultyUpdatedEvents
@foreignKey (block_id) REFERENCES blocks (id)
@foreignKey (event_id) REFERENCES events (id)';


--
-- Name: event_supplier_service_config_activateds; Type: TABLE; Schema: mainnet; Owner: -
--

CREATE TABLE mainnet.event_supplier_service_config_activateds (
    id text NOT NULL,
    event_id text NOT NULL,
    block_id numeric NOT NULL,
    _id uuid NOT NULL,
    _block_range int8range NOT NULL
);


--
-- Name: TABLE event_supplier_service_config_activateds; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON TABLE mainnet.event_supplier_service_config_activateds IS '@omit
@foreignKey (event_id) REFERENCES events (id)
@foreignKey (block_id) REFERENCES blocks (id)';


--
-- Name: event_supplier_slasheds; Type: TABLE; Schema: mainnet; Owner: -
--

CREATE TABLE mainnet.event_supplier_slasheds (
    id text NOT NULL,
    supplier_id text NOT NULL,
    application_id text NOT NULL,
    service_id text NOT NULL,
    session_id text NOT NULL,
    session_start_height numeric NOT NULL,
    session_end_height numeric NOT NULL,
    proof_validation_status mainnet.fe879004fe,
    proof_missing_penalty numeric NOT NULL,
    proof_missing_penalty_denom text NOT NULL,
    previous_stake_amount numeric NOT NULL,
    after_stake_amount numeric NOT NULL,
    block_id numeric NOT NULL,
    event_id text NOT NULL,
    _id uuid NOT NULL,
    _block_range int8range NOT NULL
);


--
-- Name: TABLE event_supplier_slasheds; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON TABLE mainnet.event_supplier_slasheds IS '@deprecated Will be removed from the schema. Use getActorLifecycleList with kind supplier and events [slash]; totals in getSupplierPenaltiesJson. See https://github.com/pokt-network/pocketdex/blob/main/docs/graphql-migration.md
@foreignKey (supplier_id) REFERENCES suppliers (id)
@foreignKey (application_id) REFERENCES applications (id)
@foreignKey (service_id) REFERENCES services (id)
@foreignKey (block_id) REFERENCES blocks (id)
@foreignKey (event_id) REFERENCES events (id)';


--
-- Name: event_supplier_unbonding_begins; Type: TABLE; Schema: mainnet; Owner: -
--

CREATE TABLE mainnet.event_supplier_unbonding_begins (
    id text NOT NULL,
    supplier_id text NOT NULL,
    reason mainnet.bc79f39c65 NOT NULL,
    unbonding_end_height numeric NOT NULL,
    session_end_height numeric NOT NULL,
    block_id numeric NOT NULL,
    event_id text NOT NULL,
    _id uuid NOT NULL,
    _block_range int8range NOT NULL
);


--
-- Name: TABLE event_supplier_unbonding_begins; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON TABLE mainnet.event_supplier_unbonding_begins IS '@deprecated Will be removed from the schema. Use getActorLifecycleList with kind supplier. See https://github.com/pokt-network/pocketdex/blob/main/docs/graphql-migration.md
@foreignKey (supplier_id) REFERENCES suppliers (id)|@foreignFieldName unstakingBeginEvents
@foreignKey (block_id) REFERENCES blocks (id)
@foreignKey (event_id) REFERENCES events (id)';


--
-- Name: event_supplier_unbonding_ends; Type: TABLE; Schema: mainnet; Owner: -
--

CREATE TABLE mainnet.event_supplier_unbonding_ends (
    id text NOT NULL,
    supplier_id text NOT NULL,
    reason mainnet.bc79f39c65 NOT NULL,
    unbonding_end_height numeric NOT NULL,
    session_end_height numeric NOT NULL,
    block_id numeric NOT NULL,
    event_id text NOT NULL,
    _id uuid NOT NULL,
    _block_range int8range NOT NULL
);


--
-- Name: TABLE event_supplier_unbonding_ends; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON TABLE mainnet.event_supplier_unbonding_ends IS '@deprecated Will be removed from the schema. Use getActorLifecycleList with kind supplier. See https://github.com/pokt-network/pocketdex/blob/main/docs/graphql-migration.md
@foreignKey (supplier_id) REFERENCES suppliers (id)|@foreignFieldName unstakingEndEvents
@foreignKey (block_id) REFERENCES blocks (id)
@foreignKey (event_id) REFERENCES events (id)';


--
-- Name: event_transfer_begins; Type: TABLE; Schema: mainnet; Owner: -
--

CREATE TABLE mainnet.event_transfer_begins (
    id text NOT NULL,
    source_id text NOT NULL,
    destination_id text NOT NULL,
    transaction_id text NOT NULL,
    block_id numeric NOT NULL,
    event_id text NOT NULL,
    _id uuid NOT NULL,
    _block_range int8range NOT NULL
);


--
-- Name: TABLE event_transfer_begins; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON TABLE mainnet.event_transfer_begins IS '@omit
@foreignKey (source_id) REFERENCES applications (id)|@foreignFieldName sourceTransferBeginEvents
@foreignKey (destination_id) REFERENCES applications (id)|@foreignFieldName destinationTransferBeginEvents
@foreignKey (transaction_id) REFERENCES transactions (id)
@foreignKey (block_id) REFERENCES blocks (id)
@foreignKey (event_id) REFERENCES events (id)';


--
-- Name: event_transfer_ends; Type: TABLE; Schema: mainnet; Owner: -
--

CREATE TABLE mainnet.event_transfer_ends (
    id text NOT NULL,
    source_id text NOT NULL,
    destination_id text NOT NULL,
    block_id numeric NOT NULL,
    event_id text NOT NULL,
    _id uuid NOT NULL,
    _block_range int8range NOT NULL
);


--
-- Name: TABLE event_transfer_ends; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON TABLE mainnet.event_transfer_ends IS '@omit
@foreignKey (source_id) REFERENCES applications (id)|@foreignFieldName sourceTransferEndEvents
@foreignKey (destination_id) REFERENCES applications (id)|@foreignFieldName destinationTransferEndEvents
@foreignKey (block_id) REFERENCES blocks (id)
@foreignKey (event_id) REFERENCES events (id)';


--
-- Name: event_transfer_errors; Type: TABLE; Schema: mainnet; Owner: -
--

CREATE TABLE mainnet.event_transfer_errors (
    id text NOT NULL,
    source_id text NOT NULL,
    destination_id text NOT NULL,
    error text NOT NULL,
    block_id numeric NOT NULL,
    event_id text NOT NULL,
    _id uuid NOT NULL,
    _block_range int8range NOT NULL
);


--
-- Name: TABLE event_transfer_errors; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON TABLE mainnet.event_transfer_errors IS '@omit
@foreignKey (source_id) REFERENCES applications (id)|@foreignFieldName sourceTransferErrorEvents
@foreignKey (destination_id) REFERENCES accounts (id)|@foreignFieldName destinationTransferErrorEvents
@foreignKey (block_id) REFERENCES blocks (id)
@foreignKey (event_id) REFERENCES events (id)';


--
-- Name: event_validator_reward_distributions; Type: TABLE; Schema: mainnet; Owner: -
--

CREATE TABLE mainnet.event_validator_reward_distributions (
    id text NOT NULL,
    session_end_block_height numeric NOT NULL,
    op_reason mainnet.c8206fb405 NOT NULL,
    validator_operator_address text NOT NULL,
    validator_account_address text NOT NULL,
    commission_rate text NOT NULL,
    pool_share_amount numeric NOT NULL,
    commission_amount numeric NOT NULL,
    self_delegation_reward_amount numeric NOT NULL,
    delegators_reward_amount numeric NOT NULL,
    total_delegated_stake_amount numeric NOT NULL,
    num_delegators integer NOT NULL,
    block_id numeric NOT NULL,
    _id uuid NOT NULL,
    _block_range int8range NOT NULL
);


--
-- Name: TABLE event_validator_reward_distributions; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON TABLE mainnet.event_validator_reward_distributions IS '@deprecated Will be removed from the schema. Use getValidatorRewardsJson or getDelegatorIncomeJson. See https://github.com/pokt-network/pocketdex/blob/main/docs/graphql-migration.md
@foreignKey (block_id) REFERENCES blocks (id)';


--
-- Name: events; Type: TABLE; Schema: mainnet; Owner: -
--

CREATE TABLE mainnet.events (
    id text NOT NULL,
    idx integer NOT NULL,
    type text NOT NULL,
    kind mainnet.f8e3effa3a NOT NULL,
    attributes jsonb NOT NULL,
    transaction_id text,
    message_id text,
    block_id numeric NOT NULL,
    _id uuid NOT NULL,
    _block_range int8range NOT NULL
);


--
-- Name: TABLE events; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON TABLE mainnet.events IS '@omit
@foreignKey (block_id) REFERENCES blocks (id)|@foreignFieldName events
@foreignKey (transaction_id) REFERENCES transactions (id)|@foreignFieldName events
@foreignKey (message_id) REFERENCES messages (id)|@foreignFieldName events';


--
-- Name: gateways; Type: TABLE; Schema: mainnet; Owner: -
--

CREATE TABLE mainnet.gateways (
    id text NOT NULL,
    account_id text NOT NULL,
    stake_amount numeric NOT NULL,
    stake_denom text NOT NULL,
    stake_status mainnet."1a17296b39" NOT NULL,
    unstaking_begin_block_id numeric,
    unstaking_end_height numeric,
    unstaking_end_block_id numeric,
    _id uuid NOT NULL,
    _block_range int8range NOT NULL
);


--
-- Name: TABLE gateways; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON TABLE mainnet.gateways IS '@foreignKey (account_id) REFERENCES accounts (id)|@deprecated Relations will be removed from the schema: query the related entity by its key. See https://github.com/pokt-network/pocketdex/blob/main/docs/graphql-migration.md
@foreignKey (unstaking_begin_block_id) REFERENCES blocks (id)|@deprecated Relations will be removed from the schema: query the related entity by its key. See https://github.com/pokt-network/pocketdex/blob/main/docs/graphql-migration.md
@foreignKey (unstaking_end_block_id) REFERENCES blocks (id)|@deprecated Relations will be removed from the schema: query the related entity by its key. See https://github.com/pokt-network/pocketdex/blob/main/docs/graphql-migration.md
One row per gateway, keyed by address, with its stake and unstaking state. SubQuery keeps its history; GraphQL lists show the current version of each row unless asked for an earlier height.';


--
-- Name: COLUMN gateways.id; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.gateways.id IS 'Gateway address.';


--
-- Name: COLUMN gateways.account_id; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.gateways.account_id IS 'The gateway''s address (Account id); same as id.';


--
-- Name: COLUMN gateways.stake_amount; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.gateways.stake_amount IS 'Stake in upokt as set by the last stake message; 0 once Unstaked.';


--
-- Name: COLUMN gateways.stake_denom; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.gateways.stake_denom IS 'Denom of stake_amount.';


--
-- Name: COLUMN gateways.stake_status; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.gateways.stake_status IS 'StakeStatus: Staked, Unstaking or Unstaked. Set to Staked by a stake message, to Unstaking by MsgUnstakeGateway, to Unstaked when unbonding ends.';


--
-- Name: COLUMN gateways.unstaking_begin_block_id; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.gateways.unstaking_begin_block_id IS 'Height of the block with the gateway''s MsgUnstakeGateway; null otherwise, cleared by a new stake.';


--
-- Name: COLUMN gateways.unstaking_end_height; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.gateways.unstaking_end_height IS 'Height at which unbonding ends, as the chain announced when unbonding began; null otherwise.';


--
-- Name: COLUMN gateways.unstaking_end_block_id; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.gateways.unstaking_end_block_id IS 'Unbonding end height reported by the chain''s unbonding-end event (for the older unstaked event, the block where it was indexed); null until unbonding ends.';


--
-- Name: genesis_balances; Type: TABLE; Schema: mainnet; Owner: -
--

CREATE TABLE mainnet.genesis_balances (
    id text NOT NULL,
    amount numeric NOT NULL,
    denom text NOT NULL,
    account_id text NOT NULL,
    _id uuid NOT NULL,
    _block_range int8range NOT NULL
);


--
-- Name: TABLE genesis_balances; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON TABLE mainnet.genesis_balances IS '@omit
@foreignKey (account_id) REFERENCES accounts (id)|@foreignFieldName genesisBalances';


--
-- Name: genesis_files; Type: TABLE; Schema: mainnet; Owner: -
--

CREATE TABLE mainnet.genesis_files (
    id text NOT NULL,
    raw text NOT NULL,
    _id uuid NOT NULL,
    _block_range int8range NOT NULL
);


--
-- Name: TABLE genesis_files; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON TABLE mainnet.genesis_files IS '@omit';


--
-- Name: messages; Type: TABLE; Schema: mainnet; Owner: -
--

CREATE TABLE mainnet.messages (
    id text NOT NULL,
    idx integer NOT NULL,
    type_url text NOT NULL,
    json text,
    transaction_id text NOT NULL,
    block_id numeric NOT NULL,
    _id uuid NOT NULL,
    _block_range int8range NOT NULL
);


--
-- Name: TABLE messages; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON TABLE mainnet.messages IS '@omit
@foreignKey (block_id) REFERENCES blocks (id)|@foreignFieldName messages
@foreignKey (transaction_id) REFERENCES transactions (id)|@foreignFieldName messages';


--
-- Name: module_accounts; Type: TABLE; Schema: mainnet; Owner: -
--

CREATE TABLE mainnet.module_accounts (
    id text NOT NULL,
    name text NOT NULL,
    account_number numeric NOT NULL,
    sequence numeric NOT NULL,
    permissions jsonb,
    _id uuid NOT NULL,
    _block_range int8range NOT NULL
);


--
-- Name: TABLE module_accounts; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON TABLE mainnet.module_accounts IS '@omit';


--
-- Name: morse_claimable_accounts; Type: TABLE; Schema: mainnet; Owner: -
--

CREATE TABLE mainnet.morse_claimable_accounts (
    id text NOT NULL,
    msg_import_morse_claimable_accounts_id text NOT NULL,
    unstaked_balance_amount numeric NOT NULL,
    supplier_stake_amount numeric NOT NULL,
    application_stake_amount numeric NOT NULL,
    morse_output_address text,
    unstaking_time timestamp without time zone,
    shannon_dest_address text,
    claimed_at_id numeric,
    claimed boolean NOT NULL,
    transaction_id text,
    claimed_msg_id text,
    unstaked_balance_denom text NOT NULL,
    supplier_stake_denom text NOT NULL,
    application_stake_denom text NOT NULL,
    _id uuid NOT NULL,
    _block_range int8range NOT NULL
);


--
-- Name: TABLE morse_claimable_accounts; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON TABLE mainnet.morse_claimable_accounts IS '@foreignKey (msg_import_morse_claimable_accounts_id) REFERENCES msg_import_morse_claimable_accounts (id)|@foreignFieldName morseClaimableAccounts|@deprecated Relations will be removed from the schema: query the related entity by its key. See https://github.com/pokt-network/pocketdex/blob/main/docs/graphql-migration.md
@foreignKey (claimed_at_id) REFERENCES blocks (id)|@deprecated Relations will be removed from the schema: query the related entity by its key. See https://github.com/pokt-network/pocketdex/blob/main/docs/graphql-migration.md
@foreignKey (transaction_id) REFERENCES transactions (id)|@deprecated Relations will be removed from the schema: query the related entity by its key. See https://github.com/pokt-network/pocketdex/blob/main/docs/graphql-migration.md
@foreignKey (claimed_msg_id) REFERENCES messages (id)|@deprecated Relations will be removed from the schema: query the related entity by its key. See https://github.com/pokt-network/pocketdex/blob/main/docs/graphql-migration.md
One row per Morse account imported for migration to Shannon, with its claimable balances and claim state. A claim updates the row in place; earlier states are not kept.';


--
-- Name: COLUMN morse_claimable_accounts.id; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.morse_claimable_accounts.id IS 'Morse address, lowercase hex.';


--
-- Name: COLUMN morse_claimable_accounts.msg_import_morse_claimable_accounts_id; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.morse_claimable_accounts.msg_import_morse_claimable_accounts_id IS 'Id of the import message that loaded this account.';


--
-- Name: COLUMN morse_claimable_accounts.unstaked_balance_amount; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.morse_claimable_accounts.unstaked_balance_amount IS 'Liquid balance claimable on Shannon, in unstaked_balance_denom.';


--
-- Name: COLUMN morse_claimable_accounts.supplier_stake_amount; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.morse_claimable_accounts.supplier_stake_amount IS 'Supplier (node) stake claimable on Shannon, in supplier_stake_denom; 0 if none.';


--
-- Name: COLUMN morse_claimable_accounts.application_stake_amount; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.morse_claimable_accounts.application_stake_amount IS 'Application stake claimable on Shannon, in application_stake_denom; 0 if none.';


--
-- Name: COLUMN morse_claimable_accounts.morse_output_address; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.morse_claimable_accounts.morse_output_address IS 'Morse output (owner) address of a node/supplier account; null when the account has none.';


--
-- Name: COLUMN morse_claimable_accounts.unstaking_time; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.morse_claimable_accounts.unstaking_time IS 'UTC time after which the Morse node/supplier unbonding period has elapsed; null when not set.';


--
-- Name: COLUMN morse_claimable_accounts.shannon_dest_address; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.morse_claimable_accounts.shannon_dest_address IS 'Shannon address the claim went to, as the chain records it; for a supplier claim, the owner when the owner signed it or it staked nothing (its Morse unbonding had ended, or the stake was below the minimum), else the supplier address (before poktroll v0.1.20, always the supplier address); null until claimed.';


--
-- Name: COLUMN morse_claimable_accounts.claimed_at_id; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.morse_claimable_accounts.claimed_at_id IS 'Height of the block where the account was claimed; null until claimed.';


--
-- Name: COLUMN morse_claimable_accounts.claimed; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.morse_claimable_accounts.claimed IS 'True once the account has been claimed (as account, application or supplier) or recovered.';


--
-- Name: COLUMN morse_claimable_accounts.transaction_id; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.morse_claimable_accounts.transaction_id IS 'Hash of the claim transaction; null until claimed.';


--
-- Name: COLUMN morse_claimable_accounts.claimed_msg_id; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.morse_claimable_accounts.claimed_msg_id IS 'Id of the claim message (for a recovery, of the authz exec message that carried it); null until claimed.';


--
-- Name: COLUMN morse_claimable_accounts.unstaked_balance_denom; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.morse_claimable_accounts.unstaked_balance_denom IS 'Denom of unstaked_balance_amount; empty string when the account had no such balance.';


--
-- Name: COLUMN morse_claimable_accounts.supplier_stake_denom; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.morse_claimable_accounts.supplier_stake_denom IS 'Denom of supplier_stake_amount; empty string when the account had no supplier stake.';


--
-- Name: COLUMN morse_claimable_accounts.application_stake_denom; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.morse_claimable_accounts.application_stake_denom IS 'Denom of application_stake_amount; empty string when the account had no application stake.';


--
-- Name: msg_add_services; Type: TABLE; Schema: mainnet; Owner: -
--

CREATE TABLE mainnet.msg_add_services (
    id text NOT NULL,
    service_id text NOT NULL,
    name text NOT NULL,
    compute_units_per_relay numeric NOT NULL,
    owner_id text NOT NULL,
    block_id numeric NOT NULL,
    transaction_id text NOT NULL,
    message_id text NOT NULL,
    _id uuid NOT NULL,
    _block_range int8range NOT NULL
);


--
-- Name: TABLE msg_add_services; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON TABLE mainnet.msg_add_services IS '@omit
@foreignKey (service_id) REFERENCES services (id)|@foreignFieldName addServiceMsgs
@foreignKey (owner_id) REFERENCES accounts (id)
@foreignKey (block_id) REFERENCES blocks (id)
@foreignKey (transaction_id) REFERENCES transactions (id)
@foreignKey (message_id) REFERENCES messages (id)';


--
-- Name: msg_claim_morse_accounts; Type: TABLE; Schema: mainnet; Owner: -
--

CREATE TABLE mainnet.msg_claim_morse_accounts (
    id text NOT NULL,
    account_id text NOT NULL,
    shannon_signing_address text NOT NULL,
    shannon_dest_address text NOT NULL,
    morse_public_key text NOT NULL,
    morse_src_address text NOT NULL,
    morse_signature text NOT NULL,
    balance_amount numeric NOT NULL,
    balance_denom text NOT NULL,
    block_id numeric NOT NULL,
    transaction_id text NOT NULL,
    message_id text NOT NULL,
    _id uuid NOT NULL,
    _block_range int8range NOT NULL
);


--
-- Name: TABLE msg_claim_morse_accounts; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON TABLE mainnet.msg_claim_morse_accounts IS '@omit
@foreignKey (account_id) REFERENCES accounts (id)
@foreignKey (block_id) REFERENCES blocks (id)
@foreignKey (transaction_id) REFERENCES transactions (id)
@foreignKey (message_id) REFERENCES messages (id)';


--
-- Name: msg_claim_morse_application_services; Type: TABLE; Schema: mainnet; Owner: -
--

CREATE TABLE mainnet.msg_claim_morse_application_services (
    id text NOT NULL,
    claim_msg_id text NOT NULL,
    service_id text NOT NULL,
    _id uuid NOT NULL,
    _block_range int8range NOT NULL
);


--
-- Name: TABLE msg_claim_morse_application_services; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON TABLE mainnet.msg_claim_morse_application_services IS '@omit
@foreignKey (claim_msg_id) REFERENCES msg_claim_morse_applications (id)|@foreignFieldName serviceConfigs
@foreignKey (service_id) REFERENCES services (id)';


--
-- Name: msg_claim_morse_applications; Type: TABLE; Schema: mainnet; Owner: -
--

CREATE TABLE mainnet.msg_claim_morse_applications (
    id text NOT NULL,
    application_id text NOT NULL,
    shannon_signing_address text NOT NULL,
    shannon_dest_address text NOT NULL,
    morse_public_key text NOT NULL,
    morse_src_address text NOT NULL,
    morse_signature text NOT NULL,
    stake_amount numeric NOT NULL,
    stake_denom text NOT NULL,
    balance_amount numeric NOT NULL,
    balance_denom text NOT NULL,
    block_id numeric NOT NULL,
    transaction_id text NOT NULL,
    message_id text NOT NULL,
    _id uuid NOT NULL,
    _block_range int8range NOT NULL
);


--
-- Name: TABLE msg_claim_morse_applications; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON TABLE mainnet.msg_claim_morse_applications IS '@omit
@foreignKey (application_id) REFERENCES applications (id)
@foreignKey (block_id) REFERENCES blocks (id)
@foreignKey (transaction_id) REFERENCES transactions (id)
@foreignKey (message_id) REFERENCES messages (id)';


--
-- Name: msg_claim_morse_supplier_services; Type: TABLE; Schema: mainnet; Owner: -
--

CREATE TABLE mainnet.msg_claim_morse_supplier_services (
    id text NOT NULL,
    claim_msg_id text NOT NULL,
    service_id text NOT NULL,
    rev_share jsonb NOT NULL,
    endpoints jsonb NOT NULL,
    _id uuid NOT NULL,
    _block_range int8range NOT NULL
);


--
-- Name: TABLE msg_claim_morse_supplier_services; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON TABLE mainnet.msg_claim_morse_supplier_services IS '@omit
@foreignKey (claim_msg_id) REFERENCES msg_claim_morse_suppliers (id)|@foreignFieldName serviceConfigs
@foreignKey (service_id) REFERENCES services (id)';


--
-- Name: msg_claim_morse_suppliers; Type: TABLE; Schema: mainnet; Owner: -
--

CREATE TABLE mainnet.msg_claim_morse_suppliers (
    id text NOT NULL,
    supplier_id text NOT NULL,
    shannon_signing_address text NOT NULL,
    shannon_owner_address text NOT NULL,
    shannon_operator_address text NOT NULL,
    morse_public_key text NOT NULL,
    morse_src_address text NOT NULL,
    morse_signature text NOT NULL,
    morse_node_address text,
    signer_is_output_address boolean,
    claim_signer_type mainnet."307ae33cc6",
    stake_amount numeric NOT NULL,
    stake_denom text NOT NULL,
    balance_amount numeric NOT NULL,
    balance_denom text NOT NULL,
    block_id numeric NOT NULL,
    transaction_id text NOT NULL,
    message_id text NOT NULL,
    _id uuid NOT NULL,
    _block_range int8range NOT NULL
);


--
-- Name: TABLE msg_claim_morse_suppliers; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON TABLE mainnet.msg_claim_morse_suppliers IS '@omit
@foreignKey (supplier_id) REFERENCES suppliers (id)
@foreignKey (block_id) REFERENCES blocks (id)
@foreignKey (transaction_id) REFERENCES transactions (id)
@foreignKey (message_id) REFERENCES messages (id)';


--
-- Name: msg_create_claims; Type: TABLE; Schema: mainnet; Owner: -
--

CREATE TABLE mainnet.msg_create_claims (
    id text NOT NULL,
    supplier_id text NOT NULL,
    application_id text NOT NULL,
    service_id text NOT NULL,
    session_id text NOT NULL,
    session_start_height numeric NOT NULL,
    session_end_height numeric NOT NULL,
    root_hash text,
    transaction_id text NOT NULL,
    block_id numeric NOT NULL,
    _id uuid NOT NULL,
    _block_range int8range NOT NULL,
    num_relays numeric,
    num_claimed_computed_units numeric,
    num_estimated_computed_units numeric,
    claimed_amount numeric,
    claimed_denom text,
    num_estimated_relays numeric
);


--
-- Name: TABLE msg_create_claims; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON TABLE mainnet.msg_create_claims IS '@deprecated Will be removed from the schema. Use getCreatedClaimsList. See https://github.com/pokt-network/pocketdex/blob/main/docs/graphql-migration.md
@foreignKey (supplier_id) REFERENCES suppliers (id)
@foreignKey (application_id) REFERENCES applications (id)
@foreignKey (service_id) REFERENCES services (id)
@foreignKey (transaction_id) REFERENCES transactions (id)
@foreignKey (block_id) REFERENCES blocks (id)';


--
-- Name: msg_create_validators; Type: TABLE; Schema: mainnet; Owner: -
--

CREATE TABLE mainnet.msg_create_validators (
    id text NOT NULL,
    pubkey jsonb NOT NULL,
    address text NOT NULL,
    signer_id text NOT NULL,
    signer_pokt_prefix_id text NOT NULL,
    delegator_id text,
    description jsonb NOT NULL,
    commission jsonb NOT NULL,
    min_self_delegation integer NOT NULL,
    stake_denom text NOT NULL,
    stake_amount numeric NOT NULL,
    transaction_id text NOT NULL,
    block_id numeric NOT NULL,
    message_id text NOT NULL,
    _id uuid NOT NULL,
    _block_range int8range NOT NULL
);


--
-- Name: TABLE msg_create_validators; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON TABLE mainnet.msg_create_validators IS '@omit
@foreignKey (signer_id) REFERENCES accounts (id)
@foreignKey (signer_pokt_prefix_id) REFERENCES accounts (id)
@foreignKey (delegator_id) REFERENCES accounts (id)
@foreignKey (transaction_id) REFERENCES transactions (id)
@foreignKey (block_id) REFERENCES blocks (id)
@foreignKey (message_id) REFERENCES messages (id)';


--
-- Name: msg_delegate_to_gateways; Type: TABLE; Schema: mainnet; Owner: -
--

CREATE TABLE mainnet.msg_delegate_to_gateways (
    id text NOT NULL,
    application_id text NOT NULL,
    gateway_id text NOT NULL,
    transaction_id text NOT NULL,
    block_id numeric NOT NULL,
    message_id text NOT NULL,
    _id uuid NOT NULL,
    _block_range int8range NOT NULL
);


--
-- Name: TABLE msg_delegate_to_gateways; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON TABLE mainnet.msg_delegate_to_gateways IS '@deprecated Will be removed from the schema. Use getActorLifecycleList with kind application or gateway and events [delegate, undelegate]. See https://github.com/pokt-network/pocketdex/blob/main/docs/graphql-migration.md
@foreignKey (application_id) REFERENCES applications (id)|@foreignFieldName delegateMsgs
@foreignKey (gateway_id) REFERENCES gateways (id)
@foreignKey (transaction_id) REFERENCES transactions (id)
@foreignKey (block_id) REFERENCES blocks (id)
@foreignKey (message_id) REFERENCES messages (id)';


--
-- Name: msg_import_morse_claimable_accounts; Type: TABLE; Schema: mainnet; Owner: -
--

CREATE TABLE mainnet.msg_import_morse_claimable_accounts (
    id text NOT NULL,
    authority_id text NOT NULL,
    morse_account_state_hash text NOT NULL,
    block_id numeric NOT NULL,
    message_id text NOT NULL,
    transaction_id text NOT NULL,
    _id uuid NOT NULL,
    _block_range int8range NOT NULL
);


--
-- Name: TABLE msg_import_morse_claimable_accounts; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON TABLE mainnet.msg_import_morse_claimable_accounts IS '@omit
@foreignKey (authority_id) REFERENCES accounts (id)
@foreignKey (block_id) REFERENCES blocks (id)
@foreignKey (message_id) REFERENCES messages (id)
@foreignKey (transaction_id) REFERENCES transactions (id)';


--
-- Name: msg_recover_morse_accounts; Type: TABLE; Schema: mainnet; Owner: -
--

CREATE TABLE mainnet.msg_recover_morse_accounts (
    id text NOT NULL,
    authority_id text NOT NULL,
    shannon_dest_address_id text NOT NULL,
    morse_src_address text NOT NULL,
    recovered_balance_amount numeric NOT NULL,
    recovered_balance_denom text NOT NULL,
    block_id numeric NOT NULL,
    transaction_id text NOT NULL,
    message_id text NOT NULL,
    _id uuid NOT NULL,
    _block_range int8range NOT NULL,
    is_admin boolean
);


--
-- Name: TABLE msg_recover_morse_accounts; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON TABLE mainnet.msg_recover_morse_accounts IS '@omit
@foreignKey (authority_id) REFERENCES module_accounts (id)
@foreignKey (shannon_dest_address_id) REFERENCES accounts (id)
@foreignKey (block_id) REFERENCES blocks (id)
@foreignKey (transaction_id) REFERENCES transactions (id)
@foreignKey (message_id) REFERENCES messages (id)';


--
-- Name: msg_stake_application_services; Type: TABLE; Schema: mainnet; Owner: -
--

CREATE TABLE mainnet.msg_stake_application_services (
    id text NOT NULL,
    stake_msg_id text NOT NULL,
    service_id text NOT NULL,
    _id uuid NOT NULL,
    _block_range int8range NOT NULL
);


--
-- Name: TABLE msg_stake_application_services; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON TABLE mainnet.msg_stake_application_services IS '@omit
@foreignKey (stake_msg_id) REFERENCES msg_stake_applications (id)
@foreignKey (service_id) REFERENCES services (id)';


--
-- Name: msg_stake_applications; Type: TABLE; Schema: mainnet; Owner: -
--

CREATE TABLE mainnet.msg_stake_applications (
    id text NOT NULL,
    stake_amount numeric NOT NULL,
    stake_denom text NOT NULL,
    transaction_id text NOT NULL,
    block_id numeric NOT NULL,
    application_id text NOT NULL,
    message_id text NOT NULL,
    _id uuid NOT NULL,
    _block_range int8range NOT NULL
);


--
-- Name: TABLE msg_stake_applications; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON TABLE mainnet.msg_stake_applications IS '@deprecated Will be removed from the schema. Use getActorLifecycleList with kind application. See https://github.com/pokt-network/pocketdex/blob/main/docs/graphql-migration.md
@foreignKey (transaction_id) REFERENCES transactions (id)
@foreignKey (block_id) REFERENCES blocks (id)
@foreignKey (application_id) REFERENCES applications (id)|@foreignFieldName stakeMsgs
@foreignKey (message_id) REFERENCES messages (id)';


--
-- Name: msg_stake_gateways; Type: TABLE; Schema: mainnet; Owner: -
--

CREATE TABLE mainnet.msg_stake_gateways (
    id text NOT NULL,
    gateway_id text NOT NULL,
    stake_amount numeric NOT NULL,
    stake_denom text NOT NULL,
    transaction_id text NOT NULL,
    block_id numeric NOT NULL,
    message_id text NOT NULL,
    _id uuid NOT NULL,
    _block_range int8range NOT NULL
);


--
-- Name: TABLE msg_stake_gateways; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON TABLE mainnet.msg_stake_gateways IS '@deprecated Will be removed from the schema. Use getActorLifecycleList with kind gateway. See https://github.com/pokt-network/pocketdex/blob/main/docs/graphql-migration.md
@foreignKey (gateway_id) REFERENCES gateways (id)|@foreignFieldName stakeMsgs
@foreignKey (transaction_id) REFERENCES transactions (id)
@foreignKey (block_id) REFERENCES blocks (id)
@foreignKey (message_id) REFERENCES messages (id)';


--
-- Name: msg_stake_supplier_services; Type: TABLE; Schema: mainnet; Owner: -
--

CREATE TABLE mainnet.msg_stake_supplier_services (
    id text NOT NULL,
    stake_msg_id text NOT NULL,
    service_id text NOT NULL,
    rev_share jsonb NOT NULL,
    endpoints jsonb NOT NULL,
    _id uuid NOT NULL,
    _block_range int8range NOT NULL
);


--
-- Name: TABLE msg_stake_supplier_services; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON TABLE mainnet.msg_stake_supplier_services IS '@deprecated Will be removed from the schema. Use supplierServiceConfigs. See https://github.com/pokt-network/pocketdex/blob/main/docs/graphql-migration.md
@foreignKey (stake_msg_id) REFERENCES msg_stake_suppliers (id)|@foreignFieldName serviceConfigs
@foreignKey (service_id) REFERENCES services (id)';


--
-- Name: msg_stake_suppliers; Type: TABLE; Schema: mainnet; Owner: -
--

CREATE TABLE mainnet.msg_stake_suppliers (
    id text NOT NULL,
    signer_id text NOT NULL,
    supplier_id text NOT NULL,
    owner_id text NOT NULL,
    stake_amount numeric NOT NULL,
    stake_denom text NOT NULL,
    block_id numeric NOT NULL,
    transaction_id text NOT NULL,
    message_id text NOT NULL,
    _id uuid NOT NULL,
    _block_range int8range NOT NULL
);


--
-- Name: TABLE msg_stake_suppliers; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON TABLE mainnet.msg_stake_suppliers IS '@deprecated Will be removed from the schema. Use getActorLifecycleList with kind supplier. See https://github.com/pokt-network/pocketdex/blob/main/docs/graphql-migration.md
@foreignKey (signer_id) REFERENCES accounts (id)
@foreignKey (supplier_id) REFERENCES suppliers (id)|@foreignFieldName stakeMsgs
@foreignKey (owner_id) REFERENCES accounts (id)
@foreignKey (block_id) REFERENCES blocks (id)
@foreignKey (transaction_id) REFERENCES transactions (id)
@foreignKey (message_id) REFERENCES messages (id)';


--
-- Name: msg_submit_proofs; Type: TABLE; Schema: mainnet; Owner: -
--

CREATE TABLE mainnet.msg_submit_proofs (
    id text NOT NULL,
    supplier_id text NOT NULL,
    application_id text NOT NULL,
    service_id text NOT NULL,
    session_id text NOT NULL,
    session_start_height numeric NOT NULL,
    session_end_height numeric NOT NULL,
    proof text,
    transaction_id text NOT NULL,
    block_id numeric NOT NULL,
    _id uuid NOT NULL,
    _block_range int8range NOT NULL
);


--
-- Name: TABLE msg_submit_proofs; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON TABLE mainnet.msg_submit_proofs IS '@deprecated Will be removed from the schema. Use getSupplierProofsJson. See https://github.com/pokt-network/pocketdex/blob/main/docs/graphql-migration.md
@foreignKey (supplier_id) REFERENCES suppliers (id)
@foreignKey (application_id) REFERENCES applications (id)
@foreignKey (service_id) REFERENCES services (id)
@foreignKey (transaction_id) REFERENCES transactions (id)
@foreignKey (block_id) REFERENCES blocks (id)';


--
-- Name: msg_transfer_applications; Type: TABLE; Schema: mainnet; Owner: -
--

CREATE TABLE mainnet.msg_transfer_applications (
    id text NOT NULL,
    source_application_id text NOT NULL,
    destination_application_id text NOT NULL,
    transaction_id text NOT NULL,
    block_id numeric NOT NULL,
    message_id text NOT NULL,
    _id uuid NOT NULL,
    _block_range int8range NOT NULL
);


--
-- Name: TABLE msg_transfer_applications; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON TABLE mainnet.msg_transfer_applications IS '@omit
@foreignKey (source_application_id) REFERENCES applications (id)|@foreignFieldName sourceTransferMsgs
@foreignKey (destination_application_id) REFERENCES applications (id)|@foreignFieldName destinationTransferMsgs
@foreignKey (transaction_id) REFERENCES transactions (id)
@foreignKey (block_id) REFERENCES blocks (id)
@foreignKey (message_id) REFERENCES messages (id)';


--
-- Name: msg_undelegate_from_gateways; Type: TABLE; Schema: mainnet; Owner: -
--

CREATE TABLE mainnet.msg_undelegate_from_gateways (
    id text NOT NULL,
    application_id text NOT NULL,
    gateway_id text NOT NULL,
    transaction_id text NOT NULL,
    block_id numeric NOT NULL,
    message_id text NOT NULL,
    _id uuid NOT NULL,
    _block_range int8range NOT NULL
);


--
-- Name: TABLE msg_undelegate_from_gateways; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON TABLE mainnet.msg_undelegate_from_gateways IS '@deprecated Will be removed from the schema. Use getActorLifecycleList with kind application or gateway and events [delegate, undelegate]. See https://github.com/pokt-network/pocketdex/blob/main/docs/graphql-migration.md
@foreignKey (application_id) REFERENCES applications (id)|@foreignFieldName undelegateMsgs
@foreignKey (gateway_id) REFERENCES gateways (id)
@foreignKey (transaction_id) REFERENCES transactions (id)
@foreignKey (block_id) REFERENCES blocks (id)
@foreignKey (message_id) REFERENCES messages (id)';


--
-- Name: msg_unstake_applications; Type: TABLE; Schema: mainnet; Owner: -
--

CREATE TABLE mainnet.msg_unstake_applications (
    id text NOT NULL,
    application_id text NOT NULL,
    transaction_id text NOT NULL,
    block_id numeric NOT NULL,
    message_id text NOT NULL,
    _id uuid NOT NULL,
    _block_range int8range NOT NULL
);


--
-- Name: TABLE msg_unstake_applications; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON TABLE mainnet.msg_unstake_applications IS '@omit
@foreignKey (application_id) REFERENCES applications (id)|@foreignFieldName unstakeMsgs
@foreignKey (transaction_id) REFERENCES transactions (id)
@foreignKey (block_id) REFERENCES blocks (id)
@foreignKey (message_id) REFERENCES messages (id)';


--
-- Name: msg_unstake_gateways; Type: TABLE; Schema: mainnet; Owner: -
--

CREATE TABLE mainnet.msg_unstake_gateways (
    id text NOT NULL,
    gateway_id text NOT NULL,
    transaction_id text NOT NULL,
    block_id numeric NOT NULL,
    message_id text NOT NULL,
    _id uuid NOT NULL,
    _block_range int8range NOT NULL
);


--
-- Name: TABLE msg_unstake_gateways; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON TABLE mainnet.msg_unstake_gateways IS '@omit
@foreignKey (gateway_id) REFERENCES gateways (id)|@foreignFieldName unstakeMsgs
@foreignKey (transaction_id) REFERENCES transactions (id)
@foreignKey (block_id) REFERENCES blocks (id)
@foreignKey (message_id) REFERENCES messages (id)';


--
-- Name: msg_unstake_suppliers; Type: TABLE; Schema: mainnet; Owner: -
--

CREATE TABLE mainnet.msg_unstake_suppliers (
    id text NOT NULL,
    signer_id text NOT NULL,
    supplier_id text NOT NULL,
    block_id numeric NOT NULL,
    transaction_id text NOT NULL,
    message_id text NOT NULL,
    _id uuid NOT NULL,
    _block_range int8range NOT NULL
);


--
-- Name: TABLE msg_unstake_suppliers; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON TABLE mainnet.msg_unstake_suppliers IS '@deprecated Will be removed from the schema. Use getActorLifecycleList with kind supplier. See https://github.com/pokt-network/pocketdex/blob/main/docs/graphql-migration.md
@foreignKey (signer_id) REFERENCES accounts (id)
@foreignKey (supplier_id) REFERENCES suppliers (id)|@foreignFieldName unstakeMsgs
@foreignKey (block_id) REFERENCES blocks (id)
@foreignKey (transaction_id) REFERENCES transactions (id)
@foreignKey (message_id) REFERENCES messages (id)';


--
-- Name: params; Type: TABLE; Schema: mainnet; Owner: -
--

CREATE TABLE mainnet.params (
    id text NOT NULL,
    namespace text NOT NULL,
    key text NOT NULL,
    value text NOT NULL,
    block_id numeric NOT NULL,
    _id uuid NOT NULL,
    _block_range int8range NOT NULL,
    active_at numeric
);


--
-- Name: TABLE params; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON TABLE mainnet.params IS '@foreignKey (block_id) REFERENCES blocks (id)|@foreignFieldName params|@deprecated Relations will be removed from the schema: query the related entity by its key. See https://github.com/pokt-network/pocketdex/blob/main/docs/graphql-migration.md
One row per chain parameter (module namespace and key) with the value the chain holds, re-read from chain state every block. SubQuery keeps its history; GraphQL lists show the current version of each row unless asked for an earlier height.';


--
-- Name: COLUMN params.id; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.params.id IS 'Namespace and key joined by ''-'' (e.g. tokenomics-mint_ratio).';


--
-- Name: COLUMN params.namespace; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.params.namespace IS 'Module the parameter belongs to: application, gateway, proof, service, session, shared, supplier, tokenomics, migration, auth, bank, distribution, mint, slashing, staking, gov or consensus.';


--
-- Name: COLUMN params.key; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.params.key IS 'Parameter name: the proto field name in snake_case (e.g. num_blocks_per_session).';


--
-- Name: COLUMN params.value; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.params.value IS 'Raw value as the chain REST returns it: strings as-is, anything else as JSON text (64-bit integers as strings, decimals with 18 places like ''0.670000000000000000'', durations like ''600s'').';


--
-- Name: COLUMN params.block_id; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.params.block_id IS 'Height at which this value was recorded: the first block whose chain state held it (the genesis height for genesis values).';


--
-- Name: COLUMN params.active_at; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.params.active_at IS 'First height at which the chain uses this value; for shared and session changes this can be the next session start rather than the height of the change. Null on rows written before this field existed.';


--
-- Name: services; Type: TABLE; Schema: mainnet; Owner: -
--

CREATE TABLE mainnet.services (
    id text NOT NULL,
    name text NOT NULL,
    compute_units_per_relay numeric NOT NULL,
    owner_id text NOT NULL,
    prev_target_hash_hex_encoded text,
    new_target_hash_hex_encoded text,
    prev_num_relays_ema numeric,
    new_num_relays_ema numeric,
    _id uuid NOT NULL,
    _block_range int8range NOT NULL
);


--
-- Name: TABLE services; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON TABLE mainnet.services IS '@foreignKey (owner_id) REFERENCES accounts (id)|@foreignFieldName services|@deprecated Relations will be removed from the schema: query the related entity by its key. See https://github.com/pokt-network/pocketdex/blob/main/docs/graphql-migration.md
One row per service (the chain or API that suppliers serve and applications pay for), as last defined by MsgAddService or the genesis state. SubQuery keeps its history; GraphQL lists show the current version of each row unless asked for an earlier height.';


--
-- Name: COLUMN services.id; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.services.id IS 'Service id as registered on chain.';


--
-- Name: COLUMN services.name; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.services.name IS 'Service name.';


--
-- Name: COLUMN services.compute_units_per_relay; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.services.compute_units_per_relay IS 'Compute units per relay for this service.';


--
-- Name: COLUMN services.owner_id; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.services.owner_id IS 'Address of the service owner (Account id).';


--
-- Name: COLUMN services.prev_target_hash_hex_encoded; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.services.prev_target_hash_hex_encoded IS 'Not maintained: null on most services, stale where set. The difficulty history is getRelayMiningDifficultyList.';


--
-- Name: COLUMN services.new_target_hash_hex_encoded; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.services.new_target_hash_hex_encoded IS 'Not maintained: null on most services, stale where set. The difficulty history is getRelayMiningDifficultyList.';


--
-- Name: COLUMN services.prev_num_relays_ema; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.services.prev_num_relays_ema IS 'Not maintained: null on most services, stale where set. The difficulty history is getRelayMiningDifficultyList.';


--
-- Name: COLUMN services.new_num_relays_ema; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.services.new_num_relays_ema IS 'Not maintained: null on most services, stale where set. The difficulty history is getRelayMiningDifficultyList.';


--
-- Name: supplier_service_configs; Type: TABLE; Schema: mainnet; Owner: -
--

CREATE TABLE mainnet.supplier_service_configs (
    id text NOT NULL,
    supplier_id text NOT NULL,
    service_id text NOT NULL,
    rev_share jsonb NOT NULL,
    endpoints jsonb NOT NULL,
    activated_at_id numeric,
    activated_event_id text,
    _id uuid NOT NULL,
    _block_range int8range NOT NULL,
    domains jsonb
);


--
-- Name: TABLE supplier_service_configs; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON TABLE mainnet.supplier_service_configs IS '@foreignKey (supplier_id) REFERENCES suppliers (id)|@foreignFieldName serviceConfigs|@deprecated Relations will be removed from the schema: query the related entity by its key. See https://github.com/pokt-network/pocketdex/blob/main/docs/graphql-migration.md
@foreignKey (service_id) REFERENCES services (id)|@deprecated Relations will be removed from the schema: query the related entity by its key. See https://github.com/pokt-network/pocketdex/blob/main/docs/graphql-migration.md
@foreignKey (activated_at_id) REFERENCES blocks (id)|@deprecated Relations will be removed from the schema: query the related entity by its key. See https://github.com/pokt-network/pocketdex/blob/main/docs/graphql-migration.md
@foreignKey (activated_event_id) REFERENCES event_supplier_service_config_activateds (id)|@foreignFieldName activatedServicesConfig|@deprecated Relations will be removed from the schema: query the related entity by its key. See https://github.com/pokt-network/pocketdex/blob/main/docs/graphql-migration.md
One row per supplier and service: the latest config the supplier staked for that service. A config leaves the current list when a new stake drops the service or the supplier finishes unbonding; SubQuery keeps its history; GraphQL lists show the current version of each row unless asked for an earlier height.';


--
-- Name: COLUMN supplier_service_configs.id; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.supplier_service_configs.id IS 'Supplier operator address and service id joined by ''-''.';


--
-- Name: COLUMN supplier_service_configs.supplier_id; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.supplier_service_configs.supplier_id IS 'The supplier''s operator address (Supplier id).';


--
-- Name: COLUMN supplier_service_configs.service_id; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.supplier_service_configs.service_id IS 'The service''s id (Service id).';


--
-- Name: COLUMN supplier_service_configs.rev_share; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.supplier_service_configs.rev_share IS 'Revenue share as a JSON list [{address, revSharePercentage}]: the address that receives a share and its percentage as an integer string.';


--
-- Name: COLUMN supplier_service_configs.endpoints; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.supplier_service_configs.endpoints IS 'Endpoints as a JSON list [{url, rpcType, configs}]: rpcType is a number (0 UNKNOWN_RPC, 1 GRPC, 2 WEBSOCKET, 3 JSON_RPC, 4 REST, 5 COMET_BFT) and configs a list [{key, value}] where key 0 is UNKNOWN_CONFIG and 1 is TIMEOUT.';


--
-- Name: COLUMN supplier_service_configs.activated_at_id; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.supplier_service_configs.activated_at_id IS 'Height at which the chain activated this config; null while the config waits for activation.';


--
-- Name: COLUMN supplier_service_configs.activated_event_id; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.supplier_service_configs.activated_event_id IS 'Id of the chain event that activated this config; null while waiting and for configs active from genesis.';


--
-- Name: COLUMN supplier_service_configs.domains; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.supplier_service_configs.domains IS 'Domains of the endpoint URLs (the last two labels of the host, e.g. nodefleet.net, or the IP address), counting only the first endpoint of each RPC type. Can be null on rows written before this field existed.';


--
-- Name: suppliers; Type: TABLE; Schema: mainnet; Owner: -
--

CREATE TABLE mainnet.suppliers (
    id text NOT NULL,
    operator_id text NOT NULL,
    owner_id text NOT NULL,
    stake_amount numeric NOT NULL,
    stake_denom text NOT NULL,
    stake_status mainnet."1a17296b39" NOT NULL,
    unstaking_begin_block_id numeric,
    unstaking_reason mainnet.bc79f39c65,
    unstaking_end_height numeric,
    unstaking_end_block_id numeric,
    _id uuid NOT NULL,
    _block_range int8range NOT NULL
);


--
-- Name: TABLE suppliers; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON TABLE mainnet.suppliers IS '@foreignKey (operator_id) REFERENCES accounts (id)|@deprecated Relations will be removed from the schema: query the related entity by its key. See https://github.com/pokt-network/pocketdex/blob/main/docs/graphql-migration.md
@foreignKey (owner_id) REFERENCES accounts (id)|@deprecated Relations will be removed from the schema: query the related entity by its key. See https://github.com/pokt-network/pocketdex/blob/main/docs/graphql-migration.md
@foreignKey (unstaking_begin_block_id) REFERENCES blocks (id)|@deprecated Relations will be removed from the schema: query the related entity by its key. See https://github.com/pokt-network/pocketdex/blob/main/docs/graphql-migration.md
@foreignKey (unstaking_end_block_id) REFERENCES blocks (id)|@deprecated Relations will be removed from the schema: query the related entity by its key. See https://github.com/pokt-network/pocketdex/blob/main/docs/graphql-migration.md
One row per supplier, keyed by operator address, with its stake and unstaking state. SubQuery keeps its history; GraphQL lists show the current version of each row unless asked for an earlier height.';


--
-- Name: COLUMN suppliers.id; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.suppliers.id IS 'Operator address.';


--
-- Name: COLUMN suppliers.operator_id; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.suppliers.operator_id IS 'The operator''s address (Account id); same as id.';


--
-- Name: COLUMN suppliers.owner_id; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.suppliers.owner_id IS 'Owner address (Account id), from the last stake message or Morse claim.';


--
-- Name: COLUMN suppliers.stake_amount; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.suppliers.stake_amount IS 'Stake in upokt: the amount of the last stake message (a Morse claim adds its stake to the previous one), reduced by slashes; 0 once Unstaked.';


--
-- Name: COLUMN suppliers.stake_denom; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.suppliers.stake_denom IS 'Denom of stake_amount.';


--
-- Name: COLUMN suppliers.stake_status; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.suppliers.stake_status IS 'StakeStatus: Staked, Unstaking or Unstaked. Set to Staked by a stake message or Morse claim, to Unstaking by MsgUnstakeSupplier, to Unstaked when unbonding ends.';


--
-- Name: COLUMN suppliers.unstaking_begin_block_id; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.suppliers.unstaking_begin_block_id IS 'Height of the block with the supplier''s MsgUnstakeSupplier; null otherwise, cleared by a new stake.';


--
-- Name: COLUMN suppliers.unstaking_reason; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.suppliers.unstaking_reason IS 'SupplierUnbondingReason from the unbonding events: UNSPECIFIED, VOLUNTARY, BELOW_MIN_STAKE or MIGRATION. Null when not unbonding, cleared by a new stake.';


--
-- Name: COLUMN suppliers.unstaking_end_height; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.suppliers.unstaking_end_height IS 'Height at which unbonding ends, as the chain announced when unbonding began; null otherwise.';


--
-- Name: COLUMN suppliers.unstaking_end_block_id; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.suppliers.unstaking_end_block_id IS 'Unbonding end height reported by the chain''s unbonding-end event, which can be earlier than the block where that event was indexed; null until unbonding ends.';


--
-- Name: supplies; Type: TABLE; Schema: mainnet; Owner: -
--

CREATE TABLE mainnet.supplies (
    id text NOT NULL,
    denom text NOT NULL,
    amount numeric NOT NULL,
    _id uuid NOT NULL,
    _block_range int8range NOT NULL
);


--
-- Name: TABLE supplies; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON TABLE mainnet.supplies IS 'One row per denom and total-supply amount: a new row is written at each height where the chain''s total supply of that denom changed. Rows are not updated after they are written.';


--
-- Name: COLUMN supplies.id; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.supplies.id IS 'Denom and the height where this amount was first recorded, joined by ''@'' (e.g. upokt@12345).';


--
-- Name: COLUMN supplies.denom; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.supplies.denom IS 'Coin denom.';


--
-- Name: COLUMN supplies.amount; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.supplies.amount IS 'Total supply of the denom in its base unit (upokt for upokt), as the chain''s bank total supply query returned it.';


--
-- Name: supply_denoms; Type: TABLE; Schema: mainnet; Owner: -
--

CREATE TABLE mainnet.supply_denoms (
    id text NOT NULL,
    _id uuid NOT NULL,
    _block_range int8range NOT NULL
);


--
-- Name: TABLE supply_denoms; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON TABLE mainnet.supply_denoms IS '@omit';


--
-- Name: validator_commissions; Type: TABLE; Schema: mainnet; Owner: -
--

CREATE TABLE mainnet.validator_commissions (
    id text NOT NULL,
    validator_id text NOT NULL,
    amount numeric NOT NULL,
    denom text NOT NULL,
    block_id numeric NOT NULL,
    event_id text NOT NULL,
    _id uuid NOT NULL,
    _block_range int8range NOT NULL
);


--
-- Name: TABLE validator_commissions; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON TABLE mainnet.validator_commissions IS '@omit
@foreignKey (validator_id) REFERENCES validators (id)|@foreignFieldName commissions
@foreignKey (block_id) REFERENCES blocks (id)
@foreignKey (event_id) REFERENCES events (id)';


--
-- Name: validator_rewards; Type: TABLE; Schema: mainnet; Owner: -
--

CREATE TABLE mainnet.validator_rewards (
    id text NOT NULL,
    validator_id text NOT NULL,
    amount numeric NOT NULL,
    denom text NOT NULL,
    block_id numeric NOT NULL,
    event_id text NOT NULL,
    _id uuid NOT NULL,
    _block_range int8range NOT NULL
);


--
-- Name: TABLE validator_rewards; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON TABLE mainnet.validator_rewards IS '@omit
@foreignKey (validator_id) REFERENCES validators (id)|@foreignFieldName rewards
@foreignKey (block_id) REFERENCES blocks (id)
@foreignKey (event_id) REFERENCES events (id)';


--
-- Name: validators; Type: TABLE; Schema: mainnet; Owner: -
--

CREATE TABLE mainnet.validators (
    id text NOT NULL,
    ed25519_id text NOT NULL,
    signer_id text NOT NULL,
    signer_pokt_prefix_id text NOT NULL,
    delegator_id text,
    description jsonb NOT NULL,
    commission jsonb NOT NULL,
    min_self_delegation integer NOT NULL,
    stake_denom text NOT NULL,
    stake_amount numeric NOT NULL,
    stake_status mainnet."1a17296b39" NOT NULL,
    transaction_id text NOT NULL,
    create_msg_id text NOT NULL,
    _id uuid NOT NULL,
    _block_range int8range NOT NULL,
    delegator_shares text
);


--
-- Name: TABLE validators; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON TABLE mainnet.validators IS '@foreignKey (signer_id) REFERENCES accounts (id)|@deprecated Relations will be removed from the schema: query the related entity by its key. See https://github.com/pokt-network/pocketdex/blob/main/docs/graphql-migration.md
@foreignKey (signer_pokt_prefix_id) REFERENCES accounts (id)|@deprecated Relations will be removed from the schema: query the related entity by its key. See https://github.com/pokt-network/pocketdex/blob/main/docs/graphql-migration.md
@foreignKey (delegator_id) REFERENCES accounts (id)|@deprecated Relations will be removed from the schema: query the related entity by its key. See https://github.com/pokt-network/pocketdex/blob/main/docs/graphql-migration.md
@foreignKey (transaction_id) REFERENCES transactions (id)|@deprecated Relations will be removed from the schema: query the related entity by its key. See https://github.com/pokt-network/pocketdex/blob/main/docs/graphql-migration.md
@foreignKey (create_msg_id) REFERENCES msg_create_validators (id)|@deprecated Relations will be removed from the schema: query the related entity by its key. See https://github.com/pokt-network/pocketdex/blob/main/docs/graphql-migration.md
One row per validator, keyed by operator address, re-synced from the chain''s staking state every block. SubQuery keeps its history; GraphQL lists show the current version of each row unless asked for an earlier height.';


--
-- Name: COLUMN validators.id; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.validators.id IS 'Operator address (poktvaloper...).';


--
-- Name: COLUMN validators.ed25519_id; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.validators.ed25519_id IS 'Consensus address: uppercase hex of the first 20 bytes of the SHA-256 of the ed25519 consensus public key; matches blocks.proposer_address.';


--
-- Name: COLUMN validators.signer_id; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.validators.signer_id IS 'Address of the key that signed the creating transaction, with the poktvaloper prefix (Account id); equals id.';


--
-- Name: COLUMN validators.signer_pokt_prefix_id; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.validators.signer_pokt_prefix_id IS 'Account address (pokt prefix) of the same signing key (Account id).';


--
-- Name: COLUMN validators.delegator_id; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.validators.delegator_id IS 'Not populated (null).';


--
-- Name: COLUMN validators.description; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.validators.description IS 'JSON object with moniker, identity, website, securityContact and details, as the chain reports them.';


--
-- Name: COLUMN validators.commission; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.validators.commission IS 'JSON object with rate, maxRate and maxChangeRate as integer strings with 18 implied decimals (1000000000000000000 = 100%).';


--
-- Name: COLUMN validators.min_self_delegation; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.validators.min_self_delegation IS 'Minimum self-delegation the validator requires, as the chain reports it.';


--
-- Name: COLUMN validators.stake_denom; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.validators.stake_denom IS 'Denom of stake_amount.';


--
-- Name: COLUMN validators.stake_amount; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.validators.stake_amount IS 'Validator tokens as the chain''s staking module reports them, in upokt; 0 once the chain removes the validator.';


--
-- Name: COLUMN validators.stake_status; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.validators.stake_status IS 'StakeStatus from the chain''s bond status: Staked (bonded), Unstaking (unbonding), Unstaked (unbonded, or removed from the chain).';


--
-- Name: COLUMN validators.transaction_id; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.validators.transaction_id IS 'Hash of the transaction that created the validator (MsgCreateValidator, or the genesis transaction).';


--
-- Name: COLUMN validators.create_msg_id; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.validators.create_msg_id IS 'Id of the message that created the validator.';


--
-- Name: COLUMN validators.delegator_shares; Type: COMMENT; Schema: mainnet; Owner: -
--

COMMENT ON COLUMN mainnet.validators.delegator_shares IS 'Total shares issued to the validator''s delegators, as an integer string of 18-decimal fixed point (value x 10^18). Null on rows not re-synced since the field was added.';


--
-- Name: accounts accounts_pkey; Type: CONSTRAINT; Schema: mainnet; Owner: -
--

ALTER TABLE ONLY mainnet.accounts
    ADD CONSTRAINT accounts_pkey PRIMARY KEY (_id);


--
-- Name: application_gateways application_gateways_pkey; Type: CONSTRAINT; Schema: mainnet; Owner: -
--

ALTER TABLE ONLY mainnet.application_gateways
    ADD CONSTRAINT application_gateways_pkey PRIMARY KEY (_id);


--
-- Name: application_services application_services_pkey; Type: CONSTRAINT; Schema: mainnet; Owner: -
--

ALTER TABLE ONLY mainnet.application_services
    ADD CONSTRAINT application_services_pkey PRIMARY KEY (_id);


--
-- Name: applications applications_pkey; Type: CONSTRAINT; Schema: mainnet; Owner: -
--

ALTER TABLE ONLY mainnet.applications
    ADD CONSTRAINT applications_pkey PRIMARY KEY (_id);


--
-- Name: authz_execs authz_execs_pkey; Type: CONSTRAINT; Schema: mainnet; Owner: -
--

ALTER TABLE ONLY mainnet.authz_execs
    ADD CONSTRAINT authz_execs_pkey PRIMARY KEY (_id);


--
-- Name: authz_msg_execs authz_msg_execs_pkey; Type: CONSTRAINT; Schema: mainnet; Owner: -
--

ALTER TABLE ONLY mainnet.authz_msg_execs
    ADD CONSTRAINT authz_msg_execs_pkey PRIMARY KEY (_id);


--
-- Name: authzs authzs_pkey; Type: CONSTRAINT; Schema: mainnet; Owner: -
--

ALTER TABLE ONLY mainnet.authzs
    ADD CONSTRAINT authzs_pkey PRIMARY KEY (_id);


--
-- Name: balances balances_pkey; Type: CONSTRAINT; Schema: mainnet; Owner: -
--

ALTER TABLE ONLY mainnet.balances
    ADD CONSTRAINT balances_pkey PRIMARY KEY (_id);


--
-- Name: block_metadata block_metadata_pkey; Type: CONSTRAINT; Schema: mainnet; Owner: -
--

ALTER TABLE ONLY mainnet.block_metadata
    ADD CONSTRAINT block_metadata_pkey PRIMARY KEY (_id);


--
-- Name: block_supplies block_supplies_pkey; Type: CONSTRAINT; Schema: mainnet; Owner: -
--

ALTER TABLE ONLY mainnet.block_supplies
    ADD CONSTRAINT block_supplies_pkey PRIMARY KEY (_id);


--
-- Name: blocks blocks_pkey; Type: CONSTRAINT; Schema: mainnet; Owner: -
--

ALTER TABLE ONLY mainnet.blocks
    ADD CONSTRAINT blocks_pkey PRIMARY KEY (_id);


--
-- Name: delegations delegations_pkey; Type: CONSTRAINT; Schema: mainnet; Owner: -
--

ALTER TABLE ONLY mainnet.delegations
    ADD CONSTRAINT delegations_pkey PRIMARY KEY (_id);


--
-- Name: event_application_overserviceds event_application_overserviceds_pkey; Type: CONSTRAINT; Schema: mainnet; Owner: -
--

ALTER TABLE ONLY mainnet.event_application_overserviceds
    ADD CONSTRAINT event_application_overserviceds_pkey PRIMARY KEY (_id);


--
-- Name: event_application_reimbursement_requests event_application_reimbursement_requests_pkey; Type: CONSTRAINT; Schema: mainnet; Owner: -
--

ALTER TABLE ONLY mainnet.event_application_reimbursement_requests
    ADD CONSTRAINT event_application_reimbursement_requests_pkey PRIMARY KEY (_id);


--
-- Name: event_application_unbonding_begins event_application_unbonding_begins_pkey; Type: CONSTRAINT; Schema: mainnet; Owner: -
--

ALTER TABLE ONLY mainnet.event_application_unbonding_begins
    ADD CONSTRAINT event_application_unbonding_begins_pkey PRIMARY KEY (_id);


--
-- Name: event_application_unbonding_ends event_application_unbonding_ends_pkey; Type: CONSTRAINT; Schema: mainnet; Owner: -
--

ALTER TABLE ONLY mainnet.event_application_unbonding_ends
    ADD CONSTRAINT event_application_unbonding_ends_pkey PRIMARY KEY (_id);


--
-- Name: event_claim_expireds event_claim_expireds_pkey; Type: CONSTRAINT; Schema: mainnet; Owner: -
--

ALTER TABLE ONLY mainnet.event_claim_expireds
    ADD CONSTRAINT event_claim_expireds_pkey PRIMARY KEY (_id);


--
-- Name: event_claim_settleds event_claim_settleds_pkey; Type: CONSTRAINT; Schema: mainnet; Owner: -
--

ALTER TABLE ONLY mainnet.event_claim_settleds
    ADD CONSTRAINT event_claim_settleds_pkey PRIMARY KEY (_id);


--
-- Name: event_claim_updateds event_claim_updateds_pkey; Type: CONSTRAINT; Schema: mainnet; Owner: -
--

ALTER TABLE ONLY mainnet.event_claim_updateds
    ADD CONSTRAINT event_claim_updateds_pkey PRIMARY KEY (_id);


--
-- Name: event_gateway_unbonding_begins event_gateway_unbonding_begins_pkey; Type: CONSTRAINT; Schema: mainnet; Owner: -
--

ALTER TABLE ONLY mainnet.event_gateway_unbonding_begins
    ADD CONSTRAINT event_gateway_unbonding_begins_pkey PRIMARY KEY (_id);


--
-- Name: event_gateway_unbonding_ends event_gateway_unbonding_ends_pkey; Type: CONSTRAINT; Schema: mainnet; Owner: -
--

ALTER TABLE ONLY mainnet.event_gateway_unbonding_ends
    ADD CONSTRAINT event_gateway_unbonding_ends_pkey PRIMARY KEY (_id);


--
-- Name: event_gateway_unstakeds event_gateway_unstakeds_pkey; Type: CONSTRAINT; Schema: mainnet; Owner: -
--

ALTER TABLE ONLY mainnet.event_gateway_unstakeds
    ADD CONSTRAINT event_gateway_unstakeds_pkey PRIMARY KEY (_id);


--
-- Name: event_proof_updateds event_proof_updateds_pkey; Type: CONSTRAINT; Schema: mainnet; Owner: -
--

ALTER TABLE ONLY mainnet.event_proof_updateds
    ADD CONSTRAINT event_proof_updateds_pkey PRIMARY KEY (_id);


--
-- Name: event_proof_validity_checkeds event_proof_validity_checkeds_pkey; Type: CONSTRAINT; Schema: mainnet; Owner: -
--

ALTER TABLE ONLY mainnet.event_proof_validity_checkeds
    ADD CONSTRAINT event_proof_validity_checkeds_pkey PRIMARY KEY (_id);


--
-- Name: event_relay_mining_difficulty_updateds event_relay_mining_difficulty_updateds_pkey; Type: CONSTRAINT; Schema: mainnet; Owner: -
--

ALTER TABLE ONLY mainnet.event_relay_mining_difficulty_updateds
    ADD CONSTRAINT event_relay_mining_difficulty_updateds_pkey PRIMARY KEY (_id);


--
-- Name: event_supplier_service_config_activateds event_supplier_service_config_activateds_pkey; Type: CONSTRAINT; Schema: mainnet; Owner: -
--

ALTER TABLE ONLY mainnet.event_supplier_service_config_activateds
    ADD CONSTRAINT event_supplier_service_config_activateds_pkey PRIMARY KEY (_id);


--
-- Name: event_supplier_slasheds event_supplier_slasheds_pkey; Type: CONSTRAINT; Schema: mainnet; Owner: -
--

ALTER TABLE ONLY mainnet.event_supplier_slasheds
    ADD CONSTRAINT event_supplier_slasheds_pkey PRIMARY KEY (_id);


--
-- Name: event_supplier_unbonding_begins event_supplier_unbonding_begins_pkey; Type: CONSTRAINT; Schema: mainnet; Owner: -
--

ALTER TABLE ONLY mainnet.event_supplier_unbonding_begins
    ADD CONSTRAINT event_supplier_unbonding_begins_pkey PRIMARY KEY (_id);


--
-- Name: event_supplier_unbonding_ends event_supplier_unbonding_ends_pkey; Type: CONSTRAINT; Schema: mainnet; Owner: -
--

ALTER TABLE ONLY mainnet.event_supplier_unbonding_ends
    ADD CONSTRAINT event_supplier_unbonding_ends_pkey PRIMARY KEY (_id);


--
-- Name: event_transfer_begins event_transfer_begins_pkey; Type: CONSTRAINT; Schema: mainnet; Owner: -
--

ALTER TABLE ONLY mainnet.event_transfer_begins
    ADD CONSTRAINT event_transfer_begins_pkey PRIMARY KEY (_id);


--
-- Name: event_transfer_ends event_transfer_ends_pkey; Type: CONSTRAINT; Schema: mainnet; Owner: -
--

ALTER TABLE ONLY mainnet.event_transfer_ends
    ADD CONSTRAINT event_transfer_ends_pkey PRIMARY KEY (_id);


--
-- Name: event_transfer_errors event_transfer_errors_pkey; Type: CONSTRAINT; Schema: mainnet; Owner: -
--

ALTER TABLE ONLY mainnet.event_transfer_errors
    ADD CONSTRAINT event_transfer_errors_pkey PRIMARY KEY (_id);


--
-- Name: event_validator_reward_distributions event_validator_reward_distributions_pkey; Type: CONSTRAINT; Schema: mainnet; Owner: -
--

ALTER TABLE ONLY mainnet.event_validator_reward_distributions
    ADD CONSTRAINT event_validator_reward_distributions_pkey PRIMARY KEY (_id);


--
-- Name: events events_pkey; Type: CONSTRAINT; Schema: mainnet; Owner: -
--

ALTER TABLE ONLY mainnet.events
    ADD CONSTRAINT events_pkey PRIMARY KEY (_id);


--
-- Name: gateways gateways_pkey; Type: CONSTRAINT; Schema: mainnet; Owner: -
--

ALTER TABLE ONLY mainnet.gateways
    ADD CONSTRAINT gateways_pkey PRIMARY KEY (_id);


--
-- Name: genesis_balances genesis_balances_pkey; Type: CONSTRAINT; Schema: mainnet; Owner: -
--

ALTER TABLE ONLY mainnet.genesis_balances
    ADD CONSTRAINT genesis_balances_pkey PRIMARY KEY (_id);


--
-- Name: genesis_files genesis_files_pkey; Type: CONSTRAINT; Schema: mainnet; Owner: -
--

ALTER TABLE ONLY mainnet.genesis_files
    ADD CONSTRAINT genesis_files_pkey PRIMARY KEY (_id);


--
-- Name: messages messages_pkey; Type: CONSTRAINT; Schema: mainnet; Owner: -
--

ALTER TABLE ONLY mainnet.messages
    ADD CONSTRAINT messages_pkey PRIMARY KEY (_id);


--
-- Name: module_accounts module_accounts_pkey; Type: CONSTRAINT; Schema: mainnet; Owner: -
--

ALTER TABLE ONLY mainnet.module_accounts
    ADD CONSTRAINT module_accounts_pkey PRIMARY KEY (_id);


--
-- Name: morse_claimable_accounts morse_claimable_accounts_pkey; Type: CONSTRAINT; Schema: mainnet; Owner: -
--

ALTER TABLE ONLY mainnet.morse_claimable_accounts
    ADD CONSTRAINT morse_claimable_accounts_pkey PRIMARY KEY (_id);


--
-- Name: msg_add_services msg_add_services_pkey; Type: CONSTRAINT; Schema: mainnet; Owner: -
--

ALTER TABLE ONLY mainnet.msg_add_services
    ADD CONSTRAINT msg_add_services_pkey PRIMARY KEY (_id);


--
-- Name: msg_claim_morse_accounts msg_claim_morse_accounts_pkey; Type: CONSTRAINT; Schema: mainnet; Owner: -
--

ALTER TABLE ONLY mainnet.msg_claim_morse_accounts
    ADD CONSTRAINT msg_claim_morse_accounts_pkey PRIMARY KEY (_id);


--
-- Name: msg_claim_morse_application_services msg_claim_morse_application_services_pkey; Type: CONSTRAINT; Schema: mainnet; Owner: -
--

ALTER TABLE ONLY mainnet.msg_claim_morse_application_services
    ADD CONSTRAINT msg_claim_morse_application_services_pkey PRIMARY KEY (_id);


--
-- Name: msg_claim_morse_applications msg_claim_morse_applications_pkey; Type: CONSTRAINT; Schema: mainnet; Owner: -
--

ALTER TABLE ONLY mainnet.msg_claim_morse_applications
    ADD CONSTRAINT msg_claim_morse_applications_pkey PRIMARY KEY (_id);


--
-- Name: msg_claim_morse_supplier_services msg_claim_morse_supplier_services_pkey; Type: CONSTRAINT; Schema: mainnet; Owner: -
--

ALTER TABLE ONLY mainnet.msg_claim_morse_supplier_services
    ADD CONSTRAINT msg_claim_morse_supplier_services_pkey PRIMARY KEY (_id);


--
-- Name: msg_claim_morse_suppliers msg_claim_morse_suppliers_pkey; Type: CONSTRAINT; Schema: mainnet; Owner: -
--

ALTER TABLE ONLY mainnet.msg_claim_morse_suppliers
    ADD CONSTRAINT msg_claim_morse_suppliers_pkey PRIMARY KEY (_id);


--
-- Name: msg_create_claims msg_create_claims_pkey; Type: CONSTRAINT; Schema: mainnet; Owner: -
--

ALTER TABLE ONLY mainnet.msg_create_claims
    ADD CONSTRAINT msg_create_claims_pkey PRIMARY KEY (_id);


--
-- Name: msg_create_validators msg_create_validators_pkey; Type: CONSTRAINT; Schema: mainnet; Owner: -
--

ALTER TABLE ONLY mainnet.msg_create_validators
    ADD CONSTRAINT msg_create_validators_pkey PRIMARY KEY (_id);


--
-- Name: msg_delegate_to_gateways msg_delegate_to_gateways_pkey; Type: CONSTRAINT; Schema: mainnet; Owner: -
--

ALTER TABLE ONLY mainnet.msg_delegate_to_gateways
    ADD CONSTRAINT msg_delegate_to_gateways_pkey PRIMARY KEY (_id);


--
-- Name: msg_import_morse_claimable_accounts msg_import_morse_claimable_accounts_pkey; Type: CONSTRAINT; Schema: mainnet; Owner: -
--

ALTER TABLE ONLY mainnet.msg_import_morse_claimable_accounts
    ADD CONSTRAINT msg_import_morse_claimable_accounts_pkey PRIMARY KEY (_id);


--
-- Name: msg_recover_morse_accounts msg_recover_morse_accounts_pkey; Type: CONSTRAINT; Schema: mainnet; Owner: -
--

ALTER TABLE ONLY mainnet.msg_recover_morse_accounts
    ADD CONSTRAINT msg_recover_morse_accounts_pkey PRIMARY KEY (_id);


--
-- Name: msg_stake_application_services msg_stake_application_services_pkey; Type: CONSTRAINT; Schema: mainnet; Owner: -
--

ALTER TABLE ONLY mainnet.msg_stake_application_services
    ADD CONSTRAINT msg_stake_application_services_pkey PRIMARY KEY (_id);


--
-- Name: msg_stake_applications msg_stake_applications_pkey; Type: CONSTRAINT; Schema: mainnet; Owner: -
--

ALTER TABLE ONLY mainnet.msg_stake_applications
    ADD CONSTRAINT msg_stake_applications_pkey PRIMARY KEY (_id);


--
-- Name: msg_stake_gateways msg_stake_gateways_pkey; Type: CONSTRAINT; Schema: mainnet; Owner: -
--

ALTER TABLE ONLY mainnet.msg_stake_gateways
    ADD CONSTRAINT msg_stake_gateways_pkey PRIMARY KEY (_id);


--
-- Name: msg_stake_supplier_services msg_stake_supplier_services_pkey; Type: CONSTRAINT; Schema: mainnet; Owner: -
--

ALTER TABLE ONLY mainnet.msg_stake_supplier_services
    ADD CONSTRAINT msg_stake_supplier_services_pkey PRIMARY KEY (_id);


--
-- Name: msg_stake_suppliers msg_stake_suppliers_pkey; Type: CONSTRAINT; Schema: mainnet; Owner: -
--

ALTER TABLE ONLY mainnet.msg_stake_suppliers
    ADD CONSTRAINT msg_stake_suppliers_pkey PRIMARY KEY (_id);


--
-- Name: msg_submit_proofs msg_submit_proofs_pkey; Type: CONSTRAINT; Schema: mainnet; Owner: -
--

ALTER TABLE ONLY mainnet.msg_submit_proofs
    ADD CONSTRAINT msg_submit_proofs_pkey PRIMARY KEY (_id);


--
-- Name: msg_transfer_applications msg_transfer_applications_pkey; Type: CONSTRAINT; Schema: mainnet; Owner: -
--

ALTER TABLE ONLY mainnet.msg_transfer_applications
    ADD CONSTRAINT msg_transfer_applications_pkey PRIMARY KEY (_id);


--
-- Name: msg_undelegate_from_gateways msg_undelegate_from_gateways_pkey; Type: CONSTRAINT; Schema: mainnet; Owner: -
--

ALTER TABLE ONLY mainnet.msg_undelegate_from_gateways
    ADD CONSTRAINT msg_undelegate_from_gateways_pkey PRIMARY KEY (_id);


--
-- Name: msg_unstake_applications msg_unstake_applications_pkey; Type: CONSTRAINT; Schema: mainnet; Owner: -
--

ALTER TABLE ONLY mainnet.msg_unstake_applications
    ADD CONSTRAINT msg_unstake_applications_pkey PRIMARY KEY (_id);


--
-- Name: msg_unstake_gateways msg_unstake_gateways_pkey; Type: CONSTRAINT; Schema: mainnet; Owner: -
--

ALTER TABLE ONLY mainnet.msg_unstake_gateways
    ADD CONSTRAINT msg_unstake_gateways_pkey PRIMARY KEY (_id);


--
-- Name: msg_unstake_suppliers msg_unstake_suppliers_pkey; Type: CONSTRAINT; Schema: mainnet; Owner: -
--

ALTER TABLE ONLY mainnet.msg_unstake_suppliers
    ADD CONSTRAINT msg_unstake_suppliers_pkey PRIMARY KEY (_id);


--
-- Name: native_transfers native_transfers_pkey; Type: CONSTRAINT; Schema: mainnet; Owner: -
--

ALTER TABLE ONLY mainnet.native_transfers
    ADD CONSTRAINT native_transfers_pkey PRIMARY KEY (_id);


--
-- Name: params params_pkey; Type: CONSTRAINT; Schema: mainnet; Owner: -
--

ALTER TABLE ONLY mainnet.params
    ADD CONSTRAINT params_pkey PRIMARY KEY (_id);


--
-- Name: services services_pkey; Type: CONSTRAINT; Schema: mainnet; Owner: -
--

ALTER TABLE ONLY mainnet.services
    ADD CONSTRAINT services_pkey PRIMARY KEY (_id);


--
-- Name: supplier_service_configs supplier_service_configs_pkey; Type: CONSTRAINT; Schema: mainnet; Owner: -
--

ALTER TABLE ONLY mainnet.supplier_service_configs
    ADD CONSTRAINT supplier_service_configs_pkey PRIMARY KEY (_id);


--
-- Name: suppliers suppliers_pkey; Type: CONSTRAINT; Schema: mainnet; Owner: -
--

ALTER TABLE ONLY mainnet.suppliers
    ADD CONSTRAINT suppliers_pkey PRIMARY KEY (_id);


--
-- Name: supplies supplies_pkey; Type: CONSTRAINT; Schema: mainnet; Owner: -
--

ALTER TABLE ONLY mainnet.supplies
    ADD CONSTRAINT supplies_pkey PRIMARY KEY (_id);


--
-- Name: supply_denoms supply_denoms_pkey; Type: CONSTRAINT; Schema: mainnet; Owner: -
--

ALTER TABLE ONLY mainnet.supply_denoms
    ADD CONSTRAINT supply_denoms_pkey PRIMARY KEY (_id);


--
-- Name: transactions transactions_pkey; Type: CONSTRAINT; Schema: mainnet; Owner: -
--

ALTER TABLE ONLY mainnet.transactions
    ADD CONSTRAINT transactions_pkey PRIMARY KEY (_id);


--
-- Name: validator_commissions validator_commissions_pkey; Type: CONSTRAINT; Schema: mainnet; Owner: -
--

ALTER TABLE ONLY mainnet.validator_commissions
    ADD CONSTRAINT validator_commissions_pkey PRIMARY KEY (_id);


--
-- Name: validator_rewards validator_rewards_pkey; Type: CONSTRAINT; Schema: mainnet; Owner: -
--

ALTER TABLE ONLY mainnet.validator_rewards
    ADD CONSTRAINT validator_rewards_pkey PRIMARY KEY (_id);


--
-- Name: validators validators_pkey; Type: CONSTRAINT; Schema: mainnet; Owner: -
--

ALTER TABLE ONLY mainnet.validators
    ADD CONSTRAINT validators_pkey PRIMARY KEY (_id);


--
-- Name: 0x000b4acd21673e8e; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x000b4acd21673e8e" ON mainnet.event_transfer_errors USING gist (event_id, _block_range);


--
-- Name: 0x004d19df886c3bd5; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x004d19df886c3bd5" ON mainnet.transactions USING gin (amount_sent_by_denom);


--
-- Name: 0x00776e3c40d49b94; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x00776e3c40d49b94" ON mainnet.gateways USING gist (stake_status, _block_range);


--
-- Name: 0x0584b196101a0f32; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x0584b196101a0f32" ON mainnet.suppliers USING gist (operator_id, _block_range);


--
-- Name: 0x06495860e70552fd; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x06495860e70552fd" ON mainnet.event_application_overserviceds USING gist (event_id, _block_range);


--
-- Name: 0x08560adc921bd3ff; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x08560adc921bd3ff" ON mainnet.msg_import_morse_claimable_accounts USING gist (block_id, _block_range);


--
-- Name: 0x08dbdf10d6d5d163; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x08dbdf10d6d5d163" ON mainnet.suppliers USING gist (unstaking_begin_block_id, _block_range);


--
-- Name: 0x091ad90e6f508803; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x091ad90e6f508803" ON mainnet.event_transfer_begins USING gist (event_id, _block_range);


--
-- Name: 0x092e9a66aae078f9; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x092e9a66aae078f9" ON mainnet.events USING gist (transaction_id, _block_range);


--
-- Name: 0x0aaf12af2902cc44; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x0aaf12af2902cc44" ON mainnet.native_transfers USING gist (recipient_id, _block_range);


--
-- Name: 0x0b813e4b8a6b5b35; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x0b813e4b8a6b5b35" ON mainnet.transactions USING gin (fees);


--
-- Name: 0x0b9091aa69efac24; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x0b9091aa69efac24" ON mainnet.event_supplier_slasheds USING gist (supplier_id, _block_range);


--
-- Name: 0x0e7f88385f802331; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x0e7f88385f802331" ON mainnet.balances USING gist (last_updated_block_id, _block_range);


--
-- Name: 0x102bb0a13e4043ab; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x102bb0a13e4043ab" ON mainnet.application_services USING btree (id);


--
-- Name: 0x10856b314c260502; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x10856b314c260502" ON mainnet.accounts USING gist (module_id, _block_range);


--
-- Name: 0x1098b7a772331b10; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x1098b7a772331b10" ON mainnet.event_gateway_unstakeds USING gist (gateway_id, _block_range);


--
-- Name: 0x10d5ed2f3ffd22cf; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x10d5ed2f3ffd22cf" ON mainnet.event_claim_settleds USING gist (block_id, _block_range);


--
-- Name: 0x11b39dd1cc928f42; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x11b39dd1cc928f42" ON mainnet.event_application_unbonding_begins USING btree (id);


--
-- Name: 0x136d55f50dcdf862; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x136d55f50dcdf862" ON mainnet.event_claim_expireds USING gist (transaction_id, _block_range);


--
-- Name: 0x14e498170285b0de; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x14e498170285b0de" ON mainnet.event_application_overserviceds USING gist (block_id, _block_range);


--
-- Name: 0x14ff4784b12498be; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x14ff4784b12498be" ON mainnet.msg_stake_gateways USING gist (transaction_id, _block_range);


--
-- Name: 0x15aef83fa54b6a2f; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x15aef83fa54b6a2f" ON mainnet.block_supplies USING gist (supply_id, _block_range);


--
-- Name: 0x16e64d2fb45708c3; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x16e64d2fb45708c3" ON mainnet.msg_recover_morse_accounts USING gist (shannon_dest_address_id, _block_range);


--
-- Name: 0x1781ac49f204fd42; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x1781ac49f204fd42" ON mainnet.msg_undelegate_from_gateways USING gist (transaction_id, _block_range);


--
-- Name: 0x18405fb6cd778595; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x18405fb6cd778595" ON mainnet.validators USING gin (commission);


--
-- Name: 0x1936e30d5290b5d7; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x1936e30d5290b5d7" ON mainnet.validator_rewards USING gist (event_id, _block_range);


--
-- Name: 0x19f67fa9c631df9d; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x19f67fa9c631df9d" ON mainnet.application_gateways USING btree (id);


--
-- Name: 0x1acc61469affe6a1; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x1acc61469affe6a1" ON mainnet.msg_claim_morse_accounts USING gist (account_id, _block_range);


--
-- Name: 0x1b1eebe42a725735; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x1b1eebe42a725735" ON mainnet.event_claim_expireds USING gist (block_id, _block_range);


--
-- Name: 0x1c11061910c45928; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x1c11061910c45928" ON mainnet.msg_delegate_to_gateways USING btree (id);


--
-- Name: 0x1d97456a7a7e98f0; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x1d97456a7a7e98f0" ON mainnet.gateways USING btree (id);


--
-- Name: 0x1e268fd5211ce6e6; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x1e268fd5211ce6e6" ON mainnet.msg_stake_gateways USING gist (message_id, _block_range);


--
-- Name: 0x1e8c6c5d400363d8; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x1e8c6c5d400363d8" ON mainnet.suppliers USING gist (stake_status, _block_range);


--
-- Name: 0x1f3d9f850c8c6006; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x1f3d9f850c8c6006" ON mainnet.events USING gist (block_id, _block_range);


--
-- Name: 0x1f5e1e8ff2995a26; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x1f5e1e8ff2995a26" ON mainnet.event_transfer_begins USING gist (block_id, _block_range);


--
-- Name: 0x1f6461a47cac0060; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x1f6461a47cac0060" ON mainnet.event_application_overserviceds USING btree (id);


--
-- Name: 0x1fdd352f1d33845a; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x1fdd352f1d33845a" ON mainnet.event_supplier_unbonding_begins USING btree (id);


--
-- Name: 0x2014fc82a5ddcd25; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x2014fc82a5ddcd25" ON mainnet.msg_claim_morse_applications USING gist (block_id, _block_range);


--
-- Name: 0x210e9fbda9de385e; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x210e9fbda9de385e" ON mainnet.msg_add_services USING gist (transaction_id, _block_range);


--
-- Name: 0x22bc7881c9c6600b; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x22bc7881c9c6600b" ON mainnet.event_application_unbonding_begins USING gist (event_id, _block_range);


--
-- Name: 0x23c8103087b3f35f; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x23c8103087b3f35f" ON mainnet.events USING gist (type, _block_range);


--
-- Name: 0x23caa8f97f09aef3; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x23caa8f97f09aef3" ON mainnet.event_supplier_slasheds USING gist (service_id, _block_range);


--
-- Name: 0x245b7403f5b50329; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x245b7403f5b50329" ON mainnet.params USING gist (key, _block_range);


--
-- Name: 0x25097832df75b86c; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x25097832df75b86c" ON mainnet.msg_add_services USING gist (service_id, _block_range);


--
-- Name: 0x258d3189494504dd; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x258d3189494504dd" ON mainnet.blocks USING gist (proposer_address, _block_range);


--
-- Name: 0x2637e92882a516bc; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x2637e92882a516bc" ON mainnet.gateways USING gist (account_id, _block_range);


--
-- Name: 0x2705441b2238a27b; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x2705441b2238a27b" ON mainnet.msg_stake_suppliers USING gist (owner_id, _block_range);


--
-- Name: 0x275bb4b425b950b2; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x275bb4b425b950b2" ON mainnet.msg_unstake_suppliers USING gist (block_id, _block_range);


--
-- Name: 0x278df385d0cf305f; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x278df385d0cf305f" ON mainnet.msg_stake_applications USING gist (message_id, _block_range);


--
-- Name: 0x27b89204f0b5fb78; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x27b89204f0b5fb78" ON mainnet.msg_unstake_gateways USING btree (id);


--
-- Name: 0x281a3353b001f08b; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x281a3353b001f08b" ON mainnet.authz_execs USING btree (id);


--
-- Name: 0x283b3c0dd2eff825; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x283b3c0dd2eff825" ON mainnet.validators USING gist (signer_pokt_prefix_id, _block_range);


--
-- Name: 0x298effb85231a6fb; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x298effb85231a6fb" ON mainnet.event_supplier_unbonding_begins USING gist (event_id, _block_range);


--
-- Name: 0x29ab88ce5f1ef209; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x29ab88ce5f1ef209" ON mainnet.msg_claim_morse_accounts USING gist (transaction_id, _block_range);


--
-- Name: 0x29b58c62adbb98dc; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x29b58c62adbb98dc" ON mainnet.delegations USING gist (validator_operator, _block_range);


--
-- Name: 0x2a217de4090a9c52; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x2a217de4090a9c52" ON mainnet.msg_claim_morse_applications USING btree (id);


--
-- Name: 0x2a7466fea6c9fef8; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x2a7466fea6c9fef8" ON mainnet.msg_claim_morse_applications USING gist (message_id, _block_range);


--
-- Name: 0x2d6e47b4b8a04787; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x2d6e47b4b8a04787" ON mainnet.event_relay_mining_difficulty_updateds USING gist (block_id, _block_range);


--
-- Name: 0x2e74206554f22e82; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x2e74206554f22e82" ON mainnet.accounts USING gist (chain_id, _block_range);


--
-- Name: 0x2f005b54bbb3698b; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x2f005b54bbb3698b" ON mainnet.event_application_unbonding_ends USING gist (block_id, _block_range);


--
-- Name: 0x2f0f46743d96fc30; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x2f0f46743d96fc30" ON mainnet.validator_rewards USING gist (validator_id, _block_range);


--
-- Name: 0x2fa92e933744d786; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x2fa92e933744d786" ON mainnet.event_validator_reward_distributions USING gist (block_id, _block_range);


--
-- Name: 0x3011445b76f78dea; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x3011445b76f78dea" ON mainnet.msg_submit_proofs USING gist (transaction_id, _block_range);


--
-- Name: 0x3019782fb38f9448; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x3019782fb38f9448" ON mainnet.msg_stake_applications USING btree (id);


--
-- Name: 0x3061ab38ff33074d; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x3061ab38ff33074d" ON mainnet.applications USING gist (account_id, _block_range);


--
-- Name: 0x309faeb809f67c83; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x309faeb809f67c83" ON mainnet.msg_stake_supplier_services USING gin (endpoints);


--
-- Name: 0x314457667062d657; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x314457667062d657" ON mainnet.transactions USING gin (amount_of_messages);


--
-- Name: 0x31aac80f1e14a850; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x31aac80f1e14a850" ON mainnet.msg_create_claims USING gist (application_id, _block_range);


--
-- Name: 0x33d88cc4aede736a; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x33d88cc4aede736a" ON mainnet.msg_create_validators USING gin (commission);


--
-- Name: 0x33eb3e288aec6f27; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x33eb3e288aec6f27" ON mainnet.application_gateways USING gist (application_id, _block_range);


--
-- Name: 0x356b68c07865af17; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x356b68c07865af17" ON mainnet.event_supplier_unbonding_ends USING gist (event_id, _block_range);


--
-- Name: 0x362e083fa123e4e5; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x362e083fa123e4e5" ON mainnet.event_proof_updateds USING gist (transaction_id, _block_range);


--
-- Name: 0x36425d85638b7d88; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x36425d85638b7d88" ON mainnet.msg_stake_suppliers USING btree (id);


--
-- Name: 0x37821270d576a3cb; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x37821270d576a3cb" ON mainnet.event_proof_validity_checkeds USING gist (supplier_id, _block_range);


--
-- Name: 0x37a4591ffb16a7ec; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x37a4591ffb16a7ec" ON mainnet.event_claim_expireds USING gist (service_id, _block_range);


--
-- Name: 0x37d9685c72d37cab; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x37d9685c72d37cab" ON mainnet.event_gateway_unstakeds USING gist (event_id, _block_range);


--
-- Name: 0x38bd30151fb846b5; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x38bd30151fb846b5" ON mainnet.msg_stake_suppliers USING gist (signer_id, _block_range);


--
-- Name: 0x3aa470ce86b53074; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x3aa470ce86b53074" ON mainnet.balances USING btree (id);


--
-- Name: 0x3c31bfdec5502bfe; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x3c31bfdec5502bfe" ON mainnet.msg_add_services USING gist (message_id, _block_range);


--
-- Name: 0x3c341ef35a9ef671; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x3c341ef35a9ef671" ON mainnet.authzs USING gist (event_id, _block_range);


--
-- Name: 0x3c667df16e0f5b96; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x3c667df16e0f5b96" ON mainnet.msg_unstake_gateways USING gist (message_id, _block_range);


--
-- Name: 0x3cef430a0391c756; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x3cef430a0391c756" ON mainnet.event_transfer_ends USING gist (destination_id, _block_range);


--
-- Name: 0x3cfcb4c9b1530d1a; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x3cfcb4c9b1530d1a" ON mainnet.msg_claim_morse_application_services USING gist (claim_msg_id, _block_range);


--
-- Name: 0x3d088f83c991199f; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x3d088f83c991199f" ON mainnet.event_application_overserviceds USING gist (application_id, _block_range);


--
-- Name: 0x3d0de70ca11e52d8; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x3d0de70ca11e52d8" ON mainnet.event_claim_expireds USING gist (application_id, _block_range);


--
-- Name: 0x3d5948b122152b77; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x3d5948b122152b77" ON mainnet.blocks USING gist (chain_id, _block_range);


--
-- Name: 0x3d6142c8e6fe468d; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x3d6142c8e6fe468d" ON mainnet.msg_claim_morse_supplier_services USING gin (rev_share);


--
-- Name: 0x3d6fb0fdd8950657; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x3d6fb0fdd8950657" ON mainnet.msg_transfer_applications USING btree (id);


--
-- Name: 0x3d807f68beb038bf; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x3d807f68beb038bf" ON mainnet.msg_stake_supplier_services USING gist (service_id, _block_range);


--
-- Name: 0x3e1217df431e8814; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x3e1217df431e8814" ON mainnet.msg_stake_gateways USING btree (id);


--
-- Name: 0x412ef25ed3a2c796; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x412ef25ed3a2c796" ON mainnet.event_proof_updateds USING gist (block_id, _block_range);


--
-- Name: 0x4196d846ef2b3cc4; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x4196d846ef2b3cc4" ON mainnet.msg_stake_applications USING gist (application_id, _block_range);


--
-- Name: 0x4237f5ba55d42531; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x4237f5ba55d42531" ON mainnet.params USING gist (block_id, _block_range);


--
-- Name: 0x428c01d4ef53ce34; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x428c01d4ef53ce34" ON mainnet.event_application_reimbursement_requests USING gist (block_id, _block_range);


--
-- Name: 0x445a3650ef396471; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x445a3650ef396471" ON mainnet.native_transfers USING gist (message_id, _block_range);


--
-- Name: 0x449b4b11660ea541; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x449b4b11660ea541" ON mainnet.authz_execs USING gist (grantee, _block_range);


--
-- Name: 0x44a4bce990818ed8; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x44a4bce990818ed8" ON mainnet.msg_claim_morse_supplier_services USING gin (endpoints);


--
-- Name: 0x455d0ee7abbcedbe; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x455d0ee7abbcedbe" ON mainnet.event_supplier_slasheds USING btree (id);


--
-- Name: 0x4574b41f2b24e2f2; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x4574b41f2b24e2f2" ON mainnet.msg_submit_proofs USING btree (id);


--
-- Name: 0x45d461c9da9660bc; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x45d461c9da9660bc" ON mainnet.event_application_unbonding_ends USING gist (application_id, _block_range);


--
-- Name: 0x461a93ac7099228d; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x461a93ac7099228d" ON mainnet.applications USING btree (id);


--
-- Name: 0x46b6303f35f130ff; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x46b6303f35f130ff" ON mainnet.morse_claimable_accounts USING gist (msg_import_morse_claimable_accounts_id, _block_range);


--
-- Name: 0x4717bd2dc95a17eb; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x4717bd2dc95a17eb" ON mainnet.msg_stake_application_services USING btree (id);


--
-- Name: 0x48534d5548e813a1; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x48534d5548e813a1" ON mainnet.msg_recover_morse_accounts USING btree (id);


--
-- Name: 0x48af919d3e3f11c8; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x48af919d3e3f11c8" ON mainnet.authzs USING gist (msg, _block_range);


--
-- Name: 0x48b96f1ed19740b1; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x48b96f1ed19740b1" ON mainnet.event_proof_validity_checkeds USING gist (application_id, _block_range);


--
-- Name: 0x49fbaea5b5b72b49; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x49fbaea5b5b72b49" ON mainnet.delegations USING btree (id);


--
-- Name: 0x4a45d00e452cd63c; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x4a45d00e452cd63c" ON mainnet.application_services USING gist (service_id, _block_range);


--
-- Name: 0x4a8a837dc5e85f6d; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x4a8a837dc5e85f6d" ON mainnet.event_claim_settleds USING gist (supplier_owner_id, _block_range);


--
-- Name: 0x4ab5f7d68331e538; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x4ab5f7d68331e538" ON mainnet.msg_delegate_to_gateways USING gist (application_id, _block_range);


--
-- Name: 0x4ba92d207d776b9a; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x4ba92d207d776b9a" ON mainnet.msg_submit_proofs USING gist (supplier_id, _block_range);


--
-- Name: 0x4c8376892fed3388; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x4c8376892fed3388" ON mainnet.native_transfers USING gist (status, _block_range);


--
-- Name: 0x4cb388e53e3e30f3; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x4cb388e53e3e30f3" ON mainnet.accounts USING btree (id);


--
-- Name: 0x4cbccf17a8c1e1b8; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x4cbccf17a8c1e1b8" ON mainnet.validator_commissions USING gist (validator_id, _block_range);


--
-- Name: 0x4d10b8919f49724f; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x4d10b8919f49724f" ON mainnet.params USING btree (id);


--
-- Name: 0x4dff977cc36a7917; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x4dff977cc36a7917" ON mainnet.msg_recover_morse_accounts USING gist (authority_id, _block_range);


--
-- Name: 0x4f9bbd92f8184019; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x4f9bbd92f8184019" ON mainnet.event_relay_mining_difficulty_updateds USING gist (event_id, _block_range);


--
-- Name: 0x506577e6239b4bef; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x506577e6239b4bef" ON mainnet.event_application_unbonding_begins USING gist (application_id, _block_range);


--
-- Name: 0x51f86b328f18b0a3; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x51f86b328f18b0a3" ON mainnet.morse_claimable_accounts USING gist (transaction_id, _block_range);


--
-- Name: 0x529cec5d1d4fa6e6; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x529cec5d1d4fa6e6" ON mainnet.event_transfer_ends USING gist (event_id, _block_range);


--
-- Name: 0x53214a1784fa8261; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x53214a1784fa8261" ON mainnet.msg_create_claims USING gist (transaction_id, _block_range);


--
-- Name: 0x543ac6b7a88740bf; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x543ac6b7a88740bf" ON mainnet.event_supplier_slasheds USING gist (event_id, _block_range);


--
-- Name: 0x553862bce80d6750; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x553862bce80d6750" ON mainnet.event_application_unbonding_begins USING gist (block_id, _block_range);


--
-- Name: 0x55523eec17e6ccc2; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x55523eec17e6ccc2" ON mainnet.event_supplier_slasheds USING gist (block_id, _block_range);


--
-- Name: 0x56b638443a0413e9; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x56b638443a0413e9" ON mainnet.validators USING gist (delegator_id, _block_range);


--
-- Name: 0x56c7c282c6631973; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x56c7c282c6631973" ON mainnet.authzs USING gist (type, _block_range);


--
-- Name: 0x56fe26936cc41206; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x56fe26936cc41206" ON mainnet.application_services USING gist (application_id, _block_range);


--
-- Name: 0x585f0d21a444f5a8; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x585f0d21a444f5a8" ON mainnet.msg_stake_applications USING gist (block_id, _block_range);


--
-- Name: 0x58e0e7b0d356884a; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x58e0e7b0d356884a" ON mainnet.genesis_balances USING gist (account_id, _block_range);


--
-- Name: 0x59790e0ef084a93b; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x59790e0ef084a93b" ON mainnet.msg_claim_morse_suppliers USING gist (supplier_id, _block_range);


--
-- Name: 0x59f75d2bc1e6a0bc; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x59f75d2bc1e6a0bc" ON mainnet.blocks USING gist ("timestamp", _block_range);


--
-- Name: 0x5b1307c31145e31f; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x5b1307c31145e31f" ON mainnet.event_gateway_unbonding_begins USING gist (event_id, _block_range);


--
-- Name: 0x5b74f4b7b7af35da; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x5b74f4b7b7af35da" ON mainnet.event_transfer_errors USING gist (destination_id, _block_range);


--
-- Name: 0x5c36f454630f4898; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x5c36f454630f4898" ON mainnet.msg_claim_morse_suppliers USING gist (message_id, _block_range);


--
-- Name: 0x5c3ffd16bf1e9110; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x5c3ffd16bf1e9110" ON mainnet.messages USING gist (block_id, _block_range);


--
-- Name: 0x5cb6e360cf09ea17; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x5cb6e360cf09ea17" ON mainnet.services USING gist (owner_id, _block_range);


--
-- Name: 0x5e323f0df95b3c28; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x5e323f0df95b3c28" ON mainnet.event_validator_reward_distributions USING gist (validator_account_address, _block_range);


--
-- Name: 0x5eeccfbfc9d7f4cb; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x5eeccfbfc9d7f4cb" ON mainnet.msg_create_claims USING gist (service_id, _block_range);


--
-- Name: 0x5f1e6e5f3803a999; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x5f1e6e5f3803a999" ON mainnet.native_transfers USING gist (denom, _block_range);


--
-- Name: 0x5f3eeba217167300; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x5f3eeba217167300" ON mainnet.event_claim_settleds USING gist (application_id, _block_range);


--
-- Name: 0x6079e925d5297548; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x6079e925d5297548" ON mainnet.msg_create_claims USING btree (id);


--
-- Name: 0x6131d72d57f2a188; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x6131d72d57f2a188" ON mainnet.blocks USING gist (hash, _block_range);


--
-- Name: 0x63f831411fd249ca; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x63f831411fd249ca" ON mainnet.msg_create_validators USING gin (pubkey);


--
-- Name: 0x6459fb98a65708d0; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x6459fb98a65708d0" ON mainnet.msg_stake_supplier_services USING btree (id);


--
-- Name: 0x65a502a428dd1462; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x65a502a428dd1462" ON mainnet.event_gateway_unstakeds USING btree (id);


--
-- Name: 0x65ee5e48da498dc8; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x65ee5e48da498dc8" ON mainnet.suppliers USING gist (unstaking_end_block_id, _block_range);


--
-- Name: 0x66bf9e932b8a926e; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x66bf9e932b8a926e" ON mainnet.validator_commissions USING gist (block_id, _block_range);


--
-- Name: 0x6877613353ebd786; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x6877613353ebd786" ON mainnet.supplier_service_configs USING gin (rev_share);


--
-- Name: 0x6a12b239e3f18d36; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x6a12b239e3f18d36" ON mainnet.native_transfers USING gin (amounts);


--
-- Name: 0x6a64f7ca77b0d865; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x6a64f7ca77b0d865" ON mainnet.supplies USING gist (denom, _block_range);


--
-- Name: 0x6aba15dfca6bc246; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x6aba15dfca6bc246" ON mainnet.authz_execs USING gist (transaction_id, _block_range);


--
-- Name: 0x6b52bcc3a0f7a360; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x6b52bcc3a0f7a360" ON mainnet.event_transfer_errors USING btree (id);


--
-- Name: 0x6b9f030d404bea3b; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x6b9f030d404bea3b" ON mainnet.messages USING gist (transaction_id, _block_range);


--
-- Name: 0x6bccc914e4d005a7; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x6bccc914e4d005a7" ON mainnet.msg_import_morse_claimable_accounts USING gist (authority_id, _block_range);


--
-- Name: 0x6d07220ed3ab6a9d; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x6d07220ed3ab6a9d" ON mainnet.event_application_unbonding_ends USING gist (event_id, _block_range);


--
-- Name: 0x6d28adfc86af204d; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x6d28adfc86af204d" ON mainnet.authzs USING gist (block_id, _block_range);


--
-- Name: 0x6e284d2fdfda01ed; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x6e284d2fdfda01ed" ON mainnet.event_application_unbonding_ends USING btree (id);


--
-- Name: 0x6f655462fcb4995e; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x6f655462fcb4995e" ON mainnet.transactions USING gist (status, _block_range);


--
-- Name: 0x700d61ba595c762d; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x700d61ba595c762d" ON mainnet.native_transfers USING gist (transaction_id, _block_range);


--
-- Name: 0x71714dc933737099; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x71714dc933737099" ON mainnet.msg_undelegate_from_gateways USING gist (message_id, _block_range);


--
-- Name: 0x718b9c77b443f905; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x718b9c77b443f905" ON mainnet.msg_import_morse_claimable_accounts USING gist (message_id, _block_range);


--
-- Name: 0x72dbc3a6a1dcfef5; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x72dbc3a6a1dcfef5" ON mainnet.msg_import_morse_claimable_accounts USING btree (id);


--
-- Name: 0x72f041fd12659786; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x72f041fd12659786" ON mainnet.event_proof_updateds USING gist (service_id, _block_range);


--
-- Name: 0x7324438ffd147a52; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x7324438ffd147a52" ON mainnet.msg_claim_morse_suppliers USING gist (block_id, _block_range);


--
-- Name: 0x73de1ee1e48d8f09; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x73de1ee1e48d8f09" ON mainnet.event_supplier_service_config_activateds USING gist (block_id, _block_range);


--
-- Name: 0x743e4a5c7c77d262; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x743e4a5c7c77d262" ON mainnet.event_supplier_unbonding_begins USING gist (supplier_id, _block_range);


--
-- Name: 0x74e55ba902b865ff; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x74e55ba902b865ff" ON mainnet.event_transfer_ends USING gist (block_id, _block_range);


--
-- Name: 0x752337e642a2bb9e; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x752337e642a2bb9e" ON mainnet.applications USING gist (transferring_to_id, _block_range);


--
-- Name: 0x75364b6625d7e3e1; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x75364b6625d7e3e1" ON mainnet.msg_stake_gateways USING gist (block_id, _block_range);


--
-- Name: 0x75968ebe0b04685e; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x75968ebe0b04685e" ON mainnet.msg_create_validators USING gin (description);


--
-- Name: 0x75cb311a39e1f59c; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x75cb311a39e1f59c" ON mainnet.validator_rewards USING gist (block_id, _block_range);


--
-- Name: 0x762bcb3bcd21dd3f; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x762bcb3bcd21dd3f" ON mainnet.event_proof_validity_checkeds USING gist (event_id, _block_range);


--
-- Name: 0x768f6d19f41cb490; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x768f6d19f41cb490" ON mainnet.messages USING gist (type_url, _block_range);


--
-- Name: 0x76c0e962ef7e76a0; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x76c0e962ef7e76a0" ON mainnet.msg_submit_proofs USING gist (application_id, _block_range);


--
-- Name: 0x76de40cdec2c1cd2; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x76de40cdec2c1cd2" ON mainnet.msg_submit_proofs USING gist (service_id, _block_range);


--
-- Name: 0x776afd62fb4d38b8; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x776afd62fb4d38b8" ON mainnet.event_proof_validity_checkeds USING gist (service_id, _block_range);


--
-- Name: 0x77cd190574559301; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x77cd190574559301" ON mainnet.authz_msg_execs USING gist (message_id, _block_range);


--
-- Name: 0x78782ea0fdfdd2c2; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x78782ea0fdfdd2c2" ON mainnet.event_relay_mining_difficulty_updateds USING gist (service_id, _block_range);


--
-- Name: 0x78c1ee810e50ebd5; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x78c1ee810e50ebd5" ON mainnet.validators USING gist (stake_status, _block_range);


--
-- Name: 0x7ae87ead1a62544c; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x7ae87ead1a62544c" ON mainnet.msg_create_validators USING gist (transaction_id, _block_range);


--
-- Name: 0x7b0479d23b76426c; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x7b0479d23b76426c" ON mainnet.event_gateway_unbonding_ends USING btree (id);


--
-- Name: 0x7ba3bc03047262c3; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x7ba3bc03047262c3" ON mainnet.authzs USING gist (grantee_id, _block_range);


--
-- Name: 0x7ce1dd62ea8d6ee9; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x7ce1dd62ea8d6ee9" ON mainnet.event_transfer_begins USING gist (destination_id, _block_range);


--
-- Name: 0x7cebf4c1ed8f146c; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x7cebf4c1ed8f146c" ON mainnet.msg_stake_supplier_services USING gin (rev_share);


--
-- Name: 0x7e13b9aa59b1b24b; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x7e13b9aa59b1b24b" ON mainnet.gateways USING gist (unstaking_begin_block_id, _block_range);


--
-- Name: 0x7e5deb1e1d1c280d; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x7e5deb1e1d1c280d" ON mainnet.morse_claimable_accounts USING gist (claimed_msg_id, _block_range);


--
-- Name: 0x7ebdf2c7d7d84d9e; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x7ebdf2c7d7d84d9e" ON mainnet.event_proof_updateds USING gist (relay_id, _block_range);


--
-- Name: 0x7fcdea576639932e; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x7fcdea576639932e" ON mainnet.msg_claim_morse_accounts USING gist (message_id, _block_range);


--
-- Name: 0x8089dd7707591a45; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x8089dd7707591a45" ON mainnet.event_transfer_ends USING btree (id);


--
-- Name: 0x80bd12f194aafb95; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x80bd12f194aafb95" ON mainnet.msg_transfer_applications USING gist (block_id, _block_range);


--
-- Name: 0x80fcdc7cbc57a4e9; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x80fcdc7cbc57a4e9" ON mainnet.services USING btree (id);


--
-- Name: 0x8158311edc7094b6; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x8158311edc7094b6" ON mainnet.event_gateway_unstakeds USING gist (transaction_id, _block_range);


--
-- Name: 0x81c4e0beed63be07; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x81c4e0beed63be07" ON mainnet.authz_msg_execs USING btree (id);


--
-- Name: 0x8383b2bd331211ee; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x8383b2bd331211ee" ON mainnet.event_application_overserviceds USING gist (supplier_id, _block_range);


--
-- Name: 0x845de907fad571dc; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x845de907fad571dc" ON mainnet.applications USING gist (unstaking_begin_block_id, _block_range);


--
-- Name: 0x8475bf018fc87a49; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x8475bf018fc87a49" ON mainnet.event_proof_updateds USING gist (application_id, _block_range);


--
-- Name: 0x84dd2072d6c42049; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x84dd2072d6c42049" ON mainnet.msg_transfer_applications USING gist (message_id, _block_range);


--
-- Name: 0x84f376b1ebd1a174; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x84f376b1ebd1a174" ON mainnet.event_application_reimbursement_requests USING gist (service_id, _block_range);


--
-- Name: 0x86cf7367cdbc848f; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x86cf7367cdbc848f" ON mainnet.event_supplier_slasheds USING gist (application_id, _block_range);


--
-- Name: 0x87b3ee3f0fdb8597; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x87b3ee3f0fdb8597" ON mainnet.supplier_service_configs USING gist (activated_at_id, _block_range);


--
-- Name: 0x87da029bdcfbb584; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x87da029bdcfbb584" ON mainnet.msg_claim_morse_accounts USING btree (id);


--
-- Name: 0x881a7b5593a0bcc8; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x881a7b5593a0bcc8" ON mainnet.msg_unstake_gateways USING gist (block_id, _block_range);


--
-- Name: 0x88fa1919ac379f84; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x88fa1919ac379f84" ON mainnet.event_supplier_service_config_activateds USING gist (event_id, _block_range);


--
-- Name: 0x899a10f5eabcd16d; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x899a10f5eabcd16d" ON mainnet.msg_stake_application_services USING gist (service_id, _block_range);


--
-- Name: 0x8a28840c72040fe3; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x8a28840c72040fe3" ON mainnet.msg_import_morse_claimable_accounts USING gist (transaction_id, _block_range);


--
-- Name: 0x8ae9524bcfe792a1; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x8ae9524bcfe792a1" ON mainnet.msg_stake_suppliers USING gist (message_id, _block_range);


--
-- Name: 0x8aee3ced20eb2895; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x8aee3ced20eb2895" ON mainnet.transactions USING gist (signer_address, _block_range);


--
-- Name: 0x8badaa0e9467c364; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x8badaa0e9467c364" ON mainnet.event_application_overserviceds USING gist (service_id, _block_range);


--
-- Name: 0x8c8640371a3a608b; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x8c8640371a3a608b" ON mainnet.msg_claim_morse_applications USING gist (application_id, _block_range);


--
-- Name: 0x8c9a8d71d77f3fb1; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x8c9a8d71d77f3fb1" ON mainnet.msg_stake_supplier_services USING gist (stake_msg_id, _block_range);


--
-- Name: 0x8dd40a897c50a523; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x8dd40a897c50a523" ON mainnet.transactions USING gist (timeout_height, _block_range);


--
-- Name: 0x8dfe5e233c1b130d; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x8dfe5e233c1b130d" ON mainnet.msg_transfer_applications USING gist (source_application_id, _block_range);


--
-- Name: 0x8e8843680ded0d42; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x8e8843680ded0d42" ON mainnet.event_gateway_unbonding_begins USING gist (block_id, _block_range);


--
-- Name: 0x8faf1417266506ce; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x8faf1417266506ce" ON mainnet.msg_stake_suppliers USING gist (supplier_id, _block_range);


--
-- Name: 0x8fed119aedba4205; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x8fed119aedba4205" ON mainnet.gateways USING gist (unstaking_end_block_id, _block_range);


--
-- Name: 0x903dd8c14d76de5f; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x903dd8c14d76de5f" ON mainnet.msg_stake_suppliers USING gist (transaction_id, _block_range);


--
-- Name: 0x90619687981ecb5b; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x90619687981ecb5b" ON mainnet.event_relay_mining_difficulty_updateds USING btree (id);


--
-- Name: 0x9228a4aa51463cbe; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x9228a4aa51463cbe" ON mainnet.native_transfers USING gist (block_id, _block_range);


--
-- Name: 0x9393a31e83c272bf; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x9393a31e83c272bf" ON mainnet.msg_add_services USING gist (owner_id, _block_range);


--
-- Name: 0x93cfbe3a29fff1f9; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x93cfbe3a29fff1f9" ON mainnet.msg_claim_morse_applications USING gist (transaction_id, _block_range);


--
-- Name: 0x942ee83a77d54c77; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x942ee83a77d54c77" ON mainnet.authz_msg_execs USING gist (authz_exec_id, _block_range);


--
-- Name: 0x9474012d26aa4788; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x9474012d26aa4788" ON mainnet.msg_unstake_gateways USING gist (transaction_id, _block_range);


--
-- Name: 0x94e63ca22058fa65; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x94e63ca22058fa65" ON mainnet.events USING gist (message_id, _block_range);


--
-- Name: 0x94f293cb36297566; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x94f293cb36297566" ON mainnet.msg_create_validators USING gist (signer_id, _block_range);


--
-- Name: 0x94f8e390df0eb75e; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x94f8e390df0eb75e" ON mainnet.msg_recover_morse_accounts USING gist (block_id, _block_range);


--
-- Name: 0x953451cdf8fc4048; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x953451cdf8fc4048" ON mainnet.msg_claim_morse_accounts USING gist (block_id, _block_range);


--
-- Name: 0x96103f88d9e0aa2d; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x96103f88d9e0aa2d" ON mainnet.msg_stake_suppliers USING gist (block_id, _block_range);


--
-- Name: 0x9676d95a34d61121; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x9676d95a34d61121" ON mainnet.msg_delegate_to_gateways USING gist (transaction_id, _block_range);


--
-- Name: 0x99eaa786d9915ecc; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x99eaa786d9915ecc" ON mainnet.genesis_files USING btree (id);


--
-- Name: 0x9a721403fbca0573; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x9a721403fbca0573" ON mainnet.msg_claim_morse_application_services USING btree (id);


--
-- Name: 0x9ace5249901ad08b; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x9ace5249901ad08b" ON mainnet.native_transfers USING btree (id);


--
-- Name: 0x9be6d3425d1bacfa; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x9be6d3425d1bacfa" ON mainnet.event_claim_updateds USING gist (relay_id, _block_range);


--
-- Name: 0x9c2f441f2998b66f; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x9c2f441f2998b66f" ON mainnet.event_supplier_unbonding_ends USING btree (id);


--
-- Name: 0x9d06b81b6ec8d089; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x9d06b81b6ec8d089" ON mainnet.msg_undelegate_from_gateways USING gist (gateway_id, _block_range);


--
-- Name: 0x9e317d279ddfc717; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x9e317d279ddfc717" ON mainnet.blocks USING gist (metadata_id, _block_range);


--
-- Name: 0x9f6d53ac5c87c345; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x9f6d53ac5c87c345" ON mainnet.msg_stake_application_services USING gist (stake_msg_id, _block_range);


--
-- Name: 0x9fb78ab65f9e5635; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0x9fb78ab65f9e5635" ON mainnet.event_transfer_errors USING gist (source_id, _block_range);


--
-- Name: 0xa1374a1e7524cec3; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0xa1374a1e7524cec3" ON mainnet.msg_transfer_applications USING gist (destination_application_id, _block_range);


--
-- Name: 0xa15f07e9cbb7f384; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0xa15f07e9cbb7f384" ON mainnet.msg_claim_morse_application_services USING gist (service_id, _block_range);


--
-- Name: 0xa22836d2819e6dec; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0xa22836d2819e6dec" ON mainnet.balances USING gist (denom, _block_range);


--
-- Name: 0xa29165046592da90; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0xa29165046592da90" ON mainnet.msg_unstake_gateways USING gist (gateway_id, _block_range);


--
-- Name: 0xa31495406d3bdc48; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0xa31495406d3bdc48" ON mainnet.event_claim_settleds USING gist (service_id, _block_range);


--
-- Name: 0xa321a1e4e0d5440e; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0xa321a1e4e0d5440e" ON mainnet.applications USING gist (transfer_end_block_id, _block_range);


--
-- Name: 0xa52aba815e29db64; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0xa52aba815e29db64" ON mainnet.event_claim_settleds USING gist (supplier_id, _block_range);


--
-- Name: 0xa552c3653636ba9e; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0xa552c3653636ba9e" ON mainnet.event_gateway_unbonding_ends USING gist (event_id, _block_range);


--
-- Name: 0xa72b5c3163d9a705; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0xa72b5c3163d9a705" ON mainnet.event_claim_updateds USING gist (block_id, _block_range);


--
-- Name: 0xa760fe71ffe947f7; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0xa760fe71ffe947f7" ON mainnet.msg_unstake_applications USING btree (id);


--
-- Name: 0xa808672414a6e969; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0xa808672414a6e969" ON mainnet.validator_commissions USING gist (event_id, _block_range);


--
-- Name: 0xaa093005a0f46db3; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0xaa093005a0f46db3" ON mainnet.native_transfers USING gist (sender_id, _block_range);


--
-- Name: 0xaa1ee019072d27f6; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0xaa1ee019072d27f6" ON mainnet.morse_claimable_accounts USING btree (id);


--
-- Name: 0xaa8c3088385328e6; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0xaa8c3088385328e6" ON mainnet.messages USING btree (id);


--
-- Name: 0xaba9bad64d32ff74; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0xaba9bad64d32ff74" ON mainnet.event_gateway_unbonding_begins USING gist (transaction_id, _block_range);


--
-- Name: 0xabdf93500d901d8e; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0xabdf93500d901d8e" ON mainnet.event_gateway_unbonding_ends USING gist (gateway_id, _block_range);


--
-- Name: 0xac94b3fa405f33fa; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0xac94b3fa405f33fa" ON mainnet.validator_commissions USING btree (id);


--
-- Name: 0xacc22329e0c84979; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0xacc22329e0c84979" ON mainnet.event_transfer_begins USING gist (transaction_id, _block_range);


--
-- Name: 0xad371557d7d0ae73; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0xad371557d7d0ae73" ON mainnet.event_gateway_unbonding_begins USING btree (id);


--
-- Name: 0xae0ceaf9ee024503; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0xae0ceaf9ee024503" ON mainnet.event_claim_updateds USING gist (service_id, _block_range);


--
-- Name: 0xaf52de7d1543cd12; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0xaf52de7d1543cd12" ON mainnet.supplier_service_configs USING gist (activated_event_id, _block_range);


--
-- Name: 0xb17ffc218339f00d; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0xb17ffc218339f00d" ON mainnet.msg_claim_morse_supplier_services USING btree (id);


--
-- Name: 0xb1a0cd7f8d33b9b0; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0xb1a0cd7f8d33b9b0" ON mainnet.msg_unstake_applications USING gist (application_id, _block_range);


--
-- Name: 0xb2200a5ebe3c844d; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0xb2200a5ebe3c844d" ON mainnet.validators USING gist (transaction_id, _block_range);


--
-- Name: 0xb2cc2c6c03aeea74; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0xb2cc2c6c03aeea74" ON mainnet.validator_rewards USING btree (id);


--
-- Name: 0xb2f035ee31049227; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0xb2f035ee31049227" ON mainnet.msg_create_validators USING gist (delegator_id, _block_range);


--
-- Name: 0xb3f254153b7e4d0a; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0xb3f254153b7e4d0a" ON mainnet.validators USING gin (description);


--
-- Name: 0xb5b0b87a06221b54; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0xb5b0b87a06221b54" ON mainnet.authz_execs USING gist (message_id, _block_range);


--
-- Name: 0xb5b6fab15abbf102; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0xb5b6fab15abbf102" ON mainnet.msg_unstake_suppliers USING gist (supplier_id, _block_range);


--
-- Name: 0xb6661ae275452358; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0xb6661ae275452358" ON mainnet.msg_delegate_to_gateways USING gist (message_id, _block_range);


--
-- Name: 0xb6d869cea02541dd; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0xb6d869cea02541dd" ON mainnet.msg_create_claims USING gist (block_id, _block_range);


--
-- Name: 0xb7ca8756e51b075a; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0xb7ca8756e51b075a" ON mainnet.msg_claim_morse_suppliers USING gist (transaction_id, _block_range);


--
-- Name: 0xb7f934126ea2bc04; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0xb7f934126ea2bc04" ON mainnet.event_application_reimbursement_requests USING gist (application_id, _block_range);


--
-- Name: 0xb811beb1b841b6aa; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0xb811beb1b841b6aa" ON mainnet.application_gateways USING gist (gateway_id, _block_range);


--
-- Name: 0xb95a4347c8e3263d; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0xb95a4347c8e3263d" ON mainnet.event_claim_settleds USING gist (transaction_id, _block_range);


--
-- Name: 0xbb77014c06aeea23; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0xbb77014c06aeea23" ON mainnet.event_gateway_unbonding_begins USING gist (gateway_id, _block_range);


--
-- Name: 0xbbe8cc2d617cdaec; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0xbbe8cc2d617cdaec" ON mainnet.module_accounts USING btree (id);


--
-- Name: 0xbc385dd8bfc6b320; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0xbc385dd8bfc6b320" ON mainnet.transactions USING gin (multisig);


--
-- Name: 0xbe248b4933c99454; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0xbe248b4933c99454" ON mainnet.applications USING gist (unstaking_end_block_id, _block_range);


--
-- Name: 0xbecd8be968df3274; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0xbecd8be968df3274" ON mainnet.event_claim_expireds USING btree (id);


--
-- Name: 0xbee3959417875d42; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0xbee3959417875d42" ON mainnet.event_transfer_begins USING btree (id);


--
-- Name: 0xbf756e9c4498ec93; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0xbf756e9c4498ec93" ON mainnet.msg_claim_morse_supplier_services USING gist (service_id, _block_range);


--
-- Name: 0xc0024d69c3229be7; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0xc0024d69c3229be7" ON mainnet.event_claim_updateds USING btree (id);


--
-- Name: 0xc11e2ef5f2382c28; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0xc11e2ef5f2382c28" ON mainnet.event_application_reimbursement_requests USING btree (id);


--
-- Name: 0xc149cd7a92c04eca; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0xc149cd7a92c04eca" ON mainnet.params USING gist (namespace, _block_range);


--
-- Name: 0xc1b3baa7875fa984; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0xc1b3baa7875fa984" ON mainnet.msg_add_services USING btree (id);


--
-- Name: 0xc25748a8d6fb40cd; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0xc25748a8d6fb40cd" ON mainnet.msg_claim_morse_supplier_services USING gist (claim_msg_id, _block_range);


--
-- Name: 0xc262f52e15590a14; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0xc262f52e15590a14" ON mainnet.event_transfer_errors USING gist (block_id, _block_range);


--
-- Name: 0xc32032f9a9d05a15; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0xc32032f9a9d05a15" ON mainnet.msg_unstake_suppliers USING btree (id);


--
-- Name: 0xc621c17541321f38; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0xc621c17541321f38" ON mainnet.msg_delegate_to_gateways USING gist (block_id, _block_range);


--
-- Name: 0xc7d259f084c06ea9; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0xc7d259f084c06ea9" ON mainnet.event_supplier_unbonding_ends USING gist (block_id, _block_range);


--
-- Name: 0xc7f44ad2de6635ef; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0xc7f44ad2de6635ef" ON mainnet.event_validator_reward_distributions USING btree (id);


--
-- Name: 0xc91068250da68c36; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0xc91068250da68c36" ON mainnet.msg_create_claims USING gist (supplier_id, _block_range);


--
-- Name: 0xc94ffca5a8d3ff9f; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0xc94ffca5a8d3ff9f" ON mainnet.msg_create_validators USING btree (id);


--
-- Name: 0xc963835f03eb9cfd; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0xc963835f03eb9cfd" ON mainnet.msg_create_validators USING gist (block_id, _block_range);


--
-- Name: 0xca10de28e5acb0a5; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0xca10de28e5acb0a5" ON mainnet.msg_unstake_suppliers USING gist (signer_id, _block_range);


--
-- Name: 0xca65a586d6bd6389; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0xca65a586d6bd6389" ON mainnet.block_supplies USING btree (id);


--
-- Name: 0xcb6b99b85177c9dc; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0xcb6b99b85177c9dc" ON mainnet.event_claim_settleds USING btree (id);


--
-- Name: 0xcbeb2408cb8e0423; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0xcbeb2408cb8e0423" ON mainnet.transactions USING btree (id);


--
-- Name: 0xcd598cf34b3bc990; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0xcd598cf34b3bc990" ON mainnet.event_supplier_service_config_activateds USING btree (id);


--
-- Name: 0xce35eb449fed051d; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0xce35eb449fed051d" ON mainnet.delegations USING gist (delegator, _block_range);


--
-- Name: 0xcee15532309d01fa; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0xcee15532309d01fa" ON mainnet.event_validator_reward_distributions USING gist (validator_operator_address, _block_range);


--
-- Name: 0xcf8f933c89af1739; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0xcf8f933c89af1739" ON mainnet.msg_unstake_applications USING gist (block_id, _block_range);


--
-- Name: 0xcfa29fb8f6330293; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0xcfa29fb8f6330293" ON mainnet.authzs USING gist (granter_id, _block_range);


--
-- Name: 0xd05a05b6a3b1efcb; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0xd05a05b6a3b1efcb" ON mainnet.msg_recover_morse_accounts USING gist (transaction_id, _block_range);


--
-- Name: 0xd135f8b19e7d994d; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0xd135f8b19e7d994d" ON mainnet.msg_unstake_applications USING gist (message_id, _block_range);


--
-- Name: 0xd1f45d868cd2b387; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0xd1f45d868cd2b387" ON mainnet.event_supplier_unbonding_begins USING gist (block_id, _block_range);


--
-- Name: 0xd245f0909505d9ad; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0xd245f0909505d9ad" ON mainnet.event_proof_validity_checkeds USING btree (id);


--
-- Name: 0xd26dd5312e821e3e; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0xd26dd5312e821e3e" ON mainnet.msg_undelegate_from_gateways USING gist (application_id, _block_range);


--
-- Name: 0xd3f4183bada75352; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0xd3f4183bada75352" ON mainnet.event_gateway_unbonding_ends USING gist (block_id, _block_range);


--
-- Name: 0xd460e24d6385aca5; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0xd460e24d6385aca5" ON mainnet.event_proof_updateds USING gist (supplier_id, _block_range);


--
-- Name: 0xd49f5c131649c9ae; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0xd49f5c131649c9ae" ON mainnet.msg_stake_applications USING gist (transaction_id, _block_range);


--
-- Name: 0xd4aca688357a0faf; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0xd4aca688357a0faf" ON mainnet.applications USING gist (stake_status, _block_range);


--
-- Name: 0xd56e70053393817d; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0xd56e70053393817d" ON mainnet.msg_stake_gateways USING gist (gateway_id, _block_range);


--
-- Name: 0xd8cdddf2856af856; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0xd8cdddf2856af856" ON mainnet.supplier_service_configs USING gin (endpoints);


--
-- Name: 0xd91c4f56a5e5a3ad; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0xd91c4f56a5e5a3ad" ON mainnet.msg_undelegate_from_gateways USING btree (id);


--
-- Name: 0xd922885ac10fecef; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0xd922885ac10fecef" ON mainnet.event_claim_updateds USING gist (application_id, _block_range);


--
-- Name: 0xd958767600c238ab; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0xd958767600c238ab" ON mainnet.msg_delegate_to_gateways USING gist (gateway_id, _block_range);


--
-- Name: 0xda1ae7d37d264af4; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0xda1ae7d37d264af4" ON mainnet.msg_unstake_suppliers USING gist (message_id, _block_range);


--
-- Name: 0xda7b671228cec582; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0xda7b671228cec582" ON mainnet.supply_denoms USING btree (id);


--
-- Name: 0xdabe167ad937a24a; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0xdabe167ad937a24a" ON mainnet.morse_claimable_accounts USING gist (claimed_at_id, _block_range);


--
-- Name: 0xdae7178ecda2ac29; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0xdae7178ecda2ac29" ON mainnet.module_accounts USING gist (name, _block_range);


--
-- Name: 0xdc4255f79971f023; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0xdc4255f79971f023" ON mainnet.validators USING gist (create_msg_id, _block_range);


--
-- Name: 0xdc52a0854648916d; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0xdc52a0854648916d" ON mainnet.msg_add_services USING gist (block_id, _block_range);


--
-- Name: 0xdcd389953c779d83; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0xdcd389953c779d83" ON mainnet.supplier_service_configs USING gist (supplier_id, _block_range);


--
-- Name: 0xdd1ac9c77dc9c80a; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0xdd1ac9c77dc9c80a" ON mainnet.applications USING gist (destination_application_id, _block_range);


--
-- Name: 0xdd6e72c689eb1591; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0xdd6e72c689eb1591" ON mainnet.authzs USING btree (id);


--
-- Name: 0xdd839dd30c8762fe; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0xdd839dd30c8762fe" ON mainnet.transactions USING gist (block_id, _block_range);


--
-- Name: 0xdd8c8bfa3419a944; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0xdd8c8bfa3419a944" ON mainnet.event_gateway_unstakeds USING gist (block_id, _block_range);


--
-- Name: 0xddade6d04b85b108; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0xddade6d04b85b108" ON mainnet.event_claim_updateds USING gist (supplier_id, _block_range);


--
-- Name: 0xde55107a04ae184e; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0xde55107a04ae184e" ON mainnet.msg_create_validators USING gist (signer_pokt_prefix_id, _block_range);


--
-- Name: 0xde6e106ab362680a; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0xde6e106ab362680a" ON mainnet.msg_unstake_suppliers USING gist (transaction_id, _block_range);


--
-- Name: 0xdefcb454df20a1f6; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0xdefcb454df20a1f6" ON mainnet.applications USING gist (transfer_begin_block_id, _block_range);


--
-- Name: 0xdfb42e5067068233; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0xdfb42e5067068233" ON mainnet.suppliers USING gist (owner_id, _block_range);


--
-- Name: 0xdfee43138100c24f; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0xdfee43138100c24f" ON mainnet.msg_claim_morse_suppliers USING btree (id);


--
-- Name: 0xe0a30e89948c82de; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0xe0a30e89948c82de" ON mainnet.event_claim_updateds USING gist (transaction_id, _block_range);


--
-- Name: 0xe1205db36159b7ed; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0xe1205db36159b7ed" ON mainnet.supplier_service_configs USING gist (service_id, _block_range);


--
-- Name: 0xe251b5dac8c40bb2; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0xe251b5dac8c40bb2" ON mainnet.applications USING gist (source_application_id, _block_range);


--
-- Name: 0xe304b2992006cabd; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0xe304b2992006cabd" ON mainnet.supplier_service_configs USING btree (id);


--
-- Name: 0xe374d70191310e12; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0xe374d70191310e12" ON mainnet.applications USING gist (transferred_from_at_id, _block_range);


--
-- Name: 0xe3cfb4df88e40052; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0xe3cfb4df88e40052" ON mainnet.event_transfer_begins USING gist (source_id, _block_range);


--
-- Name: 0xe49f9a2a6cef0d83; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0xe49f9a2a6cef0d83" ON mainnet.event_application_reimbursement_requests USING gist (event_id, _block_range);


--
-- Name: 0xe5bf5858bd35a276; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0xe5bf5858bd35a276" ON mainnet.events USING btree (id);


--
-- Name: 0xe5f7aa2da276b7ac; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0xe5f7aa2da276b7ac" ON mainnet.msg_transfer_applications USING gist (transaction_id, _block_range);


--
-- Name: 0xe8073051425e3fa9; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0xe8073051425e3fa9" ON mainnet.validators USING btree (id);


--
-- Name: 0xe8623246ab5ae1a2; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0xe8623246ab5ae1a2" ON mainnet.native_transfers USING gist (event_id, _block_range);


--
-- Name: 0xe8a3a4637089dace; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0xe8a3a4637089dace" ON mainnet.msg_create_validators USING gist (message_id, _block_range);


--
-- Name: 0xea744dc1ff363d51; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0xea744dc1ff363d51" ON mainnet.block_metadata USING gin (header);


--
-- Name: 0xeab1d083f0c16197; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0xeab1d083f0c16197" ON mainnet.msg_unstake_applications USING gist (transaction_id, _block_range);


--
-- Name: 0xeb2ed033ec77a5ee; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0xeb2ed033ec77a5ee" ON mainnet.event_proof_updateds USING btree (id);


--
-- Name: 0xedb1f588642da117; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0xedb1f588642da117" ON mainnet.msg_undelegate_from_gateways USING gist (block_id, _block_range);


--
-- Name: 0xeecc7ad5c5c8e5de; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0xeecc7ad5c5c8e5de" ON mainnet.supplies USING btree (id);


--
-- Name: 0xf12527b94b76f454; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0xf12527b94b76f454" ON mainnet.msg_submit_proofs USING gist (block_id, _block_range);


--
-- Name: 0xf321f650f7714d9c; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0xf321f650f7714d9c" ON mainnet.balances USING gist (account_id, _block_range);


--
-- Name: 0xf409ee496cbc75d8; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0xf409ee496cbc75d8" ON mainnet.event_transfer_ends USING gist (source_id, _block_range);


--
-- Name: 0xf40c70a0405ed13d; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0xf40c70a0405ed13d" ON mainnet.suppliers USING btree (id);


--
-- Name: 0xf82877f1b2f8cf4e; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0xf82877f1b2f8cf4e" ON mainnet.event_claim_expireds USING gist (supplier_id, _block_range);


--
-- Name: 0xf89d9fab33d6e956; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0xf89d9fab33d6e956" ON mainnet.genesis_balances USING gist (denom, _block_range);


--
-- Name: 0xfa47dbe64d284848; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0xfa47dbe64d284848" ON mainnet.event_proof_validity_checkeds USING gist (block_id, _block_range);


--
-- Name: 0xfa5eda5cdc3a19f7; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0xfa5eda5cdc3a19f7" ON mainnet.block_supplies USING gist (block_id, _block_range);


--
-- Name: 0xfbabf55a3c496857; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0xfbabf55a3c496857" ON mainnet.msg_recover_morse_accounts USING gist (message_id, _block_range);


--
-- Name: 0xfd2c1463d7053fd7; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0xfd2c1463d7053fd7" ON mainnet.authz_execs USING gist (block_id, _block_range);


--
-- Name: 0xfe6aa2eb6af4a125; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0xfe6aa2eb6af4a125" ON mainnet.event_supplier_unbonding_ends USING gist (supplier_id, _block_range);


--
-- Name: 0xfe760574034640ee; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0xfe760574034640ee" ON mainnet.validators USING gist (signer_id, _block_range);


--
-- Name: 0xfe8fb9fa4ec05df0; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0xfe8fb9fa4ec05df0" ON mainnet.genesis_balances USING btree (id);


--
-- Name: 0xff5de277cbae8890; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX "0xff5de277cbae8890" ON mainnet.event_application_reimbursement_requests USING gist (supplier_id, _block_range);


--
-- Name: balances_block_range_upper_idx; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX balances_block_range_upper_idx ON mainnet.balances USING btree (upper(_block_range));


--
-- Name: idx_balances_block_id; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX idx_balances_block_id ON mainnet.balances USING btree (last_updated_block_id);


--
-- Name: idx_block_metadata_id; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX idx_block_metadata_id ON mainnet.block_metadata USING btree (id);


--
-- Name: idx_blocks_id; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX idx_blocks_id ON mainnet.blocks USING btree (id);


--
-- Name: idx_blocks_timestamp_id; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX idx_blocks_timestamp_id ON mainnet.blocks USING btree ("timestamp", id);


--
-- Name: idx_claimable_claimed_false; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX idx_claimable_claimed_false ON mainnet.morse_claimable_accounts USING btree (claimed) WHERE (claimed = false);


--
-- Name: idx_claims_backfill; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX idx_claims_backfill ON mainnet.msg_create_claims USING btree (block_id) WHERE (num_estimated_relays IS NULL);


--
-- Name: idx_event_claim_settleds_backfill; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX idx_event_claim_settleds_backfill ON mainnet.event_claim_settleds USING btree (block_id) WHERE (num_estimated_relays IS NULL);


--
-- Name: idx_event_claim_settleds_block_id; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX idx_event_claim_settleds_block_id ON mainnet.event_claim_settleds USING btree (block_id);


--
-- Name: idx_event_claim_settleds_service_session_end; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX idx_event_claim_settleds_service_session_end ON mainnet.event_claim_settleds USING btree (service_id, session_end_height);


--
-- Name: idx_event_claim_settleds_session_id; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX idx_event_claim_settleds_session_id ON mainnet.event_claim_settleds USING btree (session_id);


--
-- Name: idx_event_claim_settleds_supplier_block; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX idx_event_claim_settleds_supplier_block ON mainnet.event_claim_settleds USING btree (supplier_id, block_id);


--
-- Name: idx_event_claim_settleds_supplier_block_service; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX idx_event_claim_settleds_supplier_block_service ON mainnet.event_claim_settleds USING btree (supplier_id, block_id, service_id);


--
-- Name: idx_event_proof_validity_checkeds_supplier_block; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX idx_event_proof_validity_checkeds_supplier_block ON mainnet.event_proof_validity_checkeds USING btree (supplier_id, block_id);


--
-- Name: idx_morse_claimable_accounts_morse_output; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX idx_morse_claimable_accounts_morse_output ON mainnet.morse_claimable_accounts USING btree (morse_output_address);


--
-- Name: idx_morse_claimable_accounts_shannon_dest; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX idx_morse_claimable_accounts_shannon_dest ON mainnet.morse_claimable_accounts USING btree (shannon_dest_address);


--
-- Name: idx_msg_submit_proofs_session_id; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX idx_msg_submit_proofs_session_id ON mainnet.msg_submit_proofs USING btree (session_id);


--
-- Name: idx_msg_submit_proofs_supplier_block; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX idx_msg_submit_proofs_supplier_block ON mainnet.msg_submit_proofs USING btree (supplier_id, block_id);


--
-- Name: idx_rmd_service_block; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX idx_rmd_service_block ON mainnet.event_relay_mining_difficulty_updateds USING btree (service_id, block_id);


--
-- Name: idx_ssc_domains; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX idx_ssc_domains ON mainnet.supplier_service_configs USING gin (domains);


--
-- Name: idx_ssc_live_domains; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX idx_ssc_live_domains ON mainnet.supplier_service_configs USING gin (domains) WHERE upper_inf(_block_range);


--
-- Name: idx_ssc_live_rev_share; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX idx_ssc_live_rev_share ON mainnet.supplier_service_configs USING gin (rev_share jsonb_path_ops) WHERE upper_inf(_block_range);


--
-- Name: idx_ssc_live_service; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX idx_ssc_live_service ON mainnet.supplier_service_configs USING btree (service_id, supplier_id) WHERE upper_inf(_block_range);


--
-- Name: idx_ssc_live_supplier_domains; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX idx_ssc_live_supplier_domains ON mainnet.supplier_service_configs USING btree (supplier_id) INCLUDE (domains) WHERE upper_inf(_block_range);


--
-- Name: idx_ssc_live_supplier_service; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX idx_ssc_live_supplier_service ON mainnet.supplier_service_configs USING btree (supplier_id, service_id) WHERE upper_inf(_block_range);


--
-- Name: idx_suppliers_live_id; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX idx_suppliers_live_id ON mainnet.suppliers USING btree (id) INCLUDE (stake_status, stake_amount) WHERE upper_inf(_block_range);


--
-- Name: supplier_service_configs_block_range_idx; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX supplier_service_configs_block_range_idx ON mainnet.supplier_service_configs USING gist (_block_range);


--
-- Name: supplier_service_configs_supplier_id_idx; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX supplier_service_configs_supplier_id_idx ON mainnet.supplier_service_configs USING btree (supplier_id);


--
-- Name: suppliers_block_range_idx; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX suppliers_block_range_idx ON mainnet.suppliers USING gist (_block_range);


--
-- Name: suppliers_id_stake_status_idx; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX suppliers_id_stake_status_idx ON mainnet.suppliers USING btree (id, stake_status);


--
-- Name: suppliers_stake_status_idx; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX suppliers_stake_status_idx ON mainnet.suppliers USING btree (stake_status);


--
-- Name: transactions_block_id_desc_live_idx; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX transactions_block_id_desc_live_idx ON mainnet.transactions USING btree (block_id DESC, _id) INCLUDE (_block_range) WHERE (id IS NOT NULL);


--
-- Name: transactions_signer_block_id_desc_idx; Type: INDEX; Schema: mainnet; Owner: -
--

CREATE INDEX transactions_signer_block_id_desc_idx ON mainnet.transactions USING btree (signer_address, block_id DESC, _id) INCLUDE (_block_range);


--
-- PostgreSQL database dump complete
--



CREATE TABLE mainnet._metadata (
    key character varying(255) NOT NULL,
    value jsonb,
    "createdAt" timestamp with time zone NOT NULL,
    "updatedAt" timestamp with time zone NOT NULL,
    CONSTRAINT _metadata_pkey PRIMARY KEY (key)
);
