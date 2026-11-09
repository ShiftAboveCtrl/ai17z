import type { PolicyConfig, QualityReport, VoiceFingerprint } from '@xbam/shared/contracts';
import { emptyFingerprint } from '@xbam/shared/contracts';
import { createLogger, errorMessage } from '@xbam/shared';
import { agents as agentsRepo, voice as voiceRepo } from '@xbam/database';
import {
  compileVoice,
  deriveFingerprint,
  longerThanUsual,
  scoreGeneric,
  scoreRepetition,
  scoreVoice,
} from '@xbam/persona';
import { generate } from '@xbam/models';
import { NO_EM_DASHES } from './punctuation';
import {
  peerBriefSection,
  runPeerReview,
  settlePeerReview,
  type PeerCritique,
  type PeerReviewRecord,
} from './peerReview';
import { validateOutput } from './validator';

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
  /**
   * Whether this is the agent choosing its own subject rather than answering.
   *
   * Only repetition reads it, and only to decide whether an identical opening
   * is decisive on its own. See `RepetitionOptions.openerIsDecisive`.
   */
  isPost?: boolean;
  /**
   * Whether a peer may be asked for a second opinion on this draft.
   *
   * Separate from `allowModelCall` because the two answer different questions.
   * A dry run is not paid for by default, so it does not rewrite on its own; a
   * peer review is something the owner switched on and wants to watch in a
   * rehearsal, so it runs there. Both still need `policy.quality.peerReview`.
   */
  allowPeerReview?: boolean;
  /** The message being answered, for the peer to read. */
  incomingText?: string | null;
  /** The operator's own text, so a rewrite is held to the same address rule. */
  operatorText?: string | null;
}

export interface CompileForJobResult {
  text: string;
  report: QualityReport;
  /** Which stages actually ran, for the trace and for cost accounting. */
  applied: string[];
  modelCallUsed: boolean;
  /** What the peer review did, or null when it was off. */
  peerReview: PeerReviewRecord | null;
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
    {
      signaturePhrases: policy.signaturePhrases,
      signatureRestHours: policy.signatureRestHours,
      openerIsDecisive: input.isPost === true,
    },
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
  const ordinaryReason =
    policy.enabled &&
    policy.allowModelRewrite &&
    input.allowModelCall &&
    (compiled.applied === 'model_needed' ||
      generic.score > policy.genericRewriteAbove ||
      repetition.score > policy.repetitionRewriteAbove);

  /*
    A second opinion, asked for before the rewrite and folded into it.

    It rides the rewrite that already exists rather than adding one: the peer
    only supplies notes, the rewriter decides what to do with them, and the
    result is held to the output rules again below. A rewrite is also the only
    thing that can act on a critique, so with rewriting forbidden the peer is
    not asked at all; paying for notes nothing can apply would be the wrong
    trade.
  */
  let peerReview: PeerReviewRecord | null = null;
  let critique: PeerCritique | null = null;
  const peerMayRun =
    input.policy.quality.peerReview.enabled &&
    policy.enabled &&
    policy.allowModelRewrite &&
    input.allowPeerReview === true;
  if (peerMayRun) {
    const reviewed = await runPeerReview({
      agentId: input.agentId,
      jobId: input.jobId,
      config: input.policy.quality.peerReview,
      draft: text,
      incomingText: input.incomingText ?? null,
      maxCalls: input.maxCalls,
    });
    peerReview = reviewed?.record ?? null;
    critique = reviewed?.critique ?? null;
    if (peerReview?.peerName) applied.push(`peer review (${peerReview.peerName}): ${peerReview.outcome === 'unavailable' ? 'unavailable' : 'consulted'}`);
  } else if (input.policy.quality.peerReview.enabled) {
    peerReview = {
      ran: false,
      outcome: 'skipped',
      reason: !policy.enabled
        ? 'Peer review needs the voice step, which is off.'
        : !policy.allowModelRewrite
          ? 'Peer review needs a model rewrite to act on its notes, and this agent does not allow one.'
          : 'Peer review is not run at this response speed or for this kind of reply.',
      peerAgentId: input.policy.quality.peerReview.peerAgentId,
      peerName: null,
      summary: null,
      kept: [],
      undone: [],
    };
  }

  const needsModel = Boolean(ordinaryReason) || critique !== null;

