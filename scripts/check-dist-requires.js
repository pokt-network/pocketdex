// Post-prune smoke check for the production image: the mapping bundle (dist/*.js, built by `subql build`) must not
// require any npm package at runtime, because the image prunes dev dependencies and a package that is only there
// transitively (p-limit, for one) can disappear with a hoisting change. Only node builtins and the bundle's own
// relative chunks are allowed.
const fs = require("fs");
const path = require("path");
const { builtinModules } = require("module");

const dist = path.join(__dirname, "..", "dist");
const builtins = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));
const external = new Set();
for (const file of fs.readdirSync(dist).filter((f) => f.endsWith(".js"))) {
  for (const [, name] of fs.readFileSync(path.join(dist, file), "utf8").matchAll(/require\("([^"]+)"\)/g)) {
    if (!name.startsWith(".") && !builtins.has(name)) external.add(`${file}: ${name}`);
  }
}
if (external.size > 0) {
  console.error(`dist requires packages outside the bundle:\n${[...external].join("\n")}`);
  process.exit(1);
}
console.log("dist bundle requires only node builtins");
