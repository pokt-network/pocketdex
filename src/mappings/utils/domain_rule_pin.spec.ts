// Unit test: pins the domain rule (endpointDomain and its ipv6 helper in service_config_history.ts) by the sha256 of
// its normalised source. igniter keeps a copy of the same rule in apps/middleman-workflows/src/activities/endpointDomain.ts
// and pins the same hash, so both sides read a supplier's domains alike. Changing the rule means changing both copies
// and the hash in both tests; a comment or formatting change keeps the hash. Run with
//   yarn test:unit
/* eslint-disable @typescript-eslint/no-floating-promises */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const DOMAIN_RULE_SHA256 = "b596552d083a61180943f52566d6e33cf56ead44e5bc067461391042559a6c36";

// the text of a function, from `function <name>(` to the brace that closes its body (a leading `export ` is left out)
function functionText(src: string, name: string): string {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `no function ${name}`);
  const open = src.indexOf("{", src.indexOf(")", start));
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`unbalanced function ${name}`);
}

// comment lines out, `"` as `'`, no `;`, no non-null `!` before `,` `)` `]` or `.`, no whitespace
function normalise(text: string): string {
  return text
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n")
    .replace(/"/g, "'")
    .replace(/;/g, "")
    .replace(/!(?=[,)\].])/g, "")
    .replace(/\s+/g, "");
}

describe("domain rule pin", () => {
  it("endpointDomain and ipv6 hash as igniter's copy", () => {
    const src = readFileSync(join(__dirname, "service_config_history.ts"), "utf8");
    const hash = createHash("sha256")
      .update(normalise(functionText(src, "endpointDomain")) + normalise(functionText(src, "ipv6")))
      .digest("hex");
    assert.equal(hash, DOMAIN_RULE_SHA256);
  });
});
