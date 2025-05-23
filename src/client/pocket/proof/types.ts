// Code generated by protoc-gen-ts_proto. DO NOT EDIT.
// versions:
//   protoc-gen-ts_proto  v2.6.1
//   protoc               unknown
// source: pocket/proof/types.proto

/* eslint-disable */
import { BinaryReader, BinaryWriter } from "@bufbuild/protobuf/wire";
import { SessionHeader } from "../session/types";

export const protobufPackage = "pocket.proof";

export enum ProofRequirementReason {
  NOT_REQUIRED = 0,
  PROBABILISTIC = 1,
  THRESHOLD = 2,
  UNRECOGNIZED = -1,
}

export function proofRequirementReasonFromJSON(object: any): ProofRequirementReason {
  switch (object) {
    case 0:
    case "NOT_REQUIRED":
      return ProofRequirementReason.NOT_REQUIRED;
    case 1:
    case "PROBABILISTIC":
      return ProofRequirementReason.PROBABILISTIC;
    case 2:
    case "THRESHOLD":
      return ProofRequirementReason.THRESHOLD;
    case -1:
    case "UNRECOGNIZED":
    default:
      return ProofRequirementReason.UNRECOGNIZED;
  }
}

export function proofRequirementReasonToJSON(object: ProofRequirementReason): string {
  switch (object) {
    case ProofRequirementReason.NOT_REQUIRED:
      return "NOT_REQUIRED";
    case ProofRequirementReason.PROBABILISTIC:
      return "PROBABILISTIC";
    case ProofRequirementReason.THRESHOLD:
      return "THRESHOLD";
    case ProofRequirementReason.UNRECOGNIZED:
    default:
      return "UNRECOGNIZED";
  }
}

export enum ClaimProofStage {
  CLAIMED = 0,
  PROVEN = 1,
  SETTLED = 2,
  EXPIRED = 3,
  UNRECOGNIZED = -1,
}

export function claimProofStageFromJSON(object: any): ClaimProofStage {
  switch (object) {
    case 0:
    case "CLAIMED":
      return ClaimProofStage.CLAIMED;
    case 1:
    case "PROVEN":
      return ClaimProofStage.PROVEN;
    case 2:
    case "SETTLED":
      return ClaimProofStage.SETTLED;
    case 3:
    case "EXPIRED":
      return ClaimProofStage.EXPIRED;
    case -1:
    case "UNRECOGNIZED":
    default:
      return ClaimProofStage.UNRECOGNIZED;
  }
}

export function claimProofStageToJSON(object: ClaimProofStage): string {
  switch (object) {
    case ClaimProofStage.CLAIMED:
      return "CLAIMED";
    case ClaimProofStage.PROVEN:
      return "PROVEN";
    case ClaimProofStage.SETTLED:
      return "SETTLED";
    case ClaimProofStage.EXPIRED:
      return "EXPIRED";
    case ClaimProofStage.UNRECOGNIZED:
    default:
      return "UNRECOGNIZED";
  }
}

/**
 * Status of proof validation for a claim
 * Default is PENDING_VALIDATION regardless of proof requirement
 */
export enum ClaimProofStatus {
  PENDING_VALIDATION = 0,
  VALIDATED = 1,
  INVALID = 2,
  UNRECOGNIZED = -1,
}

export function claimProofStatusFromJSON(object: any): ClaimProofStatus {
  switch (object) {
    case 0:
    case "PENDING_VALIDATION":
      return ClaimProofStatus.PENDING_VALIDATION;
    case 1:
    case "VALIDATED":
      return ClaimProofStatus.VALIDATED;
    case 2:
    case "INVALID":
      return ClaimProofStatus.INVALID;
    case -1:
    case "UNRECOGNIZED":
    default:
      return ClaimProofStatus.UNRECOGNIZED;
  }
}

export function claimProofStatusToJSON(object: ClaimProofStatus): string {
  switch (object) {
    case ClaimProofStatus.PENDING_VALIDATION:
      return "PENDING_VALIDATION";
    case ClaimProofStatus.VALIDATED:
      return "VALIDATED";
    case ClaimProofStatus.INVALID:
      return "INVALID";
    case ClaimProofStatus.UNRECOGNIZED:
    default:
      return "UNRECOGNIZED";
  }
}

