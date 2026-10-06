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
import { endpointDomains } from "../../src/mappings/utils/service_config_history";

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
    // the genesis config's domains, as genesis derives them from its endpoints
    const genesisDomains = JSON.stringify(endpointDomains(["https://akash.node.d.com:443"]));
    await c.query(createDomainServiceDailyRewardsTableFn(S));
    await c.query(refreshDomainServiceDailyRewardsFn(S));
    // blocks 100..200 on 2026-10-01; sessions of 20 blocks (141..160 is one), the event omitting its start (0)
    await c.query(
      `
      INSERT INTO ${S}.blocks SELECT g, '2026-10-01 00:00'::timestamp + g * interval '1 minute' FROM generate_series(100, 200) g;
      -- a change to 10 made at 155, inside the session, in force from the next session (active_at 161): the session
      -- that ends at 160 still has 20 blocks
      INSERT INTO ${S}.params VALUES ('shared', 'num_blocks_per_session', '20', 1, int8range(1, 155)),
        ('shared', 'num_blocks_per_session', '10', 161, int8range(155, NULL));
      INSERT INTO ${S}.suppliers VALUES
        ('unstaked', 'Staked', int8range(100, 150)), ('unstaked', 'Unstaking', int8range(150, NULL)),
        ('restaked', 'Staked', int8range(100, NULL)),
        ('dup', 'Staked', int8range(100, NULL)),
        ('no-heights', 'Staked', int8range(100, NULL)),
        ('started', 'Staked', int8range(100, NULL)),
        ('first-block', 'Staked', int8range(100, NULL)),
        ('genesis', 'Staked', int8range(141, NULL)), ('late', 'Staked', int8range(100, NULL)),
        ('pre-block', 'Staked', int8range(100, NULL)), ('param-change', 'Staked', int8range(100, NULL));
      INSERT INTO ${S}.supplier_service_configs (supplier_id, service_id, domains, _block_range) VALUES
        -- unstaked at 150, inside the session: the claim settles at 175 with no config open
        ('unstaked', 'akash', '["a.com"]', int8range(100, 150)),
        -- restaked at 165 with another domain, after the session
        ('restaked', 'akash', '["b.com"]', int8range(100, 165)),
        ('restaked', 'akash', '["c.com"]', int8range(165, NULL)),
        -- an id the index still holds twice: one row serves the claim, the latest
        ('dup', 'akash', '["i.com"]', int8range(100, NULL)),
        ('dup', 'akash', '["k.com"]', int8range(120, NULL)),
        -- a claim with no session heights: the config live at the settlement block
        ('no-heights', 'akash', '["j.com"]', int8range(100, NULL)),
        -- the event carries its start (an older era): a version created inside the session does not serve it
        ('started', 'akash', '["e.com"]', int8range(100, 150)),
        ('started', 'akash', '["f.com"]', int8range(150, NULL)),
        -- restaked in the session's first block: the new config activates at the next session, the old one served
        ('first-block', 'akash', '["g.com"]', int8range(100, 141)),
        ('first-block', 'akash', '["h.com"]', int8range(141, NULL)),
        -- written at the session's start, as genesis writes its configs at the first session (domains as genesis
        -- derives them): no version before it
        ('genesis', 'akash', '${genesisDomains}'::jsonb, int8range(141, NULL)),
        -- nothing at or before the session start (a config the index lost before it): the earliest one serves
        ('late', 'akash', '["l.com"]', int8range(150, NULL)),
        -- staked in the block before the session: its config activates at the session start and serves it
        ('pre-block', 'akash', '["m.com"]', int8range(100, 140)),
        ('pre-block', 'akash', '["n.com"]', int8range(140, NULL)),
        -- the 20-block session starts at 141; with the change's 10 it would start at 151, under p.com
        ('param-change', 'akash', '["o.com"]', int8range(100, 150)),
        ('param-change', 'akash', '["p.com"]', int8range(150, NULL));
      INSERT INTO ${S}.event_claim_settleds VALUES
        ('unstaked', 'akash', 175, 0, 160, 1, 1, 10, 10, 1000),
        ('restaked', 'akash', 175, 0, 160, 2, 2, 20, 20, 2000),
        ('dup', 'akash', 175, 0, 160, 32, 32, 320, 320, 32000),
        ('no-heights', 'akash', 175, 0, 0, 64, 64, 640, 640, 64000),
        ('started', 'akash', 175, 141, 160, 8, 8, 80, 80, 8000),
        ('first-block', 'akash', 175, 0, 160, 16, 16, 160, 160, 16000),
        ('genesis', 'akash', 175, 0, 160, 4, 4, 40, 40, 4000),
        ('late', 'akash', 175, 0, 160, 128, 128, 1280, 1280, 128000),
        ('pre-block', 'akash', 175, 0, 160, 256, 256, 2560, 2560, 256000),
        ('param-change', 'akash', 175, 0, 160, 512, 512, 5120, 5120, 512000);`
    );
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
      { domain: "j.com", service_id: "akash", relays: "64", gross_rewards: "64000" },
      { domain: "k.com", service_id: "akash", relays: "32", gross_rewards: "32000" },
      { domain: "l.com", service_id: "akash", relays: "128", gross_rewards: "128000" },
      { domain: "n.com", service_id: "akash", relays: "256", gross_rewards: "256000" },
      { domain: "o.com", service_id: "akash", relays: "512", gross_rewards: "512000" },
    ]);
  });

  it("without the session length, a claim is attributed at its settlement block, never dropped", async () => {
    await c.query("BEGIN");
    try {
      await c.query(`TRUNCATE ${S}.params; SELECT ${S}.refresh_domain_service_daily_rewards(175)`);
      const r = (
        await c.query(`SELECT sum(relays)::text relays FROM ${S}.domain_service_daily_rewards WHERE day = '2026-10-01'`)
      ).rows[0];
      // every claim is still there: 1 + 2 + 4 + 8 + 16 + 32 + 64 + 128 + 256 + 512
      assert.equal(r.relays, "1023");
    } finally {
      await c.query("ROLLBACK");
    }
  });
});
