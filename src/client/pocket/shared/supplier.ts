// Code generated by protoc-gen-ts_proto. DO NOT EDIT.
// versions:
//   protoc-gen-ts_proto  v2.6.1
//   protoc               unknown
// source: pocket/shared/supplier.proto

/* eslint-disable */
import { BinaryReader, BinaryWriter } from "@bufbuild/protobuf/wire";
import { Coin } from "../../cosmos/base/v1beta1/coin";
import { SupplierServiceConfig } from "./service";

export const protobufPackage = "pocket.shared";

/** Supplier represents an actor in Pocket Network that provides RPC services */
export interface Supplier {
  /**
   * Owner address that controls the staked funds and receives rewards by default
   * Cannot be updated by the operator
   */
  ownerAddress: string;
  /**
   * Operator address managing the offchain server
   * Immutable for supplier's lifespan - requires unstake/re-stake to change.
   * Can update supplier configs except for owner address.
   */
  operatorAddress: string;
  /** Total amount of staked uPOKT */
  stake:
    | Coin
    | undefined;
  /** List of service configurations supported by this supplier */
  services: SupplierServiceConfig[];
  /** Session end height when supplier initiated unstaking (0 if not unstaking) */
  unstakeSessionEndHeight: number;
  /**
   * List of historical service configuration updates, tracking the suppliers
   * services update and corresponding activation heights.
   */
  serviceConfigHistory: ServiceConfigUpdate[];
}

/**
 * ServiceConfigUpdate tracks a change in a supplier's service configurations
 * at a specific block height, enabling tracking of configuration changes over time.
 */
export interface ServiceConfigUpdate {
  /** List of service configurations after the update was applied. */
  services: SupplierServiceConfig[];
  /**
   * Block height at which this service configuration update takes effect,
   * aligned with the session start height.
   */
  effectiveBlockHeight: number;
}

function createBaseSupplier(): Supplier {
  return {
    ownerAddress: "",
    operatorAddress: "",
    stake: undefined,
    services: [],
    unstakeSessionEndHeight: 0,
    serviceConfigHistory: [],
  };
}

