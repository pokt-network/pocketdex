import { default as JSONBig } from "json-bigint";

// use JSONBig module instead of the Native one due to the usage of BigInt, which is not supported natively.
export function parseJson<T>(str: string, reviver?: (this: unknown, key: string, value: unknown) => unknown): T {
  return JSONBig.parse(str, reviver) as T;
}

// use JSONBig module instead of the Native one due to the usage of BigInt, which is not supported natively.
export function stringify(value: unknown, replacer?: (this: unknown, key: string, value: unknown) => unknown, space?: string | number): string {
  return JSONBig.stringify(value, replacer || undefined, space);
}
