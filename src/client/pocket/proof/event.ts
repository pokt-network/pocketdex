// Code generated by protoc-gen-ts_proto. DO NOT EDIT.
// versions:
//   protoc-gen-ts_proto  v2.6.1
//   protoc               unknown
// source: pocket/proof/event.proto

/* eslint-disable */
import { BinaryReader, BinaryWriter } from "@bufbuild/protobuf/wire";
import { Coin } from "../../cosmos/base/v1beta1/coin";
import { Claim, ClaimProofStatus, claimProofStatusFromJSON, claimProofStatusToJSON, Proof } from "./types";

export const protobufPackage = "pocket.proof";

export interface EventClaimCreated {
  claim: Claim | undefined;
  numRelays: number;
  numClaimedComputeUnits: number;
  numEstimatedComputeUnits: number;
  claimedUpokt: Coin | undefined;
}

/** TODO_TEST: Add coverage for claim updates. */
export interface EventClaimUpdated {
  claim: Claim | undefined;
  numRelays: number;
  numClaimedComputeUnits: number;
  numEstimatedComputeUnits: number;
  claimedUpokt: Coin | undefined;
}

export interface EventProofSubmitted {
  claim: Claim | undefined;
  proof: Proof | undefined;
  numRelays: number;
  numClaimedComputeUnits: number;
  numEstimatedComputeUnits: number;
  claimedUpokt: Coin | undefined;
}

/** TODO_TEST: Add coverage for proof updates. */
export interface EventProofUpdated {
  claim: Claim | undefined;
  proof: Proof | undefined;
  numRelays: number;
  numClaimedComputeUnits: number;
  numEstimatedComputeUnits: number;
  claimedUpokt: Coin | undefined;
}

/**
 * Event emitted after a proof has been checked for validity in the proof module's
 * EndBlocker.
 */
export interface EventProofValidityChecked {
  proof: Proof | undefined;
  blockHeight: number;
  proofStatus: ClaimProofStatus;
  /**
   * reason is the string representation of the error that led to the proof being
   * marked as invalid (e.g. "invalid closest merkle proof", "invalid relay request signature")
   */
  failureReason: string;
}

function createBaseEventClaimCreated(): EventClaimCreated {
  return {
    claim: undefined,
    numRelays: 0,
    numClaimedComputeUnits: 0,
    numEstimatedComputeUnits: 0,
    claimedUpokt: undefined,
  };
}

