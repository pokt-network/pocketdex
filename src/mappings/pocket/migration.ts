import { toHex } from "@cosmjs/encoding";
import type { CosmosMessage } from "@subql/types-cosmos";
import type { Coin } from "../../client/cosmos/base/v1beta1/coin";
import { MsgImportMorseClaimableAccounts } from "../../client/pocket/migration/tx";
import type { MorseClaimableAccountProps } from "../../types/models/MorseClaimableAccount";
import {
  MsgClaimMorseAccount as MsgClaimMorseAccountEntity,
  MsgClaimMorseAccountProps,
} from "../../types/models/MsgClaimMorseAccount";
import type { MsgImportMorseClaimableAccountsProps } from "../../types/models/MsgImportMorseClaimableAccounts";
import { MsgRecoverMorseAccountProps } from "../../types/models/MsgRecoverMorseAccount";
import type { CoinSDKType } from "../../types/proto-interfaces/cosmos/base/v1beta1/coin";
import type { MsgClaimMorseAccount, MsgRecoverMorseAccount } from "../../types/proto-interfaces/pocket/migration/tx";
import type { EncodedMsg } from "../types";
import { getStoreModel } from "../utils/db";
import { messageId } from "../utils/ids";
import { Ed25519, pubKeyToAddress } from "../utils/pub_key";

function _handleMsgClaimMorseAccount(
  msg: CosmosMessage<MsgClaimMorseAccount>,
): MsgClaimMorseAccountProps {
  const msgId = messageId(msg);


  let balanceCoin: Coin | null = null;

  for (const event of msg.tx.tx.events) {
    if (event.type === 'pocket.migration.EventMorseAccountClaimed') {
      for (const attribute of event.attributes) {
        if (attribute.key === 'claimed_balance') {
          const coin: CoinSDKType = JSON.parse(attribute.value as string);

          balanceCoin = {
            denom: coin.denom,
            amount: coin.amount,
          }
        }
      }
    }
  }

  if (!balanceCoin) {
    throw new Error(`[handleMsgClaimMorseSupplier] balance coin not found in event`);
  }

  return MsgClaimMorseAccountEntity.create({
    id: msgId,
    accountId: msg.msg.decodedMsg.shannonDestAddress,
    transactionId: msg.tx.hash,
    blockId: BigInt(msg.block.block.header.height),
    shannonDestAddress: msg.msg.decodedMsg.shannonDestAddress,
    messageId: msgId,
    morseSignature: toHex(msg.msg.decodedMsg.morseSignature),
    morsePublicKey: toHex(msg.msg.decodedMsg.morsePublicKey),
    morseSrcAddress: pubKeyToAddress(
      Ed25519,
      msg.msg.decodedMsg.morsePublicKey,
      undefined,
      true
    ),
    shannonSigningAddress: msg.msg.decodedMsg.shannonSigningAddress,
    balanceAmount: BigInt(balanceCoin.amount),
    balanceDenom: balanceCoin.denom,
  })
}

function _handleMsgRecoverMorseAccount(msg: CosmosMessage<MsgRecoverMorseAccount>): MsgRecoverMorseAccountProps {
  let recoveredBalance: Coin | null = null;

  for (const event of msg.tx.tx.events) {
    if (event.type === 'pocket.migration.EventMorseAccountRecovered') {
      for (const attribute of event.attributes) {
        if (attribute.key === 'recovered_balance') {
          const coin: CoinSDKType = JSON.parse(attribute.value as string);

          recoveredBalance = {
            denom: coin.denom,
            amount: coin.amount,
          }
        }
      }
    }
  }

  if (!recoveredBalance) {
    throw new Error(`[handleMsgRecoverMorseAccount] recovered balance not found in event`);
  }

  return {
    id: messageId(msg),
    recoveredBalanceAmount: BigInt(recoveredBalance.amount),
    recoveredBalanceDenom: recoveredBalance.denom,
    authorityId: msg.msg.decodedMsg.authority,
    morseSrcAddress: msg.msg.decodedMsg.morseSrcAddress,
    shannonDestAddressId: msg.msg.decodedMsg.shannonDestAddress,

    blockId: BigInt(msg.block.header.height),
    transactionId: msg.tx.hash,
    messageId: messageId(msg),
  }
}

