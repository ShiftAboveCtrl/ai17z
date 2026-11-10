/**
 * A voice, built from an agent and turned back into one: the pure half.
 *
 * Nothing here touches the database, the network or the clock, so every
 * decision in it (what a voice contains, what its digest is, what a stranger's
 * text is flagged for) is an argument in a unit test.
 *
 * ## Built from named fields
 *
 * `voiceFromAgent` reads a persona and a policy and copies out exactly the
 * fields `VoiceDocument` has a place for. It does not clone a persona and
 * delete from it. The difference is what happens next year when `PersonaDraft`
 * grows a field: a denylist publishes it until somebody remembers, and this
 * does not.
 *
 * ## Installing is the reverse, into defaults
 *
 * `personaFromVoice` and `policyFromVoice` start from the platform's defaults
 * and set only the voice's fields. A published voice therefore cannot choose
 * `identityKind`, `mayDenyBeingAI`, `capabilityLoop`, a represented entity or
 * any other part of the policy that decides what an agent may do. Those are the
 * installer's, as they are for any new agent.
 */
import { createHash } from 'node:crypto';
import {
  DEFAULT_POLICY,
  MAX_VOICE_BYTES,
  PersonaDraft,
  PolicyConfig,
  VOICE_DOCUMENT_FORMAT,
  VOICE_DOCUMENT_VERSION,
  VoiceDocument,
  type VoiceCounts,
} from '@xbam/shared/contracts';
import { canonicalJson } from '@xbam/shared';

/** The digest Studio stores and a reader recomputes: sha256 of the canonical JSON. */
export function voiceDigest(document: VoiceDocument): string {
  return createHash('sha256').update(canonicalJson(document)).digest('hex');
}

/**
 * Counted out of the parsed document, never read from a field the file supplied.
 * A voice that described itself as short would be the one worth checking.
 */
export function countsOf(document: VoiceDocument): VoiceCounts {
  const c = document.character;
  return {
    styleExamples: c.styleExamples.length,
    topics: c.topics.length,
    prohibitedBehaviors: c.prohibitedBehaviors.length,
    allowedEmoji: document.settings.emoji.allowed.length,
    characters:
      document.title.length +
      document.summary.length +
      c.biography.length +
      c.personality.length +
      c.tone.length +
      c.styleGuidelines.length +
      c.languagePolicy.length +
      c.styleExamples.reduce((sum, value) => sum + value.length, 0) +
      c.prohibitedBehaviors.reduce((sum, value) => sum + value.length, 0) +
      c.topics.reduce((sum, value) => sum + value.length, 0),
  };
}

/** One sentence about a zod failure, with where it was. */
function firstProblem(error: { issues: Array<{ path: PropertyKey[]; message: string; code?: string; keys?: string[] }> }): string {
  const first = error.issues[0];
  if (!first) return 'It does not match the voice format.';
  const where = first.path.length ? first.path.map(String).join('.') : 'the document';
  if (first.code === 'unrecognized_keys') {
    return `It carries a field a voice does not have (${(first.keys ?? []).join(', ') || 'unknown'} at ${where}).`;
  }
  return `${where}: ${first.message}.`;
}

export type ParsedVoice =
  | { ok: true; document: VoiceDocument; digest: string; bytes: number }
  | { ok: false; problem: string };

/**
 * Reads a voice from text or from something already parsed. Never throws: a
 * file that is not a voice is something to be told about, not an error to
 * handle.
 *
 * Same order as the agent package reader and for the same reason: the version
 * is looked at before the shape, because the schema is strict and a newer
 * format would otherwise be reported as an unknown field instead of as "update
 * before reading it".
 */
export function parseVoice(raw: unknown): ParsedVoice {
  let value: unknown = raw;
  let bytes = 0;
  if (typeof raw === 'string' || Buffer.isBuffer(raw)) {
    const text = typeof raw === 'string' ? raw : raw.toString('utf8');
    bytes = Buffer.byteLength(text, 'utf8');
    if (bytes > MAX_VOICE_BYTES) {
      return { ok: false, problem: `That is larger than ${MAX_VOICE_BYTES / 1024}KB, which no voice is.` };
    }
    try {
      value = JSON.parse(text) as unknown;
    } catch {
      return { ok: false, problem: 'That is not an AI17Z voice. It is not readable as JSON.' };
    }
  } else {
    bytes = Buffer.byteLength(JSON.stringify(raw) ?? '', 'utf8');
    if (bytes > MAX_VOICE_BYTES) {
      return { ok: false, problem: `That is larger than ${MAX_VOICE_BYTES / 1024}KB, which no voice is.` };
    }
  }
  const head = value as { format?: unknown; version?: unknown } | null | undefined;
  if (!head || typeof head !== 'object' || head.format !== VOICE_DOCUMENT_FORMAT) {
    return { ok: false, problem: 'That is not an AI17Z voice.' };
  }
  if (typeof head.version === 'number' && head.version > VOICE_DOCUMENT_VERSION) {
    return {
      ok: false,
      problem: `That voice was written by a newer AI17Z (format version ${head.version}; this one reads ${VOICE_DOCUMENT_VERSION}). Update before reading it.`,
    };
  }
  const parsed = VoiceDocument.safeParse(value);
  if (!parsed.success) return { ok: false, problem: `That voice could not be read. ${firstProblem(parsed.error)}` };
  return { ok: true, document: parsed.data, digest: voiceDigest(parsed.data), bytes };
}

