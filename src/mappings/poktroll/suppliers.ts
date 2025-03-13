import {
  CosmosEvent,
  CosmosMessage,
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
  SupplierUnbondingReason,
} from "../../types";
import { MsgStakeSupplierServiceProps } from "../../types/models/MsgStakeSupplierService";
import { SupplierServiceConfigProps } from "../../types/models/SupplierServiceConfig";
import { SupplierSDKType } from "../../types/proto-interfaces/poktroll/shared/supplier";
import {
  supplierUnbondingReasonFromJSON,
  SupplierUnbondingReasonSDKType,
} from "../../types/proto-interfaces/poktroll/supplier/event";
import {
  MsgStakeSupplier,
  MsgUnstakeSupplier,
} from "../../types/proto-interfaces/poktroll/supplier/tx";
import { optimizedBulkCreate } from "../utils/db";
import {
  getBlockId,
  getEventId,
  getMsgStakeServiceId,
  getStakeServiceId,
  messageId,
} from "../utils/ids";
import { fetchAllSupplierServiceConfigBySupplier } from "./pagination";

function getSupplierUnbondingReasonFromSDK(item: typeof SupplierUnbondingReasonSDKType | string | number): SupplierUnbondingReason {
  switch (item) {
    case 0:
    case SupplierUnbondingReasonSDKType.SUPPLIER_UNBONDING_REASON_UNSPECIFIED:
    case "SUPPLIER_UNBONDING_REASON_UNSPECIFIED":
      return SupplierUnbondingReason.UNSPECIFIED
    case 1:
    case SupplierUnbondingReasonSDKType.SUPPLIER_UNBONDING_REASON_VOLUNTARY:
    case "SUPPLIER_UNBONDING_REASON_VOLUNTARY":
      return SupplierUnbondingReason.VOLUNTARY
    case 2:
    case SupplierUnbondingReasonSDKType.SUPPLIER_UNBONDING_REASON_BELOW_MIN_STAKE:
    case "SUPPLIER_UNBONDING_REASON_BELOW_MIN_STAKE":
      return SupplierUnbondingReason.BELOW_MIN_STAKE
    default:
      throw new Error(`Unknown SupplierUnbondingReason=${item}`)
  }
}

async function _handleSupplierStakeMsg(msg: CosmosMessage<MsgStakeSupplier>) {
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
    optimizedBulkCreate("MsgStakeSupplierService", supplierMsgStakeServices),
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
  /*
  {
  "type":"poktroll.supplier.EventSupplierUnbondingBegin",
  "attributes":[
  {
  "key":"reason",
  "value":"\"SUPPLIER_UNBONDING_REASON_BELOW_MIN_STAKE\"",
  "index":true
  },
  {
  "key":"session_end_height",
  "value":"\"55060\"",
  "index":true
  },
  {
  "key":"supplier",
  "value":"{\"owner_address\":\"pokt1kfjlev8j9nml32rzln7nw6r9pynez30c5lpgx5\",\"operator_address\":\"pokt1kfjlev8j9nml32rzln7nw6r9pynez30c5lpgx5\",
  \"stake\":{\"denom\":\"upokt\",\"amount\":\"0\"},\"services\":[{\"service_id\":\"proto-anvil\",\
  "endpoints\":[{\"url\":\"https://beta-relayminer-4.us-nj.poktroll.com:443\",\"rpc_type\":\"JSON_RPC\",\
  "configs\":[]}],\"rev_share\":[{\"address\":\"pokt1kfjlev8j9nml32rzln7nw6r9pynez30c5lpgx5\",
  \"rev_share_percentage\":100}]},{\"service_id\":\"proto-static-ngx\",
  \"endpoints\":[{\"url\":\"https://beta-relayminer-4.us-nj.poktroll.com:443\",\"rpc_type\":\"JSON_RPC\",\"configs\":[]}],
  \"rev_share\":[{\"address\":\"pokt1kfjlev8j9nml32rzln7nw6r9pynez30c5lpgx5\",\"rev_share_percentage\":100}]}],\"unstake_session_end_height\":\"55060\",
  \"services_activation_heights_map\":{\"proto-anvil\":\"31851\",\"proto-static-ngx\":\"31851\"}}","index":true
  },
  {
  "key":"unbonding_end_height",
  "value":"\"55070\"","index":true
  },{"key":"mode","value":"EndBlock","index":true}]}
   */
  let unbondingHeight: bigint | null = null, sessionEndHeight: bigint | null = null, supplierSdk: SupplierSDKType | null = null, reason = 0;

  for (const attribute of event.event.attributes) {
    if (attribute.key === "supplier") {
      supplierSdk = JSON.parse(attribute.value as unknown as string);
      continue
    }

    const parsedValue = (attribute.value as string).replaceAll('"', '');

    if (attribute.key === "unbonding_end_height") {
      unbondingHeight = BigInt(parsedValue);
    }

    if (attribute.key === "session_end_height") {
      sessionEndHeight = BigInt(parsedValue);
    }

    if (attribute.key === "reason") {
      reason = supplierUnbondingReasonFromJSON(parsedValue);
    }
  }

  if (!supplierSdk) {
    throw new Error(`[handleSupplierUnbondingBeginEvent] supplier not provided in event`);
  }

  const operatorAddress = supplierSdk.operator_address;

  const supplier = await Supplier.get(operatorAddress);

  if (!supplier) {
    throw new Error(`[handleSupplierUnbondingBeginEvent] supplier not found for operator address ${operatorAddress}`);
  }

  if (!unbondingHeight) {
    // todo: we should do this -> throw new Error(`[handleSupplierUnbondingBeginEvent] unbonding_end_height not found`);
    //  but alpha has still events without this
    logger.error(`[handleSupplierUnbondingBeginEvent] unbonding_end_height not found`);
  } else {
    supplier.unstakingEndHeight = unbondingHeight
  }

  if (!reason) {
    // todo: we should do this -> throw new Error(`[handleSupplierUnbondingBeginEvent] reason not found in event`);
    //  but alpha has still events without this
    logger.error(`[handleSupplierUnbondingBeginEvent] reason not found in event`);
  } else {
    supplier.unstakingReason = getSupplierUnbondingReasonFromSDK(reason)
  }

  const eventId = getEventId(event);

  await Promise.all([
    supplier.save(),
    EventSupplierUnbondingBeginEntity.create({
      id: eventId,
      unbondingEndHeight: unbondingHeight || BigInt(0),
      sessionEndHeight: sessionEndHeight || BigInt(0),
      supplierId: operatorAddress,
      blockId: getBlockId(event.block),
      reason: reason ? getSupplierUnbondingReasonFromSDK(reason) : SupplierUnbondingReason.UNSPECIFIED,
      eventId,
    }).save(),
  ]);
}

