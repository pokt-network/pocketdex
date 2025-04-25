import { createPagination, ProtobufRpcClient, QueryClient } from "@cosmjs/stargate";
import {QueryClientImpl as AuthQueryClientImpl} from 'cosmjs-types/cosmos/auth/v1beta1/query'
import {
  QueryAllBalancesRequest,
  QueryClientImpl as BankQueryClientImpl,
  QueryTotalSupplyResponse,
} from "cosmjs-types/cosmos/bank/v1beta1/query";
import { Coin } from "cosmjs-types/cosmos/base/v1beta1/coin";
import { Any } from "cosmjs-types/google/protobuf/any";

interface PocketdexExtension {
  readonly bank: {
    readonly totalSupply: (paginationKey?: Uint8Array) => Promise<QueryTotalSupplyResponse>;
    readonly allBalances: (address: string) => Promise<Coin[]>;
  }
  readonly auth: {
    readonly moduleAccounts: () => Promise<Any[]>;
  }
}

export function createProtobufRpcClient(base: QueryClient, height?: number): ProtobufRpcClient {
  return {
    request: async (service: string, method: string, data: Uint8Array): Promise<Uint8Array> => {
      const path = `/${service}/${method}`;
      const response = await base.queryAbci(path, data, height);
      return response.value;
    },
  };
}

const setupPocketdexExtension = (height?: number) => (base: QueryClient): PocketdexExtension => {
  const rpc = createProtobufRpcClient(base, height);

  // Use this service to get easy typed access to query methods
  // This cannot be used for proof verification
  const bankQueryService = new BankQueryClientImpl(rpc);
  const authQueryService = new AuthQueryClientImpl(rpc);

  return {
    bank: {
      totalSupply: async (paginationKey?: Uint8Array) => {
        return bankQueryService.TotalSupply({
          pagination: createPagination(paginationKey),
        });
      },
      allBalances: async (address: string) => {
        const { balances } = await bankQueryService.AllBalances(
          QueryAllBalancesRequest.fromPartial({ address: address }),
        );
        return balances;
      },
    },
    auth: {
      moduleAccounts: async () => {
        const { accounts } = await authQueryService.ModuleAccounts();
        return accounts ?? [];
      }
    }
  };
}

// The purpose of creating a new query client instead of using the one injected by subql
// is because with the injected one, we cannot pass a custom height so it always queries the latest height.
// With this new query client, we can pass a custom height, and it will query the data for the block that is being indexed.
export default function getQueryClient(height: number): QueryClient & PocketdexExtension {
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  const cometClient = api.forceGetCometClient();

  return QueryClient.withExtensions(
    cometClient,
    setupPocketdexExtension(height),
  )
}
