// GraphQL descriptions of the entity tables that stay exposed: one per table and per column, written as COMMENT ON by
// createEntityDescriptionsFn at start. A table keeps the smart tags SubQuery or smartTags.ts put in its comment
// (@foreignKey, @omit); the description goes after them. The columns that hold no data say so (measured on mainnet,
// 2026-10-13). A test checks every table and column against schema.graphql. Their forward relations (@foreignKey) get
// |@deprecated: relations leave the schema (deprecations.ts).
import { DEPRECATED_RELATION } from "./deprecations";

const HISTORY = "SubQuery keeps its history; GraphQL lists show the current version of each row unless asked for an earlier height.";

export const ENTITY_DESCRIPTIONS: Record<string, { table: string; columns: Record<string, string> }> = {
  blocks: {
    table: "One row per indexed block, keyed by height, with per-block totals (transactions, settled relays, staked actors) computed when the block is indexed.",
    columns: {
      id: "Block height.",
      chain_id: "Chain id from the block header.",
      hash: "Block hash, uppercase hex.",
      timestamp: "Block time from the block header, UTC.",
      proposer_address: "Consensus address of the validator that proposed the block, uppercase hex; matches validators.ed25519_id.",
      metadata_id: "Id of the block's metadata record (block id, full header, last commit); equal to the height.",
      size: "Approximate block size in bytes, computed by the indexer from the block id, header, transactions, evidence and last commit.",
      total_computed_units: "Sum of the claimed compute units of the claims settled in this block.",
      total_estimated_computed_units: "Sum of the estimated compute units of the claims settled in this block.",
      total_relays: "Sum of the relays of the claims settled in this block.",
      total_estimated_relays: "Sum of the estimated relays of the claims settled in this block.",
      failed_txs: "Number of transactions in this block with a non-zero result code.",
      successful_txs: "Number of transactions in this block with result code 0.",
      total_txs: "Number of transactions in this block.",
      staked_suppliers: "Number of suppliers with stake status Staked at this block.",
      staked_suppliers_tokens: "Total stake of the suppliers with status Staked at this block, in upokt.",
      unstaking_suppliers: "Number of suppliers with stake status Unstaking at this block.",
      unstaking_suppliers_tokens: "Total stake of the suppliers with status Unstaking at this block, in upokt.",
      time_to_block: "Milliseconds between this block's time and the previous block's time; 0 when the previous block is not indexed.",
      unstaked_suppliers: "Number of suppliers that became Unstaked in this block.",
      unstaked_suppliers_tokens: "Stake those suppliers held just before they became Unstaked, in upokt.",
      staked_apps: "Number of applications with stake status Staked at this block.",
      staked_apps_tokens: "Total stake of the applications with status Staked at this block, in upokt.",
      unstaking_apps: "Number of applications with stake status Unstaking at this block.",
      unstaking_apps_tokens: "Total stake of the applications with status Unstaking at this block, in upokt.",
      unstaked_apps: "Number of applications that became Unstaked in this block.",
      unstaked_apps_tokens: "Stake those applications held just before they became Unstaked, in upokt.",
      staked_gateways: "Number of gateways with stake status Staked at this block.",
      staked_gateways_tokens: "Total stake of the gateways with status Staked at this block, in upokt.",
      unstaked_gateways: "Number of gateways that became Unstaked in this block.",
      unstaked_gateways_tokens: "Stake those gateways held just before they became Unstaked, in upokt.",
      staked_validators: "Number of validators with stake status Staked (bonded) at this block.",
      staked_validators_tokens: "Total tokens of the validators with status Staked at this block, in upokt.",
      unstaking_validators: "Number of validators with stake status Unstaking (unbonding) at this block.",
      unstaking_validators_tokens: "Total tokens of the validators with status Unstaking at this block, in upokt.",
    },
  },

  transactions: {
    table: "One row per transaction, successful or failed, plus placeholder rows the indexer creates at the genesis height for the genesis state. Rows are not updated after they are written.",
    columns: {
      id: "Transaction hash, uppercase hex. Genesis placeholder rows use a made-up hash: zeros followed by a counter and a letter.",
      block_id: "Height of the block that includes the transaction.",
      gas_used: "Gas the transaction consumed.",
      gas_wanted: "Gas limit the transaction requested.",
      fees: "Fee paid, as a JSON list of coins [{denom, amount}], amount a string in the denom's base unit (upokt for upokt); empty list when no fee was set.",
      memo: "Memo from the transaction body; may be empty.",
      status: "TxStatus: Success when code is 0, Error otherwise.",
      log: "Raw log the chain returned for the transaction; empty string when there is none.",
      code: "Result code: 0 is success, any other value is an error of the module named in codespace.",
      idx: "Index of the transaction within its block.",
      codespace: "Module namespace of a non-zero result code; may be empty.",
      timeout_height: "Height after which the sender asked the chain not to include the transaction; 0 when unset, null on some genesis placeholder rows.",
      signer_address: "Address of the first signer (pokt prefix, or poktvaloper for validator-related messages); for a multisig, the multisig address. Null on most genesis placeholder rows.",
      is_multisig: "True when the transaction is signed with a legacy amino multisig key.",
      multisig: "Null unless is_multisig. JSON with from (multisig address), all (member addresses), signed (addresses that signed), indices, threshold, multisigPubKey, bitarrayElems and extraBitsStored.",
      amount_of_messages: "Message count per type, as a JSON list [{type, amount}]: type is the message type URL (e.g. /cosmos.bank.v1beta1.MsgSend), amount how many the transaction carries. Null on genesis placeholder rows.",
      amount_sent_by_denom: "Total sent by the transaction's MsgSend messages per denom, as a JSON list [{denom, amount}], amount a string; empty list when there is no MsgSend. Null on genesis placeholder rows.",
    },
  },

  native_transfers: {
    table: "One row per bank MsgSend message, from successful and failed transactions alike. Rows are not updated after they are written.",
    columns: {
      id: "Message id: the transaction hash and the message index joined by '-'.",
      recipient_id: "Address that receives the coins, the MsgSend to_address (Account id).",
      sender_id: "Address that sends the coins, the MsgSend from_address (Account id).",
      amounts: "Coins sent, as a JSON list [{denom, amount}], amount a string in the denom's base unit (upokt for upokt).",
      denom: "Denom of the first coin in amounts.",
      status: "TxStatus of the transaction that carries the message: Success or Error.",
      event_id: "Same value as message_id.",
      message_id: "Id of the MsgSend message; same value as id.",
      transaction_id: "Hash of the transaction that carries the message.",
      block_id: "Height of the block that includes the transaction.",
    },
  },

  accounts: {
    table: "One row per address the indexer has seen: in a coin movement, as a module account, in the genesis state, or as a validator signer. Each address is written once and not updated.",
    columns: {
      id: "Bech32 address (pokt..., or poktvaloper... for a validator operator).",
      chain_id: "Chain id of the block where the address was first written.",
      module_id: "Not populated (null).",
    },
  },

  balances: {
    table: `One row per address and denom with the balance after its last change. ${HISTORY}`,
    columns: {
      id: "Address and denom joined by '-'.",
      account_id: "The holder's address (Account id).",
      denom: "Coin denom.",
      amount: "Balance in the denom's base unit (upokt for upokt). Module account balances are read from the chain every block; other balances are the running sum of the chain's coin_received and coin_spent events.",
      last_updated_block_id: "Height of the block where the balance last changed.",
    },
  },

  params: {
    table: `One row per chain parameter (module namespace and key) with the value the chain holds, re-read from chain state every block. ${HISTORY}`,
    columns: {
      id: "Namespace and key joined by '-' (e.g. tokenomics-mint_ratio).",
      namespace: "Module the parameter belongs to: application, gateway, proof, service, session, shared, supplier, tokenomics, migration, auth, bank, distribution, mint, slashing, staking, gov or consensus.",
      key: "Parameter name: the proto field name in snake_case (e.g. num_blocks_per_session).",
      value: "Raw value as the chain REST returns it: strings as-is, anything else as JSON text (64-bit integers as strings, decimals with 18 places like '0.670000000000000000', durations like '600s').",
      active_at: "First height at which the chain uses this value; for shared and session changes this can be the next session start rather than the height of the change. Null on rows written before this field existed.",
      block_id: "Height at which this value was recorded: the first block whose chain state held it (the genesis height for genesis values).",
    },
  },

  supplies: {
    table: "One row per denom and total-supply amount: a new row is written at each height where the chain's total supply of that denom changed. Rows are not updated after they are written.",
    columns: {
      id: "Denom and the height where this amount was first recorded, joined by '@' (e.g. upokt@12345).",
      denom: "Coin denom.",
      amount: "Total supply of the denom in its base unit (upokt for upokt), as the chain's bank total supply query returned it.",
    },
  },

  block_supplies: {
    table: "One row per block and denom, linking the block to the total supply in force at that block. Rows are not updated after they are written.",
    columns: {
      id: "Denom and block height joined by '@'.",
      block_id: "Block height.",
      supply_id: "Id of the supplies row that holds the denom's total supply at this block.",
    },
  },

  services: {
    table: `One row per service (the chain or API that suppliers serve and applications pay for), as last defined by MsgAddService or the genesis state. ${HISTORY}`,
    columns: {
      id: "Service id as registered on chain.",
      name: "Service name.",
      compute_units_per_relay: "Compute units per relay for this service.",
      owner_id: "Address of the service owner (Account id).",
      prev_target_hash_hex_encoded: "Not maintained: null on most services, stale where set. The difficulty history is getRelayMiningDifficultyList.",
      new_target_hash_hex_encoded: "Not maintained: null on most services, stale where set. The difficulty history is getRelayMiningDifficultyList.",
      prev_num_relays_ema: "Not maintained: null on most services, stale where set. The difficulty history is getRelayMiningDifficultyList.",
      new_num_relays_ema: "Not maintained: null on most services, stale where set. The difficulty history is getRelayMiningDifficultyList.",
    },
  },

  suppliers: {
    table: `One row per supplier, keyed by operator address, with its stake and unstaking state. ${HISTORY}`,
    columns: {
      id: "Operator address.",
      operator_id: "The operator's address (Account id); same as id.",
      owner_id: "Owner address (Account id), from the last stake message or Morse claim.",
      stake_amount: "Stake in upokt: the amount of the last stake message (a Morse claim adds its stake to the previous one), reduced by slashes; 0 once Unstaked.",
      stake_denom: "Denom of stake_amount.",
      stake_status: "StakeStatus: Staked, Unstaking or Unstaked. Set to Staked by a stake message or Morse claim, to Unstaking by MsgUnstakeSupplier, to Unstaked when unbonding ends.",
      unstaking_begin_block_id: "Height of the block with the supplier's MsgUnstakeSupplier; null otherwise, cleared by a new stake.",
      unstaking_reason: "SupplierUnbondingReason from the unbonding events: UNSPECIFIED, VOLUNTARY, BELOW_MIN_STAKE or MIGRATION. Null when not unbonding, cleared by a new stake.",
      unstaking_end_height: "Height at which unbonding ends, as the chain announced when unbonding began; null otherwise.",
      unstaking_end_block_id: "Unbonding end height reported by the chain's unbonding-end event, which can be earlier than the block where that event was indexed; null until unbonding ends.",
    },
  },

  supplier_service_configs: {
    table: `One row per supplier and service: the latest config the supplier staked for that service. A config leaves the current list when a new stake drops the service or the supplier finishes unbonding; ${HISTORY}`,
    columns: {
      id: "Supplier operator address and service id joined by '-'.",
      supplier_id: "The supplier's operator address (Supplier id).",
      service_id: "The service's id (Service id).",
      rev_share: "Revenue share as a JSON list [{address, revSharePercentage}]: the address that receives a share and its percentage as an integer string.",
      endpoints: "Endpoints as a JSON list [{url, rpcType, configs}]: rpcType is a number (0 UNKNOWN_RPC, 1 GRPC, 2 WEBSOCKET, 3 JSON_RPC, 4 REST, 5 COMET_BFT) and configs a list [{key, value}] where key 0 is UNKNOWN_CONFIG and 1 is TIMEOUT.",
      domains: "Domains of the endpoint URLs (the last two labels of the host, e.g. nodefleet.net, or the IP address), counting only the first endpoint of each RPC type. Can be null on rows written before this field existed.",
      activated_at_id: "Height at which the chain activated this config; null while the config waits for activation.",
      activated_event_id: "Id of the chain event that activated this config; null while waiting and for configs active from genesis.",
    },
  },

  gateways: {
    table: `One row per gateway, keyed by address, with its stake and unstaking state. ${HISTORY}`,
    columns: {
      id: "Gateway address.",
      account_id: "The gateway's address (Account id); same as id.",
      stake_amount: "Stake in upokt as set by the last stake message; 0 once Unstaked.",
      stake_denom: "Denom of stake_amount.",
      stake_status: "StakeStatus: Staked, Unstaking or Unstaked. Set to Staked by a stake message, to Unstaking by MsgUnstakeGateway, to Unstaked when unbonding ends.",
      unstaking_begin_block_id: "Height of the block with the gateway's MsgUnstakeGateway; null otherwise, cleared by a new stake.",
      unstaking_end_height: "Height at which unbonding ends, as the chain announced when unbonding began; null otherwise.",
      unstaking_end_block_id: "Unbonding end height reported by the chain's unbonding-end event (for the older unstaked event, the block where it was indexed); null until unbonding ends.",
    },
  },

  applications: {
    table: `One row per application, keyed by address, with its stake, unstaking and transfer state. ${HISTORY}`,
    columns: {
      id: "Application address.",
      account_id: "The application's address (Account id); same as id.",
      stake_amount: "Stake in upokt, re-read from the chain on every block with an application message, an unbonding or transfer event, or a claim settlement; 0 once Unstaked.",
      stake_denom: "Denom of stake_amount.",
      stake_status: "StakeStatus read from the chain: Staked, Unstaking while an unstake is pending, Unstaked once the chain no longer holds the application.",
      unstaking_begin_block_id: "Height of the block with the application's MsgUnstakeApplication; null otherwise, cleared by a new stake.",
      unstaking_end_height: "Height at which unbonding ends, from the chain's unbonding-begin event; null otherwise, cleared by a new stake.",
      unstaking_reason: "ApplicationUnbondingReason: ELECTIVE, BELOW_MINIMUM_STAKE, TRANSFER or MIGRATION. Set from the unbonding-begin event, and to TRANSFER on the source application when a transfer completes.",
      unstaking_end_block_id: "Height of the block where unbonding ended, or for a transferred source application where the transfer ended; null until then.",
      transferred_from_at_id: "On an application created by a transfer: height of the block where the transfer completed; null otherwise.",
      source_application_id: "On an application created by a transfer: the source application's address; null otherwise.",
      destination_application_id: "On a source application whose transfer completed: the destination application's address; null otherwise.",
      transfer_begin_block_id: "Not populated (null).",
      transfer_end_block_id: "On a source application whose transfer completed: height of the block where it completed; null otherwise.",
      transferring_to_id: "Destination address while a transfer is pending; null otherwise.",
      transfer_end_height: "Height at which a pending transfer completes, from the chain's transfer-begin event; null when no transfer is pending.",
    },
  },

  application_services: {
    table: `One row per application and service the application is staked for. A row leaves the current list when a new stake drops the service, the application finishes unbonding, or it is transferred; ${HISTORY}`,
    columns: {
      id: "Application address and service id joined by '-'.",
      application_id: "The application's address (Application id).",
      service_id: "The service's id (Service id).",
    },
  },

  application_gateways: {
    table: `One row per application and gateway the application delegates to. A row leaves the current list on undelegation, when the application finishes unbonding or is transferred, or when the gateway finishes unbonding; ${HISTORY}`,
    columns: {
      id: "Application address and gateway address joined by '-'.",
      gateway_id: "The gateway's address (Gateway id).",
      application_id: "The application's address (Application id).",
    },
  },

  validators: {
    table: `One row per validator, keyed by operator address, re-synced from the chain's staking state every block. ${HISTORY}`,
    columns: {
      id: "Operator address (poktvaloper...).",
      ed25519_id: "Consensus address: uppercase hex of the first 20 bytes of the SHA-256 of the ed25519 consensus public key; matches blocks.proposer_address.",
      signer_id: "Address of the key that signed the creating transaction, with the poktvaloper prefix (Account id); equals id.",
      signer_pokt_prefix_id: "Account address (pokt prefix) of the same signing key (Account id).",
      delegator_id: "Not populated (null).",
      description: "JSON object with moniker, identity, website, securityContact and details, as the chain reports them.",
      commission: "JSON object with rate, maxRate and maxChangeRate as integer strings with 18 implied decimals (1000000000000000000 = 100%).",
      min_self_delegation: "Minimum self-delegation the validator requires, as the chain reports it.",
      stake_denom: "Denom of stake_amount.",
      stake_amount: "Validator tokens as the chain's staking module reports them, in upokt; 0 once the chain removes the validator.",
      stake_status: "StakeStatus from the chain's bond status: Staked (bonded), Unstaking (unbonding), Unstaked (unbonded, or removed from the chain).",
      delegator_shares: "Total shares issued to the validator's delegators, as an integer string of 18-decimal fixed point (value x 10^18). Null on rows not re-synced since the field was added.",
      transaction_id: "Hash of the transaction that created the validator (MsgCreateValidator, or the genesis transaction).",
      create_msg_id: "Id of the message that created the validator.",
    },
  },

  morse_claimable_accounts: {
    table: "One row per Morse account imported for migration to Shannon, with its claimable balances and claim state. A claim updates the row in place; earlier states are not kept.",
    columns: {
      id: "Morse address, lowercase hex.",
      msg_import_morse_claimable_accounts_id: "Id of the import message that loaded this account.",
      unstaked_balance_amount: "Liquid balance claimable on Shannon, in unstaked_balance_denom.",
      supplier_stake_amount: "Supplier (node) stake claimable on Shannon, in supplier_stake_denom; 0 if none.",
      application_stake_amount: "Application stake claimable on Shannon, in application_stake_denom; 0 if none.",
      morse_output_address: "Morse output (owner) address of a node/supplier account; null when the account has none.",
      unstaking_time: "UTC time after which the Morse node/supplier unbonding period has elapsed; null when not set.",
      shannon_dest_address: "Shannon address the claim went to (for a supplier claim, the owner address); null until claimed.",
      claimed_at_id: "Height of the block where the account was claimed; null until claimed.",
      claimed: "True once the account has been claimed (as account, application or supplier) or recovered.",
      transaction_id: "Hash of the claim transaction; null until claimed.",
      claimed_msg_id: "Id of the claim message (for a recovery, of the authz exec message that carried it); null until claimed.",
      unstaked_balance_denom: "Denom of unstaked_balance_amount; empty string when the account had no such balance.",
      supplier_stake_denom: "Denom of supplier_stake_amount; empty string when the account had no supplier stake.",
      application_stake_denom: "Denom of application_stake_amount; empty string when the account had no application stake.",
    },
  },
  delegations: {
    table: `One row per delegation (validator, delegator), as the chain's staking module holds it: the indexer reconciles them with the chain when a validator's delegator shares change and closes the row of a delegation that ended. ${HISTORY}`,
    columns: {
      id: "validator_operator-delegator.",
      validator_operator: "Operator address of the validator (poktvaloper...).",
      delegator: "Address of the delegating account.",
      shares: "Delegator shares as the chain's LegacyDec atomics (the shares times 10^18), a string.",
    },
  },
  module_accounts: {
    table: "The chain's module accounts as of genesis, one row per address (read once at the genesis height, not updated after); their balances are in balances.",
    columns: {
      id: "Module account address.",
      name: "Module name (bank, application, bonded_tokens_pool, ...).",
      account_number: "Account number at genesis.",
      sequence: "Sequence at genesis.",
      permissions: "Module permissions at genesis (minter, burner, staking), a JSON array.",
    },
  },
  authzs: {
    table: `One row per authz grant (granter, message type, grantee), from the grant message or, for a grant made outside a transaction, the grant event; a later grant of the same key replaces it. Revocations are not indexed: a revoked grant keeps its row. ${HISTORY}`,
    columns: {
      id: "granter:message type (without the leading slash)-grantee.",
      granter_id: "Granter address (Account id).",
      grantee_id: "Grantee address (Account id).",
      type: "Authorization type URL (/cosmos.authz.v1beta1.GenericAuthorization, ...); cosmos.authz.v1beta1.EventGrant when the grant came from an event, whose authorization the indexer does not see.",
      msg: "Type URL of the message the grant authorizes.",
      expiration: "When the grant expires, UTC; null when it has none or came from an event.",
      event_id: "Id of the grant event (Event id).",
      block_id: "Height of the grant (Block id).",
    },
  },
  block_metadata: {
    table: "One row per indexed block, keyed by height: its CometBFT block id, header and last commit as JSON, as the indexer received them.",
    columns: {
      id: "Block height.",
      block_id: "The block's CometBFT BlockID: hash and part set header (parts), JSON.",
      header: "The block's CometBFT header, JSON.",
      last_commit: "The block's last commit (the signatures of the previous block), JSON.",
    },
  },
};

