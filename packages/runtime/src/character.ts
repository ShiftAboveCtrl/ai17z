import type {
  CharacterAnswers,
  CharacterCompleteness,
  EasyCharacter,
  EasyStylePreset,
} from '@xbam/shared/contracts';
import { CHARACTER_QUESTIONS, CharacterAnswers as CharacterAnswersSchema } from '@xbam/shared/contracts';

/**
 * Building a character from a description, a template, or a scraped account.
 *
 * Three ways in, one shape out. Whichever route somebody takes they answer the
 * same questions, so a character described in a paragraph is as deep as one
 * typed field by field — and a template handed to another assistant is
 * generated from the same list rather than written twice and left to drift.
 *
 * The whole file is pure. Nothing here calls a model; `describeToAnswers` in
 * the API supplies the model and this supplies the prompt and the parsing.
 */

const TOTAL_WEIGHT = CHARACTER_QUESTIONS.reduce((sum, q) => sum + q.weight, 0);

/** Whether an answer is actually answered, rather than present and empty. */
function answered(answers: CharacterAnswers, key: string): boolean {
  const value = (answers as unknown as Record<string, unknown>)[key];
  if (Array.isArray(value)) return value.filter((v) => String(v).trim()).length > 0;
  // Two words is not a personality. A field with "funny" in it is a field
  // somebody skipped, and scoring it as complete helps nobody.
  const text = String(value ?? '').trim();
  if (key === 'name') return text.length > 0;
  return text.length >= 12;
}

/**
 * How complete a character is, weighted by how much each answer matters.
 *
 * Examples are worth the most because a model imitates examples and only
 * approximates adjectives; a character with five real sentences in its own
 * voice beats one with three paragraphs describing that voice.
 */
export function scoreCharacter(input: Partial<CharacterAnswers>): CharacterCompleteness {
  const answers = CharacterAnswersSchema.parse(input);
  let earned = 0;
  const missing: CharacterCompleteness['missing'] = [];

  for (const question of CHARACTER_QUESTIONS) {
    if (answered(answers, question.key)) earned += question.weight;
    else missing.push({ key: question.key, ask: question.ask, why: question.why });
  }

  return { score: Math.round((earned / TOTAL_WEIGHT) * 100), missing };
}

/**
 * The instruction handed to a model that is building a character from a
 * description somebody typed.
 *
 * Written to be strict about the shape and loose about the content: the JSON
 * has to come back parseable, and everything else is the model's judgement
 * about the character. The one rule that is not negotiable is that examples
 * must be sentences the character would say — a model asked for examples will
 * otherwise return descriptions of examples.
 */
export function describePrompt(description: string): string {
  const questions = CHARACTER_QUESTIONS.map((q) => `- ${q.key}: ${q.ask} (${q.why})`).join('\n');
  return [
    'You are helping somebody set up a social media character. They have described it in their own words.',
    'Turn that into a complete, specific character definition.',
    '',
    'WHAT THEY WROTE',
    description.trim(),
    '',
    'ANSWER ALL OF THESE',
    questions,
    '',
    'RULES',
    '- Return JSON only. No prose before or after, no code fences.',
    '- caresAbout, examples, opinions and avoids are arrays of strings.',
    '- Everything else is a string.',
    '- examples must be things the character would actually say, written as they would say them.',
    '  Not descriptions of what they would say. Five of them, varied in length.',
    '- Be specific. "Funny" is useless; "deadpan, never explains the joke, undercuts his own point" is usable.',
    '- Where they did not say, decide something consistent with what they did say rather than leaving it blank.',
    '- Do not invent biographical facts that could be checked and found false.',
    '',
    'SHAPE',
    JSON.stringify(
      {
        name: 'string',
        description: 'string',
        personality: 'string',
        tone: 'string',
        caresAbout: ['string'],
        speaksLike: 'string',
        examples: ['string'],
        opinions: ['string'],
        avoids: ['string'],
        audience: 'string',
      },
      null,
      2,
    ),
  ].join('\n');
}

/**
 * Reads a model's answer, tolerating the things models do to JSON.
 *
 * Code fences, a sentence of preamble, and trailing commentary are all common
 * enough that failing on them would make this feature unreliable for no reason.
 * What is not tolerated is guessing: if there is no object in there, it says so.
 */
