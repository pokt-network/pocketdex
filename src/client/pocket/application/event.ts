// Code generated by protoc-gen-ts_proto. DO NOT EDIT.
// versions:
//   protoc-gen-ts_proto  v2.6.1
//   protoc               unknown
// source: pocket/application/event.proto

/* eslint-disable */
import { BinaryReader, BinaryWriter } from "@bufbuild/protobuf/wire";
import { Application } from "./types";

export const protobufPackage = "pocket.application";

export enum ApplicationUnbondingReason {
  APPLICATION_UNBONDING_REASON_ELECTIVE = 0,
  APPLICATION_UNBONDING_REASON_BELOW_MIN_STAKE = 1,
  APPLICATION_UNBONDING_REASON_MIGRATION = 2,
  UNRECOGNIZED = -1,
}

export function applicationUnbondingReasonFromJSON(object: any): ApplicationUnbondingReason {
  switch (object) {
    case 0:
    case "APPLICATION_UNBONDING_REASON_ELECTIVE":
      return ApplicationUnbondingReason.APPLICATION_UNBONDING_REASON_ELECTIVE;
    case 1:
    case "APPLICATION_UNBONDING_REASON_BELOW_MIN_STAKE":
      return ApplicationUnbondingReason.APPLICATION_UNBONDING_REASON_BELOW_MIN_STAKE;
    case 2:
    case "APPLICATION_UNBONDING_REASON_MIGRATION":
      return ApplicationUnbondingReason.APPLICATION_UNBONDING_REASON_MIGRATION;
    case -1:
    case "UNRECOGNIZED":
    default:
      return ApplicationUnbondingReason.UNRECOGNIZED;
  }
}

export function applicationUnbondingReasonToJSON(object: ApplicationUnbondingReason): string {
  switch (object) {
    case ApplicationUnbondingReason.APPLICATION_UNBONDING_REASON_ELECTIVE:
      return "APPLICATION_UNBONDING_REASON_ELECTIVE";
    case ApplicationUnbondingReason.APPLICATION_UNBONDING_REASON_BELOW_MIN_STAKE:
      return "APPLICATION_UNBONDING_REASON_BELOW_MIN_STAKE";
    case ApplicationUnbondingReason.APPLICATION_UNBONDING_REASON_MIGRATION:
      return "APPLICATION_UNBONDING_REASON_MIGRATION";
    case ApplicationUnbondingReason.UNRECOGNIZED:
    default:
      return "UNRECOGNIZED";
  }
}

/** EventApplicationStaked is emitted when an application is staked or up-staked. */
export interface EventApplicationStaked {
  application:
    | Application
    | undefined;
  /** The end height of the session in which the application was staked. */
  sessionEndHeight: number;
}

/**
 * EventRedelegation is an event emitted whenever an application changes its
 * delegatee gateways on chain. This is in response to both a DelegateToGateway
 * and UndelegateFromGateway message.
 */
export interface EventRedelegation {
  /** The application which was redelegated. */
  application:
    | Application
    | undefined;
  /** The end height of the session in which the redelegation was committed. */
  sessionEndHeight: number;
}

/**
 * EventTransferBegin is emitted whenever an application begins a transfer. It
 * includes the source application state immediately after the transfer began.
 */
export interface EventTransferBegin {
  sourceAddress: string;
  destinationAddress: string;
  sourceApplication:
    | Application
    | undefined;
  /** The end height of the session in which the transfer began. */
  sessionEndHeight: number;
  /** The height at which the transfer will complete. */
  transferEndHeight: number;
}

/**
 * EventTransferEnd is emitted whenever an application transfer is completed. It
 * includes the destination application state at the time the transfer completed.
 * Either EventTransferEnd or EventTransferError will be emitted corresponding to
 * any given EventTransferBegin event.
 */
export interface EventTransferEnd {
  sourceAddress: string;
  destinationAddress: string;
  destinationApplication:
    | Application
    | undefined;
  /** The end height of the session in which the transfer ended. */
  sessionEndHeight: number;
  /** The height at which the transfer completed. */
  transferEndHeight: number;
}

