// Code generated by protoc-gen-ts_proto. DO NOT EDIT.
// versions:
//   protoc-gen-ts_proto  v2.2.0
//   protoc               unknown
// source: poktroll/proof/tx.proto

/* eslint-disable */
import { BinaryReader, BinaryWriter } from "@bufbuild/protobuf/wire";
import { Coin } from "../../cosmos/base/v1beta1/coin";
import { SessionHeader } from "../session/types";
import { Params } from "./params";
import { Claim, Proof } from "./types";

export const protobufPackage = "poktroll.proof";

/** MsgUpdateParams is the Msg/UpdateParams request type to update all params at once. */
export interface MsgUpdateParams {
  /** authority is the address that controls the module (defaults to x/gov unless overwritten). */
  authority: string;
  /**
   * params defines the x/proof parameters to update.
   * NOTE: All parameters must be supplied.
   */
  params: Params | undefined;
}

/**
 * MsgUpdateParamsResponse defines the response structure for executing a
 * MsgUpdateParams message.
 */
export interface MsgUpdateParamsResponse {
}

/** MsgUpdateParam is the Msg/UpdateParam request type to update a single param. */
export interface MsgUpdateParam {
  /** authority is the address that controls the module (defaults to x/gov unless overwritten). */
  authority: string;
  /**
   * The (name, as_type) tuple must match the corresponding name and type as
   * specified in the `Params`` message in `proof/params.proto.`
   */
  name: string;
  asBytes?: Uint8Array | undefined;
  asFloat?: number | undefined;
  asCoin?: Coin | undefined;
}

/**
 * MsgUpdateParamResponse defines the response structure for executing a
 * MsgUpdateParam message after a single param update.
 */
export interface MsgUpdateParamResponse {
  params: Params | undefined;
}

export interface MsgCreateClaim {
  supplierOperatorAddress: string;
  sessionHeader:
    | SessionHeader
    | undefined;
  /** root returned from smt.SMST#Root() */
  rootHash: Uint8Array;
}

export interface MsgCreateClaimResponse {
  claim: Claim | undefined;
}

export interface MsgSubmitProof {
  supplierOperatorAddress: string;
  sessionHeader:
    | SessionHeader
    | undefined;
  /** serialized version of *smt.SparseCompactMerkleClosestProof */
  proof: Uint8Array;
}

export interface MsgSubmitProofResponse {
  proof: Proof | undefined;
}

function createBaseMsgUpdateParams(): MsgUpdateParams {
  return { authority: "", params: undefined };
}

export const MsgUpdateParams: MessageFns<MsgUpdateParams> = {
  encode(message: MsgUpdateParams, writer: BinaryWriter = new BinaryWriter()): BinaryWriter {
    if (message.authority !== "") {
      writer.uint32(10).string(message.authority);
    }
    if (message.params !== undefined) {
      Params.encode(message.params, writer.uint32(18).fork()).join();
    }
    return writer;
  },

  decode(input: BinaryReader | Uint8Array, length?: number): MsgUpdateParams {
    const reader = input instanceof BinaryReader ? input : new BinaryReader(input);
    let end = length === undefined ? reader.len : reader.pos + length;
    const message = createBaseMsgUpdateParams();
    while (reader.pos < end) {
      const tag = reader.uint32();
      switch (tag >>> 3) {
        case 1:
          if (tag !== 10) {
            break;
          }

          message.authority = reader.string();
          continue;
        case 2:
          if (tag !== 18) {
            break;
          }

          message.params = Params.decode(reader, reader.uint32());
          continue;
      }
      if ((tag & 7) === 4 || tag === 0) {
        break;
      }
      reader.skip(tag & 7);
    }
    return message;
  },

  fromJSON(object: any): MsgUpdateParams {
    return {
      authority: isSet(object.authority) ? globalThis.String(object.authority) : "",
      params: isSet(object.params) ? Params.fromJSON(object.params) : undefined,
    };
  },

  toJSON(message: MsgUpdateParams): unknown {
    const obj: any = {};
    if (message.authority !== "") {
      obj.authority = message.authority;
    }
    if (message.params !== undefined) {
      obj.params = Params.toJSON(message.params);
    }
    return obj;
  },

  create<I extends Exact<DeepPartial<MsgUpdateParams>, I>>(base?: I): MsgUpdateParams {
    return MsgUpdateParams.fromPartial(base ?? ({} as any));
  },
  fromPartial<I extends Exact<DeepPartial<MsgUpdateParams>, I>>(object: I): MsgUpdateParams {
    const message = createBaseMsgUpdateParams();
    message.authority = object.authority ?? "";
    message.params = (object.params !== undefined && object.params !== null)
      ? Params.fromPartial(object.params)
      : undefined;
    return message;
  },
};

