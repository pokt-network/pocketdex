import fs from "fs/promises";
import path from "path";
import { fromBase64 } from "@cosmjs/encoding";
import { CosmosBlock } from "@subql/types-cosmos";
import {
  get,
  isNil,
} from "lodash";
import fetch from "node-fetch";
import {
  Event,
  EventKind,
  GenesisFile as GenesisEntity,
  StakeStatus,
  TxStatus,
} from "../../types";
import type { AccountProps } from "../../types/models/Account";
import type { ApplicationProps } from "../../types/models/Application";
import { ApplicationGatewayProps } from "../../types/models/ApplicationGateway";
import type { ApplicationServiceProps } from "../../types/models/ApplicationService";
import { AuthzProps } from "../../types/models/Authz";
import type { BalanceProps } from "../../types/models/Balance";
import type { GatewayProps } from "../../types/models/Gateway";
import type { GenesisBalanceProps } from "../../types/models/GenesisBalance";
import { MessageProps } from "../../types/models/Message";
import { MsgAddServiceProps } from "../../types/models/MsgAddService";
import { MsgCreateValidatorProps } from "../../types/models/MsgCreateValidator";
import { MsgDelegateToGatewayProps } from "../../types/models/MsgDelegateToGateway";
import { MsgStakeApplicationProps } from "../../types/models/MsgStakeApplication";
import { MsgStakeApplicationServiceProps } from "../../types/models/MsgStakeApplicationService";
import { MsgStakeGatewayProps } from "../../types/models/MsgStakeGateway";
import { MsgStakeSupplierProps } from "../../types/models/MsgStakeSupplier";
import { MsgStakeSupplierServiceProps } from "../../types/models/MsgStakeSupplierService";
import type { NativeBalanceChangeProps } from "../../types/models/NativeBalanceChange";
import type { ParamProps } from "../../types/models/Param";
import type { ServiceProps } from "../../types/models/Service";
import type { SupplierProps } from "../../types/models/Supplier";
import { SupplierServiceConfigProps } from "../../types/models/SupplierServiceConfig";
import type { TransactionProps } from "../../types/models/Transaction";
import { ValidatorProps } from "../../types/models/Validator";
import { MsgStakeApplication as MsgStakeApplicationType } from "../../types/proto-interfaces/pocket/application/tx";
import { MsgStakeGateway as MsgStakeGatewayType } from "../../types/proto-interfaces/pocket/gateway/tx";
import { MsgAddService as MsgAddServiceType } from "../../types/proto-interfaces/pocket/service/tx";
import {
  configOptionsFromJSON,
  rPCTypeFromJSON,
} from "../../types/proto-interfaces/pocket/shared/service";
import { MsgStakeSupplier as MsgStakeSupplierType } from "../../types/proto-interfaces/pocket/supplier/tx";
import {
  EnforceAccountExistenceParams,
  enforceAccountsExists,
  getModuleAccountProps,
  getSupplyRecord,
  queryModuleAccounts,
} from "../bank";
import {
  PREFIX,
  VALIDATOR_PREFIX,
} from "../constants";
import {
  Genesis,
  GenesisTransaction,
} from "../types/genesis";
import { optimizedBulkCreate } from "../utils/db";
import {
  getAppDelegatedToGatewayId,
  getBalanceId,
  getBlockId,
  getGenesisFakeTxHash,
  getMsgStakeServiceId,
  getParamId,
  getStakeServiceId,
} from "../utils/ids";
import {
  sanitize,
  stringify,
} from "../utils/json";
import {
  Ed25519,
  pubKeyToAddress,
  Secp256k1,
} from "../utils/pub_key";

let genesisFile: Genesis | null = null;

