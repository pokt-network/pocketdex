// Code generated by protoc-gen-ts_proto. DO NOT EDIT.
// versions:
//   protoc-gen-ts_proto  v2.6.1
//   protoc               unknown
// source: poktroll/gateway/event.proto

/* eslint-disable */
import { BinaryReader, BinaryWriter } from "@bufbuild/protobuf/wire";
import { Gateway } from "./types";

export const protobufPackage = "poktroll.gateway";

/** EventGatewayStaked is emitted when a gateway is staked or up-staked. */
export interface EventGatewayStaked {
  /** The gateway that has been staked. */
  gateway:
    | Gateway
    | undefined;
  /** The end height of the session in which gateway was staked. */
  sessionEndHeight: number;
}

/**
 * EventGatewayUnbondingBegin is emitted when a gateway begins unbonding.
 * It is triggered by the commitment of an unstake gateway message.
 * This event signals that a gateway has begun unbonding.
 * The unbonding period is determined by the shared param gateway_unbonding_period_sessions.
 */
export interface EventGatewayUnbondingBegin {
  gateway:
    | Gateway
    | undefined;
  /** The end height of the session in which the unbonding began. */
  sessionEndHeight: number;
  /** The height at which gateway unbonding will end. */
  unbondingEndHeight: number;
}

/**
 * EventGatewayUnbondingEnd is emitted when a gateway has completed unbonding.
 * The unbonding period is determined by the shared param gateway_unbonding_period_sessions.
 */
export interface EventGatewayUnbondingEnd {
  /** The gateway that has completed unbonding. */
  gateway:
    | Gateway
    | undefined;
  /** The end height of the session in which the unbonding began. */
  sessionEndHeight: number;
  /** The height at which gateway unbonding will end. */
  unbondingEndHeight: number;
}

/**
 * EventGatewayUnbondingCanceled is emitted when a gateway which was unbonding
 * successfully (re-)stakes before the unbonding period has elapsed.
 * An EventGatewayStaked event will also be emitted immediately after this event.
 */
export interface EventGatewayUnbondingCanceled {
  gateway:
    | Gateway
    | undefined;
  /** The end height of the session in which the unbonding was canceled. */
  sessionEndHeight: number;
}

function createBaseEventGatewayStaked(): EventGatewayStaked {
  return { gateway: undefined, sessionEndHeight: 0 };
}

