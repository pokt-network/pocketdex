import { CosmosBlock } from "@subql/types-cosmos";
import {
  Application,
  ApplicationService,
  Block,
  EventClaimSettled,
  Gateway,
  StakeStatus,
  Supplier,
  SupplierServiceConfig,
  Transaction,
} from "../../types";

export async function handleAddBlockReports(block: CosmosBlock): Promise<void> {
  logger.info(`[handleAddBlockReports] Generating block #${block.header.height} reports...`);
  const startTime = (await cache.get("startTime")) ?? Date.now();
  // TODO: replace many of them using local cache counter to reduce the amount of queries and speedup the overall process
  // const [
  //   {computedUnits, relays, relaysByService},
  //   {invalidTxs, validTxs},
  //   {stakedSuppliers, stakedSuppliersByService, stakedTokensBySupplier},
  //   {unstakingSuppliers, unstakingTokensBySupplier},
  //   took,
  //   {unstakedSuppliers, unstakedTokensBySupplier},
  //   {stakedApps, stakedAppsByService, stakedTokensByApp},
  //   {unstakingApps, unstakingTokensByApp},
  //   {unstakedApps, unstakedTokensByApp},
  //   {stakedGateways, stakedTokensByGateway},
  //   {unstakedGateways, unstakedTokensByGateway},
  //   blockFromDB
  // ] = await Promise.all([
  //   getRelaysData(block),
  //   getTransactionsData(block),
  //   getStakedSuppliersData(),
  //   getUnstakingSuppliersData(),
  //   getTook(block),
  //   getUnstakedSuppliersData(block.block.id),
  //   getStakedAppsData(),
  //   getUnstakingAppsData(),
  //   getUnstakedAppssData(block.block.id),
  //   getStakedGatewaysData(),
  //   getUnstakedGatewaysData(block.block.id),
  //   Block.get(block.block.id)!
  // ] as const)
  //
  // const blockEntity = blockFromDB as Block
  //
  // blockEntity.totalComputedUnits = computedUnits
  // blockEntity.totalRelays = relays
  // blockEntity.failedTxs = invalidTxs
  // blockEntity.successfulTxs = validTxs
  // blockEntity.timeToBlock = took
  // blockEntity.totalTxs = validTxs + invalidTxs
  // blockEntity.stakedSuppliers = stakedSuppliers
  // blockEntity.stakedSuppliersTokens = stakedTokensBySupplier
  // blockEntity.unstakingSuppliers = unstakingSuppliers
  // blockEntity.unstakingSuppliersTokens = unstakingTokensBySupplier
  // blockEntity.unstakedSuppliers = unstakedSuppliers
  // blockEntity.unstakedSuppliersTokens = unstakedTokensBySupplier
  // blockEntity.stakedApps = stakedApps
  // blockEntity.stakedAppsTokens = stakedTokensByApp
  // blockEntity.unstakingApps = unstakingApps
  // blockEntity.unstakingAppsTokens = unstakingTokensByApp
  // blockEntity.unstakedApps = unstakedApps
  // blockEntity.unstakedAppsTokens = unstakedTokensByApp
  // blockEntity.stakedGateways = stakedGateways
  // blockEntity.stakedGatewaysTokens = stakedTokensByGateway
  // blockEntity.unstakedGateways = unstakedGateways
  // blockEntity.unstakedGatewaysTokens = unstakedTokensByGateway
  //
  // await Promise.all([
  //   blockEntity.save(),
  //   store.bulkCreate('RelayByBlockAndService', relaysByService.map(relay => ({
  //     id: `${block.block.id}-${relay.service}`,
  //     relays: relay.relays,
  //     amount: relay.amount,
  //     computedUnits: relay.computedUnits,
  //     claimedUpokt: relay.tokens,
  //     blockId: block.block.id,
  //     serviceId: relay.service,
  //   } as RelayByBlockAndServiceProps))),
  //   store.bulkCreate('StakedSuppliersByBlockAndService', stakedSuppliersByService.map(staked => ({
  //     id: `${block.block.id}-${staked.service}`,
  //     tokens: staked.tokens,
  //     amount: staked.amount,
  //     blockId: block.block.id,
  //     serviceId: staked.service,
  //   } as StakedSuppliersByBlockAndServiceProps))),
  //   store.bulkCreate('StakedAppsByBlockAndService', stakedAppsByService.map(staked => ({
  //     id: `${block.block.id}-${staked.service}`,
  //     tokens: staked.tokens,
  //     amount: staked.amount,
  //     blockId: block.block.id,
  //     serviceId: staked.service,
  //   } as StakedAppsByBlockAndServiceProps))),
  // ])
  const end = Date.now();
  logger.info(`[handleAddBlockReports] Block #${block.header.height} processed in ${end - startTime}ms.`);
}

