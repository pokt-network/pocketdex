// Code generated by protoc-gen-ts_proto. DO NOT EDIT.
// versions:
//   protoc-gen-ts_proto  v2.6.1
//   protoc               unknown
// source: pocket/supplier/query.proto

/* eslint-disable */
import { BinaryReader, BinaryWriter } from "@bufbuild/protobuf/wire";
import { PageRequest, PageResponse } from "../../cosmos/base/query/v1beta1/pagination";
import { Supplier } from "../shared/supplier";
import { Params } from "./params";

export const protobufPackage = "pocket.supplier";

/** QueryParamsRequest is request type for the Query/Params RPC method. */
export interface QueryParamsRequest {
}

/** QueryParamsResponse is response type for the Query/Params RPC method. */
export interface QueryParamsResponse {
  /** params holds all the parameters of this module. */
  params: Params | undefined;
}

export interface QueryGetSupplierRequest {
  /** TODO_TECHDEBT: Add the ability to query for a supplier by owner_id */
  operatorAddress: string;
}

export interface QueryGetSupplierResponse {
  supplier: Supplier | undefined;
}

export interface QueryAllSuppliersRequest {
  pagination:
    | PageRequest
    | undefined;
  /** unique service identifier to filter by */
  serviceId?: string | undefined;
}

