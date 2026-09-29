import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, ArrowRight, BookOpenCheck, Search } from 'lucide-react';
import { ApiError, post } from '@app/lib/api';
import { createAgent } from '@app/lib/setup';
import { FadeIn } from '@app/components/motion';
import { ChoiceGroup, ChoiceOption, ErrorPanel, Field, Spinner, StatusDot, Toggle } from '@app/components/ui';

interface Brief {
  text: string;
  handle: string | null;
  projects: string[];
  urls: string[];
  relationship: 'MODELED_AFTER' | 'AUTHORIZED_AS';
  autonomy: 'CONSERVATIVE' | 'SELECTIVE' | 'ACTIVE';
  useMirrors: boolean;
}

interface Plan {
  brief: Brief;
  sources: { name: string; role: string; available: boolean }[];
  reader: { handle: string } | null;
  warning: string | null;
}

/** One option, styled the way Easy Setup styles its choices. */
function Choice({ selected, onSelect, label, detail }: { selected: boolean; onSelect: () => void; label: string; detail: string }) {
  return (
    <ChoiceOption
      selected={selected}
      onSelect={onSelect}
      className={`rounded-lg border px-3.5 py-3 text-left transition-colors ${
        selected ? 'border-signal-calm/60 bg-signal-calm/[0.07] text-bone' : 'border-ink-line text-bone-dim hover:border-bone-faint'
      }`}
    >
      <span className="block text-sm">{label}</span>
      <span className="mt-1 block text-[11px] text-bone-faint">{detail}</span>
    </ChoiceOption>
  );
}

/**
 * Research-backed setup: an agent built from what somebody actually wrote and
 * what a project's own sources say, reviewed before any of it is applied.
 *
 * Three moments, deliberately few: say what you want, see the plan, start.
 * Everything technical (which sources, which trust tier, how a mirror is
 * treated) is shown as a plan a person can read, and nothing runs until they
 * press start. The research itself happens on the next page, where it can be
 * watched.
 */
