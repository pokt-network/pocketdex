import { TextEncoder } from "util";
import {
  CosmosBlock,
  Header,
  TxData,
  TxEvent,
} from "@subql/types-cosmos";
import { Attribute } from "../../types/proto-interfaces/cosmos/base/abci/v1beta1/abci";
import { stringify } from "./json";

// Utility function to get the byte size of a Uint8Array
function getUint8ArraySize(array: Uint8Array): number {
  return array ? array.length : 0;
}

// Utility function to convert a hexadecimal string to a Uint8Array
function hexStringToUint8Array(hex: string): Uint8Array {
  const length = hex.length / 2;
  const array = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    array[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return array;
}

// Utility function to get the byte size of a string or number when converted to bytes
function getStringOrNumberSize(input: string | number): number {
  return new TextEncoder().encode(String(input).trim()).length;
}

// Utility function to get the byte size of a Header
function getHeaderSize(header: Header): number {
  let size = 0;

  size += getUint8ArraySize(header.lastCommitHash);
  size += getUint8ArraySize(header.dataHash);
  size += getUint8ArraySize(header.validatorsHash);
  size += getUint8ArraySize(header.nextValidatorsHash);
  size += getUint8ArraySize(header.consensusHash);
  size += getUint8ArraySize(header.appHash);
  size += getUint8ArraySize(header.lastResultsHash);
  size += getUint8ArraySize(header.evidenceHash);
  size += getUint8ArraySize(header.proposerAddress);

  size += getStringOrNumberSize(header.chainId);
  size += getStringOrNumberSize(header.height);

  // Use ISO string format for the time field
  size += getStringOrNumberSize(header.time.toISOString());

  size += getStringOrNumberSize(header.version.block);
  size += getStringOrNumberSize(header.version.app);

  if (header.lastBlockId) {
    size += getUint8ArraySize(header.lastBlockId.hash);
    if (header.lastBlockId.parts) {
      size += getStringOrNumberSize(header.lastBlockId.parts.total);
      size += getUint8ArraySize(header.lastBlockId.parts.hash);
    }
  }

  return size;
}

// Utility function to get the byte size of a LastCommit
function getLastCommitSize(lastCommit: any): number {
  let size = 0;

  size += getStringOrNumberSize(lastCommit.height);
  size += getStringOrNumberSize(lastCommit.round);
  size += getUint8ArraySize(lastCommit.blockId.hash);
  size += getStringOrNumberSize(lastCommit.blockId.parts.total);
  size += getUint8ArraySize(lastCommit.blockId.parts.hash);

  size += lastCommit.signatures.reduce((total: number, sig: any) => {
    total += getStringOrNumberSize(sig.blockIdFlag);
    total += sig.validatorAddress ? getUint8ArraySize(sig.validatorAddress) : 0;

    // Use ISO string format for the timestamp field
    total += sig.timestamp ? getStringOrNumberSize(sig.timestamp.toISOString()) : 0;

    total += sig.signature ? getUint8ArraySize(sig.signature) : 0;
    return total;
  }, 0);

  return size;
}

// Utility function to get the byte size of EventAttribute
function getEventAttributeSize(attribute: Attribute): number {
  let size = 0;
  size += getStringOrNumberSize(attribute.key);
  size += getStringOrNumberSize(attribute.value);
  return size;
}

// Utility function to get the byte size of an Event
function getEventSize(event: TxEvent): number {
  let size = 0;
  size += getStringOrNumberSize(event.type);
  size += event.attributes.reduce((total, attr) => total + getEventAttributeSize(attr as Attribute), 0);
  return size;
}

// Utility function to get the byte size of TxData
function getTxDataSize(txData: TxData): number {
  let size = 0;
  size += getStringOrNumberSize(txData.code);
  if (txData.codespace) size += getStringOrNumberSize(txData.codespace);
  if (txData.log) size += getStringOrNumberSize(txData.log);
  if (txData.data) size += getUint8ArraySize(txData.data);
  size += txData.events.reduce((total, event) => total + getEventSize(event), 0);
  size += getStringOrNumberSize(txData.gasWanted.toString());
  size += getStringOrNumberSize(txData.gasUsed.toString());
  return size;
}

// Utility function to get the byte size of an Evidence
function getEvidenceSize(evidence: any): number {
  // Adjust as per actual evidence structure
  return new TextEncoder().encode(stringify(evidence).trim()).length;
}

// Main function to get the byte size of a CosmosBlock
export function getBlockByteSize(block: CosmosBlock): number {
  let size = 0;

  // Convert block.block.id to Uint8Array and count its size
  const blockIdArray = hexStringToUint8Array(block.block.id);
  size += getUint8ArraySize(blockIdArray);

  // Calculate the byte size of the Header using the utility function
  size += getHeaderSize(block.block.header);

  // Calculate the total size of transaction data (txs array) using detailed parsing
  size += block.txs.reduce((total, tx) => total + getTxDataSize(tx), 0);

  // Evidence on TypeScript is defined as any,
  // so due to the unknown on the structure, use stringify and calculate it is
  // the best for now.
  if (block.block.evidence) {
    size += block.block.evidence.reduce((total, ev) => total + getEvidenceSize(ev), 0);
  }

  // Calculate the last commit size, including its nested structures
  if (block.block.lastCommit) {
    size += getLastCommitSize(block.block.lastCommit);
  }

  return size;
}
