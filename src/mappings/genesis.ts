import { CosmosBlock } from "@subql/types-cosmos";
import {
  Event,
  GenesisFile as GenesisEntity,
} from "../types";
import type { AccountProps } from "../types/models/Account";
import { AddServiceMsgProps } from "../types/models/AddServiceMsg";
import type { ApplicationProps } from "../types/models/Application";
import type { ApplicationDelegatedToGatewayProps } from "../types/models/ApplicationDelegatedToGateway";
import type { ApplicationServiceProps } from "../types/models/ApplicationService";
import type { AppParamProps } from "../types/models/AppParam";
import type { AppStakeMsgProps } from "../types/models/AppStakeMsg";
import type { AppStakeMsgServiceProps } from "../types/models/AppStakeMsgService";
import type { BalanceProps } from "../types/models/Balance";
import { DelegateToGatewayMsgProps } from "../types/models/DelegateToGatewayMsg";
import type { GatewayProps } from "../types/models/Gateway";
import type { GatewayStakeMsgProps } from "../types/models/GatewayStakeMsg";
import type { GenesisBalanceProps } from "../types/models/GenesisBalance";
import type { NativeBalanceChangeProps } from "../types/models/NativeBalanceChange";
import type { ServiceProps } from "../types/models/Service";
import type { SupplierProps } from "../types/models/Supplier";
import type { SupplierServiceProps } from "../types/models/SupplierService";
import type { SupplierStakeMsgProps } from "../types/models/SupplierStakeMsg";
import type { SupplierStakeMsgServiceProps } from "../types/models/SupplierStakeMsgService";
import type { TransactionProps } from "../types/models/Transaction";
import { configOptionsFromJSON, rPCTypeFromJSON } from "../types/proto-interfaces/poktroll/shared/service";
import { StakeStatus, TxStatus } from "./constants";
import type { Genesis } from "./types/genesis";
import {
  getAppDelegatedToGatewayId,
  getBalanceId,
  getGenesisFakeTxHash,
  getMsgStakeServiceId, getParamId,
  getStakeServiceId,
} from "./utils";
// eslint-disable-next-line no-duplicate-imports
import { stringify } from "./utils";

export async function handleGenesis(block: CosmosBlock): Promise<void> {
  const genesis: Genesis = require('../../genesis.json');

  // IMPORTANT: Return early if this is not the genesis initial height as this is called for block indexed!
  if (block.block.header.height !== genesis.initial_height) {
    return
  }

  logger.info(`[handleGenesis] (block.header.height): indexing genesis block ${block.block.header.height}`);

  // save records
  await Promise.all([
    _handleGenesisEvent(block),
    _handleGenesisServices(genesis, block),
    _handleGenesisBalances(genesis, block),
    _handleGenesisGateways(genesis, block),
    _handleGenesisSuppliers(genesis, block),
    _handleGenesisApplications(genesis, block),
    // PARAMS
    _handleGenesisParams(genesis, block),
  ]);

  await GenesisEntity.create({
    id: block.block.header.height.toString(),
    raw: JSON.stringify(genesis),
  }).save();
}

async function _handleGenesisEvent(block: CosmosBlock): Promise<void> {
  await Event.create({
    id: "genesis",
    type: "genesis",
    blockId: block.block.id,
  }).save()
}

