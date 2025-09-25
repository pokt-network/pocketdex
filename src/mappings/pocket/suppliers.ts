import { toHex } from "@cosmjs/encoding";
import {
  CosmosEvent,
  CosmosMessage,
} from "@subql/types-cosmos";
import { Coin } from "../../client/cosmos/base/v1beta1/coin";
import {
  EventSupplierServiceConfigActivated,
  EventSupplierUnbondingBegin as EventSupplierUnbondingBeginEntity,
  EventSupplierUnbondingEnd as EventSupplierUnbondingEndEntity,
  MorseSupplierClaimSignerType,
  MsgClaimMorseSupplier as MsgClaimMorseSupplierEntity,
  MsgStakeSupplier as MsgStakeSupplierEntity,
  MsgUnstakeSupplier as MsgUnstakeSupplierEntity,
  StakeStatus,
  Supplier,
  SupplierEndpoint,
  SupplierRevShare,
  SupplierServiceConfig,
  SupplierUnbondingReason,
} from "../../types";
import { MsgClaimMorseSupplierProps } from "../../types/models/MsgClaimMorseSupplier";
import { MsgStakeSupplierServiceProps } from "../../types/models/MsgStakeSupplierService";
import { SupplierServiceConfigProps } from "../../types/models/SupplierServiceConfig";
import { CoinSDKType } from "../../types/proto-interfaces/cosmos/base/v1beta1/coin";
import { MorseSupplierClaimSignerTypeSDKType } from "../../types/proto-interfaces/pocket/migration/morse_onchain";
import { MsgClaimMorseSupplier } from "../../types/proto-interfaces/pocket/migration/tx";
import { SupplierServiceConfig as SupplierServiceConfigType } from "../../types/proto-interfaces/pocket/shared/service";
import { SupplierSDKType } from "../../types/proto-interfaces/pocket/shared/supplier";
import {
  supplierUnbondingReasonFromJSON,
  SupplierUnbondingReasonSDKType,
} from "../../types/proto-interfaces/pocket/supplier/event";
import {
  MsgStakeSupplier,
  MsgUnstakeSupplier,
} from "../../types/proto-interfaces/pocket/supplier/tx";
import { optimizedBulkCreate } from "../utils/db";
import {
  getBlockId,
  getEventId,
  getMsgStakeServiceId,
  getStakeServiceId,
  messageId,
} from "../utils/ids";
import { getDenomAndAmount } from "../utils/primitives";
import {
  Ed25519,
  pubKeyToAddress,
} from "../utils/pub_key";
import { updateMorseClaimableAccounts } from "./migration";
import { fetchAllSupplierServiceConfigBySupplier } from "./pagination";