export function parseCharacterJson(raw: string): { ok: true; answers: CharacterAnswers } | { ok: false; detail: string } {
  const withoutFences = raw.replace(/```(?:json)?/gi, '').trim();
  const start = withoutFences.indexOf('{');
  const end = withoutFences.lastIndexOf('}');
  if (start === -1 || end <= start) {
    return { ok: false, detail: 'The model did not return anything that looks like JSON.' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(withoutFences.slice(start, end + 1));
  } catch (error) {
    return { ok: false, detail: `The model returned JSON that could not be read: ${(error as Error).message}` };
  }

  const result = CharacterAnswersSchema.safeParse(coerceShape(parsed));
  if (!result.success) {
    return { ok: false, detail: `The model returned the wrong shape: ${result.error.issues[0]?.message ?? 'unknown'}` };
  }
  return { ok: true, answers: result.data };
}

/**
 * Nudges near-misses into shape.
 *
 * Models return a comma-separated string where an array was asked for often
 * enough that rejecting it would be pedantry rather than rigour.
 */
function coerceShape(value: unknown): Record<string, unknown> {
  const object = (value ?? {}) as Record<string, unknown>;
  const arrays = ['caresAbout', 'examples', 'opinions', 'avoids'];
  const fixed: Record<string, unknown> = { ...object };
  for (const key of arrays) {
    const raw = object[key];
    if (typeof raw === 'string') {
      fixed[key] = raw
        .split(/\n|,(?![^(]*\))/)
        .map((s) => s.trim().replace(/^[-*\d.)\s]+/, ''))
        .filter(Boolean);
    }
  }
  return fixed;
}

/** The Easy Mode character an answered question set describes. */
export function answersToCharacter(answers: CharacterAnswers, preset: EasyStylePreset = 'CUSTOM'): EasyCharacter {
  return {
    name: answers.name.trim() || 'Untitled',
    description: answers.description.trim().slice(0, 500),
    personality: [answers.personality.trim(), answers.audience.trim() ? `Talking to: ${answers.audience.trim()}` : '']
      .filter(Boolean)
      .join('\n\n')
      .slice(0, 4_000),
    tone: answers.tone.trim().slice(0, 1_000),
    caresAbout: answers.caresAbout.map((t) => t.trim()).filter(Boolean).slice(0, 40),
    speaksLike: [
      answers.speaksLike.trim(),
      answers.opinions.length > 0 ? `Holds these positions and will say so:\n${bullets(answers.opinions)}` : '',
    ]
      .filter(Boolean)
      .join('\n\n')
      .slice(0, 4_000),
    examples: answers.examples.map((e) => e.trim()).filter(Boolean).slice(0, 50),
    preset,
  };
}

/** Things the character must never do, for the persona's prohibited list. */
export function answersToProhibited(answers: CharacterAnswers): string[] {
  return answers.avoids.map((a) => a.trim()).filter(Boolean).slice(0, 20);
}

function bullets(items: string[]): string {
  return items.map((i) => `- ${i.trim()}`).filter((l) => l.length > 2).join('\n');
}

/**
 * The template somebody hands to another assistant.
 *
 * Generated from the same question list the rest of this file uses, so it
 * cannot drift from what AI17Z actually reads. Markdown rather than a binary
 * format: it survives being pasted into a chat window, which is exactly what
 * people do with it, and the upload side accepts the JSON block it asks for.
 */
export function characterTemplate(): string {
  const lines: string[] = [
    '# AI17Z character brief',
    '',
    'Give this file to any assistant along with a description of the character you',
    'want. Ask it to fill in the JSON at the bottom and give the file back. Then',
    'upload the result to AI17Z, on the character step of agent setup.',
    '',
    '## What AI17Z needs, and why',
    '',
  ];

  for (const question of CHARACTER_QUESTIONS) {
    lines.push(`### ${question.key}`, '', question.ask, '', `*Why it matters:* ${question.why}`, '');
  }

  lines.push(
    '## Rules for whoever fills this in',
    '',
    '- `examples` are the most important field by a distance. Write things the',
    '  character would actually say, in their words, not descriptions of what they',
    '  would say. Five, varied in length.',
    '- Be specific. "Funny" is useless. "Deadpan, never explains the joke,',
    '  undercuts his own point" is usable.',
    '- Where the description does not say, decide something consistent with what it',
    '  does say. Do not leave fields blank.',
    '- Do not invent biographical facts that could be checked and found false.',
    '',
    '## Fill this in and return the whole block',
    '',
    '```json',
    JSON.stringify(
      {
        name: '',
        description: '',
        personality: '',
        tone: '',
        caresAbout: [],
        speaksLike: '',
        examples: [],
        opinions: [],
        avoids: [],
        audience: '',
      },
      null,
      2,
    ),
    '```',
    '',
  );
  return lines.join('\n');
}

/**
 * Pulls the answers out of a returned template.
 *
 * Accepts the whole file, the JSON block on its own, or a PDF's extracted text:
 * all three end up as a string with a JSON object somewhere in it, and finding
 * that object is the same job in every case.
 */
export function parseFilledTemplate(text: string): { ok: true; answers: CharacterAnswers } | { ok: false; detail: string } {
  const fenced = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/i);
  return parseCharacterJson(fenced?.[1] ?? text);
}
