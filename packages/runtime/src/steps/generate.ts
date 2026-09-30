
import { positionsConflict, RESPONSE_SPEED_PROFILES } from '@xbam/shared/contracts';
import type {
  QualityReport,
  RelationshipContext,
  ResolvedContext,
  StanceContext,
} from '@xbam/shared/contracts';
import {
  PipelineError,
  describeVersion,
} from '@xbam/shared';
import {
  content as contentRepo,
  jobs as jobsRepo,
  memories as memoriesRepo,
  observability,
  ops,
  prompts as promptsRepo,
  voice as voiceRepo,
} from '@xbam/database';

import { assemblePrompt } from '@xbam/prompts';
import { habitualPhrases, lengthCeiling } from '@xbam/persona';
import { runCapabilityLoop } from '../capabilityLoop';
import { variantForPost } from '../experimentRuns';
import { capabilitySettings } from '../capabilityPermissions';
import { pauseState } from '../killSwitch';
import { generate } from '@xbam/models';
import { getChannelAdapter } from '@xbam/channels';
import {
  collectDiagnostics,
  suppliedFacts,
  summariseDiagnostics,
} from '@xbam/tools';

import { readPosition } from '../stance';
import {
  audienceOf,
  chooseIntent,
  readTemperature,
} from '../engagement';
import { readPromo } from '../promo';
import { compileForJob, fingerprintFor } from '../voice';
import { activePreferences, variantFor } from '../learning';

/** The length each learned option aims for, in characters. */
const LENGTH_TARGETS = { SHORT: 45, MEDIUM: 100, LONG: 170 } as const;
import { asksAboutTheAgent, questionsIn } from '../research';
import { removeEmDashes } from '../punctuation';
import { judgePost } from '../postQuality';
import { publicSelfFacts } from '../publicSelf';

import { classifyEvidence } from '../evidenceClass';

import type { JobBundle } from '../loadJob';
import { ensureMediaResolved } from './context';
import { validateOutput } from '../validator';
import {
  checkAudience,
  checkBudget,
} from '../policyGate';

/**
 * Producing the text, and everything done to it before anybody sees it.
 *
 * Choosing what kind of reply this is, asking the model, checking it against
 * the policy, pulling it back towards the agent's own voice, and scoring what
 * came out. A draft leaves here either fit to send or held for a person.
 */

/**
 * Whether this reply joins a conversation nobody invited the agent into.
 *
 * Only when nobody addressed it and it has not already spoken in the thread:
 * a reply in a conversation it is part of is a conversation, whatever the
 * event that started it.
 */
function approachOf(
  bundle: JobBundle,
  context: ResolvedContext,
): 'STRANGER' | 'TARGET' | 'COMMUNITY' | 'CIRCLE' | null {
  const type = bundle.event.type;
  if (type !== 'KEYWORD_MATCH' && type !== 'TARGET_ACCOUNT_ACTIVITY') return null;
  const selves = [bundle.account?.handle, ...bundle.policy.content.selfHandles]
    .filter((h): h is string => Boolean(h))
    .map((h) => h.replace(/^@+/, '').toLowerCase());
  const text = (context.incomingText ?? '').toLowerCase();
  if (selves.some((self) => text.includes(`@${self}`))) return null;
  if ((context.thread ?? []).some((m) => m.role === 'OUTBOUND')) return null;
  if (type === 'TARGET_ACCOUNT_ACTIVITY') return 'TARGET';
  // Somebody in the conversation of an account it follows, found by a
  // people-focused session: see peopleCandidates.
  const community = audienceOf(bundle.event.payload).community;
  if (community) return community.kind === 'REPLY' ? 'COMMUNITY' : 'CIRCLE';
  return 'STRANGER';
}

/** The account the agent follows, for the COMMUNITY and CIRCLE framing. */
function communityOf(bundle: JobBundle): string | null {
  return audienceOf(bundle.event.payload).community?.watched ?? null;
}

