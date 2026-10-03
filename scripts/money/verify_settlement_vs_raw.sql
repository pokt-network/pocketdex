-- Read-only check: for every settlement height in [:from, :to], the settlement money tables must hold
-- exactly what the raw mod_to_acct_transfers table holds, per (recipient, role, family).
--
--   psql -v schema=mainnet -v from=950000 -v to=950200 -f scripts/money/verify_settlement_vs_raw.sql
--
-- Prints one row per height with the number of (recipient, role, family) keys and how many differ, followed by
-- the first differing keys (rows with an address). Plain CTEs, no temp tables: it runs in a read-only transaction. A height present in only one of the two sides shows up as all keys differing.
-- The raw table stores pocketdex's enum names; the mapping to the chain's op_reason is written out below.
\set ON_ERROR_STOP on
BEGIN READ ONLY;
SET LOCAL search_path = :schema;

WITH reason_map (raw, role, family) AS (VALUES
  ('TLM_RELAY_BURN_EQUALS_MINT_SUPPLIER_SHAREHOLDER_RD', 'rev_share', 'relay'),
  ('TLM_RELAY_BURN_EQUALS_MINT_DAO_REWARD_DISTRIBUTION', 'dao', 'relay'),
  ('TLM_RELAY_BURN_EQUALS_MINT_SOURCE_OWNER_RD', 'source_owner', 'relay'),
  ('TLM_RELAY_BURN_EQUALS_MINT_APPLICATION_RD', 'application', 'relay'),
  ('TLM_RELAY_BURN_EQUALS_MINT_VALIDATOR_RD', 'validator', 'relay'),
  ('TLM_RELAY_BURN_EQUALS_MINT_DELEGATOR_RD', 'delegator', 'relay'),
  ('TLM_GLOBAL_MINT_SUPPLIER_SHAREHOLDER_REWARD_DISTRIBUTION', 'rev_share', 'global'),
  ('TLM_GLOBAL_MINT_DAO_REWARD_DISTRIBUTION', 'dao', 'global'),
  ('TLM_GLOBAL_MINT_SOURCE_OWNER_REWARD_DISTRIBUTION', 'source_owner', 'global'),
  ('TLM_GLOBAL_MINT_APPLICATION_REWARD_DISTRIBUTION', 'application', 'global'),
  ('TLM_GLOBAL_MINT_VALIDATOR_REWARD_DISTRIBUTION', 'validator', 'global'),
  ('TLM_GLOBAL_MINT_DELEGATOR_REWARD_DISTRIBUTION', 'delegator', 'global'),
  ('TLM_GLOBAL_MINT_REIMBURSEMENT_REQUEST_ESCROW_DAO_TRANSFER', 'dao', 'reimb_escrow')
), raw AS (
  SELECT t.block_id::bigint AS height, t.recipient_id AS address, coalesce(m.role, 'UNMAPPED:' || t.op_reason::text) AS role,
         coalesce(m.family, '?') AS family, sum(t.amount)::numeric AS amount_upokt
  FROM mod_to_acct_transfers t LEFT JOIN reason_map m ON m.raw = t.op_reason::text
  WHERE t.block_id BETWEEN :from AND :to
  GROUP BY 1, 2, 3, 4
), b AS (
  SELECT height, address, role, family, sum(amount_upokt)::numeric AS amount_upokt
  FROM v_income_base WHERE height BETWEEN :from AND :to
  GROUP BY 1, 2, 3, 4
), cmp AS (
  SELECT coalesce(raw.height, b.height) AS height, coalesce(raw.address, b.address) AS address,
         coalesce(raw.role, b.role) AS role, coalesce(raw.family, b.family) AS family,
         raw.amount_upokt AS raw_amount, b.amount_upokt AS b_amount
  FROM raw FULL JOIN b USING (height, address, role, family)
)
SELECT height, count(*) AS keys, count(*) FILTER (WHERE raw_amount IS DISTINCT FROM b_amount) AS differing,
       NULL::text AS address, NULL::text AS role, NULL::text AS family, NULL::numeric AS raw_amount, NULL::numeric AS b_amount
FROM cmp GROUP BY height
UNION ALL
(SELECT height, NULL, NULL, address, role, family, raw_amount, b_amount
 FROM cmp WHERE raw_amount IS DISTINCT FROM b_amount ORDER BY height, address, role, family LIMIT 50)
ORDER BY height, address NULLS FIRST;
COMMIT;
