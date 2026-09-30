import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Check, ChevronDown, CircleDot, FlaskConical, Pencil, RotateCcw, Search, X } from 'lucide-react';
import { ApiError, get, patch, post } from '@app/lib/api';
import { useElapsed, usePolling, useResource } from '@app/lib/hooks';
import { timeAgo } from '@app/lib/format';
import { FadeIn } from '@app/components/motion';
import { EmptyState, ErrorPanel, Field, Loading, Spinner, StatusDot, Working } from '@app/components/ui';

// ── Shapes the API returns ─────────────────────────────────────────────────

interface Stage {
  stage: string;
  label: string;
  state: 'DONE' | 'RUNNING' | 'WAITING';
  detail: string | null;
  at: string | null;
}
interface RunView {
  id: string;
  agentId: string | null;
  kind: 'FOUNDRY_SETUP' | 'FOUNDRY_IMPROVE' | 'PERSONA_REFRESH';
  status: 'QUEUED' | 'RUNNING' | 'READY' | 'FAILED' | 'CANCELLED';
  brief: { handle?: string | null; projects?: string[] };
  stages: Stage[];
  lastError: string | null;
  waitingFor?: string | null;
  createdAt: string;
  finishedAt: string | null;
}
interface Evidence {
  objectId: string | null;
  url: string | null;
  excerpt: string;
  family: string | null;
  tier: string | null;
  publishedAt: string | null;
}
interface Item {
  id: string;
  section: string;
  itemKey: string;
  title: string;
  currentValue: unknown;
  proposedValue: unknown;
  ownerValue: unknown;
  rationale: string;
  confidence: number;
  evidence: Evidence[];
  counterEvidence: Evidence[];
  assessment: 'ALREADY_CORRECT' | 'MISSING' | 'WEAK' | 'STALE' | 'CONTRADICTORY' | 'UNSUPPORTED' | 'NEW';
  status: 'PROPOSED' | 'ACCEPTED' | 'EDITED' | 'REJECTED' | 'APPLIED' | 'SUPERSEDED';
}
interface Report {
  sources: { family: string; state: string; detail: string; observed: number }[];
  corpus: { total: number; posts: number; replies: number; quotes: number; confirmed: number; from: string | null; to: string | null };
  sections: { section: string; label: string; proposed: number; accepted: number; edited: number; rejected: number; applied: number }[];
  topics: string[];
  beliefs: string[];
  knowledge: string[];
  radar: string[];
  capabilities: string[];
  autonomy: string | null;
  tests: number;
  uncertainty: string[];
  applied: { at: string; accepted: number; rejected: number }[];
}
interface ApplyResult {
  applied: { section: string; title: string; detail: string }[];
  skipped: { section: string; title: string; reason: string }[];
  personaVersion: number | null;
  policyVersion: number | null;
}

const SECTION_LABELS: Record<string, string> = {
  IDENTITY: 'Identity',
  STYLE: 'Style guidelines',
  MUST_NEVER: 'Must never',
  INSTRUCTIONS: 'Additional instructions',
  TOPICS: 'Interests and topics',
  BELIEFS: 'Beliefs and stances',
  KNOWLEDGE: 'Knowledge sources',
  PERSONA_SOURCES: 'Persona sources',
  RADAR: 'Social Radar',
  CAPABILITIES: 'Capabilities and Plugins',
  AUTONOMY: 'Autonomy and cadence',
  LANGUAGE: 'Language',
  LEARNING: 'Learning',
  TESTS: 'Response Lab tests',
};

/** What an improvement found, in words and a tone. */
const ASSESSMENT: Record<Item['assessment'], { label: string; tone: string }> = {
  ALREADY_CORRECT: { label: 'Already right', tone: 'text-bone-faint border-ink-line' },
  MISSING: { label: 'Missing', tone: 'text-signal-wait border-signal-wait/40' },
  WEAK: { label: 'Could be stronger', tone: 'text-signal-wait border-signal-wait/40' },
  STALE: { label: 'Stale', tone: 'text-signal-wait border-signal-wait/40' },
  CONTRADICTORY: { label: 'Contradicts the research', tone: 'text-signal-fail border-signal-fail/40' },
  UNSUPPORTED: { label: 'No evidence found', tone: 'text-bone-dim border-ink-line' },
  NEW: { label: 'New', tone: 'text-signal-calm border-signal-calm/40' },
};