function createBaseMsgUpdateParamsResponse(): MsgUpdateParamsResponse {
  return {};
}

export const MsgUpdateParamsResponse: MessageFns<MsgUpdateParamsResponse> = {
  encode(_: MsgUpdateParamsResponse, writer: BinaryWriter = new BinaryWriter()): BinaryWriter {
    return writer;
  },

  decode(input: BinaryReader | Uint8Array, length?: number): MsgUpdateParamsResponse {
    const reader = input instanceof BinaryReader ? input : new BinaryReader(input);
    let end = length === undefined ? reader.len : reader.pos + length;
    const message = createBaseMsgUpdateParamsResponse();
    while (reader.pos < end) {
      const tag = reader.uint32();
      switch (tag >>> 3) {
      }
      if ((tag & 7) === 4 || tag === 0) {
        break;
      }
      reader.skip(tag & 7);
    }
    return message;
  },

  fromJSON(_: any): MsgUpdateParamsResponse {
    return {};
  },

  toJSON(_: MsgUpdateParamsResponse): unknown {
    const obj: any = {};
    return obj;
  },

  create<I extends Exact<DeepPartial<MsgUpdateParamsResponse>, I>>(base?: I): MsgUpdateParamsResponse {
    return MsgUpdateParamsResponse.fromPartial(base ?? ({} as any));
  },
  fromPartial<I extends Exact<DeepPartial<MsgUpdateParamsResponse>, I>>(_: I): MsgUpdateParamsResponse {
    const message = createBaseMsgUpdateParamsResponse();
    return message;
  },
};

function createBaseMsgUpdateParam(): MsgUpdateParam {
  return { authority: "", name: "", asBytes: undefined, asFloat: undefined, asCoin: undefined };
}

export const MsgUpdateParam: MessageFns<MsgUpdateParam> = {
  encode(message: MsgUpdateParam, writer: BinaryWriter = new BinaryWriter()): BinaryWriter {
    if (message.authority !== "") {
      writer.uint32(10).string(message.authority);
    }
    if (message.name !== "") {
      writer.uint32(18).string(message.name);
    }
    if (message.asBytes !== undefined) {
      writer.uint32(58).bytes(message.asBytes);
    }
    if (message.asFloat !== undefined) {
      writer.uint32(69).float(message.asFloat);
    }
    if (message.asCoin !== undefined) {
      Coin.encode(message.asCoin, writer.uint32(74).fork()).join();
    }
    return writer;
  },

  decode(input: BinaryReader | Uint8Array, length?: number): MsgUpdateParam {
    const reader = input instanceof BinaryReader ? input : new BinaryReader(input);
    let end = length === undefined ? reader.len : reader.pos + length;
    const message = createBaseMsgUpdateParam();
    while (reader.pos < end) {
      const tag = reader.uint32();
      switch (tag >>> 3) {
        case 1:
          if (tag !== 10) {
            break;
          }

          message.authority = reader.string();
          continue;
        case 2:
          if (tag !== 18) {
            break;
          }

          message.name = reader.string();
          continue;
        case 7:
          if (tag !== 58) {
            break;
          }

          message.asBytes = reader.bytes();
          continue;
        case 8:
          if (tag !== 69) {
            break;
          }

          message.asFloat = reader.float();
          continue;
        case 9:
          if (tag !== 74) {
            break;
          }

          message.asCoin = Coin.decode(reader, reader.uint32());
          continue;
      }
      if ((tag & 7) === 4 || tag === 0) {
        break;
      }
      reader.skip(tag & 7);
    }
    return message;
  },

  fromJSON(object: any): MsgUpdateParam {
    return {
      authority: isSet(object.authority) ? globalThis.String(object.authority) : "",
      name: isSet(object.name) ? globalThis.String(object.name) : "",
      asBytes: isSet(object.asBytes) ? bytesFromBase64(object.asBytes) : undefined,
      asFloat: isSet(object.asFloat) ? globalThis.Number(object.asFloat) : undefined,
      asCoin: isSet(object.asCoin) ? Coin.fromJSON(object.asCoin) : undefined,
    };
  },

  toJSON(message: MsgUpdateParam): unknown {
    const obj: any = {};
    if (message.authority !== "") {
      obj.authority = message.authority;
    }
    if (message.name !== "") {
      obj.name = message.name;
    }
    if (message.asBytes !== undefined) {
      obj.asBytes = base64FromBytes(message.asBytes);
    }
    if (message.asFloat !== undefined) {
      obj.asFloat = message.asFloat;
    }
    if (message.asCoin !== undefined) {
      obj.asCoin = Coin.toJSON(message.asCoin);
    }
    return obj;
  },

  create<I extends Exact<DeepPartial<MsgUpdateParam>, I>>(base?: I): MsgUpdateParam {
    return MsgUpdateParam.fromPartial(base ?? ({} as any));
  },
  fromPartial<I extends Exact<DeepPartial<MsgUpdateParam>, I>>(object: I): MsgUpdateParam {
    const message = createBaseMsgUpdateParam();
    message.authority = object.authority ?? "";
    message.name = object.name ?? "";
    message.asBytes = object.asBytes ?? undefined;
    message.asFloat = object.asFloat ?? undefined;
    message.asCoin = (object.asCoin !== undefined && object.asCoin !== null)
      ? Coin.fromPartial(object.asCoin)
      : undefined;
    return message;
  },
};

