// Unit test: indexSupplier writes SupplierServiceConfig rows as the chain orders the block (BeginBlock
// activations, then txs) and keeps one open row per id, against fake SubQuery globals (logger, store).
// Run with
//   yarn test:unit
//
// The fake store keeps an in-memory versioned table per model. It does not evaluate Sequelize predicates:
// it reads only the shapes this handler sends and applies their meaning by hand, so a change to those
// shapes needs this fake changed too:
//   destroy  lower(_block_range) = height, optionally AND id IN (...)  -> drop the rows created at height
//   update   id IN (...) AND __block_range @> height                  -> close those open rows at height
//            any other update: a MorseClaimableAccount one records its shannon_dest_address, the rest are ignored
//   bulkCreate                                                        -> insert at [height, null)
//   getByFields [field, "in", values]                                 -> the rows open at height
// Every destroy, update and bulkCreate must carry the block transaction (BLOCK_TX).
/* eslint-disable @typescript-eslint/no-floating-promises, @typescript-eslint/require-await, @typescript-eslint/no-var-requires */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CosmosEvent, CosmosMessage } from "@subql/types-cosmos";

// lo = hi = null is Postgres' 'empty' range: int8range(h, h) when a row created at h is closed at h
type Row = Record<string, unknown> & { lo: number | null; hi: number | null };

const tables: Record<string, Array<Row>> = {};
// Morse address -> the shannon_dest_address a claim wrote for it
const morseDestinations: Record<string, unknown> = {};
let height = 0;

const openAt = (row: Row, block: number) => row.lo !== null && row.lo <= block && (row.hi === null || block < row.hi);

// the raw queries the handler sends (supplier_rev_share_wallets), with their bind values and transaction
const queries: Array<{ sql: string; bind: Array<unknown>; transaction: unknown }> = [];

const sequelize = {
  query: async (sql: string, { bind, transaction }: { bind: Array<unknown>; transaction: unknown }) => {
    queries.push({ sql, bind, transaction });
  },
  fn: (fn: string, ...args: Array<unknown>) => ({ fn, args }),
  col: (col: string) => ({ col }),
  where: (left: unknown, right: unknown) => ({ left, right }),
};

const BLOCK_TX = { block: "transaction" };
const inBlockTx = (transaction: unknown) => assert.equal(transaction, BLOCK_TX, "a write outside the block transaction");

type IdIn = { id: Record<symbol, Array<string>> };

const model = (name: string) => {
  tables[name] = tables[name] || [];
  return {
    sequelize,
    destroy: async ({ transaction, where }: { where: Record<symbol, [unknown, IdIn]>; transaction: unknown }) => {
      inBlockTx(transaction);
      const and = where[Symbol.for("and")];
      const ids = and ? and[1].id[Symbol.for("in")] : null;
      tables[name] = tables[name].filter(
        (row) => row.lo !== height || (ids !== null && !ids.includes(row.id as string))
      );
    },
    update: async (values: Record<string, unknown>, { transaction, where }: { where: IdIn & { __block_range?: unknown }; transaction: unknown }) => {
      inBlockTx(transaction);
      if (!where.__block_range) {
        if (name === "MorseClaimableAccount") morseDestinations[where.id as unknown as string] = values.shannon_dest_address;
        return;
      }
      const ids = where.id[Symbol.for("in")];
      for (const row of tables[name]) {
        if (!ids.includes(row.id as string) || !openAt(row, height)) continue;
        if (row.lo === height) row.lo = null;
        // int8range(h, h) is empty
        else row.hi = height;
      }
    },
    bulkCreate: async (docs: Array<Record<string, unknown>>, { transaction }: { transaction: unknown }) => {
      inBlockTx(transaction);
      for (const { __block_range, ...doc } of docs) {
        const [lo, hi] = __block_range as [number, number | null];
        tables[name].push({ ...doc, lo: Number(lo), hi });
      }
    },
  };
};

const globals = globalThis as Record<string, unknown>;
const warnings: Array<string> = [];
globals.logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: (message: string) => warnings.push(message),
  error: () => undefined,
};
globals.store = {
  context: { getHistoricalUnit: () => height, transaction: BLOCK_TX },
  modelProvider: { getModel: (name: string) => ({ model: model(name) }) },
  getByFields: async (
    name: string,
    filter: Array<[string, string, Array<string>]>,
    { limit, offset }: { limit: number; offset: number }
  ) => {
    const [[field, , values]] = filter;
    return (tables[name] || [])
      .filter((row) => openAt(row, height) && values.includes(row[field] as string))
      .slice(offset, offset + limit)
      .map((row) => ({ ...row })); // bulkCreate overwrites lo/hi of a row saved again
  },
};

const { indexSupplier } = require("./suppliers") as typeof import("./suppliers");
const { Ed25519, pubKeyToAddress } = require("../utils/pub_key") as typeof import("../utils/pub_key");

