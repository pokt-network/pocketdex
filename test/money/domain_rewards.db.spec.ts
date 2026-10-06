// refresh_domain_service_daily_rewards attributes each settled claim to the config its supplier had declared for
// the service at the claim's session start, not to the config live at the settlement block: a claim settled after
// the supplier unstaked, or after it restaked with other domains, keeps the domain it served.
//   MONEY_TEST_PG=postgres://postgres:postgres@127.0.0.1:5432/postgres yarn test:money
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import {
  createDomainServiceDailyRewardsTableFn,
  refreshDomainServiceDailyRewardsFn,
} from "../../src/mappings/dbFunctions/domainRewards";

interface PgClient {
  connect(): Promise<void>;
  end(): Promise<void>;
  query(sql: string, params?: unknown[]): Promise<{ rows: Record<string, string | null>[] }>;
}
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Client } = require("pg") as { Client: new (options: { connectionString?: string }) => PgClient };

const URL = process.env.MONEY_TEST_PG;
const S = "domain_rewards_ci";

describe("refresh_domain_service_daily_rewards (PostgreSQL)", { skip: !URL && "MONEY_TEST_PG not set" }, () => {
  const c = new Client({ connectionString: URL });

  before(async () => {
    await c.connect();
    await c.query("SET statement_timeout = '20s'");
    // as the indexer's role in pnf, not a superuser
    await c.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${S}_owner') THEN CREATE ROLE ${S}_owner NOSUPERUSER; END IF;
    END $$`);
    await c.query(
      `DROP SCHEMA IF EXISTS ${S} CASCADE; CREATE SCHEMA ${S} AUTHORIZATION ${S}_owner; SET ROLE ${S}_owner;`
    );
    await c.query(`
      CREATE TABLE ${S}.blocks (id numeric, timestamp timestamp);
      CREATE TABLE ${S}.event_claim_settleds (supplier_id text, service_id text, block_id numeric,
        session_start_height numeric, session_end_height numeric, num_relays numeric, num_estimated_relays numeric,
        num_claimed_computed_units numeric, num_estimated_computed_units numeric, claimed_amount numeric);
      CREATE TABLE ${S}.supplier_service_configs (_id uuid DEFAULT gen_random_uuid(), supplier_id text, service_id text,
        domains jsonb, _block_range int8range);
      CREATE TABLE ${S}.suppliers (id text, stake_status text, _block_range int8range);
      CREATE TABLE ${S}.params (namespace text, key text, value text, active_at numeric, _block_range int8range);`);
    await c.query(createDomainServiceDailyRewardsTableFn(S));
    await c.query(refreshDomainServiceDailyRewardsFn(S));
    // blocks 100..200 on 2026-10-01; sessions of 20 blocks (141..160 is one), the event omitting its start (0)
    await c.query(`
      INSERT INTO ${S}.blocks SELECT g, '2026-10-01 00:00'::timestamp + g * interval '1 minute' FROM generate_series(100, 200) g;
      INSERT INTO ${S}.params VALUES ('shared', 'num_blocks_per_session', '20', 1, int8range(1, NULL));
      INSERT INTO ${S}.suppliers VALUES
        ('unstaked', 'Staked', int8range(100, 150)), ('unstaked', 'Unstaking', int8range(150, NULL)),
        ('restaked', 'Staked', int8range(100, NULL)),
        ('at-start', 'Staked', int8range(100, 140)), ('at-start', 'Unstaking', int8range(140, NULL)),
        ('started', 'Staked', int8range(100, NULL)),
        ('first-block', 'Staked', int8range(100, NULL));
      INSERT INTO ${S}.supplier_service_configs (supplier_id, service_id, domains, _block_range) VALUES
        -- unstaked at 150, inside the session: the claim settles at 175 with no config open
        ('unstaked', 'akash', '["a.com"]', int8range(100, 150)),
        -- restaked at 165 with another domain, after the session
        ('restaked', 'akash', '["b.com"]', int8range(100, 165)),
        ('restaked', 'akash', '["c.com"]', int8range(165, NULL)),
        -- unstaked in the block before the session: no version covers 140, the latest one before it serves
        ('at-start', 'akash', '["d.com"]', int8range(100, 140)),
        -- the event carries its start (an older era): a version created inside the session does not serve it
        ('started', 'akash', '["e.com"]', int8range(100, 150)),
        ('started', 'akash', '["f.com"]', int8range(150, NULL)),
        -- restaked in the session's first block: the new config activates at the next session, the old one served
        ('first-block', 'akash', '["g.com"]', int8range(100, 141)),
        ('first-block', 'akash', '["h.com"]', int8range(141, NULL));
      INSERT INTO ${S}.event_claim_settleds VALUES
        ('unstaked', 'akash', 175, 0, 160, 1, 1, 10, 10, 1000),
        ('restaked', 'akash', 175, 0, 160, 2, 2, 20, 20, 2000),
        ('at-start', 'akash', 175, 0, 160, 4, 4, 40, 40, 4000),
        ('started', 'akash', 175, 141, 160, 8, 8, 80, 80, 8000),
        ('first-block', 'akash', 175, 0, 160, 16, 16, 160, 160, 16000);`);
    await c.query(`SELECT ${S}.refresh_domain_service_daily_rewards(175)`);
  });
  after(async () => {
    await c.query(`RESET ROLE; DROP SCHEMA IF EXISTS ${S} CASCADE`);
    await c.end();
  });

  it("attributes each claim to the config declared at its session start", async () => {
    const rows = (
      await c.query(
        `SELECT domain, service_id, relays::text, gross_rewards::text FROM ${S}.domain_service_daily_rewards
         WHERE day = '2026-10-01' ORDER BY domain`
      )
    ).rows;
    assert.deepEqual(rows, [
      { domain: "a.com", service_id: "akash", relays: "1", gross_rewards: "1000" },
      { domain: "b.com", service_id: "akash", relays: "2", gross_rewards: "2000" },
      { domain: "d.com", service_id: "akash", relays: "4", gross_rewards: "4000" },
      { domain: "e.com", service_id: "akash", relays: "8", gross_rewards: "8000" },
      { domain: "g.com", service_id: "akash", relays: "16", gross_rewards: "16000" },
    ]);
  });
});