/**
 * EventTransferError is emitted whenever an application transfer fails. It
 * includes the source application state at the time the transfer failed and
 * the error message.
 * Either EventTransferEnd or EventTransferError will be emitted corresponding to
 * any given EventTransferBegin event.
 */
export interface EventTransferError {
  sourceAddress: string;
  destinationAddress: string;
  sourceApplication:
    | Application
    | undefined;
  /** The end height of the session in which the transfer failed. */
  sessionEndHeight: number;
  error: string;
}

/**
 * EventApplicationUnbondingBegin is emitted when an application begins unbonding.
 * This can be triggered by the commitment of an unstake message or by the application's
 * stake dropping below the minimum. This event signals that an application has begun
 * unbonding. The unbonding period is determined by the shared param,
 * application_unbonding_period_sessions.
 */
export interface EventApplicationUnbondingBegin {
  application: Application | undefined;
  reason: ApplicationUnbondingReason;
  /** The end height of the session in which the unbonding began. */
  sessionEndHeight: number;
  /** The height at which application unbonding will end. */
  unbondingEndHeight: number;
}

/**
 * EventApplicationUnbondingEnd is emitted when an application has completed
 * unbonding. The unbonding period is determined by the shared param,
 * application_unbonding_period_sessions.
 */
export interface EventApplicationUnbondingEnd {
  application: Application | undefined;
  reason: ApplicationUnbondingReason;
  /** The end height of the session in which the unbonding ended. */
  sessionEndHeight: number;
  /** The height at which application unbonding ended. */
  unbondingEndHeight: number;
}

/**
 * EventApplicationUnbondingCanceled is emitted when an application which was unbonding
 * successfully (re-)stakes before the unbonding period has elapsed. An EventApplicationStaked
 * event will also be emitted immediately after this event.
 */
export interface EventApplicationUnbondingCanceled {
  application:
    | Application
    | undefined;
  /** The end height of the session in which the unbonding was canceled. */
  sessionEndHeight: number;
}

function createBaseEventApplicationStaked(): EventApplicationStaked {
  return { application: undefined, sessionEndHeight: 0 };
}