const TIER_LABEL: Record<string, string> = {
  PRIMARY_PLATFORM: 'read on X',
  OFFICIAL_PROJECT: 'official site',
  OFFICIAL_REPOSITORY: 'official repository',
  DIRECT_AUTHORITATIVE: 'read directly',
  OWNER_SUPPLIED: 'given by you',
  SEARCH_INDEX: 'search result',
  PUBLIC_MIRROR: 'public mirror, unconfirmed',
  ARCHIVE: 'archive',
  UNKNOWN: 'unknown source',
};

// ── Values, shown as a person reads them ───────────────────────────────────

/**
 * The settings' own vocabulary, in words. An owner reviewing a proposal should
 * never have to know that "follows the question" is spelled ADAPTIVE.
 */
const WORDS: Record<string, string> = {
  FICTIONAL: 'A fictional character',
  INSPIRED_BY: 'Modelled on a real account, never claiming to be them',
  BRAND: 'A brand',
  REAL_PERSON_AUTHORIZED: 'Speaks for a real person, with their authority',
  DISCLOSED_AI: 'An openly AI character',
  TERSE: 'Very short',
  SHORT: 'Short',
  MEDIUM: 'Medium',
  LONG: 'Long',
  ADAPTIVE: 'Follows the question: short by default, longer when needed',
  OFF: 'Off',
  MONITOR_ONLY: 'Watches only',
  MANUAL_ONLY: 'Only when you ask',
  REVIEW_BEFORE_ACTION: 'You review every action',
  AUTONOMOUS: 'Acts on its own',
  REVIEW: 'Shown to you first',
  SELECTIVE: 'Selective',
  ALWAYS_REPLY: 'Answers every mention',
  QUESTIONS_ONLY: 'Answers questions only',
  NEVER_AUTO_IGNORE: 'Asks you before staying silent',
  POSITIVE: 'Positive',
  NEGATIVE: 'Critical',
  MIXED: 'Mixed',
  NEUTRAL: 'Neutral',
  UNCERTAIN: 'Unsure',
  DOCUMENTATION_SITE: 'Documentation site',
  GITHUB_REPOSITORY: 'GitHub repository',
  URL: 'Web page',
  TEXT: 'Pasted text',
  x_public: 'Public X account',
  notifications: 'X notifications',
  mention_search: 'Mention search',
  reply_search: 'Reply search',
  own_threads: 'Under its own posts',
  tracked_account: 'A watched account',
  tracked_keyword: 'A watched keyword',
  OFFICIAL: 'official',
  COMMUNITY: 'community',
  OWNER: 'yours',
};

const KEY_LABELS: Record<string, string> = {
  mode: 'Mode',
  dryRun: 'Rehearsal only',
  strategy: 'How it decides',
  minimumReplyValue: 'Reply bar (0 to 100)',
  maxRepliesPerPersonPerHour: 'Replies to one person an hour',
  maxRepliesPerThread: 'Turns in one exchange',
  enabled: 'On',
  on: 'On',
  kind: 'Kind',
  target: 'Watching',
  location: 'Address',
  labels: 'Labels',
  refreshIntervalMinutes: 'Read again',
  name: 'Name',
  subject: 'About',
  position: 'Position',
  summary: 'In a sentence',
  pinned: 'Pinned by you',
  handle: 'Account',
  generation: 'Version',
  keep: 'Kept',
  retire: 'Retired',
  gap: 'Missing a source for',
};

function word(value: unknown): string {
  if (value === null || value === undefined || value === '') return 'none';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return WORDS[value] ?? value;
  if (Array.isArray(value)) return value.map((v) => (typeof v === 'object' && v ? (v as Record<string, unknown>).subject ?? (v as Record<string, unknown>).name ?? JSON.stringify(v) : word(v))).join(', ');
  if (typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .filter(([k]) => k !== 'id')
      .map(([k, v]) => (k === 'generation' || k === 'version' ? String(v) : word(v)))
      .join(', ');
  }
  return String(value);
}

/** Minutes to how often a person would say it. */
function every(minutes: unknown): string {
  if (typeof minutes !== 'number') return word(minutes);
  if (minutes >= 10_080 && minutes % 10_080 === 0) return minutes === 10_080 ? 'Every week' : `Every ${minutes / 10_080} weeks`;
  if (minutes >= 1_440 && minutes % 1_440 === 0) return minutes === 1_440 ? 'Every day' : `Every ${minutes / 1_440} days`;
  return `Every ${minutes} minutes`;
}