const S1 = "pokt139eww6ul8dxcfvgp9z5xtnnhc2n30vnka6pm3p";
const S2 = "pokt1xgjlnqqmrmc7v2hp0sc6xx46lr7z4y6j406ue9";
const block = (h: number, chainId = "pocket") => ({ block: { header: { height: h, chainId } } });

const stake = (h: number, operator: string, services: Array<string>, txIdx = 0): CosmosMessage =>
  ({
    idx: 0,
    block: block(h),
    tx: { hash: `STAKE${h}${operator}`, idx: txIdx, tx: { code: 0, events: [] } },
    msg: {
      typeUrl: "/pocket.supplier.MsgStakeSupplier",
      decodedMsg: {
        operatorAddress: operator,
        ownerAddress: operator,
        signer: operator,
        stake: { amount: "60000000000", denom: "upokt" },
        services: services.map((serviceId) => ({ serviceId, endpoints: [], revShare: [] })),
      },
    },
  } as unknown as CosmosMessage);

const unstake = (h: number, operator: string): CosmosMessage =>
  ({
    idx: 0,
    block: block(h),
    tx: { hash: `UNSTAKE${h}${operator}`, idx: 0, tx: { code: 0, events: [] } },
    msg: {
      typeUrl: "/pocket.supplier.MsgUnstakeSupplier",
      decodedMsg: { operatorAddress: operator, signer: operator },
    },
  } as unknown as CosmosMessage);

const activation = (h: number, idx: number, attributes: Array<{ key: string; value: string }>): CosmosEvent =>
  ({
    idx,
    kind: "finalize_block",
    block: block(h),
    event: {
      type: "pocket.supplier.EventSupplierServiceConfigActivated",
      attributes: [{ key: "activation_height", value: `"${h}"` }, ...attributes, { key: "mode", value: "BeginBlock" }],
    },
  } as unknown as CosmosEvent);

// Since v0.1.27: one event per service, as in block_results of mainnet 947061 and 947081.
const activations = (h: number, operator: string, services: Array<string>): Array<CosmosEvent> =>
  services.map((serviceId, i) =>
    activation(h, 100 + i, [
      { key: "operator_address", value: `"${operator}"` },
      { key: "service_id", value: `"${serviceId}"` },
    ])
  );

// Before v0.1.27: one event per supplier, carrying the supplier (with its service_config_history) and no
// service_id, as in block_results of mainnet 247741.
const legacyActivation = (h: number, operator: string, history: Array<[string, number, number?]>): CosmosEvent =>
  activation(h, 100, [
    {
      key: "supplier",
      value: JSON.stringify({
        operator_address: operator,
        service_config_history: history.map(([service_id, activation_height, deactivation_height = 0]) => ({
          service: { service_id },
          activation_height: `${activation_height}`,
          deactivation_height: `${deactivation_height}`,
        })),
      }),
    },
  ]);

const unbondingEnd = (h: number, operator: string): CosmosEvent =>
  ({
    idx: 900,
    kind: "finalize_block",
    block: block(h),
    event: {
      type: "pocket.supplier.EventSupplierUnbondingEnd",
      attributes: [
        { key: "operator_address", value: `"${operator}"` },
        { key: "unbonding_end_height", value: `"${h}"` },
        { key: "session_end_height", value: `"${h}"` },
        { key: "mode", value: "EndBlock" },
      ],
    },
  } as unknown as CosmosEvent);

// EventSupplierUnbondingBegin as the chain emits it: the reason as its quoted enum name in every era (block_results
// of mainnet 96850 and 461853, beta 23673 and 482553). BELOW_MIN_STAKE comes from the EndBlock settlement;
// MIGRATION from a Morse claim's tx (mainnet 99160).
const unbondingBegin = (h: number, operator: string, reason: "BELOW_MIN_STAKE" | "MIGRATION"): CosmosEvent =>
  ({
    idx: 800,
    kind: reason === "BELOW_MIN_STAKE" ? "finalize_block" : "tx",
    block: block(h),
    ...(reason === "MIGRATION" && { tx: { hash: `MIGRATION${h}${operator}`, idx: 0, tx: { code: 0, events: [] } } }),
    event: {
      type: "pocket.supplier.EventSupplierUnbondingBegin",
      attributes: [
        { key: "reason", value: `"SUPPLIER_UNBONDING_REASON_${reason}"` },
        { key: "session_end_height", value: `"${h}"` },
        { key: "supplier", value: JSON.stringify({ operator_address: operator }) },
        { key: "unbonding_end_height", value: `"${h + 100}"` },
        ...(reason === "BELOW_MIN_STAKE" ? [{ key: "mode", value: "EndBlock" }] : []),
      ],
    },
  } as unknown as CosmosEvent);