function createBaseMsgUpdateParamResponse(): MsgUpdateParamResponse {
  return { params: undefined };
}

export const MsgUpdateParamResponse: MessageFns<MsgUpdateParamResponse> = {
  encode(message: MsgUpdateParamResponse, writer: BinaryWriter = new BinaryWriter()): BinaryWriter {
    if (message.params !== undefined) {
      Params.encode(message.params, writer.uint32(10).fork()).join();
    }
    return writer;
  },

  decode(input: BinaryReader | Uint8Array, length?: number): MsgUpdateParamResponse {
    const reader = input instanceof BinaryReader ? input : new BinaryReader(input);
    let end = length === undefined ? reader.len : reader.pos + length;
    const message = createBaseMsgUpdateParamResponse();
    while (reader.pos < end) {
      const tag = reader.uint32();
      switch (tag >>> 3) {
        case 1:
          if (tag !== 10) {
            break;
          }

          message.params = Params.decode(reader, reader.uint32());
          continue;
      }
      if ((tag & 7) === 4 || tag === 0) {
        break;
      }
      reader.skip(tag & 7);
    }
    return message;
  },

  fromJSON(object: any): MsgUpdateParamResponse {
    return { params: isSet(object.params) ? Params.fromJSON(object.params) : undefined };
  },

  toJSON(message: MsgUpdateParamResponse): unknown {
    const obj: any = {};
    if (message.params !== undefined) {
      obj.params = Params.toJSON(message.params);
    }
    return obj;
  },

  create<I extends Exact<DeepPartial<MsgUpdateParamResponse>, I>>(base?: I): MsgUpdateParamResponse {
    return MsgUpdateParamResponse.fromPartial(base ?? ({} as any));
  },
  fromPartial<I extends Exact<DeepPartial<MsgUpdateParamResponse>, I>>(object: I): MsgUpdateParamResponse {
    const message = createBaseMsgUpdateParamResponse();
    message.params = (object.params !== undefined && object.params !== null)
      ? Params.fromPartial(object.params)
      : undefined;
    return message;
  },
};

function createBaseMsgCreateClaim(): MsgCreateClaim {
  return { supplierOperatorAddress: "", sessionHeader: undefined, rootHash: new Uint8Array(0) };
}

