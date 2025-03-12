// Code generated by protoc-gen-ts_proto. DO NOT EDIT.
// versions:
//   protoc-gen-ts_proto  v2.6.1
//   protoc               unknown
// source: poktroll/proof/query.proto

/* eslint-disable */
import { BinaryReader, BinaryWriter } from "@bufbuild/protobuf/wire";
import { PageRequest, PageResponse } from "../../cosmos/base/query/v1beta1/pagination";
import { Params } from "./params";
import { Claim, Proof } from "./types";

export const protobufPackage = "poktroll.proof";

/** QueryParamsRequest is request type for the Query/Params RPC method. */
export interface QueryParamsRequest {
}

/** QueryParamsResponse is response type for the Query/Params RPC method. */
export interface QueryParamsResponse {
  /** params holds all the parameters of this module. */
  params: Params | undefined;
}

export interface QueryGetClaimRequest {
  sessionId: string;
  supplierOperatorAddress: string;
}

export interface QueryGetClaimResponse {
  claim: Claim | undefined;
}

export interface QueryAllClaimsRequest {
  pagination: PageRequest | undefined;
  supplierOperatorAddress?: string | undefined;
  sessionId?: string | undefined;
  sessionEndHeight?: number | undefined;
}

export interface QueryAllClaimsResponse {
  claims: Claim[];
  pagination: PageResponse | undefined;
}

export interface QueryGetProofRequest {
  sessionId: string;
  supplierOperatorAddress: string;
}

export interface QueryGetProofResponse {
  proof: Proof | undefined;
}

export interface QueryAllProofsRequest {
  pagination: PageRequest | undefined;
  supplierOperatorAddress?: string | undefined;
  sessionId?: string | undefined;
  sessionEndHeight?: number | undefined;
}

export interface QueryAllProofsResponse {
  proofs: Proof[];
  pagination: PageResponse | undefined;
}

function createBaseQueryParamsRequest(): QueryParamsRequest {
  return {};
}

export const QueryParamsRequest: MessageFns<QueryParamsRequest> = {
  encode(_: QueryParamsRequest, writer: BinaryWriter = new BinaryWriter()): BinaryWriter {
    return writer;
  },

  decode(input: BinaryReader | Uint8Array, length?: number): QueryParamsRequest {
    const reader = input instanceof BinaryReader ? input : new BinaryReader(input);
    let end = length === undefined ? reader.len : reader.pos + length;
    const message = createBaseQueryParamsRequest();
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

  fromJSON(_: any): QueryParamsRequest {
    return {};
  },

  toJSON(_: QueryParamsRequest): unknown {
    const obj: any = {};
    return obj;
  },

  create<I extends Exact<DeepPartial<QueryParamsRequest>, I>>(base?: I): QueryParamsRequest {
    return QueryParamsRequest.fromPartial(base ?? ({} as any));
  },
  fromPartial<I extends Exact<DeepPartial<QueryParamsRequest>, I>>(_: I): QueryParamsRequest {
    const message = createBaseQueryParamsRequest();
    return message;
  },
};

function createBaseQueryParamsResponse(): QueryParamsResponse {
  return { params: undefined };
}

export const QueryParamsResponse: MessageFns<QueryParamsResponse> = {
  encode(message: QueryParamsResponse, writer: BinaryWriter = new BinaryWriter()): BinaryWriter {
    if (message.params !== undefined) {
      Params.encode(message.params, writer.uint32(10).fork()).join();
    }
    return writer;
  },

  decode(input: BinaryReader | Uint8Array, length?: number): QueryParamsResponse {
    const reader = input instanceof BinaryReader ? input : new BinaryReader(input);
    let end = length === undefined ? reader.len : reader.pos + length;
    const message = createBaseQueryParamsResponse();
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
      }
      if ((tag & 7) === 4 || tag === 0) {
        break;
      }
      reader.skip(tag & 7);
    }
    return message;
  },

  fromJSON(object: any): QueryParamsResponse {
    return { params: isSet(object.params) ? Params.fromJSON(object.params) : undefined };
  },

  toJSON(message: QueryParamsResponse): unknown {
    const obj: any = {};
    if (message.params !== undefined) {
      obj.params = Params.toJSON(message.params);
    }
    return obj;
  },

  create<I extends Exact<DeepPartial<QueryParamsResponse>, I>>(base?: I): QueryParamsResponse {
    return QueryParamsResponse.fromPartial(base ?? ({} as any));
  },
  fromPartial<I extends Exact<DeepPartial<QueryParamsResponse>, I>>(object: I): QueryParamsResponse {
    const message = createBaseQueryParamsResponse();
    message.params = (object.params !== undefined && object.params !== null)
      ? Params.fromPartial(object.params)
      : undefined;
    return message;
  },
};

