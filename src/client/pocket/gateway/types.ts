// Code generated by protoc-gen-ts_proto. DO NOT EDIT.
// versions:
//   protoc-gen-ts_proto  v2.6.1
//   protoc               unknown
// source: pocket/gateway/types.proto

/* eslint-disable */
import { BinaryReader, BinaryWriter } from "@bufbuild/protobuf/wire";
import { Coin } from "../../cosmos/base/v1beta1/coin";

export const protobufPackage = "pocket.gateway";

export interface Gateway {
  /** The Bech32 address of the gateway */
  address: string;
  /** The total amount of uPOKT the gateway has staked */
  stake:
    | Coin
    | undefined;
  /** Session end height at which the gateway initiated unstaking (0 if not unstaking) */
  unstakeSessionEndHeight: number;
}

function createBaseGateway(): Gateway {
  return { address: "", stake: undefined, unstakeSessionEndHeight: 0 };
}

export const Gateway: MessageFns<Gateway> = {
  encode(message: Gateway, writer: BinaryWriter = new BinaryWriter()): BinaryWriter {
    if (message.address !== "") {
      writer.uint32(10).string(message.address);
    }
    if (message.stake !== undefined) {
      Coin.encode(message.stake, writer.uint32(18).fork()).join();
    }
    if (message.unstakeSessionEndHeight !== 0) {
      writer.uint32(24).uint64(message.unstakeSessionEndHeight);
    }
    return writer;
  },

  decode(input: BinaryReader | Uint8Array, length?: number): Gateway {
    const reader = input instanceof BinaryReader ? input : new BinaryReader(input);
    let end = length === undefined ? reader.len : reader.pos + length;
    const message = createBaseGateway();
    while (reader.pos < end) {
      const tag = reader.uint32();
      switch (tag >>> 3) {
        case 1: {
          if (tag !== 10) {
            break;
          }

          message.address = reader.string();
          continue;
        }
        case 2: {
          if (tag !== 18) {
            break;
          }

          message.stake = Coin.decode(reader, reader.uint32());
          continue;
        }
        case 3: {
          if (tag !== 24) {
            break;
          }

          message.unstakeSessionEndHeight = longToNumber(reader.uint64());
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

  fromJSON(object: any): Gateway {
    return {
      address: isSet(object.address) ? globalThis.String(object.address) : "",
      stake: isSet(object.stake) ? Coin.fromJSON(object.stake) : undefined,
      unstakeSessionEndHeight: isSet(object.unstakeSessionEndHeight)
        ? globalThis.Number(object.unstakeSessionEndHeight)
        : 0,
    };
  },

  toJSON(message: Gateway): unknown {
    const obj: any = {};
    if (message.address !== "") {
      obj.address = message.address;
    }
    if (message.stake !== undefined) {
      obj.stake = Coin.toJSON(message.stake);
    }
    if (message.unstakeSessionEndHeight !== 0) {
      obj.unstakeSessionEndHeight = Math.round(message.unstakeSessionEndHeight);
    }
    return obj;
  },

  create<I extends Exact<DeepPartial<Gateway>, I>>(base?: I): Gateway {
    return Gateway.fromPartial(base ?? ({} as any));
  },
  fromPartial<I extends Exact<DeepPartial<Gateway>, I>>(object: I): Gateway {
    const message = createBaseGateway();
    message.address = object.address ?? "";
    message.stake = (object.stake !== undefined && object.stake !== null) ? Coin.fromPartial(object.stake) : undefined;
    message.unstakeSessionEndHeight = object.unstakeSessionEndHeight ?? 0;
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

function longToNumber(int64: { toString(): string }): number {
  const num = globalThis.Number(int64.toString());
  if (num > globalThis.Number.MAX_SAFE_INTEGER) {
    throw new globalThis.Error("Value is larger than Number.MAX_SAFE_INTEGER");
  }
  if (num < globalThis.Number.MIN_SAFE_INTEGER) {
    throw new globalThis.Error("Value is smaller than Number.MIN_SAFE_INTEGER");
  }
  return num;
}

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
