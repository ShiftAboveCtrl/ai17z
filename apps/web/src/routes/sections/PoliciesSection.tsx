import { useEffect, useState } from 'react';
import type { PolicyConfig } from '@app/lib/types';
import { ApiError, get, put } from '@app/lib/api';
import { ChoiceGroup, ChoiceOption, Field, SavedTick, Spinner, Toggle } from '@app/components/ui';
import { Section, useSubHeading } from './Section';

/** What the spending endpoint answers with. One report per limit, plus warnings. */
interface LimitReport {
  limit: number | null;
  used: number;
  inert: boolean;
  says: string;
}
interface SpendingReport {
  callsPerJob: LimitReport;
  callsPerDay: LimitReport;
  callsPerMonth: LimitReport;
  researchPerEvent: LimitReport;
  costPerDay: LimitReport;
  warnings: string[];
}

const MODES = ['OFF', 'MONITOR_ONLY', 'MANUAL_ONLY', 'REVIEW_BEFORE_ACTION', 'AUTONOMOUS'] as const;
const DISCLOSURE = ['ON_REQUEST', 'ALWAYS', 'NONE'] as const;
const ENGAGEMENT = ['ALWAYS_REPLY', 'SELECTIVE', 'QUESTIONS_ONLY', 'NEVER_AUTO_IGNORE'] as const;
const LINK_POLICY = ['IGNORE_LINKS', 'READ_METADATA', 'READ_PAGE_IF_RELEVANT', 'ALWAYS_RESOLVE_ALLOWED_DOMAINS'] as const;
const VISION_FAILURE = ['RETRY', 'RESPOND_TEXT_ONLY_IF_SAFE', 'REVIEW', 'IGNORE'] as const;
const STANCE_CONFLICT = ['REWRITE', 'REVIEW', 'ALLOW_AND_REVISE', 'IGNORE'] as const;

/**
 * One labelled group of related settings.
 *
 * Policy used to be sixteen controls in two columns with nothing saying which
 * belonged together -- identity, spending, rate limits and content rules in one
 * undifferentiated list.
 */