export const Supplier: MessageFns<Supplier> = {
  encode(message: Supplier, writer: BinaryWriter = new BinaryWriter()): BinaryWriter {
    if (message.ownerAddress !== "") {
      writer.uint32(10).string(message.ownerAddress);
    }
    if (message.operatorAddress !== "") {
      writer.uint32(18).string(message.operatorAddress);
    }
    if (message.stake !== undefined) {
      Coin.encode(message.stake, writer.uint32(26).fork()).join();
    }
    for (const v of message.services) {
      SupplierServiceConfig.encode(v!, writer.uint32(34).fork()).join();
    }
    if (message.unstakeSessionEndHeight !== 0) {
      writer.uint32(40).uint64(message.unstakeSessionEndHeight);
    }
    for (const v of message.serviceConfigHistory) {
      ServiceConfigUpdate.encode(v!, writer.uint32(50).fork()).join();
    }
    return writer;
  },

  decode(input: BinaryReader | Uint8Array, length?: number): Supplier {
    const reader = input instanceof BinaryReader ? input : new BinaryReader(input);
    let end = length === undefined ? reader.len : reader.pos + length;
    const message = createBaseSupplier();
    while (reader.pos < end) {
      const tag = reader.uint32();
      switch (tag >>> 3) {
        case 1: {
          if (tag !== 10) {
            break;
          }

          message.ownerAddress = reader.string();
          continue;
        }
        case 2: {
          if (tag !== 18) {
            break;
          }

          message.operatorAddress = reader.string();
          continue;
        }
        case 3: {
          if (tag !== 26) {
            break;
          }

          message.stake = Coin.decode(reader, reader.uint32());
          continue;
        }
        case 4: {
          if (tag !== 34) {
            break;
          }

          message.services.push(SupplierServiceConfig.decode(reader, reader.uint32()));
          continue;
        }
        case 5: {
          if (tag !== 40) {
            break;
          }

          message.unstakeSessionEndHeight = longToNumber(reader.uint64());
          continue;
        }
        case 6: {
          if (tag !== 50) {
            break;
          }

          message.serviceConfigHistory.push(ServiceConfigUpdate.decode(reader, reader.uint32()));
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

  fromJSON(object: any): Supplier {
    return {
      ownerAddress: isSet(object.ownerAddress) ? globalThis.String(object.ownerAddress) : "",
      operatorAddress: isSet(object.operatorAddress) ? globalThis.String(object.operatorAddress) : "",
      stake: isSet(object.stake) ? Coin.fromJSON(object.stake) : undefined,
      services: globalThis.Array.isArray(object?.services)
        ? object.services.map((e: any) => SupplierServiceConfig.fromJSON(e))
        : [],
      unstakeSessionEndHeight: isSet(object.unstakeSessionEndHeight)
        ? globalThis.Number(object.unstakeSessionEndHeight)
        : 0,
      serviceConfigHistory: globalThis.Array.isArray(object?.serviceConfigHistory)
        ? object.serviceConfigHistory.map((e: any) => ServiceConfigUpdate.fromJSON(e))
        : [],
    };
  },

  toJSON(message: Supplier): unknown {
    const obj: any = {};
    if (message.ownerAddress !== "") {
      obj.ownerAddress = message.ownerAddress;
    }
    if (message.operatorAddress !== "") {
      obj.operatorAddress = message.operatorAddress;
    }
    if (message.stake !== undefined) {
      obj.stake = Coin.toJSON(message.stake);
    }
    if (message.services?.length) {
      obj.services = message.services.map((e) => SupplierServiceConfig.toJSON(e));
    }
    if (message.unstakeSessionEndHeight !== 0) {
      obj.unstakeSessionEndHeight = Math.round(message.unstakeSessionEndHeight);
    }
    if (message.serviceConfigHistory?.length) {
      obj.serviceConfigHistory = message.serviceConfigHistory.map((e) => ServiceConfigUpdate.toJSON(e));
    }
    return obj;
  },

  create<I extends Exact<DeepPartial<Supplier>, I>>(base?: I): Supplier {
    return Supplier.fromPartial(base ?? ({} as any));
  },
  fromPartial<I extends Exact<DeepPartial<Supplier>, I>>(object: I): Supplier {
    const message = createBaseSupplier();
    message.ownerAddress = object.ownerAddress ?? "";
    message.operatorAddress = object.operatorAddress ?? "";
    message.stake = (object.stake !== undefined && object.stake !== null) ? Coin.fromPartial(object.stake) : undefined;
    message.services = object.services?.map((e) => SupplierServiceConfig.fromPartial(e)) || [];
    message.unstakeSessionEndHeight = object.unstakeSessionEndHeight ?? 0;
    message.serviceConfigHistory = object.serviceConfigHistory?.map((e) => ServiceConfigUpdate.fromPartial(e)) || [];
    return message;
  },
};

function createBaseServiceConfigUpdate(): ServiceConfigUpdate {
  return { services: [], effectiveBlockHeight: 0 };
}

export const ServiceConfigUpdate: MessageFns<ServiceConfigUpdate> = {
  encode(message: ServiceConfigUpdate, writer: BinaryWriter = new BinaryWriter()): BinaryWriter {
    for (const v of message.services) {
      SupplierServiceConfig.encode(v!, writer.uint32(10).fork()).join();
    }
    if (message.effectiveBlockHeight !== 0) {
      writer.uint32(16).uint64(message.effectiveBlockHeight);
    }
    return writer;
  },

  decode(input: BinaryReader | Uint8Array, length?: number): ServiceConfigUpdate {
    const reader = input instanceof BinaryReader ? input : new BinaryReader(input);
    let end = length === undefined ? reader.len : reader.pos + length;
    const message = createBaseServiceConfigUpdate();
    while (reader.pos < end) {
      const tag = reader.uint32();
      switch (tag >>> 3) {
        case 1: {
          if (tag !== 10) {
            break;
          }

          message.services.push(SupplierServiceConfig.decode(reader, reader.uint32()));
          continue;
        }
        case 2: {
          if (tag !== 16) {
            break;
          }

          message.effectiveBlockHeight = longToNumber(reader.uint64());
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

  fromJSON(object: any): ServiceConfigUpdate {
    return {
      services: globalThis.Array.isArray(object?.services)
        ? object.services.map((e: any) => SupplierServiceConfig.fromJSON(e))
        : [],
      effectiveBlockHeight: isSet(object.effectiveBlockHeight) ? globalThis.Number(object.effectiveBlockHeight) : 0,
    };
  },

  toJSON(message: ServiceConfigUpdate): unknown {
    const obj: any = {};
    if (message.services?.length) {
      obj.services = message.services.map((e) => SupplierServiceConfig.toJSON(e));
    }
    if (message.effectiveBlockHeight !== 0) {
      obj.effectiveBlockHeight = Math.round(message.effectiveBlockHeight);
    }
    return obj;
  },

  create<I extends Exact<DeepPartial<ServiceConfigUpdate>, I>>(base?: I): ServiceConfigUpdate {
    return ServiceConfigUpdate.fromPartial(base ?? ({} as any));
  },
  fromPartial<I extends Exact<DeepPartial<ServiceConfigUpdate>, I>>(object: I): ServiceConfigUpdate {
    const message = createBaseServiceConfigUpdate();
    message.services = object.services?.map((e) => SupplierServiceConfig.fromPartial(e)) || [];
    message.effectiveBlockHeight = object.effectiveBlockHeight ?? 0;
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
