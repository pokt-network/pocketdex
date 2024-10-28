import { CosmosEvent, CosmosMessage } from "@subql/types-cosmos";
import {
  StakeStatus,
  Supplier,
  SupplierMsgStake,
  SupplierMsgUnstake,
  SupplierService,
  SupplierUnbondingBeginEvent,
  SupplierUnbondingEndEvent,
} from "../../types";
import { SupplierMsgStakeServiceProps } from "../../types/models/SupplierMsgStakeService";
import { SupplierServiceProps } from "../../types/models/SupplierService";
import { MsgStakeSupplier, MsgUnstakeSupplier } from "../../types/proto-interfaces/poktroll/supplier/tx";
import {
  attemptHandling,
  getEventId,
  getMsgStakeServiceId,
  getStakeServiceId,
  messageId,
  stringify,
  unprocessedEventHandler,
  unprocessedMsgHandler,
} from "../utils";

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

  const msgId = messageId(msg)

  // TODO(@Alann27): this should be a BigInt? Should we use coin for stake or we should split amount and denom?
  const stakeCoin = {
    amount: msg.msg.decodedMsg.stake.amount,
    denom: msg.msg.decodedMsg.stake.denom,
  }

  const supplierMsgStake = SupplierMsgStake.create({
    id: msgId,
    signerId: msg.msg.decodedMsg.signer,
    supplierId: msg.msg.decodedMsg.operatorAddress,
    ownerId: msg.msg.decodedMsg.ownerAddress,
    stake: stakeCoin,
    blockId: msg.block.block.id,
    transactionId: msg.tx.hash,
  })

  const supplier = Supplier.create({
    id: msg.msg.decodedMsg.operatorAddress,
    operatorAccountId: msg.msg.decodedMsg.operatorAddress,
    ownerId: msg.msg.decodedMsg.ownerAddress,
    stake: stakeCoin,
    status: StakeStatus.Staked,
    unbondingHeight: undefined,
    unbondedAtBlockId: undefined,
    unbondingStartBlockId: undefined,
  })

  const servicesId: Array<string> = []
  const supplierMsgStakeServices: Array<SupplierMsgStakeServiceProps> = []
  const newSupplierServices: Array<SupplierServiceProps> = []

  const operatorAddress = msg.msg.decodedMsg.operatorAddress

  for (const {endpoints, revShare, serviceId} of msg.msg.decodedMsg.services) {
    servicesId.push(serviceId)

    const endpointsArr = endpoints.map((endpoint) => ({
      url: endpoint.url,
      rpcType: endpoint.rpcType,
      configs: endpoint.configs,
    }))

    const revShareArr = revShare.map((revShare) => ({
      address: revShare.address,
      revSharePercentage: revShare.revSharePercentage,
    }))

    supplierMsgStakeServices.push({
      id: getMsgStakeServiceId(msgId, serviceId),
      serviceId,
      supplierStakeMsgId: msgId,
      endpoints: endpointsArr,
      revShare: revShareArr
    })

    newSupplierServices.push({
      id: getStakeServiceId(operatorAddress, serviceId),
      serviceId,
      supplierId: operatorAddress,
      endpoints: endpointsArr,
      revShare: revShareArr
    })
  }

  const currentSupplierServices = await SupplierService.getBySupplierId(operatorAddress)

  const servicesToRemove: Array<string> = []

  if (currentSupplierServices && currentSupplierServices.length > 0) {
    for (const service of currentSupplierServices) {
      if (!servicesId.includes(service.serviceId)) {
        servicesToRemove.push(service.id)
      }
    }
  }

  const promises: Array<Promise<void>> = [
    supplierMsgStake.save(),
    supplier.save(),
    store.bulkCreate('SupplierMsgStakeService', supplierMsgStakeServices),
    store.bulkCreate('SupplierService', newSupplierServices),
  ]

  if (servicesToRemove.length > 0) {
    promises.push(store.bulkRemove('SupplierService', servicesToRemove))
  }

  await Promise.all(promises)
}