export interface Proof {
  /** Address of the supplier's operator that submitted this proof. */
  supplierOperatorAddress: string;
  /** The session header of the session that this claim is for. */
  sessionHeader:
    | SessionHeader
    | undefined;
  /** The serialized SMST compacted proof from the `#ClosestProof()` method. */
  closestMerkleProof: Uint8Array;
}

/** Claim is the serialized object stored onchain for claims pending to be proven */
export interface Claim {
  /** Address of the supplier's operator that submitted this claim. */
  supplierOperatorAddress: string;
  /** Session header this claim is for. */
  sessionHeader:
    | SessionHeader
    | undefined;
  /** Root hash from smt.SMST#Root(). */
  rootHash: Uint8Array;
  /** Important: This field MUST only be set by proofKeeper#EnsureValidProofSignaturesAndClosestPath */
  proofValidationStatus: ClaimProofStatus;
}

/**
 * SessionSMT is the serializable session's SMST used to persist the session's
 * state offchain by the RelayMiner.
 * It is not used for any onchain logic.
 */
export interface SessionSMT {
  sessionHeader: SessionHeader | undefined;
  supplierOperatorAddress: string;
  smtRoot: Uint8Array;
}

function createBaseProof(): Proof {
  return { supplierOperatorAddress: "", sessionHeader: undefined, closestMerkleProof: new Uint8Array(0) };
}

