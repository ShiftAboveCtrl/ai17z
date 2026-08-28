import type { VoiceFingerprint, VoicePolicy } from '@xbam/shared/contracts';
import { scoreVoice } from './voice';

/**
 * The Voice Compiler.
 *
 * The model supplies meaning. This supplies the way it is said. Given the same
 * semantic draft from Claude, GPT, DeepSeek or a local model, the output should
 * come out sounding like the same agent — which is the whole point of separating
 * the two.
 *
 * Three levels of intervention, chosen by how far the draft already is from the
 * fingerprint. Most drafts need none, and paying for a second model call on a
 * reply that already sounds right is how a per-reply cost becomes a bill.
 */

/** Providers each have a house style; these are the tells that survive prompting. */
const TRIMMABLE_OPENERS = [
  /^(great|good|excellent|interesting)\s+(question|point)[.!,]?\s*/i,
  /^(absolutely|certainly|of course|sure)[.!,]\s*/i,
  /^(thanks|thank you) for (asking|the question)[.!,]?\s*/i,
  /^(i think )?(that'?s|this is) a (great|good|fair|valid) (point|question)[.!,]?\s*/i,
  /^(so,?|well,?|ah,?)\s+/i,
  /^(to answer your question,?|you'?re asking\s+\w+,?)\s*/i,
];

const TRIMMABLE_CLOSERS = [
  /\s*(hope (this|that) helps[.!]?)$/i,
  /\s*(let me know if (you have any|there'?s anything)[^.!?]*[.!?]?)$/i,
  /\s*(feel free to (ask|reach out)[^.!?]*[.!?]?)$/i,
  /\s*(happy to (help|elaborate|expand)[^.!?]*[.!?]?)$/i,
  /\s*(hope that (makes sense|clarifies)[^.!?]*[.!?]?)$/i,
];

/** Corporate and marketing words with plain replacements. */
const PLAINER: [RegExp, string][] = [
  [/\bleverage\b/gi, 'use'],
  [/\butili[sz]e\b/gi, 'use'],
  [/\bfacilitate\b/gi, 'help'],
  [/\bin order to\b/gi, 'to'],
  [/\bat this point in time\b/gi, 'now'],
  [/\bdue to the fact that\b/gi, 'because'],
  [/\ba (large )?number of\b/gi, 'many'],
  [/\bit is (important|worth) (to note|noting) that\b/gi, ''],
  [/\bdelve into\b/gi, 'look at'],
];

export interface CompileInput {
  /** What the model produced. */
  draft: string;
  fingerprint: VoiceFingerprint;
  policy: VoicePolicy;
  /** Hard ceiling from the output policy. Never exceeded, whatever else happens. */
  maxCharacters?: number;
}

export interface CompileResult {
  text: string;
  /** none | light | model_needed */
  applied: 'none' | 'light' | 'model_needed';
  scoreBefore: number;
  scoreAfter: number;
  changes: string[];
  /** Set when a model rewrite is called for; the caller decides whether to pay. */
  rewriteBrief: string | null;
}

/** Sentence-aware truncation, so a shortened reply still ends somewhere. */
function trimToSentence(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  const lastStop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  if (lastStop > limit * 0.5) return cut.slice(0, lastStop + 1).trim();
  const lastSpace = cut.lastIndexOf(' ');
  return (lastSpace > 0 ? cut.slice(0, lastSpace) : cut).trim();
}

/**
 * The deterministic pass.
 *
 * Only removals and substitutions — nothing here invents words. A compiler that
 * writes new sentences is a second model with none of the safeguards, and the
 * output policy has already been applied to the draft it is editing.
 */
function lightCompile(draft: string, input: CompileInput): { text: string; changes: string[] } {
  const changes: string[] = [];
  let text = draft.trim();

  for (const pattern of TRIMMABLE_OPENERS) {
    const trimmed = text.replace(pattern, '');
    if (trimmed !== text && trimmed.trim().length > 0) {
      text = trimmed.trimStart();
      changes.push('dropped a filler opening');
      break;
    }
  }

  for (const pattern of TRIMMABLE_CLOSERS) {
    const trimmed = text.replace(pattern, '');
    if (trimmed !== text && trimmed.trim().length > 0) {
      text = trimmed.trimEnd();
      changes.push('dropped a helpdesk sign-off');
    }
  }

  for (const [pattern, plain] of PLAINER) {
    if (pattern.test(text)) {
      text = text.replace(pattern, plain);
      changes.push('replaced stock phrasing with plainer words');
    }
  }

  // Habits the agent measurably does not have. Only near-never rates count:
  // stripping emoji from an agent that uses them a third of the time would be
  // enforcing a fingerprint against itself.
  if (input.fingerprint.sampleCount >= 10) {
    if (input.fingerprint.hashtagRate <= 0.05 && /#\w/.test(text)) {
      text = text.replace(/\s*#[A-Za-z0-9_]+/g, '').trim();
      changes.push('removed hashtags, which this agent does not use');
    }
    if (input.fingerprint.exclamationRate <= 0.05 && /!/.test(text)) {
      text = text.replace(/!+/g, '.');
      changes.push('toned down exclamation marks');
    }
    if (input.fingerprint.emojiRate <= 0.05) {
      const withoutEmoji = text.replace(
        /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu,
        '',
      );
      if (withoutEmoji !== text) {
        text = withoutEmoji.replace(/\s{2,}/g, ' ').trim();
        changes.push('removed emoji, which this agent does not use');
      }
    }
  }

  text = text.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

  // Length last, so trimming happens after everything that shortens the text.
  const ceiling = Math.min(
    input.maxCharacters ?? Number.MAX_SAFE_INTEGER,
    input.fingerprint.sampleCount >= 10
      ? Math.max(input.fingerprint.p90Chars * 1.3, input.fingerprint.medianChars * 2.5, 120)
      : Number.MAX_SAFE_INTEGER,
  );
  if (text.length > ceiling) {
    text = trimToSentence(text, Math.floor(ceiling));
    changes.push('shortened to the length this agent usually writes');
  }

  return { text, changes };
}

/**
 * Turns a semantic draft into something the agent would have written.
 *
 * Returns rather than throws when a model rewrite is needed: whether to spend a
 * second call is the caller's decision, made against the budget policy.
 */
export function compileVoice(input: CompileInput): CompileResult {
  const before = scoreVoice(input.draft, input.fingerprint);

  if (!input.policy.enabled) {
    return {
      text: input.draft.trim(),
      applied: 'none',
      scoreBefore: before.score,
      scoreAfter: before.score,
      changes: [],
      rewriteBrief: null,
    };
  }

  // The cheap pass runs whatever the score is. A helpdesk sign-off on a
  // correctly-sized reply still reads as a helpdesk sign-off, and the voice
  // score cannot see it: length, structure and punctuation are all fine. The
  // threshold governs whether a model rewrite is considered, not whether the
  // free cleanup happens.
  const light = lightCompile(input.draft, input);
  const after = scoreVoice(light.text, input.fingerprint);

  if (before.score >= input.policy.acceptAt) {
    return {
      text: light.text,
      applied: light.changes.length > 0 ? 'light' : 'none',
      scoreBefore: before.score,
      scoreAfter: after.score,
      changes: light.changes,
      rewriteBrief: null,
    };
  }

  // The tidy-up was enough, or the draft was only mildly off to begin with.
  if (after.score >= input.policy.lightRewriteAt || !input.policy.allowModelRewrite) {
    return {
      text: light.text,
      applied: light.changes.length > 0 ? 'light' : 'none',
      scoreBefore: before.score,
      scoreAfter: after.score,
      changes: light.changes,
      rewriteBrief: null,
    };
  }

  return {
    text: light.text,
    applied: 'model_needed',
    scoreBefore: before.score,
    scoreAfter: after.score,
    changes: light.changes,
    rewriteBrief: rewriteBrief(light.text, input.fingerprint, after),
  };
}

/**
 * What to tell a model that is being asked to rewrite in the agent's voice.
 *
 * Numbers rather than adjectives, and only the dimensions that actually scored
 * badly. Telling a model to be "concise and dry" gets a different result from
 * every provider, which is the problem this whole subsystem exists to solve.
 */
export function rewriteBrief(
  text: string,
  fingerprint: VoiceFingerprint,
  match: ReturnType<typeof scoreVoice>,
): string {
  const lines: string[] = [
    'Rewrite the message below so it reads as this specific person wrote it.',
    'Keep the meaning, the facts and the position exactly as they are. Change only how it is said.',
    '',
    'HOW THIS PERSON WRITES',
    `- Typical reply: about ${fingerprint.medianChars} characters, rarely over ${fingerprint.p90Chars}.`,
    `- Usually ${fingerprint.medianSentences} sentence${fingerprint.medianSentences === 1 ? '' : 's'}.`,
  ];

  // Only the ends of the range are worth stating. A habit the agent has half
  // the time is not a rule, and telling a model it "sometimes" does something
  // produces exactly the mush this is meant to avoid.
  const habit = (rate: number, never: string | null, often: string | null) =>
    rate <= 0.05 ? never : rate >= 0.4 ? often : null;

  for (const line of [
    habit(fingerprint.questionRate, '- Rarely ends on a question.', '- Often ends on a question.'),
    habit(fingerprint.emojiRate, '- Never uses emoji.', '- Uses emoji freely.'),
    habit(fingerprint.hashtagRate, '- Never uses hashtags.', '- Uses hashtags.'),
    habit(fingerprint.exclamationRate, '- Almost never uses exclamation marks.', '- Uses exclamation marks.'),
    habit(fingerprint.contractionRate, '- Writes without contractions.', "- Uses contractions: don't, it's, that's."),
    habit(fingerprint.fragmentRate, null, '- Often writes in fragments rather than full sentences.'),
    habit(fingerprint.firstPersonRate, '- Rarely refers to itself.', '- Speaks in the first person.'),
  ]) {
    if (line) lines.push(line);
  }

  if (fingerprint.characteristicWords.length > 0) {
    lines.push(`- Words it actually uses: ${fingerprint.characteristicWords.slice(0, 12).join(', ')}.`);
  }

  const weak = match.dimensions.filter((d) => d.score < 80);
  if (weak.length > 0) {
    lines.push('', 'WHAT IS WRONG WITH THE DRAFT');
    for (const dimension of weak) lines.push(`- ${dimension.name}: ${dimension.detail}`);
  }

  lines.push(
    '',
    'Return only the rewritten message. No preamble, no quotation marks, no explanation.',
    '',
    'DRAFT',
    text,
  );
  return lines.join('\n');
}