export const EventGatewayStaked: MessageFns<EventGatewayStaked> = {
  encode(message: EventGatewayStaked, writer: BinaryWriter = new BinaryWriter()): BinaryWriter {
    if (message.gateway !== undefined) {
      Gateway.encode(message.gateway, writer.uint32(10).fork()).join();
    }
    if (message.sessionEndHeight !== 0) {
      writer.uint32(16).int64(message.sessionEndHeight);
    }
    return writer;
  },

  decode(input: BinaryReader | Uint8Array, length?: number): EventGatewayStaked {
    const reader = input instanceof BinaryReader ? input : new BinaryReader(input);
    let end = length === undefined ? reader.len : reader.pos + length;
    const message = createBaseEventGatewayStaked();
    while (reader.pos < end) {
      const tag = reader.uint32();
      switch (tag >>> 3) {
        case 1: {
          if (tag !== 10) {
            break;
          }

          message.gateway = Gateway.decode(reader, reader.uint32());
          continue;
        }
        case 2: {
          if (tag !== 16) {
            break;
          }

          message.sessionEndHeight = longToNumber(reader.int64());
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

  fromJSON(object: any): EventGatewayStaked {
    return {
      gateway: isSet(object.gateway) ? Gateway.fromJSON(object.gateway) : undefined,
      sessionEndHeight: isSet(object.sessionEndHeight) ? globalThis.Number(object.sessionEndHeight) : 0,
    };
  },

  toJSON(message: EventGatewayStaked): unknown {
    const obj: any = {};
    if (message.gateway !== undefined) {
      obj.gateway = Gateway.toJSON(message.gateway);
    }
    if (message.sessionEndHeight !== 0) {
      obj.sessionEndHeight = Math.round(message.sessionEndHeight);
    }
    return obj;
  },

  create<I extends Exact<DeepPartial<EventGatewayStaked>, I>>(base?: I): EventGatewayStaked {
    return EventGatewayStaked.fromPartial(base ?? ({} as any));
  },
  fromPartial<I extends Exact<DeepPartial<EventGatewayStaked>, I>>(object: I): EventGatewayStaked {
    const message = createBaseEventGatewayStaked();
    message.gateway = (object.gateway !== undefined && object.gateway !== null)
      ? Gateway.fromPartial(object.gateway)
      : undefined;
    message.sessionEndHeight = object.sessionEndHeight ?? 0;
    return message;
  },
};

function createBaseEventGatewayUnbondingBegin(): EventGatewayUnbondingBegin {
  return { gateway: undefined, sessionEndHeight: 0, unbondingEndHeight: 0 };
}

export const EventGatewayUnbondingBegin: MessageFns<EventGatewayUnbondingBegin> = {
  encode(message: EventGatewayUnbondingBegin, writer: BinaryWriter = new BinaryWriter()): BinaryWriter {
    if (message.gateway !== undefined) {
      Gateway.encode(message.gateway, writer.uint32(10).fork()).join();
    }
    if (message.sessionEndHeight !== 0) {
      writer.uint32(24).int64(message.sessionEndHeight);
    }
    if (message.unbondingEndHeight !== 0) {
      writer.uint32(32).int64(message.unbondingEndHeight);
    }
    return writer;
  },

  decode(input: BinaryReader | Uint8Array, length?: number): EventGatewayUnbondingBegin {
    const reader = input instanceof BinaryReader ? input : new BinaryReader(input);
    let end = length === undefined ? reader.len : reader.pos + length;
    const message = createBaseEventGatewayUnbondingBegin();
    while (reader.pos < end) {
      const tag = reader.uint32();
      switch (tag >>> 3) {
        case 1: {
          if (tag !== 10) {
            break;
          }

          message.gateway = Gateway.decode(reader, reader.uint32());
          continue;
        }
        case 3: {
          if (tag !== 24) {
            break;
          }

          message.sessionEndHeight = longToNumber(reader.int64());
          continue;
        }
        case 4: {
          if (tag !== 32) {
            break;
          }

          message.unbondingEndHeight = longToNumber(reader.int64());
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

  fromJSON(object: any): EventGatewayUnbondingBegin {
    return {
      gateway: isSet(object.gateway) ? Gateway.fromJSON(object.gateway) : undefined,
      sessionEndHeight: isSet(object.sessionEndHeight) ? globalThis.Number(object.sessionEndHeight) : 0,
      unbondingEndHeight: isSet(object.unbondingEndHeight) ? globalThis.Number(object.unbondingEndHeight) : 0,
    };
  },

  toJSON(message: EventGatewayUnbondingBegin): unknown {
    const obj: any = {};
    if (message.gateway !== undefined) {
      obj.gateway = Gateway.toJSON(message.gateway);
    }
    if (message.sessionEndHeight !== 0) {
      obj.sessionEndHeight = Math.round(message.sessionEndHeight);
    }
    if (message.unbondingEndHeight !== 0) {
      obj.unbondingEndHeight = Math.round(message.unbondingEndHeight);
    }
    return obj;
  },

  create<I extends Exact<DeepPartial<EventGatewayUnbondingBegin>, I>>(base?: I): EventGatewayUnbondingBegin {
    return EventGatewayUnbondingBegin.fromPartial(base ?? ({} as any));
  },
  fromPartial<I extends Exact<DeepPartial<EventGatewayUnbondingBegin>, I>>(object: I): EventGatewayUnbondingBegin {
    const message = createBaseEventGatewayUnbondingBegin();
    message.gateway = (object.gateway !== undefined && object.gateway !== null)
      ? Gateway.fromPartial(object.gateway)
      : undefined;
    message.sessionEndHeight = object.sessionEndHeight ?? 0;
    message.unbondingEndHeight = object.unbondingEndHeight ?? 0;
    return message;
  },
};

function createBaseEventGatewayUnbondingEnd(): EventGatewayUnbondingEnd {
  return { gateway: undefined, sessionEndHeight: 0, unbondingEndHeight: 0 };
}

export const EventGatewayUnbondingEnd: MessageFns<EventGatewayUnbondingEnd> = {
  encode(message: EventGatewayUnbondingEnd, writer: BinaryWriter = new BinaryWriter()): BinaryWriter {
    if (message.gateway !== undefined) {
      Gateway.encode(message.gateway, writer.uint32(10).fork()).join();
    }
    if (message.sessionEndHeight !== 0) {
      writer.uint32(24).int64(message.sessionEndHeight);
    }
    if (message.unbondingEndHeight !== 0) {
      writer.uint32(32).int64(message.unbondingEndHeight);
    }
    return writer;
  },

  decode(input: BinaryReader | Uint8Array, length?: number): EventGatewayUnbondingEnd {
    const reader = input instanceof BinaryReader ? input : new BinaryReader(input);
    let end = length === undefined ? reader.len : reader.pos + length;
    const message = createBaseEventGatewayUnbondingEnd();
    while (reader.pos < end) {
      const tag = reader.uint32();
      switch (tag >>> 3) {
        case 1: {
          if (tag !== 10) {
            break;
          }

          message.gateway = Gateway.decode(reader, reader.uint32());
          continue;
        }
        case 3: {
          if (tag !== 24) {
            break;
          }

          message.sessionEndHeight = longToNumber(reader.int64());
          continue;
        }
        case 4: {
          if (tag !== 32) {
            break;
          }

          message.unbondingEndHeight = longToNumber(reader.int64());
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

  fromJSON(object: any): EventGatewayUnbondingEnd {
    return {
      gateway: isSet(object.gateway) ? Gateway.fromJSON(object.gateway) : undefined,
      sessionEndHeight: isSet(object.sessionEndHeight) ? globalThis.Number(object.sessionEndHeight) : 0,
      unbondingEndHeight: isSet(object.unbondingEndHeight) ? globalThis.Number(object.unbondingEndHeight) : 0,
    };
  },

  toJSON(message: EventGatewayUnbondingEnd): unknown {
    const obj: any = {};
    if (message.gateway !== undefined) {
      obj.gateway = Gateway.toJSON(message.gateway);
    }
    if (message.sessionEndHeight !== 0) {
      obj.sessionEndHeight = Math.round(message.sessionEndHeight);
    }
    if (message.unbondingEndHeight !== 0) {
      obj.unbondingEndHeight = Math.round(message.unbondingEndHeight);
    }
    return obj;
  },

  create<I extends Exact<DeepPartial<EventGatewayUnbondingEnd>, I>>(base?: I): EventGatewayUnbondingEnd {
    return EventGatewayUnbondingEnd.fromPartial(base ?? ({} as any));
  },
  fromPartial<I extends Exact<DeepPartial<EventGatewayUnbondingEnd>, I>>(object: I): EventGatewayUnbondingEnd {
    const message = createBaseEventGatewayUnbondingEnd();
    message.gateway = (object.gateway !== undefined && object.gateway !== null)
      ? Gateway.fromPartial(object.gateway)
      : undefined;
    message.sessionEndHeight = object.sessionEndHeight ?? 0;
    message.unbondingEndHeight = object.unbondingEndHeight ?? 0;
    return message;
  },
};

function createBaseEventGatewayUnbondingCanceled(): EventGatewayUnbondingCanceled {
  return { gateway: undefined, sessionEndHeight: 0 };
}

export const EventGatewayUnbondingCanceled: MessageFns<EventGatewayUnbondingCanceled> = {
  encode(message: EventGatewayUnbondingCanceled, writer: BinaryWriter = new BinaryWriter()): BinaryWriter {
    if (message.gateway !== undefined) {
      Gateway.encode(message.gateway, writer.uint32(10).fork()).join();
    }
    if (message.sessionEndHeight !== 0) {
      writer.uint32(16).int64(message.sessionEndHeight);
    }
    return writer;
  },

  decode(input: BinaryReader | Uint8Array, length?: number): EventGatewayUnbondingCanceled {
    const reader = input instanceof BinaryReader ? input : new BinaryReader(input);
    let end = length === undefined ? reader.len : reader.pos + length;
    const message = createBaseEventGatewayUnbondingCanceled();
    while (reader.pos < end) {
      const tag = reader.uint32();
      switch (tag >>> 3) {
        case 1: {
          if (tag !== 10) {
            break;
          }

          message.gateway = Gateway.decode(reader, reader.uint32());
          continue;
        }
        case 2: {
          if (tag !== 16) {
            break;
          }

          message.sessionEndHeight = longToNumber(reader.int64());
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

  fromJSON(object: any): EventGatewayUnbondingCanceled {
    return {
      gateway: isSet(object.gateway) ? Gateway.fromJSON(object.gateway) : undefined,
      sessionEndHeight: isSet(object.sessionEndHeight) ? globalThis.Number(object.sessionEndHeight) : 0,
    };
  },

  toJSON(message: EventGatewayUnbondingCanceled): unknown {
    const obj: any = {};
    if (message.gateway !== undefined) {
      obj.gateway = Gateway.toJSON(message.gateway);
    }
    if (message.sessionEndHeight !== 0) {
      obj.sessionEndHeight = Math.round(message.sessionEndHeight);
    }
    return obj;
  },

  create<I extends Exact<DeepPartial<EventGatewayUnbondingCanceled>, I>>(base?: I): EventGatewayUnbondingCanceled {
    return EventGatewayUnbondingCanceled.fromPartial(base ?? ({} as any));
  },
  fromPartial<I extends Exact<DeepPartial<EventGatewayUnbondingCanceled>, I>>(
    object: I,
  ): EventGatewayUnbondingCanceled {
    const message = createBaseEventGatewayUnbondingCanceled();
    message.gateway = (object.gateway !== undefined && object.gateway !== null)
      ? Gateway.fromPartial(object.gateway)
      : undefined;
    message.sessionEndHeight = object.sessionEndHeight ?? 0;
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