function getMorseSupplierClaimSignerType(item: typeof MorseSupplierClaimSignerTypeSDKType | string | number): MorseSupplierClaimSignerType {
  switch (item) {
    case 0:
    case "MORSE_SUPPLIER_CLAIM_SIGNER_TYPE_UNSPECIFIED":
    case MorseSupplierClaimSignerTypeSDKType.MORSE_SUPPLIER_CLAIM_SIGNER_TYPE_UNSPECIFIED:
      return MorseSupplierClaimSignerType.MORSE_SUPPLIER_CLAIM_SIGNER_TYPE_UNSPECIFIED
    case 1:
    case "MORSE_SUPPLIER_CLAIM_SIGNER_TYPE_CUSTODIAL_SIGNED_BY_NODE_ADDR":
    case MorseSupplierClaimSignerTypeSDKType.MORSE_SUPPLIER_CLAIM_SIGNER_TYPE_CUSTODIAL_SIGNED_BY_NODE_ADDR:
      return MorseSupplierClaimSignerType.MORSE_SUPPLIER_CLAIM_CUSTODIAL_SIGNED_BY_NODE_ADDR
    case 2:
    case "MORSE_SUPPLIER_CLAIM_SIGNER_TYPE_NON_CUSTODIAL_SIGNED_BY_NODE_ADDR":
    case MorseSupplierClaimSignerTypeSDKType.MORSE_SUPPLIER_CLAIM_SIGNER_TYPE_NON_CUSTODIAL_SIGNED_BY_NODE_ADDR:
      return MorseSupplierClaimSignerType.MORSE_SUPPLIER_CLAIM_NON_CUSTODIAL_SIGNED_BY_NODE_ADDR
    case 3:
    case "MORSE_SUPPLIER_CLAIM_SIGNER_TYPE_NON_CUSTODIAL_SIGNED_BY_OWNER":
    case MorseSupplierClaimSignerTypeSDKType.MORSE_SUPPLIER_CLAIM_SIGNER_TYPE_NON_CUSTODIAL_SIGNED_BY_OWNER:
      return MorseSupplierClaimSignerType.MORSE_SUPPLIER_CLAIM_NON_CUSTODIAL_SIGNED_BY_OWNER
    default:
      throw new Error(`Unknown MorseSupplierClaimSignerType=${item}`)
  }
}

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
    case 3:
    case SupplierUnbondingReasonSDKType.SUPPLIER_UNBONDING_REASON_MIGRATION:
    case "SUPPLIER_UNBONDING_REASON_MIGRATION":
      return SupplierUnbondingReason.MIGRATION
    default:
      throw new Error(`Unknown SupplierUnbondingReason=${item}`)
  }
}

interface StakeSupplierProps {
  operatorAddress: string;
  ownerAddress: string;
  stake: Coin;
  services: Array<SupplierServiceConfigType>;
  msgId: string
  msgServicesEntityName: string
  serviceMsgIdKey: 'claimMsgId' | 'stakeMsgId'
}

type ClaimOrStake<T extends StakeSupplierProps['serviceMsgIdKey']> = T extends 'claimMsgId' ? MsgClaimMorseSupplierProps : MsgStakeSupplierServiceProps

async function _stakeSupplier({
  msgId,
  msgServicesEntityName,
  operatorAddress,
  ownerAddress,
  serviceMsgIdKey,
  services,
  stake,
}: StakeSupplierProps): Promise<Array<Promise<void>>> {
  const supplier = Supplier.create({
    id: operatorAddress,
    operatorId: operatorAddress,
    ownerId: ownerAddress,
    stakeAmount: BigInt(stake.amount),
    stakeDenom: stake.denom,
    stakeStatus: StakeStatus.Staked,
  });

  const servicesId: Array<string> = [];
  // used to create the services that came in the stake message
  const supplierMsgStakeServices: Array<ClaimOrStake<typeof serviceMsgIdKey>> = [];
  // used to have the services that are currently configured for the supplier
  const newSupplierServices: Array<SupplierServiceConfigProps> = [];

  for (const { endpoints, revShare, serviceId } of services) {
    servicesId.push(serviceId);

    const endpointsArr: Array<SupplierEndpoint> = endpoints.map((endpoint) => ({
      url: endpoint.url,
      rpcType: endpoint.rpcType,
      configs: endpoint.configs,
    }));

    const revShareArr: Array<SupplierRevShare> = revShare.map((revShare) => ({
      address: revShare.address,
      revSharePercentage: revShare.revSharePercentage.toString(),
    }));

    supplierMsgStakeServices.push({
      id: getMsgStakeServiceId(msgId, serviceId),
      serviceId,
      [serviceMsgIdKey]: msgId,
      endpoints: endpointsArr,
      revShare: revShareArr,
    } as ClaimOrStake<typeof serviceMsgIdKey>);

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
    supplier.save(),
    optimizedBulkCreate(msgServicesEntityName, supplierMsgStakeServices),
    store.bulkCreate("SupplierServiceConfig", newSupplierServices),
  ];

  if (servicesToRemove.length > 0) {
    promises.push(store.bulkRemove("SupplierServiceConfig", servicesToRemove));
  }

  return promises
}