async function _handleSupplierUnbondingEndEvent(
  event: CosmosEvent,
) {
  let unbondingHeight: bigint | null = null, sessionEndHeight: bigint | null = null, supplierSdk: SupplierSDKType | null = null, reason = 0;

  for (const attribute of event.event.attributes) {
    if (attribute.key === "supplier") {
      supplierSdk = JSON.parse(attribute.value as unknown as string);
      continue
    }

    const parsedValue = (attribute.value as string).replaceAll('"', '');

    if (attribute.key === "unbonding_end_height") {
      unbondingHeight = BigInt(parsedValue);
    }

    if (attribute.key === "session_end_height") {
      sessionEndHeight = BigInt(parsedValue);
    }

    if (attribute.key === "reason") {
      reason = supplierUnbondingReasonFromJSON(parsedValue);
    }
  }

  if (!supplierSdk) {
    throw new Error(`[handleSupplierUnbondingEndEvent] supplier not provided in event`);
  }

  const supplier = await Supplier.get(supplierSdk.operator_address);

  if (!supplier) {
    throw new Error(`[handleSupplierUnbondingEndEvent] supplier not found for operator address ${supplierSdk.operator_address}`);
  }

  if (!unbondingHeight) {
    // todo: we should do this -> throw new Error(`[handleSupplierUnbondingEndEvent] unbonding_end_height not found`);
    //  but alpha has still events without this
    logger.error(`[handleSupplierUnbondingEndEvent] unbonding_end_height not found`);
  } else {
    supplier.unstakingEndBlockId = BigInt((unbondingHeight as unknown as string).replaceAll("\"", ""));
  }

  if (!reason) {
    // todo: we should do this -> throw new Error(`[handleSupplierUnbondingBeginEvent] reason not found in event`);
    //  but alpha has still events without this
    logger.error(`[handleSupplierUnbondingEndEvent] reason not found in event`);
  } else {
    supplier.unstakingReason = getSupplierUnbondingReasonFromSDK(reason)
  }

  supplier.stakeStatus = StakeStatus.Unstaked;

  const supplierServices = (await fetchAllSupplierServiceConfigBySupplier(supplierSdk.operator_address) || []).map(item => item.id);

  const eventId = getEventId(event);

  await Promise.all([
    EventSupplierUnbondingEndEntity.create({
      id: eventId,
      unbondingEndHeight: unbondingHeight || BigInt(0),
      sessionEndHeight: sessionEndHeight || BigInt(0),
      reason: reason ? getSupplierUnbondingReasonFromSDK(reason) : SupplierUnbondingReason.UNSPECIFIED,
      blockId: getBlockId(event.block),
      supplierId: supplierSdk.operator_address,
      eventId,
    }).save(),
    supplier.save(),
    // todo: change this for an atomic operation
    store.bulkRemove("SupplierServiceConfig", supplierServices),
  ]);
}

export async function handleSupplierStakeMsg(
  messages: Array<CosmosMessage<MsgStakeSupplier>>,
): Promise<void> {
  await Promise.all(messages.map(_handleSupplierStakeMsg));
}

export async function handleUnstakeSupplierMsg(
  messages: Array<CosmosMessage<MsgUnstakeSupplier>>,
): Promise<void> {
  await Promise.all(messages.map(_handleUnstakeSupplierMsg));
}

export async function handleSupplierUnbondingBeginEvent(
  events: Array<CosmosEvent>,
): Promise<void> {
  await Promise.all(events.map(_handleSupplierUnbondingBeginEvent));
}

export async function handleSupplierUnbondingEndEvent(
  events: Array<CosmosEvent>,
): Promise<void> {
  await Promise.all(events.map(_handleSupplierUnbondingEndEvent));
}
