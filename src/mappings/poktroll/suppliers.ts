import {
  CosmosEvent,
  CosmosMessage,
  CosmosTransaction,
} from "@subql/types-cosmos";
import {
  EventSupplierUnbondingBegin as EventSupplierUnbondingBeginEntity,
  EventSupplierUnbondingEnd as EventSupplierUnbondingEndEntity,
  MsgStakeSupplier as MsgStakeSupplierEntity,
  MsgUnstakeSupplier as MsgUnstakeSupplierEntity,
  StakeStatus,
  Supplier,
  SupplierEndpoint,
  SupplierRevShare,
  SupplierServiceConfig,
} from "../../types";
import { MsgStakeSupplierServiceProps } from "../../types/models/MsgStakeSupplierService";
import { SupplierServiceConfigProps } from "../../types/models/SupplierServiceConfig";
import {
  MsgStakeSupplier,
  MsgUnstakeSupplier,
} from "../../types/proto-interfaces/poktroll/supplier/tx";
import {
  getBlockId,
  getEventId,
  getMsgStakeServiceId,
  getStakeServiceId,
  messageId,
} from "../utils/ids";
import { stringify } from "../utils/json";

async function _handleSupplierStakeMsg(msg: CosmosMessage<MsgStakeSupplier>) {
  // logger.debug(`[handleSupplierStakeMsg] (msg.msg): ${stringify(msg.msg, undefined, 2)}`);

  if (!msg.msg.decodedMsg.stake) {
    return logger.error(`[handleSupplierStakeMsg] stake not provided in msg`);
  }

  const msgId = messageId(msg);

  const supplierMsgStake = MsgStakeSupplierEntity.create({
    id: msgId,
    signerId: msg.msg.decodedMsg.signer,
    supplierId: msg.msg.decodedMsg.operatorAddress,
    ownerId: msg.msg.decodedMsg.ownerAddress,
    stakeAmount: BigInt(msg.msg.decodedMsg.stake.amount),
    stakeDenom: msg.msg.decodedMsg.stake.denom,
    blockId: getBlockId(msg.block),
    transactionId: msg.tx.hash,
    messageId: msgId,
  });

  const supplier = Supplier.create({
    id: msg.msg.decodedMsg.operatorAddress,
    operatorId: msg.msg.decodedMsg.operatorAddress,
    ownerId: msg.msg.decodedMsg.ownerAddress,
    stakeAmount: BigInt(msg.msg.decodedMsg.stake.amount),
    stakeDenom: msg.msg.decodedMsg.stake.denom,
    stakeStatus: StakeStatus.Staked,
  });

  const servicesId: Array<string> = [];
  // used to create the services that came in the stake message
  const supplierMsgStakeServices: Array<MsgStakeSupplierServiceProps> = [];
  // used to have the services that are currently configured for the supplier
  const newSupplierServices: Array<SupplierServiceConfigProps> = [];

  const operatorAddress = msg.msg.decodedMsg.operatorAddress;

  for (const { endpoints, revShare, serviceId } of msg.msg.decodedMsg.services) {
    servicesId.push(serviceId);

    const endpointsArr: Array<SupplierEndpoint> = endpoints.map((endpoint) => ({
      url: endpoint.url,
      rpcType: endpoint.rpcType,
      configs: endpoint.configs,
    }));

    const revShareArr: Array<SupplierRevShare> = revShare.map((revShare) => ({
      address: revShare.address,
      revSharePercentage: revShare.revSharePercentage,
    }));

    supplierMsgStakeServices.push({
      id: getMsgStakeServiceId(msgId, serviceId),
      serviceId,
      stakeMsgId: msgId,
      endpoints: endpointsArr,
      revShare: revShareArr,
    });

    newSupplierServices.push({
      id: getStakeServiceId(operatorAddress, serviceId),
      serviceId,
      supplierId: operatorAddress,
      endpoints: endpointsArr,
      revShare: revShareArr,
    });
  }

  const currentSupplierServices = await SupplierServiceConfig.getBySupplierId(operatorAddress, { limit: 100 });

  const servicesToRemove: Array<string> = [];

  if (currentSupplierServices && currentSupplierServices.length > 0) {
    for (const service of currentSupplierServices) {
      if (!servicesId.includes(service.serviceId)) {
        servicesToRemove.push(service.id);
      }
    }
  }

  const promises: Array<Promise<void>> = [
    supplierMsgStake.save(),
    supplier.save(),
    store.bulkCreate("MsgStakeSupplierService", supplierMsgStakeServices),
    store.bulkCreate("SupplierServiceConfig", newSupplierServices),
  ];

  if (servicesToRemove.length > 0) {
    promises.push(store.bulkRemove("SupplierServiceConfig", servicesToRemove));
  }

  await Promise.all(promises);
}

