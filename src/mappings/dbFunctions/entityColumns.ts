// SubQuery (node-core 16) migrates the database schema only when the project deployment changes: redeploying the
// same project creates the tables of new entities but never adds a field added to an existing entity. Every such
// field is added here, at start, so a database indexed before it gets the column (2026-10-03: beta crash-looped on
// "column delegator_shares does not exist"). entityColumns.spec.ts fails when schema.graphql gains a field on an
// existing entity that is not listed here.
export const ADDED_ENTITY_COLUMNS: { entity: string; field: string; table: string; column: string; type: string }[] = [
  // settlement money layer, #96
  { entity: "Validator", field: "delegatorShares", table: "validators", column: "delegator_shares", type: "text" },
];

// The ALTER only runs when the column is missing: ALTER TABLE takes an ACCESS EXCLUSIVE lock even when IF NOT EXISTS
// makes it a no-op, and on every start it would queue the API's reads of the table behind any long query.
export function addEntityColumnsFn(dbSchema: string): string {
  return ADDED_ENTITY_COLUMNS.map(
    (c) => `DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = '${dbSchema}' AND table_name = '${c.table}' AND column_name = '${c.column}') THEN
    ALTER TABLE ${dbSchema}.${c.table} ADD COLUMN IF NOT EXISTS ${c.column} ${c.type};
  END IF;
END $$;`
  ).join("\n");
}
