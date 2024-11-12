import { toBech32 } from "@cosmjs/encoding";
import { CosmosBlock } from "@subql/types-cosmos";
import _ from "lodash";

type UintMap = { [key: number]: number };

// Type for converted block JSON
export type ConvertedBlockJson = {
  blockId: ConvertedBlockJson;
  header: ConvertedBlockJson;
  block: ConvertedBlockJson;
  [key: string]: string | number | boolean | ConvertedBlockJson | ConvertedBlockJson[];
};

// Utility function to convert Uint8Array to a hex string
function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

// Utility function to convert Uint8Array to a Bech32 address
function bytesToBech32(bytes: Uint8Array, prefix: string): string {
  return toBech32(prefix, bytes);
}

// Check if an object is an uint map
function isUintMap(obj: unknown): obj is UintMap {
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return false;

  const keys = Object.keys(obj).map(Number).sort((a, b) => a - b);
  if (keys.some(isNaN)) return false;

  return keys.every((key, index) =>
    key === index && Number.isInteger((obj as UintMap)[key]) && (obj as UintMap)[key] >= 0 && (obj as UintMap)[key] <= 255,
  );
}

// Find and convert all uint maps in a JSON object to Uint8Array
function findAndConvertUintMaps(obj: unknown): unknown {
  if (isUintMap(obj)) {
    return new Uint8Array(Object.values(obj));
  } else if (Array.isArray(obj)) {
    return obj.map(findAndConvertUintMaps);
  } else if (_.isPlainObject(obj)) {
    return _.mapValues(obj as Record<string, unknown>, findAndConvertUintMaps);
  } else {
    return obj;
  }
}

// Process the JSON object to convert Uint8Array properties to hex or Bech32
function convert(obj: unknown, bech32Prefix: string): ConvertedBlockJson | ConvertedBlockJson[] {
  if (Array.isArray(obj)) {
    return obj.map(item => convert(item, bech32Prefix)) as ConvertedBlockJson[];
  } else if (_.isPlainObject(obj)) {
    const result: Record<string, unknown> = {};
    _.forOwn(obj, (value, key) => {
      if ((value as unknown) instanceof Uint8Array) {
        result[key] = key.toLowerCase().includes("address")
          ? bytesToBech32(value, bech32Prefix)
          : bytesToHex(value);
      } else {
        result[key] = convert(value, bech32Prefix);
      }
    });
    return result as ConvertedBlockJson;
  } else {
    return obj as ConvertedBlockJson;
  }
}

// Combined function to process the JSON object and convert appropriate fields
export function processBlockJson(jsonObj: CosmosBlock, bech32Prefix: string): ConvertedBlockJson | ConvertedBlockJson[] {
  // Step 1: Find and convert all uint maps
  const convertedJson = findAndConvertUintMaps(jsonObj);

  // Step 2: Process the JSON object for other conversions
  return convert(convertedJson, bech32Prefix);
}