async function _handleGenesisBalances(genesis: Genesis, block: CosmosBlock): Promise<void> {
  // get Accounts
  const accounts : Array<AccountProps> = genesis.app_state.auth.accounts.map(account => {
    return {
      id: account.address,
      chainId: block.block.header.chainId,
    }
  })

  // get balances
  const nativeBalanceChanges: Array<NativeBalanceChangeProps> = [];
  const genesisBalances: Array<GenesisBalanceProps> = [];
  const balances: Array<BalanceProps> = [];

  type AmountByAccountAndDenom = Record<string, {
    accountId: string,
    amount: bigint,
    denom: string,
  }>

  // here we are grouping the amount of each denom for each account
  const amountByAccountAndDenom: AmountByAccountAndDenom = genesis.app_state.bank.balances.reduce((acc, balance) => {
    const amountByDenom: Record<string, bigint> = balance.coins.reduce((acc, coin) => ({
      ...acc,
      [coin.denom]: BigInt(acc[coin.denom] || 0) +  BigInt(coin.amount),
    }), {} as Record<string, bigint>)

    for (const [denom, amount] of Object.entries(amountByDenom)) {
      const id = getBalanceId(balance.address, denom)
      if (acc[id]) {
        acc[id].amount += amount
      } else {
        acc[id] = {
          amount,
          denom,
          accountId: balance.address,
        }
      }
    }

    return acc
  }, {} as AmountByAccountAndDenom)

  for (const [id, {accountId, amount, denom}] of Object.entries(amountByAccountAndDenom)) {
    nativeBalanceChanges.push({
      id,
      balanceOffset: amount.valueOf(),
      denom,
      accountId: accountId,
      eventId: "genesis",
      blockId: block.block.id,
    });

    genesisBalances.push({
      id,
      amount: amount,
      denom,
      accountId: accountId,
    });

    balances.push({
      id,
      amount: amount,
      denom,
      accountId: accountId,
      lastUpdatedBlockId: block.block.id,
    });
  }

  await Promise.all([
    store.bulkCreate('Account', accounts),
    store.bulkCreate('GenesisBalance', genesisBalances),
    store.bulkCreate('NativeBalanceChange', nativeBalanceChanges),
    store.bulkCreate('Balance', balances),
  ])
}

async function _handleGenesisServices(genesis: Genesis, block: CosmosBlock): Promise<void> {
  const services: Array<ServiceProps> = [], addServiceMsgs: Array<AddServiceMsgProps> = []

  for (const service of genesis.app_state.service.serviceList) {
    services.push({
      id: service.id,
      name: service.name,
      computeUnitsPerRelay: BigInt(service.compute_units_per_relay),
      ownerId: service.owner_address,
    })

    addServiceMsgs.push({
      id: `genesis-${service.id}`,
      serviceId: service.id,
      name: service.name,
      computeUnitsPerRelay: BigInt(service.compute_units_per_relay),
      ownerId: service.owner_address,
      blockId: block.block.id,
      transactionId: getGenesisFakeTxHash('service', 0),
    })
  }

  await Promise.all([
    store.bulkCreate('Service', services),
    store.bulkCreate('AddServiceMsg', addServiceMsgs),
  ])
}

async function _handleGenesisSuppliers(genesis: Genesis, block: CosmosBlock): Promise<void> {
  const suppliers: Array<SupplierProps> = []
  const supplierMsgStakes: Array<SupplierStakeMsgProps> = []
  const supplierServices: Array<SupplierServiceProps> = []
  const servicesAndSupplierMsgStakes: Array<SupplierStakeMsgServiceProps> = []
  const transactions: Array<TransactionProps> = []

  for (let i = 0; i < genesis.app_state.supplier.supplierList.length; i++) {
    const supplier = genesis.app_state.supplier.supplierList[i]
    const msgId = `genesis-${supplier.operator_address}`
    const transactionHash = getGenesisFakeTxHash('app', i)

    transactions.push({
      id: transactionHash,
      blockId: block.block.id,
      gasUsed: BigInt(0),
      gasWanted: BigInt(0),
      fees: [],
      status: TxStatus.Success,
    })

    const stakeCoin = {
      amount: supplier.stake.amount,
      denom: supplier.stake.denom,
    }

    supplierMsgStakes.push({
      id: msgId,
      stake: stakeCoin,
      blockId: block.block.id,
      transactionId: transactionHash,
      ownerId: supplier.owner_address,
      signerId: supplier.owner_address,
      supplierId: supplier.operator_address
    })

    suppliers.push({
      id: supplier.operator_address,
      operatorId: supplier.operator_address,
      ownerId: supplier.owner_address,
      stake: stakeCoin,
      status: StakeStatus.Staked
    })

    for (const service of supplier.services) {
      const endpoints = service.endpoints.map((endpoint) => ({
        url: endpoint.url,
        rpcType: rPCTypeFromJSON(endpoint.rpc_type),
        configs: endpoint.configs.map((config) => ({
          key: configOptionsFromJSON(config.key),
          value: config.value,
        })),
      }))

      const revShare = service.rev_share.map((revShare) => ({
        address: revShare.address,
        revSharePercentage: revShare.rev_share_percentage,
      }))

      servicesAndSupplierMsgStakes.push({
        id: getMsgStakeServiceId(msgId, service.service_id),
        supplierStakeMsgId: msgId,
        serviceId: service.service_id,
        endpoints,
        revShare,
      })

      supplierServices.push({
        id: getStakeServiceId(supplier.operator_address, service.service_id),
        supplierId: supplier.operator_address,
        serviceId: service.service_id,
        endpoints,
        revShare,
      })
    }
  }

  await Promise.all([
    store.bulkCreate('Supplier', suppliers),
    store.bulkCreate('SupplierStakeMsg', supplierMsgStakes),
    store.bulkCreate('SupplierService', supplierServices),
    store.bulkCreate('SupplierStakeMsgService', servicesAndSupplierMsgStakes),
    store.bulkCreate('Transaction', transactions)
  ])
}

