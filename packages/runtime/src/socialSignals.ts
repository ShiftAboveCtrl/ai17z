import { z } from 'zod';
import { defineCapability, registerCapability } from '@xbam/tools';

/**
 * Reading a set of public posts the caller supplies: where a narrative
 * started and how it spread, signs of coordination, who interacts with whom,
 * and a measured profile of one author's public writing.
 *
 * The posts are the caller's. AI17Z fetches nothing here, so nothing is read
 * from X or redistributed by this site, and every finding is about exactly
 * the set given: "earliest" is earliest in what was supplied. Everything is
 * deterministic and every finding names the posts it rests on.
 *
 * What these never do: accuse anybody, guess at motives or psychology, or
 * turn a pattern into a claim about a person. A coordination signal says
 * what was seen and how sure the pattern is, and says it is a signal.
 */

export const SuppliedPost = z
  .object({
    id: z.string().min(1).max(64),
    authorId: z.string().min(1).max(64),
    authorHandle: z.string().max(64).optional(),
    text: z.string().max(4_000),
    createdAt: z.string().datetime(),
    replyTo: z.object({ postId: z.string().max(64).optional(), authorId: z.string().max(64) }).strict().optional(),
    quoteOf: z.object({ postId: z.string().max(64).optional(), authorId: z.string().max(64) }).strict().optional(),
    repostOf: z.object({ postId: z.string().max(64).optional(), authorId: z.string().max(64) }).strict().optional(),
    mentions: z.array(z.string().max(64)).max(50).optional(),
  })
  .strict();
export type SuppliedPost = z.infer<typeof SuppliedPost>;

const Posts = z.array(SuppliedPost).min(1).max(500);

const STOP = new Set(
  'a an and are as at be but by for from has have he her his i if in into is it its just me my no not of on or our she so that the their them then there they this to too up us was we were what when which who will with you your rt via amp'.split(' '),
);

