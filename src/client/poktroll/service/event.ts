// Code generated by protoc-gen-ts_proto. DO NOT EDIT.
// versions:
//   protoc-gen-ts_proto  v2.6.1
//   protoc               unknown
// source: poktroll/service/event.proto

/* eslint-disable */
import { BinaryReader, BinaryWriter } from "@bufbuild/protobuf/wire";

export const protobufPackage = "poktroll.service";

/**
 * EventRelayMiningDifficultyUpdated is an event emitted whenever the relay mining difficulty is updated
 * for a given service.
 */
export interface EventRelayMiningDifficultyUpdated {
  serviceId: string;
  prevTargetHashHexEncoded: string;
  newTargetHashHexEncoded: string;
  prevNumRelaysEma: number;
  newNumRelaysEma: number;
}

function createBaseEventRelayMiningDifficultyUpdated(): EventRelayMiningDifficultyUpdated {
  return {
    serviceId: "",
    prevTargetHashHexEncoded: "",
    newTargetHashHexEncoded: "",
    prevNumRelaysEma: 0,
    newNumRelaysEma: 0,
  };
}

export const EventRelayMiningDifficultyUpdated: MessageFns<EventRelayMiningDifficultyUpdated> = {
  encode(message: EventRelayMiningDifficultyUpdated, writer: BinaryWriter = new BinaryWriter()): BinaryWriter {
    if (message.serviceId !== "") {
      writer.uint32(10).string(message.serviceId);
    }
    if (message.prevTargetHashHexEncoded !== "") {
      writer.uint32(18).string(message.prevTargetHashHexEncoded);
    }
    if (message.newTargetHashHexEncoded !== "") {
      writer.uint32(26).string(message.newTargetHashHexEncoded);
    }
    if (message.prevNumRelaysEma !== 0) {
      writer.uint32(32).uint64(message.prevNumRelaysEma);
    }
    if (message.newNumRelaysEma !== 0) {
      writer.uint32(40).uint64(message.newNumRelaysEma);
    }
    return writer;
  },

  decode(input: BinaryReader | Uint8Array, length?: number): EventRelayMiningDifficultyUpdated {
    const reader = input instanceof BinaryReader ? input : new BinaryReader(input);
    let end = length === undefined ? reader.len : reader.pos + length;
    const message = createBaseEventRelayMiningDifficultyUpdated();
    while (reader.pos < end) {
      const tag = reader.uint32();
      switch (tag >>> 3) {
        case 1: {
          if (tag !== 10) {
            break;
          }

          message.serviceId = reader.string();
          continue;
        }
        case 2: {
          if (tag !== 18) {
            break;
          }

          message.prevTargetHashHexEncoded = reader.string();
          continue;
        }
        case 3: {
          if (tag !== 26) {
            break;
          }

          message.newTargetHashHexEncoded = reader.string();
          continue;
        }
        case 4: {
          if (tag !== 32) {
            break;
          }

          message.prevNumRelaysEma = longToNumber(reader.uint64());
          continue;
        }
        case 5: {
          if (tag !== 40) {
            break;
          }

          message.newNumRelaysEma = longToNumber(reader.uint64());
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

  fromJSON(object: any): EventRelayMiningDifficultyUpdated {
    return {
      serviceId: isSet(object.serviceId) ? globalThis.String(object.serviceId) : "",
      prevTargetHashHexEncoded: isSet(object.prevTargetHashHexEncoded)
        ? globalThis.String(object.prevTargetHashHexEncoded)
        : "",
      newTargetHashHexEncoded: isSet(object.newTargetHashHexEncoded)
        ? globalThis.String(object.newTargetHashHexEncoded)
        : "",
      prevNumRelaysEma: isSet(object.prevNumRelaysEma) ? globalThis.Number(object.prevNumRelaysEma) : 0,
      newNumRelaysEma: isSet(object.newNumRelaysEma) ? globalThis.Number(object.newNumRelaysEma) : 0,
    };
  },

  toJSON(message: EventRelayMiningDifficultyUpdated): unknown {
    const obj: any = {};
    if (message.serviceId !== "") {
      obj.serviceId = message.serviceId;
    }
    if (message.prevTargetHashHexEncoded !== "") {
      obj.prevTargetHashHexEncoded = message.prevTargetHashHexEncoded;
    }
    if (message.newTargetHashHexEncoded !== "") {
      obj.newTargetHashHexEncoded = message.newTargetHashHexEncoded;
    }
    if (message.prevNumRelaysEma !== 0) {
      obj.prevNumRelaysEma = Math.round(message.prevNumRelaysEma);
    }
    if (message.newNumRelaysEma !== 0) {
      obj.newNumRelaysEma = Math.round(message.newNumRelaysEma);
    }
    return obj;
  },

  create<I extends Exact<DeepPartial<EventRelayMiningDifficultyUpdated>, I>>(
    base?: I,
  ): EventRelayMiningDifficultyUpdated {
    return EventRelayMiningDifficultyUpdated.fromPartial(base ?? ({} as any));
  },
  fromPartial<I extends Exact<DeepPartial<EventRelayMiningDifficultyUpdated>, I>>(
    object: I,
  ): EventRelayMiningDifficultyUpdated {
    const message = createBaseEventRelayMiningDifficultyUpdated();
    message.serviceId = object.serviceId ?? "";
    message.prevTargetHashHexEncoded = object.prevTargetHashHexEncoded ?? "";
    message.newTargetHashHexEncoded = object.newTargetHashHexEncoded ?? "";
    message.prevNumRelaysEma = object.prevNumRelaysEma ?? 0;
    message.newNumRelaysEma = object.newNumRelaysEma ?? 0;
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