function asLines(value: unknown): string[] | null {
  if (typeof value === 'string' && WORDS[value]) return [WORDS[value]];
  if (typeof value === 'string') return value.split('\n').filter((l) => l.trim());
  if (Array.isArray(value) && value.every((v) => typeof v === 'string')) return value as string[];
  return null;
}

function Value({ value, compareTo }: { value: unknown; compareTo?: unknown }) {
  if (value === null || value === undefined || value === '') return <span className="text-bone-faint">Nothing set</span>;
  const lines = asLines(value);
  if (lines) {
    const before = new Set((asLines(compareTo) ?? []).map((l) => l.trim().toLowerCase()));
    return (
      <ul className="space-y-1">
        {lines.map((line, i) => {
          const isNew = compareTo !== undefined && !before.has(line.trim().toLowerCase());
          return (
            <li key={`${i}-${line.slice(0, 20)}`} className={`break-words text-sm ${isNew ? 'text-bone' : 'text-bone-dim'}`}>
              {isNew && <span className="mr-1.5 font-mono text-[10px] text-signal-calm">+</span>}
              {line}
            </li>
          );
        })}
      </ul>
    );
  }
  if (typeof value === 'object') {
    return (
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
        {Object.entries(value as Record<string, unknown>)
          // An id is for the machine; an absent target is simply not shown.
          .filter(([k, v]) => k !== 'id' && !(k === 'target' && v === null))
          .map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-[12px] text-bone-faint">{KEY_LABELS[k] ?? k}</dt>
              <dd className="break-words text-bone-dim">{k === 'refreshIntervalMinutes' ? every(v) : word(v)}</dd>
            </div>
          ))}
      </dl>
    );
  }
  return <span className="break-words text-sm text-bone-dim">{word(value)}</span>;
}