// Tables or columns missing from the database are skipped (a schema migration can still be pending), and so are the
// comments that already say it: each COMMENT takes a lock on its table, and this runs on every start;
// entityDescriptions.spec.ts keeps the names honest against schema.graphql.
export function createEntityDescriptionsFn(dbSchema: string): string {
  const s = dbSchema;
  const q = (t: string) => `'${t.replace(/'/g, "''")}'`;
  const tables = Object.entries(ENTITY_DESCRIPTIONS)
    .map(([t, d]) => `(${q(t)}, ${q(d.table)})`)
    .join(", ");
  const columns = Object.entries(ENTITY_DESCRIPTIONS)
    .flatMap(([t, d]) => Object.entries(d.columns).map(([c, what]) => `(${q(t)}, ${q(c)}, ${q(what)})`))
    .join(", ");
  return `
DO $$
DECLARE r record; tags text;
BEGIN
  FOR r IN SELECT k.oid, k.oid::regclass t, d.what, obj_description(k.oid, 'pg_class') c FROM pg_class k
           JOIN (VALUES ${tables}) d(name, what) ON d.name = k.relname
           WHERE k.relnamespace = '${s}'::regnamespace AND k.relkind = 'r' LOOP
    -- the smart tag lines stay first, each relation deprecated once, and the description replaces whatever text
    -- followed them
    tags := (SELECT string_agg(CASE WHEN l ~ '^@foreignKey' AND l !~ '[|]@deprecated' THEN l || '|' || ${q(DEPRECATED_RELATION)}
                                    ELSE l END, E'\n' ORDER BY i)
             FROM unnest(string_to_array(coalesce(r.c, ''), E'\n')) WITH ORDINALITY u(l, i)
             WHERE l ~ '^@');
    IF r.c IS DISTINCT FROM coalesce(tags || E'\n', '') || r.what THEN
      EXECUTE format('COMMENT ON TABLE %s IS %L', r.t, coalesce(tags || E'\n', '') || r.what);
    END IF;
  END LOOP;
  FOR r IN SELECT format('%I.%I.%I', '${s}', d.tbl, d.col) target, d.what FROM (VALUES ${columns}) d(tbl, col, what)
           JOIN information_schema.columns c ON c.table_schema = '${s}' AND c.table_name = d.tbl AND c.column_name = d.col
           WHERE col_description(format('%I.%I', '${s}', d.tbl)::regclass, c.ordinal_position::int) IS DISTINCT FROM d.what LOOP
    EXECUTE format('COMMENT ON COLUMN %s IS %L', r.target, r.what);
  END LOOP;
END $$;
`;
}