async function _handleUnstakeSupplierMsg(
  msg: CosmosMessage<MsgUnstakeSupplier>,
) {
  logger.info(`[handleUnstakeSupplierMsg] (msg.msg): ${stringify(msg.msg, undefined, 2)}`);
  const supplier = await Supplier.get(msg.msg.decodedMsg.operatorAddress)

  if (!supplier) {
    throw new Error(`[handleUnstakeSupplierMsg] supplier not found for operator address ${msg.msg.decodedMsg.operatorAddress}`)
  }

  const msgUnstakeSupplier = SupplierMsgUnstake.create({
    id: messageId(msg),
    signerId: msg.msg.decodedMsg.signer,
    supplierId: msg.msg.decodedMsg.operatorAddress,
    blockId: msg.block.block.id,
    transactionId: msg.tx.hash,
  })

  supplier.status = StakeStatus.Unstaking
  supplier.unbondingStartBlockId = msg.block.block.id

  await Promise.all([
    supplier.save(),
    msgUnstakeSupplier.save()
  ])
}

async function _handleSupplierUnbondingBeginEvent(
  event: CosmosEvent
) {
  logger.info(`[handleSupplierUnbondingBeginEvent] (event.event): ${stringify(event.event, undefined, 2)}`);

  const msg: CosmosMessage<MsgUnstakeSupplier> = event.msg;
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore
  const unbondingBeginEvent = event.tx.tx.events.find(item => item.type === "poktroll.supplier.EventSupplierUnbondingBegin")

  if (!unbondingBeginEvent) {
    throw new Error(`[handleSupplierUnbondingEndEvent] unbondingBeginEvent not found`);
  }

  const unbondingHeight = unbondingBeginEvent.attributes.find(attribute => attribute.key === "unbonding_height")?.value

  if (!unbondingHeight) {
    throw new Error(`[handleSupplierUnbondingEndEvent] unbondingHeight not found`);
  }

  const supplier = await Supplier.get(msg.msg.decodedMsg.operatorAddress);

  if (!supplier) {
    throw new Error(`[handleSupplierUnbondingBeginEvent] supplier not found for operator address ${msg.msg.decodedMsg.operatorAddress}`)
  }

  supplier.unbondingHeight = BigInt((unbondingHeight as unknown as string).replaceAll('"', ""))

  await Promise.all([
    supplier.save(),
    SupplierUnbondingBeginEvent.create({
      id: getEventId(event),
      supplierId: msg.msg.decodedMsg.operatorAddress,
      blockId: event.block.block.id,
      transactionId: event.tx.hash
    }).save(),
  ])
}

async function _handleSupplierUnbondingEndEvent(
  event: CosmosEvent
) {
  logger.info(`[handleSupplierUnbondingEndEvent] (event.event): ${stringify(event.event, undefined, 2)}`);

  const supplierStringified = event.event.attributes.find(attribute => attribute.key === "supplier")?.value as unknown as string

  if (!supplierStringified) {
    throw new Error(`[handleSupplierUnbondingEndEvent] supplier not provided in event`);
  }

  const supplierAddress = JSON.parse(supplierStringified).operator_address

  if (!supplierAddress) {
    throw new Error(`[handleSupplierUnbondingEndEvent] operator_address not provided in supplier event`);
  }

  const supplier = await Supplier.get(supplierAddress);

  if (!supplier) {
    throw new Error(`[handleSupplierUnbondingEndEvent] supplier not found for operator address ${supplierAddress}`)
  }

  supplier.unbondedAtBlockId = event.block.block.id
  supplier.status = StakeStatus.Unstaked

  const supplierServices = (await SupplierService.getBySupplierId(supplierAddress) || []).map(item => item.id)

  await Promise.all([
    SupplierUnbondingEndEvent.create({
      id: getEventId(event),
      supplierId: supplierAddress,
      blockId: event.block.block.id,
    }).save(),
    supplier.save(),
    store.bulkRemove('SupplierService', supplierServices),
  ])
}