export async function loadGenesisFile(): Promise<Genesis> {
  if (!isNil(genesisFile)) {
    return genesisFile; // Return a cached value if already loaded
  }

  const genesisSource = process.env.POCKETDEX_GENESIS || null;

  if (!genesisSource) {
    throw new Error("Environment variable POCKETDEX_GENESIS is not defined.");
  }

  // Check if the provided source is a URL
  const isUrl = /^https?:\/\//i.test(genesisSource);

  if (isUrl) {
    // If it's a URL, use fetch to load the data
    try {
      const response = await fetch(genesisSource);

      if (!response.ok) {
        // noinspection ExceptionCaughtLocallyJS
        throw new Error(`Failed to fetch from URL: ${genesisSource}. Status: ${response.status} ${response.statusText}`);
      }

      const json = await response.json();
      genesisFile = json as Genesis; // Cache the result to avoid reloading
      return json as Genesis;
    } catch (error) {
      // Handle errors strictly for TypeScript compatibility
      if (error instanceof Error) {
        throw new Error(`Failed to load genesis JSON from URL: ${error.message}`);
      } else {
        throw new Error("An unknown error occurred while loading from the URL.");
      }
    }
  } else {
    // If not a URL, validate if it's a valid file path
    try {
      const resolvedPath = path.isAbsolute(genesisSource)
        ? genesisSource // Use as-is if already an absolute path
        : path.resolve(process.cwd(), genesisSource); // Resolve to absolute if relative

      // Check if the file exists using fs.stat (validates a proper file path)
      const fileExists = await fs.stat(resolvedPath).then(() => true).catch(() => false);

      if (!fileExists) {
        // noinspection ExceptionCaughtLocallyJS
        throw new Error(`File not found or invalid path: ${resolvedPath}`);
      }

      // Read the file contents and parse as JSON
      const fileContents = await fs.readFile(resolvedPath, "utf-8");
      const json = JSON.parse(fileContents); // Parse the JSON from the file
      genesisFile = json as Genesis; // Cache the result
      return json;
    } catch (error) {
      if (error instanceof SyntaxError) {
        // Handle JSON parsing errors specifically
        throw new Error(`Invalid JSON in the file: ${error.message}`);
      } else if (error instanceof Error) {
        // Handle other errors (e.g., file not found or access issues)
        throw new Error(`Failed to load genesis JSON from file: ${error.message}`);
      } else {
        throw new Error("An unknown error occurred while loading from the file.");
      }
    }
  }
}


// handleGenesis, referenced in project.ts, handle genesis file and all the base entities of the network derived from it
export async function handleGenesis(block: CosmosBlock): Promise<void> {
  const genesis: Genesis = await loadGenesisFile();

  // IMPORTANT: Return early if this is not the genesis initial height as this is called for block indexed!
  if (block.block.header.height !== genesis.initial_height) {
    return;
  }

  logger.info(`[handleGenesis] (block.header.height): indexing genesis block ${block.block.header.height}`);

  // save records
  await Promise.all([
    _handleModuleAccounts(block),
    _handleAuthz(genesis, block),
    _handleGenesisSupplyDenom(genesis),
    _handleGenesisSupply(genesis, block),
    _handleGenesisEvent(block),
    _handleGenesisServices(genesis, block),
    _handleGenesisBalances(genesis, block),
    _handleGenesisGateways(genesis, block),
    _handleGenesisSuppliers(genesis, block),
    _handleGenesisApplications(genesis, block),
    _handleGenesisParams(genesis, block),
    _handleGenesisGenTxs(genesis, block),
  ]);

  await GenesisEntity.create({
    id: block.block.header.height.toString(),
    raw: JSON.stringify(genesis),
  }).save();
}

