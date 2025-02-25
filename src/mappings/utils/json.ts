import { default as JSONBig } from "json-bigint";
import { isString } from "lodash";

// use JSONBig module instead of the Native one due to the usage of BigInt, which is not supported natively.
export function parseJson<T>(str: string, reviver?: (this: unknown, key: string, value: unknown) => unknown): T {
  return JSONBig.parse(str, reviver) as T;
}

// use JSONBig module instead of the Native one due to the usage of BigInt, which is not supported natively.
export function stringify(value: unknown, replacer?: (this: unknown, key: string, value: unknown) => unknown, space?: string | number): string {
  return JSONBig.stringify(value, replacer || undefined, space);
}

// return an string no mater the input.
export function sanitize(value: unknown): string {
  // avoid stringify a string
  if (isString(value)) return value;
  // otherwise return it as a stringifies object
  return stringify(value);
}
