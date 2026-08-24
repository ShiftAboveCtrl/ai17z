import { useEffect, useState } from 'react';
import type { PersonaVersion } from '@xbam/shared/contracts';
import { ApiError, put } from '@app/lib/api';
import { Field, SavedTick, Spinner } from '@app/components/ui';
import { Section } from './Section';

const IDENTITY_KINDS = ['DISCLOSED_AI', 'FICTIONAL', 'INSPIRED_BY', 'BRAND', 'REAL_PERSON_AUTHORIZED'] as const;
const LENGTHS = ['TERSE', 'SHORT', 'MEDIUM', 'LONG', 'ADAPTIVE'] as const;

/** Editing a persona always cuts a new version; nothing is overwritten in place. */
export function IdentitySection({
  index,
  agentId,
  agentName,
  persona,
  onSaved,
}: {
  index: number;
  agentId: string;
  agentName: string;
  persona: PersonaVersion | null;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState<PersonaVersion | null>(persona);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setDraft(persona), [persona]);

  if (!draft) {
    return (
      <Section id="identity" index={index} eyebrow="Identity" heading={`Who is ${agentName}?`}>
        <p className="text-bone-dim">This agent has no persona version yet.</p>
      </Section>
    );
  }

  const set = <K extends keyof PersonaVersion>(key: K, value: PersonaVersion[K]) =>
    setDraft((d) => (d ? { ...d, [key]: value } : d));

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await put(`/api/agents/${agentId}/persona`, {
        identityKind: draft.identityKind,
        displayName: draft.displayName,
        biography: draft.biography,
        personality: draft.personality,
        tone: draft.tone,
        styleGuidelines: draft.styleGuidelines,
        styleExamples: draft.styleExamples,
        topics: draft.topics,
        languagePolicy: draft.languagePolicy,
        responseLength: draft.responseLength,
        prohibitedBehaviors: draft.prohibitedBehaviors,
        customInstructions: draft.customInstructions,
        changeNote: 'edited in the identity section',
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2400);
      onSaved();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'The persona could not be saved.');
    } finally {
      setBusy(false);
    }
  };

  const lines = (value: string) => value.split('\n').map((s) => s.trim()).filter(Boolean);

  return (
    <Section
      id="identity"
      index={index}
      eyebrow="Identity"
      heading={`Who is ${draft.displayName || agentName}?`}
      lede="Everything the model is told about itself lives here, as versioned data. Saving creates a new persona version, and every generation records which one it used."
    >
      <div className="grid gap-8 lg:grid-cols-2">
        <div className="space-y-6">
          <Field label="Display name" htmlFor="displayName">
            <input id="displayName" className="field" value={draft.displayName} onChange={(e) => set('displayName', e.target.value)} />
          </Field>
          <Field label="Identity kind" htmlFor="identityKind" hint="Drives what the agent is allowed to claim about itself.">
            <select id="identityKind" className="field capitalize" value={draft.identityKind} onChange={(e) => set('identityKind', e.target.value as PersonaVersion['identityKind'])}>
              {IDENTITY_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {kind.replace(/_/g, ' ').toLowerCase()}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Personality" htmlFor="personality">
            <textarea id="personality" rows={4} className="field resize-y" value={draft.personality} onChange={(e) => set('personality', e.target.value)} />
          </Field>
          <Field label="Tone" htmlFor="tone">
            <input id="tone" className="field" value={draft.tone} onChange={(e) => set('tone', e.target.value)} />
          </Field>
          <Field label="Response length" htmlFor="responseLength">
            <select id="responseLength" className="field capitalize" value={draft.responseLength} onChange={(e) => set('responseLength', e.target.value as PersonaVersion['responseLength'])}>
              {LENGTHS.map((l) => (
                <option key={l} value={l}>
                  {l.toLowerCase()}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <div className="space-y-6">
          <Field label="Biography" htmlFor="biography" hint="Background facts, injected as the persona layer of every prompt.">
            <textarea id="biography" rows={7} className="field resize-y" value={draft.biography} onChange={(e) => set('biography', e.target.value)} />
          </Field>
          <Field label="Topics" htmlFor="topics" hint="Comma separated.">
            <input id="topics" className="field" value={draft.topics.join(', ')} onChange={(e) => set('topics', e.target.value.split(',').map((t) => t.trim()).filter(Boolean))} />
          </Field>
          <Field label="Style examples" htmlFor="styleExamples" hint="One per line. Verbatim samples of the voice.">
            <textarea id="styleExamples" rows={5} className="field resize-y font-mono text-[13px]" value={draft.styleExamples.join('\n')} onChange={(e) => set('styleExamples', lines(e.target.value))} />
          </Field>
          <Field label="Language" htmlFor="languagePolicy" hint="Blank means mirror the incoming language.">
            <input id="languagePolicy" className="field" value={draft.languagePolicy} onChange={(e) => set('languagePolicy', e.target.value)} />
          </Field>
          <Field label="Must never" htmlFor="prohibited" hint="One per line.">
            <textarea id="prohibited" rows={3} className="field resize-y" value={draft.prohibitedBehaviors.join('\n')} onChange={(e) => set('prohibitedBehaviors', lines(e.target.value))} />
          </Field>
        </div>
      </div>

      <div className="mt-8 flex flex-wrap items-center gap-4 border-t border-ink-line pt-6">
        <button type="button" className="btn-primary" onClick={() => void save()} disabled={busy}>
          {busy && <Spinner />}
          Save as version {draft.version + 1}
        </button>
        <SavedTick visible={saved} />
        <span className="ml-auto font-mono text-[10px] uppercase tracking-[0.16em] text-bone-faint">Currently v{draft.version}</span>
        {error && <p className="w-full text-sm text-signal-fail">{error}</p>}
      </div>
    </Section>
  );
}
