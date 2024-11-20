import { CosmosBlock } from "@subql/types-cosmos";
import {
  Application,
  ApplicationService,
  Block,
  EventClaimSettled, Gateway,
  Supplier,
  SupplierServiceConfig,
  Transaction,
} from "../../types";
import { RelayByBlockAndServiceProps } from "../../types/models/RelayByBlockAndService";
import { StakedAppsByBlockAndServiceProps } from "../../types/models/StakedAppsByBlockAndService";
import { StakedSuppliersByBlockAndServiceProps } from "../../types/models/StakedSuppliersByBlockAndService";
import { StakeStatus, TxStatus } from "../constants";

export async function handleAddBlockReports(block: CosmosBlock): Promise<void> {
  const [
    {computedUnits, relays, relaysByService},
    {invalidTxs, validTxs},
    {stakedSuppliers, stakedSuppliersByService, stakedTokensBySupplier},
    {unstakingSuppliers, unstakingTokensBySupplier},
    took,
    {unstakedSuppliers, unstakedTokensBySupplier},
    {stakedApps, stakedAppsByService, stakedTokensByApp},
    {unstakingApps, unstakingTokensByApp},
    {unstakedApps, unstakedTokensByApp},
    {stakedGateways, stakedTokensByGateway},
    {unstakedGateways, unstakedTokensByGateway},
    blockFromDB
  ] = await Promise.all([
    getRelaysData(block),
    getTransactionsData(block),
    getStakedSuppliersData(),
    getUnstakingSuppliersData(),
    getTook(block),
    getUnstakedSuppliersData(block.block.id),
    getStakedAppsData(),
    getUnstakingAppsData(),
    getUnstakedAppssData(block.block.id),
    getStakedGatewaysData(),
    getUnstakedGatewaysData(block.block.id),
    Block.get(block.block.id)!
  ] as const)

  const blockEntity = blockFromDB as Block

  blockEntity.totalComputedUnits = computedUnits
  blockEntity.totalRelays = relays
  blockEntity.failedTxs = invalidTxs
  blockEntity.validTxs = validTxs
  blockEntity.took = took
  blockEntity.totalTxs = validTxs + invalidTxs
  blockEntity.stakedSuppliers = stakedSuppliers
  blockEntity.suppliersStakedTokens = stakedTokensBySupplier
  blockEntity.unstakingSuppliers = unstakingSuppliers
  blockEntity.suppliersUnstakingTokens = unstakingTokensBySupplier
  blockEntity.unstakedSuppliers = unstakedSuppliers
  blockEntity.unstakedTokensOfSuppliers = unstakedTokensBySupplier
  blockEntity.stakedApps = stakedApps
  blockEntity.appsStakedTokens = stakedTokensByApp
  blockEntity.unstakingApps = unstakingApps
  blockEntity.appsUnstakingTokens = unstakingTokensByApp
  blockEntity.unstakedApps = unstakedApps
  blockEntity.unstakedTokensOfApps = unstakedTokensByApp
  blockEntity.stakedGateways = stakedGateways
  blockEntity.gatewaysStakedTokens = stakedTokensByGateway
  blockEntity.unstakingGateways = unstakedGateways
  blockEntity.gatewaysUnstakingTokens = unstakedTokensByGateway

  await Promise.all([
    blockEntity.save(),
    store.bulkCreate('RelayByBlockAndService', relaysByService.map(relay => ({
      id: `${block.block.id}-${relay.service}`,
      relays: relay.relays,
      amount: relay.amount,
      computedUnits: relay.computedUnits,
      blockId: block.block.id,
      serviceId: relay.service,
    } as RelayByBlockAndServiceProps))),
    store.bulkCreate('StakedSuppliersByBlockAndService', stakedSuppliersByService.map(staked => ({
      id: `${block.block.id}-${staked.service}`,
      tokens: staked.tokens,
      amount: staked.amount,
      blockId: block.block.id,
      serviceId: staked.service,
    } as StakedSuppliersByBlockAndServiceProps))),
    store.bulkCreate('StakedAppsByBlockAndService', stakedAppsByService.map(staked => ({
      id: `${block.block.id}-${staked.service}`,
      tokens: staked.tokens,
      amount: staked.amount,
      blockId: block.block.id,
      serviceId: staked.service,
    } as StakedAppsByBlockAndServiceProps))),
  ])
}

async function getRelaysData(block: CosmosBlock){
  const relays = await EventClaimSettled.getByFields([["blockId", "=", block.block.id]], {})
  const relaysByServiceMap: Record<string,{
    tokens: bigint,
    computedUnits: bigint,
    amount: number,
    relays: bigint,
  }> = {}

  let relaysAmount = BigInt(0), computedUnits = BigInt(0), claimedAmount = BigInt(0);

  for (const relay of relays) {
    relaysAmount += relay.numRelays || BigInt(0)
    computedUnits += relay.numClaimedComputedUnits || BigInt(0)
    claimedAmount += relay.claimedAmount || BigInt(0)

    if (!relaysByServiceMap[relay.serviceId]) {
      relaysByServiceMap[relay.serviceId] = {
        tokens: BigInt(0),
        computedUnits: BigInt(0),
        amount: 0,
        relays: BigInt(0),
      }
    }

    relaysByServiceMap[relay.serviceId].amount += 1
    relaysByServiceMap[relay.serviceId].relays += relay.numRelays || BigInt(0)
    relaysByServiceMap[relay.serviceId].tokens += relay.claimedAmount || BigInt(0)
    relaysByServiceMap[relay.serviceId].computedUnits += relay.numClaimedComputedUnits || BigInt(0)
  }

  const relaysByService = Object.entries(relaysByServiceMap).map(([service, {amount, computedUnits, relays, tokens}]) => ({
    service,
    tokens,
    amount,
    computedUnits,
    relays
  }))

  return {
    relays: relaysAmount,
    computedUnits,
    claimedAmount,
    relaysByService
  }
}

