import { CosmosBlock } from "@subql/types-cosmos";
import {
  Event,
  GenesisFile as GenesisEntity,
} from "../types";
import type { AccountProps } from "../types/models/Account";
import type { ApplicationProps } from "../types/models/Application";
import { ApplicationGatewayProps } from "../types/models/ApplicationGateway";
import type { ApplicationServiceProps } from "../types/models/ApplicationService";
import type { AppParamProps } from "../types/models/AppParam";
import type { BalanceProps } from "../types/models/Balance";
import type { GatewayProps } from "../types/models/Gateway";
import type { GenesisBalanceProps } from "../types/models/GenesisBalance";
import { MsgAddServiceProps } from "../types/models/MsgAddService";
import { MsgDelegateToGatewayProps } from "../types/models/MsgDelegateToGateway";
import { MsgStakeApplicationProps } from "../types/models/MsgStakeApplication";
import { MsgStakeApplicationServiceProps } from "../types/models/MsgStakeApplicationService";
import { MsgStakeGatewayProps } from "../types/models/MsgStakeGateway";
import { MsgStakeSupplierProps } from "../types/models/MsgStakeSupplier";
import { MsgStakeSupplierServiceProps } from "../types/models/MsgStakeSupplierService";
import type { NativeBalanceChangeProps } from "../types/models/NativeBalanceChange";
import type { ServiceProps } from "../types/models/Service";
import type { SupplierProps } from "../types/models/Supplier";
import { SupplierServiceConfigProps } from "../types/models/SupplierServiceConfig";
import type { TransactionProps } from "../types/models/Transaction";
import {
  configOptionsFromJSON,
  rPCTypeFromJSON,
} from "../types/proto-interfaces/poktroll/shared/service";
import { getSupplyRecord } from "./bank/supply";
import {
  StakeStatus,
  TxStatus,
} from "./constants";
import type { Genesis } from "./types/genesis";
import {
  getAppDelegatedToGatewayId,
  getBalanceId,
  getGenesisFakeTxHash,
  getMsgStakeServiceId,
  getParamId,
  getStakeServiceId,
} from "./utils/ids";
import { stringify } from "./utils/json";