export const MsgCreateClaim: MessageFns<MsgCreateClaim> = {
  encode(message: MsgCreateClaim, writer: BinaryWriter = new BinaryWriter()): BinaryWriter {
    if (message.supplierOperatorAddress !== "") {
      writer.uint32(10).string(message.supplierOperatorAddress);
    }
    if (message.sessionHeader !== undefined) {
      SessionHeader.encode(message.sessionHeader, writer.uint32(18).fork()).join();
    }
    if (message.rootHash.length !== 0) {
      writer.uint32(26).bytes(message.rootHash);
    }
    return writer;
  },

  decode(input: BinaryReader | Uint8Array, length?: number): MsgCreateClaim {
    const reader = input instanceof BinaryReader ? input : new BinaryReader(input);
    let end = length === undefined ? reader.len : reader.pos + length;
    const message = createBaseMsgCreateClaim();
    while (reader.pos < end) {
      const tag = reader.uint32();
      switch (tag >>> 3) {
        case 1:
          if (tag !== 10) {
            break;
          }

          message.supplierOperatorAddress = reader.string();
          continue;
        case 2:
          if (tag !== 18) {
            break;
          }

          message.sessionHeader = SessionHeader.decode(reader, reader.uint32());
          continue;
        case 3:
          if (tag !== 26) {
            break;
          }

          message.rootHash = reader.bytes();
          continue;
      }
      if ((tag & 7) === 4 || tag === 0) {
        break;
      }
      reader.skip(tag & 7);
    }
    return message;
  },

  fromJSON(object: any): MsgCreateClaim {
    return {
      supplierOperatorAddress: isSet(object.supplierOperatorAddress)
        ? globalThis.String(object.supplierOperatorAddress)
        : "",
      sessionHeader: isSet(object.sessionHeader) ? SessionHeader.fromJSON(object.sessionHeader) : undefined,
      rootHash: isSet(object.rootHash) ? bytesFromBase64(object.rootHash) : new Uint8Array(0),
    };
  },

  toJSON(message: MsgCreateClaim): unknown {
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
    return obj;
  },

  create<I extends Exact<DeepPartial<MsgCreateClaim>, I>>(base?: I): MsgCreateClaim {
    return MsgCreateClaim.fromPartial(base ?? ({} as any));
  },
  fromPartial<I extends Exact<DeepPartial<MsgCreateClaim>, I>>(object: I): MsgCreateClaim {
    const message = createBaseMsgCreateClaim();
    message.supplierOperatorAddress = object.supplierOperatorAddress ?? "";
    message.sessionHeader = (object.sessionHeader !== undefined && object.sessionHeader !== null)
      ? SessionHeader.fromPartial(object.sessionHeader)
      : undefined;
    message.rootHash = object.rootHash ?? new Uint8Array(0);
    return message;
  },
};

function createBaseMsgCreateClaimResponse(): MsgCreateClaimResponse {
  return { claim: undefined };
}

export const MsgCreateClaimResponse: MessageFns<MsgCreateClaimResponse> = {
  encode(message: MsgCreateClaimResponse, writer: BinaryWriter = new BinaryWriter()): BinaryWriter {
    if (message.claim !== undefined) {
      Claim.encode(message.claim, writer.uint32(10).fork()).join();
    }
    return writer;
  },

  decode(input: BinaryReader | Uint8Array, length?: number): MsgCreateClaimResponse {
    const reader = input instanceof BinaryReader ? input : new BinaryReader(input);
    let end = length === undefined ? reader.len : reader.pos + length;
    const message = createBaseMsgCreateClaimResponse();
    while (reader.pos < end) {
      const tag = reader.uint32();
      switch (tag >>> 3) {
        case 1:
          if (tag !== 10) {
            break;
          }

          message.claim = Claim.decode(reader, reader.uint32());
          continue;
      }
      if ((tag & 7) === 4 || tag === 0) {
        break;
      }
      reader.skip(tag & 7);
    }
    return message;
  },

  fromJSON(object: any): MsgCreateClaimResponse {
    return { claim: isSet(object.claim) ? Claim.fromJSON(object.claim) : undefined };
  },

  toJSON(message: MsgCreateClaimResponse): unknown {
    const obj: any = {};
    if (message.claim !== undefined) {
      obj.claim = Claim.toJSON(message.claim);
    }
    return obj;
  },

  create<I extends Exact<DeepPartial<MsgCreateClaimResponse>, I>>(base?: I): MsgCreateClaimResponse {
    return MsgCreateClaimResponse.fromPartial(base ?? ({} as any));
  },
  fromPartial<I extends Exact<DeepPartial<MsgCreateClaimResponse>, I>>(object: I): MsgCreateClaimResponse {
    const message = createBaseMsgCreateClaimResponse();
    message.claim = (object.claim !== undefined && object.claim !== null) ? Claim.fromPartial(object.claim) : undefined;
    return message;
  },
};

