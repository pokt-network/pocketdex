import {
  createMultisigThresholdPubkey,
  encodeAminoPubkey,
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
  signerIndices: number[];
  threshold: number;
  multisigPubKey: string;
  extraBitsStored: number;
  bitarrayElems: string;
}

/**
 * Decodes a base64-encoded bit array and determines the indices of bits set to 1.
 *
 * @param {string} elemsBase64 - The base64-encoded string representing the bit array.
 * @param {number} extraBitsStored - The total number of bits considered in the bit array.
 * @return {number[]} An array of indices where the corresponding bits in the bit array are set to 1.
 */
function decodeBitArray(elemsBase64: string, extraBitsStored: number): number[] {
  const bitArray = fromBase64(elemsBase64);

  const signerIndices: number[] = [];

  for (let i = 0; i < extraBitsStored; i++) {
    const byteIndex = Math.floor(i / 8);
    const bitIndex = i % 8;
    const byte = bitArray[byteIndex];

    // Cosmos uses MSB first: bit 0 is the highest bit in the byte
    const bit = (byte >> (7 - bitIndex)) & 1;

    if (bit === 1) {
      signerIndices.push(i);
    }
  }

  return signerIndices;
}

/**
 * Generates a multi-signature public key address based on the provided public keys, threshold, and address prefix.
 *
 * @param {string[]} pubkeysBase64 - An array of public keys in base64 encoding.
 * @param {number} threshold - The minimum number of signatures required to authorize a transaction.
 * @param {string} prefix - The prefix to be used for the derived address (e.g., "cosmos", "terra").
 * @return {Object} An object containing the derived address and the multi-signature public key:
 *                  - `from`: The derived address corresponding to the multi-signature public key.
 *                  - `pubkey`: The base64-encoded amino multi-signature public key.
 */
export function getMultiSignPubKeyAddress(pubkeysBase64: string[], threshold: number, prefix: string): {
  from: string,
  pubkey: string
} {
  // Encode each base64 pubkey as Amino SinglePubkey
  const pubkeyObjs: SinglePubkey[] = pubkeysBase64.map((b64) =>
    encodeSecp256k1Pubkey(fromBase64(b64)),
  );

  // Build a multisig pubkey and derive fromAddress
  const multisigPubkey = createMultisigThresholdPubkey(pubkeyObjs, threshold);
  const aminoMultsigPubKey = encodeAminoPubkey(multisigPubkey);
  return {
    from: pubkeyToAddress(multisigPubkey, prefix),
    pubkey: toBase64(aminoMultsigPubKey),
  };
}

/**
 * Parses multisig signer information from provided parameters, including pubkeys, bitarrays, and other metadata.
 *
 * @param {Object} params - The input parameters for the function.
 * @param {string[]} params.pubkeysBase64 - An array of public keys encoded in base64 format.
 * @param {number} params.threshold - The minimum number of signatures required to validate the multisig.
 * @param {string} params.bitarrayElems - The bitarray representing which signatures are provided.
 * @param {number} params.extraBitsStored - A number representing additional bits stored in the bitarray.
 * @param {string} params.prefix - The address prefix used to encode addresses.
 * @return {MultisigInfo} An object containing parsed multisig information,
 * including the derived `fromAddress`, signer addresses, and metadata.
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
  // Encode each base64 pubkey as Amino SinglePubkey
  const pubkeyObjs: SinglePubkey[] = pubkeysBase64.map((b64) =>
    encodeSecp256k1Pubkey(fromBase64(b64)),
  );

  // Build a multisig pubkey and derive fromAddress
  const { from: fromAddress, pubkey: multisigPubKey } = getMultiSignPubKeyAddress(pubkeysBase64, threshold, prefix);

  // All signer addresses
  const allSignerAddresses = pubkeyObjs.map((pk) => pubkeyToAddress(pk, prefix));

  // Decode the bitarray to find actual signers
  const signerIndices = decodeBitArray(bitarrayElems, extraBitsStored);
  const signedSignerAddresses = signerIndices.map((i) => allSignerAddresses[i]);

  return {
    fromAddress,
    allSignerAddresses,
    signedSignerAddresses,
    signerIndices,
    threshold,
    multisigPubKey,
    bitarrayElems,
    extraBitsStored,
  };
}

/**
 * Extracts the threshold and public keys in Base64 format from a multisig public key bytes' representation.
 * The input must be a valid multisig public key, or an error will be thrown.
 *
 * @param {Uint8Array} pubkeyBytes - The serialized public key bytes representing a multisig instance.
 * @return {Object} An object containing the threshold and an array of public keys in Base64 format.
 * @return {number} return.threshold - The threshold value for the multisig key.
 * @return {string[]} return.pubkeysBase64 - Array of public keys (in Base64 format) involved in the multisig.
 */
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
  const pubkeysBase64 = pubkeys.map((pk: { value: never; }) => pk.value); // already base64

  return {
    threshold: Number(threshold),
    pubkeysBase64,
  };
}

/**
 * Retrieves the multisignature information from the given signer information.
 *
 * @param {SignerInfo} signerInfo - The signer information to extract multisig information from.
 * Must be valid multisig signer information with a defined public key.
 * @return {MultisigInfo} The extracted multisignature information including public keys, threshold, and bitarray data.
 * @throws {Error} If the provided signer information is not a multisig or lacks a public key.
 */
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

/**
 * Determines if the provided signer information corresponds to a multisignature public key.
 *
 * @param {SignerInfo} signerInfo - The signer information containing a public key to be checked.
 * @return {boolean} Returns true if the public key type URL matches a multisignature public key; otherwise, false.
 */
export function isMulti(signerInfo: SignerInfo): boolean {
  if (!signerInfo.publicKey) {
    throw new Error(`missing signerInfos public key`);
  }

  return signerInfo.publicKey.typeUrl === MultisigLegacyAminoPubKey;
}