async function getRelaysData(block: CosmosBlock) {
  const relays: Array<EventClaimSettled> = [];
  const limit = 100;
  let offset = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const items: Array<EventClaimSettled> = await EventClaimSettled.getByFields([["blockId", "=", block.block.id]], {
      limit,
      offset,
    });

    // eslint-disable-next-line
    //@ts-ignore
    if (items.length === 0) {
      break;
    }

    relays.push(...items);
    offset += limit;
  }

  const relaysByServiceMap: Record<string, {
    tokens: bigint,
    computedUnits: bigint,
    amount: number,
    relays: bigint,
  }> = {};

  let relaysAmount = BigInt(0), computedUnits = BigInt(0), claimedAmount = BigInt(0);

  for (const relay of relays) {
    relaysAmount += relay.numRelays || BigInt(0);
    computedUnits += relay.numClaimedComputedUnits || BigInt(0);
    claimedAmount += relay.claimedAmount || BigInt(0);

    if (!relaysByServiceMap[relay.serviceId]) {
      relaysByServiceMap[relay.serviceId] = {
        tokens: BigInt(0),
        computedUnits: BigInt(0),
        amount: 0,
        relays: BigInt(0),
      };
    }

    relaysByServiceMap[relay.serviceId].amount += 1;
    relaysByServiceMap[relay.serviceId].relays += relay.numRelays || BigInt(0);
    relaysByServiceMap[relay.serviceId].tokens += relay.claimedAmount || BigInt(0);
    relaysByServiceMap[relay.serviceId].computedUnits += relay.numClaimedComputedUnits || BigInt(0);
  }

  const relaysByService = Object.entries(relaysByServiceMap).map(([service, {
    amount,
    computedUnits,
    relays,
    tokens,
  }]) => ({
    service,
    tokens,
    amount,
    computedUnits,
    relays,
  }));

  return {
    relays: relaysAmount,
    computedUnits,
    claimedAmount,
    relaysByService,
  };
}

async function getTransactionsData(block: CosmosBlock) {
  const transactions: Array<Transaction> = [];
  const limit = 100;
  let offset = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const items: Array<Transaction> = await Transaction.getByFields([["blockId", "=", block.block.id]], {
      limit,
      offset,
    });

    // eslint-disable-next-line
    //@ts-ignore
    if (items.length === 0) {
      break;
    }

    transactions.push(...items);
    offset += limit;
  }

  let validTxs = 0, invalidTxs = 0;

  for (const tx of transactions) {
    if (tx.code === 0) {
      validTxs += 1;
    } else {
      invalidTxs += 1;
    }
  }

  return {
    validTxs,
    invalidTxs,
  };
}

async function getStakedSuppliersData() {
  // TODO: ADD A WAY TO LOAD MORE (PAGINATION)
  const stakedSuppliers = await Supplier.getByFields([["stakeStatus", "=", StakeStatus.Staked]], { limit: 100 });
  const stakedSuppliersByServiceMap: Record<string, {
    tokens: bigint,
    amount: number,
  }> = {};

  let stakedTokensBySupplier = BigInt(0);

  for (const supplier of stakedSuppliers) {
    stakedTokensBySupplier += supplier.stakeAmount;
    // TODO: ADD A WAY TO LOAD MORE (PAGINATION)
    const services = await SupplierServiceConfig.getBySupplierId(supplier.id, { limit: 100 });

    for (const { serviceId } of services) {
      if (!stakedSuppliersByServiceMap[serviceId]) {
        stakedSuppliersByServiceMap[serviceId] = {
          tokens: BigInt(0),
          amount: 0,
        };
      } else {
        stakedSuppliersByServiceMap[serviceId].tokens += supplier.stakeAmount;
        stakedSuppliersByServiceMap[serviceId].amount += 1;
      }
    }
  }

  const stakedSuppliersByService = Object.entries(stakedSuppliersByServiceMap).map(([service, { amount, tokens }]) => ({
    service,
    tokens,
    amount,
  }));

  return {
    stakedSuppliers: stakedSuppliers.length,
    stakedTokensBySupplier,
    stakedSuppliersByService,
  };
}

