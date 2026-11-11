import { z } from 'zod';
import { sha256Hex } from '@xbam/shared';

/**
 * What a development update may say, decided before anything is stored.
 *
 * Pure on purpose: every rule here runs at submission, again when the owner
 * edits, and again at the moment of dispatch, and a rule that needed the
 * database could not be the same rule in all three places.
 *
 * The errors are not symmetric, so the rules lean towards refusing. A refused
 * update costs the sender one rewrite. A secret, a private address or somebody's
 * source code on a public account cannot be taken back, and a post that says an
 * assistant wrote it tells everybody who reads it the account is automated.
 *
 * A refusal never repeats what it refused. Messages name the field and the rule
 * and nothing else, because the response, the log line and the audit row are
 * all places a pasted token would otherwise end up.
 */

export const DEV_UPDATE_EVIDENCE_TYPES = [
  'COMMIT',
  'PULL_REQUEST',
  'ISSUE',
  'RELEASE',
  'TEST',
  'BENCHMARK',
  'NOTE',
] as const;
export type DevUpdateEvidenceType = (typeof DEV_UPDATE_EVIDENCE_TYPES)[number];

/** References that identify one piece of work, so the same work is not announced twice. */
const KEYED_EVIDENCE: readonly DevUpdateEvidenceType[] = ['COMMIT', 'PULL_REQUEST', 'ISSUE', 'RELEASE'];

export const DevUpdateSubmissionInput = z.object({
  projectKey: z.string().trim().toLowerCase().min(2).max(63),
  kind: z.enum(['FEATURE', 'FIX', 'IMPROVEMENT', 'MILESTONE', 'RELEASE']),
  title: z.string().trim().min(1).max(120),
  summary: z.string().trim().min(1).max(600),
  why: z.string().trim().min(1).max(300),
  evidence: z
    .array(
      z.object({
        type: z.enum(DEV_UPDATE_EVIDENCE_TYPES),
        ref: z.string().trim().max(80).optional().nullable(),
        detail: z.string().trim().min(1).max(200),
      }),
    )
    .min(1)
    .max(8),
  /**
   * The sender's explicit statement that every fact above may be made public.
   * A string rather than a boolean so it cannot be satisfied by a default.
   */
  disclosure: z.string(),
  /** A post the sender wrote. Absent means AI17Z composes one from the facts. */
  post: z.string().trim().min(1).max(400).optional(),
  /**
   * Files uploaded first (`POST /api/dev-updates/sender/media`) that go with the
   * post, by the id that upload returned. Ids, never paths: nothing here names
   * a place on anybody's disk.
   */
  mediaIds: z.array(z.uuid()).max(4).optional(),
  /** Makes a retried submission safe: the same id twice is the same update. */
  // An identifier, not prose: anything else is refused before it is read, and
  // only a hash of it is ever stored.
  clientRequestId: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9._:-]{8,100}$/, 'Use 8 to 100 letters, digits, dots, colons, dashes or underscores.')
    .optional(),
});
export type DevUpdateSubmissionInput = z.infer<typeof DevUpdateSubmissionInput>;

export type DevUpdateRefusalCode =
  | 'NOT_PUBLIC'
  | 'NOT_MEANINGFUL'
  | 'SECRET'
  | 'PRIVATE_LOCATION'
  | 'RAW_CODE'
  | 'ATTRIBUTION'
  | 'HASHTAG_SPAM'
  | 'MENTION'
  | 'TOO_LONG'
  | 'FILLER'
  | 'SENSITIVE';

/**
 * Security and embargoed work, refused whatever the sender asserts.
 *
 * "disclosure: PUBLIC" is the sender's judgement, and the one class of fact
 * where a wrong judgement hands somebody a way in is an unpatched weakness:
 * an auth bypass announced before the fix is deployed is an instruction. So is
 * anything the facts themselves call unreleased, under embargo or internal.
 * This is deliberately broad, including security fixes that are out: the owner
 * can say those in their own words, and a missed refusal cannot be undone.
 */
