// Code generated by protoc-gen-ts_proto. DO NOT EDIT.
// versions:
//   protoc-gen-ts_proto  v2.6.1
//   protoc               unknown
// source: poktroll/service/genesis.proto

/* eslint-disable */
import { BinaryReader, BinaryWriter } from "@bufbuild/protobuf/wire";
import { Service } from "../shared/service";
import { Params } from "./params";
import { RelayMiningDifficulty } from "./relay_mining_difficulty";

export const protobufPackage = "poktroll.service";

/** GenesisState defines the service module's genesis state. */
export interface GenesisState {
  /** params defines all the parameters of the module. */
  params: Params | undefined;
  serviceList: Service[];
  relayMiningDifficultyList: RelayMiningDifficulty[];
}

function createBaseGenesisState(): GenesisState {
  return { params: undefined, serviceList: [], relayMiningDifficultyList: [] };
}

export const GenesisState: MessageFns<GenesisState> = {
  encode(message: GenesisState, writer: BinaryWriter = new BinaryWriter()): BinaryWriter {
    if (message.params !== undefined) {
      Params.encode(message.params, writer.uint32(10).fork()).join();
    }
    for (const v of message.serviceList) {
      Service.encode(v!, writer.uint32(18).fork()).join();
    }
    for (const v of message.relayMiningDifficultyList) {
      RelayMiningDifficulty.encode(v!, writer.uint32(26).fork()).join();
    }
    return writer;
  },

  decode(input: BinaryReader | Uint8Array, length?: number): GenesisState {
    const reader = input instanceof BinaryReader ? input : new BinaryReader(input);
    let end = length === undefined ? reader.len : reader.pos + length;
    const message = createBaseGenesisState();
    while (reader.pos < end) {
      const tag = reader.uint32();
      switch (tag >>> 3) {
        case 1: {
          if (tag !== 10) {
            break;
          }

          message.params = Params.decode(reader, reader.uint32());
          continue;
        }
        case 2: {
          if (tag !== 18) {
            break;
          }

          message.serviceList.push(Service.decode(reader, reader.uint32()));
          continue;
        }
        case 3: {
          if (tag !== 26) {
            break;
          }

          message.relayMiningDifficultyList.push(RelayMiningDifficulty.decode(reader, reader.uint32()));
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

  fromJSON(object: any): GenesisState {
    return {
      params: isSet(object.params) ? Params.fromJSON(object.params) : undefined,
      serviceList: globalThis.Array.isArray(object?.serviceList)
        ? object.serviceList.map((e: any) => Service.fromJSON(e))
        : [],
      relayMiningDifficultyList: globalThis.Array.isArray(object?.relayMiningDifficultyList)
        ? object.relayMiningDifficultyList.map((e: any) => RelayMiningDifficulty.fromJSON(e))
        : [],
    };
  },

  toJSON(message: GenesisState): unknown {
    const obj: any = {};
    if (message.params !== undefined) {
      obj.params = Params.toJSON(message.params);
    }
    if (message.serviceList?.length) {
      obj.serviceList = message.serviceList.map((e) => Service.toJSON(e));
    }
    if (message.relayMiningDifficultyList?.length) {
      obj.relayMiningDifficultyList = message.relayMiningDifficultyList.map((e) => RelayMiningDifficulty.toJSON(e));
    }
    return obj;
  },

  create<I extends Exact<DeepPartial<GenesisState>, I>>(base?: I): GenesisState {
    return GenesisState.fromPartial(base ?? ({} as any));
  },
  fromPartial<I extends Exact<DeepPartial<GenesisState>, I>>(object: I): GenesisState {
    const message = createBaseGenesisState();
    message.params = (object.params !== undefined && object.params !== null)
      ? Params.fromPartial(object.params)
      : undefined;
    message.serviceList = object.serviceList?.map((e) => Service.fromPartial(e)) || [];
    message.relayMiningDifficultyList =
      object.relayMiningDifficultyList?.map((e) => RelayMiningDifficulty.fromPartial(e)) || [];
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