export const EventApplicationStaked: MessageFns<EventApplicationStaked> = {
  encode(message: EventApplicationStaked, writer: BinaryWriter = new BinaryWriter()): BinaryWriter {
    if (message.application !== undefined) {
      Application.encode(message.application, writer.uint32(10).fork()).join();
    }
    if (message.sessionEndHeight !== 0) {
      writer.uint32(16).int64(message.sessionEndHeight);
    }
    return writer;
  },

  decode(input: BinaryReader | Uint8Array, length?: number): EventApplicationStaked {
    const reader = input instanceof BinaryReader ? input : new BinaryReader(input);
    let end = length === undefined ? reader.len : reader.pos + length;
    const message = createBaseEventApplicationStaked();
    while (reader.pos < end) {
      const tag = reader.uint32();
      switch (tag >>> 3) {
        case 1: {
          if (tag !== 10) {
            break;
          }

          message.application = Application.decode(reader, reader.uint32());
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

  fromJSON(object: any): EventApplicationStaked {
    return {
      application: isSet(object.application) ? Application.fromJSON(object.application) : undefined,
      sessionEndHeight: isSet(object.sessionEndHeight) ? globalThis.Number(object.sessionEndHeight) : 0,
    };
  },

  toJSON(message: EventApplicationStaked): unknown {
    const obj: any = {};
    if (message.application !== undefined) {
      obj.application = Application.toJSON(message.application);
    }
    if (message.sessionEndHeight !== 0) {
      obj.sessionEndHeight = Math.round(message.sessionEndHeight);
    }
    return obj;
  },

  create<I extends Exact<DeepPartial<EventApplicationStaked>, I>>(base?: I): EventApplicationStaked {
    return EventApplicationStaked.fromPartial(base ?? ({} as any));
  },
  fromPartial<I extends Exact<DeepPartial<EventApplicationStaked>, I>>(object: I): EventApplicationStaked {
    const message = createBaseEventApplicationStaked();
    message.application = (object.application !== undefined && object.application !== null)
      ? Application.fromPartial(object.application)
      : undefined;
    message.sessionEndHeight = object.sessionEndHeight ?? 0;
    return message;
  },
};

function createBaseEventRedelegation(): EventRedelegation {
  return { application: undefined, sessionEndHeight: 0 };
}

export const EventRedelegation: MessageFns<EventRedelegation> = {
  encode(message: EventRedelegation, writer: BinaryWriter = new BinaryWriter()): BinaryWriter {
    if (message.application !== undefined) {
      Application.encode(message.application, writer.uint32(10).fork()).join();
    }
    if (message.sessionEndHeight !== 0) {
      writer.uint32(16).int64(message.sessionEndHeight);
    }
    return writer;
  },

  decode(input: BinaryReader | Uint8Array, length?: number): EventRedelegation {
    const reader = input instanceof BinaryReader ? input : new BinaryReader(input);
    let end = length === undefined ? reader.len : reader.pos + length;
    const message = createBaseEventRedelegation();
    while (reader.pos < end) {
      const tag = reader.uint32();
      switch (tag >>> 3) {
        case 1: {
          if (tag !== 10) {
            break;
          }

          message.application = Application.decode(reader, reader.uint32());
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

  fromJSON(object: any): EventRedelegation {
    return {
      application: isSet(object.application) ? Application.fromJSON(object.application) : undefined,
      sessionEndHeight: isSet(object.sessionEndHeight) ? globalThis.Number(object.sessionEndHeight) : 0,
    };
  },

  toJSON(message: EventRedelegation): unknown {
    const obj: any = {};
    if (message.application !== undefined) {
      obj.application = Application.toJSON(message.application);
    }
    if (message.sessionEndHeight !== 0) {
      obj.sessionEndHeight = Math.round(message.sessionEndHeight);
    }
    return obj;
  },

  create<I extends Exact<DeepPartial<EventRedelegation>, I>>(base?: I): EventRedelegation {
    return EventRedelegation.fromPartial(base ?? ({} as any));
  },
  fromPartial<I extends Exact<DeepPartial<EventRedelegation>, I>>(object: I): EventRedelegation {
    const message = createBaseEventRedelegation();
    message.application = (object.application !== undefined && object.application !== null)
      ? Application.fromPartial(object.application)
      : undefined;
    message.sessionEndHeight = object.sessionEndHeight ?? 0;
    return message;
  },
};

function createBaseEventTransferBegin(): EventTransferBegin {
  return {
    sourceAddress: "",
    destinationAddress: "",
    sourceApplication: undefined,
    sessionEndHeight: 0,
    transferEndHeight: 0,
  };
}

export const EventTransferBegin: MessageFns<EventTransferBegin> = {
  encode(message: EventTransferBegin, writer: BinaryWriter = new BinaryWriter()): BinaryWriter {
    if (message.sourceAddress !== "") {
      writer.uint32(10).string(message.sourceAddress);
    }
    if (message.destinationAddress !== "") {
      writer.uint32(18).string(message.destinationAddress);
    }
    if (message.sourceApplication !== undefined) {
      Application.encode(message.sourceApplication, writer.uint32(26).fork()).join();
    }
    if (message.sessionEndHeight !== 0) {
      writer.uint32(32).int64(message.sessionEndHeight);
    }
    if (message.transferEndHeight !== 0) {
      writer.uint32(40).int64(message.transferEndHeight);
    }
    return writer;
  },

  decode(input: BinaryReader | Uint8Array, length?: number): EventTransferBegin {
    const reader = input instanceof BinaryReader ? input : new BinaryReader(input);
    let end = length === undefined ? reader.len : reader.pos + length;
    const message = createBaseEventTransferBegin();
    while (reader.pos < end) {
      const tag = reader.uint32();
      switch (tag >>> 3) {
        case 1: {
          if (tag !== 10) {
            break;
          }

          message.sourceAddress = reader.string();
          continue;
        }
        case 2: {
          if (tag !== 18) {
            break;
          }

          message.destinationAddress = reader.string();
          continue;
        }
        case 3: {
          if (tag !== 26) {
            break;
          }

          message.sourceApplication = Application.decode(reader, reader.uint32());
          continue;
        }
        case 4: {
          if (tag !== 32) {
            break;
          }

          message.sessionEndHeight = longToNumber(reader.int64());
          continue;
        }
        case 5: {
          if (tag !== 40) {
            break;
          }

          message.transferEndHeight = longToNumber(reader.int64());
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

  fromJSON(object: any): EventTransferBegin {
    return {
      sourceAddress: isSet(object.sourceAddress) ? globalThis.String(object.sourceAddress) : "",
      destinationAddress: isSet(object.destinationAddress) ? globalThis.String(object.destinationAddress) : "",
      sourceApplication: isSet(object.sourceApplication) ? Application.fromJSON(object.sourceApplication) : undefined,
      sessionEndHeight: isSet(object.sessionEndHeight) ? globalThis.Number(object.sessionEndHeight) : 0,
      transferEndHeight: isSet(object.transferEndHeight) ? globalThis.Number(object.transferEndHeight) : 0,
    };
  },

  toJSON(message: EventTransferBegin): unknown {
    const obj: any = {};
    if (message.sourceAddress !== "") {
      obj.sourceAddress = message.sourceAddress;
    }
    if (message.destinationAddress !== "") {
      obj.destinationAddress = message.destinationAddress;
    }
    if (message.sourceApplication !== undefined) {
      obj.sourceApplication = Application.toJSON(message.sourceApplication);
    }
    if (message.sessionEndHeight !== 0) {
      obj.sessionEndHeight = Math.round(message.sessionEndHeight);
    }
    if (message.transferEndHeight !== 0) {
      obj.transferEndHeight = Math.round(message.transferEndHeight);
    }
    return obj;
  },

  create<I extends Exact<DeepPartial<EventTransferBegin>, I>>(base?: I): EventTransferBegin {
    return EventTransferBegin.fromPartial(base ?? ({} as any));
  },
  fromPartial<I extends Exact<DeepPartial<EventTransferBegin>, I>>(object: I): EventTransferBegin {
    const message = createBaseEventTransferBegin();
    message.sourceAddress = object.sourceAddress ?? "";
    message.destinationAddress = object.destinationAddress ?? "";
    message.sourceApplication = (object.sourceApplication !== undefined && object.sourceApplication !== null)
      ? Application.fromPartial(object.sourceApplication)
      : undefined;
    message.sessionEndHeight = object.sessionEndHeight ?? 0;
    message.transferEndHeight = object.transferEndHeight ?? 0;
    return message;
  },
};

function createBaseEventTransferEnd(): EventTransferEnd {
  return {
    sourceAddress: "",
    destinationAddress: "",
    destinationApplication: undefined,
    sessionEndHeight: 0,
    transferEndHeight: 0,
  };
}

export const EventTransferEnd: MessageFns<EventTransferEnd> = {
  encode(message: EventTransferEnd, writer: BinaryWriter = new BinaryWriter()): BinaryWriter {
    if (message.sourceAddress !== "") {
      writer.uint32(10).string(message.sourceAddress);
    }
    if (message.destinationAddress !== "") {
      writer.uint32(18).string(message.destinationAddress);
    }
    if (message.destinationApplication !== undefined) {
      Application.encode(message.destinationApplication, writer.uint32(26).fork()).join();
    }
    if (message.sessionEndHeight !== 0) {
      writer.uint32(32).int64(message.sessionEndHeight);
    }
    if (message.transferEndHeight !== 0) {
      writer.uint32(40).int64(message.transferEndHeight);
    }
    return writer;
  },

  decode(input: BinaryReader | Uint8Array, length?: number): EventTransferEnd {
    const reader = input instanceof BinaryReader ? input : new BinaryReader(input);
    let end = length === undefined ? reader.len : reader.pos + length;
    const message = createBaseEventTransferEnd();
    while (reader.pos < end) {
      const tag = reader.uint32();
      switch (tag >>> 3) {
        case 1: {
          if (tag !== 10) {
            break;
          }

          message.sourceAddress = reader.string();
          continue;
        }
        case 2: {
          if (tag !== 18) {
            break;
          }

          message.destinationAddress = reader.string();
          continue;
        }
        case 3: {
          if (tag !== 26) {
            break;
          }

          message.destinationApplication = Application.decode(reader, reader.uint32());
          continue;
        }
        case 4: {
          if (tag !== 32) {
            break;
          }

          message.sessionEndHeight = longToNumber(reader.int64());
          continue;
        }
        case 5: {
          if (tag !== 40) {
            break;
          }

          message.transferEndHeight = longToNumber(reader.int64());
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

  fromJSON(object: any): EventTransferEnd {
    return {
      sourceAddress: isSet(object.sourceAddress) ? globalThis.String(object.sourceAddress) : "",
      destinationAddress: isSet(object.destinationAddress) ? globalThis.String(object.destinationAddress) : "",
      destinationApplication: isSet(object.destinationApplication)
        ? Application.fromJSON(object.destinationApplication)
        : undefined,
      sessionEndHeight: isSet(object.sessionEndHeight) ? globalThis.Number(object.sessionEndHeight) : 0,
      transferEndHeight: isSet(object.transferEndHeight) ? globalThis.Number(object.transferEndHeight) : 0,
    };
  },

  toJSON(message: EventTransferEnd): unknown {
    const obj: any = {};
    if (message.sourceAddress !== "") {
      obj.sourceAddress = message.sourceAddress;
    }
    if (message.destinationAddress !== "") {
      obj.destinationAddress = message.destinationAddress;
    }
    if (message.destinationApplication !== undefined) {
      obj.destinationApplication = Application.toJSON(message.destinationApplication);
    }
    if (message.sessionEndHeight !== 0) {
      obj.sessionEndHeight = Math.round(message.sessionEndHeight);
    }
    if (message.transferEndHeight !== 0) {
      obj.transferEndHeight = Math.round(message.transferEndHeight);
    }
    return obj;
  },

  create<I extends Exact<DeepPartial<EventTransferEnd>, I>>(base?: I): EventTransferEnd {
    return EventTransferEnd.fromPartial(base ?? ({} as any));
  },
  fromPartial<I extends Exact<DeepPartial<EventTransferEnd>, I>>(object: I): EventTransferEnd {
    const message = createBaseEventTransferEnd();
    message.sourceAddress = object.sourceAddress ?? "";
    message.destinationAddress = object.destinationAddress ?? "";
    message.destinationApplication =
      (object.destinationApplication !== undefined && object.destinationApplication !== null)
        ? Application.fromPartial(object.destinationApplication)
        : undefined;
    message.sessionEndHeight = object.sessionEndHeight ?? 0;
    message.transferEndHeight = object.transferEndHeight ?? 0;
    return message;
  },
};

function createBaseEventTransferError(): EventTransferError {
  return { sourceAddress: "", destinationAddress: "", sourceApplication: undefined, sessionEndHeight: 0, error: "" };
}

export const EventTransferError: MessageFns<EventTransferError> = {
  encode(message: EventTransferError, writer: BinaryWriter = new BinaryWriter()): BinaryWriter {
    if (message.sourceAddress !== "") {
      writer.uint32(10).string(message.sourceAddress);
    }
    if (message.destinationAddress !== "") {
      writer.uint32(18).string(message.destinationAddress);
    }
    if (message.sourceApplication !== undefined) {
      Application.encode(message.sourceApplication, writer.uint32(26).fork()).join();
    }
    if (message.sessionEndHeight !== 0) {
      writer.uint32(32).int64(message.sessionEndHeight);
    }
    if (message.error !== "") {
      writer.uint32(42).string(message.error);
    }
    return writer;
  },

  decode(input: BinaryReader | Uint8Array, length?: number): EventTransferError {
    const reader = input instanceof BinaryReader ? input : new BinaryReader(input);
    let end = length === undefined ? reader.len : reader.pos + length;
    const message = createBaseEventTransferError();
    while (reader.pos < end) {
      const tag = reader.uint32();
      switch (tag >>> 3) {
        case 1: {
          if (tag !== 10) {
            break;
          }

          message.sourceAddress = reader.string();
          continue;
        }
        case 2: {
          if (tag !== 18) {
            break;
          }

          message.destinationAddress = reader.string();
          continue;
        }
        case 3: {
          if (tag !== 26) {
            break;
          }

          message.sourceApplication = Application.decode(reader, reader.uint32());
          continue;
        }
        case 4: {
          if (tag !== 32) {
            break;
          }

          message.sessionEndHeight = longToNumber(reader.int64());
          continue;
        }
        case 5: {
          if (tag !== 42) {
            break;
          }

          message.error = reader.string();
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

  fromJSON(object: any): EventTransferError {
    return {
      sourceAddress: isSet(object.sourceAddress) ? globalThis.String(object.sourceAddress) : "",
      destinationAddress: isSet(object.destinationAddress) ? globalThis.String(object.destinationAddress) : "",
      sourceApplication: isSet(object.sourceApplication) ? Application.fromJSON(object.sourceApplication) : undefined,
      sessionEndHeight: isSet(object.sessionEndHeight) ? globalThis.Number(object.sessionEndHeight) : 0,
      error: isSet(object.error) ? globalThis.String(object.error) : "",
    };
  },

  toJSON(message: EventTransferError): unknown {
    const obj: any = {};
    if (message.sourceAddress !== "") {
      obj.sourceAddress = message.sourceAddress;
    }
    if (message.destinationAddress !== "") {
      obj.destinationAddress = message.destinationAddress;
    }
    if (message.sourceApplication !== undefined) {
      obj.sourceApplication = Application.toJSON(message.sourceApplication);
    }
    if (message.sessionEndHeight !== 0) {
      obj.sessionEndHeight = Math.round(message.sessionEndHeight);
    }
    if (message.error !== "") {
      obj.error = message.error;
    }
    return obj;
  },

  create<I extends Exact<DeepPartial<EventTransferError>, I>>(base?: I): EventTransferError {
    return EventTransferError.fromPartial(base ?? ({} as any));
  },
  fromPartial<I extends Exact<DeepPartial<EventTransferError>, I>>(object: I): EventTransferError {
    const message = createBaseEventTransferError();
    message.sourceAddress = object.sourceAddress ?? "";
    message.destinationAddress = object.destinationAddress ?? "";
    message.sourceApplication = (object.sourceApplication !== undefined && object.sourceApplication !== null)
      ? Application.fromPartial(object.sourceApplication)
      : undefined;
    message.sessionEndHeight = object.sessionEndHeight ?? 0;
    message.error = object.error ?? "";
    return message;
  },
};

function createBaseEventApplicationUnbondingBegin(): EventApplicationUnbondingBegin {
  return { application: undefined, reason: 0, sessionEndHeight: 0, unbondingEndHeight: 0 };
}

export const EventApplicationUnbondingBegin: MessageFns<EventApplicationUnbondingBegin> = {
  encode(message: EventApplicationUnbondingBegin, writer: BinaryWriter = new BinaryWriter()): BinaryWriter {
    if (message.application !== undefined) {
      Application.encode(message.application, writer.uint32(10).fork()).join();
    }
    if (message.reason !== 0) {
      writer.uint32(16).int32(message.reason);
    }
    if (message.sessionEndHeight !== 0) {
      writer.uint32(24).int64(message.sessionEndHeight);
    }
    if (message.unbondingEndHeight !== 0) {
      writer.uint32(32).int64(message.unbondingEndHeight);
    }
    return writer;
  },

  decode(input: BinaryReader | Uint8Array, length?: number): EventApplicationUnbondingBegin {
    const reader = input instanceof BinaryReader ? input : new BinaryReader(input);
    let end = length === undefined ? reader.len : reader.pos + length;
    const message = createBaseEventApplicationUnbondingBegin();
    while (reader.pos < end) {
      const tag = reader.uint32();
      switch (tag >>> 3) {
        case 1: {
          if (tag !== 10) {
            break;
          }

          message.application = Application.decode(reader, reader.uint32());
          continue;
        }
        case 2: {
          if (tag !== 16) {
            break;
          }

          message.reason = reader.int32() as any;
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

  fromJSON(object: any): EventApplicationUnbondingBegin {
    return {
      application: isSet(object.application) ? Application.fromJSON(object.application) : undefined,
      reason: isSet(object.reason) ? applicationUnbondingReasonFromJSON(object.reason) : 0,
      sessionEndHeight: isSet(object.sessionEndHeight) ? globalThis.Number(object.sessionEndHeight) : 0,
      unbondingEndHeight: isSet(object.unbondingEndHeight) ? globalThis.Number(object.unbondingEndHeight) : 0,
    };
  },

  toJSON(message: EventApplicationUnbondingBegin): unknown {
    const obj: any = {};
    if (message.application !== undefined) {
      obj.application = Application.toJSON(message.application);
    }
    if (message.reason !== 0) {
      obj.reason = applicationUnbondingReasonToJSON(message.reason);
    }
    if (message.sessionEndHeight !== 0) {
      obj.sessionEndHeight = Math.round(message.sessionEndHeight);
    }
    if (message.unbondingEndHeight !== 0) {
      obj.unbondingEndHeight = Math.round(message.unbondingEndHeight);
    }
    return obj;
  },

  create<I extends Exact<DeepPartial<EventApplicationUnbondingBegin>, I>>(base?: I): EventApplicationUnbondingBegin {
    return EventApplicationUnbondingBegin.fromPartial(base ?? ({} as any));
  },
  fromPartial<I extends Exact<DeepPartial<EventApplicationUnbondingBegin>, I>>(
    object: I,
  ): EventApplicationUnbondingBegin {
    const message = createBaseEventApplicationUnbondingBegin();
    message.application = (object.application !== undefined && object.application !== null)
      ? Application.fromPartial(object.application)
      : undefined;
    message.reason = object.reason ?? 0;
    message.sessionEndHeight = object.sessionEndHeight ?? 0;
    message.unbondingEndHeight = object.unbondingEndHeight ?? 0;
    return message;
  },
};

function createBaseEventApplicationUnbondingEnd(): EventApplicationUnbondingEnd {
  return { application: undefined, reason: 0, sessionEndHeight: 0, unbondingEndHeight: 0 };
}

export const EventApplicationUnbondingEnd: MessageFns<EventApplicationUnbondingEnd> = {
  encode(message: EventApplicationUnbondingEnd, writer: BinaryWriter = new BinaryWriter()): BinaryWriter {
    if (message.application !== undefined) {
      Application.encode(message.application, writer.uint32(10).fork()).join();
    }
    if (message.reason !== 0) {
      writer.uint32(16).int32(message.reason);
    }
    if (message.sessionEndHeight !== 0) {
      writer.uint32(24).int64(message.sessionEndHeight);
    }
    if (message.unbondingEndHeight !== 0) {
      writer.uint32(32).int64(message.unbondingEndHeight);
    }
    return writer;
  },

  decode(input: BinaryReader | Uint8Array, length?: number): EventApplicationUnbondingEnd {
    const reader = input instanceof BinaryReader ? input : new BinaryReader(input);
    let end = length === undefined ? reader.len : reader.pos + length;
    const message = createBaseEventApplicationUnbondingEnd();
    while (reader.pos < end) {
      const tag = reader.uint32();
      switch (tag >>> 3) {
        case 1: {
          if (tag !== 10) {
            break;
          }

          message.application = Application.decode(reader, reader.uint32());
          continue;
        }
        case 2: {
          if (tag !== 16) {
            break;
          }

          message.reason = reader.int32() as any;
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

  fromJSON(object: any): EventApplicationUnbondingEnd {
    return {
      application: isSet(object.application) ? Application.fromJSON(object.application) : undefined,
      reason: isSet(object.reason) ? applicationUnbondingReasonFromJSON(object.reason) : 0,
      sessionEndHeight: isSet(object.sessionEndHeight) ? globalThis.Number(object.sessionEndHeight) : 0,
      unbondingEndHeight: isSet(object.unbondingEndHeight) ? globalThis.Number(object.unbondingEndHeight) : 0,
    };
  },

  toJSON(message: EventApplicationUnbondingEnd): unknown {
    const obj: any = {};
    if (message.application !== undefined) {
      obj.application = Application.toJSON(message.application);
    }
    if (message.reason !== 0) {
      obj.reason = applicationUnbondingReasonToJSON(message.reason);
    }
    if (message.sessionEndHeight !== 0) {
      obj.sessionEndHeight = Math.round(message.sessionEndHeight);
    }
    if (message.unbondingEndHeight !== 0) {
      obj.unbondingEndHeight = Math.round(message.unbondingEndHeight);
    }
    return obj;
  },

  create<I extends Exact<DeepPartial<EventApplicationUnbondingEnd>, I>>(base?: I): EventApplicationUnbondingEnd {
    return EventApplicationUnbondingEnd.fromPartial(base ?? ({} as any));
  },
  fromPartial<I extends Exact<DeepPartial<EventApplicationUnbondingEnd>, I>>(object: I): EventApplicationUnbondingEnd {
    const message = createBaseEventApplicationUnbondingEnd();
    message.application = (object.application !== undefined && object.application !== null)
      ? Application.fromPartial(object.application)
      : undefined;
    message.reason = object.reason ?? 0;
    message.sessionEndHeight = object.sessionEndHeight ?? 0;
    message.unbondingEndHeight = object.unbondingEndHeight ?? 0;
    return message;
  },
};

function createBaseEventApplicationUnbondingCanceled(): EventApplicationUnbondingCanceled {
  return { application: undefined, sessionEndHeight: 0 };
}

export const EventApplicationUnbondingCanceled: MessageFns<EventApplicationUnbondingCanceled> = {
  encode(message: EventApplicationUnbondingCanceled, writer: BinaryWriter = new BinaryWriter()): BinaryWriter {
    if (message.application !== undefined) {
      Application.encode(message.application, writer.uint32(10).fork()).join();
    }
    if (message.sessionEndHeight !== 0) {
      writer.uint32(16).int64(message.sessionEndHeight);
    }
    return writer;
  },

  decode(input: BinaryReader | Uint8Array, length?: number): EventApplicationUnbondingCanceled {
    const reader = input instanceof BinaryReader ? input : new BinaryReader(input);
    let end = length === undefined ? reader.len : reader.pos + length;
    const message = createBaseEventApplicationUnbondingCanceled();
    while (reader.pos < end) {
      const tag = reader.uint32();
      switch (tag >>> 3) {
        case 1: {
          if (tag !== 10) {
            break;
          }

          message.application = Application.decode(reader, reader.uint32());
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

  fromJSON(object: any): EventApplicationUnbondingCanceled {
    return {
      application: isSet(object.application) ? Application.fromJSON(object.application) : undefined,
      sessionEndHeight: isSet(object.sessionEndHeight) ? globalThis.Number(object.sessionEndHeight) : 0,
    };
  },

  toJSON(message: EventApplicationUnbondingCanceled): unknown {
    const obj: any = {};
    if (message.application !== undefined) {
      obj.application = Application.toJSON(message.application);
    }
    if (message.sessionEndHeight !== 0) {
      obj.sessionEndHeight = Math.round(message.sessionEndHeight);
    }
    return obj;
  },

  create<I extends Exact<DeepPartial<EventApplicationUnbondingCanceled>, I>>(
    base?: I,
  ): EventApplicationUnbondingCanceled {
    return EventApplicationUnbondingCanceled.fromPartial(base ?? ({} as any));
  },
  fromPartial<I extends Exact<DeepPartial<EventApplicationUnbondingCanceled>, I>>(
    object: I,
  ): EventApplicationUnbondingCanceled {
    const message = createBaseEventApplicationUnbondingCanceled();
    message.application = (object.application !== undefined && object.application !== null)
      ? Application.fromPartial(object.application)
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