/** Text reduced to its words: no links, mentions, numbers, case or punctuation. */
export function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[@#$][\w]+/g, ' ')
    .replace(/\d+/g, ' ')
    .replace(/[^\p{L}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function shingles(text: string, n = 4): Set<string> {
  const words = normalizeText(text).split(' ').filter(Boolean);
  const out = new Set<string>();
  if (words.length < n) {
    if (words.length > 0) out.add(words.join(' '));
    return out;
  }
  for (let i = 0; i + n <= words.length; i += 1) out.add(words.slice(i, i + n).join(' '));
  return out;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  return inter / (a.size + b.size - inter);
}

const time = (p: SuppliedPost) => Date.parse(p.createdAt);

// ---------------------------------------------------------------------------
// Coordination

export interface CoordinationSignal {
  kind: 'TEMPLATE_REUSE' | 'SYNCHRONIZED_POSTING' | 'CONCENTRATED_AMPLIFICATION';
  /** How strong the pattern is in the set given; never a verdict about anybody. */
  strength: 'WEAK' | 'MODERATE' | 'STRONG';
  sentence: string;
  authors: string[];
  posts: string[];
}

/**
 * Patterns that coordinated posting leaves, found in the set given: the same
 * wording from several authors, several authors posting near-identical text
 * within a minute, and amplification concentrated in a few accounts. Each is
 * a signal with the posts behind it. People post alike for innocent reasons,
 * which is why none of this is ever an accusation.
 */
export function coordinationSignals(posts: readonly SuppliedPost[]): { signals: CoordinationSignal[]; caveat: string } {
  const originals = posts.filter((p) => !p.repostOf && normalizeText(p.text).split(' ').length >= 5);
  const sh = originals.map((p) => shingles(p.text));
  // Union-find over near-identical originals by different authors.
  const parent = originals.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  for (let i = 0; i < originals.length; i += 1) {
    for (let j = i + 1; j < originals.length; j += 1) {
      if (originals[i]!.authorId !== originals[j]!.authorId && jaccard(sh[i]!, sh[j]!) >= 0.7) parent[find(i)] = find(j);
    }
  }
  const groups = new Map<number, SuppliedPost[]>();
  originals.forEach((p, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), p]));

  const signals: CoordinationSignal[] = [];
  for (const group of groups.values()) {
    const authors = [...new Set(group.map((p) => p.authorId))];
    if (authors.length < 3) continue;
    const span = Math.max(...group.map(time)) - Math.min(...group.map(time));
    signals.push({
      kind: 'TEMPLATE_REUSE',
      strength: authors.length >= 10 ? 'STRONG' : authors.length >= 5 ? 'MODERATE' : 'WEAK',
      sentence: `${authors.length} authors posted near-identical wording across ${Math.round(span / 60_000)} minute(s).`,
      authors,
      posts: group.map((p) => p.id),
    });
    // The same group posting within a minute of each other is a second, stronger pattern.
    const sorted = [...group].sort((a, b) => time(a) - time(b));
    let best: SuppliedPost[] = [];
    for (let i = 0; i < sorted.length; i += 1) {
      const window = sorted.filter((p) => time(p) >= time(sorted[i]!) && time(p) - time(sorted[i]!) <= 60_000);
      if (new Set(window.map((p) => p.authorId)).size > new Set(best.map((p) => p.authorId)).size) best = window;
    }
    const inMinute = [...new Set(best.map((p) => p.authorId))];
    if (inMinute.length >= 3) {
      signals.push({
        kind: 'SYNCHRONIZED_POSTING',
        strength: inMinute.length >= 8 ? 'STRONG' : inMinute.length >= 5 ? 'MODERATE' : 'WEAK',
        sentence: `${inMinute.length} authors posted that wording within one minute.`,
        authors: inMinute,
        posts: best.map((p) => p.id),
      });
    }
  }

  const amplifying = posts.filter((p) => p.repostOf || p.quoteOf);
  if (amplifying.length >= 10) {
    const counts = new Map<string, number>();
    for (const p of amplifying) counts.set(p.authorId, (counts.get(p.authorId) ?? 0) + 1);
    const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    const top = ranked.slice(0, 3);
    const share = top.reduce((n, [, c]) => n + c, 0) / amplifying.length;
    if (share >= 0.6 && counts.size >= 3) {
      signals.push({
        kind: 'CONCENTRATED_AMPLIFICATION',
        strength: share >= 0.85 ? 'STRONG' : share >= 0.7 ? 'MODERATE' : 'WEAK',
        sentence: `${top.length} accounts made ${Math.round(share * 100)}% of the ${amplifying.length} reposts and quotes in this set.`,
        authors: top.map(([a]) => a),
        posts: amplifying.filter((p) => top.some(([a]) => a === p.authorId)).map((p) => p.id),
      });
    }
  }
  return {
    signals,
    caveat: 'Signals in the posts supplied, not findings about anybody. People share wording and post together for innocent reasons; none of this says who did what or why.',
  };
}

// ---------------------------------------------------------------------------
// Narrative genesis

export interface NarrativeReport {
  matched: number;
  earliest: { postId: string; authorId: string; at: string } | null;
  originAuthors: string[];
  propagation: { hour: string; posts: number; authors: number }[];
  variants: { wording: string; firstSeen: string; postId: string; count: number }[];
  amplifiers: { authorId: string; amplifications: number }[];
  caveat: string;
}

/**
 * Where a narrative appears first in the set given, and how it spread: the
 * earliest posts naming it, hour by hour after that, the wordings it took in
 * the order they first appeared, and who amplified it most. "Earliest" is
 * earliest among the posts supplied; a set that starts late cannot see an
 * earlier origin, and this says so.
 */
export function narrativeGenesis(posts: readonly SuppliedPost[], term: string): NarrativeReport {
  const needle = normalizeText(term);
  const matched = posts.filter((p) => needle && normalizeText(p.text).includes(needle)).sort((a, b) => time(a) - time(b));
  const caveat = 'Earliest within the posts supplied. An origin before the earliest post given cannot be seen here.';
  if (matched.length === 0) return { matched: 0, earliest: null, originAuthors: [], propagation: [], variants: [], amplifiers: [], caveat };

  const first = matched[0]!;
  // Everything within ten minutes of the first sighting counts as the origin.
  const originAuthors = [...new Set(matched.filter((p) => time(p) - time(first) <= 10 * 60_000).map((p) => p.authorId))];
  const hours = new Map<string, { posts: number; authors: Set<string> }>();
  for (const p of matched) {
    const hour = new Date(Math.floor(time(p) / 3_600_000) * 3_600_000).toISOString();
    const h = hours.get(hour) ?? { posts: 0, authors: new Set<string>() };
    h.posts += 1;
    h.authors.add(p.authorId);
    hours.set(hour, h);
  }
  const variants = new Map<string, { firstSeen: string; postId: string; count: number }>();
  for (const p of matched.filter((x) => !x.repostOf)) {
    const wording = normalizeText(p.text).slice(0, 140);
    const v = variants.get(wording);
    if (v) v.count += 1;
    else variants.set(wording, { firstSeen: p.createdAt, postId: p.id, count: 1 });
  }
  const amp = new Map<string, number>();
  const ids = new Set(matched.map((p) => p.id));
  for (const p of posts) {
    const target = p.repostOf ?? p.quoteOf;
    if (target?.postId && ids.has(target.postId)) amp.set(p.authorId, (amp.get(p.authorId) ?? 0) + 1);
  }
  return {
    matched: matched.length,
    earliest: { postId: first.id, authorId: first.authorId, at: first.createdAt },
    originAuthors,
    propagation: [...hours.entries()].map(([hour, h]) => ({ hour, posts: h.posts, authors: h.authors.size })),
    variants: [...variants.entries()].slice(0, 20).map(([wording, v]) => ({ wording, ...v })),
    amplifiers: [...amp.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([authorId, amplifications]) => ({ authorId, amplifications })),
    caveat,
  };
}

// ---------------------------------------------------------------------------
// Relationship graph

export interface RelationshipEdge {
  from: string;
  to: string;
  kind: 'REPLY' | 'MENTION' | 'QUOTE' | 'REPOST';
  count: number;
  firstAt: string;
  lastAt: string;
  posts: string[];
}

/** Who replied to, mentioned, quoted and reposted whom in the set given, with when and the posts behind each edge. */
export function relationshipGraph(posts: readonly SuppliedPost[]): { nodes: string[]; edges: RelationshipEdge[] } {
  const edges = new Map<string, RelationshipEdge>();
  const add = (from: string, to: string, kind: RelationshipEdge['kind'], p: SuppliedPost) => {
    if (from === to) return;
    const key = `${from}|${to}|${kind}`;
    const e = edges.get(key) ?? { from, to, kind, count: 0, firstAt: p.createdAt, lastAt: p.createdAt, posts: [] };
    e.count += 1;
    if (p.createdAt < e.firstAt) e.firstAt = p.createdAt;
    if (p.createdAt > e.lastAt) e.lastAt = p.createdAt;
    if (e.posts.length < 20) e.posts.push(p.id);
    edges.set(key, e);
  };
  for (const p of posts) {
    if (p.replyTo) add(p.authorId, p.replyTo.authorId, 'REPLY', p);
    if (p.quoteOf) add(p.authorId, p.quoteOf.authorId, 'QUOTE', p);
    if (p.repostOf) add(p.authorId, p.repostOf.authorId, 'REPOST', p);
    for (const m of new Set(p.mentions ?? [])) add(p.authorId, m, 'MENTION', p);
  }
  const list = [...edges.values()].sort((a, b) => b.count - a.count);
  return { nodes: [...new Set(list.flatMap((e) => [e.from, e.to]))], edges: list };
}

// ---------------------------------------------------------------------------
// Persona profile

export interface PublicProfile {
  authorId: string;
  posts: number;
  span: { from: string; to: string };
  topics: { term: string; posts: number }[];
  style: { medianLength: number; questionShare: number; linkShare: number; replyShare: number };
  caveat: string;
}

/**
 * One author's public writing, measured: what they write about most, how long
 * and how often they ask, link and reply. Measurements, not adjectives, and
 * nothing about who they are, what they believe beyond what they wrote, or
 * how they feel.
 */
export function publicProfile(posts: readonly SuppliedPost[], authorId: string): PublicProfile | null {
  const own = posts.filter((p) => p.authorId === authorId && !p.repostOf).sort((a, b) => time(a) - time(b));
  if (own.length === 0) return null;
  const terms = new Map<string, Set<string>>();
  for (const p of own) {
    for (const w of new Set(normalizeText(p.text).split(' '))) {
      if (w.length < 4 || STOP.has(w)) continue;
      terms.set(w, (terms.get(w) ?? new Set()).add(p.id));
    }
  }
  const lengths = own.map((p) => p.text.length).sort((a, b) => a - b);
  const share = (f: (p: SuppliedPost) => boolean) => Math.round((own.filter(f).length / own.length) * 100) / 100;
  return {
    authorId,
    posts: own.length,
    span: { from: own[0]!.createdAt, to: own.at(-1)!.createdAt },
    topics: [...terms.entries()]
      .filter(([, ids]) => ids.size >= 2)
      .sort((a, b) => b[1].size - a[1].size)
      .slice(0, 12)
      .map(([term, ids]) => ({ term, posts: ids.size })),
    style: {
      medianLength: lengths[Math.floor(lengths.length / 2)]!,
      questionShare: share((p) => p.text.includes('?')),
      linkShare: share((p) => /https?:\/\//.test(p.text)),
      replyShare: share((p) => Boolean(p.replyTo)),
    },
    caveat: 'Measured from the posts supplied. Says nothing about the person beyond what they wrote publicly.',
  };
}

// ---------------------------------------------------------------------------
// Capabilities

const common = { category: 'READ' as const, effect: 'READ' as const, risk: 'LOW' as const, modelCallable: true, timeoutMs: 10_000 };

export const coordinationCapability = defineCapability({
  ...common,
  id: 'social.coordination_signals',
  name: 'Signs of coordinated posting',
  description:
    'In a set of public posts you supply: the same wording from several authors, several authors posting it within a minute, and amplification concentrated in a few accounts. Signals with the posts behind them, never an accusation.',
  input: z.object({ posts: Posts }).strict(),
  output: z.object({ signals: z.array(z.record(z.unknown())), caveat: z.string() }),
  async run(input) {
    return coordinationSignals(input.posts) as never;
  },
});

export const narrativeCapability = defineCapability({
  ...common,
  id: 'social.narrative_genesis',
  name: 'Where a narrative started',
  description:
    'In a set of public posts you supply: the earliest posts naming a term, how it spread hour by hour, the wordings it took, and who amplified it. Earliest within what was supplied.',
  input: z.object({ posts: Posts, term: z.string().trim().min(2).max(120) }).strict(),
  output: z.object({ matched: z.number(), earliest: z.unknown(), caveat: z.string() }).passthrough(),
  async run(input) {
    return narrativeGenesis(input.posts, input.term) as never;
  },
});

export const relationshipCapability = defineCapability({
  ...common,
  id: 'social.relationship_graph',
  name: 'Who interacts with whom',
  description: 'In a set of public posts you supply: replies, mentions, quotes and reposts between authors, with counts, first and last seen, and the posts behind each.',
  input: z.object({ posts: Posts }).strict(),
  output: z.object({ nodes: z.array(z.string()), edges: z.array(z.record(z.unknown())) }),
  async run(input) {
    return relationshipGraph(input.posts) as never;
  },
});

export const profileCapability = defineCapability({
  ...common,
  id: 'social.public_profile',
  name: 'An author’s public writing, measured',
  description:
    'From public posts you supply by one author: the subjects they write about most and measurements of how they write. Nothing about the person beyond what they wrote.',
  input: z.object({ posts: Posts, authorId: z.string().min(1).max(64) }).strict(),
  output: z.object({ profile: z.unknown() }),
  async run(input) {
    return { profile: publicProfile(input.posts, input.authorId) };
  },
});

export function registerSocialSignalCapabilities(): void {
  registerCapability(coordinationCapability);
  registerCapability(narrativeCapability);
  registerCapability(relationshipCapability);
  registerCapability(profileCapability);
}
