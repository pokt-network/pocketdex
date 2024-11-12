import {
  CosmosEvent,
  CosmosMessage,
} from "@subql/types-cosmos";
import {
  EventSupplierUnbondingBegin as EventSupplierUnbondingBeginEntity,
  EventSupplierUnbondingEnd as EventSupplierUnbondingEndEntity,
  MsgStakeSupplier as MsgStakeSupplierEntity,
  MsgUnstakeSupplier as MsgUnstakeSupplierEntity,
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
import { StakeStatus } from "../constants";
import {
  attemptHandling,
  unprocessedEventHandler,
  unprocessedMsgHandler,
} from "../utils/handlers";
import {
  getEventId,
  getMsgStakeServiceId,
  getStakeServiceId,
  messageId,
} from "../utils/ids";
import { stringify } from "../utils/json";

export async function handleSupplierStakeMsg(
  msg: CosmosMessage<MsgStakeSupplier>,
): Promise<void> {
  await attemptHandling(msg, _handleSupplierStakeMsg, unprocessedMsgHandler);
}

export async function handleUnstakeSupplierMsg(
  msg: CosmosMessage<MsgUnstakeSupplier>,
): Promise<void> {
  await attemptHandling(msg, _handleUnstakeSupplierMsg, unprocessedMsgHandler);
}

export async function handleSupplierUnbondingBeginEvent(
  event: CosmosEvent,
): Promise<void> {
  await attemptHandling(event, _handleSupplierUnbondingBeginEvent, unprocessedEventHandler);
}

export async function handleSupplierUnbondingEndEvent(
  event: CosmosEvent,
): Promise<void> {
  await attemptHandling(event, _handleSupplierUnbondingEndEvent, unprocessedEventHandler);
}

async function _handleSupplierStakeMsg(msg: CosmosMessage<MsgStakeSupplier>) {
  logger.debug(`[handleSupplierStakeMsg] (msg.msg): ${stringify(msg.msg, undefined, 2)}`);

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
    blockId: msg.block.block.id,
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

  const currentSupplierServices = await SupplierServiceConfig.getBySupplierId(operatorAddress, {});

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
  logger.info(`[handleUnstakeSupplierMsg] (msg.msg): ${stringify(msg.msg, undefined, 2)}`);
  const supplier = await Supplier.get(msg.msg.decodedMsg.operatorAddress);

  if (!supplier) {
    throw new Error(`[handleUnstakeSupplierMsg] supplier not found for operator address ${msg.msg.decodedMsg.operatorAddress}`);
  }

  const msgId = messageId(msg);

  const msgUnstakeSupplier = MsgUnstakeSupplierEntity.create({
    id: msgId,
    signerId: msg.msg.decodedMsg.signer,
    supplierId: msg.msg.decodedMsg.operatorAddress,
    blockId: msg.block.block.id,
    transactionId: msg.tx.hash,
    messageId: msgId,
  });

  supplier.stakeStatus = StakeStatus.Unstaking;
  supplier.unstakingBeginBlockId = msg.block.block.id;

  await Promise.all([
    supplier.save(),
    msgUnstakeSupplier.save(),
  ]);
}

async function _handleSupplierUnbondingBeginEvent(
  event: CosmosEvent,
) {
  logger.info(`[handleSupplierUnbondingBeginEvent] (event.event): ${stringify(event.event, undefined, 2)}`);

  const msg: CosmosMessage<MsgUnstakeSupplier> = event.msg;
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
      blockId: event.block.block.id,
      transactionId: event.tx.hash,
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

  supplier.unstakingEndBlockId = event.block.block.id;
  supplier.stakeStatus = StakeStatus.Unstaked;

  const supplierServices = (await SupplierServiceConfig.getBySupplierId(supplierAddress, {}) || []).map(item => item.id);

  const eventId = getEventId(event);

  await Promise.all([
    EventSupplierUnbondingEndEntity.create({
      id: eventId,
      supplierId: supplierAddress,
      blockId: event.block.block.id,
      eventId,
    }).save(),
    supplier.save(),
    store.bulkRemove("SupplierServiceConfig", supplierServices),
  ]);
}