const claimMorse = (h: number, operator: string, services: Array<string>, unbondingEnded = false): CosmosMessage =>
  ({
    idx: 0,
    block: block(h),
    tx: {
      hash: `CLAIM${h}${operator}`,
      idx: 0,
      tx: {
        code: 0,
        events: [
          {
            type: "pocket.migration.EventMorseSupplierClaimed",
            attributes: [
              { key: "claimed_balance", value: '"1000upokt"' },
              { key: "claimed_supplier_stake", value: '"60000000000upokt"' },
            ],
          },
          ...(unbondingEnded
            ? [
                {
                  type: "pocket.supplier.EventSupplierUnbondingEnd",
                  attributes: [{ key: "operator_address", value: `"${operator}"` }],
                },
              ]
            : []),
        ],
      },
    },
    msg: {
      typeUrl: "/pocket.migration.MsgClaimMorseSupplier",
      decodedMsg: {
        shannonOperatorAddress: operator,
        shannonOwnerAddress: operator,
        shannonSigningAddress: operator,
        morsePublicKey: new Uint8Array(32).fill(7),
        morseSignature: new Uint8Array(64),
        morseNodeAddress: "",
        signerIsOutputAddress: false,
        services: services.map((serviceId) => ({ serviceId, endpoints: [], revShare: [] })),
      },
    },
  } as unknown as CosmosMessage);

// the EventSupplierUnbondingEnd a Morse claim emits in its own tx when it stakes nothing
const claimUnbondingEnd = (claim: CosmosMessage, operator: string): CosmosEvent =>
  ({
    idx: 1,
    kind: "tx",
    block: claim.block,
    tx: claim.tx,
    event: {
      type: "pocket.supplier.EventSupplierUnbondingEnd",
      attributes: [
        { key: "operator_address", value: `"${operator}"` },
        { key: "reason", value: '"SUPPLIER_UNBONDING_REASON_MIGRATION"' },
      ],
    },
  } as unknown as CosmosEvent);

const supplierStatus = (operator: string) =>
  (tables.Supplier || []).find((row) => row.id === operator && openAt(row, height))?.stakeStatus;

const index = async (h: number, msgs: Array<CosmosMessage>, events: Array<CosmosEvent>) => {
  height = h;
  const msgByType: Record<string, Array<CosmosMessage>> = {
    "/pocket.supplier.MsgUnstakeSupplier": [],
    "/pocket.migration.MsgClaimMorseSupplier": [],
    "/pocket.supplier.MsgStakeSupplier": [],
  };
  const eventByType: Record<string, Array<CosmosEvent>> = {
    "pocket.supplier.EventSupplierUnbondingBegin": [],
    "pocket.supplier.EventSupplierUnbondingEnd": [],
    "pocket.supplier.EventSupplierServiceConfigActivated": [],
    "pocket.tokenomics.EventSupplierSlashed": [],
  };
  for (const msg of msgs) msgByType[msg.msg.typeUrl].push(msg);
  for (const event of events) eventByType[event.event.type].push(event);
  await indexSupplier(msgByType as never, eventByType as never);
};

const configs = (operator: string) => (tables.SupplierServiceConfig || []).filter((row) => row.supplierId === operator);

// the configs open at the current height, as "<service>@<activatedAt>"
const open = (operator: string) =>
  configs(operator)
    .filter((row) => openAt(row, height))
    .map((row) => `${row.serviceId}@${row.activatedAtId ?? "-"}`)
    .sort();

// every row of one config, as [from, to, activatedAt]
const history = (operator: string, serviceId: string) =>
  configs(operator)
    .filter((row) => row.serviceId === serviceId)
    .map((row) => [row.lo, row.hi, row.activatedAtId === undefined ? null : Number(row.activatedAtId)]);

const reset = () => {
  for (const name of Object.keys(tables)) delete tables[name];
  for (const id of Object.keys(morseDestinations)) delete morseDestinations[id];
};