export async function stepGenerate(bundle: JobBundle): Promise<void> {
  await ensureMediaResolved(bundle);
  const context = bundle.job.resolvedContext;
  if (!context) throw PipelineError.retryable('context_missing', 'Generation ran before context was resolved.');

  // Every gate that knows how long it will be blocked says so, and every throw
  // carries that through: a limit is waited out rather than retried, and a wait
  // does not spend an attempt. A daily budget cap answered with an exponential
  // backoff burns all five attempts in under a minute of a twenty-four hour
  // wait, which is how a job dies of a ceiling that would have cleared.
  const audience = checkAudience(bundle.policy, context);
  if (!audience.allow) {
    throw audience.kind === 'PERMANENT'
      ? PipelineError.permanent(audience.reason, audience.message)
      : PipelineError.retryable(audience.reason, audience.message, { retryAfterMs: audience.retryAfterMs });
  }

  const budget = await checkBudget(bundle.agent.id, bundle.policy);
  if (!budget.allow) {
    throw PipelineError.retryable(budget.reason, budget.message, { retryAfterMs: budget.retryAfterMs });
  }

  const template = bundle.job.promptTemplateVersionId
    ? await promptsRepo.getTemplateVersion(bundle.job.promptTemplateVersionId)
    : await promptsRepo.getActiveTemplate('reply.default');
  if (!template) throw PipelineError.permanent('template_missing', 'The prompt template for this job is missing.');

  const memories = await memoriesRepo.listRetrievals(bundle.job.id);
  const enabledTools = await ops.listAgentTools(bundle.agent.id);

  // What this answer will actually rest on, worked out before anything is
  // written. Derived from what was gathered rather than asked of the model:
  // a model asked how well-founded its own answer is gives the answer it would
  // like to be true.
  const research = (context?.meta as { research?: { findings?: { kind: string }[]; failed?: unknown[] } } | undefined)
    ?.research;
  const findings = research?.findings ?? [];
  const evidence = classifyEvidence({
    hasConversationContext: Boolean(context?.parentText?.trim()) || (context?.thread.length ?? 0) > 0,
    projectPassages: memories.filter((m) => m.scope === 'KNOWLEDGE').length,
    webFindings: findings.filter((f) => f.kind !== 'token').length,
    marketFindings: findings.filter((f) => f.kind === 'token').length,
    memories: memories.filter((m) => m.scope !== 'KNOWLEDGE').length,
    failedLookups: research?.failed?.length ?? 0,
    // The loop runs after this prompt is assembled, so a failed web lookup is
    // not the end of the search when the model is about to be offered a menu.
    mayStillLookUp: bundle.policy.tools.capabilityLoop,
  });

  await observability.emitTrace({
    jobId: bundle.job.id,
    agentId: bundle.agent.id,
    type: 'PROMPT_ASSEMBLED',
    // The category, never the reasoning that produced the answer.
    message: `Evidence: ${evidence.evidence.toLowerCase().replace(/_/g, ' ')}. ${evidence.reason}`,
    data: { evidence: evidence.evidence, shouldAdmitUncertainty: evidence.shouldAdmitUncertainty },
  });
  const toolKeys = enabledTools
    .filter((t) => t.enabled && bundle.policy.tools.allowed.includes(t.key))
    .map((t) => t.key);

  // What those tools actually contribute, as facts rather than as an offer.
  //
  // This block used to be headed TOOLS AVAILABLE and list every enabled tool,
  // and nothing in AI17Z could call one: there is no tool-call loop. A model
  // told it can check something writes as though it checked. See
  // `packages/tools/src/supply.ts`.
  const toolFacts = suppliedFacts({
    keys: toolKeys,
    timezone: bundle.policy.rate.workingHours.timezone,
  });

  // Only for an agent whose owner turned this on. Collecting diagnostics costs
  // a handful of queries, and doing it for every reply everybody's agent writes
  // would be paying for a feature almost nobody has enabled.
  const support = bundle.policy.support.enabled
    ? {
        subject: bundle.policy.support.subject,
        version: describeVersion(),
        runtime: bundle.policy.support.describeOwnRuntime
          ? summariseDiagnostics(await collectDiagnostics(bundle.agent.id))
          : null,
      }
    : undefined;

  /**
   * Which arm of a running experiment this post is being written for.
   *
   * Posts only. An experiment about how the agent writes belongs to the things
   * it chooses to say; quietly varying the way it answers somebody is an
   * experiment run on a person who did not agree to be in one.
   *
   * Never fails the job. An assignment that could not be written means the post
   * goes out unvaried and uncounted, which is a missing data point rather than
   * a missing post.
   */
  const variant =
    bundle.job.actionType === 'POST'
      ? await variantForPost({
          agentId: bundle.agent.id,
          jobId: bundle.job.id,
          jobIdempotencyKey: bundle.job.idempotencyKey,
        })
      : null;
  if (variant) {
    await observability.emitTrace({
      jobId: bundle.job.id,
      agentId: bundle.agent.id,
      type: 'PROMPT_ASSEMBLED',
      message: `Experiment arm: ${variant.label}`,
      data: { experimentId: variant.experimentId, variant: variant.key },
    });
  }

  /*
    What this agent keeps saying, named before it says it again. Cheaper than
    catching it afterwards, which costs a rewrite call: measured on a live
    agent, the same runs of words recurred in five and six published replies
    and nothing had flagged them. The rewrite check in the voice step remains
    the backstop.
  */
  const habits = habitualPhrases(
    (await voiceRepo.recentOutput(bundle.agent.id, 40, 21).catch(() => [])).map((row) => row.text),
  ).map((habit) => habit.phrase);

  const fingerprint = await fingerprintFor(bundle.agent.id).catch(() => null);
  let usualLength =
    fingerprint && fingerprint.sampleCount > 0
      ? { median: fingerprint.medianChars, ceiling: lengthCeiling(fingerprint) }
      : null;

  /*
    What this agent has learned about how long to write and whether to ask,
    applied with the old behaviour running as the control. The choice is keyed
    on the job, so a job resumed after a restart makes the same one, and it is
    written onto the job so the outcome is credited to the side that produced
    it. See learning.ts.
  */
  let leaning: string | null = null;
  const variants: Record<string, 'learned' | 'control'> = {};
  if (bundle.policy.learning.enabled && bundle.job.actionType !== 'POST') {
    const learned = await activePreferences(bundle.agent.id);
    if (learned.length) {
      variants.length = variantFor(`${bundle.job.id}:length`, learned.length.status);
      if (variants.length === 'learned') {
        const target = LENGTH_TARGETS[learned.length.arm as keyof typeof LENGTH_TARGETS];
        if (target) {
          // Never past what the policy allows, and never a ceiling the voice
          // check would hold the draft to review for.
          const limit = bundle.policy.output.maxCharacters;
          usualLength = { median: Math.min(target, limit), ceiling: Math.min(Math.max(usualLength?.ceiling ?? 0, target + 40), limit) };
        }
      }
    }
    if (learned.question) {
      variants.question = variantFor(`${bundle.job.id}:question`, learned.question.status);
      if (variants.question === 'learned') {
        leaning =
          learned.question.arm === 'ASKS'
            ? 'Replies that ask one real question have done well for you here; end with one if it fits.'
            : 'Replies that say something have done better for you than ones that ask; do not end on a question.';
      }
    }
    if (Object.keys(variants).length > 0 && context) {
      const learnedMeta = { ...(context.meta ?? {}), learning: { variants } };
      await jobsRepo.updateJob(bundle.job.id, { resolvedContext: { ...context, meta: learnedMeta } });
      // The steps after this one write back from the bundle, so it has to
      // carry the labels too or the voice step would drop them.
      bundle.job.resolvedContext = { ...context, meta: learnedMeta };
    }
  }

  const aboutSelf = questionsIn(context.incomingText ?? '').some((question) => asksAboutTheAgent(question));
  const prompt = assemblePrompt({
    layers: template.layers,
    templateKey: template.templateKey,
    templateVersion: template.version,
    persona: bundle.persona,
    policy: bundle.policy,
    context,
    memories,
    channelName: getChannelAdapter(bundle.job.channel).displayName,
    toolDescriptions: toolFacts,
    memoryCharBudget: bundle.policy.memory.retrieval.totalCharBudget,
    actionType: bundle.job.actionType,
    approach: approachOf(bundle, context),
    watched: communityOf(bundle),
    promotional: readPromo(context.incomingText ?? '').level !== 'none',
    habits,
    usualLength,
    ...(leaning ? { leaning } : {}),
    aboutSelf,
    ...(aboutSelf ? { selfFacts: await publicSelfFacts(bundle.agent.id).catch(() => []) } : {}),
    evidence,
    support,
    ...(variant ? { experiment: { label: variant.label, instruction: variant.instruction } } : {}),
  });

  await observability.emitTrace({
    jobId: bundle.job.id,
    agentId: bundle.agent.id,
    type: 'PROMPT_ASSEMBLED',
    message: `${prompt.layers.length} layers, ${prompt.promptText.length} characters`,
    data: {
      template: `${template.templateKey} v${template.version}`,
      personaVersion: bundle.persona.version,
      layers: prompt.layers.map((l) => ({ key: l.key, source: l.source, chars: l.content.length })),
    },
  });

  const callModel = async (messages: typeof prompt.messages) =>
    (
      await generate({
        agentId: bundle.agent.id,
        jobId: bundle.job.id,
        purpose: 'GENERATE',
        messages,
        promptLayers: prompt.layers,
        promptText: prompt.promptText,
        maxCalls: bundle.policy.budget.maxModelCallsPerJob,
      })
    ).text;

  /**
   * Answering, with the option of asking for one thing first.
   *
   * Off unless the owner turned it on. The runtime has already resolved
   * context, retrieved memory and done its research by this point, so the
   * ordinary answer needs nothing more -- this is for the case where the model
   * is part-way through and needs one specific fact it does not have.
   *
   * The loop is given a closure over the same gateway call, so it never picks a
   * model, never sees a credential, and cannot spend more than
   * `budget.maxModelCallsPerJob` allows -- the cap is inside `generate`, and
   * every step of the loop goes through it.
   */
  let text: string;
  if (bundle.policy.tools.capabilityLoop) {
    // Both halves of the owner's setup, in one read. Passing the permissions
    // and not the configs is what made `CapabilityContext.config` a field that
    // was always empty however it was filled in.
    const settings = await capabilitySettings(bundle.agent.id);
    const loop = await runCapabilityLoop({
      agentId: bundle.agent.id,
      jobId: bundle.job.id,
      accountId: bundle.job.accountId,
      messages: prompt.messages,
      generate: callModel,
      /*
        What was asked, for choosing the menu, and only what was asked.

        `prompt.messages` is the assembled prompt: its last user message carries
        memory, evidence, the sender, the task framing and the output rules
        around one line of incoming text. Judging relevance against that block
        offers reads for the words in the framing rather than for the question,
        which is how an agent asked the time on a live installation was offered
        eight X reads and answered that it could not check.
      */
      task: bundle.job.resolvedContext?.incomingText || bundle.event.text || '',
      permissions: settings.permissions,
      configs: settings.configs,
      // One stop rather than four on FAST. Every step is a whole extra model
      // call, so this is the lever that costs the most when it is used and
      // nothing at all when the model answers without asking for anything.
      maxSteps: RESPONSE_SPEED_PROFILES[bundle.policy.responseSpeed].capabilitySteps,
      paused: (await pauseState().catch(() => ({ paused: false }))).paused,
    });
    text = loop.answer;
    /*
      What it was shown, not only what it used.

      "The agent did not look it up" has two completely different causes with
      the same symptom: the capability was never offered, or it was offered and
      the model did not take it. The first is a shortlisting problem and the
      second is a prompt problem, and without this row an owner cannot tell
      them apart. Ids and counts only, which is what the shortlist decided
      rather than any reasoning about it.
    */
    await observability.emitTrace({
      jobId: bundle.job.id,
      agentId: bundle.agent.id,
      type: 'CAPABILITY_OFFERED',
      level: 'debug',
      message:
        loop.shortlist.offered.length === 0
          ? `Nothing on the menu bore on this, out of ${loop.shortlist.considered} available.`
          : `Offered ${loop.shortlist.offered.length} of ${loop.shortlist.considered}: ${loop.shortlist.offered
              .map((capability) => capability.id)
              .join(', ')}`,
      data: {
        considered: loop.shortlist.considered,
        offered: loop.shortlist.offered.map((capability) => capability.id),
        families: loop.shortlist.families,
        used: loop.steps.map((step) => step.capabilityId),
      },
    });
    for (const step of loop.steps) {
      await observability.emitTrace({
        jobId: bundle.job.id,
        agentId: bundle.agent.id,
        type: 'CAPABILITY_USED',
        level: step.outcome === 'SUCCEEDED' ? 'info' : 'warn',
        message: `${step.capabilityId}: ${step.detail}`,
        data: { capabilityId: step.capabilityId, outcome: step.outcome, durationMs: step.durationMs },
      });
    }
  } else {
    text = await callModel(prompt.messages);
  }

  await jobsRepo.updateJob(bundle.job.id, {
    status: 'GENERATED',
    generatedOutput: text,
    touch: ['generatedAt'],
  });
}
export async function stepValidate(bundle: JobBundle): Promise<void> {
  const raw = bundle.job.generatedOutput;
  if (raw === null) throw PipelineError.retryable('output_missing', 'Validation ran before anything was generated.');

  const result = validateOutput(
    raw,
    bundle.policy,
    bundle.job.resolvedContext?.targetAuthorHandle ?? bundle.event.remoteAuthorHandle,
    // What the operator wrote for this agent. An address they put in the
    // biography or the standing instructions is one they gave it deliberately,
    // and is the normal place for a project's own contract address to live.
    [bundle.persona.biography, bundle.persona.customInstructions].filter(Boolean).join('\n'),
  );
  const blocking = result.violations.filter((v) => v.severity !== 'REPAIRED');

  if (!result.ok) {
    const summary = blocking.map((v) => v.message).join(' ');
    await observability.emitTrace({
      jobId: bundle.job.id,
      agentId: bundle.agent.id,
      type: 'VALIDATION_FAILED',
      level: 'warn',
      message: summary,
      data: { violations: result.violations },
    });
    const rejected = blocking.some((v) => v.severity === 'REJECT');
    // A rejected output is a content problem, not a transient one. Retrying the
    // same prompt would produce the same class of answer, so a human decides.
    if (rejected || bundle.policy.safety.reviewOnValidationFailure) {
      throw PipelineError.review('validation_failed', summary);
    }
    throw PipelineError.retryable('validation_failed', summary);
  }

  await jobsRepo.updateJob(bundle.job.id, {
    status: 'VALIDATED',
    validatedOutput: result.output,
    touch: ['validatedAt'],
  });
  await observability.emitTrace({
    jobId: bundle.job.id,
    agentId: bundle.agent.id,
    type: 'VALIDATION_PASSED',
    message: result.violations.length > 0 ? `Passed with ${result.violations.length} repair(s)` : 'Passed',
    data: { repairs: result.violations, chars: result.output.length },
  });
}

