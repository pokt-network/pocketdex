import { createPagination, ProtobufRpcClient, QueryClient } from "@cosmjs/stargate";
import {QueryClientImpl as AuthQueryClientImpl} from 'cosmjs-types/cosmos/auth/v1beta1/query'
import {
  QueryAllBalancesRequest,
  QueryClientImpl as BankQueryClientImpl,
  QueryTotalSupplyResponse,
} from "cosmjs-types/cosmos/bank/v1beta1/query";
import { Coin } from "cosmjs-types/cosmos/base/v1beta1/coin";
import { Any } from "cosmjs-types/google/protobuf/any";
import { PageRequest } from "../../client/cosmos/base/query/v1beta1/pagination";
import {
  QueryAllApplicationsRequest,
  QueryClientImpl as ApplicationQueryClientImpl,
} from "../../client/pocket/application/query";
import { Application as ChainApplication } from "../../client/pocket/application/types";
import {
  QueryClientImpl as StakingQueryClientImpl,
  QueryValidatorsRequest,
} from "../../client/cosmos/staking/v1beta1/query";
import { Validator as ChainValidator } from "../../client/cosmos/staking/v1beta1/staking";

// High default page size: with the current validator/app counts a single page is
// enough, but the loop below keeps requesting pages while a next_key is returned
// so we stay covered if the set ever grows past one page.
const DEFAULT_PAGE_LIMIT = 1000;

interface PocketdexExtension {
  readonly bank: {
    readonly totalSupply: (paginationKey?: Uint8Array) => Promise<QueryTotalSupplyResponse>;
    readonly allBalances: (address: string) => Promise<Coin[]>;
  }
  readonly auth: {
    readonly moduleAccounts: () => Promise<Any[]>;
  }
  readonly staking: {
    // Returns every validator known to the chain (any bond status) at the
    // configured height, following pagination across as many pages as needed.
    readonly allValidators: () => Promise<ChainValidator[]>;
  }
  readonly application: {
    // Returns every application known to the chain at the configured height,
    // following pagination across as many pages as needed.
    readonly allApplications: () => Promise<ChainApplication[]>;
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
  const stakingQueryService = new StakingQueryClientImpl(rpc);
  const applicationQueryService = new ApplicationQueryClientImpl(rpc);

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
    },
    staking: {
      allValidators: async () => {
        const validators: ChainValidator[] = [];
        let nextKey: Uint8Array | undefined = undefined;

        do {
          const response = await stakingQueryService.Validators(
            QueryValidatorsRequest.fromPartial({
              // empty status => all bond statuses (bonded, unbonding, unbonded)
              status: "",
              pagination: PageRequest.fromPartial({
                key: nextKey ?? new Uint8Array(),
                limit: DEFAULT_PAGE_LIMIT,
              }),
            }),
          );

          validators.push(...response.validators);
          nextKey = response.pagination?.nextKey;
        } while (nextKey && nextKey.length > 0);

        return validators;
      },
    },
    application: {
      allApplications: async () => {
        const applications: ChainApplication[] = [];
        let nextKey: Uint8Array | undefined = undefined;

        do {
          const response = await applicationQueryService.AllApplications(
            QueryAllApplicationsRequest.fromPartial({
              pagination: PageRequest.fromPartial({
                key: nextKey ?? new Uint8Array(),
                limit: DEFAULT_PAGE_LIMIT,
              }),
            }),
          );

          applications.push(...response.applications);
          nextKey = response.pagination?.nextKey;
        } while (nextKey && nextKey.length > 0);

        return applications;
      },
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