async function _handleSupplierStakeMsg(msg: CosmosMessage<MsgStakeSupplier>) {
  if (!msg.msg.decodedMsg.stake) {
    return logger.error(`[handleSupplierStakeMsg] stake not provided in msg`);
  }

  const msgId = messageId(msg);

  const promises = await _stakeSupplier({
    msgId,
    msgServicesEntityName: "MsgStakeSupplierService",
    operatorAddress: msg.msg.decodedMsg.operatorAddress,
    ownerAddress: msg.msg.decodedMsg.ownerAddress,
    stake: msg.msg.decodedMsg.stake,
    services: msg.msg.decodedMsg.services,
    serviceMsgIdKey: 'stakeMsgId',
  });

  promises.push(
    MsgStakeSupplierEntity.create({
      id: msgId,
      signerId: msg.msg.decodedMsg.signer,
      supplierId: msg.msg.decodedMsg.operatorAddress,
      ownerId: msg.msg.decodedMsg.ownerAddress,
      stakeAmount: BigInt(msg.msg.decodedMsg.stake.amount),
      stakeDenom: msg.msg.decodedMsg.stake.denom,
      blockId: getBlockId(msg.block),
      transactionId: msg.tx.hash,
      messageId: msgId,
    }).save()
  )

  await Promise.all(promises);
}