/** Just enough of a persona and a policy to build a voice, so a test can hand in plain objects. */
export interface VoiceSource {
  persona: Pick<
    PersonaDraft,
    | 'biography'
    | 'personality'
    | 'tone'
    | 'styleGuidelines'
    | 'styleExamples'
    | 'topics'
    | 'languagePolicy'
    | 'responseLength'
    | 'prohibitedBehaviors'
  >;
  output: Pick<
    PolicyConfig['output'],
    'emoji' | 'maxCharacters' | 'forbidHashtags' | 'forbidLinks' | 'forbidMentionsOfOthers' | 'stripSurroundingQuotes'
  >;
}

export type BuiltVoice = { ok: true; document: VoiceDocument; digest: string } | { ok: false; problem: string };

/**
 * An agent's voice, as the document that would be published.
 *
 * Refuses rather than trims. A biography past the voice's limit is a decision
 * for the owner about what the listing should say, and silently cutting it
 * would publish a sentence they did not write.
 */
export function voiceFromAgent(source: VoiceSource, listing: { title: string; summary: string }): BuiltVoice {
  const p = source.persona;
  const o = source.output;
  const candidate = {
    format: VOICE_DOCUMENT_FORMAT,
    version: VOICE_DOCUMENT_VERSION,
    title: listing.title.trim(),
    summary: listing.summary.trim(),
    character: {
      biography: p.biography,
      personality: p.personality,
      tone: p.tone,
      styleGuidelines: p.styleGuidelines,
      styleExamples: [...p.styleExamples],
      topics: [...p.topics],
      languagePolicy: p.languagePolicy,
      responseLength: p.responseLength,
      prohibitedBehaviors: [...p.prohibitedBehaviors],
    },
    settings: {
      emoji: {
        use: o.emoji.use,
        maxPerMessage: o.emoji.maxPerMessage,
        allowed: [...o.emoji.allowed],
        messagesPercent: o.emoji.messagesPercent,
      },
      maxCharacters: o.maxCharacters,
      forbidHashtags: o.forbidHashtags,
      forbidLinks: o.forbidLinks,
      forbidMentionsOfOthers: o.forbidMentionsOfOthers,
      stripSurroundingQuotes: o.stripSurroundingQuotes,
    },
  };
  const parsed = VoiceDocument.safeParse(candidate);
  if (!parsed.success) {
    return { ok: false, problem: `This voice cannot be published as it stands. ${firstProblem(parsed.error)}` };
  }
  return { ok: true, document: parsed.data, digest: voiceDigest(parsed.data) };
}

/**
 * The persona a new agent gets from a voice.
 *
 * `identityKind` is the platform default and `customInstructions` is empty:
 * both are the installer's to set, and neither is in the voice. The display
 * name is the installer's too. A published voice does not get to name the agent
 * that installs it, which is also what stops it claiming to be somebody.
 */
export function personaFromVoice(document: VoiceDocument, displayName: string, changeNote: string): PersonaDraft {
  const c = document.character;
  return PersonaDraft.parse({
    displayName,
    biography: c.biography,
    personality: c.personality,
    tone: c.tone,
    styleGuidelines: c.styleGuidelines,
    styleExamples: c.styleExamples,
    topics: c.topics,
    languagePolicy: c.languagePolicy,
    responseLength: c.responseLength,
    prohibitedBehaviors: c.prohibitedBehaviors,
    changeNote: changeNote.slice(0, 500),
  });
}

/**
 * The policy a new agent gets: the platform's, with the voice's output settings.
 *
 * Built from `DEFAULT_POLICY` so every part of the policy that decides what the
 * agent may do (identity, tools, trading, rate limits, approvals) is exactly
 * what any new agent has. Only the six output settings come from the voice.
 */
export function policyFromVoice(document: VoiceDocument): PolicyConfig {
  const s = document.settings;
  return PolicyConfig.parse({
    ...DEFAULT_POLICY,
    output: {
      ...DEFAULT_POLICY.output,
      maxCharacters: s.maxCharacters,
      forbidHashtags: s.forbidHashtags,
      forbidLinks: s.forbidLinks,
      forbidMentionsOfOthers: s.forbidMentionsOfOthers,
      stripSurroundingQuotes: s.stripSurroundingQuotes,
      emoji: { ...s.emoji },
    },
  });
}

// ---------------------------------------------------------------------------
// What a stranger's words are flagged for
// ---------------------------------------------------------------------------

export type VoiceFindingKind =
  | 'INSTRUCTION_OVERRIDE'
  | 'PROMPT_EXTRACTION'
  | 'IDENTITY_DENIAL'
  | 'SECRET_REQUEST'
  | 'MONEY_INSTRUCTION'
  | 'MARKUP';

export interface VoiceFinding {
  /** Where, as a path into the document: `character.styleExamples.3`. */
  field: string;
  kind: VoiceFindingKind;
  /** What matched, cut short. */
  excerpt: string;
}