async function _handleUnstakeSupplierMsg(
  msg: CosmosMessage<MsgUnstakeSupplier>,
) {
  const supplier = await Supplier.get(msg.msg.decodedMsg.operatorAddress);

  if (!supplier) {
    throw new Error(`[handleUnstakeSupplierMsg] supplier not found for operator address ${msg.msg.decodedMsg.operatorAddress}`);
  }

  const msgId = messageId(msg);

  const msgUnstakeSupplier = MsgUnstakeSupplierEntity.create({
    id: msgId,
    signerId: msg.msg.decodedMsg.signer,
    supplierId: msg.msg.decodedMsg.operatorAddress,
    blockId: getBlockId(msg.block),
    transactionId: msg.tx.hash,
    messageId: msgId,
  });

  supplier.stakeStatus = StakeStatus.Unstaking;
  supplier.unstakingBeginBlockId = getBlockId(msg.block);

  await Promise.all([
    supplier.save(),
    msgUnstakeSupplier.save(),
  ]);
}

async function _handleSupplierUnbondingBeginEvent(
  event: CosmosEvent,
) {
  const msg = event.msg as CosmosMessage<MsgUnstakeSupplier>;
  const tx = event.tx as CosmosTransaction;
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  const unbondingBeginEvent = event.tx.tx.events.find(item => item.type === "poktroll.supplier.EventSupplierUnbondingBegin");

  if (!unbondingBeginEvent) {
    throw new Error(`[handleSupplierUnbondingEndEvent] unbondingBeginEvent not found`);
  }

  const unbondingHeight = unbondingBeginEvent.attributes.find(attribute => attribute.key === "unbonding_height")?.value;

  if (!unbondingHeight) {
    throw new Error(`[handleSupplierUnbondingEndEvent] unbondingHeight not found`);
  }

  const supplier = await Supplier.get(msg.msg.decodedMsg.operatorAddress);

  if (!supplier) {
    throw new Error(`[handleSupplierUnbondingBeginEvent] supplier not found for operator address ${msg.msg.decodedMsg.operatorAddress}`);
  }

  supplier.unstakingEndHeight = BigInt((unbondingHeight as unknown as string).replaceAll("\"", ""));

  const eventId = getEventId(event);

  await Promise.all([
    supplier.save(),
    EventSupplierUnbondingBeginEntity.create({
      id: eventId,
      supplierId: msg.msg.decodedMsg.operatorAddress,
      blockId: getBlockId(event.block),
      transactionId: tx.hash,
      eventId,
    }).save(),
  ]);
}

async function _handleSupplierUnbondingEndEvent(
  event: CosmosEvent,
) {
  logger.info(`[handleSupplierUnbondingEndEvent] (event.event): ${stringify(event.event, undefined, 2)}`);

  const supplierStringified = event.event.attributes.find(attribute => attribute.key === "supplier")?.value as unknown as string;

  if (!supplierStringified) {
    throw new Error(`[handleSupplierUnbondingEndEvent] supplier not provided in event`);
  }

  const supplierAddress = JSON.parse(supplierStringified).operator_address;

  if (!supplierAddress) {
    throw new Error(`[handleSupplierUnbondingEndEvent] operator_address not provided in supplier event`);
  }

  const supplier = await Supplier.get(supplierAddress);

  if (!supplier) {
    throw new Error(`[handleSupplierUnbondingEndEvent] supplier not found for operator address ${supplierAddress}`);
  }

  supplier.unstakingEndBlockId = getBlockId(event.block);
  supplier.stakeStatus = StakeStatus.Unstaked;
  // TODO: ADD A WAY TO LOAD MORE (PAGINATION)
  const supplierServices = (await SupplierServiceConfig.getBySupplierId(supplierAddress, { limit: 100 }) || []).map(item => item.id);

  const eventId = getEventId(event);

  await Promise.all([
    EventSupplierUnbondingEndEntity.create({
      id: eventId,
      supplierId: supplierAddress,
      blockId: getBlockId(event.block),
      eventId,
    }).save(),
    supplier.save(),
    store.bulkRemove("SupplierServiceConfig", supplierServices),
  ]);
}

// TODO: update this to work with BatchMessage handler
// handleSupplierStakeMsg, referenced in project.ts
export async function handleSupplierStakeMsg(
  msg: CosmosMessage<MsgStakeSupplier>,
): Promise<void> {
  await _handleSupplierStakeMsg(msg);
}

// TODO: update this to work with BatchMessage handler
// handleUnstakeSupplierMsg, referenced in project.ts
export async function handleUnstakeSupplierMsg(
  msg: CosmosMessage<MsgUnstakeSupplier>,
): Promise<void> {
  await _handleUnstakeSupplierMsg(msg);
}

// TODO: update this to work with BatchEvent handler
// handleSupplierUnbondingBeginEvent, referenced in project.ts
export async function handleSupplierUnbondingBeginEvent(
  event: CosmosEvent,
): Promise<void> {
  await _handleSupplierUnbondingBeginEvent(event);
}

// TODO: update this to work with BatchEvent handler
// handleSupplierUnbondingEndEvent, referenced in project.ts
export async function handleSupplierUnbondingEndEvent(
  event: CosmosEvent,
): Promise<void> {
  await _handleSupplierUnbondingEndEvent(event);
}