function Group({ title, blurb, children }: { title: string; blurb: string; children: React.ReactNode }) {
  // One level below whatever the surrounding section used, rather than always
  // `h4` -- which skipped a level on the agent page.
  const H = useSubHeading();
  return (
    <section className="space-y-4">
      <div className="border-b border-ink-line pb-3">
        <H className="text-sm text-bone">{title}</H>
        <p className="mt-1 max-w-2xl text-[12px] leading-relaxed text-bone-faint">{blurb}</p>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">{children}</div>
    </section>
  );
}

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
  const [spending, setSpending] = useState<SpendingReport | null>(null);

  useEffect(() => setDraft(policy), [policy]);
  // Read after every save, so the sentences under each limit describe the
  // policy that is now in force rather than the one being edited.
  useEffect(() => {
    let live = true;
    void get<SpendingReport>(`/api/agents/${agentId}/spending`)
      .then((report) => live && setSpending(report))
      .catch(() => live && setSpending(null));
    return () => {
      live = false;
    };
  }, [agentId, version]);
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
      explain={
        <>
          <p><strong>The rules the agent cannot break</strong>, whatever it decides in the moment. How often it may post, how much it may spend, what it must never say, whether it may claim to be human.</p>
          <p>These are checked after the text is written and before anything is sent, so a model having an off day cannot talk its way past them.</p>
          <p>The defaults are cautious. You can loosen them; nothing loosens itself.</p>
        </>
      }
    >
      {/*
        Grouped, because sixteen unrelated controls in one column is not a form
        anybody can read. These are eight different kinds of decision -- who it
        talks to, what it may write, what it reads, what it costs -- and the
        wall gave no clue which was which.

        Everything the runtime enforces is here. Thirty of these settings were
        enforced and reachable from no screen at all; `policyReachability.ts`
        classifies every one and the test fails if a new field appears without a
        decision.
      */}
      <div className="space-y-10">
        <Group title="Automation" blurb="What it is allowed to do without being asked.">
          <Field label="Automation" hint="Review mode holds every message for a person before anything is sent.">
            <ChoiceGroup label="Automation" className="space-y-2">
              {MODES.map((mode) => (
                <ChoiceOption
                  key={mode}
                  selected={draft.automation.mode === mode}
                  onSelect={() => patch((n) => void (n.automation.mode = mode))}
                  className={`block w-full rounded-lg border px-3.5 py-2.5 text-left text-sm capitalize transition-colors ${draft.automation.mode === mode ? 'border-signal-calm/60 bg-signal-calm/[0.07] text-bone' : 'border-ink-line text-bone-dim hover:border-bone-faint'}`}
                >
                  {mode.replace(/_/g, ' ').toLowerCase()}
                </ChoiceOption>
              ))}
            </ChoiceGroup>
          </Field>
          <Toggle
            checked={draft.automation.dryRunDefault}
            onChange={(v) => patch((n) => void (n.automation.dryRunDefault = v))}
            label="Dry run by default"
            description="New jobs run the full pipeline, verify the target, and stop before touching the remote."
          />
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
          <div className="grid grid-cols-2 gap-4">
            <Field label="Max attempts">
              <input type="number" className="field" value={draft.safety.maxAttempts} onChange={(e) => patch((n) => void (n.safety.maxAttempts = Number(e.target.value) || 5))} />
            </Field>
            <Field label="Actions per hour">
              <input type="number" className="field" value={draft.rate.maxActionsPerHour} onChange={(e) => patch((n) => void (n.rate.maxActionsPerHour = Number(e.target.value) || 0))} />
            </Field>
          </div>
          <Field label="Seconds between actions">
            <input type="number" className="field" value={draft.rate.minSecondsBetweenActions} onChange={(e) => patch((n) => void (n.rate.minSecondsBetweenActions = Number(e.target.value) || 0))} />
          </Field>
        </Group>

        <Group title="Identity" blurb="What it says about itself.">
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
          <Field label="How it says so" hint="The exact sentence used when it discloses.">
            <input
              className="field"
              value={draft.identity.disclosureStatement}
              onChange={(e) => patch((n) => void (n.identity.disclosureStatement = e.target.value))}
              placeholder="I am an AI agent."
            />
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
        </Group>

        <Group title="What it writes" blurb="Checked on the finished text, after the model has done its part.">
          <div className="grid grid-cols-2 gap-4">
            <Field label="Max characters">
              <input type="number" className="field" value={draft.output.maxCharacters} onChange={(e) => patch((n) => void (n.output.maxCharacters = Number(e.target.value) || 280))} />
            </Field>
            <Field label="Min characters" hint="A reply shorter than this is treated as a failure.">
              <input type="number" className="field" value={draft.output.minCharacters} onChange={(e) => patch((n) => void (n.output.minCharacters = Number(e.target.value) || 0))} />
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <Field label="Emoji per message">
              <input type="number" className="field" value={draft.output.emoji.maxPerMessage} onChange={(e) => patch((n) => void (n.output.emoji.maxPerMessage = Number(e.target.value) || 0))} />
            </Field>
            <Field label="In how many messages" hint="Percent. Surplus emoji are removed after generation.">
              <input type="number" className="field" value={draft.output.emoji.messagesPercent} onChange={(e) => patch((n) => void (n.output.emoji.messagesPercent = Number(e.target.value) || 0))} />
            </Field>
          </div>
          <Toggle checked={draft.output.forbidHashtags} onChange={(v) => patch((n) => void (n.output.forbidHashtags = v))} label="No hashtags" description="Removed from the finished text." />
          <Toggle checked={draft.output.forbidLinks} onChange={(v) => patch((n) => void (n.output.forbidLinks = v))} label="No links" description="A reply containing one is refused." />
          <Toggle checked={draft.output.forbidMentionsOfOthers} onChange={(v) => patch((n) => void (n.output.forbidMentionsOfOthers = v))} label="No mentions of other accounts" description="Beyond the person being replied to." />
          <Toggle checked={draft.output.stripSurroundingQuotes} onChange={(v) => patch((n) => void (n.output.stripSurroundingQuotes = v))} label="Strip surrounding quotes" description="Models often wrap a reply in quotation marks. This removes them." />
          <Field label="Phrases it must never write" hint="Comma separated. Matched on the finished text.">
            <input className="field" value={draft.output.bannedPhrases.join(', ')} onChange={(e) => patch((n) => void (n.output.bannedPhrases = list(e.target.value)))} />
          </Field>
        </Group>

        <Group title="Who it answers" blurb="Which posts are worth a reply, and whose.">
          <Field label="How selective" hint="Silence is a valid outcome, not a failure.">
            <select
              className="field capitalize"
              value={draft.engagement.strategy}
              onChange={(e) => patch((n) => void (n.engagement.strategy = e.target.value as PolicyConfig['engagement']['strategy']))}
            >
              {ENGAGEMENT.map((v) => (
                <option key={v} value={v}>{v.replace(/_/g, ' ').toLowerCase()}</option>
              ))}
            </select>
          </Field>
          <Field label="Replies to one person per hour" hint="Answering the same account repeatedly reads as a bot.">
            <input type="number" className="field" value={draft.engagement.maxRepliesPerPersonPerHour} onChange={(e) => patch((n) => void (n.engagement.maxRepliesPerPersonPerHour = Number(e.target.value) || 0))} />
          </Field>
          <Toggle checked={draft.engagement.ignoreMassTags} onChange={(v) => patch((n) => void (n.engagement.ignoreMassTags = v))} label="Ignore mass tags" description="A post tagging a dozen accounts is rarely addressed to any of them." />
          <Toggle checked={draft.engagement.allowThreadFollowUps} onChange={(v) => patch((n) => void (n.engagement.allowThreadFollowUps = v))} label="Follow up in threads" description="Answer replies to its own replies, not only the first mention." />
          <Toggle checked={draft.content.requireVerifiedAuthor} onChange={(v) => patch((n) => void (n.content.requireVerifiedAuthor = v))} label="Verified accounts only" description="Everyone else is read and never answered." />
          <Field label="Never reply to" hint="Comma separated handles.">
            <input className="field" value={draft.content.blockedRemoteHandles.join(', ')} onChange={(e) => patch((n) => void (n.content.blockedRemoteHandles = list(e.target.value)))} />
          </Field>
          <Field label="Only reply to" hint="Comma separated. Leave empty to answer anyone not blocked.">
            <input className="field" value={draft.content.allowedRemoteHandles.join(', ')} onChange={(e) => patch((n) => void (n.content.allowedRemoteHandles = list(e.target.value)))} />
          </Field>
          <Field label="Topics it will not discuss" hint="Comma separated. A message about one is left alone.">
            <input className="field" value={draft.content.blockedTopics.join(', ')} onChange={(e) => patch((n) => void (n.content.blockedTopics = list(e.target.value)))} />
          </Field>
          <Field label="Own handles" hint="Comma separated. The agent never acts on its own posts.">
            <input className="field" value={draft.content.selfHandles.join(', ')} onChange={(e) => patch((n) => void (n.content.selfHandles = list(e.target.value)))} />
          </Field>
        </Group>

        <Group title="What it reads" blurb="Most questions worth answering are about a picture. Each of these costs a model call.">
          <Toggle checked={draft.media.analyzeImages} onChange={(v) => patch((n) => void (n.media.analyzeImages = v))} label="Read images" description="Without this it tells the person it cannot see them, which is honest and a bad answer." />
          <Toggle checked={draft.media.analyzeGifs} onChange={(v) => patch((n) => void (n.media.analyzeGifs = v))} label="Read GIFs" />
          <Toggle checked={draft.media.analyzeVideo} onChange={(v) => patch((n) => void (n.media.analyzeVideo = v))} label="Read video" description="Not implemented yet; the setting is here so it is not a surprise when it is." />
          <Toggle checked={draft.media.resolveQuotedPosts} onChange={(v) => patch((n) => void (n.media.resolveQuotedPosts = v))} label="Read quoted posts" description="The picture being asked about is usually on the post above." />
          <Field label="When it cannot read an image" hint="An unread image is always stated as a gap; this is what it does next.">
            <select
              className="field capitalize"
              value={draft.media.onVisionFailure}
              onChange={(e) => patch((n) => void (n.media.onVisionFailure = e.target.value as PolicyConfig['media']['onVisionFailure']))}
            >
              {VISION_FAILURE.map((v) => (
                <option key={v} value={v}>{v.replace(/_/g, ' ').toLowerCase()}</option>
              ))}
            </select>
          </Field>
          <Field label="Links" hint="How far it goes to find out what a link says.">
            <select
              className="field capitalize"
              value={draft.media.linkPolicy}
              onChange={(e) => patch((n) => void (n.media.linkPolicy = e.target.value as PolicyConfig['media']['linkPolicy']))}
            >
              {LINK_POLICY.map((v) => (
                <option key={v} value={v}>{v.replace(/_/g, ' ').toLowerCase()}</option>
              ))}
            </select>
          </Field>
          <Field label="Domains it may open" hint="Comma separated. Only used by the always-resolve policy.">
            <input className="field" value={draft.media.allowedLinkDomains.join(', ')} onChange={(e) => patch((n) => void (n.media.allowedLinkDomains = list(e.target.value)))} />
          </Field>
        </Group>

        <Group title="Positions it holds" blurb="An agent that cannot remember what it said reads as a different agent every time.">
          <Toggle checked={draft.stance.learnFromOwnPosts} onChange={(v) => patch((n) => void (n.stance.learnFromOwnPosts = v))} label="Learn from what it published" description="Never from drafts or dry runs: a dry run is not a public position." />
          <Toggle checked={draft.stance.trackCommitments} onChange={(v) => patch((n) => void (n.stance.trackCommitments = v))} label="Track things it promised" />
          <Toggle checked={draft.stance.trackPredictions} onChange={(v) => patch((n) => void (n.stance.trackPredictions = v))} label="Track predictions it made" />
          <Field label="When a draft contradicts a position" hint="Only a straight reversal counts; moving from certain to hedged is allowed.">
            <select
              className="field capitalize"
              value={draft.stance.onConflict}
              onChange={(e) => patch((n) => void (n.stance.onConflict = e.target.value as PolicyConfig['stance']['onConflict']))}
            >
              {STANCE_CONFLICT.map((v) => (
                <option key={v} value={v}>{v.replace(/_/g, ' ').toLowerCase()}</option>
              ))}
            </select>
          </Field>
        </Group>

        <Group title="Voice" blurb="Applied to the finished draft, so it sounds like this agent whichever model wrote it.">
          <Toggle checked={draft.voice.allowModelRewrite} onChange={(v) => patch((n) => void (n.voice.allowModelRewrite = v))} label="Let a model rewrite for voice" description="A rewrite that scores worse is discarded, and a failed rewrite never fails the job." />
          <Field label="Phrases that are its own" hint="Comma separated. Rested between uses so they do not become a tic.">
            <input className="field" value={draft.voice.signaturePhrases.join(', ')} onChange={(e) => patch((n) => void (n.voice.signaturePhrases = list(e.target.value)))} />
          </Field>
          <Field label="Phrases to avoid" hint="Comma separated.">
            <input className="field" value={draft.voice.avoidPhrases.join(', ')} onChange={(e) => patch((n) => void (n.voice.avoidPhrases = list(e.target.value)))} />
          </Field>
        </Group>

        <Group title="Tools and addresses" blurb="What it may reach, and what it may state as fact.">
          <Field label="Tools allowed" hint="Comma separated tool keys, for example time.now, memory.search.">
            <input className="field" value={draft.tools.allowed.join(', ')} onChange={(e) => patch((n) => void (n.tools.allowed = list(e.target.value)))} />
          </Field>
          {/*
            Off by default on purpose. Low-risk reads are already permitted for
            every agent, so switching this on by default would change how every
            existing agent answers -- and the point of the loop is that an owner
            decides what their agent reaches for.
          */}
          <Toggle
            label="Let it look things up while answering"
            description="The model may ask for one of its capabilities mid-answer, up to four times, instead of answering from what it already has. Costs an extra model call each time."
            checked={draft.tools.capabilityLoop}
            onChange={(v) => patch((n) => void (n.tools.capabilityLoop = v))}
          />
          {/*
            The validator rejects any address the agent was not given, and until
            this field existed the only way to give it one was to write it into
            the persona.
          */}
          <Field
            label="Addresses it may state"
            hint="Comma separated, exact. Anything else it writes is refused, including a near miss."
          >
            <input
              className="field"
              placeholder="0x..."
              value={draft.output.verifiedAddresses.join(', ')}
              onChange={(e) => patch((n) => void (n.output.verifiedAddresses = list(e.target.value)))}
            />
          </Field>
        </Group>
      </div>

      {/*
        What it costs to run, in one place.

        The per-message limit is the one that always applies; the rest are
        optional ceilings. Each says how close it is rather than only what it is
        set to, because a limit nobody can see themselves approaching is one
        they only find out about when a job stops.
      */}
      <div className="mt-6 border-t border-ink-line pt-8">
        <p className="eyebrow">Spending</p>
        <h4 className="mt-2 text-base font-light text-bone">What it may spend</h4>
        <p className="mt-2 max-w-2xl text-[13px] leading-relaxed text-bone-faint">
          A model call is one request to a provider. Retries, fallbacks and the small classifier that decides whether to
          look something up all count. Leave a ceiling blank for no limit.
        </p>

        {spending?.warnings.map((warning) => (
          <p key={warning} className="mt-4 max-w-2xl break-words rounded-lg border border-signal-warn/40 bg-signal-warn/5 p-3 text-[13px] leading-relaxed text-signal-warn">
            {warning}
          </p>
        ))}

        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          <Field label="Model calls per message" hint={spending?.callsPerJob.says}>
            <input
              type="number"
              className="field"
              value={draft.budget.maxModelCallsPerJob}
              onChange={(e) => patch((n) => void (n.budget.maxModelCallsPerJob = Math.max(1, Number(e.target.value) || 1)))}
            />
          </Field>
          <Field label="Lookups per message" hint={spending?.researchPerEvent.says}>
            <input
              type="number"
              className="field"
              value={draft.budget.maxResearchCallsPerEvent}
              onChange={(e) => patch((n) => void (n.budget.maxResearchCallsPerEvent = Math.max(0, Number(e.target.value) || 0)))}
            />
          </Field>
          <Field label="Model calls a day" hint={spending?.callsPerDay.says ?? 'Blank for no limit.'}>
            <input
              type="number"
              className="field"
              placeholder="No limit"
              value={draft.budget.maxModelCallsPerDay ?? ''}
              onChange={(e) => patch((n) => void (n.budget.maxModelCallsPerDay = e.target.value.trim() ? Number(e.target.value) : null))}
            />
          </Field>
          <Field label="Model calls a month" hint={spending?.callsPerMonth.says ?? 'Blank for no limit.'}>
            <input
              type="number"
              className="field"
              placeholder="No limit"
              value={draft.budget.maxModelCallsPerMonth ?? ''}
              onChange={(e) => patch((n) => void (n.budget.maxModelCallsPerMonth = e.target.value.trim() ? Number(e.target.value) : null))}
            />
          </Field>
          <Field
            label="Spending a day, in USD"
            hint={spending?.costPerDay.says ?? 'Only enforceable once the models it uses have prices set.'}
          >
            <input
              type="number"
              className="field"
              placeholder="No limit"
              value={draft.budget.maxCostUsdPerDay ?? ''}
              onChange={(e) => patch((n) => void (n.budget.maxCostUsdPerDay = e.target.value.trim() ? Number(e.target.value) : null))}
            />
          </Field>
        </div>
      </div>

      {/*
        Helping people with the software this agent runs on. Off by default and
        it stays that way: everybody's agent becoming a support bot for AI17Z is
        a persona leak, not a feature.
      */}
      <div className="mt-6 border-t border-ink-line pt-8">
        <p className="eyebrow">Support</p>
        <h4 className="mt-2 text-base font-light text-bone">Helping people with the software it runs on</h4>
        <p className="mt-2 max-w-2xl text-[13px] leading-relaxed text-bone-faint">
          Most agents should leave this off. It is for the official agent of a project: it lets this one answer
          questions about the software using the documentation you have attached, say which version it is running, and
          optionally describe what its own runtime is doing, so it can say &ldquo;your notifications monitor has been
          failing for eleven minutes&rdquo; instead of &ldquo;have you checked your configuration&rdquo;.
        </p>

        <div className="mt-6 grid gap-5 lg:grid-cols-2">
          <div className="space-y-4">
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
            <div className="space-y-4">
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
      <div className="mt-6 border-t border-ink-line pt-8">
        <p className="eyebrow">Approaching people</p>
        <h4 className="mt-2 text-base font-light text-bone">Speaking first, under a post nobody sent it</h4>
        <p className="mt-2 max-w-2xl text-[13px] leading-relaxed text-bone-faint">
          Watched accounts and watched topics are set up on the account itself. This decides whether anything is ever
          said under what they find. Answering somebody badly is awkward; approaching a stranger badly is what people
          mean when they call an account a bot, so it is held to a higher bar than a reply and shown to you first
          unless you say otherwise.
        </p>

        <div className="mt-6 grid gap-5 lg:grid-cols-2">
          <div className="space-y-4">
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
            <div className="space-y-4">
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

      <div className="mt-5 flex flex-wrap items-center gap-4 border-t border-ink-line pt-6">
        <button type="button" className="btn-primary" onClick={() => void save()} disabled={busy}>
          {busy && <Spinner />}
          Save
        </button>
        <SavedTick visible={saved} />
        {/*
          The version is what the save produces, not what the button does.
          Every other section says "Save" and shows where it is beside it; this
          one put the number in the verb and read as a different action.
        */}
        <span className="ml-auto font-mono text-[10px] uppercase tracking-[0.16em] text-bone-faint">
          v{version} — saving makes v{version + 1}
        </span>
        {error && <p className="w-full text-sm text-signal-fail">{error}</p>}
      </div>
    </Section>
  );
}
