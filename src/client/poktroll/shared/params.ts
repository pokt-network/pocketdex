// Code generated by protoc-gen-ts_proto. DO NOT EDIT.
// versions:
//   protoc-gen-ts_proto  v2.6.1
//   protoc               unknown
// source: poktroll/shared/params.proto

/* eslint-disable */
import { BinaryReader, BinaryWriter } from "@bufbuild/protobuf/wire";

export const protobufPackage = "poktroll.shared";

/** Params defines the parameters for the module. */
export interface Params {
  /** num_blocks_per_session is the number of blocks between the session start & end heights. */
  numBlocksPerSession: number;
  /**
   * grace_period_end_offset_blocks is the number of blocks, after the session end height,
   * during which the supplier can still service payable relays.
   * Suppliers will need to recreate a claim for the previous session (if already created) to
   * get paid for the additional relays.
   */
  gracePeriodEndOffsetBlocks: number;
  /**
   * claim_window_open_offset_blocks is the number of blocks after the session grace
   * period height, at which the claim window opens.
   */
  claimWindowOpenOffsetBlocks: number;
  /**
   * claim_window_close_offset_blocks is the number of blocks after the claim window
   * open height, at which the claim window closes.
   */
  claimWindowCloseOffsetBlocks: number;
  /**
   * proof_window_open_offset_blocks is the number of blocks after the claim window
   * close height, at which the proof window opens.
   */
  proofWindowOpenOffsetBlocks: number;
  /**
   * proof_window_close_offset_blocks is the number of blocks after the proof window
   * open height, at which the proof window closes.
   */
  proofWindowCloseOffsetBlocks: number;
  /**
   * supplier_unbonding_period_sessions is the number of sessions that a supplier must wait after
   * unstaking before their staked assets are moved to their account balance.
   * Onchain business logic requires, and ensures, that the corresponding block count of the unbonding
   * period will exceed the end of any active claim & proof lifecycles.
   */
  supplierUnbondingPeriodSessions: number;
  /**
   * application_unbonding_period_sessions is the number of sessions that an application must wait after
   * unstaking before their staked assets are moved to their account balance.
   * Onchain business logic requires, and ensures, that the corresponding block count of the
   * application unbonding period will exceed the end of its corresponding proof window close height.
   */
  applicationUnbondingPeriodSessions: number;
  /**
   * The amount of upokt that a compute unit should translate to when settling a session.
   * DEV_NOTE: This used to be under x/tokenomics but has been moved here to avoid cyclic dependencies.
   */
  computeUnitsToTokensMultiplier: number;
  /**
   * gateway_unbonding_period_sessions is the number of sessions that a gateway must wait after
   * unstaking before their staked assets are moved to its account balance.
   */
  gatewayUnbondingPeriodSessions: number;
}

function createBaseParams(): Params {
  return {
    numBlocksPerSession: 0,
    gracePeriodEndOffsetBlocks: 0,
    claimWindowOpenOffsetBlocks: 0,
    claimWindowCloseOffsetBlocks: 0,
    proofWindowOpenOffsetBlocks: 0,
    proofWindowCloseOffsetBlocks: 0,
    supplierUnbondingPeriodSessions: 0,
    applicationUnbondingPeriodSessions: 0,
    computeUnitsToTokensMultiplier: 0,
    gatewayUnbondingPeriodSessions: 0,
  };
}