async function getUnstakingSuppliersData() {
  // TODO: ADD A WAY TO LOAD MORE (PAGINATION)
  const unstakingSuppliers = await Supplier.getByFields([["stakeStatus", "=", StakeStatus.Unstaking]], { limit: 100 });
  const unstakingTokensBySupplier = unstakingSuppliers.reduce((acc, supplier) => acc + BigInt(supplier.stakeAmount), BigInt(0));

  return {
    unstakingSuppliers: unstakingSuppliers.length,
    unstakingTokensBySupplier,
  };
}

async function getTook(block: CosmosBlock) {
  if (block.header.height === 1) {
    return 0;
  }

  const previousHeight = BigInt(block.header.height - 1);
  const previousBlock = await Block.get(previousHeight);

  if (!previousBlock) {
    throw new Error(
      `Block ${previousHeight} not found in the database. Please check if the previous block was processed.`,
    );
  }

  // took is the time between the previous block and the current block
  return block.header.time.getTime() - previousBlock.timestamp.getTime();
}

async function getUnstakedSuppliersData(blockId: bigint) {
  // TODO: ADD A WAY TO LOAD MORE (PAGINATION)
  const unstakedSuppliers = await Supplier.getByUnstakingEndBlockId(blockId, { limit: 100 });
  const unstakedTokensBySupplier = unstakedSuppliers.reduce((acc, supplier) => acc + BigInt(supplier.stakeAmount), BigInt(0));

  return {
    unstakedSuppliers: unstakedSuppliers.length,
    unstakedTokensBySupplier,
  };
}

async function getStakedAppsData() {
  const stakedApps = await Application.getByFields([["stakeStatus", "=", StakeStatus.Staked]], { limit: 100 });
  const stakedAppsByServiceMap: Record<string, {
    tokens: bigint,
    amount: number,
  }> = {};

  let stakedTokensByApp = BigInt(0);

  for (const app of stakedApps) {
    stakedTokensByApp += app.stakeAmount;

    const services = await ApplicationService.getByApplicationId(app.id, { limit: 100 });

    for (const { serviceId } of services) {
      if (!stakedAppsByServiceMap[serviceId]) {
        stakedAppsByServiceMap[serviceId] = {
          tokens: BigInt(0),
          amount: 0,
        };
      } else {
        stakedAppsByServiceMap[serviceId].tokens += app.stakeAmount;
        stakedAppsByServiceMap[serviceId].amount += 1;
      }
    }
  }

  const stakedAppsByService = Object.entries(stakedAppsByServiceMap).map(([service, { amount, tokens }]) => ({
    service,
    tokens,
    amount,
  }));

  return {
    stakedApps: stakedApps.length,
    stakedTokensByApp,
    stakedAppsByService,
  };
}

async function getUnstakingAppsData() {
  // TODO: ADD A WAY TO LOAD MORE (PAGINATION)
  const unstakingApps = await Application.getByFields([["stakeStatus", "=", StakeStatus.Unstaking]], { limit: 100 });
  const unstakingTokensByApp = unstakingApps.reduce((acc, app) => acc + app.stakeAmount, BigInt(0));

  return {
    unstakingApps: unstakingApps.length,
    unstakingTokensByApp,
  };
}

async function getUnstakedAppssData(blockId: bigint) {
  // TODO: ADD A WAY TO LOAD MORE (PAGINATION)
  const unstakedApps = await Application.getByUnstakingEndBlockId(blockId, { limit: 100 });
  const unstakedTokensByApp = unstakedApps.reduce((acc, app) => acc + BigInt(app.stakeAmount), BigInt(0));

  return {
    unstakedApps: unstakedApps.length,
    unstakedTokensByApp,
  };
}

async function getStakedGatewaysData() {
  // TODO: ADD A WAY TO LOAD MORE (PAGINATION)
  const stakedGateways = await Gateway.getByFields([["stakeStatus", "=", StakeStatus.Staked]], { limit: 100 });
  const stakedTokensByGateway = stakedGateways.reduce((acc, gateway) => acc + BigInt(gateway.stakeAmount), BigInt(0));

  return {
    stakedGateways: stakedGateways.length,
    stakedTokensByGateway,
  };
}

async function getUnstakedGatewaysData(blockId: bigint) {
  // TODO: ADD A WAY TO LOAD MORE (PAGINATION)
  const unstakedGateways = await Gateway.getByUnstakingEndBlockId(blockId, { limit: 100 });
  const unstakedTokensByGateway = unstakedGateways.reduce((acc, gateway) => acc + BigInt(gateway.stakeAmount), BigInt(0));

  return {
    unstakedGateways: unstakedGateways.length,
    unstakedTokensByGateway,
  };
}
