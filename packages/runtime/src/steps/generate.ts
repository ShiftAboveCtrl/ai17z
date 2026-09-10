
import { positionsConflict } from '@xbam/shared/contracts';
import type {
  QualityReport,
  RelationshipContext,
  StanceContext,
} from '@xbam/shared/contracts';
import {
  PipelineError,
  describeVersion,
} from '@xbam/shared';
import {
  jobs as jobsRepo,
  memories as memoriesRepo,
  observability,
  ops,
  prompts as promptsRepo,
} from '@xbam/database';

import { assemblePrompt } from '@xbam/prompts';
import { runCapabilityLoop } from '../capabilityLoop';
import { variantForPost } from '../experimentRuns';
import { capabilityPermissions } from '../capabilityPermissions';
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
  chooseIntent,
  readTemperature,
} from '../engagement';
import { compileForJob } from '../voice';

import { classifyEvidence } from '../evidenceClass';

import type { JobBundle } from '../loadJob';
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

export async function stepGenerate(bundle: JobBundle): Promise<void> {
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
    const loop = await runCapabilityLoop({
      agentId: bundle.agent.id,
      jobId: bundle.job.id,
      accountId: bundle.job.accountId,
      messages: prompt.messages,
      generate: callModel,
      permissions: await capabilityPermissions(bundle.agent.id),
      paused: (await pauseState().catch(() => ({ paused: false }))).paused,
    });
    text = loop.answer;
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
  const compiled = await compileForJob({
    agentId: bundle.agent.id,
    jobId: job.id,
    draft,
    policy,
    recipientHandle: context?.targetAuthorHandle ?? bundle.event.remoteAuthorHandle,
    // A dry run is for seeing what would be said, so it is worth showing the
    // real thing; but a rewrite costs money and a dry run is not going out.
    allowModelCall: !job.dryRun,
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

  if (compiled.text !== draft) {
    await jobsRepo.updateJob(job.id, { validatedOutput: compiled.text });
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
export async function stepQualityGate(bundle: JobBundle): Promise<void> {
  const { job, policy } = bundle;
  if (!policy.voice.enabled) return;

  const report = (job.resolvedContext?.meta as { quality?: QualityReport } | undefined)?.quality;
  if (!report) return;

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

  if (report.repetition.score > policy.voice.repetitionRewriteAbove) {
    await observability.emitTrace({
      jobId: job.id,
      agentId: bundle.agent.id,
      type: 'REPETITION_DETECTED',
      level: 'warn',
      message: report.repetition.reason ?? 'Too close to something already said.',
      data: { matched: report.repetition.matched, matchedAt: report.repetition.matchedAt },
    });
  }

  if (report.outcome !== 'accept') {
    throw PipelineError.review('quality_gate', report.reason);
  }
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