  if (needsModel) {
    const brief = buildBrief(compiled.rewriteBrief, text, fingerprint, generic, repetition, critique);
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
      const returned = result.text.trim().replace(/^["']|["']$/g, '');
      /*
        The rewrite is a draft too.

        It comes from a model with a house style exactly like the one that
        wrote the first draft, so it arrives with the same tells, and until
        this line it went to X without the deterministic pass ever seeing it.
        A brief that says "no sign-offs" is a request; the cheap pass is the
        enforcement, and skipping it on the last text before publication was
        enforcing the rule everywhere except where it mattered most.

        Only the free pass runs here. Whether to pay for a second call was
        already decided above, and a rewrite of a rewrite is a loop.
      */
      const rewritten =
        returned.length > 0
          ? compileVoice({
              draft: returned,
              fingerprint,
              policy,
              maxCharacters: input.policy.output.maxCharacters,
            }).text
          : returned;
      /*
        A rewrite that carried a peer's notes is held to the output rules again.

        The notes are text from another model, written about a message from a
        stranger, and the rewriter acts on them. Whatever came out is therefore
        the last thing to write the reply and has to be the last thing to check
        it: dashes, emoji, banned phrases, addresses nobody gave the agent, a
        claim to be human, a disclosure of what runs it. A violation that cannot
        be repaired discards the rewrite and the reply stays as it was.
      */
      let candidate = rewritten;
      let refusedByRules: string | null = null;
      if (critique && candidate.length > 0) {
        const checked = validateOutput(candidate, input.policy, input.recipientHandle, input.operatorText);
        const blocking = checked.violations.find((v) => v.severity === 'REJECT' || v.severity === 'REVIEW');
        if (blocking) refusedByRules = blocking.message;
        else candidate = checked.output;
      }

      if (candidate.length > 0) {
        // Only keep the rewrite if it actually helped. A rewrite that scores
        // worse is a worse reply, whatever it cost.
        const after = scoreVoice(candidate, fingerprint);
        const before = scoreVoice(text, fingerprint);
        if (refusedByRules) {
          applied.push('model rewrite rejected: it broke an output rule');
          if (critique && peerReview) {
            peerReview = settlePeerReview(peerReview, critique, {
              adopted: false,
              reason: `The rewrite that used the peer notes broke an output rule, so it was dropped: ${refusedByRules}`,
            });
          }
        } else if (after.score >= before.score) {
          if (critique && peerReview) {
            peerReview = settlePeerReview(peerReview, critique, {
              adopted: candidate !== text,
              reason:
                candidate !== text
                  ? 'The rewrite took the peer notes into the reply.'
                  : 'The rewrite left the reply as it was, so none of the peer notes changed it.',
            });
          }
          text = candidate;
          applied.push(`model rewrite (${result.provider}/${result.model})`);
        } else {
          applied.push('model rewrite rejected: it scored worse');
          if (critique && peerReview) {
            peerReview = settlePeerReview(peerReview, critique, {
              adopted: false,
              reason: 'The rewrite that used the peer notes scored worse for this agent, so it was dropped.',
            });
          }
        }
        modelCallUsed = true;
      }
    } catch (error) {
      // A failed rewrite is not a failed reply. The deterministic pass already
      // produced something usable, and losing the job over a style pass would
      // be the wrong trade.
      log.warn('voice rewrite failed', { agentId: input.agentId, message: errorMessage(error) });
      applied.push('model rewrite unavailable');
      if (critique && peerReview) {
        peerReview = settlePeerReview(peerReview, critique, {
          adopted: false,
          reason: 'The rewrite that would have used the peer notes failed, so the reply went on without them.',
        });
      }
    }
  } else if (compiled.applied === 'model_needed') {
    applied.push('rewrite skipped: not permitted here');
  }

  const finalVoice = scoreVoice(text, fingerprint);
  const finalGeneric = scoreGeneric(text, { avoid: policy.avoid, avoidPhrases: policy.avoidPhrases });
  const finalRepetition = scoreRepetition(
    text,
    recent.map((row) => ({ text: row.text, at: row.postedAt })),
    {
      signaturePhrases: policy.signaturePhrases,
      signatureRestHours: policy.signatureRestHours,
      openerIsDecisive: input.isPost === true,
    },
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
    peerReview,
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
  peer: PeerCritique | null = null,
): string {
  /*
    Said to the rewriter as well as enforced after it.

    The rewrite is the last model call before anything is published, and it was
    the one call that had never been told the punctuation rule. So the
    validator would strip a dash and the rewrite, working from a brief that
    said nothing about it, would put one back in a new sentence of its own.
    Repairing that afterwards works, and a message written correctly the first
    time still reads better than a repaired one: the model chooses its clause
    structure around the punctuation it thinks it has.
  */
  const extra: string[] = ['', 'PUNCTUATION', NO_EM_DASHES];
  /*
    Length pressure goes to the rewriter, never to a slicer.

    The voice compiler used to enforce "the length this agent usually writes"
    by cutting the text, which on the live agent meant drafts of 196 to 230
    characters landing as replies of 170 to 175, chopped mid-sentence. A
    truncated thought is worse than a long one: long reads as verbose, and
    truncated reads as broken.
  */
  const tooLong = longerThanUsual(text, fingerprint);
  if (tooLong) extra.push('', 'LENGTH', tooLong);
  if (generic.reasons.length > 0) {
    extra.push('', 'AVOID', ...generic.reasons.map((reason) => `- It currently ${reason}.`));
  }
  if (repetition.score > 60 && repetition.matched) {
    extra.push(
      '',
      'DO NOT REPEAT',
      // A habit has no one post to quote; it is a phrase across many.
      repetition.matchedAt
        ? `The agent recently posted: "${repetition.matched}"`
        : `The agent keeps using the phrase "${repetition.matched}". Do not use it here.`,
      'Say this differently.',
    );
  }
  // After every rule, so the notes are read as advice inside them.
  if (peer) extra.push(...peerBriefSection(peer));
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