describe("indexSupplier service configs", () => {
  it("a stake in the block where the previous stake activates waits for its own activation (mainnet 947060/61/81)", async () => {
    reset();
    await index(947060, [stake(947060, S1, ["akash", "eth"])], []);

    // the BeginBlock activation of the 947060 stake, then a new stake in tx 0 of the same block
    await index(947061, [stake(947061, S1, ["akash", "eth"])], activations(947061, S1, ["akash", "eth"]));
    assert.deepEqual(open(S1), ["akash@-", "eth@-"]);

    // the activation of the 947061 stake, one session later
    await index(947081, [], activations(947081, S1, ["akash", "eth"]));
    assert.deepEqual(open(S1), ["akash@947081", "eth@947081"]);
    assert.deepEqual(history(S1, "akash"), [
      [947060, 947061, null],
      [947061, 947081, null],
      [947081, null, 947081],
    ]);
  });

  it("stake, activation, restake that changes services, activation, unstake", async () => {
    reset();
    await index(100, [stake(100, S1, ["akash", "eth"])], []);
    assert.deepEqual(open(S1), ["akash@-", "eth@-"]);

    await index(120, [], activations(120, S1, ["akash", "eth"]));
    assert.deepEqual(open(S1), ["akash@120", "eth@120"]);

    await index(130, [stake(130, S1, ["akash", "base"])], []);
    assert.deepEqual(open(S1), ["akash@-", "base@-"]);
    assert.deepEqual(history(S1, "eth"), [
      [100, 120, null],
      [120, 130, 120],
    ]);

    await index(140, [], activations(140, S1, ["akash", "base"]));
    assert.deepEqual(open(S1), ["akash@140", "base@140"]);

    // the unstake withdraws what the supplier declared
    await index(150, [unstake(150, S1)], []);
    assert.deepEqual(open(S1), []);
    assert.equal(supplierStatus(S1), "Unstaking");
  });

  it("an activation carrying service_id activates that service only; one without it, the services its history activates", async () => {
    reset();
    await index(100, [stake(100, S1, ["akash", "eth"])], []);

    await index(120, [], activations(120, S1, ["akash"]));
    assert.deepEqual(open(S1), ["akash@120", "eth@-"]);

    await index(
      140,
      [],
      [
        legacyActivation(140, S1, [
          ["akash", 120],
          ["eth", 140],
        ]),
      ]
    );
    assert.deepEqual(open(S1), ["akash@120", "eth@140"]);
  });

  it("processing the same block twice leaves the same rows", async () => {
    reset();
    await index(190, [stake(190, S1, ["akash", "eth"])], []);

    // S1 activates and S2 stakes in the same block, so the block deletes and re-inserts S2's configs only
    const block200 = () => index(200, [stake(200, S2, ["akash"])], activations(200, S1, ["akash", "eth"]));
    await block200();
    const once = JSON.stringify([open(S1), open(S2), configs(S1).length, configs(S2).length]);
    await block200();

    assert.equal(JSON.stringify([open(S1), open(S2), configs(S1).length, configs(S2).length]), once);
    assert.deepEqual(open(S1), ["akash@200", "eth@200"]);
    assert.deepEqual(open(S2), ["akash@-"]);
  });
  it("the unstake closes the supplier's configs, and the end of the unbonding finds none left", async () => {
    reset();
    await index(100, [stake(100, S1, ["akash", "eth"])], []);
    await index(120, [], activations(120, S1, ["akash", "eth"]));
    await index(150, [unstake(150, S1)], []);
    assert.deepEqual(open(S1), []);

    await index(200, [], [unbondingEnd(200, S1)]);
    assert.deepEqual(open(S1), []);
    assert.equal(supplierStatus(S1), "Unstaked");
    assert.deepEqual(history(S1, "akash"), [
      [100, 120, null],
      [120, 150, 120],
    ]);
  });

  it("the end of the unbonding closes configs still open (rows indexed before the unstake closed them)", async () => {
    reset();
    await index(100, [stake(100, S1, ["akash"])], []);
    await index(120, [], activations(120, S1, ["akash"]));
    // the supplier row as an older index left it: Unstaking with its config open
    await index(150, [unstake(150, S1)], []);
    tables.SupplierServiceConfig.push({ id: `${S1}-akash`, supplierId: S1, serviceId: "akash", lo: 150, hi: null });

    await index(200, [], [unbondingEnd(200, S1)]);
    assert.deepEqual(open(S1), []);
  });

  it("a restake during the unbonding declares its services again", async () => {
    reset();
    await index(100, [stake(100, S1, ["akash", "eth"])], []);
    await index(120, [], activations(120, S1, ["akash", "eth"]));
    await index(150, [unstake(150, S1)], []);

    // MsgStakeSupplier cancels the unbonding (poktroll msg_server_stake_supplier.go) and declares akash
    await index(160, [stake(160, S1, ["akash"])], []);
    assert.equal(supplierStatus(S1), "Staked");
    assert.deepEqual(open(S1), ["akash@-"]);

    await index(180, [], activations(180, S1, ["akash"]));
    assert.deepEqual(open(S1), ["akash@180"]);
  });

  for (const reason of ["BELOW_MIN_STAKE", "MIGRATION"] as const) {
    it(`an unbonding begun by ${reason} leaves the supplier's configs declared`, async () => {
      reset();
      await index(100, [stake(100, S1, ["akash"])], []);
      await index(120, [], activations(120, S1, ["akash"]));

      // Neither withdraws the declaration on chain. MIGRATION schedules no deactivation. BELOW_MIN_STAKE sets one
      // on the in-memory supplier only (poktroll settle_pending_claims.go saves it with SetDehydratedSupplier,
      // which drops the history): the chain still reports deactivation_height 0 after the begin (beta supplier
      // pokt184feal... at 482554 and 490000, mainnet pokt1wua234... at 461854 and 470000).
      await index(150, [], [unbondingBegin(150, S1, reason)]);
      assert.deepEqual(open(S1), ["akash@120"]);
    });
  }

  it("an activation of a config the supplier unstaked before it is expected, not a warning", async () => {
    reset();
    await index(100, [stake(100, S1, ["akash"])], []);
    await index(110, [unstake(110, S1)], []);

    // the chain still activates it at the session start, with deactivation_height = activation_height
    warnings.length = 0;
    await index(120, [], activations(120, S1, ["akash"]));
    assert.deepEqual(open(S1), []);
    assert.deepEqual(warnings, []);

    // a supplier still staked with no open config for the service is drift: warned
    await index(130, [stake(130, S2, ["eth"])], []);
    await index(140, [], activations(140, S2, ["akash"]));
    assert.equal(warnings.length, 1);
  });

  it("a Morse claim of a node still unbonding on Morse declares its services until the unbonding ends", async () => {
    reset();
    // poktroll msg_server_claim_morse_supplier.go:317: the claim stakes the services, then emits a MIGRATION
    // EventSupplierUnbondingBegin in the same tx; the unbonding ends at the estimated height
    const claim = claimMorse(150, S1, ["akash"]);
    const begin = { ...unbondingBegin(150, S1, "MIGRATION"), tx: claim.tx, idx: 1 } as CosmosEvent;
    await index(150, [claim], [begin]);
    assert.deepEqual(open(S1), ["akash@-"]);

    await index(160, [], activations(160, S1, ["akash"]));
    assert.deepEqual(open(S1), ["akash@160"]);

    await index(250, [], [unbondingEnd(250, S1)]);
    assert.deepEqual(open(S1), []);
    assert.equal(supplierStatus(S1), "Unstaked");
  });

  it("a stake-only restake during the unbonding declares nothing", async () => {
    reset();
    await index(100, [stake(100, S1, ["akash"])], []);
    await index(120, [], activations(120, S1, ["akash"]));
    await index(150, [unstake(150, S1)], []);

    // the chain keeps the history, every entry already scheduled to deactivate
    await index(160, [stake(160, S1, [])], []);
    assert.equal(supplierStatus(S1), "Staked");
    assert.deepEqual(open(S1), []);
  });

  it("a Morse claim declares configs that its activation activates", async () => {
    reset();
    await index(100, [claimMorse(100, S1, ["akash", "eth"])], []);
    assert.deepEqual(open(S1), ["akash@-", "eth@-"]);

    await index(120, [], activations(120, S1, ["akash", "eth"]));
    assert.deepEqual(open(S1), ["akash@120", "eth@120"]);
  });

  it("a finalize_block event with an unknown mode is kept after the txs instead of failing the block", async () => {
    reset();
    await index(100, [stake(100, S1, ["akash"])], []);
    const [event] = activations(120, S1, ["akash"]);
    const middle = {
      ...event,
      event: {
        ...event.event,
        attributes: event.event.attributes.map((attribute) =>
          attribute.key === "mode" ? { ...attribute, value: "Middle" } : attribute
        ),
      },
    } as CosmosEvent;

    // after the stake, as before this ordering existed: it stamps the new config
    await index(120, [stake(120, S1, ["akash"])], [middle]);
    assert.deepEqual(open(S1), ["akash@120"]);
  });

  it("a finalize_block event without a mode (PreBlock) runs before the block's txs", async () => {
    reset();
    await index(100, [stake(100, S1, ["akash"])], []);
    const [event] = activations(120, S1, ["akash"]);
    const preBlock = {
      ...event,
      event: { ...event.event, attributes: event.event.attributes.filter(({ key }) => key !== "mode") },
    } as CosmosEvent;

    // processed after the stake, it would stamp the new config as activated at 120
    await index(120, [stake(120, S1, ["akash"])], [preBlock]);
    assert.deepEqual(open(S1), ["akash@-"]);
  });

  it("a stake without services keeps the supplier's configs", async () => {
    reset();
    await index(100, [stake(100, S1, ["akash", "eth"])], []);
    await index(120, [], activations(120, S1, ["akash", "eth"]));

    await index(130, [stake(130, S1, [])], []);
    assert.deepEqual(open(S1), ["akash@120", "eth@120"]);
  });

  it("a pre-v0.1.27 activation leaves configs that activate at another height alone (e.g. from genesis)", async () => {
    reset();
    await index(100, [stake(100, S1, ["akash", "eth"])], []);

    await index(
      140,
      [],
      [
        legacyActivation(140, S1, [
          ["akash", 1],
          ["eth", 140],
        ]),
      ]
    );
    assert.deepEqual(open(S1), ["akash@-", "eth@140"]);
  });

  it("a pre-v0.1.27 activation with an empty history activates every config of the supplier", async () => {
    reset();
    await index(100, [stake(100, S1, ["akash", "eth"])], []);

    await index(140, [], [legacyActivation(140, S1, [])]);
    assert.deepEqual(open(S1), ["akash@140", "eth@140"]);
  });

  it("a pre-v0.1.27 activation does not activate a config a restake cancelled at that height", async () => {
    reset();
    await index(100, [stake(100, S1, ["akash", "eth"])], []);

    // eth's entry was cancelled before it activated: deactivation_height == activation_height
    await index(
      140,
      [],
      [
        legacyActivation(140, S1, [
          ["akash", 140],
          ["eth", 140, 140],
        ]),
      ]
    );
    assert.deepEqual(open(S1), ["akash@140", "eth@-"]);
  });

  it("a Morse claim that stakes nothing leaves an operator already staked on Shannon as it was", async () => {
    reset();
    await index(100, [stake(100, S1, ["akash"])], []);
    await index(120, [], activations(120, S1, ["akash"]));

    const claim = claimMorse(150, S1, ["eth"], true);
    await index(150, [claim], [claimUnbondingEnd(claim, S1)]);
    assert.deepEqual(open(S1), ["akash@120"]);
    assert.equal(supplierStatus(S1), "Staked");
    // the supplier is neither closed nor saved again as an identical row
    assert.deepEqual(
      tables.Supplier.filter((row) => row.id === S1).map((row) => [row.lo, row.hi]),
      [[100, null]]
    );
  });

  // pins current behaviour, not intended behaviour: the chain stores no supplier for this operator (as on origin/main)
  it("a Morse claim that stakes nothing for a new operator leaves it unstaked without configs", async () => {
    reset();
    const claim = claimMorse(150, S2, ["eth"], true);
    await index(150, [claim], [claimUnbondingEnd(claim, S2)]);
    assert.deepEqual(open(S2), []);
    assert.equal(supplierStatus(S2), "Unstaked");
  });

  it("rows another writer created at the same height survive, unless this block closes them", async () => {
    reset();
    // handleGenesis writes these at the genesis height before indexSupplier runs on the same block
    tables.Supplier = [{ id: S1, stakeStatus: "Staked", stakeAmount: BigInt(1), lo: 1, hi: null }];
    tables.MsgStakeSupplier = [{ id: "genesis-msg", lo: 1, hi: null }];
    tables.SupplierServiceConfig = [
      { id: `${S1}-akash`, supplierId: S1, serviceId: "akash", lo: 1, hi: null },
      { id: `${S2}-eth`, supplierId: S2, serviceId: "eth", lo: 1, hi: null },
    ];

    await index(1, [stake(1, S2, ["base"])], [unbondingEnd(1, S1)]);
    assert.ok(tables.Supplier.some((row) => row.id === S1));
    assert.ok(tables.MsgStakeSupplier.some((row) => row.id === "genesis-msg"));
    // S2's genesis eth was replaced by its stake at the same height; S1's akash was closed by its unbonding end
    // at the height it was created: both are deleted, not left with an empty range
    assert.deepEqual(open(S2), ["base@-"]);
    assert.deepEqual(configs(S1), []);
    assert.equal(tables.SupplierServiceConfig.filter((row) => row.lo === null).length, 0);
  });

  for (const [label, order] of [
    ["the short-circuited claim first", [0, 1]],
    ["the staking claim first", [1, 0]],
  ] as const) {
    it(`two Morse claims in one tx do not cross-apply (${label})`, async () => {
      reset();
      // both operators are already staked on Shannon
      await index(100, [stake(100, S1, ["akash"]), stake(100, S2, ["akash"], 1)], []);
      await index(120, [], [...activations(120, S1, ["akash"]), ...activations(120, S2, ["akash"])]);

      // one tx: S1's claim short-circuits (it stays as it was), S2's claim stakes eth
      const shortCircuit = claimMorse(150, S1, ["eth"], true);
      const staking = claimMorse(150, S2, ["eth"]);
      const tx = { ...shortCircuit.tx, hash: "TWOCLAIMS" };
      const claims = [
        { ...shortCircuit, idx: order[0], tx },
        { ...staking, idx: order[1], tx },
      ] as Array<CosmosMessage>;
      await index(150, claims, [{ ...claimUnbondingEnd(shortCircuit, S1), tx } as CosmosEvent]);

      assert.deepEqual(open(S1), ["akash@120"]);
      assert.equal(supplierStatus(S1), "Staked");
      assert.deepEqual(open(S2), ["eth@-"]);
      assert.equal(supplierStatus(S2), "Staked");
    });
  }

  // one tx with several claims, each event tagged with its message's msg_index (block_results of mainnet 158648)
  const multiClaimTx = (h: number, claims: Array<[string, string, boolean]>) => {
    const events = claims.flatMap(([operator, stakeUpokt, unbondingEnded], i) => [
      {
        type: "pocket.migration.EventMorseSupplierClaimed",
        attributes: [
          { key: "claimed_balance", value: `"${i + 1}upokt"` },
          { key: "claimed_supplier_stake", value: `"${stakeUpokt}upokt"` },
          { key: "msg_index", value: `${i}` },
        ],
      },
      ...(unbondingEnded
        ? [
            {
              type: "pocket.supplier.EventSupplierUnbondingEnd",
              attributes: [
                { key: "operator_address", value: `"${operator}"` },
                { key: "msg_index", value: `${i}` },
              ],
            },
          ]
        : []),
    ]);
    const tx = { hash: `MULTI${h}`, idx: 0, tx: { code: 0, events } };
    const msgs = claims.map(
      ([operator], i) => ({ ...claimMorse(h, operator, ["eth"]), idx: i, tx } as unknown as CosmosMessage)
    );
    const unbondingEnds = events
      .filter(({ type }) => type === "pocket.supplier.EventSupplierUnbondingEnd")
      .map((event, i) => ({ idx: 10 + i, kind: "tx", block: block(h), tx, event } as unknown as CosmosEvent));
    return { msgs, unbondingEnds };
  };

  const stakeOf = (operator: string) =>
    (tables.Supplier || []).find((row) => row.id === operator && openAt(row, height))?.stakeAmount;

  it("claims in one tx each read their own amounts", async () => {
    reset();
    const { msgs } = multiClaimTx(150, [
      [S1, "61102000000", false],
      [S2, "60005000000", false],
    ]);
    await index(150, msgs, []);
    assert.equal(stakeOf(S1), BigInt("61102000000"));
    assert.equal(stakeOf(S2), BigInt("60005000000"));
  });

  it("two claims to the same staked operator in one tx: the short-circuited one does not mask the other", async () => {
    reset();
    await index(100, [stake(100, S1, ["akash"])], []);
    const { msgs, unbondingEnds } = multiClaimTx(150, [
      [S1, "1000", true],
      [S1, "5000", false],
    ]);
    await index(150, msgs, unbondingEnds);
    assert.equal(supplierStatus(S1), "Staked");
    assert.equal(stakeOf(S1), BigInt("60000005000"));
    assert.deepEqual(open(S1), ["eth@-"]);
  });
});

