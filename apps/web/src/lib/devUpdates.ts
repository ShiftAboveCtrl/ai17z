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

// ── Whether this project really publishes ──────────────────────────────────

/** What the agent's own policy says, as far as this screen needs it. Null while unknown. */
export interface AgentPublishing {
  dryRunDefault: boolean;
  automationMode: string;
}

export type PublishingHeldBy = 'PROJECT_PAUSED' | 'PROJECT_REHEARSES' | 'AGENT_DRY_RUN' | 'AGENT_AUTOMATION' | null;

export interface PublishingState {
  /** A word or two for the header. */
  words: string;
  tone: 'live' | 'wait' | 'calm' | 'unknown';
  heldBy: PublishingHeldBy;
  /** One sentence naming the switch that holds publishing, or saying nothing does. */
  sentence: string;
}

/**
 * Which switch, if any, stops an approved update reaching the account.
 *
 * There are two rehearsal switches and the dispatcher honours both: the
 * project's own, and the agent's "dry run by default", which a new agent has
 * on. A header that read only the project's flag said "posting for real" over
 * a project whose every update was rehearsing. The order is the order an owner
 * would fix them in: this project first, then the agent. Until the agent's
 * policy has been read, nothing is claimed.
 */
export function publishingState(
  project: Pick<DevUpdateProject, 'enabled' | 'rehearse'>,
  agent: AgentPublishing | null,
): PublishingState {
  if (!project.enabled) {
    return { words: 'Paused', tone: 'wait', heldBy: 'PROJECT_PAUSED', sentence: 'This project is paused, so nothing is handed to the agent.' };
  }
  if (project.rehearse) {
    return {
      words: 'Rehearsing',
      tone: 'calm',
      heldBy: 'PROJECT_REHEARSES',
      sentence: "This project rehearses: approved updates are checked end to end and not published.",
    };
  }
  if (!agent) return { words: 'Checking', tone: 'unknown', heldBy: null, sentence: "Reading the agent's own settings." };
  if (agent.dryRunDefault) {
    return {
      words: 'Rehearsing',
      tone: 'calm',
      heldBy: 'AGENT_DRY_RUN',
      sentence: "The agent's own policy runs everything as a dry run, so updates still rehearse. Turn off Dry run by default in the agent's policies to publish.",
    };
  }
  if (agent.automationMode === 'OFF' || agent.automationMode === 'MONITOR_ONLY') {
    return {
      words: 'Held by the agent',
      tone: 'wait',
      heldBy: 'AGENT_AUTOMATION',
      sentence: `The agent's automation is ${agent.automationMode.toLowerCase().replace(/_/g, ' ')}, so nothing is posted. Change it in the agent's policies.`,
    };
  }
  return { words: 'Posting for real', tone: 'live', heldBy: null, sentence: 'Approved updates are published on the account.' };
}

// ── The command, only when it can work ─────────────────────────────────────

export const MCP_SERVER_FILE = 'dev-updates-mcp.mjs';

/**
 * The command to offer, or why there is none yet.
 *
 * A command with a placeholder in it is a command that fails when pasted, and
 * a copy button says it is ready. So when the installation cannot say where
 * its MCP server is (a container, a missing file), the owner is asked for the
 * path on their own machine first, and no command exists until they give one.
 */
export function commandState(input: {
  connection: DevUpdateConnection | null;
  localPath: string;
  apiUrl: string;
  token: string;
  projectKey: string;
}): { command: string | null; needsLocalPath: boolean; pathProblem: string | null } {
  if (!input.connection) return { command: null, needsLocalPath: false, pathProblem: null };
  const known = input.connection.mcpServerPath;
  const typed = input.localPath.trim().replace(/^"(.*)"$/, '$1');
  const path = known ?? typed;
  const needsLocalPath = known === null;
  if (!path) return { command: null, needsLocalPath, pathProblem: null };
  // Absolute, because Claude Code starts the server from wherever it happens
  // to be running, and a relative path works from one folder only.
  const absolute = /^(?:[A-Za-z]:[\\/]|\/|\\\\)/.test(path);
  if (!absolute || !path.replace(/\\/g, '/').endsWith(`/${MCP_SERVER_FILE}`)) {
    return { command: null, needsLocalPath, pathProblem: `Give the full path to ${MCP_SERVER_FILE} on your machine, from the drive or root to the file name.` };
  }
  if (path.includes('"')) return { command: null, needsLocalPath, pathProblem: 'The path cannot contain a quotation mark.' };
  return {
    command: mcpAddCommand({ serverName: input.connection.serverName, apiUrl: input.apiUrl, token: input.token, projectKey: input.projectKey, serverPath: path }),
    needsLocalPath,
    pathProblem: null,
  };
}

// ── What the log leaves out ────────────────────────────────────────────────

export const LOG_LIMIT = 200;
export const REFUSAL_LIMIT = 200;

/** Said under the log when a list came back full, so a missing old entry is not a mystery. */
export function logTruncation(updates: number, auditRows: number): string | null {
  const parts: string[] = [];
  if (updates >= LOG_LIMIT) parts.push(`This shows the newest ${LOG_LIMIT} updates; older ones are kept but not listed here.`);
  if (auditRows >= REFUSAL_LIMIT) {
    parts.push(`Refusals come from the newest ${REFUSAL_LIMIT} refusal records on this installation, so older ones are not listed.`);
  }
  return parts.length > 0 ? parts.join(' ') : null;
}