export const EventClaimCreated: MessageFns<EventClaimCreated> = {
  encode(message: EventClaimCreated, writer: BinaryWriter = new BinaryWriter()): BinaryWriter {
    if (message.claim !== undefined) {
      Claim.encode(message.claim, writer.uint32(10).fork()).join();
    }
    if (message.numRelays !== 0) {
      writer.uint32(16).uint64(message.numRelays);
    }
    if (message.numClaimedComputeUnits !== 0) {
      writer.uint32(32).uint64(message.numClaimedComputeUnits);
    }
    if (message.numEstimatedComputeUnits !== 0) {
      writer.uint32(40).uint64(message.numEstimatedComputeUnits);
    }
    if (message.claimedUpokt !== undefined) {
      Coin.encode(message.claimedUpokt, writer.uint32(50).fork()).join();
    }
    return writer;
  },

  decode(input: BinaryReader | Uint8Array, length?: number): EventClaimCreated {
    const reader = input instanceof BinaryReader ? input : new BinaryReader(input);
    let end = length === undefined ? reader.len : reader.pos + length;
    const message = createBaseEventClaimCreated();
    while (reader.pos < end) {
      const tag = reader.uint32();
      switch (tag >>> 3) {
        case 1: {
          if (tag !== 10) {
            break;
          }

          message.claim = Claim.decode(reader, reader.uint32());
          continue;
        }
        case 2: {
          if (tag !== 16) {
            break;
          }

          message.numRelays = longToNumber(reader.uint64());
          continue;
        }
        case 4: {
          if (tag !== 32) {
            break;
          }

          message.numClaimedComputeUnits = longToNumber(reader.uint64());
          continue;
        }
        case 5: {
          if (tag !== 40) {
            break;
          }

          message.numEstimatedComputeUnits = longToNumber(reader.uint64());
          continue;
        }
        case 6: {
          if (tag !== 50) {
            break;
          }

          message.claimedUpokt = Coin.decode(reader, reader.uint32());
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

  fromJSON(object: any): EventClaimCreated {
    return {
      claim: isSet(object.claim) ? Claim.fromJSON(object.claim) : undefined,
      numRelays: isSet(object.numRelays) ? globalThis.Number(object.numRelays) : 0,
      numClaimedComputeUnits: isSet(object.numClaimedComputeUnits)
        ? globalThis.Number(object.numClaimedComputeUnits)
        : 0,
      numEstimatedComputeUnits: isSet(object.numEstimatedComputeUnits)
        ? globalThis.Number(object.numEstimatedComputeUnits)
        : 0,
      claimedUpokt: isSet(object.claimedUpokt) ? Coin.fromJSON(object.claimedUpokt) : undefined,
    };
  },

  toJSON(message: EventClaimCreated): unknown {
    const obj: any = {};
    if (message.claim !== undefined) {
      obj.claim = Claim.toJSON(message.claim);
    }
    if (message.numRelays !== 0) {
      obj.numRelays = Math.round(message.numRelays);
    }
    if (message.numClaimedComputeUnits !== 0) {
      obj.numClaimedComputeUnits = Math.round(message.numClaimedComputeUnits);
    }
    if (message.numEstimatedComputeUnits !== 0) {
      obj.numEstimatedComputeUnits = Math.round(message.numEstimatedComputeUnits);
    }
    if (message.claimedUpokt !== undefined) {
      obj.claimedUpokt = Coin.toJSON(message.claimedUpokt);
    }
    return obj;
  },

  create<I extends Exact<DeepPartial<EventClaimCreated>, I>>(base?: I): EventClaimCreated {
    return EventClaimCreated.fromPartial(base ?? ({} as any));
  },
  fromPartial<I extends Exact<DeepPartial<EventClaimCreated>, I>>(object: I): EventClaimCreated {
    const message = createBaseEventClaimCreated();
    message.claim = (object.claim !== undefined && object.claim !== null) ? Claim.fromPartial(object.claim) : undefined;
    message.numRelays = object.numRelays ?? 0;
    message.numClaimedComputeUnits = object.numClaimedComputeUnits ?? 0;
    message.numEstimatedComputeUnits = object.numEstimatedComputeUnits ?? 0;
    message.claimedUpokt = (object.claimedUpokt !== undefined && object.claimedUpokt !== null)
      ? Coin.fromPartial(object.claimedUpokt)
      : undefined;
    return message;
  },
};

function createBaseEventClaimUpdated(): EventClaimUpdated {
  return {
    claim: undefined,
    numRelays: 0,
    numClaimedComputeUnits: 0,
    numEstimatedComputeUnits: 0,
    claimedUpokt: undefined,
  };
}

export const EventClaimUpdated: MessageFns<EventClaimUpdated> = {
  encode(message: EventClaimUpdated, writer: BinaryWriter = new BinaryWriter()): BinaryWriter {
    if (message.claim !== undefined) {
      Claim.encode(message.claim, writer.uint32(10).fork()).join();
    }
    if (message.numRelays !== 0) {
      writer.uint32(16).uint64(message.numRelays);
    }
    if (message.numClaimedComputeUnits !== 0) {
      writer.uint32(32).uint64(message.numClaimedComputeUnits);
    }
    if (message.numEstimatedComputeUnits !== 0) {
      writer.uint32(40).uint64(message.numEstimatedComputeUnits);
    }
    if (message.claimedUpokt !== undefined) {
      Coin.encode(message.claimedUpokt, writer.uint32(50).fork()).join();
    }
    return writer;
  },

  decode(input: BinaryReader | Uint8Array, length?: number): EventClaimUpdated {
    const reader = input instanceof BinaryReader ? input : new BinaryReader(input);
    let end = length === undefined ? reader.len : reader.pos + length;
    const message = createBaseEventClaimUpdated();
    while (reader.pos < end) {
      const tag = reader.uint32();
      switch (tag >>> 3) {
        case 1: {
          if (tag !== 10) {
            break;
          }

          message.claim = Claim.decode(reader, reader.uint32());
          continue;
        }
        case 2: {
          if (tag !== 16) {
            break;
          }

          message.numRelays = longToNumber(reader.uint64());
          continue;
        }
        case 4: {
          if (tag !== 32) {
            break;
          }

          message.numClaimedComputeUnits = longToNumber(reader.uint64());
          continue;
        }
        case 5: {
          if (tag !== 40) {
            break;
          }

          message.numEstimatedComputeUnits = longToNumber(reader.uint64());
          continue;
        }
        case 6: {
          if (tag !== 50) {
            break;
          }

          message.claimedUpokt = Coin.decode(reader, reader.uint32());
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

  fromJSON(object: any): EventClaimUpdated {
    return {
      claim: isSet(object.claim) ? Claim.fromJSON(object.claim) : undefined,
      numRelays: isSet(object.numRelays) ? globalThis.Number(object.numRelays) : 0,
      numClaimedComputeUnits: isSet(object.numClaimedComputeUnits)
        ? globalThis.Number(object.numClaimedComputeUnits)
        : 0,
      numEstimatedComputeUnits: isSet(object.numEstimatedComputeUnits)
        ? globalThis.Number(object.numEstimatedComputeUnits)
        : 0,
      claimedUpokt: isSet(object.claimedUpokt) ? Coin.fromJSON(object.claimedUpokt) : undefined,
    };
  },

  toJSON(message: EventClaimUpdated): unknown {
    const obj: any = {};
    if (message.claim !== undefined) {
      obj.claim = Claim.toJSON(message.claim);
    }
    if (message.numRelays !== 0) {
      obj.numRelays = Math.round(message.numRelays);
    }
    if (message.numClaimedComputeUnits !== 0) {
      obj.numClaimedComputeUnits = Math.round(message.numClaimedComputeUnits);
    }
    if (message.numEstimatedComputeUnits !== 0) {
      obj.numEstimatedComputeUnits = Math.round(message.numEstimatedComputeUnits);
    }
    if (message.claimedUpokt !== undefined) {
      obj.claimedUpokt = Coin.toJSON(message.claimedUpokt);
    }
    return obj;
  },

  create<I extends Exact<DeepPartial<EventClaimUpdated>, I>>(base?: I): EventClaimUpdated {
    return EventClaimUpdated.fromPartial(base ?? ({} as any));
  },
  fromPartial<I extends Exact<DeepPartial<EventClaimUpdated>, I>>(object: I): EventClaimUpdated {
    const message = createBaseEventClaimUpdated();
    message.claim = (object.claim !== undefined && object.claim !== null) ? Claim.fromPartial(object.claim) : undefined;
    message.numRelays = object.numRelays ?? 0;
    message.numClaimedComputeUnits = object.numClaimedComputeUnits ?? 0;
    message.numEstimatedComputeUnits = object.numEstimatedComputeUnits ?? 0;
    message.claimedUpokt = (object.claimedUpokt !== undefined && object.claimedUpokt !== null)
      ? Coin.fromPartial(object.claimedUpokt)
      : undefined;
    return message;
  },
};

function createBaseEventProofSubmitted(): EventProofSubmitted {
  return {
    claim: undefined,
    proof: undefined,
    numRelays: 0,
    numClaimedComputeUnits: 0,
    numEstimatedComputeUnits: 0,
    claimedUpokt: undefined,
  };
}

export const EventProofSubmitted: MessageFns<EventProofSubmitted> = {
  encode(message: EventProofSubmitted, writer: BinaryWriter = new BinaryWriter()): BinaryWriter {
    if (message.claim !== undefined) {
      Claim.encode(message.claim, writer.uint32(10).fork()).join();
    }
    if (message.proof !== undefined) {
      Proof.encode(message.proof, writer.uint32(18).fork()).join();
    }
    if (message.numRelays !== 0) {
      writer.uint32(24).uint64(message.numRelays);
    }
    if (message.numClaimedComputeUnits !== 0) {
      writer.uint32(32).uint64(message.numClaimedComputeUnits);
    }
    if (message.numEstimatedComputeUnits !== 0) {
      writer.uint32(40).uint64(message.numEstimatedComputeUnits);
    }
    if (message.claimedUpokt !== undefined) {
      Coin.encode(message.claimedUpokt, writer.uint32(50).fork()).join();
    }
    return writer;
  },

  decode(input: BinaryReader | Uint8Array, length?: number): EventProofSubmitted {
    const reader = input instanceof BinaryReader ? input : new BinaryReader(input);
    let end = length === undefined ? reader.len : reader.pos + length;
    const message = createBaseEventProofSubmitted();
    while (reader.pos < end) {
      const tag = reader.uint32();
      switch (tag >>> 3) {
        case 1: {
          if (tag !== 10) {
            break;
          }

          message.claim = Claim.decode(reader, reader.uint32());
          continue;
        }
        case 2: {
          if (tag !== 18) {
            break;
          }

          message.proof = Proof.decode(reader, reader.uint32());
          continue;
        }
        case 3: {
          if (tag !== 24) {
            break;
          }

          message.numRelays = longToNumber(reader.uint64());
          continue;
        }
        case 4: {
          if (tag !== 32) {
            break;
          }

          message.numClaimedComputeUnits = longToNumber(reader.uint64());
          continue;
        }
        case 5: {
          if (tag !== 40) {
            break;
          }

          message.numEstimatedComputeUnits = longToNumber(reader.uint64());
          continue;
        }
        case 6: {
          if (tag !== 50) {
            break;
          }

          message.claimedUpokt = Coin.decode(reader, reader.uint32());
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

  fromJSON(object: any): EventProofSubmitted {
    return {
      claim: isSet(object.claim) ? Claim.fromJSON(object.claim) : undefined,
      proof: isSet(object.proof) ? Proof.fromJSON(object.proof) : undefined,
      numRelays: isSet(object.numRelays) ? globalThis.Number(object.numRelays) : 0,
      numClaimedComputeUnits: isSet(object.numClaimedComputeUnits)
        ? globalThis.Number(object.numClaimedComputeUnits)
        : 0,
      numEstimatedComputeUnits: isSet(object.numEstimatedComputeUnits)
        ? globalThis.Number(object.numEstimatedComputeUnits)
        : 0,
      claimedUpokt: isSet(object.claimedUpokt) ? Coin.fromJSON(object.claimedUpokt) : undefined,
    };
  },

  toJSON(message: EventProofSubmitted): unknown {
    const obj: any = {};
    if (message.claim !== undefined) {
      obj.claim = Claim.toJSON(message.claim);
    }
    if (message.proof !== undefined) {
      obj.proof = Proof.toJSON(message.proof);
    }
    if (message.numRelays !== 0) {
      obj.numRelays = Math.round(message.numRelays);
    }
    if (message.numClaimedComputeUnits !== 0) {
      obj.numClaimedComputeUnits = Math.round(message.numClaimedComputeUnits);
    }
    if (message.numEstimatedComputeUnits !== 0) {
      obj.numEstimatedComputeUnits = Math.round(message.numEstimatedComputeUnits);
    }
    if (message.claimedUpokt !== undefined) {
      obj.claimedUpokt = Coin.toJSON(message.claimedUpokt);
    }
    return obj;
  },

  create<I extends Exact<DeepPartial<EventProofSubmitted>, I>>(base?: I): EventProofSubmitted {
    return EventProofSubmitted.fromPartial(base ?? ({} as any));
  },
  fromPartial<I extends Exact<DeepPartial<EventProofSubmitted>, I>>(object: I): EventProofSubmitted {
    const message = createBaseEventProofSubmitted();
    message.claim = (object.claim !== undefined && object.claim !== null) ? Claim.fromPartial(object.claim) : undefined;
    message.proof = (object.proof !== undefined && object.proof !== null) ? Proof.fromPartial(object.proof) : undefined;
    message.numRelays = object.numRelays ?? 0;
    message.numClaimedComputeUnits = object.numClaimedComputeUnits ?? 0;
    message.numEstimatedComputeUnits = object.numEstimatedComputeUnits ?? 0;
    message.claimedUpokt = (object.claimedUpokt !== undefined && object.claimedUpokt !== null)
      ? Coin.fromPartial(object.claimedUpokt)
      : undefined;
    return message;
  },
};

function createBaseEventProofUpdated(): EventProofUpdated {
  return {
    claim: undefined,
    proof: undefined,
    numRelays: 0,
    numClaimedComputeUnits: 0,
    numEstimatedComputeUnits: 0,
    claimedUpokt: undefined,
  };
}

export const EventProofUpdated: MessageFns<EventProofUpdated> = {
  encode(message: EventProofUpdated, writer: BinaryWriter = new BinaryWriter()): BinaryWriter {
    if (message.claim !== undefined) {
      Claim.encode(message.claim, writer.uint32(10).fork()).join();
    }
    if (message.proof !== undefined) {
      Proof.encode(message.proof, writer.uint32(18).fork()).join();
    }
    if (message.numRelays !== 0) {
      writer.uint32(24).uint64(message.numRelays);
    }
    if (message.numClaimedComputeUnits !== 0) {
      writer.uint32(32).uint64(message.numClaimedComputeUnits);
    }
    if (message.numEstimatedComputeUnits !== 0) {
      writer.uint32(40).uint64(message.numEstimatedComputeUnits);
    }
    if (message.claimedUpokt !== undefined) {
      Coin.encode(message.claimedUpokt, writer.uint32(50).fork()).join();
    }
    return writer;
  },

  decode(input: BinaryReader | Uint8Array, length?: number): EventProofUpdated {
    const reader = input instanceof BinaryReader ? input : new BinaryReader(input);
    let end = length === undefined ? reader.len : reader.pos + length;
    const message = createBaseEventProofUpdated();
    while (reader.pos < end) {
      const tag = reader.uint32();
      switch (tag >>> 3) {
        case 1: {
          if (tag !== 10) {
            break;
          }

          message.claim = Claim.decode(reader, reader.uint32());
          continue;
        }
        case 2: {
          if (tag !== 18) {
            break;
          }

          message.proof = Proof.decode(reader, reader.uint32());
          continue;
        }
        case 3: {
          if (tag !== 24) {
            break;
          }

          message.numRelays = longToNumber(reader.uint64());
          continue;
        }
        case 4: {
          if (tag !== 32) {
            break;
          }

          message.numClaimedComputeUnits = longToNumber(reader.uint64());
          continue;
        }
        case 5: {
          if (tag !== 40) {
            break;
          }

          message.numEstimatedComputeUnits = longToNumber(reader.uint64());
          continue;
        }
        case 6: {
          if (tag !== 50) {
            break;
          }

          message.claimedUpokt = Coin.decode(reader, reader.uint32());
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

  fromJSON(object: any): EventProofUpdated {
    return {
      claim: isSet(object.claim) ? Claim.fromJSON(object.claim) : undefined,
      proof: isSet(object.proof) ? Proof.fromJSON(object.proof) : undefined,
      numRelays: isSet(object.numRelays) ? globalThis.Number(object.numRelays) : 0,
      numClaimedComputeUnits: isSet(object.numClaimedComputeUnits)
        ? globalThis.Number(object.numClaimedComputeUnits)
        : 0,
      numEstimatedComputeUnits: isSet(object.numEstimatedComputeUnits)
        ? globalThis.Number(object.numEstimatedComputeUnits)
        : 0,
      claimedUpokt: isSet(object.claimedUpokt) ? Coin.fromJSON(object.claimedUpokt) : undefined,
    };
  },

  toJSON(message: EventProofUpdated): unknown {
    const obj: any = {};
    if (message.claim !== undefined) {
      obj.claim = Claim.toJSON(message.claim);
    }
    if (message.proof !== undefined) {
      obj.proof = Proof.toJSON(message.proof);
    }
    if (message.numRelays !== 0) {
      obj.numRelays = Math.round(message.numRelays);
    }
    if (message.numClaimedComputeUnits !== 0) {
      obj.numClaimedComputeUnits = Math.round(message.numClaimedComputeUnits);
    }
    if (message.numEstimatedComputeUnits !== 0) {
      obj.numEstimatedComputeUnits = Math.round(message.numEstimatedComputeUnits);
    }
    if (message.claimedUpokt !== undefined) {
      obj.claimedUpokt = Coin.toJSON(message.claimedUpokt);
    }
    return obj;
  },

  create<I extends Exact<DeepPartial<EventProofUpdated>, I>>(base?: I): EventProofUpdated {
    return EventProofUpdated.fromPartial(base ?? ({} as any));
  },
  fromPartial<I extends Exact<DeepPartial<EventProofUpdated>, I>>(object: I): EventProofUpdated {
    const message = createBaseEventProofUpdated();
    message.claim = (object.claim !== undefined && object.claim !== null) ? Claim.fromPartial(object.claim) : undefined;
    message.proof = (object.proof !== undefined && object.proof !== null) ? Proof.fromPartial(object.proof) : undefined;
    message.numRelays = object.numRelays ?? 0;
    message.numClaimedComputeUnits = object.numClaimedComputeUnits ?? 0;
    message.numEstimatedComputeUnits = object.numEstimatedComputeUnits ?? 0;
    message.claimedUpokt = (object.claimedUpokt !== undefined && object.claimedUpokt !== null)
      ? Coin.fromPartial(object.claimedUpokt)
      : undefined;
    return message;
  },
};

function createBaseEventProofValidityChecked(): EventProofValidityChecked {
  return { proof: undefined, blockHeight: 0, proofStatus: 0, failureReason: "" };
}

export const EventProofValidityChecked: MessageFns<EventProofValidityChecked> = {
  encode(message: EventProofValidityChecked, writer: BinaryWriter = new BinaryWriter()): BinaryWriter {
    if (message.proof !== undefined) {
      Proof.encode(message.proof, writer.uint32(10).fork()).join();
    }
    if (message.blockHeight !== 0) {
      writer.uint32(16).uint64(message.blockHeight);
    }
    if (message.proofStatus !== 0) {
      writer.uint32(24).int32(message.proofStatus);
    }
    if (message.failureReason !== "") {
      writer.uint32(34).string(message.failureReason);
    }
    return writer;
  },

  decode(input: BinaryReader | Uint8Array, length?: number): EventProofValidityChecked {
    const reader = input instanceof BinaryReader ? input : new BinaryReader(input);
    let end = length === undefined ? reader.len : reader.pos + length;
    const message = createBaseEventProofValidityChecked();
    while (reader.pos < end) {
      const tag = reader.uint32();
      switch (tag >>> 3) {
        case 1: {
          if (tag !== 10) {
            break;
          }

          message.proof = Proof.decode(reader, reader.uint32());
          continue;
        }
        case 2: {
          if (tag !== 16) {
            break;
          }

          message.blockHeight = longToNumber(reader.uint64());
          continue;
        }
        case 3: {
          if (tag !== 24) {
            break;
          }

          message.proofStatus = reader.int32() as any;
          continue;
        }
        case 4: {
          if (tag !== 34) {
            break;
          }

          message.failureReason = reader.string();
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

  fromJSON(object: any): EventProofValidityChecked {
    return {
      proof: isSet(object.proof) ? Proof.fromJSON(object.proof) : undefined,
      blockHeight: isSet(object.blockHeight) ? globalThis.Number(object.blockHeight) : 0,
      proofStatus: isSet(object.proofStatus) ? claimProofStatusFromJSON(object.proofStatus) : 0,
      failureReason: isSet(object.failureReason) ? globalThis.String(object.failureReason) : "",
    };
  },

  toJSON(message: EventProofValidityChecked): unknown {
    const obj: any = {};
    if (message.proof !== undefined) {
      obj.proof = Proof.toJSON(message.proof);
    }
    if (message.blockHeight !== 0) {
      obj.blockHeight = Math.round(message.blockHeight);
    }
    if (message.proofStatus !== 0) {
      obj.proofStatus = claimProofStatusToJSON(message.proofStatus);
    }
    if (message.failureReason !== "") {
      obj.failureReason = message.failureReason;
    }
    return obj;
  },

  create<I extends Exact<DeepPartial<EventProofValidityChecked>, I>>(base?: I): EventProofValidityChecked {
    return EventProofValidityChecked.fromPartial(base ?? ({} as any));
  },
  fromPartial<I extends Exact<DeepPartial<EventProofValidityChecked>, I>>(object: I): EventProofValidityChecked {
    const message = createBaseEventProofValidityChecked();
    message.proof = (object.proof !== undefined && object.proof !== null) ? Proof.fromPartial(object.proof) : undefined;
    message.blockHeight = object.blockHeight ?? 0;
    message.proofStatus = object.proofStatus ?? 0;
    message.failureReason = object.failureReason ?? "";
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
