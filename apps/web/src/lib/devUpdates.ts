/**
 * The words and the pure decisions behind the development updates screen.
 *
 * Kept out of the components so a test can pin them: which accounts a project
 * may post through and why the others are missing, what each status means to
 * somebody who never read the lifecycle, what a refusal code says, and the
 * exact command an owner pastes into a terminal.
 */

export type DevUpdateStatus =
  | 'PENDING_REVIEW'
  | 'APPROVED'
  | 'DISPATCHED'
  | 'PUBLISHED'
  | 'REHEARSED'
  | 'SKIPPED'
  | 'REJECTED'
  | 'FAILED'
  | 'CANCELLED';

export interface DevUpdateProject {
  id: string;
  projectKey: string;
  displayName: string;
  agentId: string;
  accountId: string;
  mode: 'DRAFT' | 'AUTO';
  enabled: boolean;
  dailyCap: number;
  minSpacingMinutes: number;
  rehearse: boolean;
  senderToken: { active: boolean; hint: string | null; issuedAt: string | null };
  lastDispatchReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DevUpdateHistoryEntry {
  at: string;
  status: DevUpdateStatus;
  actor: 'sender' | 'owner' | 'system';
  reason: string;
}

export interface DevUpdate {
  id: string;
  kind: string;
  title: string;
  summary: string;
  why: string;
  evidence: { type: string; ref: string | null; detail: string }[];
  post: string;
  proposedPost: string;
  edited: boolean;
  status: DevUpdateStatus;
  reason: string | null;
  url: string | null;
  jobId: string | null;
  history: DevUpdateHistoryEntry[];
  decidedAt: string | null;
  dispatchedAt: string | null;
  finishedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DevUpdateConnection {
  serverName: string;
  mcpServerPath: string | null;
  reason: string | null;
}

/** An audit row for a refused submission. It holds codes and field names, never the words. */
export interface RefusalRecord {
  id: string;
  entityId: string | null;
  data: { codes?: unknown; fields?: unknown };
  at: string;
}

/** The most a post may be, matching the server's rule. */
export const POST_MAX_CHARS = 280;

/** Mirrors the server's limits, so a choice offered here is one the server accepts. */
export const DAILY_CAP_CHOICES = [1, 2, 3, 4, 5, 6] as const;
export const SPACING_CHOICES = [30, 60, 120, 240, 480, 720, 1440] as const;

export const STATUS_WORDS: Record<DevUpdateStatus, string> = {
  PENDING_REVIEW: 'Waiting for you',
  APPROVED: 'Approved, waiting for a slot',
  DISPATCHED: 'With the agent',
  PUBLISHED: 'Published',
  REHEARSED: 'Rehearsed, not posted',
  SKIPPED: 'Skipped as a repeat',
  REJECTED: 'Rejected',
  FAILED: 'Failed',
  CANCELLED: 'Stopped',
};

export function statusTone(status: DevUpdateStatus): 'live' | 'wait' | 'fail' | 'idle' {
  switch (status) {
    case 'PUBLISHED':
      return 'live';
    case 'PENDING_REVIEW':
    case 'APPROVED':
    case 'DISPATCHED':
      return 'wait';
    case 'FAILED':
      return 'fail';
    default:
      return 'idle';
  }
}

export const KIND_WORDS: Record<string, string> = {
  FEATURE: 'Feature',
  FIX: 'Fix',
  IMPROVEMENT: 'Improvement',
  MILESTONE: 'Milestone',
  RELEASE: 'Release',
};

export const ACTOR_WORDS: Record<DevUpdateHistoryEntry['actor'], string> = {
  sender: 'Your coding assistant',
  owner: 'You',
  system: 'AI17Z',
};

/**
 * What each refusal code means, in a sentence.
 *
 * The audit row keeps only the code and the field, because the words that
 * were refused must go nowhere. So the log can say why, but never what.
 */
const REFUSAL_WORDS: Record<string, string> = {
  NOT_PUBLIC: 'It was not marked as public.',
  NOT_MEANINGFUL: 'It did not say clearly what changed or why it matters.',
  SECRET: 'It contained something shaped like a password or key.',
  PRIVATE_LOCATION: 'It contained a private address, a local path or an email address.',
  RAW_CODE: 'It contained code or a diff.',
  ATTRIBUTION: 'It credited an assistant or automation.',
  HASHTAG_SPAM: 'It had more than one hashtag.',
  MENTION: 'It tagged a person or account.',
  TOO_LONG: 'The post was longer than 280 characters.',
  FILLER: 'It read like promotion, or had more than one link.',
  SENSITIVE: 'It described security or unreleased work.',
};

const FIELD_WORDS: Record<string, string> = {
  title: 'the title',
  summary: 'what changed',
  why: 'why it matters',
  evidence: 'the evidence',
  post: 'the post',
  disclosure: 'the public confirmation',
};

export function refusalSentences(record: RefusalRecord): { reasons: string[]; where: string | null } {
  const codes = Array.isArray(record.data.codes) ? record.data.codes.filter((c): c is string => typeof c === 'string') : [];
  const fields = Array.isArray(record.data.fields) ? record.data.fields.filter((f): f is string => typeof f === 'string') : [];
  const reasons = codes.map((code) => REFUSAL_WORDS[code] ?? 'It broke a sharing rule.');
  const named = fields.map((f) => FIELD_WORDS[f] ?? FIELD_WORDS[f.split('.')[0] ?? ''] ?? f);
  const unique = [...new Set(named)];
  return {
    reasons: reasons.length > 0 ? [...new Set(reasons)] : ['It broke a sharing rule.'],
    where: unique.length > 0 ? `Found in ${joinWords(unique)}.` : null,
  };
}

function joinWords(words: string[]): string {
  if (words.length <= 1) return words.join('');
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

export function spacingWords(minutes: number): string {
  if (minutes < 60) return `${minutes} minutes`;
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return hours === 1 ? '1 hour' : hours === 24 ? '1 day' : `${hours} hours`;
  }
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/** The project key a display name suggests, in the shape the server accepts. */
export function suggestKey(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/-+$/, '')
    .slice(0, 63);
}

export const KEY_PATTERN = /^[a-z0-9][a-z0-9._-]{1,62}$/;

export interface AccountChoice {
  accountId: string;
  handle: string;
  channel: string;
  /** Null when the project may post through it; otherwise the one sentence saying why not. */
  unavailable: string | null;
}

/**
 * Every account the agent is connected to, and whether a project may use it.
 *
 * The same order of checks the server makes when the project is saved, so an
 * account offered here is one the server accepts, and an account withheld
 * says what would change that.
 */
export function accountChoices(
  accounts: { accountId: string; handle: string; channel: string; enabled: boolean; accountEnabled: boolean }[],
  grants: Record<string, string[]>,
): AccountChoice[] {
  return accounts.map((a) => {
    let unavailable: string | null = null;
    if (!a.accountEnabled) unavailable = `@${a.handle} is switched off.`;
    else if (!a.enabled) unavailable = `The agent's connection to @${a.handle} is switched off.`;
    else if (!(grants[a.accountId] ?? []).includes('POST')) unavailable = `The agent may not post through @${a.handle}.`;
    return { accountId: a.accountId, handle: a.handle, channel: a.channel, unavailable };
  });
}

/** Where the API is, as this browser reaches it. The MCP server calls the same address. */
export function apiUrlFrom(base: string, origin: string): string {
  return (base || origin).replace(/\/+$/, '');
}

/**
 * The one line an owner pastes into a terminal.
 *
 * One line, because a backslash continues a line in bash and a backtick does
 * in PowerShell, and a command that works in one of them is a command that
 * fails for half the people pasting it. The path is quoted for the spaces a
 * Windows profile path usually has. The name comes straight after `add`:
 * `--env` takes any number of values, so a name placed after it would be read
 * as one more variable.
 */
export function mcpAddCommand(input: { serverName: string; apiUrl: string; token: string; projectKey: string; serverPath: string }): string {
  return [
    'claude mcp add',
    input.serverName,
    '--scope local',
    `--env AI17Z_API_URL=${input.apiUrl}`,
    `--env AI17Z_DEV_UPDATES_TOKEN=${input.token}`,
    `--env AI17Z_DEV_UPDATES_PROJECT=${input.projectKey}`,
    '--',
    'node',
    `"${input.serverPath}"`,
  ].join(' ');
}
