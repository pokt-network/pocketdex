// Code generated by protoc-gen-ts_proto. DO NOT EDIT.
// versions:
//   protoc-gen-ts_proto  v2.6.1
//   protoc               unknown
// source: cosmos/counter/v1/tx.proto

/* eslint-disable */
import { BinaryReader, BinaryWriter } from "@bufbuild/protobuf/wire";

export const protobufPackage = "cosmos.counter.v1";

/** MsgIncreaseCounter defines a count Msg service counter. */
export interface MsgIncreaseCounter {
  /** signer is the address that controls the module (defaults to x/gov unless overwritten). */
  signer: string;
  /** count is the number of times to increment the counter. */
  count: number;
}

/** MsgIncreaseCountResponse is the Msg/Counter response type. */
export interface MsgIncreaseCountResponse {
  /** new_count is the number of times the counter was incremented. */
  newCount: number;
}

function createBaseMsgIncreaseCounter(): MsgIncreaseCounter {
  return { signer: "", count: 0 };
}

export const MsgIncreaseCounter: MessageFns<MsgIncreaseCounter> = {
  encode(message: MsgIncreaseCounter, writer: BinaryWriter = new BinaryWriter()): BinaryWriter {
    if (message.signer !== "") {
      writer.uint32(10).string(message.signer);
    }
    if (message.count !== 0) {
      writer.uint32(16).int64(message.count);
    }
    return writer;
  },

  decode(input: BinaryReader | Uint8Array, length?: number): MsgIncreaseCounter {
    const reader = input instanceof BinaryReader ? input : new BinaryReader(input);
    let end = length === undefined ? reader.len : reader.pos + length;
    const message = createBaseMsgIncreaseCounter();
    while (reader.pos < end) {
      const tag = reader.uint32();
      switch (tag >>> 3) {
        case 1: {
          if (tag !== 10) {
            break;
          }

          message.signer = reader.string();
          continue;
        }
        case 2: {
          if (tag !== 16) {
            break;
          }

          message.count = longToNumber(reader.int64());
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

  fromJSON(object: any): MsgIncreaseCounter {
    return {
      signer: isSet(object.signer) ? globalThis.String(object.signer) : "",
      count: isSet(object.count) ? globalThis.Number(object.count) : 0,
    };
  },

  toJSON(message: MsgIncreaseCounter): unknown {
    const obj: any = {};
    if (message.signer !== "") {
      obj.signer = message.signer;
    }
    if (message.count !== 0) {
      obj.count = Math.round(message.count);
    }
    return obj;
  },

  create<I extends Exact<DeepPartial<MsgIncreaseCounter>, I>>(base?: I): MsgIncreaseCounter {
    return MsgIncreaseCounter.fromPartial(base ?? ({} as any));
  },
  fromPartial<I extends Exact<DeepPartial<MsgIncreaseCounter>, I>>(object: I): MsgIncreaseCounter {
    const message = createBaseMsgIncreaseCounter();
    message.signer = object.signer ?? "";
    message.count = object.count ?? 0;
    return message;
  },
};

function createBaseMsgIncreaseCountResponse(): MsgIncreaseCountResponse {
  return { newCount: 0 };
}

export const MsgIncreaseCountResponse: MessageFns<MsgIncreaseCountResponse> = {
  encode(message: MsgIncreaseCountResponse, writer: BinaryWriter = new BinaryWriter()): BinaryWriter {
    if (message.newCount !== 0) {
      writer.uint32(8).int64(message.newCount);
    }
    return writer;
  },

  decode(input: BinaryReader | Uint8Array, length?: number): MsgIncreaseCountResponse {
    const reader = input instanceof BinaryReader ? input : new BinaryReader(input);
    let end = length === undefined ? reader.len : reader.pos + length;
    const message = createBaseMsgIncreaseCountResponse();
    while (reader.pos < end) {
      const tag = reader.uint32();
      switch (tag >>> 3) {
        case 1: {
          if (tag !== 8) {
            break;
          }

          message.newCount = longToNumber(reader.int64());
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

  fromJSON(object: any): MsgIncreaseCountResponse {
    return { newCount: isSet(object.newCount) ? globalThis.Number(object.newCount) : 0 };
  },

  toJSON(message: MsgIncreaseCountResponse): unknown {
    const obj: any = {};
    if (message.newCount !== 0) {
      obj.newCount = Math.round(message.newCount);
    }
    return obj;
  },

  create<I extends Exact<DeepPartial<MsgIncreaseCountResponse>, I>>(base?: I): MsgIncreaseCountResponse {
    return MsgIncreaseCountResponse.fromPartial(base ?? ({} as any));
  },
  fromPartial<I extends Exact<DeepPartial<MsgIncreaseCountResponse>, I>>(object: I): MsgIncreaseCountResponse {
    const message = createBaseMsgIncreaseCountResponse();
    message.newCount = object.newCount ?? 0;
    return message;
  },
};

/** Msg defines the counter Msg service. */
export interface Msg {
  /** IncreaseCount increments the counter by the specified amount. */
  IncreaseCount(request: MsgIncreaseCounter): Promise<MsgIncreaseCountResponse>;
}

export const MsgServiceName = "cosmos.counter.v1.Msg";
export class MsgClientImpl implements Msg {
  private readonly rpc: Rpc;
  private readonly service: string;
  constructor(rpc: Rpc, opts?: { service?: string }) {
    this.service = opts?.service || MsgServiceName;
    this.rpc = rpc;
    this.IncreaseCount = this.IncreaseCount.bind(this);
  }
  IncreaseCount(request: MsgIncreaseCounter): Promise<MsgIncreaseCountResponse> {
    const data = MsgIncreaseCounter.encode(request).finish();
    const promise = this.rpc.request(this.service, "IncreaseCount", data);
    return promise.then((data) => MsgIncreaseCountResponse.decode(new BinaryReader(data)));
  }
}

interface Rpc {
  request(service: string, method: string, data: Uint8Array): Promise<Uint8Array>;
}

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
