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

describe("endpointDomain", () => {
  const { endpointDomain, endpointDomains } =
    require("./service_config_history") as typeof import("./service_config_history");

  it("an IPv4 host is the whole address, with or without a port (41 such urls on mainnet, 2 on beta)", () => {
    assert.equal(endpointDomain("http://10.0.3.4"), "10.0.3.4");
    assert.equal(endpointDomain("http://144.202.31.211:8050"), "144.202.31.211");
    assert.equal(endpointDomain("http://999.1.1.1"), null);
  });

  it("an IPv6 host is its compressed lowercase form, IPv4-mapped in dotted form", () => {
    assert.equal(endpointDomain("http://[2001:db8::1]:8545"), "2001:db8::1");
    assert.equal(endpointDomain("http://[2001:0DB8:0000:0000:0000:0000:0000:0001]"), "2001:db8::1");
    assert.equal(endpointDomain("http://[::ffff:10.0.3.4]:80"), "::ffff:10.0.3.4");
    assert.equal(endpointDomain("http://2001:db8::1"), "2001:db8::1");
  });

  it("a hostname keeps its last two labels, whatever the scheme, case, port, userinfo, path or trailing dot", () => {
    assert.equal(endpointDomain("https://eth.node.Example.COM.:443/v1?x=1"), "example.com");
    assert.equal(endpointDomain("wss://user:pw@rpc.d.io/ws"), "d.io");
    assert.equal(endpointDomain("ws://relay.e.io:8546"), "e.io");
    assert.equal(endpointDomain(" https://a.b.c/ "), "b.c");
    assert.equal(endpointDomain("https://localhost"), "localhost");
    // a placeholder a supplier staked on mainnet, as it is
    assert.equal(endpointDomain("http://YOUR_NODE_IP_OR_HOST.com:8545"), "your_node_ip_or_host.com");
  });

  it("never throws: a string that names no host gives no domain", () => {
    for (const value of ["", "   ", "garbage", "http://", "://x", null, undefined, 42]) {
      assert.equal(endpointDomain(value), null, String(value));
    }
  });

  it("the domains of a config are unique, in endpoint order", () => {
    assert.deepEqual(
      endpointDomains([
        { url: "https://eth.node.d.com:443/v1", rpcType: 3 },
        { url: "wss://base.node.d.com", rpcType: 2 },
        { url: "http://10.0.3.4:8545", rpcType: 1 },
        { url: "garbage", rpcType: 4 },
      ]),
      ["d.com", "10.0.3.4"]
    );
  });

  it("only the first endpoint of each rpcType counts (mainnet pokt1vmy9q5..., rpcType 3 on two IPs since 852319)", () => {
    assert.deepEqual(
      endpointDomains([
        { url: "http://88.198.50.175:28546", rpcType: 3 },
        { url: "http://193.201.82.205:28546", rpcType: 3 },
      ]),
      ["88.198.50.175"]
    );
    // the first of a type decides even when the type's later endpoints sit on other domains; other types still count
    assert.deepEqual(
      endpointDomains([
        { url: "wss://ws.a.io", rpcType: 2 },
        { url: "https://rpc.b.io", rpcType: 3 },
        { url: "https://rpc.c.io", rpcType: 3 },
        { url: "wss://ws.d.io", rpcType: 2 },
        { url: "https://rest.c.io", rpcType: 4 },
      ]),
      ["a.io", "b.io", "c.io"]
    );
  });

  it("the first endpoint of a type with a domain decides: one with none does not take the type's place", () => {
    assert.deepEqual(
      endpointDomains([
        { url: "garbage", rpcType: 3 },
        { url: "https://rpc.b.io", rpcType: 3 },
        { url: "https://rpc.c.io", rpcType: 3 },
      ]),
      ["b.io"]
    );
  });

  it("rpcType 0, unset or UNRECOGNIZED is no type: each such endpoint counts on its own", () => {
    assert.deepEqual(
      endpointDomains([
        { url: "https://a.io", rpcType: 0 },
        { url: "https://b.io", rpcType: 0 },
        { url: "https://c.io", rpcType: undefined },
        { url: "https://d.io", rpcType: undefined },
        { url: "https://e.io", rpcType: -1 },
        { url: "https://f.io", rpcType: -1 },
      ]),
      ["a.io", "b.io", "c.io", "d.io", "e.io", "f.io"]
    );
  });
});