/** Records a browser/adapter failure with a screenshot when one is available. */
export async function stepIntent(bundle: JobBundle): Promise<void> {
  await ensureMediaResolved(bundle);
  const { job } = bundle;
  const context = job.resolvedContext;
  const text = context?.incomingText ?? bundle.event.text;
  const meta = (context?.meta ?? {}) as {
    relationship?: RelationshipContext;
    stance?: StanceContext;
  };

  const temperature = readTemperature(text);
  const contradicts = (meta.stance?.relevant ?? []).some((s) => {
    const read = readPosition(text);
    return positionsConflict(s.position, read.position);
  });

  const decision = chooseIntent({
    text,
    temperature,
    relationship: meta.relationship ?? null,
    contradictsStance: contradicts,
    hasCallback: Boolean(meta.relationship?.callback),
  });

  await observability.emitTrace({
    jobId: job.id,
    agentId: bundle.agent.id,
    type: 'INTENT_SELECTED',
    message: `${decision.intent}: ${decision.reason}`,
    data: { intent: decision.intent, temperature: decision.temperature, reason: decision.reason },
  });

  if (context) {
    await jobsRepo.updateJob(job.id, {
      resolvedContext: { ...context, meta: { ...context.meta, intent: decision } },
    });
  }
}

/**
 * Makes the draft sound like this agent, and judges whether it does.
 *
 * Runs after validation, so the text has already been through the output policy
 * and this is only changing how it reads. The result replaces the validated
 * output: what gets published is what came out of here.
 */
