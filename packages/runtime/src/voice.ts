import type { PolicyConfig, QualityReport, VoiceFingerprint } from '@xbam/shared/contracts';
import { emptyFingerprint } from '@xbam/shared/contracts';
import { createLogger, errorMessage } from '@xbam/shared';
import { agents as agentsRepo, voice as voiceRepo } from '@xbam/database';
import { compileVoice, deriveFingerprint, scoreGeneric, scoreRepetition, scoreVoice } from '@xbam/persona';
import { generate } from '@xbam/models';

const log = createLogger('voice');

/**
 * Making the agent sound like itself, whatever wrote the draft.
 *
 * The model supplies meaning; this supplies the way it is said. Given the same
 * semantic draft from Claude, GPT, DeepSeek or a local model, the published
 * output should read as the same agent — which is the entire reason the two are
 * separated.
 */

/**
 * The fingerprint in force for an agent.
 *
 * Falls back to persona style examples when nothing has been derived yet, so a
 * brand-new agent still has a target rather than no opinion at all.
 */
export async function fingerprintFor(agentId: string): Promise<VoiceFingerprint> {
  const stored = await voiceRepo.getFingerprint(agentId);
  if (stored && stored.fingerprint.sampleCount > 0) return stored.fingerprint;

  const persona = await agentsRepo.getActivePersona(agentId);
  const examples = persona?.styleExamples ?? [];
  if (examples.length === 0) return emptyFingerprint();
  return deriveFingerprint(examples, ['persona style examples']);
}

/**
 * Re-derives the fingerprint from what the agent has actually published.
 *
 * Persona examples are what somebody wrote down; published replies are what the
 * agent really does. Both are used, with published output preferred once there
 * is enough of it to mean something.
 */
export async function refreshFingerprint(agentId: string, force = false): Promise<VoiceFingerprint> {
  const published = await voiceRepo.samplesForFingerprint(agentId, 400);
  const persona = await agentsRepo.getActivePersona(agentId);
  const examples = persona?.styleExamples ?? [];

  const sources: string[] = [];
  if (published.length > 0) sources.push(`${published.length} published replies`);
  if (examples.length > 0) sources.push(`${examples.length} persona examples`);

  // Below about twenty samples the rates are noise, so the written examples
  // still carry weight. Above it, what the agent does beats what it was told.
  const samples = published.length >= 20 ? published : [...published, ...examples];
  if (samples.length === 0) return emptyFingerprint();

  const fingerprint = deriveFingerprint(samples, sources);
  await voiceRepo.saveFingerprint({ agentId, fingerprint, sources, force });
  log.info('voice fingerprint derived', { agentId, samples: samples.length, median: fingerprint.medianChars });
  return fingerprint;
}

export interface CompileForJobInput {
  agentId: string;
  jobId: string | null;
  draft: string;
  policy: PolicyConfig;
  recipientHandle: string | null;
  /** Allows the expensive path. False during a dry run or a tight budget. */
  allowModelCall: boolean;
  maxCalls: number;
}

export interface CompileForJobResult {
  text: string;
  report: QualityReport;
  /** Which stages actually ran, for the trace and for cost accounting. */
  applied: string[];
  modelCallUsed: boolean;
}

/**
 * Runs a draft through voice, repetition and generic-prose checks.
 *
 * Ordered by cost. The statistical checks are free and run always; the model
 * rewrite runs only when the cheap paths could not get the draft close enough,
 * because paying for a second call on a reply that already sounds right is how a
 * per-reply cost turns into a bill.
 */
