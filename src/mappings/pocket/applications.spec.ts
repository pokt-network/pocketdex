// Unit test: get_actor_lifecycle names an application unbonding reason with APP_UNBONDING_REASON_NAMES, in SQL; the
// indexer names the entity's unstakingReason with getAppUnbondingReasonFromSDK. Every reason the proto defines must map
// to the same name in both, and the SQL map must hold no reason the indexer refuses.
// Run with
//   yarn test:unit
/* eslint-disable @typescript-eslint/no-var-requires */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ApplicationUnbondingReason as ApplicationUnbondingReasonSDKType } from "../../client/pocket/application/event";
import { APP_UNBONDING_REASON_NAMES } from "../dbFunctions/settlement/functions";

const globals = globalThis as Record<string, unknown>;
globals.logger = { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined };
const { getAppUnbondingReasonFromSDK } = require("./applications") as typeof import("./applications");

describe("application unbonding reason names", () => {
  it("are the same in get_actor_lifecycle and the indexer for every reason of the proto", () => {
    // UNRECOGNIZED (-1) is the decoder's value for a number it does not know, not a reason the chain emits
    const reasons = Object.values(ApplicationUnbondingReasonSDKType).filter(
      (v): v is number => typeof v === "number" && v >= 0
    );
    assert.deepEqual(reasons, [0, 1, 2]);
    assert.deepEqual(Object.keys(APP_UNBONDING_REASON_NAMES).map(Number), reasons, "the SQL map names exactly the proto's reasons");
    for (const r of reasons) assert.equal(APP_UNBONDING_REASON_NAMES[r], getAppUnbondingReasonFromSDK(r), `reason ${r}`);
    assert.throws(() => getAppUnbondingReasonFromSDK(3), /Unknown ApplicationUnbondingReason=3/);
  });
});
