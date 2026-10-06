// No import of generated types (src/types): the money specs load this module in CI, where codegen does not run.

// A height of a service_config_history entry, as the chain JSON writes it (a string). The event encoder writes
// zeros too (block_results of mainnet 247741); a missing height is read as 0.
export function heightOrZero(value: unknown): bigint {
  return BigInt(String(value ?? 0));
}

// The history entry fields read here (ServiceConfigUpdateSDKType, snake_case JSON).
interface ServiceConfigUpdateEntry {
  service?: { service_id?: string };
  activation_height?: unknown;
  deactivation_height?: unknown;
}

// activatedAt of a genesis SupplierServiceConfig row. The row holds the config the supplier declared
// (supplier.services): the history entry for this service with no deactivation scheduled. It is active since
// genesis (activatedAt = genesis height) when that entry activates at or before the genesis height, and pending
// otherwise, until its own activation event. A service whose only entries are scheduled to end counts as active
// if one of them is active at genesis. A missing height is read as 0 (not verified whether a genesis export omits
// zeros: neither the mainnet nor the beta genesis carries suppliers).
// Without history the config is left pending, as before. activatedEventId stays unset: genesis has no activation
// event to point to.
export function genesisConfigActivatedAt(
  history: Array<ServiceConfigUpdateEntry> | undefined,
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

// The "domain" of one endpoint URL, or null when none can be read; it never throws, whatever the string. poktroll
// validates the URL at stake (x/shared/types/service.go IsValidEndpointUrl: Go url.Parse, scheme http, https, ws or
// wss, non-empty host), but Go's parser is lenient about the host. An IPv4 host is the whole address; an IPv6 host
// (bracketed in a URL) its compressed lowercase form, an IPv4-mapped one as ::ffff:a.b.c.d (RFC 5952); a hostname
// its last two labels (a public suffix such as co.uk is not known: a follow-up).
export function endpointDomain(url: unknown): string | null {
  if (typeof url !== "string") return null;
  const raw = url.trim();
  if (raw === "") return null;
  let host: string | undefined;
  try {
    host = new URL(raw).hostname;
  } catch {
    // not a WHATWG URL (e.g. an unbracketed IPv6 or a space in the host): read the authority after the scheme
    const authority = raw.match(/^[a-z][a-z0-9+.-]*:\/\/(?:[^@/?#]*@)?([^/?#\s]+)/i)?.[1];
    // more than one colon and no brackets: an IPv6 address, whose port cannot be told apart; else host[:port]
    host = authority !== undefined && !authority.startsWith("[") && (authority.match(/:/g) ?? []).length > 1
      ? authority
      : authority?.match(/^(\[[^\]]*\]|[^:]+)/)?.[1];
  }
  if (!host) return null;
  host = host.toLowerCase().replace(/\.+$/, "");
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (host === "") return null;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    return host.split(".").every((octet) => Number(octet) <= 255) ? host : null;
  }
  if (host.includes(":")) return ipv6(host);
  const labels = host.split(".").filter((label) => label !== "");
  return labels.length >= 2 ? labels.slice(-2).join(".") : labels[0] ?? null;
}

// An IPv6 address in compressed lowercase form (WHATWG's serializer), IPv4-mapped as ::ffff:a.b.c.d; null if invalid
function ipv6(address: string): string | null {
  let compressed: string;
  try {
    compressed = new URL(`http://[${address}]/`).hostname.slice(1, -1);
  } catch {
    return null;
  }
  const mapped = compressed.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (!mapped) return compressed;
  const [hi, lo] = [parseInt(mapped[1], 16), parseInt(mapped[2], 16)];
  return `::ffff:${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

// The unique domains of a service config's endpoint URLs, in endpoint order: what SupplierServiceConfig.domains
// holds, for a stake (getServices) and for genesis alike.
export function endpointDomains(urls: Array<unknown>): Array<string> {
  return [...new Set(urls.map(endpointDomain).filter((domain): domain is string => domain !== null))];
}