async function _handleGenesisApplications(genesis: Genesis, block: CosmosBlock): Promise<void> {
  const applications: Array<ApplicationProps> = []
  const appMsgStakes: Array<AppStakeMsgProps> = []
  const appServices: Array<ApplicationServiceProps> = []
  const servicesAndAppMsgStakes: Array<AppStakeMsgServiceProps> = []
  const msgDelegateToGateways: Array<DelegateToGatewayMsgProps> = []
  const transactions: Array<TransactionProps> = []
  const appsDelegatedToGateways: Array<ApplicationDelegatedToGatewayProps> = []

  for (let i = 0; i < genesis.app_state.application.applicationList.length; i++) {
    const app = genesis.app_state.application.applicationList[i]
    const msgId = `genesis-${app.address}`
    const transactionHash = getGenesisFakeTxHash('app', i)

    transactions.push({
      id: transactionHash,
      blockId: block.block.id,
      gasUsed: BigInt(0),
      gasWanted: BigInt(0),
      fees: [],
      status: TxStatus.Success,
    })

    if (app.delegatee_gateway_addresses.length > 0) {
      for (const gatewayAddress of app.delegatee_gateway_addresses) {
        msgDelegateToGateways.push({
          id: `${msgId}-${gatewayAddress}`,
          applicationId: app.address,
          gatewayId: gatewayAddress,
          blockId: block.block.id,
          transactionId: transactionHash
        })

        appsDelegatedToGateways.push({
          id: getAppDelegatedToGatewayId(app.address, gatewayAddress),
          applicationId: app.address,
          gatewayId: gatewayAddress,
        })
      }
    }

    const stakeCoin = {
      amount: app.stake.amount,
      denom: app.stake.denom,
    }

    appMsgStakes.push({
      id: msgId,
      stake: stakeCoin,
      blockId: block.block.id,
      applicationId: app.address,
      transactionId: transactionHash
    })

    applications.push({
      id: app.address,
      accountId: app.address,
      stake: stakeCoin,
      status: StakeStatus.Staked
    })

    for (const service of app.service_configs) {
      servicesAndAppMsgStakes.push({
        id: getMsgStakeServiceId(msgId, service.service_id),
        appStakeMsgId: msgId,
        serviceId: service.service_id,
      })

      appServices.push({
        id: getStakeServiceId(app.address, service.service_id),
        applicationId: app.address,
        serviceId: service.service_id,
      })
    }
  }

  const promises: Array<Promise<void>> =[
    store.bulkCreate('AppStakeMsg', appMsgStakes),
    store.bulkCreate('Application', applications),
    store.bulkCreate('Transaction', transactions),
    store.bulkCreate('ApplicationService', appServices),
    store.bulkCreate('AppStakeMsgService', servicesAndAppMsgStakes),
    store.bulkCreate('ApplicationDelegatedToGateway', appsDelegatedToGateways)
  ]

  if (msgDelegateToGateways.length > 0) {
    promises.push(store.bulkCreate('DelegateToGatewayMsg', msgDelegateToGateways))
  }

  await Promise.all(promises)
}

