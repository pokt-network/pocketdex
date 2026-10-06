// Unit test: genesisConfigActivatedAt decides whether a genesis SupplierServiceConfig row (the config the supplier
// declared) is active since genesis or pending, from the supplier's service_config_history. Run with
//   yarn test:unit
/* eslint-disable @typescript-eslint/no-floating-promises, @typescript-eslint/no-var-requires */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

const globals = globalThis as Record<string, unknown>;
globals.logger = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined };

const { genesisConfigActivatedAt } = require("./service_config_history") as typeof import("./service_config_history");

const entry = (serviceId: string, activation: number, deactivation = 0) =>
  ({
    service: { service_id: serviceId },
    activation_height: `${activation}`,
    deactivation_height: `${deactivation}`,
  } as never);

describe("genesisConfigActivatedAt", () => {
  it("a declared config that activated at or before genesis is active since genesis", () => {
    assert.equal(genesisConfigActivatedAt([entry("eth", 0)], "eth", BigInt(1)), BigInt(1));
  });

  it("a declared config pending at genesis stays pending, even with an older config of that service still active", () => {
    // C1 active until 20, C2 declared and activating at 20
    assert.equal(genesisConfigActivatedAt([entry("eth", 0, 20), entry("eth", 20)], "eth", BigInt(1)), undefined);
  });

  it("a service whose only entry is scheduled to end counts as active while it is active at genesis", () => {
    assert.equal(genesisConfigActivatedAt([entry("eth", 0, 20)], "eth", BigInt(1)), BigInt(1));
  });

  it("without history the config is pending", () => {
    assert.equal(genesisConfigActivatedAt(undefined, "eth", BigInt(1)), undefined);
  });
});

describe("endpointDomains", () => {
  const { endpointDomains } = require("./service_config_history") as typeof import("./service_config_history");

  it("keeps each endpoint's root domain once, as a stake and genesis write SupplierServiceConfig.domains", () => {
    assert.deepEqual(
      endpointDomains([
        "https://eth.node.d.com:443/v1",
        "https://base.node.d.com",
        "http://relay.e.io",
        "https://localhost",
      ]),
      ["d.com", "e.io", "localhost"]
    );
  });
});
