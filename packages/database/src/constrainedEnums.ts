import {
  ACCOUNT_STATUSES,
  APPROVAL_MODES,
  ACTION_STATUSES,
  ACTION_TYPES,
  AGENT_STATES,
  APPROVAL_STATUSES,
  ATTENTION_KINDS,
  ATTENTION_STATES,
  AUTONOMY_LEVELS,
  AVATAR_MODES,
  CAPABILITY_PERMISSIONS,
  BROWSER_CHANNELS,
  BROWSER_ENGINES,
  BROWSER_MODES,
  CHANNELS,
  DISPOSITIONS,
  EVIDENCE_COMPLETENESS,
  EVIDENCE_KINDS,
  ERROR_CLASSES,
  EVENT_TYPES,
  FAMILIARITY_LEVELS,
  FOUNDRY_ASSESSMENTS,
  FOUNDRY_ITEM_STATUSES,
  FOUNDRY_SECTIONS,
  GOAL_ORIGINS,
  GOAL_STATUSES,
  IDENTITY_KINDS,
  INVOCATION_OUTCOMES,
  JOB_STATUSES,
  MEMORY_SCOPES,
  MEMORY_TYPES,
  MODEL_ROLES,
  PIPELINE_NODE_KINDS,
  PROVIDER_KINDS,
  PROVIDER_TIERS,
  HOST_STATES,
  KEY_CUSTODY_VALUES,
  RADAR_STATUSES,
  RUNTIME_STATES,
  REFLECTION_KINDS,
  RESEARCH_RUN_KINDS,
  RESEARCH_RUN_STATUSES,
  SOURCE_AVAILABILITY,
  SOURCE_FAMILIES,
  SOURCE_TRUST_TIERS,
  STANCE_POSITIONS,
  STANCE_STATUSES,
  TRACE_EVENT_TYPES,
  TRADE_INTENT_STATUSES,
  TRADE_MODES,
  TRADE_PAUSE_SCOPES,
  TRADE_SIDES,
} from '@xbam/shared/contracts';
import { BROWSER_TASK_KINDS } from './repositories/browserTasks';
import { ENGAGEMENT_KINDS, ENGAGEMENT_STATUSES } from './repositories/engagements';
import { REPO_EVENT_KINDS, REPO_STATUSES } from './repositories/repoSources';
import { KNOWLEDGE_DOC_KINDS, KNOWLEDGE_SOURCE_KINDS } from './repositories/knowledge';
import { SPAM_DECIDERS, SPAM_VERDICT_VALUES } from './repositories/spam';
import { AGENT_CHANGE_RISKS, AGENT_CHANGE_STATUSES, AGENT_CHANGE_SUBSYSTEMS } from './repositories/agentChanges';
import { WALLET_FAMILY_VALUES, WALLET_INTENT_KIND_VALUES, WALLET_INTENT_STATUS_VALUES } from './repositories/wallets';
import { CHAT_AUTHOR_KINDS, CHAT_KINDS, CHAT_MESSAGE_STATUSES, CHAT_SAVE_TARGETS } from './repositories/chat';

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
 *
 * **A one-value CHECK is deliberately not here.** Postgres renders `IN ('x')`
 * as `= 'x'::text` rather than `= ANY (ARRAY[...])`, so the discovery below
 * cannot see it -- and a constraint with one permitted value is not a
 * vocabulary that can drift anyway. `repo_sources.provider` is the current
 * example. The moment a second value is added it becomes discoverable, and the
 * unregistered-column test then insists it be registered, which is exactly the
 * right moment for that to happen.
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
  { table: 'agent_attention', column: 'kind', values: ATTENTION_KINDS },
  { table: 'agent_attention', column: 'state', values: ATTENTION_STATES },
  { table: 'agent_goals', column: 'origin', values: GOAL_ORIGINS },
  { table: 'agent_goals', column: 'status', values: GOAL_STATUSES },
  { table: 'agent_reflections', column: 'kind', values: REFLECTION_KINDS },
  { table: 'agent_wake', column: 'autonomy', values: AUTONOMY_LEVELS },
  { table: 'agents', column: 'avatar_mode', values: AVATAR_MODES },
  { table: 'agents', column: 'state', values: AGENT_STATES },
  { table: 'approvals', column: 'status', values: APPROVAL_STATUSES },
  { table: 'capability_invocations', column: 'outcome', values: INVOCATION_OUTCOMES },
  {
    table: 'post_analytics',
    column: 'source',
    values: ['TIMELINE', 'POST_ANALYTICS'],
    note: 'Where a reading came from. Nothing outside the database needs to name these yet.',
  },
  {
    table: 'agent_target_state',
    column: 'mode',
    values: ['WATCH', 'PRIORITIZE', 'ENGAGE'],
    note:
      'How much attention the owner asked for on a followed account. ENGAGE means every new ' +
      'eligible post is deliberately considered, which is not the same as every one being answered.',
  },
  {
    table: 'target_post_dispositions',
    column: 'disposition',
    values: [
      'CONSIDERING',
      'AWAITING_APPROVAL',
      'INTERACTED',
      'INTENTIONAL_NO_ACTION',
      'DUPLICATE',
      'ALREADY_HANDLED',
      'COOLDOWN',
      'POLICY_REFUSAL',
      'ACCOUNT_DEGRADED',
      'STALE',
      'BLOCKED_EXTERNAL',
      'WATCH_ONLY',
    ],
    note:
      'What became of one post from a followed account. The fault this closes is posts that produced ' +
      'no job and no reason, so nobody could tell considered-and-refused from never-looked-at.',
  },
  {
    table: 'broad_candidate_decisions',
    column: 'decision',
    values: ['QUEUED', 'DECLINED'],
    note: 'What became of a post the agent came across on its own. Declined is recorded with its reason, never dropped.',
  },
  {
    table: 'agent_learning_trials',
    column: 'status',
    values: ['RUNNING', 'KEPT', 'REVERTED'],
    note: 'A change the agent made to how it behaves, while it is being tested against the old behaviour and after the verdict.',
  },
  {
    table: 'studio_purchase_ledger',
    column: 'state',
    values: ['PREPARED', 'SENT', 'ABANDONED', 'CONFIRMED', 'FAILED', 'EXPIRED'],
    note: 'A Studio purchase the owner was asked to pay for from inside AI17Z: wallet asked, transaction known, nothing sent on the word of the owner, or how Studio settled it.',
  },
  {
    table: 'studio_purchase_ledger',
    column: 'role',
    values: ['PUBLISHER', 'TREASURY'],
    note: 'Which payment of a checkout a row is: the publisher share, or the marketplace fee.',
  },
  {
    table: 'studio_purchase_ledger',
    column: 'asset',
    values: ['AI17Z', 'ETH'],
    note: 'What a payment is made in: an ERC-20 transfer of $AI17Z, or a plain ETH transfer with no data.',
  },
  {
    table: 'x_capacity_ledger',
    column: 'entry',
    values: ['READ', 'SIGNAL'],
    note: 'One read of X, or X pushing back. The meter behind the X budget of an account.',
  },
  {
    table: 'x_capacity_ledger',
    column: 'class',
    values: ['DIRECT', 'TARGET', 'BROAD'],
    note: 'Who the capacity was spent for, in the order it is protected: people who wrote in, watched accounts, then what the agent looks for itself.',
  },
  {
    table: 'x_capacity_ledger',
    column: 'signal',
    values: ['RATE_LIMITED', 'STALLED', 'BROKEN'],
    note: 'What kind of pushback X gave. Not found, protected and signed out are deliberately absent: they say nothing about load.',
  },
  {
    table: 'accounts',
    column: 'health',
    values: ['HEALTHY', 'DEGRADED', 'COOLDOWN', 'HUMAN_ACTION_REQUIRED'],
    note:
      'How the runtime is coping, which is not whether the session is signed in. ' +
      '`accounts.status` answers the second and is registered separately, above.',
  },
  {
    table: 'do_not_contact',
    column: 'source',
    values: ['THEY_ASKED', 'OWNER'],
    note:
      'Who put somebody on the list. Both bind equally and only the provenance differs, ' +
      'which is why it is recorded rather than collapsed into one flag.',
  },
  {
    table: 'agent_capability_permissions',
    column: 'permission',
    values: CAPABILITY_PERMISSIONS,
    note: "An owner's decision about one capability. Its own table because agent_tools.tool_id points at the built-in catalogue, which capability ids were never in -- see migration 0068.",
  },
  {
    table: 'experiments',
    column: 'status',
    values: ['RUNNING', 'STOPPED'],
    note: 'Whether an experiment is still collecting. Stopped, never deleted -- a null result is most of what this teaches.',
  },
  { table: 'browser_sessions', column: 'channel', values: BROWSER_CHANNELS },
  { table: 'browser_sessions', column: 'engine', values: BROWSER_ENGINES },
  { table: 'browser_sessions', column: 'mode', values: BROWSER_MODES },
  { table: 'browser_tasks', column: 'kind', values: BROWSER_TASK_KINDS },
  { table: 'events', column: 'type', values: EVENT_TYPES },
  {
    table: 'installed_plugins',
    column: 'source',
    // `PLUGIN_SOURCES` less `BUILT_IN`, which deliberately has no row: a
    // built-in Plugin is a toolpack that ships with the application, so there
    // is nothing for it to be a record of. Written out rather than derived, so
    // that adding a fourth source fails here until somebody decides whether a
    // built-in has become recordable.
    values: ['LOCAL', 'AI17Z_REGISTRY'],
    note: 'Where an installed Plugin came from. BUILT_IN is excluded because a built-in has no row.',
  },
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
  {
    table: 'repo_events',
    column: 'kind',
    values: REPO_EVENT_KINDS,
    note: 'What a watched repository did. Owned by the repository-watch repository.',
  },
  {
    table: 'repo_sources',
    column: 'status',
    values: REPO_STATUSES,
    note: 'Watch health. Mirrors the radar vocabulary without sharing it: a forge and a timeline fail differently.',
  },
  { table: 'relationships', column: 'familiarity', values: FAMILIARITY_LEVELS },
  { table: 'stances', column: 'position', values: STANCE_POSITIONS },
  { table: 'stances', column: 'status', values: STANCE_STATUSES },
  { table: 'trace_events', column: 'type', values: TRACE_EVENT_TYPES },

  // ── Database-only vocabularies ────────────────────────────────────────────
  // Nothing outside the schema names these, so they live here rather than in a
  // shared contract nobody would import. Registered so they are still covered.
  {
    table: 'agent_engagements',
    column: 'kind',
    values: ENGAGEMENT_KINDS,
    note: 'What an agent proposed to do on its own. Two of the ACTION_TYPES, deliberately not that enum: this column may never grow to cover replying or posting.',
  },
  {
    table: 'agent_engagements',
    column: 'status',
    values: ENGAGEMENT_STATUSES,
    note: 'Proposal lifecycle, owned by the engagements repository.',
  },
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
    values: KNOWLEDGE_SOURCE_KINDS,
    note: 'KnowledgeSourceKind in the knowledge repository. Collections (0097) added the last two.',
  },
  {
    table: 'knowledge_sources',
    column: 'error_kind',
    values: ['FAILED', 'UNAVAILABLE'],
    note: 'Why the last refresh did not succeed: this attempt, or the source itself.',
  },
  { table: 'knowledge_documents', column: 'doc_kind', values: KNOWLEDGE_DOC_KINDS },
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
    table: 'x_account_observations',
    column: 'outcome',
    values: [
      'OK',
      'NOT_FOUND',
      'PROTECTED',
      'EMPTY',
      'NEEDS_SIGN_IN',
      'CHALLENGE',
      'RATE_LIMITED',
      'SCHEMA_CHANGED',
      'UNAVAILABLE',
    ],
    note:
      "How a read of somebody's X account ended. Mirrors X_READ_OUTCOMES in the channels package, " +
      'which this package deliberately does not import -- the database layer sits underneath the ' +
      'channels and an import the other way would invert that. ' +
      'tests/unit/constrainedEnumRegistry.test.ts holds the two lists against each other.',
  },
  {
    table: 'users',
    column: 'role',
    values: ['OWNER', 'MEMBER'],
    note: 'There is one owner per installation; MEMBER is unused so far.',
  },
  // The Research Fabric (migration 0096). Tiers, families and kinds come from
  // the shared contract, so a new source family is one edit and one migration.
  { table: 'research_runs', column: 'kind', values: RESEARCH_RUN_KINDS },
  { table: 'research_runs', column: 'status', values: RESEARCH_RUN_STATUSES },
  { table: 'research_objects', column: 'kind', values: EVIDENCE_KINDS },
  { table: 'research_objects', column: 'completeness', values: EVIDENCE_COMPLETENESS },
  { table: 'research_objects', column: 'best_tier', values: SOURCE_TRUST_TIERS },
  { table: 'research_sightings', column: 'family', values: SOURCE_FAMILIES },
  { table: 'research_sightings', column: 'tier', values: SOURCE_TRUST_TIERS },
  { table: 'research_sightings', column: 'completeness', values: EVIDENCE_COMPLETENESS },
  { table: 'research_source_health', column: 'state', values: SOURCE_AVAILABILITY },
  // Agent Foundry (migration 0098).
  { table: 'foundry_items', column: 'section', values: FOUNDRY_SECTIONS },
  { table: 'foundry_items', column: 'status', values: FOUNDRY_ITEM_STATUSES },
  { table: 'foundry_items', column: 'assessment', values: FOUNDRY_ASSESSMENTS },
  // Owner chat (migration 0100).
  { table: 'chat_conversations', column: 'kind', values: CHAT_KINDS },
  { table: 'chat_messages', column: 'author_kind', values: CHAT_AUTHOR_KINDS },
  { table: 'chat_messages', column: 'status', values: CHAT_MESSAGE_STATUSES },
  { table: 'chat_saves', column: 'target', values: CHAT_SAVE_TARGETS },
  // Spam defense (migration 0101).
  { table: 'inbound_spam', column: 'verdict', values: SPAM_VERDICT_VALUES },
  { table: 'inbound_spam', column: 'classifier_verdict', values: SPAM_VERDICT_VALUES },
  { table: 'inbound_spam', column: 'decided_by', values: SPAM_DECIDERS },
  // Changes asked for in owner chat (migration 0102).
  { table: 'agent_changes', column: 'subsystem', values: AGENT_CHANGE_SUBSYSTEMS },
  { table: 'agent_changes', column: 'risk', values: AGENT_CHANGE_RISKS },
  { table: 'agent_changes', column: 'status', values: AGENT_CHANGE_STATUSES },
  // Agent wallets (migration 0103).
  { table: 'agent_wallets', column: 'family', values: WALLET_FAMILY_VALUES },
  { table: 'wallet_intents', column: 'kind', values: WALLET_INTENT_KIND_VALUES },
  { table: 'wallet_intents', column: 'status', values: WALLET_INTENT_STATUS_VALUES },
  // Trading (migration 0104).
  { table: 'trade_mandates', column: 'mode', values: TRADE_MODES },
  { table: 'trade_mandates', column: 'approval', values: APPROVAL_MODES },
  { table: 'trade_intents', column: 'mode', values: TRADE_MODES },
  { table: 'trade_intents', column: 'side', values: TRADE_SIDES },
  { table: 'trade_intents', column: 'status', values: TRADE_INTENT_STATUSES },
  { table: 'trade_pauses', column: 'scope', values: TRADE_PAUSE_SCOPES },
  // Hosted runtimes (migration 0105).
  { table: 'host_providers', column: 'tier', values: PROVIDER_TIERS },
  { table: 'host_nodes', column: 'state', values: HOST_STATES },
  { table: 'hosted_runtimes', column: 'state', values: RUNTIME_STATES },
  { table: 'hosted_runtimes', column: 'key_custody', values: KEY_CUSTODY_VALUES },
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
