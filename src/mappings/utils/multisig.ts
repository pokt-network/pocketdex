import {
  createMultisigThresholdPubkey,
  encodeSecp256k1Pubkey,
  pubkeyToAddress,
  SinglePubkey,
} from "@cosmjs/amino";
import {
  fromBase64,
  toBase64,
} from "@cosmjs/encoding";
import { decodePubkey } from "@cosmjs/proto-signing";
import { SignerInfo } from "../../types/proto-interfaces/cosmos/tx/v1beta1/tx";
import { MultisigLegacyAminoPubKey } from "./pub_key";

export interface MultisigInfo {
  fromAddress: string;
  allSignerAddresses: string[];
  signedSignerAddresses: string[];
}

/**
 * Decode a base64-encoded bitarray and return indices of public keys that signed.
 */
function decodeBitArray(elemsBase64: string, extraBitsStored: number): number[] {
  const bitArray = fromBase64(elemsBase64);
  console.log("Decoded bitArray:", [...bitArray]);
  console.log("extraBitsStored:", extraBitsStored);

  const signerIndices: number[] = [];

  for (let i = 0; i < extraBitsStored; i++) {
    const byteIndex = Math.floor(i / 8);
    const bitIndex = i % 8;
    const byte = bitArray[byteIndex];

    // Cosmos uses MSB first: bit 0 is the highest bit in the byte
    const bit = (byte >> (7 - bitIndex)) & 1;

    console.log(`bit ${i}: byte[${byteIndex}] = ${byte.toString(2).padStart(8, "0")} → MSB bit ${7 - bitIndex} = ${bit === 1}`);

    if (bit === 1) {
      signerIndices.push(i);
    }
  }

  console.log("Decoded signer indices:", signerIndices);
  return signerIndices;
}

export function getMultiSignPubKeyAddress(pubkeysBase64: string[], threshold: number, prefix: string): string {
  // Step 1: Encode each base64 pubkey as Amino SinglePubkey
  const pubkeyObjs: SinglePubkey[] = pubkeysBase64.map((b64) =>
    encodeSecp256k1Pubkey(fromBase64(b64)),
  );

  // Step 2: Build a multisig pubkey and derive fromAddress
  const multisigPubkey = createMultisigThresholdPubkey(pubkeyObjs, threshold);
  return pubkeyToAddress(multisigPubkey, prefix);
}

/**
 * Parse all multisig signer info including fromAddress, all signers, and who actually signed.
 */
export function parseMultisigSignerInfo({
                                          bitarrayElems,
                                          extraBitsStored,
                                          prefix,
                                          pubkeysBase64,
                                          threshold,
                                        }: {
  pubkeysBase64: string[];
  threshold: number;
  bitarrayElems: string;
  extraBitsStored: number;
  prefix: string;
}): MultisigInfo {
  // Step 1: Encode each base64 pubkey as Amino SinglePubkey
  const pubkeyObjs: SinglePubkey[] = pubkeysBase64.map((b64) =>
    encodeSecp256k1Pubkey(fromBase64(b64)),
  );

  // Step 2: Build a multisig pubkey and derive fromAddress
  const fromAddress = getMultiSignPubKeyAddress(pubkeysBase64, threshold, prefix);

  // Step 3: All signer addresses
  const allSignerAddresses = pubkeyObjs.map((pk) => pubkeyToAddress(pk, prefix));

  // Step 4: Decode the bitarray to find actual signers
  const signerIndices = decodeBitArray(bitarrayElems, extraBitsStored);
  const signedSignerAddresses = signerIndices.map((i) => allSignerAddresses[i]);

  return {
    fromAddress,
    allSignerAddresses,
    signedSignerAddresses,
  };
}

export function extractThresholdAndPubkeysFromMultisig(pubkeyBytes: Uint8Array): {
  threshold: number;
  pubkeysBase64: string[];
} {
  const decoded = decodePubkey({
    typeUrl: "/cosmos.crypto.multisig.LegacyAminoPubKey",
    value: pubkeyBytes,
  });

  if (!decoded || decoded.type !== "tendermint/PubKeyMultisigThreshold") {
    throw new Error("Not a valid multisig pubkey");
  }

  const { pubkeys, threshold } = decoded.value;
  const pubkeysBase64 = pubkeys.map((pk: { value: any; }) => pk.value); // already base64

  return {
    threshold: Number(threshold),
    pubkeysBase64,
  };
}

export function getMultisigInfo(signerInfo: SignerInfo): MultisigInfo {
  if (!signerInfo || !isMulti(signerInfo)) {
    throw new Error("[getMultisigInfo] signerInfo is not a multisig");
  }
  if (!signerInfo.publicKey) {
    throw new Error("[getMultisigInfo] missing signerInfos public key");
  }
  const { pubkeysBase64, threshold } = extractThresholdAndPubkeysFromMultisig(signerInfo.publicKey.value);

  return parseMultisigSignerInfo({
    pubkeysBase64,
    threshold,
    bitarrayElems: toBase64(signerInfo.modeInfo?.multi?.bitarray?.elems as Uint8Array<ArrayBufferLike>),
    extraBitsStored: signerInfo.modeInfo?.multi?.bitarray?.extraBitsStored as number,
    prefix: "pokt",
  });
}

export function isMulti(signerInfo: SignerInfo): boolean {
  if (!signerInfo.publicKey) {
    throw new Error(`missing signerInfos public key`);
  }

  return signerInfo.publicKey.typeUrl === MultisigLegacyAminoPubKey;
}
