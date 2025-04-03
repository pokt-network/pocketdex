import { CosmosBlock } from "@subql/types-cosmos";
import {
  Block,
  EventClaimSettled,
  StakeStatus,
  Transaction,
} from "../../types";
import { RelayByBlockAndServiceProps } from "../../types/models/RelayByBlockAndService";
import { StakedAppsByBlockAndServiceProps } from "../../types/models/StakedAppsByBlockAndService";
import { StakedSuppliersByBlockAndServiceProps } from "../../types/models/StakedSuppliersByBlockAndService";
import { optimizedBulkCreate } from "../utils/db";
import { getBlockId } from "../utils/ids";
import {
  fetchAllApplicationByStatus,
  fetchAllApplicationByUnstakingEndBlockId,
  fetchAllApplicationServiceByApplicationId,
  fetchAllEventClaimSettled,
  fetchAllGatewayByStatus,
  fetchAllGatewayByUnstakingEndBlockId,
  fetchAllSupplierByStatus,
  fetchAllSupplierByUnstakingEndBlockId,
  fetchAllSupplierServiceConfigBySupplier,
  fetchAllTransactions,
  fetchAllValidatorByStatus,
} from "./pagination";

export async function handleAddBlockReports(block: CosmosBlock): Promise<void> {
  logger.info(`[handleAddBlockReports] Generating block #${block.header.height} reports...`);
  const blockHeight = getBlockId(block);
  const blockEntity = await Block.get(blockHeight);

  if (!blockEntity) {
    throw new Error(`Block ${blockHeight} not found in the database. Please check why the current indexing block is not saved.`);
  }

  const [
    { computedUnits, relays, relaysByService },
    { invalidTxs, validTxs },
    { stakedSuppliers, stakedSuppliersByService, stakedTokensBySupplier },
    { unstakingSuppliers, unstakingTokensBySupplier },
    took,
    { unstakedSuppliers, unstakedTokensBySupplier },
    { stakedApps, stakedAppsByService, stakedTokensByApp },
    { unstakingApps, unstakingTokensByApp },
    { unstakedApps, unstakedTokensByApp },
    { stakedGateways, stakedTokensByGateway },
    { unstakedGateways, unstakedTokensByGateway },
    { stakedTokensByValidators, stakedValidators },
    { unstakingTokensByValidators, unstakingValidators }
  ] = await Promise.all([
    getRelaysData(blockHeight),
    getTransactionsData(blockHeight),
    getStakedSuppliersData(),
    getUnstakingSuppliersData(),
    getTook(block),
    getUnstakedSuppliersData(blockHeight),
    getStakedAppsData(),
    getUnstakingAppsData(),
    getUnstakedAppsData(blockHeight),
    getStakedGatewaysData(),
    getUnstakedGatewaysData(blockHeight),
    getStakedValidatorsData(),
    getUnstakingValidatorsData(),
  ]);

  blockEntity.totalComputedUnits = computedUnits;
  blockEntity.totalRelays = relays;
  blockEntity.failedTxs = invalidTxs;
  blockEntity.successfulTxs = validTxs;
  blockEntity.timeToBlock = took;
  blockEntity.totalTxs = validTxs + invalidTxs;
  blockEntity.stakedSuppliers = stakedSuppliers;
  blockEntity.stakedSuppliersTokens = stakedTokensBySupplier;
  blockEntity.unstakingSuppliers = unstakingSuppliers;
  blockEntity.unstakingSuppliersTokens = unstakingTokensBySupplier;
  blockEntity.unstakedSuppliers = unstakedSuppliers;
  blockEntity.unstakedSuppliersTokens = unstakedTokensBySupplier;
  blockEntity.stakedApps = stakedApps;
  blockEntity.stakedAppsTokens = stakedTokensByApp;
  blockEntity.unstakingApps = unstakingApps;
  blockEntity.unstakingAppsTokens = unstakingTokensByApp;
  blockEntity.unstakedApps = unstakedApps;
  blockEntity.unstakedAppsTokens = unstakedTokensByApp;
  blockEntity.stakedGateways = stakedGateways;
  blockEntity.stakedGatewaysTokens = stakedTokensByGateway;
  blockEntity.unstakedGateways = unstakedGateways;
  blockEntity.unstakedGatewaysTokens = unstakedTokensByGateway;
  blockEntity.stakedValidators = stakedValidators;
  blockEntity.stakedValidatorsTokens = stakedTokensByValidators;
  blockEntity.unstakingValidators = unstakingValidators;
  blockEntity.unstakingValidatorsTokens = unstakingTokensByValidators;

  await Promise.all([
    blockEntity.save(),
    optimizedBulkCreate("RelayByBlockAndService", relaysByService.map(relay => ({
      id: `${block.block.id}-${relay.service}`,
      relays: relay.relays,
      amount: relay.amount,
      computedUnits: relay.computedUnits,
      claimedUpokt: relay.tokens,
      blockId: blockHeight,
      serviceId: relay.service,
    } as RelayByBlockAndServiceProps))),
    optimizedBulkCreate("StakedSuppliersByBlockAndService", stakedSuppliersByService.map(staked => ({
      id: `${block.block.id}-${staked.service}`,
      tokens: staked.tokens,
      amount: staked.amount,
      blockId: blockHeight,
      serviceId: staked.service,
    } as StakedSuppliersByBlockAndServiceProps))),
    optimizedBulkCreate("StakedAppsByBlockAndService", stakedAppsByService.map(staked => ({
      id: `${block.block.id}-${staked.service}`,
      tokens: staked.tokens,
      amount: staked.amount,
      blockId: blockHeight,
      serviceId: staked.service,
    } as StakedAppsByBlockAndServiceProps))),
  ]);
}

