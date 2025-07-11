// Code generated by protoc-gen-ts_proto. DO NOT EDIT.
// versions:
//   protoc-gen-ts_proto  v2.6.1
//   protoc               unknown
// source: pocket/migration/params.proto

/* eslint-disable */
import { BinaryReader, BinaryWriter } from "@bufbuild/protobuf/wire";

export const protobufPackage = "pocket.migration";

/** Params defines the parameters for the module. */
export interface Params {
  /**
   * waive_morse_claim_gas_fees is a feature flag used to enable/disable the waiving of gas fees for txs that:
   * - Contain exactly one secp256k1 signer
   * - Contain at least one Morse account/actor claim messages
   * - Do not contain any other messages other than Morse account/actor claim messages
   */
  waiveMorseClaimGasFees: boolean;
  /**
   * allow_morse_account_import_overwrite is a feature flag which is used to enable/disable
   * the re-importing of Morse claimable accounts by the authority.
   * Such a re-import will:
   * - Ignore (i.e. leave) ALL claimed destination Shannon accounts/actors
   * - Delete ALL existing onchain MorseClaimableAccounts
   * - Import the new set of MorseClaimableAccounts from the provided MsgImportMorseClaimableAccounts
   * This is useful for testing purposes, but should be disabled in production.
   */
  allowMorseAccountImportOverwrite: boolean;
  /**
   * morse_account_claiming_enabled is a feature flag which is used to enable/disable the processing of Morse account/actor claim messages
   * (i.e. `MsgClaimMorseAccount`, `MorseClaimApplication`, and `MorseClaimSupplier`).
   */
  morseAccountClaimingEnabled: boolean;
}

function createBaseParams(): Params {
  return { waiveMorseClaimGasFees: false, allowMorseAccountImportOverwrite: false, morseAccountClaimingEnabled: false };
}

export const Params: MessageFns<Params> = {
  encode(message: Params, writer: BinaryWriter = new BinaryWriter()): BinaryWriter {
    if (message.waiveMorseClaimGasFees !== false) {
      writer.uint32(8).bool(message.waiveMorseClaimGasFees);
    }
    if (message.allowMorseAccountImportOverwrite !== false) {
      writer.uint32(16).bool(message.allowMorseAccountImportOverwrite);
    }
    if (message.morseAccountClaimingEnabled !== false) {
      writer.uint32(24).bool(message.morseAccountClaimingEnabled);
    }
    return writer;
  },

  decode(input: BinaryReader | Uint8Array, length?: number): Params {
    const reader = input instanceof BinaryReader ? input : new BinaryReader(input);
    let end = length === undefined ? reader.len : reader.pos + length;
    const message = createBaseParams();
    while (reader.pos < end) {
      const tag = reader.uint32();
      switch (tag >>> 3) {
        case 1: {
          if (tag !== 8) {
            break;
          }

          message.waiveMorseClaimGasFees = reader.bool();
          continue;
        }
        case 2: {
          if (tag !== 16) {
            break;
          }

          message.allowMorseAccountImportOverwrite = reader.bool();
          continue;
        }
        case 3: {
          if (tag !== 24) {
            break;
          }

          message.morseAccountClaimingEnabled = reader.bool();
          continue;
        }
      }
      if ((tag & 7) === 4 || tag === 0) {
        break;
      }
      reader.skip(tag & 7);
    }
    return message;
  },

  fromJSON(object: any): Params {
    return {
      waiveMorseClaimGasFees: isSet(object.waiveMorseClaimGasFees)
        ? globalThis.Boolean(object.waiveMorseClaimGasFees)
        : false,
      allowMorseAccountImportOverwrite: isSet(object.allowMorseAccountImportOverwrite)
        ? globalThis.Boolean(object.allowMorseAccountImportOverwrite)
        : false,
      morseAccountClaimingEnabled: isSet(object.morseAccountClaimingEnabled)
        ? globalThis.Boolean(object.morseAccountClaimingEnabled)
        : false,
    };
  },

  toJSON(message: Params): unknown {
    const obj: any = {};
    if (message.waiveMorseClaimGasFees !== false) {
      obj.waiveMorseClaimGasFees = message.waiveMorseClaimGasFees;
    }
    if (message.allowMorseAccountImportOverwrite !== false) {
      obj.allowMorseAccountImportOverwrite = message.allowMorseAccountImportOverwrite;
    }
    if (message.morseAccountClaimingEnabled !== false) {
      obj.morseAccountClaimingEnabled = message.morseAccountClaimingEnabled;
    }
    return obj;
  },

  create<I extends Exact<DeepPartial<Params>, I>>(base?: I): Params {
    return Params.fromPartial(base ?? ({} as any));
  },
  fromPartial<I extends Exact<DeepPartial<Params>, I>>(object: I): Params {
    const message = createBaseParams();
    message.waiveMorseClaimGasFees = object.waiveMorseClaimGasFees ?? false;
    message.allowMorseAccountImportOverwrite = object.allowMorseAccountImportOverwrite ?? false;
    message.morseAccountClaimingEnabled = object.morseAccountClaimingEnabled ?? false;
    return message;
  },
};

type Builtin = Date | Function | Uint8Array | string | number | boolean | undefined;

export type DeepPartial<T> = T extends Builtin ? T
  : T extends globalThis.Array<infer U> ? globalThis.Array<DeepPartial<U>>
  : T extends ReadonlyArray<infer U> ? ReadonlyArray<DeepPartial<U>>
  : T extends {} ? { [K in keyof T]?: DeepPartial<T[K]> }
  : Partial<T>;

type KeysOfUnion<T> = T extends T ? keyof T : never;
export type Exact<P, I extends P> = P extends Builtin ? P
  : P & { [K in keyof P]: Exact<P[K], I[K]> } & { [K in Exclude<keyof I, KeysOfUnion<P>>]: never };

function isSet(value: any): boolean {
  return value !== null && value !== undefined;
}

export interface MessageFns<T> {
  encode(message: T, writer?: BinaryWriter): BinaryWriter;
  decode(input: BinaryReader | Uint8Array, length?: number): T;
  fromJSON(object: any): T;
  toJSON(message: T): unknown;
  create<I extends Exact<DeepPartial<T>, I>>(base?: I): T;
  fromPartial<I extends Exact<DeepPartial<T>, I>>(object: I): T;
}