async function _handleGenesisGateways(genesis: Genesis, block: CosmosBlock): Promise<void> {
  const gateways: Array<GatewayProps> = []
  const gatewayMsgStakes: Array<GatewayStakeMsgProps> = []
  const transactions: Array<TransactionProps> = []

  for (let i = 0; i < genesis.app_state.gateway.gatewayList.length; i++) {
    const gateway = genesis.app_state.gateway.gatewayList[i]
    const msgId = `genesis-${gateway.address}`
    const transactionHash = getGenesisFakeTxHash('gateway', i)

    transactions.push({
      id: transactionHash,
      blockId: block.block.id,
      gasUsed: BigInt(0),
      gasWanted: BigInt(0),
      fees: [],
      status: TxStatus.Success,
    })

    const stakeCoin = {
      amount: gateway.stake.amount,
      denom: gateway.stake.denom,
    }

    gatewayMsgStakes.push({
      id: msgId,
      stake: stakeCoin,
      blockId: block.block.id,
      gatewayId: gateway.address,
      transactionId: transactionHash
    })

    gateways.push({
      id: gateway.address,
      accountId: gateway.address,
      stake: stakeCoin,
      status: StakeStatus.Staked
    })
  }

  await Promise.all([
    store.bulkCreate('Gateway', gateways),
    store.bulkCreate('GatewayStakeMsg', gatewayMsgStakes),
    store.bulkCreate('Transaction', transactions)
  ])
}

async function saveParams(entityName: string, params: Record<string, unknown> | undefined, block: CosmosBlock): Promise<void> {
  const paramsEntries = Object.entries(params || {});

  if (!paramsEntries.length) {
    return
  }

  const paramsToSave: Array<AppParamProps> = paramsEntries.map(([key, value]) => ({
    id: getParamId(key, block.block.id),
    key,
    // just using stringify for objects because if a string is passed in, it will put it in quotes
    value: typeof value === 'object' ? stringify(value) : (value || "").toString(),
    blockId: block.block.id,
  }))

  await store.bulkCreate(entityName, paramsToSave)
}

async function _handleGenesisParams(
  genesis: Genesis,
  block: CosmosBlock
): Promise<void> {
  await Promise.all([
    saveParams('AppParam', genesis.app_state.application?.params, block),
    saveParams('AuthParam', genesis.app_state.auth?.params, block),
    saveParams('BankParam', genesis.app_state.bank?.params, block),
    saveParams('DistributionParam', genesis.app_state.distribution?.params, block),
    saveParams('GatewayParam', genesis.app_state.gateway?.params, block),
    saveParams('GovParam', genesis.app_state.gov?.params, block),
    saveParams('MintParam', genesis.app_state.mint?.params, block),
    saveParams('ProofParam', genesis.app_state.proof?.params, block),
    saveParams('ServiceParam', genesis.app_state.service?.params, block),
    saveParams('SessionParam', genesis.app_state.session?.params, block),
    saveParams('SharedParam', genesis.app_state.shared?.params, block),
    saveParams('SlashingParam', genesis.app_state.slashing?.params, block),
    saveParams('StakingParam', genesis.app_state.staking?.params, block),
    saveParams('SupplierParam', genesis.app_state.supplier?.params, block),
    saveParams('TokenomicsParam', genesis.app_state.tokenomics?.params, block),
    saveParams('ConsensusParam', genesis.app_state.consensus?.params, block),
  ])
}