const NEGATION = /\b(never|don'?t|do not|won'?t|will not|must not|should not|shouldn'?t|not|no one|nobody|warn|beware)\b/i;

const RULES: Array<{ kind: VoiceFindingKind; pattern: RegExp; unlessNegated?: boolean }> = [
  {
    kind: 'INSTRUCTION_OVERRIDE',
    pattern:
      /\b(ignore|disregard|forget|override|bypass)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all|any|your|the|these)\b[^.\n]{0,30}\b(instructions?|rules?|prompts?|polic(?:y|ies)|guidelines?|restrictions?)\b/i,
  },
  { kind: 'INSTRUCTION_OVERRIDE', pattern: /\byou are now\b|\bdeveloper mode\b|\bjailbreak\b|\bDAN mode\b/i },
  { kind: 'INSTRUCTION_OVERRIDE', pattern: /\b(?:new|updated|real) (?:system )?(?:instructions?|rules)\s*:/i },
  { kind: 'INSTRUCTION_OVERRIDE', pattern: /^\s*(?:system|assistant|developer)\s*:/im },
  { kind: 'INSTRUCTION_OVERRIDE', pattern: /<\|?(?:im_start|im_end|system|endoftext)\|?>/i },
  {
    kind: 'PROMPT_EXTRACTION',
    pattern: /\b(?:reveal|show|print|repeat|leak|disclose)\b[^.\n]{0,30}\b(?:system prompt|your prompt|your instructions|hidden instructions|initial instructions)\b/i,
  },
  {
    kind: 'IDENTITY_DENIAL',
    pattern: /\b(?:never|don'?t|do not|must not)\b[^.\n]{0,30}\b(?:admit|reveal|say|confess|disclose)\b[^.\n]{0,30}\b(?:ai|bot|artificial|language model|machine)\b/i,
  },
  {
    kind: 'IDENTITY_DENIAL',
    pattern: /\b(?:deny|denies|denying|hide|hiding|conceal)\b[^.\n]{0,25}\b(?:being|that (?:you are|you're|it is))\b[^.\n]{0,15}\b(?:an? )?(?:ai|bot)\b/i,
  },
  {
    kind: 'IDENTITY_DENIAL',
    pattern: /\b(?:pretend|claim|insist)\b[^.\n]{0,25}\b(?:to be|that you are|you are)\b[^.\n]{0,15}\b(?:human|a real person)\b/i,
  },
  {
    kind: 'SECRET_REQUEST',
    pattern: /\b(?:send|share|give|tell|paste|dm|ask for)\b[^.\n]{0,30}\b(?:private keys?|seed phrases?|recovery phrases?|api keys?|passwords?)\b/i,
    unlessNegated: true,
  },
  {
    kind: 'MONEY_INSTRUCTION',
    pattern: /\b(?:send|transfer|wire|swap|approve)\b[^.\n]{0,20}\b(?:funds?|tokens?|eth|sol|usdc|crypto|coins?)\b[^.\n]{0,20}\b(?:to|from|now|immediately)\b/i,
    unlessNegated: true,
  },
  { kind: 'MARKUP', pattern: /<\s*(?:script|iframe|object|embed|style|link)\b|\bjavascript:|\bon[a-z]+\s*=\s*["']/i },
];

function* stringsOf(value: unknown, path: string): Generator<[string, string]> {
  if (typeof value === 'string') yield [path, value];
  else if (Array.isArray(value)) for (let i = 0; i < value.length; i += 1) yield* stringsOf(value[i], `${path}.${i}`);
  else if (value && typeof value === 'object') {
    for (const [key, inner] of Object.entries(value)) yield* stringsOf(inner, path ? `${path}.${key}` : key);
  }
}

/**
 * Text that reads as an instruction to the model, a denial of what the agent is,
 * or a request for something it must never hold.
 *
 * This is a flag for a person and not a gate, and the distinction is the point.
 * A regular expression cannot tell a persona that jokes about "ignoring all
 * previous instructions" from one that means it, and a wall of words can always
 * get past a list. What makes a hostile voice harmless is that its text is only
 * ever stored in persona fields, where the platform's policy, validator and
 * identity rules sit between it and the world. What this adds is that the owner
 * is told what looks wrong before they install it, and has to say so once.
 */
export function scanVoice(document: VoiceDocument): VoiceFinding[] {
  const findings: VoiceFinding[] = [];
  for (const [field, text] of stringsOf(document, '')) {
    for (const rule of RULES) {
      const match = rule.pattern.exec(text);
      if (!match) continue;
      if (rule.unlessNegated) {
        // The clause the match sits in, so "never share your seed phrase" is a
        // persona being careful rather than one asking for it.
        const start = Math.max(text.lastIndexOf('.', match.index), text.lastIndexOf('\n', match.index)) + 1;
        if (NEGATION.test(text.slice(start, match.index + match[0].length))) continue;
      }
      findings.push({ field, kind: rule.kind, excerpt: match[0].replace(/\s+/g, ' ').slice(0, 80) });
    }
  }
  return findings;
}