async function _handleMsgClaimMorseSupplier(msg: CosmosMessage<MsgClaimMorseSupplier>) {
  const msgId = messageId(msg);

  let stakeCoin: Coin | null = null, balanceCoin: Coin | null = null, claimSignerType: string | null = null;

  for (const event of msg.tx.tx.events) {
    if (event.type === 'pocket.migration.EventMorseSupplierClaimed') {
      for (const attribute of event.attributes) {
        if (attribute.key === 'claim_signer_type') {
          claimSignerType = (attribute.value as string).replaceAll("\"", "");
        }

        if (attribute.key === 'claimed_balance') {
          const coin: CoinSDKType = getDenomAndAmount(attribute.value as string);

          balanceCoin = {
            denom: coin.denom,
            amount: coin.amount,
          }
        }

        if (attribute.key === 'claimed_supplier_stake') {
          const coin: CoinSDKType = getDenomAndAmount(attribute.value as string);

          stakeCoin = {
            denom: coin.denom,
            amount: coin.amount,
          }
        }
      }
    }
  }

  if (!stakeCoin) {
    throw new Error(`[handleMsgClaimMorseSupplier] stake coin not found in event`);
  }

  if (!balanceCoin) {
    throw new Error(`[handleMsgClaimMorseSupplier] balance coin not found in event`);
  }

  const supplier = await Supplier.get(msg.msg.decodedMsg.shannonOperatorAddress);

  const promises = await _stakeSupplier({
    msgId,
    msgServicesEntityName: "MsgClaimMorseSupplierService",
    operatorAddress: msg.msg.decodedMsg.shannonOperatorAddress,
    ownerAddress: msg.msg.decodedMsg.shannonOwnerAddress,
    services: msg.msg.decodedMsg.services,
    // we are using this stake because the migration allows migrating a supplier to an existing one, just adding the stake
    stake: {
      amount: (BigInt(stakeCoin.amount) + BigInt(supplier?.stakeAmount?.toString() || '0')).toString(),
      denom: stakeCoin.denom,
    },
    serviceMsgIdKey: 'claimMsgId',
  });

  promises.push(
    MsgClaimMorseSupplierEntity.create({
      id: msgId,
      supplierId: msg.msg.decodedMsg.shannonOperatorAddress,
      shannonSigningAddress: msg.msg.decodedMsg.shannonSigningAddress,
      shannonOwnerAddress: msg.msg.decodedMsg.shannonOwnerAddress,
      shannonOperatorAddress: msg.msg.decodedMsg.shannonOperatorAddress,
      morsePublicKey: toHex(msg.msg.decodedMsg.morsePublicKey),
      morseSrcAddress: pubKeyToAddress(
        Ed25519,
        msg.msg.decodedMsg.morsePublicKey,
        undefined,
        true
      ),
      morseSignature: toHex(msg.msg.decodedMsg.morseSignature),
      stakeAmount: BigInt(stakeCoin.amount),
      stakeDenom: stakeCoin.denom,
      balanceAmount: BigInt(balanceCoin.amount),
      balanceDenom: balanceCoin.denom,
      blockId: getBlockId(msg.block),
      transactionId: msg.tx.hash,
      messageId: msgId,
      morseNodeAddress: msg.msg.decodedMsg.morseNodeAddress,
      signerIsOutputAddress: msg.msg.decodedMsg.signerIsOutputAddress,
      claimSignerType: claimSignerType ? getMorseSupplierClaimSignerType(claimSignerType) : undefined,
    }).save()
  )

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

async function _handleEventSupplierServiceConfigActivated(
  event: CosmosEvent,
) {
  let activationHeight: bigint | null = null, operatorAddress: string | undefined, serviceId: string | undefined;

  for (const {key, value} of event.event.attributes) {
    if (key === "activation_height") {
      activationHeight = BigInt((value as string).replaceAll('"', ''));
    }

    if (key === "supplier") {
      operatorAddress = (JSON.parse(value as unknown as string) as SupplierSDKType).operator_address;
    }

    if (key === "operator_address") {
      operatorAddress = (value as string).replaceAll('"', '');
    }
  }

  if (!activationHeight) {
    throw new Error(`[handleEventSupplierServiceConfigActivated] activation_height not found in event`);
  }

  if (!operatorAddress) {
    throw new Error(`[handleEventSupplierServiceConfigActivated] operatorAddress not found in event`);
  }

  let services: Array<SupplierServiceConfig> = []

  if (serviceId) {
    const service = await SupplierServiceConfig.get(
      getStakeServiceId(operatorAddress, serviceId)
    )

    if (service) {
      services = [
        service
      ]
    }
  }

  if (services.length === 0) {
    services = await fetchAllSupplierServiceConfigBySupplier(operatorAddress);
  }

  const eventId = getEventId(event);

  await Promise.all([
    EventSupplierServiceConfigActivated.create({
      id: eventId,
      eventId: eventId,
      blockId: getBlockId(event.block),
    }).save(),
    store.bulkUpdate(
      "SupplierServiceConfig",
      services
        .filter((service) => !service.activatedAtId)
        .map((service) => {
          service.activatedAtId = activationHeight;
          service.activatedEventId = eventId;
          return service;
      })
    )
  ])
}

async function _handleSupplierUnbondingBeginEvent(
  event: CosmosEvent,
) {
  /*
  {
  "type":"pocket.supplier.EventSupplierUnbondingBegin",
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
  "endpoints\":[{\"url\":\"https://beta-relayminer-4.us-nj.pocket.com:443\",\"rpc_type\":\"JSON_RPC\",\
  "configs\":[]}],\"rev_share\":[{\"address\":\"pokt1kfjlev8j9nml32rzln7nw6r9pynez30c5lpgx5\",
  \"rev_share_percentage\":100}]},{\"service_id\":\"proto-static-ngx\",
  \"endpoints\":[{\"url\":\"https://beta-relayminer-4.us-nj.pocket.com:443\",\"rpc_type\":\"JSON_RPC\",\"configs\":[]}],
  \"rev_share\":[{\"address\":\"pokt1kfjlev8j9nml32rzln7nw6r9pynez30c5lpgx5\",\"rev_share_percentage\":100}]}],\"unstake_session_end_height\":\"55060\",
  \"services_activation_heights_map\":{\"proto-anvil\":\"31851\",\"proto-static-ngx\":\"31851\"}}","index":true
  },
  {
  "key":"unbonding_end_height",
  "value":"\"55070\"","index":true
  },{"key":"mode","value":"EndBlock","index":true}]}
   */
  let unbondingHeight: bigint | null = null, sessionEndHeight: bigint | null = null, operatorAddress: string | undefined, reason: null | number = null;

  for (const attribute of event.event.attributes) {
    if (attribute.key === "supplier") {
      operatorAddress = (JSON.parse(attribute.value as string) as SupplierSDKType).operator_address;
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

    if (attribute.key === "operator_address") {
      operatorAddress = parsedValue;
    }
  }

  if (!operatorAddress) {
    throw new Error(`[handleSupplierUnbondingBeginEvent] operatorAddress not provided in event`);
  }

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

  if (reason === null) {
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
      reason: reason !== null ? getSupplierUnbondingReasonFromSDK(reason) : SupplierUnbondingReason.UNSPECIFIED,
      eventId,
    }).save(),
  ]);
}