async function _handleModuleAccounts(block: CosmosBlock): Promise<void> {
  const moduleAccounts = await queryModuleAccounts();

  const accounts: Array<EnforceAccountExistenceParams> = [];
  // const mAccounts: Array<ModuleAccountProps> = [];
  const nativeBalanceChanges: Array<NativeBalanceChangeProps> = [];
  const genesisBalances: Array<GenesisBalanceProps> = [];
  const balances: Array<BalanceProps> = [];

  moduleAccounts.forEach(mAccount => {
    const address = mAccount.baseAccount?.address as string;
    accounts.push({
      account: {
        id: address,
        chainId: block.header.chainId,
        moduleId: mAccount.baseAccount?.address,
      },
      module: getModuleAccountProps(mAccount),
    });

    for (const { amount, denom } of mAccount.balances) {
      const id = getBalanceId(address, denom);

      nativeBalanceChanges.push({
        id,
        balanceOffset: BigInt(amount),
        denom,
        accountId: address,
        eventId: "genesis",
        blockId: getBlockId(block),
      });

      genesisBalances.push({
        id,
        amount: BigInt(amount),
        denom,
        accountId: address,
      });

      balances.push({
        id,
        amount: BigInt(amount),
        denom,
        accountId: address,
        lastUpdatedBlockId: getBlockId(block),
      });
    }
  });

  await Promise.all([
    enforceAccountsExists(accounts),
    optimizedBulkCreate("GenesisBalance", genesisBalances),
    optimizedBulkCreate("NativeBalanceChange", nativeBalanceChanges),
    store.bulkCreate("Balance", balances),
  ]);
}

async function _handleAuthz(genesis: Genesis, block: CosmosBlock): Promise<void> {
  const accounts: Set<string> = new Set();
  const authz: Array<AuthzProps> = [];

  for (const authorization of genesis.app_state.authz.authorization) {
    accounts.add(authorization.granter);
    accounts.add(authorization.grantee);

    const auth = authorization.authorization as unknown as Record<string, string>;

    authz.push({
      id: `${authorization.granter}:${auth.msg.replace("/", "") as string}-${authorization.grantee}`,
      granterId: authorization.granter,
      granteeId: authorization.grantee,
      expiration: authorization.expiration ? new Date(authorization.expiration) : undefined,
      msg: auth.msg,
      type: auth["@type"],
      eventId: "genesis",
      blockId: getBlockId(block),
    });
  }

  await Promise.all([
    enforceAccountsExists(Array.from(accounts.values()).map(address => ({
      account: {
        id: address,
        chainId: block.block.header.chainId,
      },
    }))),
    // This is a sensitive actor, so I (@jorgecuesta) prefer to keep using subql historical
    store.bulkCreate("Authz", authz),
  ]);
}

// Creates an event for the entities that requires it. Doing this, we are still requiring the events in the schema.
async function _handleGenesisEvent(block: CosmosBlock): Promise<void> {
  await Event.create({
    id: "genesis",
    idx: 0,
    type: "genesis",
    attributes: [],
    blockId: getBlockId(block),
    kind: EventKind.Genesis,
  }).save();
}

async function _handleGenesisBalances(genesis: Genesis, block: CosmosBlock): Promise<void> {
  const accounts: Set<string> = new Set();

  for (const account of genesis.app_state.auth.accounts) {
    accounts.add(account.address);
  }

  const nativeBalanceChanges: Array<NativeBalanceChangeProps> = [];
  const genesisBalances: Array<GenesisBalanceProps> = [];
  const balances: Array<BalanceProps> = [];

  for (const balance of genesis.app_state.bank.balances) {
    accounts.add(balance.address);
    for (const { amount, denom } of balance.coins) {
      const id = getBalanceId(balance.address, denom);

      nativeBalanceChanges.push({
        id,
        balanceOffset: BigInt(amount),
        denom,
        accountId: balance.address,
        eventId: "genesis",
        blockId: getBlockId(block),
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
        lastUpdatedBlockId: getBlockId(block),
      });
    }
  }
  await Promise.all([
    enforceAccountsExists(
      Array.from(accounts.values()).map(address => ({
        account: {
          id: address,
          chainId: block.block.header.chainId,
        },
      })),
    ),
    optimizedBulkCreate("GenesisBalance", genesisBalances),
    optimizedBulkCreate("NativeBalanceChange", nativeBalanceChanges),
    store.bulkCreate("Balance", balances),
  ]);
}

