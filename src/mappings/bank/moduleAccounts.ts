import { stringify } from "../utils/json";

export async function queryModuleAccounts(): Promise<Array<unknown>> {
  // Here we force the use of a private property, breaking TypeScript limitation, due to the need of call a total supply
  // rpc query of cosmosjs that is not exposed on the implemented client by SubQuery team.
  // To avoid this, we need to move to implement our own rpc client and also use `unsafe` parameter which I prefer to avoid.
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  const queryClient = api.forceGetQueryClient();
  const accounts = await queryClient.auth.moduleAccounts();
  logger.info(`[queryModuleAccounts] ${stringify(accounts, undefined, 2)}`);
  return accounts;
}
