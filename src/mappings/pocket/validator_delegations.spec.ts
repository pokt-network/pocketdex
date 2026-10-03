// Unit test: the delegation history kept by reconcileValidators, against fake SubQuery globals (store, api)
// and a fake chain. A beta run that starts mid-chain has no Validator rows, so these two paths can only be
// exercised here: a change of delegator_shares makes the validator's delegations be re-read, and a full
// read that finds a change no trigger saw fails the block. Run with
//   yarn test:unit
/* eslint-disable @typescript-eslint/no-floating-promises, @typescript-eslint/require-await, @typescript-eslint/no-var-requires */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  QueryValidatorDelegationsRequest,
  QueryValidatorDelegationsResponse,
  QueryValidatorsResponse,
} from "../../client/cosmos/staking/v1beta1/query";
import { BondStatus } from "../../client/cosmos/staking/v1beta1/staking";

const RATE_ONE = "1000000000000000000";
type Row = Record<string, unknown>;

// chain state at the queried height
let chainShares: Record<string, string> = {};
let chainDelegations: Record<string, Array<{ delegator: string; shares: string }>> = {};
// store state
let storeValidators: Record<string, Row> = {};
let storeDelegations: Row[] = [];
const written: { upserts: Row[]; removes: string[]; delegationReads: string[] } = {
  upserts: [],
  removes: [],
  delegationReads: [],
};

const globals = globalThis as Record<string, unknown>;
globals.logger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };
globals.store = {
  get: async (entity: string, id: string) => (entity === "Validator" ? storeValidators[id] : undefined),
  getByField: async (entity: string, field: string, value: string, options: { offset?: number }) => {
    const rows = entity === "Validator" ? Object.values(storeValidators) : storeDelegations;
    return (options.offset ?? 0) > 0 ? [] : rows.filter((r) => r[field] === value);
  },
  bulkCreate: async (entity: string, rows: Row[]) => {
    if (entity === "Delegation") written.upserts.push(...rows);
  },
  bulkRemove: async (entity: string, ids: string[]) => {
    if (entity === "Delegation") written.removes.push(...ids);
  },
};
globals.api = {
  forceGetCometClient: () => ({
    abciQuery: async ({ data, height, path }: { path: string; data: Uint8Array; height: number }) => {
      if (path.endsWith("/Validators")) {
        const validators = Object.entries(chainShares).map(([operatorAddress, delegatorShares]) => ({
          operatorAddress,
          delegatorShares,
          tokens: "100",
          status: BondStatus.BOND_STATUS_BONDED,
          commission: { commissionRates: { rate: RATE_ONE, maxRate: RATE_ONE, maxChangeRate: RATE_ONE } },
          minSelfDelegation: "1",
        }));
        return {
          code: 0,
          height,
          value: QueryValidatorsResponse.encode(QueryValidatorsResponse.fromPartial({ validators })).finish(),
        };
      }
      if (path.endsWith("/ValidatorDelegations")) {
        const operator = QueryValidatorDelegationsRequest.decode(data).validatorAddr;
        written.delegationReads.push(operator);
        const delegationResponses = (chainDelegations[operator] ?? []).map((d) => ({
          delegation: { delegatorAddress: d.delegator, validatorAddress: operator, shares: d.shares },
        }));
        const response = QueryValidatorDelegationsResponse.fromPartial({ delegationResponses });
        return { code: 0, height, value: QueryValidatorDelegationsResponse.encode(response).finish() };
      }
      throw new Error(`unexpected path ${path}`);
    },
  }),
};

const { reconcileValidators } = require("./validator") as typeof import("./validator");

function setup(
  stored: string,
  chain: string,
  storedDelegations: Array<[string, string]>,
  chainDels: Array<[string, string]>
) {
  const v = "valA";
  storeValidators = {
    [v]: {
      id: v,
      stakeStatus: "Staked",
      stakeAmount: BigInt(100),
      minSelfDelegation: 1,
      delegatorShares: stored,
      description: undefined,
      commission: { rate: RATE_ONE, maxRate: RATE_ONE, maxChangeRate: RATE_ONE },
    },
  };
  chainShares = { [v]: chain };
  storeDelegations = storedDelegations.map(([delegator, shares]) => ({
    id: `${v}-${delegator}`,
    validatorOperator: v,
    delegator,
    shares,
  }));
  chainDelegations = { [v]: chainDels.map(([delegator, shares]) => ({ delegator, shares })) };
  written.upserts.length = 0;
  written.removes.length = 0;
  written.delegationReads.length = 0;
}

describe("reconcileValidators keeps the delegation history", () => {
  it("re-reads a validator's delegations when its delegator_shares moved, and writes the difference", async () => {
    setup(
      "100",
      "150",
      [["d1", "100"]],
      [
        ["d1", "100"],
        ["d2", "50"],
      ]
    );
    await reconcileValidators(10);
    assert.deepEqual(written.delegationReads, ["valA"]);
    assert.deepEqual(
      written.upserts.map((u) => [u.delegator, u.shares]),
      [["d2", "50"]]
    );
  });

  it("does not read delegations when nothing moved and it is not a full read", async () => {
    setup("100", "100", [["d1", "100"]], [["d1", "100"]]);
    await reconcileValidators(10);
    assert.deepEqual(written.delegationReads, []);
  });

  it("re-reads a validator named by a staking event even if its delegator_shares look unchanged", async () => {
    setup(
      "100",
      "100",
      [
        ["d1", "60"],
        ["d2", "40"],
      ],
      [
        ["d1", "40"],
        ["d2", "60"],
      ]
    );
    await reconcileValidators(10, { stakingValidators: new Set(["valA"]) });
    assert.deepEqual(written.upserts.map((u) => [u.delegator, u.shares]).sort(), [
      ["d1", "40"],
      ["d2", "60"],
    ]);
  });

  it("fails the block when a full read finds a change that neither delegator_shares nor an event announced", async () => {
    setup(
      "100",
      "100",
      [
        ["d1", "60"],
        ["d2", "40"],
      ],
      [
        ["d1", "40"],
        ["d2", "60"],
      ]
    );
    await assert.rejects(
      reconcileValidators(10, { fullDelegationRead: true }),
      /changed at or before height 10 without a change/
    );
    assert.deepEqual(written.upserts, []);
  });

  it("returns the snapshot of a full read", async () => {
    setup("100", "100", [["d1", "100"]], [["d1", "100"]]);
    const snapshot = await reconcileValidators(10, { fullDelegationRead: true });
    assert.deepEqual(snapshot.delegations?.get("valA"), [{ delegator: "d1", shares: "100" }]);
  });
});
