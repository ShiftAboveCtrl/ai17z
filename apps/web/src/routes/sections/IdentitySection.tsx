import { useEffect, useState } from 'react';
import type { PersonaVersion } from '@xbam/shared/contracts';
import { PERSONA_LIMITS } from '@xbam/shared/contracts';
import { ApiError, put } from '@app/lib/api';
import { Field, SavedTick, Spinner, Toggle } from '@app/components/ui';
import { describeSaveState, useAutosave, useAutosaveEnabled } from '@app/lib/autosave';
import { PersonaSources } from '@app/components/PersonaSources';
import { AvatarEditor } from '@app/components/AvatarEditor';
import { Section } from './Section';

const IDENTITY_KINDS = ['DISCLOSED_AI', 'FICTIONAL', 'INSPIRED_BY', 'BRAND', 'REAL_PERSON_AUTHORIZED'] as const;
const LENGTHS = ['TERSE', 'SHORT', 'MEDIUM', 'LONG', 'ADAPTIVE'] as const;

/**
 * How much room is left, from the same numbers the API enforces.
 *
 * Imported rather than repeated: a counter that disagrees with the rule which
 * rejects the save is worse than no counter, because it is confidently wrong.
 * Quiet until it matters, so eleven fields do not each shout a number.
 */
function Counter({ value, limit }: { value: string; limit: number }) {
  const used = value.length;
  const near = used > limit * 0.9;
  const over = used > limit;
  if (!near) return null;
  return (
    <p className={`mt-1 text-[11px] ${over ? 'text-signal-fail' : 'text-signal-wait'}`}>
      {used.toLocaleString()} / {limit.toLocaleString()}
      {over ? ` — remove at least ${(used - limit).toLocaleString()} to save` : ''}
    </p>
  );
}

/** Editing a persona always cuts a new version; nothing is overwritten in place. */
export function IdentitySection({
  index,
  agentId,
  agentName,
  avatarUrl,
  persona,
  onSaved,
}: {
  index: number;
  agentId: string;
  agentName: string;
  avatarUrl: string | null;
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

  const [autosaveOn, setAutosaveOn] = useAutosaveEnabled();

  /** Everything a save sends, so autosave and the button cannot diverge. */
  const payload = (current: PersonaVersion) => ({
    identityKind: current.identityKind,
    displayName: current.displayName,
    biography: current.biography,
    personality: current.personality,
    tone: current.tone,
    styleGuidelines: current.styleGuidelines,
    styleExamples: current.styleExamples,
    topics: current.topics,
    languagePolicy: current.languagePolicy,
    responseLength: current.responseLength,
    prohibitedBehaviors: current.prohibitedBehaviors,
    customInstructions: current.customInstructions,
    changeNote: 'edited in the identity section',
  });

  // Compared as the payload, not as the version record.
  //
  // A PersonaVersion carries id, version and createdAt, and the server assigns
  // fresh ones on every save. Comparing whole records means the editor can
  // never match what it just sent, so it saves again, and again, and the label
  // sits on "Saving" for ever while the requests all succeed.
  const auto = useAutosave({
    draft: draft ? payload(draft) : null,
    saved: persona ? payload(persona) : null,
    enabled: autosaveOn && draft !== null,
    save: async (current) => {
      if (!current) return;
      // Marked as autosave so consecutive ones collapse into one version
      // rather than leaving a version per pause in typing.
      await put(`/api/agents/${agentId}/persona?autosave=1`, current);
    },
  });

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
      {/*
        The face, first, because it is the part of an identity somebody looks
        at rather than reads -- and because it was the one thing here that
        could be set once and never changed.
      */}
      <div className="mb-10 border-b border-ink-line pb-10">
        <AvatarEditor
          agentId={agentId}
          name={draft.displayName || agentName}
          avatarUrl={avatarUrl}
          onChanged={onSaved}
        />
      </div>

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
            <Counter value={draft.personality} limit={PERSONA_LIMITS.personality} />
          </Field>
          <Field label="Tone" htmlFor="tone">
            <input id="tone" className="field" value={draft.tone} onChange={(e) => set('tone', e.target.value)} />
            <Counter value={draft.tone} limit={PERSONA_LIMITS.tone} />
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
            <Counter value={draft.biography} limit={PERSONA_LIMITS.biography} />
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

      {/*
        Full width rather than a third column: both of these are paragraphs, and
        both were unreachable until now. They are saved on every edit and are
        rendered into every prompt, so an agent could carry rules nobody could
        read or change from here.
      */}
      <div className="mt-6 space-y-6">
        <Field
          label="Style guidelines"
          htmlFor="styleGuidelines"
          hint="How it writes, in prose. Injected as the style layer of every prompt, alongside the examples."
        >
          <textarea
            id="styleGuidelines"
            rows={6}
            className="field resize-y"
            value={draft.styleGuidelines}
            onChange={(e) => set('styleGuidelines', e.target.value)}
          />
          <Counter value={draft.styleGuidelines} limit={PERSONA_LIMITS.styleGuidelines} />
        </Field>
        <Field
          label="Additional instructions"
          htmlFor="customInstructions"
          hint="Standing rules and facts it always has to hand: links, addresses, how to answer a particular kind of question."
        >
          <textarea
            id="customInstructions"
            rows={8}
            className="field resize-y"
            value={draft.customInstructions}
            onChange={(e) => set('customInstructions', e.target.value)}
          />
          <Counter value={draft.customInstructions} limit={PERSONA_LIMITS.customInstructions} />
        </Field>
      </div>

      <div className="mt-10">
        <PersonaSources agentId={agentId} onApplied={onSaved} />
      </div>

      <div className="mt-8 flex flex-wrap items-center gap-4 border-t border-ink-line pt-6">
        <button type="button" className="btn-primary" onClick={() => void save()} disabled={busy}>
          {busy && <Spinner />}
          Save
        </button>
        <SavedTick visible={saved} />
        <Toggle
          checked={autosaveOn}
          onChange={setAutosaveOn}
          label="Auto save"
          description="Saves a moment after you stop typing. Consecutive autosaves become one version, not one each."
        />
        {/*
          Never optimistic. "Saved" appears only once the server has said so,
          because somebody who closes a tab on a false "Saved" loses the work.
        */}
        {autosaveOn && auto.state !== 'idle' && (
          <span className={`text-[12px] ${auto.state === 'failed' ? 'text-signal-fail' : 'text-bone-faint'}`}>
            {describeSaveState(auto.state)}
            {auto.error ? `: ${auto.error}` : ''}
          </span>
        )}
        <span className="ml-auto font-mono text-[10px] uppercase tracking-[0.16em] text-bone-faint">Currently v{draft.version}</span>
        {error && <p className="w-full text-sm text-signal-fail">{error}</p>}
      </div>
    </Section>
  );
}
