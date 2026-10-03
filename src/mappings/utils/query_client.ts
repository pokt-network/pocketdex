import { createPagination, ProtobufRpcClient, QueryClient } from "@cosmjs/stargate";
import {QueryClientImpl as AuthQueryClientImpl} from 'cosmjs-types/cosmos/auth/v1beta1/query'
import {
  QueryAllBalancesRequest,
  QueryClientImpl as BankQueryClientImpl,
  QueryTotalSupplyResponse,
} from "cosmjs-types/cosmos/bank/v1beta1/query";
import { Coin } from "cosmjs-types/cosmos/base/v1beta1/coin";
import { Any } from "cosmjs-types/google/protobuf/any";
import pLimit from "p-limit";
import { PageRequest } from "../../client/cosmos/base/query/v1beta1/pagination";
import {
  QueryAllApplicationsRequest,
  QueryClientImpl as ApplicationQueryClientImpl,
} from "../../client/pocket/application/query";
import { Application as ChainApplication } from "../../client/pocket/application/types";
import {
  QueryClientImpl as StakingQueryClientImpl,
  QueryValidatorDelegationsRequest,
  QueryValidatorsRequest,
} from "../../client/cosmos/staking/v1beta1/query";
import {
  Delegation as ChainDelegation,
  Validator as ChainValidator,
} from "../../client/cosmos/staking/v1beta1/staking";
import { positiveIntFromEnv } from "./env";

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
    // Returns every delegation to one validator at the configured height, following pagination.
    readonly validatorDelegations: (validatorOperator: string) => Promise<ChainDelegation[]>;
  }
  readonly application: {
    // Returns every application known to the chain at the configured height,
    // following pagination across as many pages as needed.
    readonly allApplications: () => Promise<ChainApplication[]>;
  }
  readonly params: {
    // Raw ABCI response of a module's Query/Params at the given height, with the
    // height the node answered for; decoding and normalization live in
    // utils/params_normalize.ts so the offline scripts share them.
    readonly raw: (path: string, height: number, data?: Uint8Array) => Promise<{ value: Uint8Array; height: number }>;
  }
}

// Every ABCI query the mappings make goes through queryAbci below, so the params
// (17 per block), validator, application and supply reads share one limit on
// requests in flight and one retry policy. The limit is 6 by the owner's choice,
// to bound the load each block puts on the node ("maximo 6 por tanda"): the 17
// params reads go out in 3 waves.
const ABCI_MAX_IN_FLIGHT = 6;
const ABCI_ATTEMPTS = 3;
const ABCI_RETRY_BASE_MS = 250;
// Per-attempt timeout. It is a guard against a node that accepts a request and
// never answers (without it, 6 such requests would hold every slot and hang the
// indexer silently), not a latency limit: on mainnet settlement blocks a loaded
// node has taken 12–14 s for the stake/balance/validator reads of one block
// (indexer logs), against 0.5–1.8 s on an idle seed. So the default is generous,
// 120 s; with 3 attempts a dead node fails the block after about 6 minutes.
// Override with POCKETDEX_ABCI_TIMEOUT_MS. It covers only the mappings' own ABCI
// queries made here; SubQuery's block and block_results fetching does not go
// through this module.
export const ABCI_TIMEOUT_MS = abciTimeoutFromEnv(process.env.POCKETDEX_ABCI_TIMEOUT_MS);

export function abciTimeoutFromEnv(value: string | undefined): number {
  return positiveIntFromEnv("POCKETDEX_ABCI_TIMEOUT_MS", value, 120_000);
}
const abciLimit = pLimit(ABCI_MAX_IN_FLIGHT);

type AbciTransport = Pick<QueryClient, "queryAbci">;