async function _handleGenesisServices(genesis: Genesis, block: CosmosBlock): Promise<void> {
  const services: Array<ServiceProps> = [],
    addServiceMsgs: Array<MsgAddServiceProps> = [],
    msgs: Array<MessageProps> = [],
    transactions: Array<TransactionProps> = [];

  for (const service of genesis.app_state.service.serviceList) {
    services.push({
      id: service.id,
      name: service.name,
      computeUnitsPerRelay: BigInt(service.compute_units_per_relay),
      ownerId: service.owner_address,
    });

    const msgId = `genesis-${service.id}`;
    const transactionHash = getGenesisFakeTxHash("service", 0);

    addServiceMsgs.push({
      id: msgId,
      serviceId: service.id,
      name: service.name,
      computeUnitsPerRelay: BigInt(service.compute_units_per_relay),
      ownerId: service.owner_address,
      blockId: getBlockId(block),
      transactionId: getGenesisFakeTxHash("service", 0),
      messageId: msgId,
    });

    transactions.push({
      id: transactionHash,
      idx: 0,
      blockId: getBlockId(block),
      gasUsed: BigInt(0),
      gasWanted: BigInt(0),
      fees: [{ denom: "upokt", amount: "0" }],
      codespace: "",
      memo: "",
      log: "",
      status: TxStatus.Success,
      code: 0,
    });

    // used to create correctly the content of the message
    const msgAddService: MsgAddServiceType = {
      ownerAddress: service.owner_address,
      service: {
        id: service.id,
        name: service.name,
        computeUnitsPerRelay: BigInt(service.compute_units_per_relay),
        ownerAddress: service.owner_address,
      },
    };

    msgs.push({
      id: msgId,
      idx: 0,
      typeUrl: "/pocket.service.MsgAddService",
      json: stringify(msgAddService),
      blockId: getBlockId(block),
      transactionId: transactionHash,
    });
  }

  await Promise.all([
    store.bulkCreate("Service", services),
    optimizedBulkCreate("MsgAddService", addServiceMsgs),
    optimizedBulkCreate("Transaction", transactions),
    optimizedBulkCreate("Message", msgs),
  ]);
}