async function getTransactionsData(block: CosmosBlock){
  const transactions = await Transaction.getByBlockId(block.block.id, {})

  let validTxs = 0, invalidTxs = 0;

  for (const tx of transactions) {
    if (tx.code === 0) {
      validTxs += 1
    } else {
      invalidTxs += 1
    }
  }

  return {
    validTxs,
    invalidTxs
  }
}

async function getStakedSuppliersData() {
  const stakedSuppliers = await Supplier.getByFields([["stakeStatus", "=", StakeStatus.Staked]], {})
  const stakedSuppliersByServiceMap: Record<string,{
    tokens: bigint,
    amount: number,
  }> = {}

  let stakedTokensBySupplier = BigInt(0)

  for (const supplier of stakedSuppliers) {
    stakedTokensBySupplier += supplier.stakeAmount

    const services = await SupplierServiceConfig.getBySupplierId(supplier.id, {})

    for (const {serviceId} of services) {
      if (!stakedSuppliersByServiceMap[serviceId]) {
        stakedSuppliersByServiceMap[serviceId] = {
          tokens: BigInt(0),
          amount: 0,
        }
      } else {
        stakedSuppliersByServiceMap[serviceId].tokens += supplier.stakeAmount
        stakedSuppliersByServiceMap[serviceId].amount += 1
      }
    }
  }

  const stakedSuppliersByService = Object.entries(stakedSuppliersByServiceMap).map(([service, {amount, tokens}]) => ({
    service,
    tokens,
    amount,
  }))

  return {
    stakedSuppliers: stakedSuppliers.length,
    stakedTokensBySupplier,
    stakedSuppliersByService
  }
}

async function getUnstakingSuppliersData() {
  const unstakingSuppliers = await Supplier.getByFields([["stakeStatus", "=", StakeStatus.Unstaking]], {})
  const unstakingTokensBySupplier = unstakingSuppliers.reduce((acc, supplier) => acc + BigInt(supplier.stakeAmount), BigInt(0))

  return {
    unstakingSuppliers: unstakingSuppliers.length,
    unstakingTokensBySupplier,
  }
}

async function getTook(block: CosmosBlock) {
  if (block.header.height === 1) {
    return 0
  }

  const previousHeight = BigInt(block.header.height - 1)
  const previousBlock = (await Block.getByHeight(previousHeight, {}))[0]

  // took is the time between the previous block and the current block
  return block.header.time.getTime() - previousBlock.timestamp.getTime()
}

async function getUnstakedSuppliersData(blockId: string) {
  const unstakedSuppliers = await Supplier.getByUnstakingEndBlockId(blockId, {})
  const unstakedTokensBySupplier = unstakedSuppliers.reduce((acc, supplier) => acc + BigInt(supplier.stakeAmount), BigInt(0))

  return {
    unstakedSuppliers: unstakedSuppliers.length,
    unstakedTokensBySupplier,
  }
}

async function getStakedAppsData() {
  const stakedApps = await Application.getByFields([["stakeStatus", "=", StakeStatus.Staked]], {})
  const stakedAppsByServiceMap: Record<string,{
    tokens: bigint,
    amount: number,
  }> = {}

  let stakedTokensByApp = BigInt(0)

  for (const app of stakedApps) {
    stakedTokensByApp += app.stakeAmount

    const services = await ApplicationService.getByApplicationId(app.id, {})

    for (const {serviceId} of services) {
      if (!stakedAppsByServiceMap[serviceId]) {
        stakedAppsByServiceMap[serviceId] = {
          tokens: BigInt(0),
          amount: 0,
        }
      } else {
        stakedAppsByServiceMap[serviceId].tokens += app.stakeAmount
        stakedAppsByServiceMap[serviceId].amount += 1
      }
    }
  }

  const stakedAppsByService = Object.entries(stakedAppsByServiceMap).map(([service, {amount, tokens}]) => ({
    service,
    tokens,
    amount,
  }))

  return {
    stakedApps: stakedApps.length,
    stakedTokensByApp,
    stakedAppsByService
  }
}

async function getUnstakingAppsData() {
  const unstakingApps = await Application.getByFields([["stakeStatus", "=", StakeStatus.Unstaking]], {})
  const unstakingTokensByApp = unstakingApps.reduce((acc, app) => acc + app.stakeAmount, BigInt(0))

  return {
    unstakingApps: unstakingApps.length,
    unstakingTokensByApp,
  }
}

async function getUnstakedAppssData(blockId: string) {
  const unstakedApps = await Application.getByUnstakingEndBlockId(blockId, {})
  const unstakedTokensByApp = unstakedApps.reduce((acc, app) => acc + BigInt(app.stakeAmount), BigInt(0))

  return {
    unstakedApps: unstakedApps.length,
    unstakedTokensByApp,
  }
}

async function getStakedGatewaysData() {
  const stakedGateways = await Gateway.getByFields([["stakeStatus", "=", StakeStatus.Staked]], {})
  const stakedTokensByGateway = stakedGateways.reduce((acc, gateway) => acc + BigInt(gateway.stakeAmount), BigInt(0))

  return {
    stakedGateways: stakedGateways.length,
    stakedTokensByGateway,
  }
}


async function getUnstakedGatewaysData(blockId: string) {
  const unstakedGateways = await Gateway.getByUnstakingEndBlockId(blockId, {})
  const unstakedTokensByGateway = unstakedGateways.reduce((acc, gateway) => acc + BigInt(gateway.stakeAmount), BigInt(0))

  return {
    unstakedGateways: unstakedGateways.length,
    unstakedTokensByGateway,
  }
}
