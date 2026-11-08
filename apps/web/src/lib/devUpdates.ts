/**
 * The words and the pure decisions behind the development updates screen.
 *
 * Kept out of the components so a test can pin them: which accounts a project
 * may post through and why the others are missing, what each status means to
 * somebody who never read the lifecycle, what a refusal code says, and the
 * exact command an owner pastes into a terminal.
 */

import { PolicyConfig } from '@xbam/shared/contracts';

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

/**
 * The agent's switches, from an agent detail, only if it is the agent this
 * project maps to now.
 *
 * A project can be rewired to another agent. The detail on screen can then
 * still be the previous agent's, while the new one loads or for ever if that
 * request fails, and its dry run setting would be reported for an agent that
 * no longer posts here. A detail for any other agent reads as not known yet.
 *
 * An agent with no stored policy is read through the same schema the
 * dispatcher uses, so its defaults (dry run on) are what this reports.
 */
export function agentPublishingFor(
  detail: { agent: { id: string }; policy: { config: unknown } | null } | null,
  agentId: string,
): AgentPublishing | null {
  if (!detail || detail.agent.id !== agentId) return null;
  const automation = PolicyConfig.parse(detail.policy?.config ?? {}).automation;
  return { dryRunDefault: automation.dryRunDefault, automationMode: automation.mode };
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
  /** Why the agent's settings could not be read, when they could not. */
  agentError: string | null = null,
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
  if (!agent && agentError) {
    return {
      words: 'Unknown',
      tone: 'unknown',
      heldBy: null,
      sentence: `The agent's own settings could not be read, so whether updates are published is not known: ${agentError}`,
    };
  }
  if (!agent) {
    return { words: 'Checking', tone: 'unknown', heldBy: null, sentence: "Still reading the agent's own settings; nothing is claimed until they are known." };
  }
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

/*
  Every value that goes into the pasted command is checked against an
  allowlist, because the command is run by a shell the owner chose and three
  of them read it differently. Inside double quotes bash and zsh still expand
  `$(...)`, backticks and `$VAR`, PowerShell expands `$(...)` and `$var`, and
  cmd expands `%VAR%` and, with delayed expansion, `!VAR!`. Escaping for one
  shell is wrong for the others, so nothing that any of them treats specially
  is let in at all: a value either consists of plain characters or there is
  no command, and the owner is told which value and why.
*/

/** A path segment: letters and digits in any script, space, dot, dash, underscore, round brackets. */
const SAFE_SEGMENT = String.raw`[\p{L}\p{N} ._()-]+`;
const SAFE_WINDOWS_PATH = new RegExp(String.raw`^[A-Za-z]:[\\/](?:${SAFE_SEGMENT}[\\/])*dev-updates-mcp\.mjs$`, 'u');
const SAFE_POSIX_PATH = new RegExp(String.raw`^/(?:${SAFE_SEGMENT}/)*dev-updates-mcp\.mjs$`, 'u');
/** The characters a safe path may contain at all, so a refusal can say which kind of problem it is. */
const SAFE_PATH_CHARS = /^[\p{L}\p{N} ._():\\/-]*$/u;

/**
 * An http address with nothing a shell expands: no `~`, no glob characters,
 * no brackets (so an IPv6 literal is refused rather than quoted), no query.
 */
const SAFE_API_URL = /^https?:\/\/[A-Za-z0-9.-]+(?::\d{1,5})?(?:\/[A-Za-z0-9._/-]*)?$/;
const SAFE_TOKEN = /^ai17z_dus_[A-Za-z0-9_-]{16,128}$/;
const SAFE_SERVER_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

export type PathVerdict = 'ok' | 'empty' | 'unsafe' | 'shape';

/** Whether a path may be pasted into a terminal command as it is. */
export function checkServerPath(path: string): PathVerdict {
  if (!path) return 'empty';
  if (!SAFE_PATH_CHARS.test(path)) return 'unsafe';
  return SAFE_WINDOWS_PATH.test(path) || SAFE_POSIX_PATH.test(path) ? 'ok' : 'shape';
}

const PATH_UNSAFE_SENTENCE =
  'That path has characters a terminal could treat as part of a command. Use a path of letters, digits, spaces, dots, dashes, underscores and round brackets only.';
const PATH_SHAPE_SENTENCE = `Give the full path to ${MCP_SERVER_FILE} on your machine, starting with a drive letter such as C:\\ or with /, and ending in the file name.`;

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
}): {
  command: string | null;
  needsLocalPath: boolean;
  /** The installation knows its path, but it cannot be pasted safely, so the owner is asked instead. */
  installPathUnsafe: boolean;
  pathProblem: string | null;
  /** A value other than the path that cannot go into a command. */
  problem: string | null;
} {
  const none = { command: null, needsLocalPath: false, installPathUnsafe: false, pathProblem: null, problem: null };
  if (!input.connection) return none;
  if (!SAFE_SERVER_NAME.test(input.connection.serverName)) {
    return { ...none, problem: 'This installation named its MCP server in a way that cannot be pasted safely, so no command is offered.' };
  }
  if (!SAFE_API_URL.test(input.apiUrl)) {
    return {
      ...none,
      problem: `AI17Z is open at an address (${input.apiUrl}) that cannot be pasted into a terminal safely. Open it by a host name or IPv4 address, without a query, to get a command.`,
    };
  }
  if (!KEY_PATTERN.test(input.projectKey)) return { ...none, problem: 'The project key cannot be pasted into a terminal safely, so no command is offered.' };
  if (!SAFE_TOKEN.test(input.token)) return { ...none, problem: 'The token is not in the expected form, so no command is offered. Issue a new one.' };

  const known = input.connection.mcpServerPath;
  const installPathUnsafe = known !== null && checkServerPath(known) !== 'ok';
  const needsLocalPath = known === null || installPathUnsafe;
  // One pair of surrounding quotes is forgiven, because "Copy as path" on
  // Windows adds them. Anything else is judged as typed.
  const typed = input.localPath.trim().replace(/^"(.*)"$|^'(.*)'$/, '$1$2');
  const path = needsLocalPath ? typed : known!;
  const verdict = checkServerPath(path);
  const base = { ...none, needsLocalPath, installPathUnsafe };
  if (verdict === 'empty') return base;
  if (verdict === 'unsafe') return { ...base, pathProblem: PATH_UNSAFE_SENTENCE };
  // Absolute, because the coding assistant starts the server from wherever it
  // happens to be running, and a relative path works from one folder only.
  if (verdict === 'shape') return { ...base, pathProblem: PATH_SHAPE_SENTENCE };
  return {
    ...base,
    command: mcpAddCommand({ serverName: input.connection.serverName, apiUrl: input.apiUrl, token: input.token, projectKey: input.projectKey, serverPath: path }),
  };
}