export interface QueryAllSuppliersResponse {
  supplier: Supplier[];
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

function createBaseQueryGetSupplierRequest(): QueryGetSupplierRequest {
  return { operatorAddress: "" };
}

export const QueryGetSupplierRequest: MessageFns<QueryGetSupplierRequest> = {
  encode(message: QueryGetSupplierRequest, writer: BinaryWriter = new BinaryWriter()): BinaryWriter {
    if (message.operatorAddress !== "") {
      writer.uint32(10).string(message.operatorAddress);
    }
    return writer;
  },

  decode(input: BinaryReader | Uint8Array, length?: number): QueryGetSupplierRequest {
    const reader = input instanceof BinaryReader ? input : new BinaryReader(input);
    let end = length === undefined ? reader.len : reader.pos + length;
    const message = createBaseQueryGetSupplierRequest();
    while (reader.pos < end) {
      const tag = reader.uint32();
      switch (tag >>> 3) {
        case 1: {
          if (tag !== 10) {
            break;
          }

          message.operatorAddress = reader.string();
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

  fromJSON(object: any): QueryGetSupplierRequest {
    return { operatorAddress: isSet(object.operatorAddress) ? globalThis.String(object.operatorAddress) : "" };
  },

  toJSON(message: QueryGetSupplierRequest): unknown {
    const obj: any = {};
    if (message.operatorAddress !== "") {
      obj.operatorAddress = message.operatorAddress;
    }
    return obj;
  },

  create<I extends Exact<DeepPartial<QueryGetSupplierRequest>, I>>(base?: I): QueryGetSupplierRequest {
    return QueryGetSupplierRequest.fromPartial(base ?? ({} as any));
  },
  fromPartial<I extends Exact<DeepPartial<QueryGetSupplierRequest>, I>>(object: I): QueryGetSupplierRequest {
    const message = createBaseQueryGetSupplierRequest();
    message.operatorAddress = object.operatorAddress ?? "";
    return message;
  },
};

function createBaseQueryGetSupplierResponse(): QueryGetSupplierResponse {
  return { supplier: undefined };
}

export const QueryGetSupplierResponse: MessageFns<QueryGetSupplierResponse> = {
  encode(message: QueryGetSupplierResponse, writer: BinaryWriter = new BinaryWriter()): BinaryWriter {
    if (message.supplier !== undefined) {
      Supplier.encode(message.supplier, writer.uint32(10).fork()).join();
    }
    return writer;
  },

  decode(input: BinaryReader | Uint8Array, length?: number): QueryGetSupplierResponse {
    const reader = input instanceof BinaryReader ? input : new BinaryReader(input);
    let end = length === undefined ? reader.len : reader.pos + length;
    const message = createBaseQueryGetSupplierResponse();
    while (reader.pos < end) {
      const tag = reader.uint32();
      switch (tag >>> 3) {
        case 1: {
          if (tag !== 10) {
            break;
          }

          message.supplier = Supplier.decode(reader, reader.uint32());
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

  fromJSON(object: any): QueryGetSupplierResponse {
    return { supplier: isSet(object.supplier) ? Supplier.fromJSON(object.supplier) : undefined };
  },

  toJSON(message: QueryGetSupplierResponse): unknown {
    const obj: any = {};
    if (message.supplier !== undefined) {
      obj.supplier = Supplier.toJSON(message.supplier);
    }
    return obj;
  },

  create<I extends Exact<DeepPartial<QueryGetSupplierResponse>, I>>(base?: I): QueryGetSupplierResponse {
    return QueryGetSupplierResponse.fromPartial(base ?? ({} as any));
  },
  fromPartial<I extends Exact<DeepPartial<QueryGetSupplierResponse>, I>>(object: I): QueryGetSupplierResponse {
    const message = createBaseQueryGetSupplierResponse();
    message.supplier = (object.supplier !== undefined && object.supplier !== null)
      ? Supplier.fromPartial(object.supplier)
      : undefined;
    return message;
  },
};

function createBaseQueryAllSuppliersRequest(): QueryAllSuppliersRequest {
  return { pagination: undefined, serviceId: undefined };
}

export const QueryAllSuppliersRequest: MessageFns<QueryAllSuppliersRequest> = {
  encode(message: QueryAllSuppliersRequest, writer: BinaryWriter = new BinaryWriter()): BinaryWriter {
    if (message.pagination !== undefined) {
      PageRequest.encode(message.pagination, writer.uint32(10).fork()).join();
    }
    if (message.serviceId !== undefined) {
      writer.uint32(18).string(message.serviceId);
    }
    return writer;
  },

  decode(input: BinaryReader | Uint8Array, length?: number): QueryAllSuppliersRequest {
    const reader = input instanceof BinaryReader ? input : new BinaryReader(input);
    let end = length === undefined ? reader.len : reader.pos + length;
    const message = createBaseQueryAllSuppliersRequest();
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

          message.serviceId = reader.string();
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

  fromJSON(object: any): QueryAllSuppliersRequest {
    return {
      pagination: isSet(object.pagination) ? PageRequest.fromJSON(object.pagination) : undefined,
      serviceId: isSet(object.serviceId) ? globalThis.String(object.serviceId) : undefined,
    };
  },

  toJSON(message: QueryAllSuppliersRequest): unknown {
    const obj: any = {};
    if (message.pagination !== undefined) {
      obj.pagination = PageRequest.toJSON(message.pagination);
    }
    if (message.serviceId !== undefined) {
      obj.serviceId = message.serviceId;
    }
    return obj;
  },

  create<I extends Exact<DeepPartial<QueryAllSuppliersRequest>, I>>(base?: I): QueryAllSuppliersRequest {
    return QueryAllSuppliersRequest.fromPartial(base ?? ({} as any));
  },
  fromPartial<I extends Exact<DeepPartial<QueryAllSuppliersRequest>, I>>(object: I): QueryAllSuppliersRequest {
    const message = createBaseQueryAllSuppliersRequest();
    message.pagination = (object.pagination !== undefined && object.pagination !== null)
      ? PageRequest.fromPartial(object.pagination)
      : undefined;
    message.serviceId = object.serviceId ?? undefined;
    return message;
  },
};

function createBaseQueryAllSuppliersResponse(): QueryAllSuppliersResponse {
  return { supplier: [], pagination: undefined };
}

export const QueryAllSuppliersResponse: MessageFns<QueryAllSuppliersResponse> = {
  encode(message: QueryAllSuppliersResponse, writer: BinaryWriter = new BinaryWriter()): BinaryWriter {
    for (const v of message.supplier) {
      Supplier.encode(v!, writer.uint32(10).fork()).join();
    }
    if (message.pagination !== undefined) {
      PageResponse.encode(message.pagination, writer.uint32(18).fork()).join();
    }
    return writer;
  },

  decode(input: BinaryReader | Uint8Array, length?: number): QueryAllSuppliersResponse {
    const reader = input instanceof BinaryReader ? input : new BinaryReader(input);
    let end = length === undefined ? reader.len : reader.pos + length;
    const message = createBaseQueryAllSuppliersResponse();
    while (reader.pos < end) {
      const tag = reader.uint32();
      switch (tag >>> 3) {
        case 1: {
          if (tag !== 10) {
            break;
          }

          message.supplier.push(Supplier.decode(reader, reader.uint32()));
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

  fromJSON(object: any): QueryAllSuppliersResponse {
    return {
      supplier: globalThis.Array.isArray(object?.supplier) ? object.supplier.map((e: any) => Supplier.fromJSON(e)) : [],
      pagination: isSet(object.pagination) ? PageResponse.fromJSON(object.pagination) : undefined,
    };
  },

  toJSON(message: QueryAllSuppliersResponse): unknown {
    const obj: any = {};
    if (message.supplier?.length) {
      obj.supplier = message.supplier.map((e) => Supplier.toJSON(e));
    }
    if (message.pagination !== undefined) {
      obj.pagination = PageResponse.toJSON(message.pagination);
    }
    return obj;
  },

  create<I extends Exact<DeepPartial<QueryAllSuppliersResponse>, I>>(base?: I): QueryAllSuppliersResponse {
    return QueryAllSuppliersResponse.fromPartial(base ?? ({} as any));
  },
  fromPartial<I extends Exact<DeepPartial<QueryAllSuppliersResponse>, I>>(object: I): QueryAllSuppliersResponse {
    const message = createBaseQueryAllSuppliersResponse();
    message.supplier = object.supplier?.map((e) => Supplier.fromPartial(e)) || [];
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
  /** Queries a list of Supplier items. */
  Supplier(request: QueryGetSupplierRequest): Promise<QueryGetSupplierResponse>;
  AllSuppliers(request: QueryAllSuppliersRequest): Promise<QueryAllSuppliersResponse>;
}

export const QueryServiceName = "pocket.supplier.Query";
export class QueryClientImpl implements Query {
  private readonly rpc: Rpc;
  private readonly service: string;
  constructor(rpc: Rpc, opts?: { service?: string }) {
    this.service = opts?.service || QueryServiceName;
    this.rpc = rpc;
    this.Params = this.Params.bind(this);
    this.Supplier = this.Supplier.bind(this);
    this.AllSuppliers = this.AllSuppliers.bind(this);
  }
  Params(request: QueryParamsRequest): Promise<QueryParamsResponse> {
    const data = QueryParamsRequest.encode(request).finish();
    const promise = this.rpc.request(this.service, "Params", data);
    return promise.then((data) => QueryParamsResponse.decode(new BinaryReader(data)));
  }

  Supplier(request: QueryGetSupplierRequest): Promise<QueryGetSupplierResponse> {
    const data = QueryGetSupplierRequest.encode(request).finish();
    const promise = this.rpc.request(this.service, "Supplier", data);
    return promise.then((data) => QueryGetSupplierResponse.decode(new BinaryReader(data)));
  }

  AllSuppliers(request: QueryAllSuppliersRequest): Promise<QueryAllSuppliersResponse> {
    const data = QueryAllSuppliersRequest.encode(request).finish();
    const promise = this.rpc.request(this.service, "AllSuppliers", data);
    return promise.then((data) => QueryAllSuppliersResponse.decode(new BinaryReader(data)));
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
