/**
 * Deciding whether an address belongs to the internet or to this machine.
 *
 * This is the whole of server-side request forgery in one question. An agent
 * that fetches a URL somebody else chose is a way to reach whatever the machine
 * running it can reach -- a database on the Docker network, a metadata service
 * holding cloud credentials, an admin page on loopback that trusts anything
 * arriving locally. None of those are reachable from outside; all of them are
 * reachable from here.
 *
 * So the rule is the opposite of an allowlist of bad things: an address is
 * refused unless it is a public one. A new private range added to a standard in
 * five years is then refused by default rather than allowed until somebody
 * notices, which is the direction this has to fail in.
 *
 * ### Why this is separate and pure
 *
 * Because it is the part worth testing exhaustively, and a function that takes
 * a string and returns a verdict can be. The fetching around it is plumbing.
 */

/** Why an address was refused, in words a person can act on. */
export interface AddressVerdict {
  allowed: boolean;
  /** Empty when allowed. */
  why: string;
}

function refuse(why: string): AddressVerdict {
  return { allowed: false, why };
}

function allow(): AddressVerdict {
  return { allowed: true, why: '' };
}

/** Parses dotted-quad IPv4 into four octets, or nothing. */
function octets(address: string): number[] | null {
  const parts = address.split('.');
  if (parts.length !== 4) return null;
  const numbers = parts.map((part) => {
    // Rejecting leading zeros deliberately: "0177.0.0.1" is octal for 127.0.0.1
    // in some resolvers and decimal-looking to a careless parser, which is a
    // classic way past a check like this one.
    if (!/^\d{1,3}$/.test(part)) return Number.NaN;
    if (part.length > 1 && part.startsWith('0')) return Number.NaN;
    return Number(part);
  });
  if (numbers.some((n) => Number.isNaN(n) || n > 255)) return null;
  return numbers;
}

function ipv4Verdict(address: string): AddressVerdict {
  const parts = octets(address);
  if (!parts) return refuse(`"${address}" is not an address this understands, so it is refused.`);
  const [a, b] = parts as [number, number, number, number];

  if (a === 0) return refuse('0.0.0.0/8 is "this network" and never a destination.');
  if (a === 10) return refuse('10.0.0.0/8 is a private network.');
  if (a === 127) return refuse('127.0.0.0/8 is this machine.');
  if (a === 100 && b >= 64 && b <= 127) {
    // Where Alibaba keeps its metadata service, among other things.
    return refuse('100.64.0.0/10 is carrier-grade NAT, not the public internet.');
  }
  if (a === 169 && b === 254) {
    return refuse('169.254.0.0/16 is link-local, and is where cloud metadata services live.');
  }
  if (a === 172 && b >= 16 && b <= 31) return refuse('172.16.0.0/12 is a private network, and where Docker puts things.');
  if (a === 192 && b === 168) return refuse('192.168.0.0/16 is a private network.');

  const [, , c] = parts as [number, number, number, number];
  // 192.0.0.0/24 is protocol assignments; 192.0.2.0/24 is TEST-NET-1. Both sit
  // inside 192.0, and only the second is a documentation range.
  if (a === 192 && b === 0 && c === 0) return refuse('192.0.0.0/24 is reserved for protocol assignments.');
  if (a === 192 && b === 0 && c === 2) return refuse('192.0.2.0/24 is a documentation range, not a real host.');
  if (a === 198 && b === 51 && c === 100) return refuse('198.51.100.0/24 is a documentation range.');
  if (a === 203 && b === 0 && c === 113) return refuse('203.0.113.0/24 is a documentation range.');
  // Deprecated in 2015 and still routed oddly in places.
  if (a === 192 && b === 88 && c === 99) return refuse('192.88.99.0/24 is the deprecated 6to4 relay anycast range.');
  if (a === 198 && (b === 18 || b === 19)) return refuse('198.18.0.0/15 is reserved for benchmarking.');
  if (a >= 224) return refuse(`${address} is multicast or reserved, not a host.`);
  return allow();
}

/**
 * Expands an IPv6 address into its sixteen bytes, or nothing.
 *
 * Written out rather than pulled in, because the only question asked of it is
 * which range the address is in and a dependency for that is a dependency to
 * keep up to date for ever.
 */