// cosmjs QueryClient.queryAbci throws this for a response with a non-zero code
// (unknown path, bad request): the node answered, and it will answer the same
// again, so it is not retried.
const ABCI_ERROR_CODE = /^Query failed with \(\d+\)/;
// Except a height the node has not committed yet: behind a load balancer the
// block can come from one backend and the query land on another a block or two
// behind. That clears in seconds, so it is retried on a fixed delay for up to
// ABCI_HEIGHT_LAG_ATTEMPTS * ABCI_HEIGHT_LAG_DELAY_MS (15 s, the old
// retryOnFail budget) before the block fails.
const ABCI_HEIGHT_LAG = /invalid height|height in the future|version does not exist/i;
export const ABCI_HEIGHT_LAG_ATTEMPTS = 30;
export const ABCI_HEIGHT_LAG_DELAY_MS = 500;

async function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// queryAbci runs one ABCI query under the shared concurrency limit, each attempt
// bounded by a timeout so a node that never answers cannot hold a slot. A
// transport failure is retried up to ABCI_ATTEMPTS times in all, with jittered
// exponential backoff slept outside the limit; a height the node has not reached
// yet is retried on a fixed delay; any other error code from the node is not.
// Then it throws: the caller's block fails and SubQuery retries it.
export async function queryAbci(
  base: AbciTransport,
  path: string,
  data: Uint8Array,
  height?: number,
  timeoutMs = ABCI_TIMEOUT_MS,
): Promise<{ value: Uint8Array; height: number }> {
  const what = `abci query ${path} at height ${height}`;
  let lagAttempt = 0;
  for (let attempt = 1; ; attempt++) {
    try {
      return await abciLimit(() => withTimeout(base.queryAbci(path, data, height), timeoutMs, what));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (ABCI_ERROR_CODE.test(message)) {
        if (!ABCI_HEIGHT_LAG.test(message) || ++lagAttempt >= ABCI_HEIGHT_LAG_ATTEMPTS) {
          throw Object.assign(new Error(`${what} failed (node error): ${message}`), { cause: error });
        }
        attempt--; // a lagging node is not a transport failure
        await new Promise((resolve) => setTimeout(resolve, ABCI_HEIGHT_LAG_DELAY_MS));
        continue;
      }
      if (attempt >= ABCI_ATTEMPTS) {
        throw Object.assign(new Error(`${what} failed (attempt ${attempt} of ${ABCI_ATTEMPTS}): ${message}`), { cause: error });
      }
      const backoff = ABCI_RETRY_BASE_MS * 2 ** (attempt - 1);
      await new Promise((resolve) => setTimeout(resolve, backoff / 2 + Math.random() * backoff));
    }
  }
}

export function createProtobufRpcClient(base: QueryClient, height?: number): ProtobufRpcClient {
  return {
    request: async (service: string, method: string, data: Uint8Array): Promise<Uint8Array> => {
      const path = `/${service}/${method}`;
      const response = await queryAbci(base, path, data, height);
      // A node that answers for another height than the one asked would make the block read state that
      // is not its own.
      if (height !== undefined && response.height !== height) {
        throw new Error(`abci query ${path}: asked for height ${height}, the node answered for ${response.height}`);
      }
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
        let nextKey: Uint8Array | undefined;

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
      validatorDelegations: async (validatorOperator: string) => {
        const delegations: ChainDelegation[] = [];
        let nextKey: Uint8Array | undefined;

        do {
          const response = await stakingQueryService.ValidatorDelegations(
            QueryValidatorDelegationsRequest.fromPartial({
              validatorAddr: validatorOperator,
              pagination: PageRequest.fromPartial({
                key: nextKey ?? new Uint8Array(),
                limit: DEFAULT_PAGE_LIMIT,
              }),
            }),
          );

          for (const r of response.delegationResponses) {
            if (!r.delegation) {
              throw new Error(`delegation response for validator ${validatorOperator} has no delegation`);
            }
            delegations.push(r.delegation);
          }
          nextKey = response.pagination?.nextKey;
        } while (nextKey && nextKey.length > 0);

        return delegations;
      },
    },
    application: {
      allApplications: async () => {
        const applications: ChainApplication[] = [];
        let nextKey: Uint8Array | undefined;

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
    },
    params: {
      raw: (path: string, queryHeight: number, data?: Uint8Array) =>
        queryAbci(base, path, data ?? new Uint8Array(), queryHeight),
    },
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
