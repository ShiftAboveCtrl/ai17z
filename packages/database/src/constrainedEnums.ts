import {
  ACCOUNT_STATUSES,
  ACTION_STATUSES,
  ACTION_TYPES,
  AGENT_STATES,
  APPROVAL_STATUSES,
  AVATAR_MODES,
  BROWSER_CHANNELS,
  BROWSER_ENGINES,
  BROWSER_MODES,
  CHANNELS,
  DISPOSITIONS,
  ERROR_CLASSES,
  EVENT_TYPES,
  FAMILIARITY_LEVELS,
  IDENTITY_KINDS,
  INVOCATION_OUTCOMES,
  JOB_STATUSES,
  MEMORY_SCOPES,
  MEMORY_TYPES,
  MODEL_ROLES,
  PIPELINE_NODE_KINDS,
  PROVIDER_KINDS,
  RADAR_STATUSES,
  STANCE_POSITIONS,
  STANCE_STATUSES,
  TRACE_EVENT_TYPES,
} from '@xbam/shared/contracts';
import { BROWSER_TASK_KINDS } from './repositories/browserTasks';

/**
 * Every column whose values are constrained to a fixed vocabulary by a database
 * CHECK, and the list that vocabulary is supposed to be.
 *
 * This exists because the failure it prevents is silent and expensive. Growing
 * an enum in TypeScript without widening its CHECK compiles, passes every unit
 * test, and then fails at the database on the one path nobody exercised --
 * migration 0020 added seven account states, taught the code to write them, and
 * left the constraint listing the old five, so every sign-in died at the
 * database and no test noticed.
 *
 * There were forty-six such constraints and six of them were covered.
 *
 * `tests/integration/constrainedEnums.test.ts` walks this registry in both
 * directions: every value here must be one the column accepts, and every
 * enum-like CHECK in the database must appear here. Adding a value without a
 * migration fails; adding a constrained column without registering it fails.
 *
 * Some vocabularies have no shared contract enum because nothing outside the
 * database has ever needed to name them. Those carry their values inline with a
 * note, which at least gives them one runtime source and a test.
 */
export interface ConstrainedEnum {
  table: string;
  column: string;
  values: readonly string[];
  /** Why this one has no shared contract enum. Absent when it has one. */
  note?: string;
}