async function _handleSupplierUnbondingEndEvent(
  event: CosmosEvent,
) {
  let unbondingHeight: bigint | null = null, sessionEndHeight: bigint | null = null, operatorAddress: string | undefined, reason: null | number = null;

  for (const attribute of event.event.attributes) {
    if (attribute.key === "supplier") {
      operatorAddress = (JSON.parse(attribute.value as string) as SupplierSDKType).operator_address;
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

    if (attribute.key === "operator_address") {
      operatorAddress = parsedValue;
    }
  }

  if (!operatorAddress) {
    throw new Error(`[handleSupplierUnbondingEndEvent] operatorAddress not provided in event`);
  }

  const supplier = await Supplier.get(operatorAddress);

  if (!supplier) {
    throw new Error(`[handleSupplierUnbondingEndEvent] supplier not found for operator address ${operatorAddress}`);
  }

  if (!unbondingHeight) {
    // todo: we should do this -> throw new Error(`[handleSupplierUnbondingEndEvent] unbonding_end_height not found`);
    //  but alpha has still events without this
    logger.error(`[handleSupplierUnbondingEndEvent] unbonding_end_height not found`);
  } else {
    supplier.unstakingEndBlockId = unbondingHeight
  }

  if (reason === null) {
    // todo: we should do this -> throw new Error(`[handleSupplierUnbondingBeginEvent] reason not found in event`);
    //  but alpha has still events without this
    logger.error(`[handleSupplierUnbondingEndEvent] reason not found in event`);
  } else {
    supplier.unstakingReason = getSupplierUnbondingReasonFromSDK(reason)
  }

  supplier.stakeStatus = StakeStatus.Unstaked;

  const supplierServices = (await fetchAllSupplierServiceConfigBySupplier(operatorAddress) || []).map(item => item.id);

  const eventId = getEventId(event);

  await Promise.all([
    EventSupplierUnbondingEndEntity.create({
      id: eventId,
      unbondingEndHeight: unbondingHeight || BigInt(0),
      sessionEndHeight: sessionEndHeight || BigInt(0),
      reason: reason !== null ? getSupplierUnbondingReasonFromSDK(reason) : SupplierUnbondingReason.UNSPECIFIED,
      blockId: getBlockId(event.block),
      supplierId: operatorAddress,
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

export async function handleMsgClaimMorseSupplier(
  messages: Array<CosmosMessage<MsgClaimMorseSupplier>>,
): Promise<void> {
  await Promise.all([
    ...messages.map(_handleMsgClaimMorseSupplier),
    updateMorseClaimableAccounts(
      messages.map((msg) => ({
        morseAddress: msg.msg.decodedMsg.morseNodeAddress,
        destinationAddress: msg.msg.decodedMsg.shannonOperatorAddress,
        claimedMsgId: messageId(msg),
        transactionHash: msg.tx.hash,
      }))
    )
  ]);
}

export async function handleUnstakeSupplierMsg(
  messages: Array<CosmosMessage<MsgUnstakeSupplier>>,
): Promise<void> {
  await Promise.all(messages.map(_handleUnstakeSupplierMsg));
}

export async function handleEventSupplierServiceConfigActivated(
  events: Array<CosmosEvent>,
): Promise<void> {
  await Promise.all(events.map(_handleEventSupplierServiceConfigActivated));
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