describe("Morse supplier claim destination", () => {
  const OWNER = "pokt1ownerownerownerownerownerownerownerow";
  const signerTypes = {
    node: "MORSE_SUPPLIER_CLAIM_SIGNER_TYPE_NON_CUSTODIAL_SIGNED_BY_NODE_ADDR",
    owner: "MORSE_SUPPLIER_CLAIM_SIGNER_TYPE_NON_CUSTODIAL_SIGNED_BY_OWNER",
  };
  type Claim = { supplier: string; node: number; signer: keyof typeof signerTypes; stakedNothing?: boolean };

  // one tx with these claims, all owned by OWNER, each event tagged with its message's msg_index; a claim that
  // stakes nothing emits EventSupplierUnbondingEnd for its supplier in the tx (poktroll v0.1.20 short circuits)
  const claimsTx = (h: number, claims: Array<Claim>, chainId = "pocket") => {
    const events = claims.flatMap(({ signer, stakedNothing, supplier }, i) => [
      {
        type: "pocket.migration.EventMorseSupplierClaimed",
        attributes: [
          { key: "claim_signer_type", value: `"${signerTypes[signer]}"` },
          { key: "claimed_balance", value: '"1000upokt"' },
          { key: "claimed_supplier_stake", value: '"60000000000upokt"' },
          { key: "msg_index", value: `${i}` },
        ],
      },
      ...(stakedNothing
        ? [
            {
              type: "pocket.supplier.EventSupplierUnbondingEnd",
              attributes: [
                { key: "operator_address", value: `"${supplier}"` },
                { key: "reason", value: '"SUPPLIER_UNBONDING_REASON_MIGRATION"' },
                { key: "msg_index", value: `${i}` },
              ],
            },
          ]
        : []),
    ]);
    const tx = { hash: `MORSE${h}`, idx: 0, tx: { code: 0, events } };
    const msgs = claims.map(({ node, supplier }, i) => {
      const claim = claimMorse(h, supplier, ["eth"]) as unknown as { msg: { decodedMsg: object } };
      return {
        ...claim,
        idx: i,
        block: block(h, chainId),
        tx,
        msg: {
          ...claim.msg,
          decodedMsg: { ...claim.msg.decodedMsg, shannonOwnerAddress: OWNER, morsePublicKey: new Uint8Array(32).fill(node) },
        },
      } as unknown as CosmosMessage;
    });
    const unbondingEnds = events
      .filter(({ type }) => type === "pocket.supplier.EventSupplierUnbondingEnd")
      .map((event, i) => ({ idx: 10 + i, kind: "tx", block: block(h, chainId), tx, event } as unknown as CosmosEvent));
    return { msgs, unbondingEnds };
  };

  const destinationOf = (node: number) =>
    morseDestinations[pubKeyToAddress(Ed25519, new Uint8Array(32).fill(node), undefined, true)];

  const claimAt = async (h: number, claims: Array<Claim>) => {
    reset();
    const { msgs, unbondingEnds } = claimsTx(h, claims);
    await index(h, msgs, unbondingEnds);
  };

  it("before v0.1.20 (mainnet 135,297) it is the supplier address, even for a claim the owner signed", async () => {
    await claimAt(135296, [{ supplier: S1, node: 1, signer: "owner" }]);
    assert.equal(destinationOf(1), S1);
  });

  it("since v0.1.20, a node-signed claim that stakes: the supplier address", async () => {
    await claimAt(135297, [{ supplier: S1, node: 1, signer: "node" }]);
    assert.equal(destinationOf(1), S1);
  });

  it("since v0.1.20, an owner-signed claim: the owner", async () => {
    await claimAt(135297, [{ supplier: S1, node: 1, signer: "owner" }]);
    assert.equal(destinationOf(1), OWNER);
  });

  it("since v0.1.20, a node-signed claim that stakes nothing: the owner", async () => {
    await claimAt(553909, [{ supplier: S1, node: 1, signer: "node", stakedNothing: true }]);
    assert.equal(destinationOf(1), OWNER);
  });

  it("claims in one tx each read their own unbonding end", async () => {
    await claimAt(553909, [
      { supplier: S1, node: 1, signer: "node", stakedNothing: true },
      { supplier: S2, node: 2, signer: "node" },
    ]);
    assert.equal(destinationOf(1), OWNER);
    assert.equal(destinationOf(2), S2);
  });

  it("a chain with no v0.1.20 height stops the block", async () => {
    reset();
    const { msgs } = claimsTx(150, [{ supplier: S1, node: 1, signer: "node" }], "unknown-chain");
    await assert.rejects(index(150, msgs, []), /no v0\.1\.20 height for chain "unknown-chain"/);
  });
});