function createBaseMsgSubmitProof(): MsgSubmitProof {
  return { supplierOperatorAddress: "", sessionHeader: undefined, proof: new Uint8Array(0) };
}

export const MsgSubmitProof: MessageFns<MsgSubmitProof> = {
  encode(message: MsgSubmitProof, writer: BinaryWriter = new BinaryWriter()): BinaryWriter {
    if (message.supplierOperatorAddress !== "") {
      writer.uint32(10).string(message.supplierOperatorAddress);
    }
    if (message.sessionHeader !== undefined) {
      SessionHeader.encode(message.sessionHeader, writer.uint32(18).fork()).join();
    }
    if (message.proof.length !== 0) {
      writer.uint32(26).bytes(message.proof);
    }
    return writer;
  },

  decode(input: BinaryReader | Uint8Array, length?: number): MsgSubmitProof {
    const reader = input instanceof BinaryReader ? input : new BinaryReader(input);
    let end = length === undefined ? reader.len : reader.pos + length;
    const message = createBaseMsgSubmitProof();
    while (reader.pos < end) {
      const tag = reader.uint32();
      switch (tag >>> 3) {
        case 1:
          if (tag !== 10) {
            break;
          }

          message.supplierOperatorAddress = reader.string();
          continue;
        case 2:
          if (tag !== 18) {
            break;
          }

          message.sessionHeader = SessionHeader.decode(reader, reader.uint32());
          continue;
        case 3:
          if (tag !== 26) {
            break;
          }

          message.proof = reader.bytes();
          continue;
      }
      if ((tag & 7) === 4 || tag === 0) {
        break;
      }
      reader.skip(tag & 7);
    }
    return message;
  },

  fromJSON(object: any): MsgSubmitProof {
    return {
      supplierOperatorAddress: isSet(object.supplierOperatorAddress)
        ? globalThis.String(object.supplierOperatorAddress)
        : "",
      sessionHeader: isSet(object.sessionHeader) ? SessionHeader.fromJSON(object.sessionHeader) : undefined,
      proof: isSet(object.proof) ? bytesFromBase64(object.proof) : new Uint8Array(0),
    };
  },

  toJSON(message: MsgSubmitProof): unknown {
    const obj: any = {};
    if (message.supplierOperatorAddress !== "") {
      obj.supplierOperatorAddress = message.supplierOperatorAddress;
    }
    if (message.sessionHeader !== undefined) {
      obj.sessionHeader = SessionHeader.toJSON(message.sessionHeader);
    }
    if (message.proof.length !== 0) {
      obj.proof = base64FromBytes(message.proof);
    }
    return obj;
  },

  create<I extends Exact<DeepPartial<MsgSubmitProof>, I>>(base?: I): MsgSubmitProof {
    return MsgSubmitProof.fromPartial(base ?? ({} as any));
  },
  fromPartial<I extends Exact<DeepPartial<MsgSubmitProof>, I>>(object: I): MsgSubmitProof {
    const message = createBaseMsgSubmitProof();
    message.supplierOperatorAddress = object.supplierOperatorAddress ?? "";
    message.sessionHeader = (object.sessionHeader !== undefined && object.sessionHeader !== null)
      ? SessionHeader.fromPartial(object.sessionHeader)
      : undefined;
    message.proof = object.proof ?? new Uint8Array(0);
    return message;
  },
};

function createBaseMsgSubmitProofResponse(): MsgSubmitProofResponse {
  return { proof: undefined };
}