// ── Creating a project, and the one moment its token exists ────────────────

/**
 * The new project dialog, as a state machine.
 *
 * Creating a project issues its sender token in the same response, and that
 * response is the only time the token exists outside the server. Two things
 * went wrong with it before this was a machine of its own: the dialog was
 * remounted on the first project and lost a token it had just been handed,
 * and a response arriving after the dialog closed was still revealed when it
 * opened again.
 *
 * Every close starts a new generation. A response is shown only if it belongs
 * to the generation it was asked in; a later one is recorded as an orphan:
 * the project exists, because the server made it, but its token is dropped
 * and never shown. On reopening, the owner is told so, and pointed at the
 * project's Connect tab to issue a replacement.
 */
export interface CreationState {
  generation: number;
  /** The generation a request is in flight for, if one is. */
  pending: number | null;
  revealed: { project: DevUpdateProject; token: string } | null;
  orphan: DevUpdateProject | null;
}

export type CreationEvent =
  | { type: 'submit' }
  | { type: 'succeeded'; generation: number; project: DevUpdateProject; token: string }
  | { type: 'failed'; generation: number }
  | { type: 'close' }
  | { type: 'dismissOrphan' };

export const INITIAL_CREATION: CreationState = { generation: 0, pending: null, revealed: null, orphan: null };

export function creationReducer(state: CreationState, event: CreationEvent): CreationState {
  switch (event.type) {
    case 'submit':
      return { ...state, pending: state.generation };
    case 'succeeded':
      if (event.generation === state.generation) {
        return { ...state, pending: null, revealed: { project: event.project, token: event.token } };
      }
      // Asked for in a dialog that has since closed. The token goes nowhere.
      return { ...state, orphan: event.project };
    case 'failed':
      return event.generation === state.generation ? { ...state, pending: null } : state;
    case 'close':
      return { ...state, generation: state.generation + 1, pending: null, revealed: null };
    case 'dismissOrphan':
      return { ...state, orphan: null };
  }
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
