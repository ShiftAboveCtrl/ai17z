import { useEffect, useState } from 'react';
import type { PolicyConfig } from '@app/lib/types';
import { ApiError, put } from '@app/lib/api';
import { Field, SavedTick, Spinner, Toggle } from '@app/components/ui';
import { Section } from './Section';

const MODES = ['OFF', 'MONITOR_ONLY', 'MANUAL_ONLY', 'REVIEW_BEFORE_ACTION', 'AUTONOMOUS'] as const;
const DISCLOSURE = ['ON_REQUEST', 'ALWAYS', 'NONE'] as const;

/** Policies sit between persona and action. This is the only place they change. */
export function PoliciesSection({
  index,
  agentId,
  policy,
  version,
  onSaved,
}: {
  index: number;
  agentId: string;
  policy: PolicyConfig | null;
  version: number;
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState<PolicyConfig | null>(policy);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setDraft(policy), [policy]);
  if (!draft) return null;

  const patch = (mutate: (next: PolicyConfig) => void) => {
    setDraft((current) => {
      if (!current) return current;
      const next = structuredClone(current);
      mutate(next);
      return next;
    });
  };

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await put(`/api/agents/${agentId}/policy`, { config: draft, changeNote: 'edited in the policies section' });
      setSaved(true);
      setTimeout(() => setSaved(false), 2400);
      onSaved();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'The policy could not be saved.');
    } finally {
      setBusy(false);
    }
  };

  const list = (value: string) => value.split(',').map((v) => v.trim()).filter(Boolean);

  return (
    <Section
      id="policies"
      index={index}
      eyebrow="Policies"
      heading="What it may do."
      lede="Policy is evaluated between generation and action, and pinned to each job when it starts. Changing it never alters what an in-flight job was allowed to do."
    >
      <div className="grid gap-10 lg:grid-cols-2">
        <div className="space-y-6">
          <Field label="Automation" hint="Review mode holds every message for a person before anything is sent.">
            <div className="space-y-2">
              {MODES.map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => patch((n) => void (n.automation.mode = mode))}
                  className={`block w-full rounded-lg border px-3.5 py-2.5 text-left text-sm capitalize transition-colors ${draft.automation.mode === mode ? 'border-signal-calm/60 bg-signal-calm/[0.07] text-bone' : 'border-ink-line text-bone-dim hover:border-bone-faint'}`}
                >
                  {mode.replace(/_/g, ' ').toLowerCase()}
                </button>
              ))}
            </div>
          </Field>

          <Toggle
            checked={draft.automation.dryRunDefault}
            onChange={(v) => patch((n) => void (n.automation.dryRunDefault = v))}
            label="Dry run by default"
            description="New jobs run the full pipeline, verify the target, and stop before touching the remote."
          />

          <Field label="Disclosure" hint="How the agent answers when asked whether it is an AI.">
            <select
              className="field capitalize"
              value={draft.identity.disclosure}
              onChange={(e) => patch((n) => void (n.identity.disclosure = e.target.value as PolicyConfig['identity']['disclosure']))}
            >
              {DISCLOSURE.map((d) => (
                <option key={d} value={d}>
                  {d.replace(/_/g, ' ').toLowerCase()}
                </option>
              ))}
            </select>
          </Field>

          <Toggle
            checked={draft.identity.mayDenyBeingAI}
            onChange={(v) => patch((n) => void (n.identity.mayDenyBeingAI = v))}
            label="May claim to be human"
            description="Off by default, and the validator rejects any message that claims humanity while this is off."
          />

          <Field label="Represented entity" hint="Named person or organisation this agent is authorised to speak for.">
            <input
              className="field"
              value={draft.identity.representedEntity}
              onChange={(e) => patch((n) => void (n.identity.representedEntity = e.target.value))}
              placeholder="Acme Inc."
            />
          </Field>
        </div>

        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-4">
            <Field label="Max characters">
              <input type="number" className="field" value={draft.output.maxCharacters} onChange={(e) => patch((n) => void (n.output.maxCharacters = Number(e.target.value) || 280))} />
            </Field>
            <Field label="Max attempts">
              <input type="number" className="field" value={draft.safety.maxAttempts} onChange={(e) => patch((n) => void (n.safety.maxAttempts = Number(e.target.value) || 5))} />
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <Field label="Actions per hour">
              <input type="number" className="field" value={draft.rate.maxActionsPerHour} onChange={(e) => patch((n) => void (n.rate.maxActionsPerHour = Number(e.target.value) || 0))} />
            </Field>
            <Field label="Seconds between actions">
              <input type="number" className="field" value={draft.rate.minSecondsBetweenActions} onChange={(e) => patch((n) => void (n.rate.minSecondsBetweenActions = Number(e.target.value) || 0))} />
            </Field>
          </div>

          <Toggle
            checked={draft.safety.requireTargetVerification}
            onChange={(v) => patch((n) => void (n.safety.requireTargetVerification = v))}
            label="Require target verification"
            description="Refuse to act unless the adapter positively identified the exact remote object."
          />
          <Toggle
            checked={draft.safety.reviewOnValidationFailure}
            onChange={(v) => patch((n) => void (n.safety.reviewOnValidationFailure = v))}
            label="Send validation failures to review"
            description="Rather than retrying a prompt that will produce the same class of answer."
          />

          <Field label="Never reply to" hint="Comma separated handles.">
            <input className="field" value={draft.content.blockedRemoteHandles.join(', ')} onChange={(e) => patch((n) => void (n.content.blockedRemoteHandles = list(e.target.value)))} />
          </Field>
          <Field label="Own handles" hint="Comma separated. The agent never acts on its own posts.">
            <input className="field" value={draft.content.selfHandles.join(', ')} onChange={(e) => patch((n) => void (n.content.selfHandles = list(e.target.value)))} />
          </Field>
          <Field label="Tools allowed" hint="Comma separated tool keys, for example time.now, memory.search.">
            <input className="field" value={draft.tools.allowed.join(', ')} onChange={(e) => patch((n) => void (n.tools.allowed = list(e.target.value)))} />
          </Field>
        </div>
      </div>

      {/*
        Helping people with the software this agent runs on. Off by default and
        it stays that way: everybody's agent becoming a support bot for AI17Z is
        a persona leak, not a feature.
      */}
      <div className="mt-10 border-t border-ink-line pt-8">
        <p className="eyebrow">Support</p>
        <h4 className="mt-2 text-base font-light text-bone">Helping people with the software it runs on</h4>
        <p className="mt-2 max-w-2xl text-[13px] leading-relaxed text-bone-faint">
          Most agents should leave this off. It is for the official agent of a project: it lets this one answer
          questions about the software using the documentation you have attached, say which version it is running, and
          optionally describe what its own runtime is doing, so it can say &ldquo;your notifications monitor has been
          failing for eleven minutes&rdquo; instead of &ldquo;have you checked your configuration&rdquo;.
        </p>

        <div className="mt-6 grid gap-8 lg:grid-cols-2">
          <div className="space-y-6">
            <Toggle
              checked={draft.support.enabled}
              onChange={(v) => patch((n) => void (n.support.enabled = v))}
              label="Answer questions about the software"
              description="Uses the documentation attached under Knowledge, and says which version this installation is."
            />
            {draft.support.enabled && (
              <Toggle
                checked={draft.support.describeOwnRuntime}
                onChange={(v) => patch((n) => void (n.support.describeOwnRuntime = v))}
                label="Describe its own runtime when asked"
                description="Account, discovery, browser, models and recent failures. Never keys, sessions or anything a person typed."
              />
            )}
          </div>

          {draft.support.enabled && (
            <div className="space-y-6">
              <Field label="What it supports" hint="Named, so this works for something other than AI17Z without a fork.">
                <input
                  className="field"
                  value={draft.support.subject}
                  onChange={(e) => patch((n) => void (n.support.subject = e.target.value))}
                  placeholder="AI17Z"
                />
              </Field>
            </div>
          )}
        </div>
      </div>

      {/*
        Speaking first, which is a different act from answering and has a
        different failure mode. Everything above is about what the agent does
        when somebody comes to it; this is about it going to them.
      */}
      <div className="mt-10 border-t border-ink-line pt-8">
        <p className="eyebrow">Approaching people</p>
        <h4 className="mt-2 text-base font-light text-bone">Speaking first, under a post nobody sent it</h4>
        <p className="mt-2 max-w-2xl text-[13px] leading-relaxed text-bone-faint">
          Watched accounts and watched topics are set up on the account itself. This decides whether anything is ever
          said under what they find. Answering somebody badly is awkward; approaching a stranger badly is what people
          mean when they call an account a bot, so it is held to a higher bar than a reply and shown to you first
          unless you say otherwise.
        </p>

        <div className="mt-6 grid gap-8 lg:grid-cols-2">
          <div className="space-y-6">
            <Toggle
              checked={draft.outreach.enabled}
              onChange={(v) => patch((n) => void (n.outreach.enabled = v))}
              label="Approach people unprompted"
              description="Off means watched sources still collect what they find, and the agent never speaks under any of it."
            />

            {draft.outreach.enabled && (
              <>
                <Field label="Before it goes out" hint="What you see before an unprompted approach is published.">
                  <div className="space-y-2">
                    {(['REVIEW', 'AUTONOMOUS'] as const).map((mode) => (
                      <button
                        key={mode}
                        type="button"
                        onClick={() => patch((n) => void (n.outreach.mode = mode))}
                        className={`block w-full rounded-lg border px-3.5 py-2.5 text-left text-sm transition-colors ${draft.outreach.mode === mode ? 'border-signal-calm/60 bg-signal-calm/[0.07] text-bone' : 'border-ink-line text-bone-dim hover:border-bone-faint'}`}
                      >
                        {mode === 'REVIEW' ? 'Show me each one first' : 'Send them without asking me'}
                      </button>
                    ))}
                  </div>
                </Field>

                <Toggle
                  checked={draft.outreach.requireTopicMatch}
                  onChange={(v) => patch((n) => void (n.outreach.requireTopicMatch = v))}
                  label="Only about things it follows"
                  description="A watched keyword matches on one word, often in a post about something else entirely."
                />
              </>
            )}
          </div>

          {draft.outreach.enabled && (
            <div className="space-y-6">
              <Field
                label="Worth speaking up about"
                hint={`Out of 100. A reply only has to clear ${draft.engagement.minimumReplyValue}; butting in should be worth more than that.`}
              >
                <input
                  type="number"
                  className="field"
                  value={draft.outreach.minimumValue}
                  onChange={(e) => patch((n) => void (n.outreach.minimumValue = Number(e.target.value) || 0))}
                />
              </Field>

              <div className="grid grid-cols-2 gap-4">
                <Field label="People a day" hint="Nothing to do with how many replies it sends.">
                  <input
                    type="number"
                    className="field"
                    value={draft.outreach.maxPerDay}
                    onChange={(e) => patch((n) => void (n.outreach.maxPerDay = Number(e.target.value) || 0))}
                  />
                </Field>
                <Field label="Days before the same person again">
                  <input
                    type="number"
                    className="field"
                    value={draft.outreach.cooldownDaysPerAuthor}
                    onChange={(e) => patch((n) => void (n.outreach.cooldownDaysPerAuthor = Number(e.target.value) || 0))}
                  />
                </Field>
              </div>

              {draft.outreach.minimumValue <= draft.engagement.minimumReplyValue && (
                // Not blocked, because it is a legitimate choice. Said out loud,
                // because it is almost never the one somebody meant to make.
                <p className="break-words text-[13px] text-amber-300">
                  This is the same bar as a reply, or lower. The agent will approach strangers as readily as it answers
                  the people who asked it something.
                </p>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="mt-8 flex flex-wrap items-center gap-4 border-t border-ink-line pt-6">
        <button type="button" className="btn-primary" onClick={() => void save()} disabled={busy}>
          {busy && <Spinner />}
          Save as version {version + 1}
        </button>
        <SavedTick visible={saved} />
        <span className="ml-auto font-mono text-[10px] uppercase tracking-[0.16em] text-bone-faint">Currently v{version}</span>
        {error && <p className="w-full text-sm text-signal-fail">{error}</p>}
      </div>
    </Section>
  );
}