describe("indexSupplier rev_share wallets", () => {
  // a stake whose configs share revenue with the given wallets
  const stakeSharing = (h: number, operator: string, services: Array<string>, wallets: Array<string>): CosmosMessage => {
    const msg = stake(h, operator, services);
    const decoded = msg.msg.decodedMsg as { services: Array<{ revShare: Array<unknown> }> };
    for (const service of decoded.services) {
      service.revShare = wallets.map((address) => ({ address, revSharePercentage: 100 / wallets.length }));
    }
    return msg;
  };
  // the (wallet, supplier, height) of every pair sent, sorted
  const pairs = () =>
    queries.flatMap(({ bind: [wallets, suppliers, h] }) =>
      (wallets as Array<string>).map((w, i) => `${w} ${(suppliers as Array<string>)[i]} ${h}`)
    ).sort();

  it("writes the pairs of the configs a block writes, in the block transaction, and nothing for a block that writes none", async () => {
    reset();
    queries.length = 0;
    // a transaction of its own for this block, to tell it from no transaction
    const context = (globals.store as { context: { transaction: unknown } }).context;
    const before = context.transaction;
    const tx = { block: 500 };
    context.transaction = tx;
    try {
      await index(500, [stakeSharing(500, S1, ["akash", "eth"], ["w-a", "w-b"]), stakeSharing(500, S2, ["eth"], ["w-a"])], []);
    } finally {
      context.transaction = before;
    }
    assert.equal(queries.length, 1);
    assert.match(queries[0].sql, /INSERT INTO \S+\.supplier_rev_share_wallets [\s\S]* ON CONFLICT \(wallet_address, supplier_id\) DO NOTHING/);
    assert.equal(queries[0].transaction, tx);
    // a pair listed by two configs is sent twice; the INSERT keeps one (SELECT DISTINCT, ON CONFLICT)
    assert.deepEqual(pairs(), [
      `w-a ${S1} 500`, `w-a ${S1} 500`, `w-a ${S2} 500`, `w-b ${S1} 500`, `w-b ${S1} 500`,
    ]);

    // an unstake and a stake-only top-up write no config, so no pair
    queries.length = 0;
    await index(510, [unstake(510, S2), stake(510, S1, [])], []);
    assert.equal(queries.length, 0);

    // a restake that changes the wallets: the pairs of the configs it writes, at its height
    await index(520, [stakeSharing(520, S1, ["akash"], ["w-c"])], []);
    assert.deepEqual(pairs(), [`w-c ${S1} 520`]);
  });
});
