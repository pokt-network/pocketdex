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
    const genesisDomains = JSON.stringify(endpointDomains([{ url: "https://akash.node.d.com:443", rpcType: 3 }]));
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
        ('pre-block', 'Staked', int8range(100, NULL)), ('param-change', 'Staked', int8range(100, NULL)),
        ('empty', 'Staked', int8range(100, NULL)),
        ('restart', 'Staked', int8range(100, NULL)),
        ('then-domain', 'Staked', int8range(100, NULL)), ('long-gap', 'Staked', int8range(100, NULL)),
        ('null-domains', 'Staked', int8range(100, NULL));
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
        ('param-change', 'akash', '["p.com"]', int8range(150, NULL)),
        -- the version live before the session has no domain (no endpoint URL parsed): it credits none, not the
        -- domain of another version
        ('empty', 'akash', '["q.com"]', int8range(100, 130)),
        ('empty', 'akash', '[]', int8range(130, NULL)),
        -- a gap before the session, then a version from its first block (which activates at the next session): the
        -- one that ended before the session serves it
        ('restart', 'akash', '["r.com"]', int8range(100, 130)),
        ('restart', 'akash', '["s.com"]', int8range(141, NULL)),
        -- no parseable endpoint, then a restake with a domain after the session: the session's version has none
        ('then-domain', 'akash', '[]', int8range(100, 150)),
        ('then-domain', 'akash', '["t.com"]', int8range(150, NULL)),
        -- an old domain, a long gap, then a version with none before the session: none, not the old one
        ('long-gap', 'akash', '["w.com"]', int8range(100, 101)),
        ('long-gap', 'akash', '[]', int8range(135, NULL)),
        -- a version whose domains were never written (NULL), with an older one that had some: none
        ('null-domains', 'akash', '["x.com"]', int8range(100, 120)),
        ('null-domains', 'akash', NULL, int8range(120, NULL));
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
        ('param-change', 'akash', 175, 0, 160, 512, 512, 5120, 5120, 512000),
        ('empty', 'akash', 175, 0, 160, 1024, 1024, 10240, 10240, 1024000),
        ('restart', 'akash', 175, 0, 160, 2048, 2048, 20480, 20480, 2048000),
        ('then-domain', 'akash', 175, 0, 160, 4096, 4096, 40960, 40960, 4096000),
        ('long-gap', 'akash', 175, 0, 160, 8192, 8192, 81920, 81920, 8192000),
        ('null-domains', 'akash', 175, 0, 160, 16384, 16384, 163840, 163840, 16384000);`
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
      { domain: "r.com", service_id: "akash", relays: "2048", gross_rewards: "2048000" },
    ]);
  });

  // A second day, 2026-10-02 (blocks 1500..1600), settled at 1520, 1540, 1560 and 1580: the indexer's calls add each
  // block to the day, which must equal rebuilding the day from its claims, column by column.
  describe("each settlement block added to its day", () => {
    const DAY = "2026-10-02";
    const rows = async () =>
      (
        await c.query(
          `SELECT domain, service_id, relays::text, estimated_relays::text, computed_units::text,
                  estimated_computed_units::text, gross_rewards::text, suppliers_count::text,
                  first_height::text, last_height::text
           FROM ${S}.domain_service_daily_rewards WHERE day = '${DAY}' ORDER BY domain, service_id`
        )
      ).rows;
    const refresh = async (...heights: number[]) => {
      for (const h of heights) await c.query(`SELECT ${S}.refresh_domain_service_daily_rewards(${h})`);
    };
    // the day rebuilt from its claims: a call for a block the day already holds
    const rebuilt = async (head: number) => {
      await refresh(head);
      return rows();
    };
    const claim = (supplier: string, service: string, block: number, relays: number) =>
      `('${supplier}', '${service}', ${block}, ${block - 15}, ${block - 6}, ${relays}, ${relays + 1}, ${relays * 10},
        ${relays * 10 + 1}, ${relays * 1000})`;
    // the claims settled at each block
    const settled: Record<number, string[]> = {
      1520: [claim("d1", "akash", 1520, 1), claim("d2", "akash", 1520, 2), claim("d1", "eth", 1520, 4)],
      1540: [claim("d1", "akash", 1540, 8), claim("d3", "akash", 1540, 16)],
      // d2's claim is under c.org (its config from 1530); d4 is staked from 1550 and has no config before it (its
      // earliest serves): the a.org row of 1520 counts it from then on
      1560: [claim("d2", "akash", 1560, 32), claim("d4", "akash", 1560, 64)],
      1580: [claim("d3", "akash", 1580, 128), claim("d1", "eth", 1580, 256), claim("d5", "akash", 1580, 512)],
    };
    const settle = (block: number) =>
      c.query(`INSERT INTO ${S}.event_claim_settleds VALUES ${settled[block].join(", ")}`);
    const blocks = (from: number, to: number) =>
      c.query(`INSERT INTO ${S}.blocks SELECT g, '2026-10-01 00:00'::timestamp + g * interval '1 minute'
               FROM generate_series(${from}, ${to}) g`);
    // SubQuery's rewind: the blocks above the height and the claims they settled are gone, this table is not touched
    const rewind = (height: number) =>
      c.query(
        `DELETE FROM ${S}.blocks WHERE id > ${height}; DELETE FROM ${S}.event_claim_settleds WHERE block_id > ${height}`
      );

    before(async () => {
      await c.query(`
        INSERT INTO ${S}.suppliers VALUES ('d1', 'Staked', int8range(1400, NULL)), ('d2', 'Staked', int8range(1400, NULL)),
          ('d3', 'Staked', int8range(1400, 1530)), ('d3', 'Unstaking', int8range(1530, NULL)),
          ('d4', 'Staked', int8range(1550, NULL)), ('d5', 'Staked', int8range(1400, NULL));
        INSERT INTO ${S}.supplier_service_configs (supplier_id, service_id, domains, _block_range) VALUES
          ('d1', 'akash', '["a.org", "b.org"]', int8range(1400, NULL)),
          ('d1', 'eth', '["a.org"]', int8range(1400, NULL)),
          ('d2', 'akash', '["a.org"]', int8range(1400, 1530)),
          ('d2', 'akash', '["c.org"]', int8range(1530, NULL)),
          ('d3', 'akash', '["b.org"]', int8range(1400, 1530)),
          ('d4', 'akash', '["a.org"]', int8range(1550, NULL)),
          -- no domain: its claims credit none
          ('d5', 'akash', '[]', int8range(1400, NULL));`);
    });

    it("equals the day rebuilt from its claims after every block, with each row's settlement heights", async () => {
      await blocks(1500, 1520);
      await settle(1520);
      await refresh(1520);
      for (const [to, block] of [
        [1540, 1540],
        [1560, 1560],
        [1580, 1580],
      ]) {
        await blocks(block - 19, to);
        await settle(block);
        await refresh(block);
        const added = await rows();
        assert.deepEqual(await rebuilt(block), added, `after ${block}`);
      }
      assert.deepEqual(await rows(), [
        {
          domain: "a.org",
          service_id: "akash",
          relays: "75",
          estimated_relays: "79",
          computed_units: "750",
          estimated_computed_units: "754",
          gross_rewards: "75000",
          suppliers_count: "3",
          first_height: "1520",
          last_height: "1560",
        },
        {
          domain: "a.org",
          service_id: "eth",
          relays: "260",
          estimated_relays: "262",
          computed_units: "2600",
          estimated_computed_units: "2602",
          gross_rewards: "260000",
          suppliers_count: "1",
          first_height: "1520",
          last_height: "1580",
        },
        {
          domain: "b.org",
          service_id: "akash",
          relays: "153",
          estimated_relays: "157",
          computed_units: "1530",
          estimated_computed_units: "1534",
          gross_rewards: "153000",
          suppliers_count: "2",
          first_height: "1520",
          last_height: "1580",
        },
        {
          domain: "c.org",
          service_id: "akash",
          relays: "32",
          estimated_relays: "33",
          computed_units: "320",
          estimated_computed_units: "321",
          gross_rewards: "32000",
          suppliers_count: "1",
          first_height: "1560",
          last_height: "1560",
        },
      ]);
    });

    it("adds only the block's claims while the day holds every earlier settlement block", async () => {
      await c.query("BEGIN");
      try {
        // a mark on a row: a block added to the day keeps it, a rebuild would drop it
        await c.query(`UPDATE ${S}.domain_service_daily_rewards SET relays = relays + 1000000
                       WHERE day = '${DAY}' AND domain = 'c.org'`);
        await blocks(1581, 1600);
        await c.query(`INSERT INTO ${S}.event_claim_settleds VALUES ${claim("d2", "akash", 1600, 1024)}`);
        await refresh(1600);
        const r = (await rows()).find((x) => x.domain === "c.org");
        assert.equal(r?.relays, String(32 + 1024 + 1000000));
        assert.equal(r?.last_height, "1600");
      } finally {
        await c.query("ROLLBACK");
      }
    });

    it("rebuilds the day when it holds a later block, as after a rewind", async () => {
      const before = await rows();
      await c.query("BEGIN");
      try {
        // rewound to 1550 and indexed again: 1560 finds the day holding 1580, rebuilds it to 1560, then adds 1580
        await rewind(1550);
        await blocks(1551, 1560);
        await settle(1560);
        await refresh(1560);
        assert.equal((await rows()).find((x) => x.domain === "a.org" && x.service_id === "eth")?.last_height, "1520");
        await blocks(1561, 1580);
        await settle(1580);
        await refresh(1580);
        assert.deepEqual(await rows(), before);
      } finally {
        await c.query("ROLLBACK");
      }
    });

    it("rebuilds the day when a claim settled after its last height, or a row has no heights", async () => {
      const before = await rows();
      await c.query("BEGIN");
      try {
        // 1580's claims never added (an image without the incremental refresh): 1600 rebuilds the day
        await c.query(`UPDATE ${S}.domain_service_daily_rewards t SET relays = t.relays - x.relays, last_height = 1560
          FROM (VALUES ('a.org', 'eth', 256), ('b.org', 'akash', 128)) x(domain, service_id, relays)
          WHERE t.day = '${DAY}' AND t.domain = x.domain AND t.service_id = x.service_id`);
        await blocks(1581, 1600);
        await refresh(1600);
        assert.deepEqual(await rows(), before);
        // rows written before the height columns: rebuilt
        await c.query(`UPDATE ${S}.domain_service_daily_rewards SET relays = 0, first_height = NULL, last_height = NULL
                       WHERE day = '${DAY}'`);
        await c.query(`INSERT INTO ${S}.event_claim_settleds VALUES ${claim("d1", "eth", 1600, 2048)}`);
        await refresh(1600);
        const r = (await rows()).find((x) => x.domain === "a.org" && x.service_id === "eth");
        assert.equal(r?.relays, String(260 + 2048));
        assert.deepEqual(
          (await rows()).map((x) => [x.domain, x.service_id, x.relays]),
          [
            ["a.org", "akash", "75"],
            ["a.org", "eth", "2308"],
            ["b.org", "akash", "153"],
            ["c.org", "akash", "32"],
          ]
        );
      } finally {
        await c.query("ROLLBACK");
      }
    });
  });

  it("without the session length, a claim is attributed at its settlement block", async () => {
    await c.query("BEGIN");
    try {
      await c.query(`TRUNCATE ${S}.params; SELECT ${S}.refresh_domain_service_daily_rewards(175)`);
      const r = (
        await c.query(`SELECT sum(relays)::text relays FROM ${S}.domain_service_daily_rewards WHERE day = '2026-10-01'`)
      ).rows[0];
      // every claim whose version at the settlement block has a domain: all but 1024 ([]), 8192 ([]) and
      // 16384 (NULL); 4096 is now under its restake's t.com
      assert.equal(r.relays, "7167");
    } finally {
      await c.query("ROLLBACK");
    }
  });
});