export async function stepVoice(bundle: JobBundle): Promise<void> {
  const { job, policy } = bundle;
  const draft = job.validatedOutput ?? job.generatedOutput;
  if (!policy.voice.enabled || !draft) return;

  const context = job.resolvedContext;
  const speed = RESPONSE_SPEED_PROFILES[policy.responseSpeed];
  const compiled = await compileForJob({
    agentId: bundle.agent.id,
    jobId: job.id,
    draft,
    policy,
    recipientHandle: context?.targetAuthorHandle ?? bundle.event.remoteAuthorHandle,
    // A post is the agent choosing its own subject, and repetition judges the
    // two differently. Taken from the action rather than the event, because
    // that is what decides where the text lands.
    isPost: job.actionType === 'POST',
    /*
      A dry run is for seeing what would be said, so it is worth showing the
      real thing; but a rewrite costs money and a dry run is not going out.

      And the rewrite is the single largest optional cost in a reply: 24.9
      seconds at the median against 10.2 for the answer itself. That is what
      FAST gives up, and it is the honest thing for it to give up, because the
      free deterministic pass still runs and still catches a helpdesk sign-off.
      What FAST loses is the rewrite of a correctly-sized reply that merely
      reads slightly unlike the agent.
    */
    allowModelCall: !job.dryRun && speed.voiceRewrite,
    maxCalls: policy.budget.maxModelCallsPerJob,
  });

  await observability.emitTrace({
    jobId: job.id,
    agentId: bundle.agent.id,
    type: 'VOICE_COMPILED',
    message:
      compiled.applied.length > 0
        ? `Voice ${compiled.report.voice.score}/100 after ${compiled.applied.join(', ')}.`
        : `Voice ${compiled.report.voice.score}/100, left as written.`,
    data: {
      applied: compiled.applied,
      voice: compiled.report.voice,
      modelCallUsed: compiled.modelCallUsed,
      before: draft === compiled.text ? null : draft,
    },
  });

  /*
    The last thing that writes text has to be the last thing that checks it.

    The pipeline runs validate, then voice, then quality. The validator strips
    rhetorical dashes and the voice rewrite is a model call that writes fresh
    prose afterwards, so the guarantee the validator makes was being undone one
    step later by design. Four of the sixty-eight replies ai17zos has published
    went out with an em dash in them, all after the rule existed, and the
    `validated_output` column holds the proof.

    Applied here rather than moved: the validator still repairs its own output,
    because a draft that never reaches the voice step must be clean too. This
    closes the window between them.
  */
  const spoken = removeEmDashes(compiled.text);
  if (spoken.replaced > 0) {
    await observability.emitTrace({
      jobId: job.id,
      agentId: bundle.agent.id,
      type: 'VOICE_COMPILED',
      level: 'warn',
      message: `The voice rewrite put ${spoken.replaced} dash${spoken.replaced === 1 ? '' : 'es'} back. ${spoken.reason ?? ''}`.trim(),
      data: { rewroteDashes: spoken.replaced },
    });
  }

  if (spoken.text !== draft) {
    await jobsRepo.updateJob(job.id, { validatedOutput: spoken.text });
  }

  await jobsRepo.updateJob(job.id, {
    resolvedContext: context
      ? { ...context, meta: { ...context.meta, quality: compiled.report } }
      : undefined,
  });
}

