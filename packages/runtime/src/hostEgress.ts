import { addressVerdict } from '@xbam/upstream';
import { EGRESS_DENIED_CIDRS, type EgressPolicy } from '@xbam/shared';

/**
 * Keeping a tenant guest off the infrastructure it is running on.
 *
 * Firecracker's design document says, in as many words, that it performs no
 * network traffic filtering and that filtering belongs at the host level. So
 * this is work AI17Z owes rather than something it inherits by choosing a
 * hypervisor, and it is the half of tenant isolation that a hypervisor choice
 * does not buy.
 *
 * What is denied is infrastructure, never content. A hosted agent researching
 * the open web is the product working; a hosted agent reaching the cloud
 * metadata endpoint is a credential theft. Nothing here is about geography and
 * nothing here exists to get past anybody else's security controls.
 *
 * Three things this module deliberately does not do.
 *
 * It does not judge an address itself. `addressVerdict` in `@xbam/upstream`
 * already does, it is tested against the cases that are easy to get wrong
 * (IPv4-mapped IPv6, NAT64, the 16-bit group boundary), and two answers to one
 * question is the thing this codebase keeps saying it does not want.
 *
 * It does not load a ruleset. Loading needs root on a host and is the one part
 * no test on a developer's machine can prove, so what is here is a plan, a
 * soundness check on the plan, and a check of a ruleset read back from the
 * host. A rule that was generated is not a rule that is loaded.
 *
 * And it does not treat a hostname as an address. A name is a promise about an
 * address and the promise can change between the check and the connection,
 * which is why the packet filter works on addresses and the name list is
 * returned separately for the layer that resolves.
 */

// ---------------------------------------------------------------------------
// What may never be reached
// ---------------------------------------------------------------------------

/**
 * The denials no configuration can remove.
 *
 * `EgressPolicy.deniedCidrs` defaults to this list, and a default is something
 * somebody can overwrite with an empty array. So the effective denials are the
 * union rather than whatever the policy happens to say, and emptying the field
 * widens nothing.
 */
export const MANDATORY_DENIALS: readonly string[] = EGRESS_DENIED_CIDRS;

/** Every CIDR a tenant may not reach, whatever the policy was set to. */
export function effectiveDenials(policy?: Partial<EgressPolicy>): readonly string[] {
  const out = new Set<string>(MANDATORY_DENIALS);
  for (const cidr of policy?.deniedCidrs ?? []) {
    const trimmed = cidr.trim();
    if (trimmed) out.add(trimmed);
  }
  return [...out];
}

