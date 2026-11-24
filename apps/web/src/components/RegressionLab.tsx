import { useEffect, useId, useState } from 'react';
import type { DecisionDigest, RegressionCandidate, RegressionCase, RegressionResult, RegressionRun, RegressionTrigger } from '@xbam/shared/contracts';
import { RegressionChecks } from '@xbam/shared/contracts';
import { api, post } from '@app/lib/api';
import { useResource } from '@app/lib/hooks';
import { Field } from './ui';

interface Diff {
  severity: 'REGRESSION' | 'CHANGED' | 'SAME'; decisionChange: string | null;
  validatorChanged: boolean; voiceChanged: boolean; lengthDelta: number; textNote: string | null;
  checks: { before: { verdict: string; reason: string }; after: { verdict: string; reason: string } };
  draft: { kind: 'same' | 'added' | 'removed'; text: string }[];
}
interface RunView extends RegressionRun { results: (RegressionResult & { diff: Diff | null })[] }

export function RegressionResults({ agentId, runId }: { agentId: string; runId: string }) {
  const view = useResource<RunView>(`/api/agents/${agentId}/lab/runs/${runId}`);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const finished = view.data?.finishedAt;
  useEffect(() => {
    if (finished) return;
    const timer = setInterval(view.reload, 2_000);
    return () => clearInterval(timer);
  }, [finished, view.reload]);
  const accept = async (caseId: string) => {
    setBusy(caseId);
    try { await post(`/api/agents/${agentId}/lab/cases/${caseId}/baseline`, { runId }); setMessage('Baseline saved. Earlier runs keep their original comparison.'); }
    catch (error) { setMessage((error as Error).message); }
    finally { setBusy(null); }
  };
  return <div className="mt-4 min-w-0 space-y-4">
    <p role="status">{view.error ?? (view.data ? finished ? 'Run finished.' : 'Running one saved case at a time.' : 'Loading run…')}</p>
    {view.data?.trigger === 'PREVIEW' && <p className="text-bone-dim">This run used an unsaved draft. Version ids identify its saved starting configuration.</p>}
    {message && <p role="status">{message}</p>}
    {view.data?.results.map(r => <article key={r.caseId} className="min-w-0 rounded-xl border border-ink-line p-4">
      <h4 className="font-medium text-bone">{r.title}</h4>
      {r.error ? <p role="alert" className="text-signal-fail">{r.error}</p> : !r.digest ? <p>{r.jobId ? 'Rehearsing…' : 'Waiting for the previous case.'}</p> : <>
        <p className={r.diff?.severity === 'REGRESSION' ? 'text-signal-fail' : 'text-bone'}>{r.diff?.severity}: {r.baseline.decision} → {r.digest.decision}</p>
        <p>Validator: {r.baseline.validator.outcome} → {r.digest.validator.outcome}</p>
        <p>Voice: {r.baseline.voice.outcome} → {r.digest.voice.outcome}</p>
        <p>{r.diff?.checks.before.verdict} → {r.diff?.checks.after.verdict}. {r.diff?.checks.after.reason}</p>
        <Versions before={r.baseline} after={r.digest} />
        <p className="mt-2 text-bone-dim">{r.diff?.textNote} Length change: {r.diff?.lengthDelta} characters.</p>
        <p className="mt-2 whitespace-pre-wrap break-words" aria-label="Draft word changes">{r.diff?.draft.map((word, i) => word.kind === 'added' ? <ins key={i}>{word.text}{' '}</ins> : word.kind === 'removed' ? <del key={i}>{word.text}{' '}</del> : <span key={i}>{word.text}{' '}</span>)}</p>
        {view.data?.trigger !== 'PREVIEW' && <button className="btn-ghost mt-3 min-h-12" disabled={busy !== null} onClick={() => void accept(r.caseId)}>Accept as new baseline</button>}
      </>}
    </article>)}
  </div>;
}

function Versions({ before, after }: { before: DecisionDigest; after: DecisionDigest }) {
  return <details className="mt-2 break-all text-sm"><summary>Configuration versions</summary>
    <p>Persona: {before.personaVersionId} → {after.personaVersionId}</p>
    <p>Policy: {before.policyVersionId} → {after.policyVersionId}</p>
    <p>Models before: {before.modelRoles.map(m => `${m.role}: ${m.model}`).join(', ') || 'None'}</p>
    <p>Models after: {after.modelRoles.map(m => `${m.role}: ${m.model}`).join(', ') || 'None'}</p>
  </details>;
}