async function _handleGenesisSuppliers(genesis: Genesis, block: CosmosBlock): Promise<void> {
  const suppliers: Array<SupplierProps> = [];
  const supplierMsgStakes: Array<MsgStakeSupplierProps> = [];
  const supplierServices: Array<SupplierServiceConfigProps> = [];
  const servicesAndSupplierMsgStakes: Array<MsgStakeSupplierServiceProps> = [];
  const transactions: Array<TransactionProps> = [];
  const msgs: Array<MessageProps> = [];

  for (let i = 0; i < genesis.app_state.supplier.supplierList.length; i++) {
    const supplier = genesis.app_state.supplier.supplierList[i];
    const msgId = `genesis-${supplier.operator_address}`;
    const transactionHash = getGenesisFakeTxHash("supplier", i);

    transactions.push({
      id: transactionHash,
      idx: 0,
      blockId: getBlockId(block),
      gasUsed: BigInt(0),
      gasWanted: BigInt(0),
      status: TxStatus.Success,
      code: 0,
      fees: [{ denom: "upokt", amount: "0" }],
      codespace: "",
      memo: "",
      log: "",
      timeoutHeight: BigInt(0),
    });

    supplierMsgStakes.push({
      id: msgId,
      blockId: getBlockId(block),
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

    // used to create correctly the content of the message
    const msgStakeSupplier: MsgStakeSupplierType = {
      stake: {
        amount: supplier.stake.amount,
        denom: supplier.stake.denom,
      },
      ownerAddress: supplier.owner_address,
      operatorAddress: supplier.operator_address,
      signer: supplier.owner_address,
      services: supplier.services.map(service => ({
        serviceId: service.service_id,
        endpoints: service.endpoints.map(endpoint => ({
          url: endpoint.url,
          rpcType: rPCTypeFromJSON(endpoint.rpc_type),
          configs: endpoint.configs.map(config => ({
            key: configOptionsFromJSON(config.key),
            value: config.value,
          })),
        })),
        revShare: service.rev_share.map(revShare => ({
          address: revShare.address,
          revSharePercentage: revShare.rev_share_percentage,
        })),
      })),
    };

    msgs.push({
      id: msgId,
      idx: 0,
      typeUrl: "/pocket.supplier.MsgStakeSupplier",
      json: stringify(msgStakeSupplier),
      blockId: getBlockId(block),
      transactionId: transactionHash,
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
        revSharePercentage: revShare.rev_share_percentage.toString(),
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
    store.bulkCreate("SupplierServiceConfig", supplierServices),
    optimizedBulkCreate("MsgStakeSupplier", supplierMsgStakes),
    optimizedBulkCreate("MsgStakeSupplierService", servicesAndSupplierMsgStakes),
    optimizedBulkCreate("Transaction", transactions),
    optimizedBulkCreate("Message", msgs),
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
  const msgs: Array<MessageProps> = [];

  for (let i = 0; i < genesis.app_state.application.applicationList.length; i++) {
    const app = genesis.app_state.application.applicationList[i];
    const msgId = `genesis-${app.address}`;
    const transactionHash = getGenesisFakeTxHash("app", i);

    transactions.push({
      id: transactionHash,
      idx: 0,
      blockId: getBlockId(block),
      gasUsed: BigInt(0),
      gasWanted: BigInt(0),
      fees: [{ denom: "upokt", amount: "0" }],
      codespace: "",
      memo: "",
      log: "",
      status: TxStatus.Success,
      code: 0,
    });

    if (app.delegatee_gateway_addresses.length > 0) {
      for (const gatewayAddress of app.delegatee_gateway_addresses) {
        const msgId = `genesis-${gatewayAddress}`;
        msgDelegateToGateways.push({
          id: msgId,
          applicationId: app.address,
          gatewayId: gatewayAddress,
          blockId: getBlockId(block),
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
      blockId: getBlockId(block),
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

    // used to create correctly the content of the message
    const msgStakeApplication: MsgStakeApplicationType = {
      address: app.address,
      stake: {
        amount: app.stake.amount,
        denom: app.stake.denom,
      },
      services: app.service_configs.map(service => ({
        serviceId: service.service_id,
      })),
    };

    msgs.push({
      id: msgId,
      idx: 0,
      typeUrl: "/pocket.application.MsgStakeApplication",
      json: stringify(msgStakeApplication),
      blockId: getBlockId(block),
      transactionId: transactionHash,
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
    store.bulkCreate("Application", applications),
    store.bulkCreate("ApplicationService", appServices),
    store.bulkCreate("ApplicationGateway", appsDelegatedToGateways),
    optimizedBulkCreate("MsgStakeApplication", appMsgStakes),
    optimizedBulkCreate("Transaction", transactions),
    optimizedBulkCreate("MsgStakeApplicationService", servicesAndAppMsgStakes),
    optimizedBulkCreate("Message", msgs),
    optimizedBulkCreate("MsgDelegateToGateway", msgDelegateToGateways),
  ];

  await Promise.all(promises);
}

async function _handleGenesisGateways(genesis: Genesis, block: CosmosBlock): Promise<void> {
  const gateways: Array<GatewayProps> = [];
  const gatewayMsgStakes: Array<MsgStakeGatewayProps> = [];
  const transactions: Array<TransactionProps> = [];
  const msgs: Array<MessageProps> = [];

  for (let i = 0; i < genesis.app_state.gateway.gatewayList.length; i++) {
    const gateway = genesis.app_state.gateway.gatewayList[i];
    const msgId = `genesis-${gateway.address}`;
    const transactionHash = getGenesisFakeTxHash("gateway", i);

    transactions.push({
      id: transactionHash,
      idx: 0,
      blockId: getBlockId(block),
      gasUsed: BigInt(0),
      gasWanted: BigInt(0),
      fees: [{ denom: "upokt", amount: "0" }],
      codespace: "",
      memo: "",
      log: "",
      status: TxStatus.Success,
      code: 0,
    });

    gatewayMsgStakes.push({
      id: msgId,
      stakeAmount: BigInt(gateway.stake.amount),
      stakeDenom: gateway.stake.denom,
      blockId: getBlockId(block),
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

    // used to create correctly the content of the message
    const msgStakeGateway: MsgStakeGatewayType = {
      address: gateway.address,
      stake: {
        amount: gateway.stake.amount,
        denom: gateway.stake.denom,
      },
    };

    msgs.push({
      id: msgId,
      idx: 0,
      typeUrl: "/pocket.gateway.MsgStakeGateway",
      json: stringify(msgStakeGateway),
      blockId: getBlockId(block),
      transactionId: transactionHash,
    });
  }

  await Promise.all([
    store.bulkCreate("Gateway", gateways),
    optimizedBulkCreate("MsgStakeGateway", gatewayMsgStakes),
    optimizedBulkCreate("Transaction", transactions),
    optimizedBulkCreate("Message", msgs),
  ]);
}

function saveParams(namespace: string, params: Record<string, unknown> | undefined, block: CosmosBlock): Array<ParamProps> {
  const paramsEntries = Object.entries(params || {});

  if (!paramsEntries.length) {
    return [];
  }

  return paramsEntries.map(([key, value]) => ({
    id: getParamId(namespace, key, getBlockId(block)),
    // we handle the key as is, which is snake case, so on the AuthzExec handler they will transform to snake too.
    key,
    namespace,
    // just using stringify for objects because if a string is passed in, it will put it in quotes
    value: sanitize(value),
    blockId: getBlockId(block),
  }));
}

async function _handleGenesisParams(
  genesis: Genesis,
  block: CosmosBlock,
): Promise<void> {
  await store.bulkCreate("Param", [
    ...saveParams("application", genesis.app_state.application?.params, block),
    ...saveParams("auth", genesis.app_state.auth?.params, block),
    ...saveParams("bank", genesis.app_state.bank?.params, block),
    ...saveParams("distribution", genesis.app_state.distribution?.params, block),
    ...saveParams("gateway", genesis.app_state.gateway?.params, block),
    ...saveParams("gov", genesis.app_state.gov?.params, block),
    ...saveParams("mint", genesis.app_state.mint?.params, block),
    ...saveParams("proof", genesis.app_state.proof?.params, block),
    ...saveParams("service", genesis.app_state.service?.params, block),
    ...saveParams("session", genesis.app_state.session?.params, block),
    ...saveParams("shared", genesis.app_state.shared?.params, block),
    ...saveParams("slashing", genesis.app_state.slashing?.params, block),
    ...saveParams("staking", genesis.app_state.staking?.params, block),
    ...saveParams("supplier", genesis.app_state.supplier?.params, block),
    ...saveParams("tokenomics", genesis.app_state.tokenomics?.params, block),
    ...saveParams("consensus", genesis.app_state.consensus?.params, block),
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

// Handle genutil.gen_txs payloads
async function _handleGenesisGenTxs(genesis: Genesis, block: CosmosBlock): Promise<void> {
  const promises: Array<Promise<void>> = [];
  const transactions: Array<TransactionProps> = [];
  const typedMessages: Map<string, Array<MsgCreateValidatorProps>> = new Map<string, Array<MsgCreateValidatorProps>>();
  const validators: Array<ValidatorProps> = [];
  const messages: Array<MessageProps> = [];
  const accounts: Array<AccountProps> = [];

  // logger.debug(`[handleGenesisGenTxs] Looping over gen_txs Transactions: ${genesis.app_state.genutil.gen_txs.length}`);
  for (let i = 0; i < genesis.app_state.genutil.gen_txs.length; i++) {
    const genTx = genesis.app_state.genutil.gen_txs[i];
    // assume that the first message type is the type of the transaction
    const type = get(genTx, "body.messages[0].@type");

    if (isNil(type)) {
      throw new Error(`[handleGenesisGenTxs] Null/Undefined gen_t.body.messages[0].@type: ${type}`);
    }

    let txHash, signerAddress: string;

    switch (type) {
      case "/cosmos.staking.v1beta1.MsgCreateValidator":
        // eslint-disable-next-line no-case-declarations
        const validatorMsg = _handleMsgCreateValidator(genTx, i, block);

        txHash = validatorMsg.transactionId;
        signerAddress = validatorMsg.signerId;

        // ensure signer account exists
        accounts.push({ id: validatorMsg.signerId, chainId: block.header.chainId });
        accounts.push({ id: validatorMsg.signerPoktPrefixId, chainId: block.header.chainId });

        if (typedMessages.has(type)) {
          typedMessages.get(type)?.push(validatorMsg);
        } else {
          typedMessages.set(type, [validatorMsg]);
        }

        validators.push({
          id: validatorMsg.signerId,
          ed25519_id: validatorMsg.address,
          signerId: validatorMsg.signerId,
          signerPoktPrefixId: validatorMsg.signerPoktPrefixId,
          description: validatorMsg.description,
          commission: validatorMsg.commission,
          minSelfDelegation: validatorMsg.minSelfDelegation,
          stakeDenom: validatorMsg.stakeDenom,
          stakeAmount: validatorMsg.stakeAmount,
          stakeStatus: StakeStatus.Staked,
          transactionId: validatorMsg.transactionId,
          createMsgId: validatorMsg.id,
        });

        messages.push({
          id: validatorMsg.id,
          idx: 0,
          typeUrl: type,
          json: stringify(genTx.body.messages[0]),
          blockId: getBlockId(block),
          transactionId: validatorMsg.transactionId,
        });

        break;
      // NOTE: implement any other gen_tx once they are needed, right now we just have MsgCreateValidator.
      default:
        throw new Error(`[handleGenesisGenTxs] Unknown gen_txs type: ${type}`);
    }

    transactions.push({
      id: txHash,
      idx: 0,
      blockId: getBlockId(block),
      signerAddress,
      gasUsed: BigInt(0),
      gasWanted: BigInt(0),
      fees: [{ denom: "upokt", amount: "0" }],
      codespace: "",
      memo: "",
      log: "",
      status: TxStatus.Success,
      code: 0,
    });
  }

  // upsert accounts
  promises.push(enforceAccountsExists(accounts.map(account => ({ account }))));
  // create txs, validators & messages
  promises.push(store.bulkCreate("Validator", validators));
  promises.push(optimizedBulkCreate("Transaction", transactions));
  promises.push(optimizedBulkCreate("Message", messages));

  let entity: string;
  for (const [key, value] of typedMessages) {
    entity = key.split(".")?.at(-1) as string;
    promises.push(optimizedBulkCreate(entity, value));
  }

  await Promise.all(promises);

  return;
}

function _handleMsgCreateValidator(genTx: GenesisTransaction, index: number, block: CosmosBlock): MsgCreateValidatorProps {
  const txHash = getGenesisFakeTxHash("validator", index);
  const msg = genTx.body.messages[0];
  const signer = genTx.auth_info.signer_infos[0];
  const signerAddress = pubKeyToAddress(Secp256k1, fromBase64(signer.public_key.key), VALIDATOR_PREFIX);
  const poktSignerAddress = pubKeyToAddress(Secp256k1, fromBase64(signer.public_key.key), PREFIX);

  return {
    id: `genesis-gen-txs-${index}-0`,
    pubkey: {
      type: msg.pubkey["@type"],
      key: msg.pubkey.key,
    },
    address: pubKeyToAddress(Ed25519, fromBase64(msg.pubkey.key)),
    signerId: signerAddress,
    signerPoktPrefixId: poktSignerAddress,
    description: msg.description,
    commission: {
      rate: msg.commission.rate,
      maxRate: msg.commission.max_rate,
      maxChangeRate: msg.commission.max_change_rate,
    },
    minSelfDelegation: parseInt(msg.min_self_delegation, 10),
    stakeDenom: msg.value.denom,
    stakeAmount: BigInt(msg.value.amount),
    blockId: getBlockId(block),
    transactionId: txHash,
    messageId: `genesis-gen-txs-${index}-0`,
  };
}