async function getRelaysData(blockHeight: bigint) {
  const relays: Array<EventClaimSettled> = await fetchAllEventClaimSettled(blockHeight);

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

async function getTransactionsData(blockHeight: bigint) {
  const transactions: Array<Transaction> = await fetchAllTransactions(blockHeight);

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
  const stakedSuppliers = await fetchAllSupplierByStatus(StakeStatus.Staked);
  const stakedSuppliersByServiceMap: Record<string, {
    tokens: bigint,
    amount: number,
  }> = {};

  let stakedTokensBySupplier = BigInt(0);

  for (const supplier of stakedSuppliers) {
    stakedTokensBySupplier += supplier.stakeAmount;
    const services = await fetchAllSupplierServiceConfigBySupplier(supplier.id);

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
  const unstakingSuppliers = await fetchAllSupplierByStatus(StakeStatus.Unstaking);
  const unstakingTokensBySupplier = unstakingSuppliers.reduce((acc, supplier) => acc + BigInt(supplier.stakeAmount), BigInt(0));

  return {
    unstakingSuppliers: unstakingSuppliers.length,
    unstakingTokensBySupplier,
  };
}

async function getStakedValidatorsData() {
  const stakedValidators = await fetchAllValidatorByStatus(StakeStatus.Staked);
  const stakedTokensByValidators = stakedValidators.reduce((acc, validator) => acc + BigInt(validator.stakeAmount), BigInt(0));

  return {
    stakedValidators: stakedValidators.length,
    stakedTokensByValidators: stakedTokensByValidators,
  };
}

async function getUnstakingValidatorsData() {
  const unstakingValidators = await fetchAllValidatorByStatus(StakeStatus.Unstaking);
  const unstakingTokensByValidators = unstakingValidators.reduce((acc, validator) => acc + BigInt(validator.stakeAmount), BigInt(0));

  return {
    unstakingValidators: unstakingValidators.length,
    unstakingTokensByValidators,
  };
}

async function getTook(block: CosmosBlock) {
  if (block.header.height === 1) {
    return 0;
  }

  const previousHeight = BigInt(block.header.height - 1);
  const previousBlock = await Block.get(previousHeight);

  if (!previousBlock) {
    // if we throw an error here when we start at some random block for debugging, this will break the indexing.
    logger.error(`Block ${previousHeight} not found in the database. Please check if the previous block was processed.`);
    return -1;
  }

  // took is the time between the previous block and the current block
  return block.header.time.getTime() - previousBlock.timestamp.getTime();
}

async function getUnstakedSuppliersData(blockHeight: bigint) {
  const unstakedSuppliers = await fetchAllSupplierByUnstakingEndBlockId(blockHeight);
  const unstakedTokensBySupplier = unstakedSuppliers.reduce((acc, supplier) => acc + BigInt(supplier.stakeAmount), BigInt(0));

  return {
    unstakedSuppliers: unstakedSuppliers.length,
    unstakedTokensBySupplier,
  };
}

async function getStakedAppsData() {
  const stakedApps = await fetchAllApplicationByStatus(StakeStatus.Staked);
  const stakedAppsByServiceMap: Record<string, {
    tokens: bigint,
    amount: number,
  }> = {};

  let stakedTokensByApp = BigInt(0);

  for (const app of stakedApps) {
    stakedTokensByApp += app.stakeAmount;

    const services = await fetchAllApplicationServiceByApplicationId(app.id);

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
  const unstakingApps = await fetchAllApplicationByStatus(StakeStatus.Unstaking);
  const unstakingTokensByApp = unstakingApps.reduce((acc, app) => acc + app.stakeAmount, BigInt(0));

  return {
    unstakingApps: unstakingApps.length,
    unstakingTokensByApp,
  };
}

async function getUnstakedAppsData(blockId: bigint) {
  const unstakedApps = await fetchAllApplicationByUnstakingEndBlockId(blockId);
  const unstakedTokensByApp = unstakedApps.reduce((acc, app) => acc + BigInt(app.stakeAmount), BigInt(0));

  return {
    unstakedApps: unstakedApps.length,
    unstakedTokensByApp,
  };
}

async function getStakedGatewaysData() {
  const stakedGateways = await fetchAllGatewayByStatus(StakeStatus.Staked);
  const stakedTokensByGateway = stakedGateways.reduce((acc, gateway) => acc + BigInt(gateway.stakeAmount), BigInt(0));

  return {
    stakedGateways: stakedGateways.length,
    stakedTokensByGateway,
  };
}

async function getUnstakedGatewaysData(blockId: bigint) {
  const unstakedGateways = await fetchAllGatewayByUnstakingEndBlockId(blockId);
  const unstakedTokensByGateway = unstakedGateways.reduce((acc, gateway) => acc + BigInt(gateway.stakeAmount), BigInt(0));

  return {
    unstakedGateways: unstakedGateways.length,
    unstakedTokensByGateway,
  };
}
