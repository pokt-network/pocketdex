// Unit test: pins the domain rule (endpointDomain and its ipv6 helper in service_config_history.ts) by the sha256 of
// its normalised source. igniter keeps a copy of the same rule in apps/middleman-workflows/src/activities/endpointDomain.ts
// and pins the same hash with the same functionText and normalise, so both sides read a supplier's domains alike.
// Changing the rule means changing both copies and the hash in both tests. A comment, quote style, semicolon,
// non-null `!` or formatting change keeps the hash. The hash is sha256 hex of normalise(endpointDomain's text) followed
// by normalise(ipv6's text). functionText counts braces without reading strings or comments: a brace in one, inside
// either function, would cut the text short (none today; the hash would change, and the test say so). Run with
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

// (1) block comments out, then (2) line comments, each one opened at the start of a line or after whitespace (so the
// `//` of `http://` in a string is not one); (3) `"` as `'`; (4) no `;`; (5) no non-null `!` before `,` `)` `]` or `.`;
// (6) no whitespace
function normalise(text: string): string {
  return text
    .replace(/(^|\s)\/\*[\s\S]*?\*\//g, "$1")
    .replace(/(^|\s)\/\/[^\n]*/g, "$1")
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

  it("normalises comments, quotes, semicolons and whitespace away, not the // of a URL", () => {
    assert.equal(normalise('a("x"); // why\n  /* note\n  more */ b!.c;\n// whole line\n'), "a('x')b.c");
    assert.equal(normalise("u(`http://[${x}]/`) /* c */"), "u(`http://[${x}]/`)");
  });
});
