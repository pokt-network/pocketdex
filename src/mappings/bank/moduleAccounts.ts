import { Coin } from "@cosmjs/amino";
import { CosmosBlock } from "@subql/types-cosmos";
import { ModuleAccount } from "cosmjs-types/cosmos/auth/v1beta1/auth";
import { Balance } from "../../types";
import { ModuleAccountProps } from "../../types/models/ModuleAccount";
import { Any } from "../../types/proto-interfaces/google/protobuf/any";
import {
  getBalanceId,
  getBlockId,
} from "../utils/ids";
import { stringify } from "../utils/json";
import getQueryClient from "../utils/query_client";
import { enforceAccountsExists } from "./balanceChange";

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

export async function queryModuleAccounts(block: CosmosBlock): Promise<Array<ExtendedAccount>> {
  // Here we force the use of a private property, breaking TypeScript limitation, due to the need of call a total supply
  // rpc query of @cosmjs that is not exposed on the implemented client by SubQuery team.
  // To avoid this, we need to move to implement our own rpc client and also use `unsafe` parameter which I prefer to avoid.

  // In this opportunity this moduleAccounts() function is only existent over a fork made by pokt-scan/cosmjs to include this.
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  const queryClient = getQueryClient(block.header.height);

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

export async function handleModuleAccounts(block: CosmosBlock): Promise<Set<string>> {
  const blockId = getBlockId(block);
  const moduleAccountsSet: Set<string> = new Set();
  const moduleAccounts = await queryModuleAccounts(block);
  const accounts = [];

  for (const moduleAccount of moduleAccounts) {
    const moduleAccountProps = getModuleAccountProps(moduleAccount);
    const address = moduleAccountProps.id;
    accounts.push({
      account: {
        id: address,
        chainId: block.block.header.chainId,
        firstBlockId: blockId,
      },
      module: moduleAccountProps,
    });

    moduleAccountsSet.add(address);

    // check the balances
    for (const { amount, denom } of moduleAccount.balances) {
      const balanceId = getBalanceId(address, denom);
      const prevBalance = await Balance.get(balanceId);

      if (!prevBalance) {
        // if it does not exist but now exists, create it
        await Balance.create({
          id: balanceId,
          accountId: address,
          denom,
          amount: BigInt(amount),
          lastUpdatedBlockId: blockId,
        }).save();
      } else if (prevBalance.amount.toString() !== amount) {
        // if already exists, set the new amount
        prevBalance.amount = BigInt(amount);
        prevBalance.lastUpdatedBlockId = blockId;

        await prevBalance.save();
      }
    }
  }

  // enforce accounts existence in bulk
  await enforceAccountsExists(accounts);

  return moduleAccountsSet;
}