function EvidenceList({ items, label }: { items: Evidence[]; label: string }) {
  if (items.length === 0) return null;
  return (
    <div className="mt-2">
      <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-bone-faint">{label}</p>
      <ul className="mt-1.5 space-y-2">
        {items.map((e, i) => (
          <li key={`${e.objectId ?? e.url ?? ''}-${i}`} className="rounded border border-ink-line p-2.5 text-[13px]">
            <p className="break-words text-bone-dim">{e.excerpt}</p>
            <p className="mt-1 text-[11px] text-bone-faint">
              {TIER_LABEL[e.tier ?? 'UNKNOWN'] ?? e.tier}
              {e.publishedAt ? `, ${e.publishedAt.slice(0, 10)}` : ''}
              {e.url && (
                <>
                  {' '}
                  <a className="underline decoration-ink-line underline-offset-2 hover:text-bone" href={e.url} target="_blank" rel="noreferrer noopener">
                    open
                  </a>
                </>
              )}
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── One proposed change ────────────────────────────────────────────────────

function ItemCard({ item, improving, onDecide, busy }: { item: Item; improving: boolean; onDecide: (decision: string, value?: unknown) => void; busy: boolean }) {
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const lines = asLines(item.status === 'EDITED' ? item.ownerValue : item.proposedValue);
  const editable = lines !== null && item.section !== 'TESTS';
  const decided = item.status !== 'PROPOSED';
  const shown = item.status === 'EDITED' ? item.ownerValue : item.proposedValue;
  return (
    <article className={`rounded-lg border p-4 ${item.status === 'REJECTED' ? 'border-ink-line opacity-60' : 'border-ink-line bg-ink-panel'}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h4 className="break-words text-bone">{item.title}</h4>
          <p className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-bone-faint">
            {improving && (
              <span className={`rounded border px-1.5 py-0.5 font-mono uppercase tracking-wide ${ASSESSMENT[item.assessment].tone}`}>
                {ASSESSMENT[item.assessment].label}
              </span>
            )}
            <span>{Math.round(item.confidence * 100)}% confident</span>
            {item.evidence.length > 0 && <span>{item.evidence.length} piece{item.evidence.length === 1 ? '' : 's'} of evidence</span>}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-1.5">
          {item.status === 'APPLIED' ? (
            <span className="flex items-center gap-1 text-[12px] text-signal-calm">
              <Check className="h-3.5 w-3.5" aria-hidden />
              Applied
            </span>
          ) : decided ? (
            <>
              <span className="text-[12px] text-bone-dim">{item.status === 'REJECTED' ? 'Rejected' : item.status === 'EDITED' ? 'Accepted with your edit' : 'Accepted'}</span>
              <button type="button" className="btn-quiet" disabled={busy} onClick={() => onDecide('PROPOSED')} aria-label={`Undo the decision on ${item.title}`}>
                <RotateCcw className="h-3.5 w-3.5" aria-hidden />
              </button>
            </>
          ) : (
            <>
              <button type="button" className="btn-ghost" disabled={busy} onClick={() => onDecide('ACCEPTED')}>
                <Check className="h-3.5 w-3.5" aria-hidden />
                Accept
              </button>
              {editable && (
                <button type="button" className="btn-quiet" disabled={busy} onClick={() => setEditing((lines ?? []).join('\n'))}>
                  <Pencil className="h-3.5 w-3.5" aria-hidden />
                  Edit
                </button>
              )}
              <button type="button" className="btn-quiet" disabled={busy} onClick={() => onDecide('REJECTED')}>
                <X className="h-3.5 w-3.5" aria-hidden />
                Reject
              </button>
            </>
          )}
        </div>
      </div>

      <p className="mt-3 text-sm leading-relaxed text-bone-dim">{item.rationale}</p>

      {editing !== null ? (
        <div className="mt-3 space-y-2">
          <textarea className="field min-h-[8rem] resize-y text-sm" value={editing} onChange={(e) => setEditing(e.target.value)} aria-label={`Edit ${item.title}`} />
          <div className="flex gap-2">
            <button
              type="button"
              className="btn-primary"
              disabled={busy}
              onClick={() => {
                const next = editing.split('\n').map((l) => l.trim()).filter(Boolean);
                onDecide('EDITED', typeof item.proposedValue === 'string' ? next.join('\n') : next);
                setEditing(null);
              }}
            >
              Accept my version
            </button>
            <button type="button" className="btn-quiet" onClick={() => setEditing(null)}>
              Cancel
            </button>
          </div>
        </div>
      ) : item.section !== 'TESTS' ? (
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <div>
            <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-bone-faint">Now</p>
            <div className="mt-1.5">
              <Value value={item.currentValue} />
            </div>
          </div>
          <div>
            <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-bone-faint">{item.status === 'EDITED' ? 'Your version' : 'Proposed'}</p>
            <div className="mt-1.5">
              <Value value={shown} compareTo={item.currentValue ?? undefined} />
            </div>
          </div>
        </div>
      ) : (
        <p className="mt-3 rounded border border-ink-line p-2.5 font-mono text-[12px] text-bone-dim">
          {(item.proposedValue as { message?: string }).message}
        </p>
      )}

      {(item.evidence.length > 0 || item.counterEvidence.length > 0) && (
        <div className="mt-3">
          <button type="button" className="btn-quiet px-0 text-xs" aria-expanded={open} onClick={() => setOpen(!open)}>
            <ChevronDown className={`h-3.5 w-3.5 transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden />
            {open ? 'Hide' : 'Show'} the evidence
          </button>
          {open && (
            <>
              <EvidenceList items={item.evidence} label="What it rests on" />
              <EvidenceList items={item.counterEvidence} label="What points the other way" />
            </>
          )}
        </div>
      )}
    </article>
  );
}

// ── Test this agent ────────────────────────────────────────────────────────

interface JudgedCase {
  id: string;
  category: string;
  title: string;
  message: string;
  expect: string;
  verdict: 'PASS' | 'REVIEW' | 'SILENT' | 'FAILED' | 'RUNNING';
  reason: string;
  answer: string | null;
  silence: string | null;
  jobId: string | null;
}
interface Suite {
  id: string;
  createdAt: string;
  finished: boolean;
  counts: Record<JudgedCase['verdict'], number>;
  cases: JudgedCase[];
}

const VERDICT: Record<JudgedCase['verdict'], { label: string; dot: 'live' | 'wait' | 'fail' | 'idle' }> = {
  PASS: { label: 'Pass', dot: 'idle' },
  SILENT: { label: 'Stayed silent', dot: 'idle' },
  REVIEW: { label: 'Read it', dot: 'wait' },
  FAILED: { label: 'Failed', dot: 'fail' },
  RUNNING: { label: 'Answering', dot: 'live' },
};

/**
 * The agent put through the situations that go wrong, before it is turned on.
 *
 * Every case is a rehearsal through the real pipeline, so what is shown is what
 * it would really have said. Nothing is sent.
 */
function TestPanel({ agentId, foundryRunId }: { agentId: string; foundryRunId: string | null }) {
  const latest = useResource<{ suite: Suite | null }>(`/api/agents/${agentId}/tests`);
  const [suite, setSuite] = useState<Suite | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const shown = suite ?? latest.data?.suite ?? null;
  usePolling(
    () =>
      void get<{ suite: Suite }>(`/api/agents/${agentId}/tests/${shown!.id}`)
        .then((r) => setSuite(r.suite))
        .catch(() => undefined),
    3_000,
    Boolean(shown && !shown.finished),
  );

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const started = await post<{ suite: Suite }>(`/api/agents/${agentId}/tests`, { foundryRunId });
      setSuite(started.suite);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'The tests could not be started.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="tests-title" className="rounded-lg border border-ink-line bg-ink-panel p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 id="tests-title" className="text-bone">Test this agent</h3>
          <p className="mt-1 text-sm text-bone-dim">
            The situations that go wrong, rehearsed through the real pipeline. Nothing is sent; you see what it would have said.
          </p>
        </div>
        <button type="button" className="btn-primary" disabled={busy || Boolean(shown && !shown.finished)} onClick={() => void run()}>
          {busy ? <Spinner /> : <FlaskConical className="h-4 w-4" aria-hidden />}
          {shown ? 'Run the tests again' : 'Run the tests'}
        </button>
      </div>
      {error && <p className="mt-3 text-sm text-signal-fail">{error}</p>}
      {shown && (
        <>
          <p className="mt-4 text-sm text-bone-dim" aria-live="polite">
            {(['PASS', 'SILENT', 'REVIEW', 'FAILED', 'RUNNING'] as const)
              .filter((v) => shown.counts[v] > 0)
              .map((v) => `${shown.counts[v]} ${VERDICT[v].label.toLowerCase()}`)
              .join(', ')}
            {' · '}run {timeAgo(shown.createdAt)}
          </p>
          <ul className="mt-3 space-y-2">
            {shown.cases.map((c) => (
              <li key={c.id} className="rounded border border-ink-line p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <span className="min-w-0">
                    <span className="block text-sm text-bone">{c.title}</span>
                    <span className="block text-[11px] text-bone-faint">{c.category}</span>
                  </span>
                  <StatusDot state={VERDICT[c.verdict].dot} label={VERDICT[c.verdict].label} />
                </div>
                <p className="mt-2 break-words font-mono text-[12px] text-bone-dim">{c.message}</p>
                {c.answer && <p className="mt-2 break-words border-l-2 border-ink-line pl-3 text-sm text-bone">{c.answer}</p>}
                <p className="mt-2 text-[12px] text-bone-faint">{c.reason}</p>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

// ── The run ────────────────────────────────────────────────────────────────

function RunProgress({ run, onCancel }: { run: RunView; onCancel: () => void }) {
  const elapsed = useElapsed(true);
  const current = run.stages.find((s) => s.state === 'RUNNING');
  return (
    <div className="space-y-5">
      <Working
        label={current ? current.label : run.status === 'QUEUED' ? 'Waiting for the worker to pick this up' : 'Working'}
        seconds={elapsed}
        slowAfter={run.waitingFor ? 0 : run.status === 'QUEUED' ? 45 : 90}
        slowHint={
          run.waitingFor
            ? run.waitingFor
            : run.status === 'QUEUED'
            ? 'Research runs on the worker that owns the browser. If it has not started within a minute, the Health page says whether one is running. If X is resting the account, it waits for that too.'
            : 'Reading a few hundred posts takes a few minutes. It carries on if you close this page, and waits rather than hurry if X asks it to.'
        }
        onCancel={onCancel}
        cancelLabel="Stop researching"
      />
      <ol className="space-y-2">
        {run.stages.map((s) => (
          <li key={s.stage} className="flex items-start gap-3 text-sm">
            <span className="mt-0.5">
              {s.state === 'DONE' ? (
                <Check className="h-4 w-4 text-signal-calm" aria-label="Done" />
              ) : s.state === 'RUNNING' ? (
                <Spinner className="h-4 w-4" />
              ) : (
                <CircleDot className="h-4 w-4 text-bone-faint" aria-label="Waiting" />
              )}
            </span>
            <span className="min-w-0">
              <span className={s.state === 'WAITING' ? 'text-bone-faint' : 'text-bone'}>{s.label}</span>
              {s.detail && <span className="block break-words text-[12px] text-bone-faint">{s.detail.replace(`${s.label}: `, '')}</span>}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

function ReportView({ report }: { report: Report }) {
  return (
    <section aria-labelledby="report-title" className="rounded-lg border border-ink-line bg-ink-panel p-5">
      <h3 id="report-title" className="text-bone">What the research rests on</h3>
      <p className="mt-2 text-sm text-bone-dim">
        {report.corpus.total} posts and replies
        {report.corpus.total > 0 && ` (${report.corpus.confirmed} read on X itself)`}
        {report.corpus.from && `, from ${report.corpus.from.slice(0, 10)} to ${report.corpus.to?.slice(0, 10)}`}.
      </p>
      {report.sources.length > 0 && (
        <ul className="mt-3 space-y-1.5">
          {report.sources.map((s, i) => (
            <li key={`${s.family}-${i}`} className="flex items-start justify-between gap-3 text-[13px]">
              <span className="min-w-0 break-words text-bone-dim">{s.detail}</span>
              <StatusDot state={s.state === 'AVAILABLE' ? 'idle' : s.state === 'DEGRADED' ? 'wait' : 'fail'} label={s.family} />
            </li>
          ))}
        </ul>
      )}
      {report.uncertainty.length > 0 && (
        <div className="mt-4">
          <p className="text-sm text-bone">Not settled by research</p>
          <ul className="mt-1.5 list-disc space-y-1 pl-5 text-[13px] text-bone-dim">
            {report.uncertainty.map((u) => (
              <li key={u} className="break-words">
                {u}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function RunDetail({ agentId, runId }: { agentId: string; runId: string }) {
  const view = useResource<{ run: RunView; items: Item[]; report: Report | null }>(`/api/foundry/runs/${runId}`);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [applied, setApplied] = useState<ApplyResult | null>(null);
  const run = view.data?.run;
  const items = useMemo(() => view.data?.items ?? [], [view.data]);
  const improving = run?.kind !== 'FOUNDRY_SETUP';
  usePolling(() => view.reload(), 3_000, run?.status === 'QUEUED' || run?.status === 'RUNNING');

  const sections = useMemo(() => {
    const order = Object.keys(SECTION_LABELS);
    const by = new Map<string, Item[]>();
    for (const item of items) by.set(item.section, [...(by.get(item.section) ?? []), item]);
    return [...by.entries()].sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]));
  }, [items]);
  const accepted = items.filter((i) => i.status === 'ACCEPTED' || i.status === 'EDITED').length;
  const undecided = items.filter((i) => i.status === 'PROPOSED').length;

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      view.reload();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'That did not work.');
    } finally {
      setBusy(false);
    }
  };

  if (view.loading && !run) return <Loading label="Opening the research" />;
  if (view.error || !run) return <ErrorPanel title="This research could not be opened" detail={view.error} />;

  return (
    <div className="space-y-8">
      <div>
        <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-bone-faint">
          {run.kind === 'FOUNDRY_SETUP' ? 'Research-backed setup' : run.kind === 'FOUNDRY_IMPROVE' ? 'Improving an existing agent' : 'Refreshing persona research'}
          {' · '}started {timeAgo(run.createdAt)}
        </p>
        <h1 className="mt-2 font-display text-3xl font-light tracking-monument text-bone sm:text-4xl">
          {run.brief.handle ? `Modelled on @${run.brief.handle}` : 'Research'}
          {run.brief.projects?.length ? `, knowing ${run.brief.projects.join(' and ')}` : ''}
        </h1>
      </div>

      {(run.status === 'QUEUED' || run.status === 'RUNNING') && (
        <RunProgress run={run} onCancel={() => void act(() => post(`/api/foundry/runs/${run.id}/cancel`, {}))} />
      )}
      {run.status === 'FAILED' && <ErrorPanel title="The research stopped" detail={run.lastError} />}
      {run.status === 'CANCELLED' && <p className="text-sm text-bone-dim">Stopped. Anything it proposed before stopping is below.</p>}

      {view.data?.report && <ReportView report={view.data.report} />}

      {error && <ErrorPanel title="That did not work" detail={error} />}

      {applied && (
        <section aria-labelledby="applied-title" className="rounded-lg border border-signal-calm/40 bg-signal-calm/[0.05] p-5">
          <h3 id="applied-title" className="text-bone">Applied</h3>
          <p className="mt-1 text-sm text-bone-dim">
            {applied.applied.length} change{applied.applied.length === 1 ? '' : 's'}
            {applied.personaVersion ? `, persona version ${applied.personaVersion}` : ''}
            {applied.policyVersion ? `, policy version ${applied.policyVersion}` : ''}. Every one can be undone from its own screen.
          </p>
          {applied.skipped.length > 0 && (
            <ul className="mt-3 list-disc space-y-1 pl-5 text-[13px] text-bone-dim">
              {applied.skipped.map((s) => (
                <li key={`${s.section}-${s.title}`} className="break-words">
                  {s.title}: {s.reason}
                </li>
              ))}
            </ul>
          )}
          <div className="mt-4 flex flex-wrap gap-2">
            <Link className="btn-primary" to={`/agents/${agentId}`}>
              Go to the agent
            </Link>
          </div>
        </section>
      )}

      {(applied || items.some((i) => i.status === 'APPLIED')) && <TestPanel agentId={agentId} foundryRunId={run.id} />}

      {sections.length > 0 && (
        <>
          <nav aria-label="Sections" className="sticky top-0 z-10 -mx-5 flex gap-2 overflow-x-auto border-b border-ink-line bg-ink/95 px-5 py-2 backdrop-blur">
            {sections.map(([section, list]) => (
              <a key={section} href={`#section-${section}`} className="shrink-0 rounded border border-ink-line px-2 py-1 text-[12px] text-bone-dim hover:text-bone">
                {SECTION_LABELS[section] ?? section} <span className="text-bone-faint">{list.length}</span>
              </a>
            ))}
          </nav>
          {sections.map(([section, list]) => (
            <section key={section} id={`section-${section}`} aria-labelledby={`h-${section}`} className="scroll-mt-16 space-y-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h3 id={`h-${section}`} className="text-lg text-bone">
                  {SECTION_LABELS[section] ?? section}
                </h3>
                {list.some((i) => i.status === 'PROPOSED') && (
                  <button type="button" className="btn-quiet text-xs" disabled={busy} onClick={() => void act(() => post(`/api/foundry/runs/${run.id}/accept`, { section }))}>
                    Accept this section
                  </button>
                )}
              </div>
              {list.map((item) => (
                <ItemCard
                  key={item.id}
                  item={item}
                  improving={improving}
                  busy={busy}
                  onDecide={(decision, value) => void act(() => patch(`/api/foundry/items/${item.id}`, decision === 'EDITED' ? { decision, value } : { decision }))}
                />
              ))}
            </section>
          ))}

          <div className="sticky bottom-0 -mx-5 flex flex-wrap items-center justify-between gap-3 border-t border-ink-line bg-ink/95 px-5 py-3 backdrop-blur">
            <p className="text-sm text-bone-dim">
              {accepted} accepted, {undecided} undecided. Nothing changes until you apply.
            </p>
            <div className="flex flex-wrap gap-2">
              {undecided > 0 && (
                <button type="button" className="btn-ghost" disabled={busy} onClick={() => void act(() => post(`/api/foundry/runs/${run.id}/accept`, {}))}>
                  Accept everything undecided
                </button>
              )}
              <button
                type="button"
                className="btn-primary"
                disabled={busy || accepted === 0 || run.status !== 'READY'}
                onClick={() =>
                  void act(async () => {
                    const result = await post<{ applied: ApplyResult }>(`/api/foundry/runs/${run.id}/apply`, {});
                    setApplied(result.applied);
                  })
                }
              >
                {busy ? <Spinner /> : <Check className="h-4 w-4" aria-hidden />}
                Apply {accepted} change{accepted === 1 ? '' : 's'}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ── The hub: past runs, and starting a new one on an existing agent ────────

function FoundryHub({ agentId }: { agentId: string }) {
  const navigate = useNavigate();
  const runs = useResource<{ runs: RunView[] }>(`/api/agents/${agentId}/foundry`);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const start = async (mode: 'IMPROVE' | 'REFRESH') => {
    setBusy(mode);
    setError(null);
    try {
      const started = await post<{ run: { id: string } }>(`/api/agents/${agentId}/foundry`, { text, mode });
      navigate(`/agents/${agentId}/foundry/${started.run.id}`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'The research could not be started.');
      setBusy(null);
    }
  };

  return (
    <div className="space-y-8">
      <div>
        <h1 className="font-display text-3xl font-light tracking-monument text-bone sm:text-4xl">Research</h1>
        <p className="mt-3 max-w-xl text-bone-dim">
          Compare this agent's setup with what research finds, or refresh what it knows about the account it is modelled on. You
          see every difference and decide each one; nothing changes by itself.
        </p>
      </div>
      <div className="space-y-4 rounded-lg border border-ink-line bg-ink-panel p-5">
        <Field label="What should it be?" htmlFor="h-brief" hint="Name the account with an @ and the projects it should know. Leave it short; the plan is shown before anything runs.">
          <textarea id="h-brief" rows={3} className="field resize-y" value={text} onChange={(e) => setText(e.target.value)} placeholder="Modelled on @someone. Understands Example Protocol. Selective." />
        </Field>
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn-primary" disabled={busy !== null || text.trim().length < 4} onClick={() => void start('IMPROVE')}>
            {busy === 'IMPROVE' ? <Spinner /> : <Search className="h-4 w-4" aria-hidden />}
            Improve with research
          </button>
          <button type="button" className="btn-ghost" disabled={busy !== null || text.trim().length < 4} onClick={() => void start('REFRESH')}>
            {busy === 'REFRESH' ? <Spinner /> : <RotateCcw className="h-4 w-4" aria-hidden />}
            Refresh persona research
          </button>
        </div>
        {error && <p className="text-sm text-signal-fail">{error}</p>}
      </div>

      <TestPanel agentId={agentId} foundryRunId={null} />

      <section aria-labelledby="runs-title">
        <h2 id="runs-title" className="text-lg text-bone">Earlier research</h2>
        {runs.loading && <Loading />}
        {!runs.loading && (runs.data?.runs ?? []).length === 0 && (
          <EmptyState title="No research yet" detail="Research runs you start for this agent appear here, with what each one found and what you applied." />
        )}
        <ul className="mt-3 space-y-2">
          {(runs.data?.runs ?? []).filter(Boolean).map((r) => (
            <li key={r.id}>
              <Link to={`/agents/${agentId}/foundry/${r.id}`} className="flex items-center justify-between gap-3 rounded border border-ink-line px-3 py-2.5 hover:border-bone-faint">
                <span className="min-w-0 text-sm">
                  <span className="text-bone">{r.kind === 'FOUNDRY_SETUP' ? 'Setup' : r.kind === 'FOUNDRY_IMPROVE' ? 'Improvement' : 'Persona refresh'}</span>
                  <span className="text-bone-faint"> · {timeAgo(r.createdAt)}</span>
                </span>
                <StatusDot
                  state={r.status === 'READY' ? 'idle' : r.status === 'FAILED' ? 'fail' : r.status === 'CANCELLED' ? 'idle' : 'live'}
                  label={r.status === 'READY' ? 'Ready' : r.status === 'FAILED' ? 'Failed' : r.status === 'CANCELLED' ? 'Stopped' : 'Researching'}
                />
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

/** /agents/:agentId/foundry and /agents/:agentId/foundry/:runId */
export function FoundryPage() {
  const { agentId, runId } = useParams();
  if (!agentId) return null;
  return (
    <div className="mx-auto max-w-4xl px-5 py-10 sm:py-14">
      <FadeIn>
        <Link to={runId ? `/agents/${agentId}/foundry` : `/agents/${agentId}`} className="btn-quiet px-0">
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
          {runId ? 'All research' : 'Back to the agent'}
        </Link>
        <div className="mt-6">{runId ? <RunDetail agentId={agentId} runId={runId} /> : <FoundryHub agentId={agentId} />}</div>
      </FadeIn>
    </div>
  );
}