export function RegressionControls({ agentId, candidate, revision }: { agentId: string; candidate?: RegressionCandidate; revision?: unknown }) {
  const cases = useResource<{ items: RegressionCase[]; change?: { pending: boolean; trigger: RegressionTrigger } }>(`/api/agents/${agentId}/lab/cases`, [revision]);
  const [runId, setRunId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const count = cases.data?.items.length ?? 0;
  const [more, setMore] = useState(false);
  const run = async (preview: boolean) => {
    setBusy(true); setError(null);
    try {
      const result = await post<RegressionRun>(`/api/agents/${agentId}/lab/${preview ? 'preview' : 'runs'}`, preview ? { candidate, limit: more ? count : undefined } : { trigger: cases.data?.change?.pending ? cases.data.change.trigger : 'MANUAL', limit: more ? count : undefined });
      setRunId(result.id); cases.reload();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  return <section className="my-4 min-w-0 rounded-xl border border-ink-line p-4" aria-label="Saved case checks">
    <p>{count} saved case{count === 1 ? '' : 's'}{cases.data?.change?.pending ? ', run them now.' : '.'} Each run uses the agent’s models. Up to 12 cases run by default.</p>
    {!count && <p className="text-bone-dim">Save a finished rehearsal in Lab to start comparing changes.</p>}
    {count > 12 && <label className="flex min-h-12 items-center gap-3"><input type="checkbox" checked={more} onChange={event => setMore(event.target.checked)} />Run all {count} cases this time</label>}
    <div className="mt-3 flex flex-wrap gap-3">
      <button className="btn-ghost min-h-12" disabled={busy || !count} onClick={() => void run(false)}>Run saved cases</button>
      {candidate && <button className="btn-primary min-h-12" disabled={busy || !count} onClick={() => void run(true)}>Preview my unsaved edit</button>}
    </div>
    {(error || cases.error) && <p role="alert" className="mt-2 text-signal-fail">{error ?? cases.error}</p>}
    {runId && <RegressionResults key={runId} agentId={agentId} runId={runId} />}
  </section>;
}

export function SaveRegressionCase({ agentId, jobId, onSaved }: { agentId: string; jobId: string; onSaved: () => void }) {
  const id = useId();
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  return <form className="mt-4 space-y-3" onSubmit={async event => {
    event.preventDefault(); setBusy(true); setMessage(null);
    try { await post(`/api/agents/${agentId}/lab/cases`, { jobId, title, checks: {} }); setMessage('Case saved with this rehearsal as its baseline.'); onSaved(); }
    catch (e) { setMessage((e as Error).message); }
    finally { setBusy(false); }
  }}>
    <Field label="Case title" htmlFor={id}><input id={id} className="field min-h-12" value={title} onChange={e => setTitle(e.target.value)} maxLength={200} required /></Field>
    <button className="btn-ghost min-h-12" disabled={busy}>Save as case</button>
    {message && <p role="status">{message}</p>}
  </form>;
}

function CaseEditor({ agentId, item, reload }: { agentId: string; item: RegressionCase; reload: () => void }) {
  const id = useId();
  const [title, setTitle] = useState(item.title);
  const [checks, setChecks] = useState(JSON.stringify(item.checks, null, 2));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async (archive = false) => {
    setBusy(true); setError(null);
    try {
      await api(`/api/agents/${agentId}/lab/cases/${item.id}`, { method: 'PATCH', body: archive ? { archive: true } : { title, checks: RegressionChecks.parse(JSON.parse(checks)) } });
      reload();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  return <details className="rounded-xl border border-ink-line p-4"><summary className="min-h-12 cursor-pointer">{item.title}</summary>
    <p className="mb-3 whitespace-pre-wrap break-words">{item.subject.text}</p>
    <Field label="Title" htmlFor={`${id}-title`}><input id={`${id}-title`} className="field min-h-12" value={title} onChange={e => setTitle(e.target.value)} maxLength={200} /></Field>
    <Field label="Checks (JSON)" htmlFor={`${id}-checks`} hint="Use mustBeSilent, silentOk, forbid, requireOneOf, language or maxChars."><textarea id={`${id}-checks`} className="field mt-2" rows={4} value={checks} onChange={e => setChecks(e.target.value)} /></Field>
    <div className="mt-3 flex flex-wrap gap-3"><button className="btn-ghost min-h-12" disabled={busy || !title.trim()} onClick={() => void save()}>Save case</button><button className="btn-ghost min-h-12" disabled={busy} onClick={() => void save(true)}>Archive case</button></div>
    {error && <p role="alert">{error}</p>}
  </details>;
}

export function RegressionLibrary({ agentId, revision }: { agentId: string; revision: number }) {
  const cases = useResource<{ items: RegressionCase[] }>(`/api/agents/${agentId}/lab/cases`, [revision]);
  const runs = useResource<{ items: RegressionRun[] }>(`/api/agents/${agentId}/lab/runs`, [revision]);
  return <section className="mt-8 min-w-0 space-y-4" aria-label="Regression lab">
    <h3 className="text-xl text-bone">Saved cases</h3>
    <RegressionControls agentId={agentId} revision={revision} />
    {cases.loading && <p role="status">Loading cases…</p>}
    {cases.error && <p role="alert">{cases.error}</p>}
    {cases.data?.items.map(item => <CaseEditor key={item.id} agentId={agentId} item={item} reload={cases.reload} />)}
    <h3 className="text-xl text-bone">Runs</h3>
    <button className="btn-ghost min-h-12" onClick={runs.reload}>Refresh runs</button>
    {runs.error && <p role="alert">{runs.error}</p>}
    {runs.data?.items.length === 0 && <p>No runs yet. Run your saved cases when you are ready.</p>}
    {runs.data?.items.map(run => <details key={run.id} className="min-w-0 rounded-xl border border-ink-line p-4"><summary className="min-h-12 cursor-pointer">{run.trigger}: {new Date(run.createdAt).toLocaleString()}</summary><RegressionResults agentId={agentId} runId={run.id} /></details>)}
  </section>;
}
