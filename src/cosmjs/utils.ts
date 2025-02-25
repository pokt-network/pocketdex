import type { Coin } from "@cosmjs/amino";

function cosmosDecimalToBigInt(decimalString: string) {
  const num = Number(decimalString);
  // Convert to BigInt *before* multiplying
  return BigInt(Math.round(num * 10 ** 18));  // Use Number for this calculation and round
}

/**
 * Takes a coins list like "819966000ucosm,700000000ustake" and parses it.
 *
 * This is a Stargate ready version of parseCoins from @cosmjs/amino.
 * It supports more denoms.
 */
export function parseCoins(input: string): Coin[] {
  return input
    .replace(/\s/g, "")
    .split(",")
    .filter(Boolean)
    .map((part) => {
      // handle decimals before poktroll team fix the issue where rewards and commissions events came as BigDec instead of BigInt
      const match = part.match(/^([0-9]+(\.[0-9]*)?|\.[0-9]+)([a-zA-Z][a-zA-Z0-9/]{2,127})$/);

      if (!match) {
        throw new Error(`Got an invalid coin string. Value=${input}`);
      }

      let amount: string;

      if (match[2]) {
        amount = cosmosDecimalToBigInt(match[1]).toString();
      } else {
        amount = match[1];
      }

      return {
        amount: amount,
        denom: match[3],
      };
    });
}
