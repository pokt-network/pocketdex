// Entity → stored field names of a schema.graphql (fields with @derivedFrom have no column and are left out).
export function entityFields(schema: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const re = /^type\s+(\w+)\s+@entity\b[^{]*\{([\s\S]*?)^\}/gm;
  for (let m = re.exec(schema); m; m = re.exec(schema)) {
    out[m[1]] = m[2]
      .split("\n")
      .map((l) => l.replace(/#.*/, "").trim())
      .filter((l) => /^\w+\s*:/.test(l) && !l.includes("@derivedFrom"))
      .map((l) => l.split(":")[0].trim())
      .sort();
  }
  return out;
}