export const Proof: MessageFns<Proof> = {
  encode(message: Proof, writer: BinaryWriter = new BinaryWriter()): BinaryWriter {
    if (message.supplierOperatorAddress !== "") {
      writer.uint32(10).string(message.supplierOperatorAddress);
    }
    if (message.sessionHeader !== undefined) {
      SessionHeader.encode(message.sessionHeader, writer.uint32(18).fork()).join();
    }
    if (message.closestMerkleProof.length !== 0) {
      writer.uint32(26).bytes(message.closestMerkleProof);
    }
    return writer;
  },

  decode(input: BinaryReader | Uint8Array, length?: number): Proof {
    const reader = input instanceof BinaryReader ? input : new BinaryReader(input);
    let end = length === undefined ? reader.len : reader.pos + length;
    const message = createBaseProof();
    while (reader.pos < end) {
      const tag = reader.uint32();
      switch (tag >>> 3) {
        case 1: {
          if (tag !== 10) {
            break;
          }

          message.supplierOperatorAddress = reader.string();
          continue;
        }
        case 2: {
          if (tag !== 18) {
            break;
          }

          message.sessionHeader = SessionHeader.decode(reader, reader.uint32());
          continue;
        }
        case 3: {
          if (tag !== 26) {
            break;
          }

          message.closestMerkleProof = reader.bytes();
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

  fromJSON(object: any): Proof {
    return {
      supplierOperatorAddress: isSet(object.supplierOperatorAddress)
        ? globalThis.String(object.supplierOperatorAddress)
        : "",
      sessionHeader: isSet(object.sessionHeader) ? SessionHeader.fromJSON(object.sessionHeader) : undefined,
      closestMerkleProof: isSet(object.closestMerkleProof)
        ? bytesFromBase64(object.closestMerkleProof)
        : new Uint8Array(0),
    };
  },

  toJSON(message: Proof): unknown {
    const obj: any = {};
    if (message.supplierOperatorAddress !== "") {
      obj.supplierOperatorAddress = message.supplierOperatorAddress;
    }
    if (message.sessionHeader !== undefined) {
      obj.sessionHeader = SessionHeader.toJSON(message.sessionHeader);
    }
    if (message.closestMerkleProof.length !== 0) {
      obj.closestMerkleProof = base64FromBytes(message.closestMerkleProof);
    }
    return obj;
  },

  create<I extends Exact<DeepPartial<Proof>, I>>(base?: I): Proof {
    return Proof.fromPartial(base ?? ({} as any));
  },
  fromPartial<I extends Exact<DeepPartial<Proof>, I>>(object: I): Proof {
    const message = createBaseProof();
    message.supplierOperatorAddress = object.supplierOperatorAddress ?? "";
    message.sessionHeader = (object.sessionHeader !== undefined && object.sessionHeader !== null)
      ? SessionHeader.fromPartial(object.sessionHeader)
      : undefined;
    message.closestMerkleProof = object.closestMerkleProof ?? new Uint8Array(0);
    return message;
  },
};

function createBaseClaim(): Claim {
  return {
    supplierOperatorAddress: "",
    sessionHeader: undefined,
    rootHash: new Uint8Array(0),
    proofValidationStatus: 0,
  };
}

export const Claim: MessageFns<Claim> = {
  encode(message: Claim, writer: BinaryWriter = new BinaryWriter()): BinaryWriter {
    if (message.supplierOperatorAddress !== "") {
      writer.uint32(10).string(message.supplierOperatorAddress);
    }
    if (message.sessionHeader !== undefined) {
      SessionHeader.encode(message.sessionHeader, writer.uint32(18).fork()).join();
    }
    if (message.rootHash.length !== 0) {
      writer.uint32(26).bytes(message.rootHash);
    }
    if (message.proofValidationStatus !== 0) {
      writer.uint32(32).int32(message.proofValidationStatus);
    }
    return writer;
  },

  decode(input: BinaryReader | Uint8Array, length?: number): Claim {
    const reader = input instanceof BinaryReader ? input : new BinaryReader(input);
    let end = length === undefined ? reader.len : reader.pos + length;
    const message = createBaseClaim();
    while (reader.pos < end) {
      const tag = reader.uint32();
      switch (tag >>> 3) {
        case 1: {
          if (tag !== 10) {
            break;
          }

          message.supplierOperatorAddress = reader.string();
          continue;
        }
        case 2: {
          if (tag !== 18) {
            break;
          }

          message.sessionHeader = SessionHeader.decode(reader, reader.uint32());
          continue;
        }
        case 3: {
          if (tag !== 26) {
            break;
          }

          message.rootHash = reader.bytes();
          continue;
        }
        case 4: {
          if (tag !== 32) {
            break;
          }

          message.proofValidationStatus = reader.int32() as any;
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

  fromJSON(object: any): Claim {
    return {
      supplierOperatorAddress: isSet(object.supplierOperatorAddress)
        ? globalThis.String(object.supplierOperatorAddress)
        : "",
      sessionHeader: isSet(object.sessionHeader) ? SessionHeader.fromJSON(object.sessionHeader) : undefined,
      rootHash: isSet(object.rootHash) ? bytesFromBase64(object.rootHash) : new Uint8Array(0),
      proofValidationStatus: isSet(object.proofValidationStatus)
        ? claimProofStatusFromJSON(object.proofValidationStatus)
        : 0,
    };
  },

  toJSON(message: Claim): unknown {
    const obj: any = {};
    if (message.supplierOperatorAddress !== "") {
      obj.supplierOperatorAddress = message.supplierOperatorAddress;
    }
    if (message.sessionHeader !== undefined) {
      obj.sessionHeader = SessionHeader.toJSON(message.sessionHeader);
    }
    if (message.rootHash.length !== 0) {
      obj.rootHash = base64FromBytes(message.rootHash);
    }
    if (message.proofValidationStatus !== 0) {
      obj.proofValidationStatus = claimProofStatusToJSON(message.proofValidationStatus);
    }
    return obj;
  },

  create<I extends Exact<DeepPartial<Claim>, I>>(base?: I): Claim {
    return Claim.fromPartial(base ?? ({} as any));
  },
  fromPartial<I extends Exact<DeepPartial<Claim>, I>>(object: I): Claim {
    const message = createBaseClaim();
    message.supplierOperatorAddress = object.supplierOperatorAddress ?? "";
    message.sessionHeader = (object.sessionHeader !== undefined && object.sessionHeader !== null)
      ? SessionHeader.fromPartial(object.sessionHeader)
      : undefined;
    message.rootHash = object.rootHash ?? new Uint8Array(0);
    message.proofValidationStatus = object.proofValidationStatus ?? 0;
    return message;
  },
};

function createBaseSessionSMT(): SessionSMT {
  return { sessionHeader: undefined, supplierOperatorAddress: "", smtRoot: new Uint8Array(0) };
}

export const SessionSMT: MessageFns<SessionSMT> = {
  encode(message: SessionSMT, writer: BinaryWriter = new BinaryWriter()): BinaryWriter {
    if (message.sessionHeader !== undefined) {
      SessionHeader.encode(message.sessionHeader, writer.uint32(10).fork()).join();
    }
    if (message.supplierOperatorAddress !== "") {
      writer.uint32(18).string(message.supplierOperatorAddress);
    }
    if (message.smtRoot.length !== 0) {
      writer.uint32(26).bytes(message.smtRoot);
    }
    return writer;
  },

  decode(input: BinaryReader | Uint8Array, length?: number): SessionSMT {
    const reader = input instanceof BinaryReader ? input : new BinaryReader(input);
    let end = length === undefined ? reader.len : reader.pos + length;
    const message = createBaseSessionSMT();
    while (reader.pos < end) {
      const tag = reader.uint32();
      switch (tag >>> 3) {
        case 1: {
          if (tag !== 10) {
            break;
          }

          message.sessionHeader = SessionHeader.decode(reader, reader.uint32());
          continue;
        }
        case 2: {
          if (tag !== 18) {
            break;
          }

          message.supplierOperatorAddress = reader.string();
          continue;
        }
        case 3: {
          if (tag !== 26) {
            break;
          }

          message.smtRoot = reader.bytes();
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

  fromJSON(object: any): SessionSMT {
    return {
      sessionHeader: isSet(object.sessionHeader) ? SessionHeader.fromJSON(object.sessionHeader) : undefined,
      supplierOperatorAddress: isSet(object.supplierOperatorAddress)
        ? globalThis.String(object.supplierOperatorAddress)
        : "",
      smtRoot: isSet(object.smtRoot) ? bytesFromBase64(object.smtRoot) : new Uint8Array(0),
    };
  },

  toJSON(message: SessionSMT): unknown {
    const obj: any = {};
    if (message.sessionHeader !== undefined) {
      obj.sessionHeader = SessionHeader.toJSON(message.sessionHeader);
    }
    if (message.supplierOperatorAddress !== "") {
      obj.supplierOperatorAddress = message.supplierOperatorAddress;
    }
    if (message.smtRoot.length !== 0) {
      obj.smtRoot = base64FromBytes(message.smtRoot);
    }
    return obj;
  },

  create<I extends Exact<DeepPartial<SessionSMT>, I>>(base?: I): SessionSMT {
    return SessionSMT.fromPartial(base ?? ({} as any));
  },
  fromPartial<I extends Exact<DeepPartial<SessionSMT>, I>>(object: I): SessionSMT {
    const message = createBaseSessionSMT();
    message.sessionHeader = (object.sessionHeader !== undefined && object.sessionHeader !== null)
      ? SessionHeader.fromPartial(object.sessionHeader)
      : undefined;
    message.supplierOperatorAddress = object.supplierOperatorAddress ?? "";
    message.smtRoot = object.smtRoot ?? new Uint8Array(0);
    return message;
  },
};

function bytesFromBase64(b64: string): Uint8Array {
  if ((globalThis as any).Buffer) {
    return Uint8Array.from(globalThis.Buffer.from(b64, "base64"));
  } else {
    const bin = globalThis.atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; ++i) {
      arr[i] = bin.charCodeAt(i);
    }
    return arr;
  }
}

function base64FromBytes(arr: Uint8Array): string {
  if ((globalThis as any).Buffer) {
    return globalThis.Buffer.from(arr).toString("base64");
  } else {
    const bin: string[] = [];
    arr.forEach((byte) => {
      bin.push(globalThis.String.fromCharCode(byte));
    });
    return globalThis.btoa(bin.join(""));
  }
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
