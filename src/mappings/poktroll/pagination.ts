import {
  Application,
  ApplicationGateway,
  ApplicationService,
  EventClaimSettled,
  Gateway,
  StakeStatus,
  Supplier,
  SupplierServiceConfig,
  Transaction,
} from "../../types";
import { fetchPaginatedRecords } from "../utils/db";

// primitive

export async function fetchAllTransactions(blockId: bigint): Promise<Transaction[]> {
  return fetchPaginatedRecords({
    fetchFn: (options) => Transaction.getByBlockId(blockId, options),
    initialOptions: {
      // add order and direction to speedup if there is a way
      // orderBy: 'id', // Order results by ID
      // orderDirection: 'ASC', // Ascending order
    },
  });
}

// application

export async function fetchAllApplicationByStatus(status: StakeStatus): Promise<Application[]> {
  return fetchPaginatedRecords({
    fetchFn: (options) => Application.getByStakeStatus(status, options),
    initialOptions: {
      // add order and direction to speedup if there is a way
      // orderBy: 'id', // Order results by ID
      // orderDirection: 'ASC', // Ascending order
    },
  });
}

export async function fetchAllApplicationByUnstakingEndBlockId(blockId: bigint): Promise<Application[]> {
  return fetchPaginatedRecords({
    fetchFn: (options) => Application.getByUnstakingEndBlockId(blockId, options),
    initialOptions: {
      // add order and direction to speedup if there is a way
      // orderBy: 'id', // Order results by ID
      // orderDirection: 'ASC', // Ascending order
    },
  });
}

export async function fetchAllApplicationServiceByApplicationId(applicationId: string): Promise<ApplicationService[]> {
  return fetchPaginatedRecords({
    fetchFn: (options) => ApplicationService.getByApplicationId(applicationId, options),
    initialOptions: {
      // add order and direction to speedup if there is a way
      // orderBy: 'id', // Order results by ID
      // orderDirection: 'ASC', // Ascending order
    },
  });
}

export async function fetchAllApplicationGatewayByApplicationId(applicationId: string): Promise<ApplicationGateway[]> {
  return fetchPaginatedRecords({
    fetchFn: (options) => ApplicationGateway.getByApplicationId(applicationId, options),
    initialOptions: {
      // add order and direction to speedup if there is a way
      // orderBy: 'id', // Order results by ID
      // orderDirection: 'ASC', // Ascending order
    },
  });
}

// supplier

export async function fetchAllSupplierByStatus(status: StakeStatus): Promise<Supplier[]> {
  return fetchPaginatedRecords({
    fetchFn: (options) => Supplier.getByStakeStatus(status, options),
    initialOptions: {
      // add order and direction to speedup if there is a way
      // orderBy: 'id', // Order results by ID
      // orderDirection: 'ASC', // Ascending order
    },
  });
}

export async function fetchAllSupplierServiceConfigBySupplier(supplier: string): Promise<SupplierServiceConfig[]> {
  return fetchPaginatedRecords({
    fetchFn: (options) => SupplierServiceConfig.getBySupplierId(supplier, options),
    initialOptions: {
      // add order and direction to speedup if there is a way
      // orderBy: 'id', // Order results by ID
      // orderDirection: 'ASC', // Ascending order
    },
  });
}

export async function fetchAllSupplierByUnstakingEndBlockId(blockId: bigint): Promise<Supplier[]> {
  return fetchPaginatedRecords({
    fetchFn: (options) => Supplier.getByUnstakingEndBlockId(blockId, options),
    initialOptions: {
      // add order and direction to speedup if there is a way
      // orderBy: 'id', // Order results by ID
      // orderDirection: 'ASC', // Ascending order
    },
  });
}

// gateway

export async function fetchAllGatewayByStatus(status: StakeStatus): Promise<Gateway[]> {
  return fetchPaginatedRecords({
    fetchFn: (options) => Gateway.getByStakeStatus(status, options),
    initialOptions: {
      // add order and direction to speedup if there is a way
      // orderBy: 'id', // Order results by ID
      // orderDirection: 'ASC', // Ascending order
    },
  });
}

export async function fetchAllGatewayByUnstakingEndBlockId(blockId: bigint): Promise<Gateway[]> {
  return fetchPaginatedRecords({
    fetchFn: (options) => Gateway.getByUnstakingEndBlockId(blockId, options),
    initialOptions: {
      // add order and direction to speedup if there is a way
      // orderBy: 'id', // Order results by ID
      // orderDirection: 'ASC', // Ascending order
    },
  });
}

// relays

export async function fetchAllEventClaimSettled(blockId: bigint): Promise<EventClaimSettled[]> {
  return fetchPaginatedRecords({
    fetchFn: (options) => EventClaimSettled.getByBlockId(blockId, options),
    initialOptions: {
      // add order and direction to speedup if there is a way
      // orderBy: 'id', // Order results by ID
      // orderDirection: 'ASC', // Ascending order
    },
  });
}
