/**
 * How much of a reply this message is actually asking for.
 *
 * ## The failure this fixes
 *
 * The response envelope was a property of the persona and nothing else:
 * `MEDIUM` meant "two to four sentences" whether somebody had written a
 * paragraph about scheduling or the word "nice". Every reply the live agent
 * published came out between 110 and 175 characters, including the ones
 * answering a joke, and a timeline of uniformly-sized paragraphs reads as a
 * machine whatever the words are.
 *
 * ## Deterministic, for the same reason `salience.ts` is
 *
 * No model call. A register decided by a model is one nobody can inspect,
 * correct or tune, and it would be a second model call on the path of every
 * reply to decide something that is mostly obvious from the shape of the text.
 * Every verdict here carries the sentence that produced it.
 *
 * ## Not a keyword list
 *
 * The strongest signal by far is **how much the other person said**. Somebody
 * who wrote four words is not asking for four sentences, whatever the words
 * were. That holds across languages, topics and moods, and it needs no
 * vocabulary to maintain. The rest are structural: a question mark, a code
 * identifier, a link. Nothing here tries to detect sarcasm or mood from
 * wording, because that is where brittle keyword lists come from and they are
 * wrong often enough to be worse than the default.
 *
 * ## It never overrides the owner
 *
 * This narrows, never widens. An owner who set TERSE gets terse even when
 * somebody writes an essay. What it stops is the opposite: a paragraph in
 * answer to "ha, fair".
 */

export const REGISTERS = ['BANTER', 'PRAISE', 'QUESTION', 'TECHNICAL', 'PLAIN'] as const;
export type Register = (typeof REGISTERS)[number];

export interface Envelope {
  register: Register;
  /** The most sentences this reply should reasonably run to. */
  sentences: number;
  /** Why, in words, for the trace and for the prompt. */
  because: string;
  /**
   * Whether asking something back is likely to be welcome here.
   *
   * Not every reply should close the conversation, and not every reply should
   * end in a question either. A question after a one-word compliment is
   * needy; a question after somebody describes a problem is the useful part.
   */
  inviteQuestion: boolean;
}

/** Below this many words, nobody is asking for a paragraph. */
const BRIEF_WORDS = 6;
/** Above this, they have written something substantial and expect engagement. */
const SUBSTANTIAL_WORDS = 40;

/** Things that only appear when somebody is being technical. */
const TECHNICAL_SHAPE =
  /(`[^`]+`|https?:\/\/|\b[a-z]+\.(ts|js|tsx|sql|json|md|sh|ps1)\b|\bv?\d+\.\d+\.\d+|\b[A-Za-z_]\w*\(\)|\b0x[0-9a-fA-F]{6,})/;

/**
 * The short, warm noises people make that are not questions.
 *
 * Deliberately tiny and deliberately not a sentiment model. These are the
 * handful of things that arrive alone, mean "I liked that", and get a paragraph
 * back if nothing notices what they are. Anything not on it simply falls
 * through to the length rules, which is the safe direction.
 */
const APPRECIATION = /^(thanks|thank you|ty|thx|nice|nice one|love it|great|awesome|congrats|gg|this is great|beautiful|clean|solid|based)\b/i;

/** Laughter, which is a reply to join rather than a question to answer. */
const LAUGHTER = /(^|\s)(lol|lmao|haha+|hehe|😂|🤣|💀)(\s|$|!|\.)/i;

function words(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * What this message is asking for.
 *
 * Order matters: the specific readings come first, and the general
 * how-much-did-they-say rule is the floor everything else falls back to.
 */
export function envelopeFor(incoming: string): Envelope {
  const text = (incoming ?? '').trim();
  const count = words(text);

  if (count === 0) {
    // A post of the agent's own making, or a mention with nothing in it. The
    // persona's own setting is the only guide there is.
    return {
      register: 'PLAIN',
      sentences: 3,
      because: 'Nothing was said to answer, so the usual length applies.',
      inviteQuestion: false,
    };
  }

  if (LAUGHTER.test(text) && count <= 12) {
    return {
      register: 'BANTER',
      sentences: 1,
      because: 'They were joking, so this is a joke to answer rather than a point to address.',
      // Explaining a joke is worse than not landing one, and asking a question
      // after one is how a conversation stops being fun.
      inviteQuestion: false,
    };
  }

  if (APPRECIATION.test(text) && count <= 10) {
    return {
      register: 'PRAISE',
      sentences: 1,
      because: 'They said something kind and short. Take it and say so, briefly.',
      inviteQuestion: false,
    };
  }

  const asking = text.includes('?');
  const technical = TECHNICAL_SHAPE.test(text);

  if (asking && technical) {
    return {
      register: 'TECHNICAL',
      sentences: 4,
      because: 'A specific technical question, so enough detail to actually help.',
      inviteQuestion: false,
    };
  }

  if (asking) {
    return {
      register: 'QUESTION',
      // Two, not four. Most questions have an answer; the paragraph is usually
      // the model explaining itself around it.
      sentences: count <= 12 ? 1 : 2,
      because:
        count <= 12
          ? 'A short question, so a short answer.'
          : 'A question with some substance behind it, so answer it and stop.',
      inviteQuestion: false,
    };
  }

  if (technical) {
    return {
      register: 'TECHNICAL',
      sentences: 3,
      because: 'They are talking about something specific, so be specific back.',
      // Somebody describing a system is the one case where a focused question
      // is usually the most useful thing that can be said.
      inviteQuestion: true,
    };
  }

  if (count <= BRIEF_WORDS) {
    return {
      register: 'BANTER',
      sentences: 1,
      because: `They wrote ${count} word${count === 1 ? '' : 's'}. One line back is plenty.`,
      inviteQuestion: false,
    };
  }

  if (count >= SUBSTANTIAL_WORDS) {
    return {
      register: 'PLAIN',
      sentences: 4,
      because: 'They wrote something substantial, so there is room to engage with it properly.',
      inviteQuestion: true,
    };
  }

  return {
    register: 'PLAIN',
    sentences: 2,
    because: 'An ordinary remark, so an ordinary reply.',
    inviteQuestion: false,
  };
}

/**
 * The envelope as an instruction, never wider than the owner allowed.
 *
 * `ceiling` is what the persona's own setting permits. This narrows within it
 * and never past it, so an owner who asked for terse replies keeps them.
 */
export function lengthInstruction(envelope: Envelope, ceiling: number): string {
  const sentences = Math.max(1, Math.min(envelope.sentences, ceiling));
  const howMany =
    sentences === 1 ? 'One sentence.' : sentences === 2 ? 'One or two sentences.' : `At most ${sentences} sentences.`;
  const invite = envelope.inviteQuestion
    ? ' If something here is genuinely worth asking about, ask one specific thing.'
    : ' Do not end with a question unless it is the actual point.';
  return `${howMany} ${envelope.because}${invite}`;
}