const SENSITIVE =
  /\b(?:vulnerab\w*|exploit\w*|cve-\d{4}-\d+|zero[-\s]?day|0-?day|auth(?:entication|orization)?\s+bypass\w*|bypass(?:es|ed|ing)?\s+(?:the\s+)?(?:auth\w*|login|sign[-\s]?in|2fa|mfa|permission\w*|access control)|privilege\s+escalation|remote\s+code\s+execution|rce|sql\s+injection|sqli|xss|cross[-\s]site\s+scripting|csrf|ssrf|path\s+traversal|security\s+(?:hole|flaw|issue|bug|fix|patch|advisory|incident|vulnerabilit\w*)|data\s+breach|breach(?:ed)?|leak(?:ed|s|ing)?\s+(?:credentials?|keys?|tokens?|secrets?|data|passwords?)|unpatched|embargo\w*|under\s+nda|nda\b|confidential|internal[-\s]only|not\s+(?:yet\s+)?(?:public|released|announced)|unreleased|unannounced|do\s+not\s+(?:share|publish|post)|stealth\s+mode|private\s+beta)\b/i;

export function looksSensitive(text: string): boolean {
  return SENSITIVE.test(text);
}

export interface DevUpdateRefusal {
  code: DevUpdateRefusalCode;
  field: string;
  message: string;
}

export const PUBLIC_DISCLOSURE = 'PUBLIC';
export const POST_MAX_CHARS = 280;

// ── Secrets ─────────────────────────────────────────────────────────────────

const SECRET_PATTERNS: readonly RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\b(?:sk|pk|rk)[-_](?:live|test|proj|ant|or)?[-_]?[A-Za-z0-9_-]{16,}/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bglpat-[A-Za-z0-9_-]{16,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bAIza[0-9A-Za-z_-]{30,}/,
  /\bai17z_[a-z]+_[A-Za-z0-9_-]{16,}/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./,
  /\bbearer\s+[A-Za-z0-9._~+/-]{16,}/i,
  /\b(?:api[_-]?key|secret|token|password|passwd|pwd|private[_-]?key|client[_-]?secret)\s*[:=]\s*\S{6,}/i,
  // A connection string with a password in it.
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:[^\s@/]+@/i,
  // Sixty-four hex characters is a private key as often as it is a hash, and a
  // commit is identified by forty at most.
  /\b(?:0x)?[0-9a-fA-F]{64,}\b/,
];

/**
 * A long run of mixed-case letters and digits with no spaces. API keys look
 * like this and prose does not. Hex is exempt, because a commit sha is the
 * commonest legitimate long token in a development update.
 */
function hasHighEntropyToken(text: string): boolean {
  for (const match of text.matchAll(/[A-Za-z0-9+_=-]{32,}/g)) {
    const token = match[0];
    if (/^[0-9a-fA-F]+$/.test(token)) continue;
    if (/[A-Z]/.test(token) && /[a-z]/.test(token) && /[0-9]/.test(token)) return true;
  }
  return false;
}

export function looksSecret(text: string): boolean {
  return SECRET_PATTERNS.some((p) => p.test(text)) || hasHighEntropyToken(text);
}

// ── Private locations ───────────────────────────────────────────────────────

const PRIVATE_HOST =
  /^(?:localhost|.*\.(?:local|localhost|internal|lan|home|corp|intranet|ts\.net|test|invalid|example))$/i;

function urlIsPrivate(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    // Something URL-shaped that does not parse is not something to publish.
    return true;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return true;
  if (url.username || url.password) return true;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!host.includes('.') || PRIVATE_HOST.test(host)) return true;
  if (/^[\d.]+$/.test(host) || host.includes(':')) return true;
  // A signed or tokenised link is a credential with a path.
  if (/[?&](?:token|key|sig|signature|access_token|auth|secret|code)=/i.test(url.search)) return true;
  return false;
}