export async function handleGenesis(block: CosmosBlock): Promise<void> {
  // we MUST load the JSON this way due to the sandboxed environment
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const genesis: Genesis = require("../../genesis.json");

  // IMPORTANT: Return early if this is not the genesis initial height as this is called for block indexed!
  if (block.block.header.height !== genesis.initial_height) {
    return;
  }

  logger.info(`[handleGenesis] (block.header.height): indexing genesis block ${block.block.header.height}`);

  // save records
  await Promise.all([
    _handleGenesisSupplyDenom(genesis),
    _handleGenesisSupply(genesis, block),
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

// Creates an event for the entities that requires it. Doing this, we are still requiring the events in the schema.
async function _handleGenesisEvent(block: CosmosBlock): Promise<void> {
  await Event.create({
    id: "genesis",
    type: "genesis",
    blockId: block.block.id,
  }).save();
}

async function _handleGenesisBalances(genesis: Genesis, block: CosmosBlock): Promise<void> {
  const accounts: Array<AccountProps> = [];

  for (const account of genesis.app_state.auth.accounts) {
    accounts.push({
      id: account.address,
      chainId: block.block.header.chainId,
    });
  }

  // get balances
  const nativeBalanceChanges: Array<NativeBalanceChangeProps> = [];
  const genesisBalances: Array<GenesisBalanceProps> = [];
  const balances: Array<BalanceProps> = [];


  for (const balance of genesis.app_state.bank.balances) {
    for (const { amount, denom } of balance.coins) {
      const id = getBalanceId(balance.address, denom);

      nativeBalanceChanges.push({
        id,
        balanceOffset: BigInt(amount),
        denom,
        accountId: balance.address,
        eventId: "genesis",
        blockId: block.block.id,
      });

      genesisBalances.push({
        id,
        amount: BigInt(amount),
        denom,
        accountId: balance.address,
      });

      balances.push({
        id,
        amount: BigInt(amount),
        denom,
        accountId: balance.address,
        lastUpdatedBlockId: block.block.id,
      });
    }
  }

  await Promise.all([
    store.bulkCreate("Account", accounts),
    store.bulkCreate("GenesisBalance", genesisBalances),
    store.bulkCreate("NativeBalanceChange", nativeBalanceChanges),
    store.bulkCreate("Balance", balances),
  ]);
}

async function _handleGenesisServices(genesis: Genesis, block: CosmosBlock): Promise<void> {
  const services: Array<ServiceProps> = [], addServiceMsgs: Array<MsgAddServiceProps> = [];

  for (const service of genesis.app_state.service.serviceList) {
    services.push({
      id: service.id,
      name: service.name,
      computeUnitsPerRelay: BigInt(service.compute_units_per_relay),
      ownerId: service.owner_address,
    });

    const msgId = `genesis-${service.id}`;

    addServiceMsgs.push({
      id: msgId,
      serviceId: service.id,
      name: service.name,
      computeUnitsPerRelay: BigInt(service.compute_units_per_relay),
      ownerId: service.owner_address,
      blockId: block.block.id,
      transactionId: getGenesisFakeTxHash("service", 0),
      messageId: msgId,
    });
  }

  await Promise.all([
    store.bulkCreate("Service", services),
    store.bulkCreate("MsgAddService", addServiceMsgs),
  ]);
}

async function _handleGenesisSuppliers(genesis: Genesis, block: CosmosBlock): Promise<void> {
  const suppliers: Array<SupplierProps> = [];
  const supplierMsgStakes: Array<MsgStakeSupplierProps> = [];
  const supplierServices: Array<SupplierServiceConfigProps> = [];
  const servicesAndSupplierMsgStakes: Array<MsgStakeSupplierServiceProps> = [];
  const transactions: Array<TransactionProps> = [];

  for (let i = 0; i < genesis.app_state.supplier.supplierList.length; i++) {
    const supplier = genesis.app_state.supplier.supplierList[i];
    const msgId = `genesis-${supplier.operator_address}`;
    const transactionHash = getGenesisFakeTxHash("app", i);

    transactions.push({
      id: transactionHash,
      blockId: block.block.id,
      gasUsed: BigInt(0),
      gasWanted: BigInt(0),
      fees: [],
      status: TxStatus.Success,
    });

    supplierMsgStakes.push({
      id: msgId,
      blockId: block.block.id,
      stakeAmount: BigInt(supplier.stake.amount),
      stakeDenom: supplier.stake.denom,
      transactionId: transactionHash,
      ownerId: supplier.owner_address,
      signerId: supplier.owner_address,
      supplierId: supplier.operator_address,
      messageId: msgId,
    });

    suppliers.push({
      id: supplier.operator_address,
      operatorId: supplier.operator_address,
      ownerId: supplier.owner_address,
      stakeAmount: BigInt(supplier.stake.amount),
      stakeDenom: supplier.stake.denom,
      stakeStatus: StakeStatus.Staked,
    });

    for (const service of supplier.services) {
      const endpoints = service.endpoints.map((endpoint) => ({
        url: endpoint.url,
        rpcType: rPCTypeFromJSON(endpoint.rpc_type),
        configs: endpoint.configs.map((config) => ({
          key: configOptionsFromJSON(config.key),
          value: config.value,
        })),
      }));

      const revShare = service.rev_share.map((revShare) => ({
        address: revShare.address,
        revSharePercentage: revShare.rev_share_percentage,
      }));

      servicesAndSupplierMsgStakes.push({
        id: getMsgStakeServiceId(msgId, service.service_id),
        stakeMsgId: msgId,
        serviceId: service.service_id,
        endpoints,
        revShare,
      });

      supplierServices.push({
        id: getStakeServiceId(supplier.operator_address, service.service_id),
        supplierId: supplier.operator_address,
        serviceId: service.service_id,
        endpoints,
        revShare,
      });
    }
  }

  await Promise.all([
    store.bulkCreate("Supplier", suppliers),
    store.bulkCreate("MsgStakeSupplier", supplierMsgStakes),
    store.bulkCreate("SupplierServiceConfig", supplierServices),
    store.bulkCreate("MsgStakeSupplierService", servicesAndSupplierMsgStakes),
    store.bulkCreate("Transaction", transactions),
  ]);
}

async function _handleGenesisApplications(genesis: Genesis, block: CosmosBlock): Promise<void> {
  const applications: Array<ApplicationProps> = [];
  const appMsgStakes: Array<MsgStakeApplicationProps> = [];
  const appServices: Array<ApplicationServiceProps> = [];
  const servicesAndAppMsgStakes: Array<MsgStakeApplicationServiceProps> = [];
  const msgDelegateToGateways: Array<MsgDelegateToGatewayProps> = [];
  const transactions: Array<TransactionProps> = [];
  const appsDelegatedToGateways: Array<ApplicationGatewayProps> = [];

  for (let i = 0; i < genesis.app_state.application.applicationList.length; i++) {
    const app = genesis.app_state.application.applicationList[i];
    const msgId = `genesis-${app.address}`;
    const transactionHash = getGenesisFakeTxHash("app", i);

    transactions.push({
      id: transactionHash,
      blockId: block.block.id,
      gasUsed: BigInt(0),
      gasWanted: BigInt(0),
      fees: [],
      status: TxStatus.Success,
    });

    if (app.delegatee_gateway_addresses.length > 0) {
      for (const gatewayAddress of app.delegatee_gateway_addresses) {
        const msgId = `genesis-${gatewayAddress}`;
        msgDelegateToGateways.push({
          id: msgId,
          applicationId: app.address,
          gatewayId: gatewayAddress,
          blockId: block.block.id,
          transactionId: transactionHash,
          messageId: msgId,
        });

        appsDelegatedToGateways.push({
          id: getAppDelegatedToGatewayId(app.address, gatewayAddress),
          applicationId: app.address,
          gatewayId: gatewayAddress,
        });
      }
    }

    appMsgStakes.push({
      id: msgId,
      stakeAmount: BigInt(app.stake.amount),
      stakeDenom: app.stake.denom,
      blockId: block.block.id,
      applicationId: app.address,
      transactionId: transactionHash,
      messageId: msgId,
    });

    applications.push({
      id: app.address,
      accountId: app.address,
      stakeAmount: BigInt(app.stake.amount),
      stakeDenom: app.stake.denom,
      stakeStatus: StakeStatus.Staked,
    });

    for (const service of app.service_configs) {
      servicesAndAppMsgStakes.push({
        id: getMsgStakeServiceId(msgId, service.service_id),
        stakeMsgId: msgId,
        serviceId: service.service_id,
      });

      appServices.push({
        id: getStakeServiceId(app.address, service.service_id),
        applicationId: app.address,
        serviceId: service.service_id,
      });
    }
  }

  const promises: Array<Promise<void>> = [
    store.bulkCreate("MsgStakeApplication", appMsgStakes),
    store.bulkCreate("Application", applications),
    store.bulkCreate("Transaction", transactions),
    store.bulkCreate("ApplicationService", appServices),
    store.bulkCreate("MsgStakeApplicationService", servicesAndAppMsgStakes),
    store.bulkCreate("ApplicationGateway", appsDelegatedToGateways),
  ];

  if (msgDelegateToGateways.length > 0) {
    promises.push(store.bulkCreate("MsgDelegateToGateway", msgDelegateToGateways));
  }

  await Promise.all(promises);
}

async function _handleGenesisGateways(genesis: Genesis, block: CosmosBlock): Promise<void> {
  const gateways: Array<GatewayProps> = [];
  const gatewayMsgStakes: Array<MsgStakeGatewayProps> = [];
  const transactions: Array<TransactionProps> = [];

  for (let i = 0; i < genesis.app_state.gateway.gatewayList.length; i++) {
    const gateway = genesis.app_state.gateway.gatewayList[i];
    const msgId = `genesis-${gateway.address}`;
    const transactionHash = getGenesisFakeTxHash("gateway", i);

    transactions.push({
      id: transactionHash,
      blockId: block.block.id,
      gasUsed: BigInt(0),
      gasWanted: BigInt(0),
      fees: [],
      status: TxStatus.Success,
    });

    gatewayMsgStakes.push({
      id: msgId,
      stakeAmount: BigInt(gateway.stake.amount),
      stakeDenom: gateway.stake.denom,
      blockId: block.block.id,
      gatewayId: gateway.address,
      transactionId: transactionHash,
      messageId: msgId,
    });

    gateways.push({
      id: gateway.address,
      accountId: gateway.address,
      stakeAmount: BigInt(gateway.stake.amount),
      stakeDenom: gateway.stake.denom,
      stakeStatus: StakeStatus.Staked,
    });
  }

  await Promise.all([
    store.bulkCreate("Gateway", gateways),
    store.bulkCreate("MsgStakeGateway", gatewayMsgStakes),
    store.bulkCreate("Transaction", transactions),
  ]);
}

async function saveParams(entityName: string, params: Record<string, unknown> | undefined, block: CosmosBlock): Promise<void> {
  const paramsEntries = Object.entries(params || {});

  if (!paramsEntries.length) {
    return;
  }

  const paramsToSave: Array<AppParamProps> = paramsEntries.map(([key, value]) => ({
    id: getParamId(key, block.block.id),
    key,
    // just using stringify for objects because if a string is passed in, it will put it in quotes
    value: typeof value === "object" ? stringify(value) : (value || "").toString(),
    blockId: block.block.id,
  }));

  await store.bulkCreate(entityName, paramsToSave);
}

async function _handleGenesisParams(
  genesis: Genesis,
  block: CosmosBlock,
): Promise<void> {
  await Promise.all([
    saveParams("AppParam", genesis.app_state.application?.params, block),
    saveParams("AuthParam", genesis.app_state.auth?.params, block),
    saveParams("BankParam", genesis.app_state.bank?.params, block),
    saveParams("DistributionParam", genesis.app_state.distribution?.params, block),
    saveParams("GatewayParam", genesis.app_state.gateway?.params, block),
    saveParams("GovParam", genesis.app_state.gov?.params, block),
    saveParams("MintParam", genesis.app_state.mint?.params, block),
    saveParams("ProofParam", genesis.app_state.proof?.params, block),
    saveParams("ServiceParam", genesis.app_state.service?.params, block),
    saveParams("SessionParam", genesis.app_state.session?.params, block),
    saveParams("SharedParam", genesis.app_state.shared?.params, block),
    saveParams("SlashingParam", genesis.app_state.slashing?.params, block),
    saveParams("StakingParam", genesis.app_state.staking?.params, block),
    saveParams("SupplierParam", genesis.app_state.supplier?.params, block),
    saveParams("TokenomicsParam", genesis.app_state.tokenomics?.params, block),
    saveParams("ConsensusParam", genesis.app_state.consensus?.params, block),
  ]);
}

async function _handleGenesisSupplyDenom(genesis: Genesis): Promise<void> {
  return store.bulkCreate("SupplyDenom", genesis.app_state.bank.supply.map(supply => {
    return {
      id: supply.denom,
    };
  }));
}

async function _handleGenesisSupply(genesis: Genesis, block: CosmosBlock): Promise<void> {
  return store.bulkCreate("Supply", genesis.app_state.bank.supply.map(supply => getSupplyRecord(supply, block)));
}