export async function compileForJob(input: CompileForJobInput): Promise<CompileForJobResult> {
  const policy = input.policy.voice;
  const fingerprint = await fingerprintFor(input.agentId);
  const applied: string[] = [];

  const recent = await voiceRepo.recentOutput(input.agentId, 40, 21);
  const repetition = scoreRepetition(
    input.draft,
    recent.map((row) => ({
      text: row.text,
      at: row.postedAt,
      sameRecipient:
        Boolean(input.recipientHandle) &&
        row.recipientHandle?.toLowerCase() === input.recipientHandle?.replace(/^@+/, '').toLowerCase(),
    })),
    { signaturePhrases: policy.signaturePhrases, signatureRestHours: policy.signatureRestHours },
  );

  const generic = scoreGeneric(input.draft, { avoid: policy.avoid, avoidPhrases: policy.avoidPhrases });

  const compiled = compileVoice({
    draft: input.draft,
    fingerprint,
    policy,
    maxCharacters: input.policy.output.maxCharacters,
  });
  if (compiled.applied !== 'none') applied.push(compiled.applied === 'light' ? 'light rewrite' : 'needs a rewrite');

  let text = compiled.text;
  let modelCallUsed = false;

  // A model rewrite is warranted when the draft is still far from the voice, or
  // when it reads as generic prose, or when it repeats the agent too closely.
  // The deterministic pass cannot fix the last two: they are about what the
  // draft says, not how it is punctuated.
  const needsModel =
    policy.enabled &&
    policy.allowModelRewrite &&
    input.allowModelCall &&
    (compiled.applied === 'model_needed' ||
      generic.score > policy.genericRewriteAbove ||
      repetition.score > policy.repetitionRewriteAbove);

  if (needsModel) {
    const brief = buildBrief(compiled.rewriteBrief, text, fingerprint, generic, repetition);
    try {
      const result = await generate({
        agentId: input.agentId,
        jobId: input.jobId,
        purpose: 'voice.rewrite',
        // A dedicated role, so the rewrite can run on something cheaper than
        // whatever produced the draft.
        role: 'voice_rewrite',
        maxCalls: input.maxCalls,
        messages: [{ role: 'user', content: brief }],
      });
      const rewritten = result.text.trim().replace(/^["']|["']$/g, '');
      if (rewritten.length > 0) {
        // Only keep the rewrite if it actually helped. A rewrite that scores
        // worse is a worse reply, whatever it cost.
        const after = scoreVoice(rewritten, fingerprint);
        const before = scoreVoice(text, fingerprint);
        if (after.score >= before.score) {
          text = rewritten;
          applied.push(`model rewrite (${result.provider}/${result.model})`);
        } else {
          applied.push('model rewrite rejected: it scored worse');
        }
        modelCallUsed = true;
      }
    } catch (error) {
      // A failed rewrite is not a failed reply. The deterministic pass already
      // produced something usable, and losing the job over a style pass would
      // be the wrong trade.
      log.warn('voice rewrite failed', { agentId: input.agentId, message: errorMessage(error) });
      applied.push('model rewrite unavailable');
    }
  } else if (compiled.applied === 'model_needed') {
    applied.push('rewrite skipped: not permitted here');
  }

  const finalVoice = scoreVoice(text, fingerprint);
  const finalGeneric = scoreGeneric(text, { avoid: policy.avoid, avoidPhrases: policy.avoidPhrases });
  const finalRepetition = scoreRepetition(
    text,
    recent.map((row) => ({ text: row.text, at: row.postedAt })),
    { signaturePhrases: policy.signaturePhrases, signatureRestHours: policy.signatureRestHours },
  );

  return {
    text,
    report: {
      voice: finalVoice,
      generic: finalGeneric,
      repetition: finalRepetition,
      outcome: decideOutcome(finalVoice.score, finalGeneric.score, finalRepetition.score, policy),
      reason: describeOutcome(finalVoice, finalGeneric, finalRepetition, policy),
    },
    applied,
    modelCallUsed,
  };
}

function decideOutcome(
  voice: number,
  generic: number,
  repetition: number,
  policy: PolicyConfig['voice'],
): string {
  if (repetition > policy.repetitionRewriteAbove) return 'review';
  if (generic > policy.genericRewriteAbove) return 'review';
  if (voice < policy.lightRewriteAt) return 'review';
  return 'accept';
}

function describeOutcome(
  voice: ReturnType<typeof scoreVoice>,
  generic: ReturnType<typeof scoreGeneric>,
  repetition: ReturnType<typeof scoreRepetition>,
  policy: PolicyConfig['voice'],
): string {
  if (repetition.score > policy.repetitionRewriteAbove) {
    return repetition.reason ?? 'Too close to something the agent recently said.';
  }
  if (generic.score > policy.genericRewriteAbove) {
    return `Reads as generic assistant prose: ${generic.reasons.slice(0, 2).join('; ')}.`;
  }
  if (voice.score < policy.lightRewriteAt) {
    const weakest = [...voice.dimensions].sort((a, b) => a.score - b.score)[0];
    return weakest ? `Does not sound like this agent — ${weakest.detail}.` : 'Does not sound like this agent.';
  }
  return voice.lowConfidence
    ? 'Sounds right, though there are too few samples for that to mean much yet.'
    : 'Sounds like this agent.';
}

/** Adds the repetition and generic notes to the fingerprint brief. */
function buildBrief(
  base: string | null,
  text: string,
  fingerprint: VoiceFingerprint,
  generic: ReturnType<typeof scoreGeneric>,
  repetition: ReturnType<typeof scoreRepetition>,
): string {
  const extra: string[] = [];
  if (generic.reasons.length > 0) {
    extra.push('', 'AVOID', ...generic.reasons.map((reason) => `- It currently ${reason}.`));
  }
  if (repetition.score > 60 && repetition.matched) {
    extra.push(
      '',
      'DO NOT REPEAT',
      `The agent recently posted: "${repetition.matched}"`,
      'Say this differently.',
    );
  }
  if (base) {
    // The draft is the last section of the base brief, so extras go before it.
    const marker = '\n\nDRAFT\n';
    const index = base.lastIndexOf(marker);
    if (index > 0 && extra.length > 0) {
      return `${base.slice(0, index)}\n${extra.join('\n')}${base.slice(index)}`;
    }
    return base;
  }

  return [
    'Rewrite the message below so it reads as this specific person wrote it.',
    'Keep the meaning exactly. Change only how it is said.',
    `Typical reply: about ${fingerprint.medianChars} characters.`,
    ...extra,
    '',
    'Return only the rewritten message.',
    '',
    'DRAFT',
    text,
  ].join('\n');
}