export const CONSTRAINED_ENUMS: readonly ConstrainedEnum[] = [
  // ── Backed by a shared contract enum ──────────────────────────────────────
  { table: 'accounts', column: 'channel', values: CHANNELS },
  { table: 'accounts', column: 'status', values: ACCOUNT_STATUSES },
  { table: 'actions', column: 'error_class', values: ERROR_CLASSES },
  { table: 'actions', column: 'status', values: ACTION_STATUSES },
  { table: 'agent_accounts', column: 'action_type', values: ACTION_TYPES },
  { table: 'agents', column: 'avatar_mode', values: AVATAR_MODES },
  { table: 'agents', column: 'state', values: AGENT_STATES },
  { table: 'approvals', column: 'status', values: APPROVAL_STATUSES },
  { table: 'capability_invocations', column: 'outcome', values: INVOCATION_OUTCOMES },
  { table: 'browser_sessions', column: 'channel', values: BROWSER_CHANNELS },
  { table: 'browser_sessions', column: 'engine', values: BROWSER_ENGINES },
  { table: 'browser_sessions', column: 'mode', values: BROWSER_MODES },
  { table: 'browser_tasks', column: 'kind', values: BROWSER_TASK_KINDS },
  { table: 'events', column: 'type', values: EVENT_TYPES },
  { table: 'jobs', column: 'error_class', values: ERROR_CLASSES },
  { table: 'jobs', column: 'status', values: JOB_STATUSES },
  { table: 'memories', column: 'memory_type', values: MEMORY_TYPES },
  { table: 'memories', column: 'scope', values: MEMORY_SCOPES },
  { table: 'model_configs', column: 'role', values: MODEL_ROLES },
  { table: 'persona_versions', column: 'identity_kind', values: IDENTITY_KINDS },
  { table: 'pipeline_nodes', column: 'kind', values: PIPELINE_NODE_KINDS },
  { table: 'provider_credentials', column: 'provider', values: PROVIDER_KINDS },
  { table: 'radar_sources', column: 'status', values: RADAR_STATUSES },
  { table: 'relationships', column: 'disposition', values: DISPOSITIONS },
  { table: 'relationships', column: 'familiarity', values: FAMILIARITY_LEVELS },
  { table: 'stances', column: 'position', values: STANCE_POSITIONS },
  { table: 'stances', column: 'status', values: STANCE_STATUSES },
  { table: 'trace_events', column: 'type', values: TRACE_EVENT_TYPES },

  // ── Database-only vocabularies ────────────────────────────────────────────
  // Nothing outside the schema names these, so they live here rather than in a
  // shared contract nobody would import. Registered so they are still covered.
  {
    table: 'artifacts',
    column: 'kind',
    values: ['SCREENSHOT', 'PORTRAIT', 'UPLOAD', 'EXPORT', 'HTML_SNAPSHOT'],
    note: 'Artifact kinds are written by the worker and read by the API only.',
  },
  {
    table: 'browser_tasks',
    column: 'status',
    values: ['PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED', 'SUPERSEDED'],
    note: 'Task lifecycle, owned by the browser-task repository.',
  },
  {
    table: 'commitments',
    column: 'status',
    values: ['OPEN', 'DUE', 'COMPLETED', 'CANCELLED', 'FAILED'],
    note: 'Commitment lifecycle, owned by the stances repository.',
  },
  {
    table: 'content_ideas',
    column: 'status',
    values: ['unused', 'drafting', 'used', 'discarded'],
    note: 'Idea lifecycle. Lowercase, unlike every other status column here.',
  },
  {
    table: 'import_runs',
    column: 'status',
    values: ['RUNNING', 'COMPLETED', 'FAILED'],
    note: 'AI4CZ import lifecycle.',
  },
  {
    table: 'job_attempts',
    column: 'outcome',
    values: ['OK', 'RETRYABLE', 'PERMANENT', 'REVIEW_REQUIRED'],
    note: 'ERROR_CLASSES plus OK. Deliberately not that enum: an attempt can succeed.',
  },
  {
    table: 'knowledge_sources',
    column: 'kind',
    values: ['UPLOAD', 'PATH', 'TEXT', 'URL'],
    note: 'Mirrors KnowledgeSourceKind in the knowledge repository.',
  },
  {
    table: 'messages',
    column: 'direction',
    values: ['INBOUND', 'OUTBOUND'],
    note: 'Message direction.',
  },
  {
    table: 'model_calls',
    column: 'status',
    values: ['STARTED', 'COMPLETED', 'FAILED'],
    note: 'Observability only; a call is recorded before it finishes.',
  },
  {
    table: 'notifications',
    column: 'severity',
    values: ['INFO', 'WARNING', 'CRITICAL'],
    note: 'Mirrors NotificationSeverity in the notifications repository.',
  },
  {
    table: 'persona_source_items',
    column: 'item_kind',
    values: ['post', 'reply', 'quote', 'unknown'],
    note: 'What a corpus item was on the source platform.',
  },
  {
    table: 'persona_sources',
    column: 'kind',
    values: ['x_public', 'manual'],
    note: 'Where persona source material came from.',
  },
  {
    table: 'persona_sources',
    column: 'status',
    values: ['IDLE', 'SYNCING', 'READY', 'ERROR', 'UNAVAILABLE'],
    note: 'Corpus sync lifecycle.',
  },
  {
    table: 'persona_traits',
    column: 'kind',
    values: ['style', 'belief', 'topic', 'example', 'language'],
    note: 'What kind of thing a derived trait is.',
  },
  {
    table: 'persona_versions',
    column: 'response_length',
    values: ['TERSE', 'SHORT', 'MEDIUM', 'LONG', 'ADAPTIVE'],
    note: 'Persona response length. Declared in the persona contract as a zod enum.',
  },
  {
    table: 'predictions',
    column: 'outcome',
    values: ['OPEN', 'CORRECT', 'WRONG', 'UNRESOLVABLE'],
    note: 'Whether a stated prediction came true.',
  },
  {
    table: 'tools',
    column: 'kind',
    values: ['BUILTIN', 'HTTP', 'CUSTOM'],
    note: 'How a tool is implemented.',
  },
  {
    table: 'trace_events',
    column: 'level',
    values: ['debug', 'info', 'warn', 'error'],
    note: 'Log level on a trace row. Matches the logger levels.',
  },
  {
    table: 'users',
    column: 'role',
    values: ['OWNER', 'MEMBER'],
    note: 'There is one owner per installation; MEMBER is unused so far.',
  },
];

/** Reads the vocabulary a CHECK constraint actually enforces, from the catalogue. */
export interface DiscoveredConstraint {
  table: string;
  column: string;
  constraint: string;
  values: string[];
}

/**
 * Every enum-like CHECK the database currently has.
 *
 * "Enum-like" means `column = ANY (ARRAY[...])`, which is how Postgres renders
 * `column IN (...)`. Numeric and expression CHECKs are deliberately not matched:
 * a range check on an interval is not a vocabulary and has nothing to register.
 */
export async function discoverConstrainedEnums(
  run: (sql: string) => Promise<Record<string, unknown>[]>,
): Promise<DiscoveredConstraint[]> {
  const rows = await run(
    `select conrelid::regclass::text as tbl, conname, pg_get_constraintdef(oid) as def
       from pg_constraint
      where contype = 'c' and pg_get_constraintdef(oid) like '%ANY (ARRAY%'
      order by 1, 2`,
  );
  return rows.map((row) => {
    const def = String(row.def ?? '');
    return {
      table: String(row.tbl ?? ''),
      column: def.match(/CHECK \(\("?([a-z_]+)"? = ANY/)?.[1] ?? '?',
      constraint: String(row.conname ?? ''),
      values: [...def.matchAll(/'([^']*)'::text/g)].map((m) => m[1]!),
    };
  });
}
