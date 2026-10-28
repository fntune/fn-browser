/** Shared literal-host classification for SSRF and navigation policy. */
export type HostClassification =
  | "public"
  | "loopback"
  | "private"
  | "link_local"
  | "cloud_metadata"
  | "invalid";

const CLOUD_METADATA_HOSTS: ReadonlySet<string> = new Set([
  "metadata",
  "metadata.google.internal",
  "metadata.goog",
  "metadata.platformequinix.com",
  "instance-data",
]);
const IPV6_METADATA_ADDRESSES: readonly (readonly number[])[] = [
  // AWS EC2 IMDS.
  [0xfd, 0x00, 0x0e, 0xc2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x02, 0x54],
  // AWS EKS Pod Identity Agent.
  [0xfd, 0x00, 0x0e, 0xc2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x00, 0x23],
  // Google Compute Engine metadata.
  [0xfd, 0x20, 0x00, 0xce, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x02, 0x54],
] as const;

/** Classify a hostname or IP literal without performing DNS resolution. */
export function classifyHost(rawHost: string): HostClassification {
  const host = normalizeHost(rawHost);
  if (!host) return "invalid";
  if (CLOUD_METADATA_HOSTS.has(host)) return "cloud_metadata";
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "localhost.localdomain"
  ) {
    return "loopback";
  }

  const address = classifyIpAddress(host);
  if (address !== "invalid") return address;
  return host.includes(":") || /^[\d.]+$/.test(host) ? "invalid" : "public";
}

/** Classify an IP literal; non-IP input is returned as `invalid`. */
export function classifyIpAddress(rawAddress: string): HostClassification {
  const address = normalizeHost(rawAddress);
  if (!address) return "invalid";
  if (address.includes(":")) return classifyIpv6(address);
  const ipv4 = parseIpv4(address);
  return ipv4 ? classifyIpv4(ipv4) : "invalid";
}

function normalizeHost(value: string): string {
  if (typeof value !== "string") return "";
  const normalized = value.trim().toLowerCase().replace(/\.+$/, "");
  return normalized.startsWith("[") && normalized.endsWith("]")
    ? normalized.slice(1, -1)
    : normalized;
}

function parseIpv4(host: string): [number, number, number, number] | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => {
    if (!/^\d{1,3}$/.test(part)) return Number.NaN;
    return Number.parseInt(part, 10);
  });
  if (octets.some((octet) => Number.isNaN(octet) || octet < 0 || octet > 255)) {
    return null;
  }
  return octets as [number, number, number, number];
}

function classifyIpv4([a, b, c, d]: [
  number,
  number,
  number,
  number,
]): HostClassification {
  // Azure WireServer provides platform services, including metadata-adjacent
  // guest-agent endpoints, on this otherwise public address.
  if (a === 168 && b === 63 && c === 129 && d === 16) {
    return "cloud_metadata";
  }
  if (a === 169 && b === 254 && c === 169 && d === 254) {
    return "cloud_metadata";
  }
  if (a === 169 && b === 254 && c === 170 && d === 2) {
    return "cloud_metadata";
  }
  if (a === 169 && b === 254 && c === 170 && d === 23) {
    return "cloud_metadata";
  }
  if (a === 100 && b === 100 && c === 100 && d === 200) {
    return "cloud_metadata";
  }
  if (a === 192 && b === 0 && c === 0 && d === 192) {
    return "cloud_metadata";
  }
  if (a === 127 || a === 0) return "loopback";
  if (a === 10) return "private";
  if (a === 100 && b >= 64 && b <= 127) return "private";
  if (a === 172 && b >= 16 && b <= 31) return "private";
  if (a === 192 && b === 168) return "private";
  if (a === 169 && b === 254) return "link_local";

  // IANA special-purpose, documentation, benchmarking, multicast, and reserved
  // ranges are not globally routable destinations and must fail closed. The
  // two globally reachable anycast exceptions inside 192.0.0.0/24 stay public.
  if (a === 192 && b === 0 && c === 0) {
    return d === 9 || d === 10 ? "public" : "invalid";
  }
  if (a === 192 && b === 0 && c === 2) return "invalid";
  if (a === 192 && b === 88 && c === 99) return "invalid";
  if (a === 198 && (b === 18 || b === 19)) return "invalid";
  if (a === 198 && b === 51 && c === 100) return "invalid";
  if (a === 203 && b === 0 && c === 113) return "invalid";
  if (a >= 224) return "invalid";
  return "public";
}

