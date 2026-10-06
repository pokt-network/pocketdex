import type { ServiceConfigUpdateSDKType } from "../../types/proto-interfaces/pocket/shared/supplier";
import { heightOrZero } from "./primitives";

// activatedAt of a genesis SupplierServiceConfig row. The row holds the config the supplier declared
// (supplier.services): the history entry for this service with no deactivation scheduled. It is active since
// genesis (activatedAt = genesis height) when that entry activates at or before the genesis height, and pending
// otherwise, until its own activation event. A service whose only entries are scheduled to end counts as active
// if one of them is active at genesis. A missing height is read as 0 (not verified whether a genesis export omits
// zeros: neither the mainnet nor the beta genesis carries suppliers).
// Without history the config is left pending, as before. activatedEventId stays unset: genesis has no activation
// event to point to.
export function genesisConfigActivatedAt(
  history: Array<ServiceConfigUpdateSDKType> | undefined,
  serviceId: string,
  genesisHeight: bigint
): bigint | undefined {
  const entries = (history ?? []).filter(({ service }) => service?.service_id === serviceId);
  const declared = entries.find(({ deactivation_height }) => heightOrZero(deactivation_height) === BigInt(0));
  const active = declared !== undefined
    ? heightOrZero(declared.activation_height) <= genesisHeight
    : entries.some(({ activation_height, deactivation_height }) =>
      heightOrZero(activation_height) <= genesisHeight && heightOrZero(deactivation_height) > genesisHeight);
  return active ? genesisHeight : undefined;
}