function createBaseQueryGetClaimRequest(): QueryGetClaimRequest {
  return { sessionId: "", supplierOperatorAddress: "" };
}

export const QueryGetClaimRequest: MessageFns<QueryGetClaimRequest> = {
  encode(message: QueryGetClaimRequest, writer: BinaryWriter = new BinaryWriter()): BinaryWriter {
    if (message.sessionId !== "") {
      writer.uint32(10).string(message.sessionId);
    }
    if (message.supplierOperatorAddress !== "") {
      writer.uint32(18).string(message.supplierOperatorAddress);
    }
    return writer;
  },

  decode(input: BinaryReader | Uint8Array, length?: number): QueryGetClaimRequest {
    const reader = input instanceof BinaryReader ? input : new BinaryReader(input);
    let end = length === undefined ? reader.len : reader.pos + length;
    const message = createBaseQueryGetClaimRequest();
    while (reader.pos < end) {
      const tag = reader.uint32();
      switch (tag >>> 3) {
        case 1: {
          if (tag !== 10) {
            break;
          }

          message.sessionId = reader.string();
          continue;
        }
        case 2: {
          if (tag !== 18) {
            break;
          }

          message.supplierOperatorAddress = reader.string();
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

  fromJSON(object: any): QueryGetClaimRequest {
    return {
      sessionId: isSet(object.sessionId) ? globalThis.String(object.sessionId) : "",
      supplierOperatorAddress: isSet(object.supplierOperatorAddress)
        ? globalThis.String(object.supplierOperatorAddress)
        : "",
    };
  },

  toJSON(message: QueryGetClaimRequest): unknown {
    const obj: any = {};
    if (message.sessionId !== "") {
      obj.sessionId = message.sessionId;
    }
    if (message.supplierOperatorAddress !== "") {
      obj.supplierOperatorAddress = message.supplierOperatorAddress;
    }
    return obj;
  },

  create<I extends Exact<DeepPartial<QueryGetClaimRequest>, I>>(base?: I): QueryGetClaimRequest {
    return QueryGetClaimRequest.fromPartial(base ?? ({} as any));
  },
  fromPartial<I extends Exact<DeepPartial<QueryGetClaimRequest>, I>>(object: I): QueryGetClaimRequest {
    const message = createBaseQueryGetClaimRequest();
    message.sessionId = object.sessionId ?? "";
    message.supplierOperatorAddress = object.supplierOperatorAddress ?? "";
    return message;
  },
};

function createBaseQueryGetClaimResponse(): QueryGetClaimResponse {
  return { claim: undefined };
}

export const QueryGetClaimResponse: MessageFns<QueryGetClaimResponse> = {
  encode(message: QueryGetClaimResponse, writer: BinaryWriter = new BinaryWriter()): BinaryWriter {
    if (message.claim !== undefined) {
      Claim.encode(message.claim, writer.uint32(10).fork()).join();
    }
    return writer;
  },

  decode(input: BinaryReader | Uint8Array, length?: number): QueryGetClaimResponse {
    const reader = input instanceof BinaryReader ? input : new BinaryReader(input);
    let end = length === undefined ? reader.len : reader.pos + length;
    const message = createBaseQueryGetClaimResponse();
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
      }
      if ((tag & 7) === 4 || tag === 0) {
        break;
      }
      reader.skip(tag & 7);
    }
    return message;
  },

  fromJSON(object: any): QueryGetClaimResponse {
    return { claim: isSet(object.claim) ? Claim.fromJSON(object.claim) : undefined };
  },

  toJSON(message: QueryGetClaimResponse): unknown {
    const obj: any = {};
    if (message.claim !== undefined) {
      obj.claim = Claim.toJSON(message.claim);
    }
    return obj;
  },

  create<I extends Exact<DeepPartial<QueryGetClaimResponse>, I>>(base?: I): QueryGetClaimResponse {
    return QueryGetClaimResponse.fromPartial(base ?? ({} as any));
  },
  fromPartial<I extends Exact<DeepPartial<QueryGetClaimResponse>, I>>(object: I): QueryGetClaimResponse {
    const message = createBaseQueryGetClaimResponse();
    message.claim = (object.claim !== undefined && object.claim !== null) ? Claim.fromPartial(object.claim) : undefined;
    return message;
  },
};

function createBaseQueryAllClaimsRequest(): QueryAllClaimsRequest {
  return {
    pagination: undefined,
    supplierOperatorAddress: undefined,
    sessionId: undefined,
    sessionEndHeight: undefined,
  };
}

export const QueryAllClaimsRequest: MessageFns<QueryAllClaimsRequest> = {
  encode(message: QueryAllClaimsRequest, writer: BinaryWriter = new BinaryWriter()): BinaryWriter {
    if (message.pagination !== undefined) {
      PageRequest.encode(message.pagination, writer.uint32(10).fork()).join();
    }
    if (message.supplierOperatorAddress !== undefined) {
      writer.uint32(18).string(message.supplierOperatorAddress);
    }
    if (message.sessionId !== undefined) {
      writer.uint32(26).string(message.sessionId);
    }
    if (message.sessionEndHeight !== undefined) {
      writer.uint32(32).uint64(message.sessionEndHeight);
    }
    return writer;
  },

  decode(input: BinaryReader | Uint8Array, length?: number): QueryAllClaimsRequest {
    const reader = input instanceof BinaryReader ? input : new BinaryReader(input);
    let end = length === undefined ? reader.len : reader.pos + length;
    const message = createBaseQueryAllClaimsRequest();
    while (reader.pos < end) {
      const tag = reader.uint32();
      switch (tag >>> 3) {
        case 1: {
          if (tag !== 10) {
            break;
          }

          message.pagination = PageRequest.decode(reader, reader.uint32());
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

          message.sessionId = reader.string();
          continue;
        }
        case 4: {
          if (tag !== 32) {
            break;
          }

          message.sessionEndHeight = longToNumber(reader.uint64());
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

  fromJSON(object: any): QueryAllClaimsRequest {
    return {
      pagination: isSet(object.pagination) ? PageRequest.fromJSON(object.pagination) : undefined,
      supplierOperatorAddress: isSet(object.supplierOperatorAddress)
        ? globalThis.String(object.supplierOperatorAddress)
        : undefined,
      sessionId: isSet(object.sessionId) ? globalThis.String(object.sessionId) : undefined,
      sessionEndHeight: isSet(object.sessionEndHeight) ? globalThis.Number(object.sessionEndHeight) : undefined,
    };
  },

  toJSON(message: QueryAllClaimsRequest): unknown {
    const obj: any = {};
    if (message.pagination !== undefined) {
      obj.pagination = PageRequest.toJSON(message.pagination);
    }
    if (message.supplierOperatorAddress !== undefined) {
      obj.supplierOperatorAddress = message.supplierOperatorAddress;
    }
    if (message.sessionId !== undefined) {
      obj.sessionId = message.sessionId;
    }
    if (message.sessionEndHeight !== undefined) {
      obj.sessionEndHeight = Math.round(message.sessionEndHeight);
    }
    return obj;
  },

  create<I extends Exact<DeepPartial<QueryAllClaimsRequest>, I>>(base?: I): QueryAllClaimsRequest {
    return QueryAllClaimsRequest.fromPartial(base ?? ({} as any));
  },
  fromPartial<I extends Exact<DeepPartial<QueryAllClaimsRequest>, I>>(object: I): QueryAllClaimsRequest {
    const message = createBaseQueryAllClaimsRequest();
    message.pagination = (object.pagination !== undefined && object.pagination !== null)
      ? PageRequest.fromPartial(object.pagination)
      : undefined;
    message.supplierOperatorAddress = object.supplierOperatorAddress ?? undefined;
    message.sessionId = object.sessionId ?? undefined;
    message.sessionEndHeight = object.sessionEndHeight ?? undefined;
    return message;
  },
};

function createBaseQueryAllClaimsResponse(): QueryAllClaimsResponse {
  return { claims: [], pagination: undefined };
}

export const QueryAllClaimsResponse: MessageFns<QueryAllClaimsResponse> = {
  encode(message: QueryAllClaimsResponse, writer: BinaryWriter = new BinaryWriter()): BinaryWriter {
    for (const v of message.claims) {
      Claim.encode(v!, writer.uint32(10).fork()).join();
    }
    if (message.pagination !== undefined) {
      PageResponse.encode(message.pagination, writer.uint32(18).fork()).join();
    }
    return writer;
  },

  decode(input: BinaryReader | Uint8Array, length?: number): QueryAllClaimsResponse {
    const reader = input instanceof BinaryReader ? input : new BinaryReader(input);
    let end = length === undefined ? reader.len : reader.pos + length;
    const message = createBaseQueryAllClaimsResponse();
    while (reader.pos < end) {
      const tag = reader.uint32();
      switch (tag >>> 3) {
        case 1: {
          if (tag !== 10) {
            break;
          }

          message.claims.push(Claim.decode(reader, reader.uint32()));
          continue;
        }
        case 2: {
          if (tag !== 18) {
            break;
          }

          message.pagination = PageResponse.decode(reader, reader.uint32());
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

  fromJSON(object: any): QueryAllClaimsResponse {
    return {
      claims: globalThis.Array.isArray(object?.claims) ? object.claims.map((e: any) => Claim.fromJSON(e)) : [],
      pagination: isSet(object.pagination) ? PageResponse.fromJSON(object.pagination) : undefined,
    };
  },

  toJSON(message: QueryAllClaimsResponse): unknown {
    const obj: any = {};
    if (message.claims?.length) {
      obj.claims = message.claims.map((e) => Claim.toJSON(e));
    }
    if (message.pagination !== undefined) {
      obj.pagination = PageResponse.toJSON(message.pagination);
    }
    return obj;
  },

  create<I extends Exact<DeepPartial<QueryAllClaimsResponse>, I>>(base?: I): QueryAllClaimsResponse {
    return QueryAllClaimsResponse.fromPartial(base ?? ({} as any));
  },
  fromPartial<I extends Exact<DeepPartial<QueryAllClaimsResponse>, I>>(object: I): QueryAllClaimsResponse {
    const message = createBaseQueryAllClaimsResponse();
    message.claims = object.claims?.map((e) => Claim.fromPartial(e)) || [];
    message.pagination = (object.pagination !== undefined && object.pagination !== null)
      ? PageResponse.fromPartial(object.pagination)
      : undefined;
    return message;
  },
};

function createBaseQueryGetProofRequest(): QueryGetProofRequest {
  return { sessionId: "", supplierOperatorAddress: "" };
}

export const QueryGetProofRequest: MessageFns<QueryGetProofRequest> = {
  encode(message: QueryGetProofRequest, writer: BinaryWriter = new BinaryWriter()): BinaryWriter {
    if (message.sessionId !== "") {
      writer.uint32(10).string(message.sessionId);
    }
    if (message.supplierOperatorAddress !== "") {
      writer.uint32(18).string(message.supplierOperatorAddress);
    }
    return writer;
  },

  decode(input: BinaryReader | Uint8Array, length?: number): QueryGetProofRequest {
    const reader = input instanceof BinaryReader ? input : new BinaryReader(input);
    let end = length === undefined ? reader.len : reader.pos + length;
    const message = createBaseQueryGetProofRequest();
    while (reader.pos < end) {
      const tag = reader.uint32();
      switch (tag >>> 3) {
        case 1: {
          if (tag !== 10) {
            break;
          }

          message.sessionId = reader.string();
          continue;
        }
        case 2: {
          if (tag !== 18) {
            break;
          }

          message.supplierOperatorAddress = reader.string();
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

  fromJSON(object: any): QueryGetProofRequest {
    return {
      sessionId: isSet(object.sessionId) ? globalThis.String(object.sessionId) : "",
      supplierOperatorAddress: isSet(object.supplierOperatorAddress)
        ? globalThis.String(object.supplierOperatorAddress)
        : "",
    };
  },

  toJSON(message: QueryGetProofRequest): unknown {
    const obj: any = {};
    if (message.sessionId !== "") {
      obj.sessionId = message.sessionId;
    }
    if (message.supplierOperatorAddress !== "") {
      obj.supplierOperatorAddress = message.supplierOperatorAddress;
    }
    return obj;
  },

  create<I extends Exact<DeepPartial<QueryGetProofRequest>, I>>(base?: I): QueryGetProofRequest {
    return QueryGetProofRequest.fromPartial(base ?? ({} as any));
  },
  fromPartial<I extends Exact<DeepPartial<QueryGetProofRequest>, I>>(object: I): QueryGetProofRequest {
    const message = createBaseQueryGetProofRequest();
    message.sessionId = object.sessionId ?? "";
    message.supplierOperatorAddress = object.supplierOperatorAddress ?? "";
    return message;
  },
};

function createBaseQueryGetProofResponse(): QueryGetProofResponse {
  return { proof: undefined };
}

export const QueryGetProofResponse: MessageFns<QueryGetProofResponse> = {
  encode(message: QueryGetProofResponse, writer: BinaryWriter = new BinaryWriter()): BinaryWriter {
    if (message.proof !== undefined) {
      Proof.encode(message.proof, writer.uint32(10).fork()).join();
    }
    return writer;
  },

  decode(input: BinaryReader | Uint8Array, length?: number): QueryGetProofResponse {
    const reader = input instanceof BinaryReader ? input : new BinaryReader(input);
    let end = length === undefined ? reader.len : reader.pos + length;
    const message = createBaseQueryGetProofResponse();
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
      }
      if ((tag & 7) === 4 || tag === 0) {
        break;
      }
      reader.skip(tag & 7);
    }
    return message;
  },

  fromJSON(object: any): QueryGetProofResponse {
    return { proof: isSet(object.proof) ? Proof.fromJSON(object.proof) : undefined };
  },

  toJSON(message: QueryGetProofResponse): unknown {
    const obj: any = {};
    if (message.proof !== undefined) {
      obj.proof = Proof.toJSON(message.proof);
    }
    return obj;
  },

  create<I extends Exact<DeepPartial<QueryGetProofResponse>, I>>(base?: I): QueryGetProofResponse {
    return QueryGetProofResponse.fromPartial(base ?? ({} as any));
  },
  fromPartial<I extends Exact<DeepPartial<QueryGetProofResponse>, I>>(object: I): QueryGetProofResponse {
    const message = createBaseQueryGetProofResponse();
    message.proof = (object.proof !== undefined && object.proof !== null) ? Proof.fromPartial(object.proof) : undefined;
    return message;
  },
};

function createBaseQueryAllProofsRequest(): QueryAllProofsRequest {
  return {
    pagination: undefined,
    supplierOperatorAddress: undefined,
    sessionId: undefined,
    sessionEndHeight: undefined,
  };
}

export const QueryAllProofsRequest: MessageFns<QueryAllProofsRequest> = {
  encode(message: QueryAllProofsRequest, writer: BinaryWriter = new BinaryWriter()): BinaryWriter {
    if (message.pagination !== undefined) {
      PageRequest.encode(message.pagination, writer.uint32(10).fork()).join();
    }
    if (message.supplierOperatorAddress !== undefined) {
      writer.uint32(18).string(message.supplierOperatorAddress);
    }
    if (message.sessionId !== undefined) {
      writer.uint32(26).string(message.sessionId);
    }
    if (message.sessionEndHeight !== undefined) {
      writer.uint32(32).uint64(message.sessionEndHeight);
    }
    return writer;
  },

  decode(input: BinaryReader | Uint8Array, length?: number): QueryAllProofsRequest {
    const reader = input instanceof BinaryReader ? input : new BinaryReader(input);
    let end = length === undefined ? reader.len : reader.pos + length;
    const message = createBaseQueryAllProofsRequest();
    while (reader.pos < end) {
      const tag = reader.uint32();
      switch (tag >>> 3) {
        case 1: {
          if (tag !== 10) {
            break;
          }

          message.pagination = PageRequest.decode(reader, reader.uint32());
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

          message.sessionId = reader.string();
          continue;
        }
        case 4: {
          if (tag !== 32) {
            break;
          }

          message.sessionEndHeight = longToNumber(reader.uint64());
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

  fromJSON(object: any): QueryAllProofsRequest {
    return {
      pagination: isSet(object.pagination) ? PageRequest.fromJSON(object.pagination) : undefined,
      supplierOperatorAddress: isSet(object.supplierOperatorAddress)
        ? globalThis.String(object.supplierOperatorAddress)
        : undefined,
      sessionId: isSet(object.sessionId) ? globalThis.String(object.sessionId) : undefined,
      sessionEndHeight: isSet(object.sessionEndHeight) ? globalThis.Number(object.sessionEndHeight) : undefined,
    };
  },

  toJSON(message: QueryAllProofsRequest): unknown {
    const obj: any = {};
    if (message.pagination !== undefined) {
      obj.pagination = PageRequest.toJSON(message.pagination);
    }
    if (message.supplierOperatorAddress !== undefined) {
      obj.supplierOperatorAddress = message.supplierOperatorAddress;
    }
    if (message.sessionId !== undefined) {
      obj.sessionId = message.sessionId;
    }
    if (message.sessionEndHeight !== undefined) {
      obj.sessionEndHeight = Math.round(message.sessionEndHeight);
    }
    return obj;
  },

  create<I extends Exact<DeepPartial<QueryAllProofsRequest>, I>>(base?: I): QueryAllProofsRequest {
    return QueryAllProofsRequest.fromPartial(base ?? ({} as any));
  },
  fromPartial<I extends Exact<DeepPartial<QueryAllProofsRequest>, I>>(object: I): QueryAllProofsRequest {
    const message = createBaseQueryAllProofsRequest();
    message.pagination = (object.pagination !== undefined && object.pagination !== null)
      ? PageRequest.fromPartial(object.pagination)
      : undefined;
    message.supplierOperatorAddress = object.supplierOperatorAddress ?? undefined;
    message.sessionId = object.sessionId ?? undefined;
    message.sessionEndHeight = object.sessionEndHeight ?? undefined;
    return message;
  },
};

function createBaseQueryAllProofsResponse(): QueryAllProofsResponse {
  return { proofs: [], pagination: undefined };
}

export const QueryAllProofsResponse: MessageFns<QueryAllProofsResponse> = {
  encode(message: QueryAllProofsResponse, writer: BinaryWriter = new BinaryWriter()): BinaryWriter {
    for (const v of message.proofs) {
      Proof.encode(v!, writer.uint32(10).fork()).join();
    }
    if (message.pagination !== undefined) {
      PageResponse.encode(message.pagination, writer.uint32(18).fork()).join();
    }
    return writer;
  },

  decode(input: BinaryReader | Uint8Array, length?: number): QueryAllProofsResponse {
    const reader = input instanceof BinaryReader ? input : new BinaryReader(input);
    let end = length === undefined ? reader.len : reader.pos + length;
    const message = createBaseQueryAllProofsResponse();
    while (reader.pos < end) {
      const tag = reader.uint32();
      switch (tag >>> 3) {
        case 1: {
          if (tag !== 10) {
            break;
          }

          message.proofs.push(Proof.decode(reader, reader.uint32()));
          continue;
        }
        case 2: {
          if (tag !== 18) {
            break;
          }

          message.pagination = PageResponse.decode(reader, reader.uint32());
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

  fromJSON(object: any): QueryAllProofsResponse {
    return {
      proofs: globalThis.Array.isArray(object?.proofs) ? object.proofs.map((e: any) => Proof.fromJSON(e)) : [],
      pagination: isSet(object.pagination) ? PageResponse.fromJSON(object.pagination) : undefined,
    };
  },

  toJSON(message: QueryAllProofsResponse): unknown {
    const obj: any = {};
    if (message.proofs?.length) {
      obj.proofs = message.proofs.map((e) => Proof.toJSON(e));
    }
    if (message.pagination !== undefined) {
      obj.pagination = PageResponse.toJSON(message.pagination);
    }
    return obj;
  },

  create<I extends Exact<DeepPartial<QueryAllProofsResponse>, I>>(base?: I): QueryAllProofsResponse {
    return QueryAllProofsResponse.fromPartial(base ?? ({} as any));
  },
  fromPartial<I extends Exact<DeepPartial<QueryAllProofsResponse>, I>>(object: I): QueryAllProofsResponse {
    const message = createBaseQueryAllProofsResponse();
    message.proofs = object.proofs?.map((e) => Proof.fromPartial(e)) || [];
    message.pagination = (object.pagination !== undefined && object.pagination !== null)
      ? PageResponse.fromPartial(object.pagination)
      : undefined;
    return message;
  },
};

/** Query defines the gRPC querier service. */
export interface Query {
  /** Parameters queries the parameters of the module. */
  Params(request: QueryParamsRequest): Promise<QueryParamsResponse>;
  /** Queries a list of Claim items. */
  Claim(request: QueryGetClaimRequest): Promise<QueryGetClaimResponse>;
  AllClaims(request: QueryAllClaimsRequest): Promise<QueryAllClaimsResponse>;
  /** Queries a list of Proof items. */
  Proof(request: QueryGetProofRequest): Promise<QueryGetProofResponse>;
  AllProofs(request: QueryAllProofsRequest): Promise<QueryAllProofsResponse>;
}

export const QueryServiceName = "poktroll.proof.Query";
export class QueryClientImpl implements Query {
  private readonly rpc: Rpc;
  private readonly service: string;
  constructor(rpc: Rpc, opts?: { service?: string }) {
    this.service = opts?.service || QueryServiceName;
    this.rpc = rpc;
    this.Params = this.Params.bind(this);
    this.Claim = this.Claim.bind(this);
    this.AllClaims = this.AllClaims.bind(this);
    this.Proof = this.Proof.bind(this);
    this.AllProofs = this.AllProofs.bind(this);
  }
  Params(request: QueryParamsRequest): Promise<QueryParamsResponse> {
    const data = QueryParamsRequest.encode(request).finish();
    const promise = this.rpc.request(this.service, "Params", data);
    return promise.then((data) => QueryParamsResponse.decode(new BinaryReader(data)));
  }

  Claim(request: QueryGetClaimRequest): Promise<QueryGetClaimResponse> {
    const data = QueryGetClaimRequest.encode(request).finish();
    const promise = this.rpc.request(this.service, "Claim", data);
    return promise.then((data) => QueryGetClaimResponse.decode(new BinaryReader(data)));
  }

  AllClaims(request: QueryAllClaimsRequest): Promise<QueryAllClaimsResponse> {
    const data = QueryAllClaimsRequest.encode(request).finish();
    const promise = this.rpc.request(this.service, "AllClaims", data);
    return promise.then((data) => QueryAllClaimsResponse.decode(new BinaryReader(data)));
  }

  Proof(request: QueryGetProofRequest): Promise<QueryGetProofResponse> {
    const data = QueryGetProofRequest.encode(request).finish();
    const promise = this.rpc.request(this.service, "Proof", data);
    return promise.then((data) => QueryGetProofResponse.decode(new BinaryReader(data)));
  }

  AllProofs(request: QueryAllProofsRequest): Promise<QueryAllProofsResponse> {
    const data = QueryAllProofsRequest.encode(request).finish();
    const promise = this.rpc.request(this.service, "AllProofs", data);
    return promise.then((data) => QueryAllProofsResponse.decode(new BinaryReader(data)));
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
