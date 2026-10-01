// positiveIntFromEnv parses a numeric env var strictly: unset or empty (the
// entrypoints pass an unset variable as an empty string) means the default; a
// value that is not a positive integer throws, so a typo fails at startup
// instead of being ignored.
export function positiveIntFromEnv(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, got "${value}"`);
  }
  return parsed;
}
