import { Coin } from "@cosmjs/amino";
import { CosmosBlock } from "@subql/types-cosmos";
import { ModuleAccount } from "cosmjs-types/cosmos/auth/v1beta1/auth";
import { Balance } from "../../types";
import { ModuleAccountProps } from "../../types/models/ModuleAccount";
import { Any } from "../../types/proto-interfaces/google/protobuf/any";
import { CACHE_MODULE_ADDRESS } from "../constants";
import {
  getBalanceId,
  getBlockId,
} from "../utils/ids";
import { stringify } from "../utils/json";
import { enforceAccountExistence } from "./balanceChange";

export type ExtendedAccount = ModuleAccount & {
  balances: Array<Coin>
};

export function getModuleAccountProps(account: ModuleAccount): ModuleAccountProps {
  return {
    id: account.baseAccount?.address as string,
    name: account.name,
    accountNumber: account.baseAccount?.accountNumber as bigint,
    sequence: account.baseAccount?.sequence as bigint,
    permissions: account.permissions,
  };
}

export async function getCacheModuleAccounts(): Promise<Set<string>> {
  return new Set((await cache.get(CACHE_MODULE_ADDRESS)) ?? []);
}

export async function queryModuleAccounts(): Promise<Array<ExtendedAccount>> {
  // Here we force the use of a private property, breaking TypeScript limitation, due to the need of call a total supply
  // rpc query of @cosmjs that is not exposed on the implemented client by SubQuery team.
  // To avoid this, we need to move to implement our own rpc client and also use `unsafe` parameter which I prefer to avoid.

  // In this opportunity this moduleAccounts() function is only existent over a fork made by pokt-scan/cosmjs to include this.
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  const queryClient = api.forceGetQueryClient();

  const accounts = await queryClient.auth.moduleAccounts() as Array<Any>;

  const decodedAccounts = (accounts ?? []).map(
    (account) => ModuleAccount.decode(account.value),
  ).filter((account) => !!account.baseAccount) as Array<ModuleAccount>;

  const extendedAccounts = await Promise.all(
    decodedAccounts.map(
      (account: ModuleAccount) => queryClient.bank.allBalances(account.baseAccount?.address as string)
        .then(coins => ({
            ...account,
            balances: coins,
          } as ExtendedAccount),
        ),
    ),
  );

  logger.debug(`[queryModuleAccounts] extendedAccounts=${stringify(extendedAccounts, undefined, 2)}`);

  return extendedAccounts;
}

export async function handleModuleAccounts(block: CosmosBlock): Promise<void> {
  const moduleAccountsSet: Set<string> = new Set();
  const moduleAccounts = await queryModuleAccounts();

  for (const moduleAccount of moduleAccounts) {
    const moduleAccountProps = getModuleAccountProps(moduleAccount);
    const address = moduleAccountProps.id;
    moduleAccountsSet.add(address);

    // ensure account and module account exists
    await enforceAccountExistence(
      moduleAccount.baseAccount?.address as string,
      block.header.chainId,
      moduleAccountProps,
    );

    // check the balances
    for (const { amount, denom } of moduleAccount.balances) {
      const balanceId = getBalanceId(address, denom);
      let balance = await Balance.get(balanceId);

      if (!balance) {
        // if it does not exist but now exists, create it
        balance = Balance.create({
          id: balanceId,
          accountId: address,
          denom,
          amount: BigInt(amount),
          lastUpdatedBlockId: getBlockId(block),
        });
      } else {
        // if already exists, set the new amount
        balance.amount = BigInt(amount);
        balance.lastUpdatedBlockId = getBlockId(block);
      }

      await balance.save();
    }
  }

  await cache.set(CACHE_MODULE_ADDRESS, Array.from(moduleAccountsSet));
}