export function FoundryStart() {
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [text, setText] = useState('');
  const [plan, setPlan] = useState<Plan | null>(null);
  const [busy, setBusy] = useState<'plan' | 'start' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const readPlan = async (override: Partial<Brief> = {}) => {
    setBusy('plan');
    setError(null);
    try {
      const next = await post<Plan>('/api/foundry/plan', { text, ...override });
      setPlan(next);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'The plan could not be read.');
    } finally {
      setBusy(null);
    }
  };

  const edit = (patch: Partial<Brief>) => void readPlan({ ...(plan?.brief ?? {}), ...patch });

  const start = async () => {
    if (!plan) return;
    setBusy('start');
    setError(null);
    try {
      const agentId = await createAgent({ name: name.trim() || (plan.brief.handle ? `${plan.brief.handle} agent` : 'New agent') });
      const started = await post<{ run: { id: string } }>(`/api/agents/${agentId}/foundry`, { ...plan.brief, mode: 'SETUP' });
      navigate(`/agents/${agentId}/foundry/${started.run.id}`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'The research could not be started.');
      setBusy(null);
    }
  };

  return (
    <div className="mx-auto max-w-3xl px-5 py-10 sm:py-16">
      <FadeIn>
        <Link to="/agents/new" className="btn-quiet px-0">
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden />
          Quick setup instead
        </Link>
        <p className="mt-8 font-mono text-[10px] uppercase tracking-[0.2em] text-bone-faint">Research-backed setup</p>
        <h1 className="mt-3 font-display text-4xl font-light tracking-monument text-bone sm:text-5xl">Build an agent from research</h1>
        <p className="mt-4 max-w-xl text-bone-dim">
          Say who it should sound like and what it should know. AI17Z reads their public writing and the project's own sources,
          then shows you every setting it would change and why. Nothing is applied until you say so.
        </p>
      </FadeIn>

      <div className="mt-10 space-y-6">
        <Field label="What is the agent called?" htmlFor="f-name" hint="You can rename it later.">
          <input id="f-name" className="field" value={name} onChange={(e) => setName(e.target.value)} placeholder="Ozzy" />
        </Field>
        <Field
          label="What should it be?"
          htmlFor="f-brief"
          hint="In your own words. Name the account it should sound like with an @, and the projects it should know properly."
        >
          <textarea
            id="f-brief"
            rows={5}
            className="field resize-y"
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setPlan(null);
            }}
            placeholder="Build an agent modelled on @someone. It should deeply understand Example Protocol. It will operate my X account. Keep its autonomy selective."
          />
        </Field>
        {!plan && (
          <button type="button" className="btn-primary" disabled={busy !== null || text.trim().length < 8} onClick={() => void readPlan()}>
            {busy === 'plan' ? <Spinner /> : <Search className="h-4 w-4" aria-hidden />}
            Show me the plan
          </button>
        )}
      </div>

      {error && (
        <div className="mt-6">
          <ErrorPanel title="That did not work" detail={error} />
        </div>
      )}

      {plan && (
        <FadeIn>
          <section aria-labelledby="plan-title" className="mt-10 rounded-lg border border-ink-line bg-ink-panel p-5 sm:p-6">
            <h2 id="plan-title" className="flex items-center gap-2 text-lg text-bone">
              <BookOpenCheck className="h-5 w-5" aria-hidden />
              The plan
            </h2>

            <div className="mt-5 grid gap-5 sm:grid-cols-2">
              <Field label="Sounds like" htmlFor="f-handle" hint="Their public posts and replies on X.">
                <input
                  id="f-handle"
                  className="field font-mono text-[13px]"
                  defaultValue={plan.brief.handle ? `@${plan.brief.handle}` : ''}
                  onBlur={(e) => edit({ handle: e.target.value.replace(/^@+/, '').trim() || null })}
                  placeholder="@handle"
                />
              </Field>
              <Field label="Knows about" htmlFor="f-projects" hint="Comma separated. Their own documentation and repositories are looked for.">
                <input
                  id="f-projects"
                  className="field"
                  defaultValue={plan.brief.projects.join(', ')}
                  onBlur={(e) => edit({ projects: e.target.value.split(',').map((p) => p.trim()).filter(Boolean).slice(0, 6) })}
                />
              </Field>
            </div>

            <div className="mt-6">
              <p className="text-sm text-bone">Who it is</p>
              <ChoiceGroup label="Who it is" className="mt-2 grid gap-2 sm:grid-cols-2">
                <Choice selected={plan.brief.relationship === 'MODELED_AFTER'} onSelect={() => edit({ relationship: 'MODELED_AFTER' })} label="Modelled after them" detail="Writes the way they do, never claims to be them. The safe default." />
                <Choice selected={plan.brief.relationship === 'AUTHORIZED_AS'} onSelect={() => edit({ relationship: 'AUTHORIZED_AS' })} label="Speaks for them" detail="Only if the account and the voice are yours to speak for. It still never denies being an AI." />
              </ChoiceGroup>
            </div>
            <div className="mt-5">
              <p className="text-sm text-bone">How much it does on its own</p>
              <ChoiceGroup label="How much it does on its own" className="mt-2 grid gap-2 sm:grid-cols-3">
                <Choice selected={plan.brief.autonomy === 'CONSERVATIVE'} onSelect={() => edit({ autonomy: 'CONSERVATIVE' })} label="Conservative" detail="Drafts everything for you to approve." />
                <Choice selected={plan.brief.autonomy === 'SELECTIVE'} onSelect={() => edit({ autonomy: 'SELECTIVE' })} label="Selective" detail="Answers on its own when a message is worth it. Never speaks first without you." />
                <Choice selected={plan.brief.autonomy === 'ACTIVE'} onSelect={() => edit({ autonomy: 'ACTIVE' })} label="Active" detail="Also approaches people on its own, within daily limits." />
              </ChoiceGroup>
            </div>

            <div className="mt-6">
              <p className="text-sm text-bone">Where it will look</p>
              <ul className="mt-2 space-y-2">
                {plan.sources.map((s) => (
                  <li key={s.name} className="flex items-start justify-between gap-3 text-sm">
                    <span className="min-w-0">
                      <span className="break-words text-bone">{s.name}</span>
                      <span className="block text-[12px] text-bone-faint">{s.role}</span>
                    </span>
                    <StatusDot state={s.available ? 'idle' : 'wait'} label={s.available ? 'Ready' : 'Needs X'} />
                  </li>
                ))}
              </ul>
              <div className="mt-3">
                <Toggle
                  checked={plan.brief.useMirrors}
                  onChange={(v) => edit({ useMirrors: v })}
                  label="Ask public mirrors too"
                  description="TwStalker and Sotwe can hold older public posts. They are copies, never trusted on their own, and often refuse automated readers; setup never depends on them."
                />
              </div>
            </div>

            {plan.warning && <p className="mt-5 rounded border border-signal-wait/40 bg-signal-wait/5 p-3 text-sm text-bone">{plan.warning}</p>}

            <div className="mt-6 flex flex-wrap items-center gap-3">
              <button type="button" className="btn-primary" disabled={busy !== null || (!plan.brief.handle && plan.brief.projects.length === 0 && plan.brief.urls.length === 0)} onClick={() => void start()}>
                {busy === 'start' ? <Spinner /> : <ArrowRight className="h-4 w-4" aria-hidden />}
                Create the agent and start researching
              </button>
              <p className="text-[12px] text-bone-faint">Research takes a few minutes and keeps going if you close this page.</p>
            </div>
          </section>
        </FadeIn>
      )}
    </div>
  );
}