function classifyIpv6(host: string): HostClassification {
  const bytes = ipv6ToBytes(host);
  if (!bytes) return "invalid";

  const prefixZero = (count: number): boolean =>
    bytes.slice(0, count).every((byte) => byte === 0);
  const embeddedV4 = (): HostClassification =>
    classifyIpv4([
      byteAt(bytes, 12),
      byteAt(bytes, 13),
      byteAt(bytes, 14),
      byteAt(bytes, 15),
    ]);

  if (bytes.every((byte) => byte === 0)) return "loopback";
  if (bytes.every((byte, index) => (index === 15 ? byte === 1 : byte === 0))) {
    return "loopback";
  }
  if (prefixZero(10) && bytes[10] === 0xff && bytes[11] === 0xff) {
    return embeddedV4();
  }
  // RFC 2765 IPv4-translated form: 0::ffff:0:a.b.c.d.
  if (
    prefixZero(8) &&
    bytes[8] === 0xff &&
    bytes[9] === 0xff &&
    bytes[10] === 0 &&
    bytes[11] === 0
  ) {
    return embeddedV4();
  }
  if (prefixZero(12)) {
    return embeddedV4();
  }
  if (
    bytes[0] === 0x00 &&
    bytes[1] === 0x64 &&
    bytes[2] === 0xff &&
    bytes[3] === 0x9b &&
    bytes.slice(4, 12).every((byte) => byte === 0)
  ) {
    return embeddedV4();
  }
  if (bytes[0] === 0x20 && bytes[1] === 0x02) {
    const classification = classifyIpv4([
      byteAt(bytes, 2),
      byteAt(bytes, 3),
      byteAt(bytes, 4),
      byteAt(bytes, 5),
    ]);
    // 6to4 is deprecated and not marked globally reachable. Preserve the
    // stronger metadata label, but otherwise reject the special-use range.
    return classification === "cloud_metadata" ? classification : "invalid";
  }

  if (
    IPV6_METADATA_ADDRESSES.some((address) =>
      bytes.every((byte, index) => byte === address[index]),
    )
  ) {
    return "cloud_metadata";
  }
  if (bytes[0] === 0xfe && (byteAt(bytes, 1) & 0xc0) === 0x80) {
    return "link_local";
  }
  if ((byteAt(bytes, 0) & 0xfe) === 0xfc) return "private";
  if (bytes[0] === 0xfe && (byteAt(bytes, 1) & 0xc0) === 0xc0) {
    return "private";
  }

  // Local-use NAT64.
  if (
    bytes[0] === 0x00 &&
    bytes[1] === 0x64 &&
    bytes[2] === 0xff &&
    bytes[3] === 0x9b &&
    bytes[4] === 0x00 &&
    bytes[5] === 0x01
  ) {
    return "private";
  }

  // Current IANA IPv6 special-purpose allocations that are not globally
  // reachable. More-specific globally reachable allocations inside
  // 2001::/23 are checked first, per the registry's exception rule.
  if (matchesPrefix(bytes, [0x01, 0x00, 0, 0, 0, 0, 0, 0], 64)) {
    return "invalid";
  }
  if (matchesPrefix(bytes, [0x01, 0x00, 0, 0, 0, 0, 0, 0x01], 64)) {
    return "invalid";
  }
  if (isGloballyReachableIetfAssignment(bytes)) return "public";
  if (matchesPrefix(bytes, [0x20, 0x01, 0x00], 23)) return "invalid";
  if (matchesPrefix(bytes, [0x20, 0x01, 0x0d, 0xb8], 32)) return "invalid";
  if (matchesPrefix(bytes, [0x3f, 0xff, 0x00], 20)) return "invalid";
  if (matchesPrefix(bytes, [0x5f, 0x00], 16)) return "invalid";
  if (bytes[0] === 0xff) return "invalid";

  // IPv6 global unicast is currently allocated from 2000::/3. Fail closed
  // for the rest of the unallocated/reserved address space.
  return (byteAt(bytes, 0) & 0xe0) === 0x20 ? "public" : "invalid";
}

function isGloballyReachableIetfAssignment(bytes: number[]): boolean {
  const exactAnycast = [
    [0x20, 0x01, 0x00, 0x01, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
    [0x20, 0x01, 0x00, 0x01, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2],
    [0x20, 0x01, 0x00, 0x01, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3],
  ];
  if (
    exactAnycast.some((address) =>
      bytes.every((byte, index) => byte === address[index]),
    )
  ) {
    return true;
  }
  return (
    matchesPrefix(bytes, [0x20, 0x01, 0x00, 0x03], 32) ||
    matchesPrefix(bytes, [0x20, 0x01, 0x00, 0x04, 0x01, 0x12], 48) ||
    matchesPrefix(bytes, [0x20, 0x01, 0x00, 0x20], 28) ||
    matchesPrefix(bytes, [0x20, 0x01, 0x00, 0x30], 28)
  );
}

function matchesPrefix(
  bytes: number[],
  prefix: readonly number[],
  bits: number,
): boolean {
  const wholeBytes = Math.floor(bits / 8);
  for (let index = 0; index < wholeBytes; index += 1) {
    if (bytes[index] !== prefix[index]) return false;
  }
  const remainingBits = bits % 8;
  if (remainingBits === 0) return true;
  const mask = (0xff << (8 - remainingBits)) & 0xff;
  const prefixByte = prefix[wholeBytes];
  return (
    prefixByte !== undefined &&
    (byteAt(bytes, wholeBytes) & mask) === (prefixByte & mask)
  );
}

function ipv6ToBytes(input: string): number[] | null {
  let value = input.toLowerCase();
  const zone = value.indexOf("%");
  if (zone >= 0) value = value.slice(0, zone);

  const halves = value.split("::");
  if (halves.length > 2) return null;

  const parseSide = (side: string): number[] | null => {
    if (!side) return [];
    const parts = side.split(":");
    const result: number[] = [];
    for (let index = 0; index < parts.length; index += 1) {
      const part = parts[index];
      if (part === undefined) return null;
      if (part.includes(".")) {
        if (index !== parts.length - 1) return null;
        const ipv4 = parseIpv4(part);
        if (!ipv4) return null;
        result.push(...ipv4);
        continue;
      }
      if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
      const group = Number.parseInt(part, 16);
      result.push((group >> 8) & 0xff, group & 0xff);
    }
    return result;
  };

  const head = parseSide(halves[0] ?? "");
  if (!head) return null;
  if (halves.length === 1) return head.length === 16 ? head : null;

  const tail = parseSide(halves[1] ?? "");
  if (!tail) return null;
  const fill = 16 - head.length - tail.length;
  if (fill < 2) return null;
  return [...head, ...new Array<number>(fill).fill(0), ...tail];
}

function byteAt(bytes: number[], index: number): number {
  const value = bytes[index];
  if (value === undefined) {
    throw new Error("IPv6 parser returned an incomplete address");
  }
  return value;
}
