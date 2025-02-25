import {
  ripemd160,
  sha256,
} from "@cosmjs/crypto";
import {
  fromBase64,
  toBech32,
  toHex,
} from "@cosmjs/encoding";
import {
  isEmpty,
  isNil,
} from "lodash";

export const Secp256k1 = "/cosmos.crypto.secp256k1.PubKey";
export const Ed25519 = "/cosmos.crypto.ed25519.PubKey";

function rawEd25519PubKeyToRawAddress(pubKey: Uint8Array): Uint8Array {
  let pk = pubKey;

  if (pubKey.length === 34) {
    // NB: pubKey has 2 "extra" bytes at the beginning as compared to the
    // base64-decoded representation/ of the same key when imported to
    // fetchd (`fetchd keys add --recover`) and shown (`fetchd keys show`).
    // Inspired from https://github.com/bryanchriswhite/fetchai-ledger-subquery/blob/main/src/mappings/primitives.ts#L71
    pk = pubKey.slice(2);
  }

  if (pk.length !== 32) {
    throw new Error(`Invalid Ed25519 pub key length: ${pk.length}`);
  }

  return sha256(pk).slice(0, 20);
}

function rawSecp256k1PubKeyToRawAddress(pubKey: Uint8Array): Uint8Array {
  let pk = pubKey;

  if (pubKey.length === 35) {
    // NB: pubKey has 2 "extra" bytes at the beginning as compared to the
    // base64-decoded representation/ of the same key when imported to
    // fetchd (`fetchd keys add --recover`) and shown (`fetchd keys show`).
    // Inspired from https://github.com/bryanchriswhite/fetchai-ledger-subquery/blob/main/src/mappings/primitives.ts#L71
    pk = pubKey.slice(2);
  }

  if (pk.length !== 33) {
    throw new Error(`Invalid Secp256k1 pub key length: ${pk.length}`);
  }

  return ripemd160(sha256(pk));
}

function pubKeyToRawAddress(type: string, pubKey: Uint8Array, prefix?: string): string {
  switch (type) {
    case Ed25519:
      return toHex(rawEd25519PubKeyToRawAddress(pubKey)).toUpperCase();
    case Secp256k1:
      if (isEmpty(prefix) || isNil(prefix)) {
        throw new Error("Bench32 Prefix should not be empty");
      }
      return toBech32(prefix, rawSecp256k1PubKeyToRawAddress(pubKey));
    default:
      // Keep this case here to guard against new types being added but not handled
      throw new Error(`pubKey type ${type} not supported`);
  }
}

export function base64PubKeyToAddress(type: string, base64PubKey: string, prefix?: string): string {
  return pubKeyToRawAddress(type, fromBase64(base64PubKey), prefix);
}

export function pubKeyToAddress(type: string, pubKey: Uint8Array, prefix?: string): string {
  return pubKeyToRawAddress(type, pubKey, prefix);
}