export const Params: MessageFns<Params> = {
  encode(message: Params, writer: BinaryWriter = new BinaryWriter()): BinaryWriter {
    if (message.numBlocksPerSession !== 0) {
      writer.uint32(8).uint64(message.numBlocksPerSession);
    }
    if (message.gracePeriodEndOffsetBlocks !== 0) {
      writer.uint32(16).uint64(message.gracePeriodEndOffsetBlocks);
    }
    if (message.claimWindowOpenOffsetBlocks !== 0) {
      writer.uint32(24).uint64(message.claimWindowOpenOffsetBlocks);
    }
    if (message.claimWindowCloseOffsetBlocks !== 0) {
      writer.uint32(32).uint64(message.claimWindowCloseOffsetBlocks);
    }
    if (message.proofWindowOpenOffsetBlocks !== 0) {
      writer.uint32(40).uint64(message.proofWindowOpenOffsetBlocks);
    }
    if (message.proofWindowCloseOffsetBlocks !== 0) {
      writer.uint32(48).uint64(message.proofWindowCloseOffsetBlocks);
    }
    if (message.supplierUnbondingPeriodSessions !== 0) {
      writer.uint32(56).uint64(message.supplierUnbondingPeriodSessions);
    }
    if (message.applicationUnbondingPeriodSessions !== 0) {
      writer.uint32(64).uint64(message.applicationUnbondingPeriodSessions);
    }
    if (message.computeUnitsToTokensMultiplier !== 0) {
      writer.uint32(72).uint64(message.computeUnitsToTokensMultiplier);
    }
    if (message.gatewayUnbondingPeriodSessions !== 0) {
      writer.uint32(80).uint64(message.gatewayUnbondingPeriodSessions);
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

          message.numBlocksPerSession = longToNumber(reader.uint64());
          continue;
        }
        case 2: {
          if (tag !== 16) {
            break;
          }

          message.gracePeriodEndOffsetBlocks = longToNumber(reader.uint64());
          continue;
        }
        case 3: {
          if (tag !== 24) {
            break;
          }

          message.claimWindowOpenOffsetBlocks = longToNumber(reader.uint64());
          continue;
        }
        case 4: {
          if (tag !== 32) {
            break;
          }

          message.claimWindowCloseOffsetBlocks = longToNumber(reader.uint64());
          continue;
        }
        case 5: {
          if (tag !== 40) {
            break;
          }

          message.proofWindowOpenOffsetBlocks = longToNumber(reader.uint64());
          continue;
        }
        case 6: {
          if (tag !== 48) {
            break;
          }

          message.proofWindowCloseOffsetBlocks = longToNumber(reader.uint64());
          continue;
        }
        case 7: {
          if (tag !== 56) {
            break;
          }

          message.supplierUnbondingPeriodSessions = longToNumber(reader.uint64());
          continue;
        }
        case 8: {
          if (tag !== 64) {
            break;
          }

          message.applicationUnbondingPeriodSessions = longToNumber(reader.uint64());
          continue;
        }
        case 9: {
          if (tag !== 72) {
            break;
          }

          message.computeUnitsToTokensMultiplier = longToNumber(reader.uint64());
          continue;
        }
        case 10: {
          if (tag !== 80) {
            break;
          }

          message.gatewayUnbondingPeriodSessions = longToNumber(reader.uint64());
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
      numBlocksPerSession: isSet(object.numBlocksPerSession) ? globalThis.Number(object.numBlocksPerSession) : 0,
      gracePeriodEndOffsetBlocks: isSet(object.gracePeriodEndOffsetBlocks)
        ? globalThis.Number(object.gracePeriodEndOffsetBlocks)
        : 0,
      claimWindowOpenOffsetBlocks: isSet(object.claimWindowOpenOffsetBlocks)
        ? globalThis.Number(object.claimWindowOpenOffsetBlocks)
        : 0,
      claimWindowCloseOffsetBlocks: isSet(object.claimWindowCloseOffsetBlocks)
        ? globalThis.Number(object.claimWindowCloseOffsetBlocks)
        : 0,
      proofWindowOpenOffsetBlocks: isSet(object.proofWindowOpenOffsetBlocks)
        ? globalThis.Number(object.proofWindowOpenOffsetBlocks)
        : 0,
      proofWindowCloseOffsetBlocks: isSet(object.proofWindowCloseOffsetBlocks)
        ? globalThis.Number(object.proofWindowCloseOffsetBlocks)
        : 0,
      supplierUnbondingPeriodSessions: isSet(object.supplierUnbondingPeriodSessions)
        ? globalThis.Number(object.supplierUnbondingPeriodSessions)
        : 0,
      applicationUnbondingPeriodSessions: isSet(object.applicationUnbondingPeriodSessions)
        ? globalThis.Number(object.applicationUnbondingPeriodSessions)
        : 0,
      computeUnitsToTokensMultiplier: isSet(object.computeUnitsToTokensMultiplier)
        ? globalThis.Number(object.computeUnitsToTokensMultiplier)
        : 0,
      gatewayUnbondingPeriodSessions: isSet(object.gatewayUnbondingPeriodSessions)
        ? globalThis.Number(object.gatewayUnbondingPeriodSessions)
        : 0,
    };
  },

  toJSON(message: Params): unknown {
    const obj: any = {};
    if (message.numBlocksPerSession !== 0) {
      obj.numBlocksPerSession = Math.round(message.numBlocksPerSession);
    }
    if (message.gracePeriodEndOffsetBlocks !== 0) {
      obj.gracePeriodEndOffsetBlocks = Math.round(message.gracePeriodEndOffsetBlocks);
    }
    if (message.claimWindowOpenOffsetBlocks !== 0) {
      obj.claimWindowOpenOffsetBlocks = Math.round(message.claimWindowOpenOffsetBlocks);
    }
    if (message.claimWindowCloseOffsetBlocks !== 0) {
      obj.claimWindowCloseOffsetBlocks = Math.round(message.claimWindowCloseOffsetBlocks);
    }
    if (message.proofWindowOpenOffsetBlocks !== 0) {
      obj.proofWindowOpenOffsetBlocks = Math.round(message.proofWindowOpenOffsetBlocks);
    }
    if (message.proofWindowCloseOffsetBlocks !== 0) {
      obj.proofWindowCloseOffsetBlocks = Math.round(message.proofWindowCloseOffsetBlocks);
    }
    if (message.supplierUnbondingPeriodSessions !== 0) {
      obj.supplierUnbondingPeriodSessions = Math.round(message.supplierUnbondingPeriodSessions);
    }
    if (message.applicationUnbondingPeriodSessions !== 0) {
      obj.applicationUnbondingPeriodSessions = Math.round(message.applicationUnbondingPeriodSessions);
    }
    if (message.computeUnitsToTokensMultiplier !== 0) {
      obj.computeUnitsToTokensMultiplier = Math.round(message.computeUnitsToTokensMultiplier);
    }
    if (message.gatewayUnbondingPeriodSessions !== 0) {
      obj.gatewayUnbondingPeriodSessions = Math.round(message.gatewayUnbondingPeriodSessions);
    }
    return obj;
  },

  create<I extends Exact<DeepPartial<Params>, I>>(base?: I): Params {
    return Params.fromPartial(base ?? ({} as any));
  },
  fromPartial<I extends Exact<DeepPartial<Params>, I>>(object: I): Params {
    const message = createBaseParams();
    message.numBlocksPerSession = object.numBlocksPerSession ?? 0;
    message.gracePeriodEndOffsetBlocks = object.gracePeriodEndOffsetBlocks ?? 0;
    message.claimWindowOpenOffsetBlocks = object.claimWindowOpenOffsetBlocks ?? 0;
    message.claimWindowCloseOffsetBlocks = object.claimWindowCloseOffsetBlocks ?? 0;
    message.proofWindowOpenOffsetBlocks = object.proofWindowOpenOffsetBlocks ?? 0;
    message.proofWindowCloseOffsetBlocks = object.proofWindowCloseOffsetBlocks ?? 0;
    message.supplierUnbondingPeriodSessions = object.supplierUnbondingPeriodSessions ?? 0;
    message.applicationUnbondingPeriodSessions = object.applicationUnbondingPeriodSessions ?? 0;
    message.computeUnitsToTokensMultiplier = object.computeUnitsToTokensMultiplier ?? 0;
    message.gatewayUnbondingPeriodSessions = object.gatewayUnbondingPeriodSessions ?? 0;
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