/**
 * The social quality gate.
 *
 * Everything it weighs has already been measured; this decides what to do about
 * it. Sending a borderline reply to a person is better than publishing it and
 * better than silently discarding it, so REVIEW is the default outcome for
 * anything that fails.
 */
export async function stepQualityGate(bundle: JobBundle): Promise<'next' | 'silent'> {
  const { job, policy } = bundle;
  /*
    An original post has to be worth interrupting everybody for, which is a
    different question from whether it sounds right. Asked first, and answered
    with silence rather than review: an owner asked to approve a post the
    agent had nothing to say in is being asked to do its job for it. A person
    who already approved it has made the judgement.
  */
  if (job.actionType === 'POST' && !job.approvedAt) {
    const draft = (job.validatedOutput ?? job.generatedOutput ?? '').trim();
    /*
      An idea the agent concluded, or one its owner gave it, is the point of
      the post, and stating it is not an echo. Echo is measured only against
      material that was never the agent's own view: a question somebody asked.
    */
    const payload = (bundle.event.payload ?? {}) as { ideaSource?: string; ideaSummary?: string };
    const echoSource = payload.ideaSource === 'conversation' ? (payload.ideaSummary ?? '') : '';
    const verdict = judgePost({
      draft,
      source: echoSource,
      recentPosts: await contentRepo.recentPosts(bundle.agent.id, 12).catch(() => []),
      selfNames: [bundle.persona.displayName, bundle.agent.name, bundle.account?.handle ?? '', 'AI17Z'].filter(Boolean),
    });
    await observability.emitTrace({
      jobId: job.id,
      agentId: bundle.agent.id,
      type: 'QUALITY_SCORED',
      level: verdict.post ? 'info' : 'warn',
      message: verdict.post ? 'Worth posting.' : `Not worth posting: ${verdict.reasons.join(' ')}`,
      data: { post: verdict.post, reasons: verdict.reasons, factors: verdict.factors },
    });
    if (!verdict.post) {
      await jobsRepo.updateJob(job.id, { lastError: `Not worth posting: ${verdict.reasons.join(' ')}` });
      return 'silent';
    }
  }
  if (!policy.voice.enabled) return 'next';

  const report = (job.resolvedContext?.meta as { quality?: QualityReport } | undefined)?.quality;
  if (!report) return 'next';

  await observability.emitTrace({
    jobId: job.id,
    agentId: bundle.agent.id,
    type: 'QUALITY_SCORED',
    level: report.outcome === 'accept' ? 'info' : 'warn',
    message: report.reason,
    data: {
      voice: report.voice.score,
      generic: report.generic.score,
      repetition: report.repetition.score,
      outcome: report.outcome,
      genericReasons: report.generic.reasons,
      repetitionMatched: report.repetition.matched,
    },
  });

  /*
    Anything that matched is written down, whether or not it crossed the line.

    It used to be recorded only above the rewrite threshold. The score and the
    matched text were in QUALITY_SCORED's data all along, but the event that
    names the problem never fired and the message beside it read as approval.

    Measured on ai17z-main: two original posts four days apart sharing a
    byte-identical opening and closing sentence. The score was 78 against a
    threshold of 80, so no REPETITION_DETECTED was emitted and the trace said
    "Sounds like this agent." An owner asking why it posted nearly the same
    thing twice had to know to open the data of a different event to find out.

    The level still separates them: above the threshold something was asked for
    and below it nothing was, which is a real difference and stays visible.
  */
  const crossed = report.repetition.score > policy.voice.repetitionRewriteAbove;
  if (report.repetition.reason) {
    await observability.emitTrace({
      jobId: job.id,
      agentId: bundle.agent.id,
      type: 'REPETITION_DETECTED',
      level: crossed ? 'warn' : 'info',
      message: crossed
        ? (report.repetition.reason ?? 'Too close to something already said.')
        : `${report.repetition.reason}. Under the rewrite threshold of ${policy.voice.repetitionRewriteAbove}, so nothing was asked for.`,
      data: {
        score: report.repetition.score,
        threshold: policy.voice.repetitionRewriteAbove,
        crossed,
        matched: report.repetition.matched,
        matchedAt: report.repetition.matchedAt,
      },
    });
  }

  if (report.outcome !== 'accept') {
    /*
      A person who has already approved this has made the judgement.

      Approving sets the job back to VALIDATED and requeues it, and the
      pipeline then resumes at the node after that -- which is this one. The
      quality report has not changed, so the same verdict fired again and the
      job went straight back to REVIEW_REQUIRED. From the owner's side that is
      indistinguishable from approval doing nothing at all.

      Measured on a live installation: three jobs approved at 19:19, 19:22 and
      19:23 were back in review one to four seconds later, two of them saying
      "does not sound like this agent". The owner reported it as "I approve
      things and nothing happens", and they were right.

      The rule this restores is already written down for the approval path:
      a person who edits and approves has made a judgement the platform should
      respect, short of letting through something the policy forbids outright.
      Hard policy is checked in `approveJob` by the validator and is unchanged;
      what stops here is a soft opinion about register overruling a person.

      Recorded rather than silently dropped, because "it went out despite
      scoring badly on voice" is a thing worth being able to find later.
    */
    if (job.approvedAt) {
      await observability.emitTrace({
        jobId: job.id,
        agentId: bundle.agent.id,
        type: 'QUALITY_SCORED',
        level: 'warn',
        message: `Sent anyway: you approved it. ${report.reason}`,
        data: { outcome: report.outcome, overriddenByOwner: true, approvedAt: job.approvedAt },
      });
      return 'next';
    }
    throw PipelineError.review('quality_gate', report.reason);
  }
  return 'next';
}

/**
 * Looks up anything the answer depends on that the model cannot know.
 *
 * "What is this about?" under a post from an hour ago is unanswerable from a
 * training set, and a model asked it anyway will invent something. Before this
 * step the only options were silence or a guess.
 *
 * Runs after context resolution, because what to look up is decided from the
 * conversation and not from the mention alone: the question is usually "what is
 * this", and "this" is the parent post.
 *
 * Nothing is looked up for an ordinary reply. Searching the web before every
 * message is slow, expensive, and no help at all in answering "nice one".
 */