/** Which address family a CIDR belongs to. A ruleset needs them apart. */
export function addressFamilyOf(cidr: string): 'ip' | 'ip6' {
  return cidr.includes(':') ? 'ip6' : 'ip';
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

export interface EgressRule {
  action: 'DENY' | 'ALLOW';
  family: 'ip' | 'ip6';
  /** A CIDR, or `any` for the final verdict on everything else. */
  target: string;
  /** Said in a sentence, because a ruleset nobody can read is a ruleset nobody audits. */
  why: string;
}

export interface EgressPlan {
  /**
   * What happens to a packet no rule matched.
   *
   * Always `DROP`. A base policy of accept means every future mistake is an
   * open door rather than a blocked connection, and the asymmetry is the whole
   * argument: a missing allow is a support ticket and a missing deny is an
   * incident.
   */
  basePolicy: 'DROP';
  /** In order. Denials before any allow, which `planIsSound` checks. */
  rules: readonly EgressRule[];
  /**
   * Names a tenant may not reach, for the layer that resolves them.
   *
   * Deliberately not in `rules`: a packet filter cannot match a hostname, and
   * a rule claiming to would be matching whatever that name resolved to when
   * the ruleset was written.
   */
  deniedHosts: readonly string[];
}

/**
 * Turns a policy into an ordered plan.
 *
 * Denials first, every one of them, both families, and then one verdict on
 * everything else. The ordering is not a style: in a first-match ruleset an
 * allow placed above a deny silently defeats it, which is exactly the mistake
 * that is invisible in a diff.
 */
export function egressPlan(policy?: Partial<EgressPolicy>): EgressPlan {
  const rules: EgressRule[] = [];
  for (const cidr of effectiveDenials(policy)) {
    rules.push({
      action: 'DENY',
      family: addressFamilyOf(cidr),
      target: cidr,
      why: whyDenied(cidr),
    });
  }

  const publicInternet = policy?.publicInternet ?? true;
  for (const family of ['ip', 'ip6'] as const) {
    rules.push({
      action: publicInternet ? 'ALLOW' : 'DENY',
      family,
      target: 'any',
      why: publicInternet
        ? 'Ordinary public egress. A hosted agent reading the open web is the product working.'
        : 'This runtime has no business on the internet at all.',
    });
  }

  return {
    basePolicy: 'DROP',
    rules,
    deniedHosts: [...new Set((policy?.deniedHosts ?? []).map((h) => h.trim().toLowerCase()).filter(Boolean))],
  };
}

/** Why one of the mandatory denials is there, for the ruleset's own comments. */
function whyDenied(cidr: string): string {
  if (cidr.startsWith('169.254.169.254')) {
    return 'Cloud instance metadata, on every major provider. The most valuable single address to a compromised guest.';
  }
  if (cidr.startsWith('169.254.') || cidr.startsWith('fe80:')) {
    return 'Link-local, which carries more than metadata.';
  }
  if (cidr.startsWith('127.') || cidr.startsWith('::1')) {
    return "Loopback, which from inside a guest means the guest's own services.";
  }
  if (cidr.startsWith('0.0.0.0') || cidr.startsWith('255.255.255.255')) {
    return 'Unspecified and broadcast.';
  }
  if (cidr.startsWith('100.64.')) {
    return 'Carrier-grade NAT, which is a private network in practice.';
  }
  return 'A private network: the control plane, other tenants, management networks.';
}

// ---------------------------------------------------------------------------
// Is the plan the plan it should be
// ---------------------------------------------------------------------------

export type PlanVerdict = { ok: true } | { ok: false; problems: readonly string[] };

/**
 * Checks a plan against the properties that make it worth having.
 *
 * Every problem rather than the first, because somebody fixing a ruleset wants
 * the whole list and a second run to find the second fault is a second chance
 * to ship it.
 */
export function planIsSound(plan: EgressPlan): PlanVerdict {
  const problems: string[] = [];

  if (plan.basePolicy !== 'DROP') {
    problems.push('The base policy must be DROP. A missing allow is a support ticket; a missing deny is an incident.');
  }

  const denied = new Set(plan.rules.filter((r) => r.action === 'DENY').map((r) => r.target));
  for (const must of MANDATORY_DENIALS) {
    if (!denied.has(must)) problems.push(`${must} is not denied, and no configuration may remove it.`);
  }

  // An allowlist that forgets v6 is not one, and a guest with a v6 route gets
  // to the same places by the other family.
  for (const family of ['ip', 'ip6'] as const) {
    if (!plan.rules.some((r) => r.action === 'DENY' && r.family === family)) {
      problems.push(`Nothing is denied on ${family}, so a guest reaches everything by that family.`);
    }
  }

  // First match wins, so an allow above a deny defeats it. Checked per family,
  // because a ruleset is matched within one.
  for (const family of ['ip', 'ip6'] as const) {
    const ofFamily = plan.rules.filter((r) => r.family === family);
    const firstAllow = ofFamily.findIndex((r) => r.action === 'ALLOW');
    const lastDeny = ofFamily.map((r) => r.action).lastIndexOf('DENY');
    if (firstAllow !== -1 && lastDeny > firstAllow) {
      problems.push(`On ${family} an allow sits above a deny, which silently defeats it.`);
    }
  }

  for (const rule of plan.rules) {
    if (!rule.why.trim()) problems.push(`${rule.action} ${rule.target} carries no reason.`);
  }

  return problems.length === 0 ? { ok: true } : { ok: false, problems };
}

// ---------------------------------------------------------------------------
// Rendering, and checking what actually loaded
// ---------------------------------------------------------------------------

/**
 * Renders the plan as an nftables ruleset for one tenant interface.
 *
 * Text rather than a loaded ruleset, because loading needs root on a host and
 * is the one step a test here cannot prove. It is rendered with its reasons as
 * comments so that somebody reading `nft list ruleset` on a host at three in
 * the morning is reading the same sentences as somebody reading this file.
 */
export function nftablesRuleset(plan: EgressPlan, iface: string): string {
  if (!/^[A-Za-z0-9_.-]{1,15}$/.test(iface)) {
    // An interface name reaches a shell-adjacent file, so it is validated to
    // the kernel's own shape rather than trusted.
    throw new Error(`${iface} is not a valid interface name.`);
  }

  const lines: string[] = [
    '# Generated by AI17Z. Tenant egress.',
    '# Firecracker filters no guest traffic; this is the filtering.',
    `table inet ai17z_tenant_${iface.replace(/[.-]/g, '_')} {`,
    '  chain forward {',
    '    type filter hook forward priority 0; policy drop;',
    '    ct state established,related accept',
  ];
  for (const rule of plan.rules) {
    const verb = rule.action === 'DENY' ? 'drop' : 'accept';
    const match = rule.target === 'any' ? `meta nfproto ${rule.family === 'ip' ? 'ipv4' : 'ipv6'}` : `${rule.family} daddr ${rule.target}`;
    lines.push(`    iifname "${iface}" ${match} ${verb} comment "${rule.why.replace(/"/g, "'")}"`);
  }
  lines.push('  }', '}', '');
  return lines.join('\n');
}

/**
 * Whether a ruleset actually names a CIDR, rather than merely containing its
 * characters.
 *
 * `10.0.0.0/8` contains `0.0.0.0/8`, so a plain substring test let a host pass
 * on the strength of a different rule: the unspecified range could have failed
 * to load and the private range would have covered for it. The boundary is
 * anything that is not a digit or a dot before, and not a digit after, which
 * is how an address appears in `nft list ruleset` and in every other rendering
 * of one.
 *
 * And a kernel does not print back what it was given. `nft list ruleset`
 * renders a single-host prefix without it: `169.254.169.254/32` comes back as
 * `169.254.169.254` and `::1/128` as `::1`. Measured against a real kernel,
 * which is the only way this was going to be noticed: the first version of
 * this function reported three correctly loaded denials as missing, and a
 * check that always fails is a check an operator learns to ignore, which is
 * how a real failure gets missed.
 *
 * So a full-length prefix is accepted in either spelling. Any other prefix
 * length is matched exactly, because `10.0.0.0/8` and `10.0.0.0` are different
 * claims and accepting the second for the first would be the substring bug
 * again in a new coat.
 */
function mentions(text: string, cidr: string): boolean {
  const forms = [cidr, ...bareFormOf(cidr)];
  return forms.some((form) => {
    const escaped = form.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Nothing that could be part of a longer address before, and no digit or
    // prefix separator after: `169.254.169.254` must not be matched inside
    // `169.254.169.254/32` when looking for the bare form, nor inside a
    // longer address.
    return new RegExp(`(^|[^0-9.:])${escaped}(?![0-9/])`).test(text);
  });
}

/**
 * The address alone, where the prefix covers exactly one host.
 *
 * Empty for anything shorter, so a range is never satisfied by its own base
 * address appearing somewhere.
 */
function bareFormOf(cidr: string): string[] {
  const [address, prefix] = cidr.split('/');
  if (!address || !prefix) return [];
  const single = address.includes(':') ? prefix === '128' : prefix === '32';
  return single ? [address] : [];
}

export type EnforcementVerdict =
  | { enforced: true }
  | { enforced: false; missing: readonly string[]; why: string };

/**
 * Checks a ruleset read back off the host against the mandatory denials.
 *
 * This exists because a rule that was generated is not a rule that is loaded,
 * and the difference is invisible: a host whose ruleset failed to apply looks
 * exactly like one where it did until a guest reaches the metadata endpoint.
 * The same reasoning as the packager running a TypeScript transform rather than
 * checking that the files are present.
 */
export function verifyLoadedRuleset(observed: string, plan: EgressPlan = egressPlan()): EnforcementVerdict {
  const text = observed ?? '';
  if (!text.trim()) {
    return {
      enforced: false,
      missing: [...MANDATORY_DENIALS],
      why: 'Nothing was read back from the host, which is not the same as nothing being denied.',
    };
  }

  const missing = plan.rules
    .filter((r) => r.action === 'DENY' && r.target !== 'any' && !mentions(text, r.target))
    .map((r) => r.target);

  if (missing.length > 0) {
    return {
      enforced: false,
      missing,
      why: 'The loaded ruleset does not carry every mandatory denial, so a tenant can reach what it names.',
    };
  }

  // A drop policy is the floor. A ruleset carrying every denial above an
  // accept policy is one rule away from allowing everything.
  if (!/policy\s+drop/.test(text)) {
    return {
      enforced: false,
      missing: [],
      why: 'The loaded chain does not drop by default, so anything the denials do not name is permitted.',
    };
  }

  return { enforced: true };
}

// ---------------------------------------------------------------------------
// At the moment of connecting
// ---------------------------------------------------------------------------

export type ConnectVerdict = { allowed: true } | { allowed: false; why: string };

/**
 * Whether one resolved address may be connected to from a tenant runtime.
 *
 * Delegates to `addressVerdict`, which judges an address rather than a name
 * for the reason it was written: `localtest.me` and a thousand others resolve
 * to 127.0.0.1, and no list of bad hostnames ever catches them all. This is
 * belt as well as braces: the packet filter is the boundary and this is what
 * stops a request before it becomes a packet, so a host whose ruleset failed
 * to load is not left with nothing.
 */
export function mayConnectTo(address: string): ConnectVerdict {
  const verdict = addressVerdict(address);
  return verdict.allowed ? { allowed: true } : { allowed: false, why: verdict.why };
}

/** Whether a hostname is on the policy's name list. Exact or a parent domain. */
export function hostIsDenied(hostname: string, plan: EgressPlan): boolean {
  const name = hostname.trim().toLowerCase().replace(/\.$/, '');
  if (!name) return true;
  return plan.deniedHosts.some((denied) => name === denied || name.endsWith(`.${denied}`));
}

// ---------------------------------------------------------------------------
// What this does not do
// ---------------------------------------------------------------------------

/**
 * Said out loud, because egress filtering is the kind of control that gets
 * described as complete and is never complete.
 */
export const ENFORCEMENT_CAVEATS: readonly string[] = [
  'A plan is not a loaded ruleset. Loading needs root on the host, and verifyLoadedRuleset is what checks the host rather than the intention.',
  'A hostname is not an address. A name allowed at check time can resolve somewhere else at connect time, which is why the filter works on addresses.',
  "This denies infrastructure, not content. It is not a content filter, not a geographic restriction, and not a way past anybody else's controls.",
  'A tenant that reaches the public internet can reach a proxy on the public internet. Egress filtering bounds what the infrastructure exposes, not what a determined guest can see.',
  'IPv6 is denied by the same list. A host that routes v6 without these rules loaded is unfiltered on that family whatever the v4 rules say.',
];