export const MsgSubmitProofResponse: MessageFns<MsgSubmitProofResponse> = {
  encode(message: MsgSubmitProofResponse, writer: BinaryWriter = new BinaryWriter()): BinaryWriter {
    if (message.proof !== undefined) {
      Proof.encode(message.proof, writer.uint32(10).fork()).join();
    }
    return writer;
  },

  decode(input: BinaryReader | Uint8Array, length?: number): MsgSubmitProofResponse {
    const reader = input instanceof BinaryReader ? input : new BinaryReader(input);
    let end = length === undefined ? reader.len : reader.pos + length;
    const message = createBaseMsgSubmitProofResponse();
    while (reader.pos < end) {
      const tag = reader.uint32();
      switch (tag >>> 3) {
        case 1:
          if (tag !== 10) {
            break;
          }

          message.proof = Proof.decode(reader, reader.uint32());
          continue;
      }
      if ((tag & 7) === 4 || tag === 0) {
        break;
      }
      reader.skip(tag & 7);
    }
    return message;
  },

  fromJSON(object: any): MsgSubmitProofResponse {
    return { proof: isSet(object.proof) ? Proof.fromJSON(object.proof) : undefined };
  },

  toJSON(message: MsgSubmitProofResponse): unknown {
    const obj: any = {};
    if (message.proof !== undefined) {
      obj.proof = Proof.toJSON(message.proof);
    }
    return obj;
  },

  create<I extends Exact<DeepPartial<MsgSubmitProofResponse>, I>>(base?: I): MsgSubmitProofResponse {
    return MsgSubmitProofResponse.fromPartial(base ?? ({} as any));
  },
  fromPartial<I extends Exact<DeepPartial<MsgSubmitProofResponse>, I>>(object: I): MsgSubmitProofResponse {
    const message = createBaseMsgSubmitProofResponse();
    message.proof = (object.proof !== undefined && object.proof !== null) ? Proof.fromPartial(object.proof) : undefined;
    return message;
  },
};

/** Msg defines the Msg service. */
export interface Msg {
  /**
   * UpdateParams defines a (governance) operation for updating the module
   * parameters. The authority defaults to the x/gov module account.
   */
  UpdateParams(request: MsgUpdateParams): Promise<MsgUpdateParamsResponse>;
  CreateClaim(request: MsgCreateClaim): Promise<MsgCreateClaimResponse>;
  SubmitProof(request: MsgSubmitProof): Promise<MsgSubmitProofResponse>;
  UpdateParam(request: MsgUpdateParam): Promise<MsgUpdateParamResponse>;
}

export const MsgServiceName = "poktroll.proof.Msg";
export class MsgClientImpl implements Msg {
  private readonly rpc: Rpc;
  private readonly service: string;
  constructor(rpc: Rpc, opts?: { service?: string }) {
    this.service = opts?.service || MsgServiceName;
    this.rpc = rpc;
    this.UpdateParams = this.UpdateParams.bind(this);
    this.CreateClaim = this.CreateClaim.bind(this);
    this.SubmitProof = this.SubmitProof.bind(this);
    this.UpdateParam = this.UpdateParam.bind(this);
  }
  UpdateParams(request: MsgUpdateParams): Promise<MsgUpdateParamsResponse> {
    const data = MsgUpdateParams.encode(request).finish();
    const promise = this.rpc.request(this.service, "UpdateParams", data);
    return promise.then((data) => MsgUpdateParamsResponse.decode(new BinaryReader(data)));
  }

  CreateClaim(request: MsgCreateClaim): Promise<MsgCreateClaimResponse> {
    const data = MsgCreateClaim.encode(request).finish();
    const promise = this.rpc.request(this.service, "CreateClaim", data);
    return promise.then((data) => MsgCreateClaimResponse.decode(new BinaryReader(data)));
  }

  SubmitProof(request: MsgSubmitProof): Promise<MsgSubmitProofResponse> {
    const data = MsgSubmitProof.encode(request).finish();
    const promise = this.rpc.request(this.service, "SubmitProof", data);
    return promise.then((data) => MsgSubmitProofResponse.decode(new BinaryReader(data)));
  }

  UpdateParam(request: MsgUpdateParam): Promise<MsgUpdateParamResponse> {
    const data = MsgUpdateParam.encode(request).finish();
    const promise = this.rpc.request(this.service, "UpdateParam", data);
    return promise.then((data) => MsgUpdateParamResponse.decode(new BinaryReader(data)));
  }
}

interface Rpc {
  request(service: string, method: string, data: Uint8Array): Promise<Uint8Array>;
}

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