function ipv6Bytes(address: string): number[] | null {
  let text = address.trim().toLowerCase();
  if (text.startsWith('[') && text.endsWith(']')) text = text.slice(1, -1);
  // A zone index ("%eth0") says which interface, which only local addresses have.
  const percent = text.indexOf('%');
  if (percent >= 0) text = text.slice(0, percent);

  // An IPv4-mapped or -compatible tail, "::ffff:192.168.0.1".
  const lastColon = text.lastIndexOf(':');
  const tail = text.slice(lastColon + 1);
  if (tail.includes('.')) {
    const parts = octets(tail);
    if (!parts) return null;
    const head = text.slice(0, lastColon + 1);
    const hex = `${((parts[0]! << 8) | parts[1]!).toString(16)}:${((parts[2]! << 8) | parts[3]!).toString(16)}`;
    text = head + hex;
  }

  const halves = text.split('::');
  if (halves.length > 2) return null;
  const readGroups = (part: string): number[] | null => {
    if (part === '') return [];
    const groups: number[] = [];
    for (const group of part.split(':')) {
      if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
      groups.push(Number.parseInt(group, 16));
    }
    return groups;
  };

  const left = readGroups(halves[0] ?? '');
  const right = halves.length === 2 ? readGroups(halves[1] ?? '') : [];
  if (!left || !right) return null;

  const missing = 8 - left.length - right.length;
  if (halves.length === 1 && left.length !== 8) return null;
  if (halves.length === 2 && missing < 0) return null;

  const groups = halves.length === 2 ? [...left, ...Array<number>(missing).fill(0), ...right] : left;
  if (groups.length !== 8) return null;
  return groups.flatMap((group) => [(group >> 8) & 0xff, group & 0xff]);
}

function ipv6Verdict(address: string): AddressVerdict {
  const bytes = ipv6Bytes(address);
  if (!bytes) return refuse(`"${address}" is not an address this understands, so it is refused.`);

  // These two first, because the IPv4-compatible test below is a prefix of
  // twelve zero bytes and both of these are that. Refusing ::1 with the words
  // "0.0.0.0/8 is this network" is still a refusal, and still wrong -- and the
  // reason is the half a person can act on.
  if (bytes.every((b, i) => (i < 15 ? b === 0 : b === 1))) return refuse('::1 is this machine.');
  if (bytes.every((b) => b === 0)) return refuse(':: is "unspecified" and never a destination.');

  // An IPv4 address wearing an IPv6 hat. "::ffff:127.0.0.1" is loopback, and a
  // check that only looked at the v6 ranges would wave it through.
  const mapped = bytes.slice(0, 10).every((b) => b === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
  const compatible = bytes.slice(0, 12).every((b) => b === 0);
  if (mapped || compatible) return ipv4Verdict(`${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`);
  if ((bytes[0]! & 0xfe) === 0xfc) return refuse('fc00::/7 is a private network.');
  if (bytes[0] === 0xfe && (bytes[1]! & 0xc0) === 0x80) {
    return refuse('fe80::/10 is link-local, and is where cloud metadata services live.');
  }
  if (bytes[0] === 0xff) return refuse(`${address} is multicast, not a host.`);

  // The i-th 16-bit group, not the i-th byte. Reading by byte steps across a
  // group boundary and compares half of one field with half of the next, which
  // refused 2001:4860:4860::8888 as a protocol assignment and let a NAT64
  // address through -- both caught by the tests below.
  const group = (i: number) => ((bytes[i * 2]! << 8) | bytes[i * 2 + 1]!) >>> 0;
  // 2001:db8::/32, the documentation range, and the one most likely to appear
  // in a copied example.
  if (group(0) === 0x2001 && group(1) === 0x0db8) return refuse('2001:db8::/32 is a documentation range.');
  // 2001::/23 is IETF protocol assignments -- Teredo, ORCHID and friends. Not
  // ordinary destinations, and Teredo in particular is a tunnel to somewhere.
  if (group(0) === 0x2001 && group(1) < 0x0200) return refuse('2001::/23 is reserved for protocol assignments.');
  // 64:ff9b::/96 and 64:ff9b:1::/48 carry IPv4 inside them, so an address there
  // is an IPv4 destination wearing a third hat.
  if (group(0) === 0x0064 && group(1) === 0xff9b) {
    return ipv4Verdict(`${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`);
  }
  // 100::/64 is the discard-only range: a packet sent there goes nowhere.
  if (group(0) === 0x0100 && group(1) === 0 && group(2) === 0 && group(3) === 0) {
    return refuse('100::/64 is discard-only, so nothing there can answer.');
  }
  return allow();
}

/**
 * Whether one resolved address may be connected to.
 *
 * Takes an address rather than a hostname on purpose. A hostname is a promise
 * about an address and this has to judge the address itself -- `localtest.me`
 * and a thousand others resolve to 127.0.0.1, and no list of bad hostnames ever
 * catches them all.
 */
export function addressVerdict(address: string): AddressVerdict {
  const trimmed = address.trim();
  if (!trimmed) return refuse('An empty address is refused.');
  if (trimmed.includes(':')) return ipv6Verdict(trimmed);
  return ipv4Verdict(trimmed);
}