export async function updateMorseClaimableAccounts(
  items: Array<{
    publicKey?: Uint8Array
    morseAddress?: string
    destinationAddress: string
    transactionHash: string
    claimedMsgId: string
  }>,
): Promise<void> {
  const MorseClaimableAccountModel = getStoreModel("MorseClaimableAccount");
  const blockHeight = store.context.getHistoricalUnit();

  await Promise.all(
    items.map(({ claimedMsgId, destinationAddress, morseAddress, publicKey, transactionHash }) => MorseClaimableAccountModel.model.update(
      // mark as claimed
      {
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        claimed_at_id: blockHeight,
        claimed: true,
        shannon_dest_address: destinationAddress,
        transaction_id: transactionHash,
        claimed_msg_id: claimedMsgId,
      },
      {
        hooks: false,
        where: {
          id: publicKey ? pubKeyToAddress(
            Ed25519,
            publicKey,
            undefined,
            true
          ) : morseAddress!.toLowerCase(),
        },
        transaction: store.context.transaction,
      },
    ))
  )
}

export async function handleMsgClaimMorseAccount(
  messages: Array<CosmosMessage<MsgClaimMorseAccount>>,
): Promise<void> {
  await Promise.all([
    store.bulkCreate("MsgClaimMorseAccount", messages.map(_handleMsgClaimMorseAccount)),
    updateMorseClaimableAccounts(
      messages.map((msg) => ({
        publicKey: msg.msg.decodedMsg.morsePublicKey,
        destinationAddress: msg.msg.decodedMsg.shannonDestAddress,
        claimedMsgId: messageId(msg),
        transactionHash: msg.tx.hash,
      }))
    )
  ]);
}

export async function handleMsgRecoverMorseAccount(
  messages: Array<CosmosMessage<MsgRecoverMorseAccount>>,
): Promise<void> {
  await Promise.all([
    store.bulkCreate("MsgRecoverMorseAccount", messages.map(_handleMsgRecoverMorseAccount)),
    updateMorseClaimableAccounts(
      messages.map((msg) => ({
        morseAddress: msg.msg.decodedMsg.morseSrcAddress,
        destinationAddress: msg.msg.decodedMsg.shannonDestAddress,
        claimedMsgId: messageId(msg),
        transactionHash: msg.tx.hash,
      }))
    )
  ]);
}

interface HandleMsgImportMorseClaimableAccountsProps {
  encodedMsg: EncodedMsg,
  blockId: bigint
  transactionId: string
  messageId: string
}

export function handleMsgImportMorseClaimableAccounts({
  blockId,
  encodedMsg,
  messageId,
  transactionId,
}: HandleMsgImportMorseClaimableAccountsProps): {
  decodedMsg: object
  msgImportMorseClaimableAccounts: MsgImportMorseClaimableAccountsProps
  morseClaimableAccounts: Array<MorseClaimableAccountProps>
} {
  const decodedMsg = MsgImportMorseClaimableAccounts.decode(
    new Uint8Array(Object.values(encodedMsg.value))
  );

  return {
    decodedMsg,
    msgImportMorseClaimableAccounts: {
      id: messageId,
      blockId: blockId,
      transactionId,
      messageId,
      morseAccountStateHash: toHex(decodedMsg.morseAccountStateHash),
      authorityId: decodedMsg.authority
    },
    morseClaimableAccounts: decodedMsg.morseAccountState!.accounts.map((account) => ({
      id: account.morseSrcAddress.toLowerCase(),
      msgImportMorseClaimableAccountsId: messageId,
      applicationStakeAmount: BigInt(account.applicationStake?.amount || 0),
      applicationStakeDenom: account.applicationStake?.denom || "",
      supplierStakeAmount: BigInt(account.applicationStake?.amount || 0),
      supplierStakeDenom: account.supplierStake?.denom || "",
      claimed: false,
      unstakedBalanceAmount: BigInt(account.unstakedBalance?.amount || 0),
      unstakedBalanceDenom: account.unstakedBalance?.denom || "",
      morseOutputAddress: account.morseOutputAddress || undefined,
      unstakingTime: account.unstakingTime ? new Date(account.unstakingTime) : undefined,
    }))
  }
}