export function findUrls(text: string): string[] {
  return [...text.matchAll(/\b[a-z][a-z0-9+.-]*:\/\/[^\s)>\]"']+/gi)].map((m) => m[0].replace(/[.,;:!?]+$/, ''));
}

export function looksPrivateLocation(text: string): boolean {
  if (findUrls(text).some(urlIsPrivate)) return true;
  if (/\b(?:\d{1,3}\.){3}\d{1,3}\b/.test(text)) return true;
  if (/\b[A-Za-z]:\\[^\s]/.test(text)) return true;
  if (/(?:^|[\s(`'"])(?:~\/|\/Users\/|\/home\/|\/root\/|\/etc\/|\/var\/|\/private\/|\/mnt\/)/.test(text)) return true;
  if (/\\\\[A-Za-z0-9._-]+\\/.test(text)) return true;
  if (/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i.test(text)) return true;
  return false;
}

// ── Raw code and diffs ──────────────────────────────────────────────────────

const CODE_PATTERNS: readonly RegExp[] = [
  /^diff --git /m,
  /^@@ [-+]\d/m,
  /^(?:\+\+\+|---) [ab]\//m,
  /```/,
  /\bimport\s+[\w{}*,\s]+\s+from\s+['"]/,
  /\brequire\(\s*['"]/,
  /\b(?:function|def|fn|func)\s+\w+\s*\([^)]*\)\s*[{:]/,
  /=>\s*\{/,
  /\bconsole\.\w+\(/,
  // Upper case only: "select a model from the list" is prose.
  /\bSELECT\s+[\w*,\s.]+\s+FROM\s+\w+/,
  /^#include\s*</m,
  /\n\s+at\s+\S+\s+\(.*:\d+:\d+\)/,
  /\b[\w-]+\.(?:ts|tsx|js|mjs|py|go|rs|java|cs|rb|php|sql|ps1|sh):\d+/,
];

export function looksLikeRawCode(text: string): boolean {
  if (CODE_PATTERNS.some((p) => p.test(text))) return true;
  // Diff lines carry no space after the marker; a bulleted list does.
  const diffLines = text.split('\n').filter((line) => /^[+-][^\s+-]/.test(line)).length;
  if (diffLines >= 2) return true;
  const symbols = (text.match(/[{}();=<>[\]]/g) ?? []).length;
  return text.length > 40 && symbols / text.length > 0.08;
}

// ── Saying something ────────────────────────────────────────────────────────

const GENERIC_TITLES = new Set([
  'update',
  'updates',
  'bug fix',
  'bug fixes',
  'bugfix',
  'bugfixes',
  'fix',
  'fixes',
  'misc',
  'changes',
  'improvements',
  'cleanup',
  'clean up',
  'refactor',
  'refactoring',
  'chore',
  'wip',
  'work in progress',
  'stuff',
  'tweaks',
  'progress',
  'new version',
  'release',
]);

function normalise(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function wordCount(text: string): number {
  return normalise(text).split(' ').filter(Boolean).length;
}

/** Housekeeping, the same set `worthNoticing` declines for a watched repository. */
const HOUSEKEEPING = /^(?:chore|ci|docs|build|style|test|tests|refactor|deps)(?:\([^)]*\))?!?:/i;
const DEPENDENCY_BUMP = /\b(?:bump(?:ed|s)?|upgrade[ds]?|update[ds]?)\b.{0,40}\b(?:dependenc\w*|deps|lockfile|package-lock|yarn\.lock|pnpm-lock)\b/i;
const GENERIC_PHRASE = /^(?:minor|small|various|misc(?:ellaneous)?|some|general|several|a few)\s+(?:fixes|changes|tweaks|improvements|updates|cleanups?)\b/i;

function meaningRefusals(input: DevUpdateSubmissionInput): DevUpdateRefusal[] {
  const out: DevUpdateRefusal[] = [];
  const title = normalise(input.title);
  if (title.length < 6 || GENERIC_TITLES.has(title) || GENERIC_PHRASE.test(input.title)) {
    out.push({ code: 'NOT_MEANINGFUL', field: 'title', message: 'The title has to name what changed, not that something did.' });
  }
  if (input.summary.length < 40 || wordCount(input.summary) < 7 || GENERIC_PHRASE.test(input.summary)) {
    out.push({
      code: 'NOT_MEANINGFUL',
      field: 'summary',
      message: 'The summary has to say what is different now, in at least a sentence of seven words or more.',
    });
  }
  if (input.why.length < 15 || wordCount(input.why) < 3) {
    out.push({ code: 'NOT_MEANINGFUL', field: 'why', message: 'Say why it matters to somebody using the project.' });
  }
  if (HOUSEKEEPING.test(input.title) || HOUSEKEEPING.test(input.summary)) {
    out.push({ code: 'NOT_MEANINGFUL', field: 'title', message: 'Housekeeping (chores, CI, docs, refactors) is not news.' });
  }
  if (DEPENDENCY_BUMP.test(input.title) || DEPENDENCY_BUMP.test(input.summary)) {
    out.push({ code: 'NOT_MEANINGFUL', field: 'summary', message: 'A dependency bump is not news on its own.' });
  }
  if (!input.evidence.some((e) => e.type !== 'NOTE')) {
    out.push({
      code: 'NOT_MEANINGFUL',
      field: 'evidence',
      message: 'At least one piece of evidence has to be a commit, pull request, issue, release, test or benchmark.',
    });
  }
  return out;
}

// ── The post itself ─────────────────────────────────────────────────────────

/**
 * Saying who or what wrote it.
 *
 * The sender is a coding assistant, which makes its own name the likeliest
 * slip and the most damaging one, so that is refused outright. Other vendors
 * are refused only in an attribution shape: a project that adds support for a
 * model provider has to be able to say so.
 */
const ATTRIBUTION_PATTERNS: readonly RegExp[] = [
  /\bclaude\b/i,
  /\bco-?authored-?by\b/i,
  /\bas an ai\b/i,
  /🤖/u,
  /\b(?:written|generated|posted|drafted|created|built|coded|shipped|fixed|made|done|authored|helped)\s+(?:by|with|using|via|thanks to)\s+(?:an?\s+|my\s+|our\s+)?(?:ai|bot|agent|assistant|automation|model|llm|robot|chatgpt|gpt[-\s]?\d*|copilot|gemini|cursor|codex|anthropic|openai)\b/i,
  /\b(?:ai|bot|agent|assistant|llm|machine)[-\s](?:generated|written|authored|assisted|drafted|powered post)\b/i,
  // Not "automated" or "scheduled" on their own: a project about automation has
  // to be able to say its scheduled posts got better.
  /\bauto-?(?:posted|generated)\b/i,
  /\b(?:my|our|the)\s+(?:ai|bot|agent|assistant)\s+(?:wrote|did|built|fixed|shipped|made|coded|posted)\b/i,
  /\bthis (?:post|update|tweet) (?:is|was) (?:automated|written|generated|posted)\b/i,
];

const FILLER =
  /\b(?:excited to (?:announce|share)|thrilled to|game[-\s]?changer|revolutioni[sz]\w*|stay tuned|big things (?:are )?coming|huge update|massive update|next level|don'?t miss (?:out|it)|link in bio|smash that|let'?s go+|buckle up|the future is here)\b/i;

export function checkPostText(text: string): DevUpdateRefusal[] {
  const out: DevUpdateRefusal[] = [];
  const chars = [...text].length;
  if (chars > POST_MAX_CHARS) {
    out.push({ code: 'TOO_LONG', field: 'post', message: `The post is ${chars} characters and the most is ${POST_MAX_CHARS}.` });
  }
  if (chars < 30 || wordCount(text) < 6) {
    out.push({ code: 'NOT_MEANINGFUL', field: 'post', message: 'The post is too short to tell anybody anything.' });
  }
  if (looksSecret(text)) out.push({ code: 'SECRET', field: 'post', message: 'The post contains something shaped like a credential.' });
  if (looksPrivateLocation(text)) {
    out.push({
      code: 'PRIVATE_LOCATION',
      field: 'post',
      message: 'The post contains a private address, local path, IP address or email address.',
    });
  }
  if (looksLikeRawCode(text)) out.push({ code: 'RAW_CODE', field: 'post', message: 'The post contains code or a diff.' });
  if (looksSensitive(text)) {
    out.push({
      code: 'SENSITIVE',
      field: 'post',
      message: 'Security issues and unreleased, embargoed or internal work are never shared as development updates.',
    });
  }
  if (ATTRIBUTION_PATTERNS.some((p) => p.test(text))) {
    out.push({
      code: 'ATTRIBUTION',
      field: 'post',
      message: 'The post says or implies an assistant, agent or automation wrote it. Write it as the person shipping the work.',
    });
  }
  const hashtags = (text.match(/(?:^|\s)#[\p{L}\p{N}_]+/gu) ?? []).length;
  if (hashtags > 1) out.push({ code: 'HASHTAG_SPAM', field: 'post', message: `The post has ${hashtags} hashtags; one at most.` });
  if (/(?:^|[^\w])@[A-Za-z0-9_]{1,15}\b/.test(text)) {
    out.push({ code: 'MENTION', field: 'post', message: 'Development updates do not tag people or accounts.' });
  }
  if (findUrls(text).length > 1) {
    out.push({ code: 'FILLER', field: 'post', message: 'One link at most.' });
  }
  const emoji = (text.match(/\p{Extended_Pictographic}/gu) ?? []).length;
  const exclamations = (text.match(/!/g) ?? []).length;
  if (FILLER.test(text) || emoji > 2 || exclamations > 2) {
    out.push({ code: 'FILLER', field: 'post', message: 'The post reads like promotion rather than a developer saying what shipped.' });
  }
  return out;
}

/** Every rule that applies to the facts, before any post exists. */
export function checkFacts(input: DevUpdateSubmissionInput): DevUpdateRefusal[] {
  const out: DevUpdateRefusal[] = [];
  if (input.disclosure !== PUBLIC_DISCLOSURE) {
    out.push({
      code: 'NOT_PUBLIC',
      field: 'disclosure',
      message: `Set disclosure to "${PUBLIC_DISCLOSURE}" only once every fact in this update is safe to publish.`,
    });
  }
  const fields: Array<[string, string]> = [
    ['title', input.title],
    ['summary', input.summary],
    ['why', input.why],
    ...input.evidence.flatMap((e, i): Array<[string, string]> => [
      [`evidence.${i}.detail`, e.detail],
      [`evidence.${i}.ref`, e.ref ?? ''],
    ]),
  ];
  for (const [field, value] of fields) {
    if (!value) continue;
    if (looksSecret(value)) out.push({ code: 'SECRET', field, message: `${field} contains something shaped like a credential.` });
    if (looksPrivateLocation(value)) {
      out.push({ code: 'PRIVATE_LOCATION', field, message: `${field} contains a private address, local path, IP or email address.` });
    }
    if (looksLikeRawCode(value)) out.push({ code: 'RAW_CODE', field, message: `${field} contains code or a diff. Describe the change instead.` });
    if (looksSensitive(value)) {
      out.push({
        code: 'SENSITIVE',
        field,
        message: `${field} describes a security issue or unreleased, embargoed or internal work. Those are never shared here, whatever the disclosure says.`,
      });
    }
  }
  out.push(...meaningRefusals(input));
  return out;
}

// ── Identity of an update ───────────────────────────────────────────────────

export function factFingerprint(kind: string, title: string): string {
  return sha256Hex(`${kind}|${normalise(title)}`);
}

export function textFingerprint(text: string): string {
  return sha256Hex(normalise(text));
}

export function evidenceKeys(evidence: DevUpdateSubmissionInput['evidence']): string[] {
  const keys = new Set<string>();
  for (const item of evidence) {
    if (!KEYED_EVIDENCE.includes(item.type) || !item.ref) continue;
    const ref = item.ref.trim().toLowerCase().replace(/^#/, '');
    if (!ref) continue;
    // Seven characters is the shortest sha anybody quotes, so a full sha and its
    // short form are one commit.
    const canonical = item.type === 'COMMIT' && /^[0-9a-f]{7,40}$/.test(ref) ? ref.slice(0, 7) : ref;
    keys.add(`${item.type}:${canonical}`);
  }
  return [...keys].sort();
}

// ── Composing a post from the facts ─────────────────────────────────────────

function sentence(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  if (!trimmed) return '';
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function bare(text: string): string {
  return text.trim().replace(/\s+/g, ' ').replace(/[.!?]+$/, '');
}

/** "Faster cold starts" becomes "faster cold starts"; "API keys rotate" keeps its acronym. */
function casual(text: string): string {
  const t = bare(text);
  if (t.length > 1 && /^[A-Z][a-z]/.test(t)) return t[0]!.toLowerCase() + t.slice(1);
  return t;
}

function firstSentence(text: string): string {
  const match = text.trim().match(/^.+?[.!?](?:\s|$)/);
  return sentence(match ? match[0] : text);
}

type Template = (f: { title: string; summary: string; why: string; project: string }) => string;

const TEMPLATES: Record<string, Template[]> = {
  FEATURE: [
    (f) => `${sentence(f.title)} ${sentence(f.summary)}`,
    (f) => `new in ${f.project}: ${casual(f.title)}. ${sentence(f.why)}`,
    (f) => `${sentence(f.summary)} ${sentence(f.why)}`,
    (f) => `shipped ${casual(f.title)} today. ${sentence(f.summary)}`,
  ],
  FIX: [
    (f) => `fixed ${casual(f.title)}. ${sentence(f.why)}`,
    (f) => `${sentence(f.summary)} ${sentence(f.why)}`,
    (f) => `one less bug in ${f.project}: ${casual(f.title)}. ${sentence(f.summary)}`,
    (f) => `tracked down ${casual(f.title)}. ${sentence(f.summary)}`,
  ],
  IMPROVEMENT: [
    (f) => `${sentence(f.title)} ${sentence(f.summary)}`,
    (f) => `small one, but it matters: ${casual(f.title)}. ${sentence(f.why)}`,
    (f) => `${sentence(f.summary)} ${sentence(f.why)}`,
  ],
  MILESTONE: [
    (f) => `${f.project} milestone: ${casual(f.title)}. ${sentence(f.summary)}`,
    (f) => `${sentence(f.title)} ${sentence(f.why)}`,
    (f) => `${sentence(f.summary)} ${sentence(f.why)}`,
  ],
  RELEASE: [
    (f) => `${f.project} ${bare(f.title)} is out. ${sentence(f.summary)}`,
    (f) => `new ${f.project} release, ${bare(f.title)}. ${sentence(f.why)}`,
    (f) => `${bare(f.title)} shipped. ${sentence(f.summary)}`,
  ],
};

function fits(text: string): boolean {
  return [...text].length <= POST_MAX_CHARS;
}

/**
 * A post in a developer's own register, from the facts alone.
 *
 * Varied by the update's own fingerprint rather than at random, so composing
 * the same update twice gives the same post and the text fingerprint means
 * something. Lower case openers and no sign-off, because that is how somebody
 * who just shipped a thing writes about it. Only used when the sender did not
 * write the post; either way the result goes through `checkPostText`.
 */
export function composePost(
  input: Pick<DevUpdateSubmissionInput, 'kind' | 'title' | 'summary' | 'why'>,
  projectName: string,
  seed: string,
): string {
  const templates = TEMPLATES[input.kind] ?? TEMPLATES.FEATURE!;
  const start = parseInt(seed.slice(0, 8), 16) % templates.length;
  const facts = { title: input.title, summary: input.summary, why: input.why, project: projectName };
  const shorter = { ...facts, summary: firstSentence(facts.summary), why: firstSentence(facts.why) };
  for (const variant of [facts, shorter]) {
    for (let i = 0; i < templates.length; i += 1) {
      const text = templates[(start + i) % templates.length]!(variant).replace(/\s+/g, ' ').trim();
      if (fits(text)) return text;
    }
  }
  // Nothing fitted: the title and the first sentence of the summary, cut at a word.
  let text = `${sentence(facts.title)} ${shorter.summary}`;
  while (!fits(text)) text = text.replace(/\s+\S+$/, '');
  return text;
}
