import type {
  ConversationTemperature,
  EngagementPolicy,
  EngagementVerdict,
  IntentDecision,
  OutreachPolicy,
  RelationshipContext,
  ResponseIntent,
  ValueFactor,
} from '@xbam/shared/contracts';
import { actions as actionsRepo } from '@xbam/database';

/**
 * Whether to reply at all, and if so, what kind of reply.
 *
 * An autonomous agent that answers everything is not autonomous, it is a
 * doorbell. Deciding not to speak is a real decision and is recorded as one,
 * with the reasons in words: "reply value 18" tells nobody anything, while
 * "mass tag with no direct question" tells them whether it was right.
 *
 * All of this is arithmetic and pattern matching rather than a model call. It
 * runs on every inbound event, the result is shown to the owner, and a judgement
 * that cannot be explained is not much use for deciding to stay silent.
 */

const QUESTION = /\?\s*$|\?\s|^(what|why|how|when|where|who|which|is|are|do|does|did|can|could|would|should|will)\b/i;
const GREETING_ONLY = /^(gm|gn|hi|hey|hello|yo|sup|good morning|good night|wagmi|lfg|based)[\s!.]*$/i;
const SPAM = /\b(giveaway|airdrop|free mint|dm me|check my|follow back|f4f|link in bio|100x|guaranteed)\b/i;
const THANKS = /\b(thanks|thank you|ty|appreciate it|cheers)\b/i;
const DISAGREEMENT = /\b(wrong|disagree|no it|actually|that's not|thats not|nonsense|rubbish|incorrect)\b/i;
const HOSTILE = /\b(idiot|stupid|scam|shill|clown|garbage|trash|shut up|useless|fraud)\b/i;
const HUMOUR = /\b(lol|lmao|haha|😂|🤣|joking|kidding)\b/i;
const TECHNICAL = /\b(api|latency|throughput|schema|deploy|memory|token|protocol|consensus|repo|commit|bug|config)\b/i;
const SARCASM = /\b(sure|right|obviously|totally|of course)\b.*\b(lol|\.\.\.)|\/s\b/i;
// "do not understand" is written as often as "don't", and missing it made the
// agent answer a request for clarification by adding more.
const CONFUSED = /\b(confused|(don'?t|do not|cannot|can'?t) (get|understand|follow)|what do you mean|lost me|huh)\b/i;

/**
 * A message that closes an exchange rather than continuing it.
 *
 * These are the things people say when a conversation is finished: agreement,
 * acknowledgement, a sign-off. Answering one is how an exchange goes from four
 * turns to nine, with the agent having the last word every time -- which reads
 * far worse than not answering, because the other person has already stopped.
 *
 * Deliberately anchored and short. "Fair enough" on its own ends a thread;
 * "fair enough, but the fee model still assumes" is somebody still talking, and
 * the length check below is what keeps those apart.
 */
const CLOSING =
  /^(ok(ay)?|k|kk|cool|nice|great|awesome|perfect|got it|gotcha|makes sense|fair|fair enough|agreed|true|right|yep|yeah|yes|indeed|no worries|np|will do|noted|sounds good|good point|good luck|see you|later|bye|ttyl|o7|gg)[\s!.,]*$/i;

/** Emoji-only, which is the other way people say "we are done here". */
const REACTION_ONLY = /^[\p{Extended_Pictographic}\p{Emoji_Presentation}️‍\s!.,]+$/u;

/**
 * Handles, generously.
 *
 * Fifteen is X's limit and this used to enforce it, which meant a longer handle
 * on any other channel was stripped down to fourteen characters and left a
 * fragment behind: "@somebody_longer hey" became "r hey", which is not a
 * greeting as far as an anchored pattern is concerned. Over-matching a handle
 * costs nothing here; under-matching one silently changes the verdict.
 */
const HANDLE = /@[A-Za-z0-9_]{1,32}/g;

function countMentions(text: string): number {
  return (text.match(HANDLE) ?? []).length;
}

/**
 * The message with the handles taken out.
 *
 * Every mention on X begins with the handle it is addressed to, so an anchored
 * pattern like "is this only a greeting" never matched a real message: "@agent
 * hey" is not "hey" as far as a regex is concerned. The word count already
 * stripped them, which is why a bare greeting scored as thin content rather
 * than as a greeting and squeaked over the threshold with a reply of "Hey."
 */
function withoutHandles(text: string): string {
  return text.replace(HANDLE, ' ').replace(/\s+/g, ' ').trim();
}

/** How the incoming message reads. A signal, not a verdict about the person. */
export function readTemperature(text: string): ConversationTemperature {
  if (HOSTILE.test(text)) return 'hostile';
  if (SARCASM.test(text)) return 'sarcastic';
  if (HUMOUR.test(text)) return 'joking';
  if (CONFUSED.test(text)) return 'confused';
  if (TECHNICAL.test(text)) return 'technical';
  if (QUESTION.test(text)) return 'curious';
  if (THANKS.test(text) || GREETING_ONLY.test(withoutHandles(text))) return 'friendly';
  if (text.length > 220) return 'serious';
  return 'casual';
}

export interface ReplyValueInput {
  text: string;
  /** True when the agent's own handle is actually addressed. */
  directlyAddressed: boolean;
  relationship: RelationshipContext | null;
  threadDepth: number;
  /** Replies already sent to this person in the last hour. */
  recentRepliesToPerson: number;
  /** True when the agent already answered somewhere in this thread. */
  alreadyRepliedInThread: boolean;
  /**
   * How many times the agent has spoken in this thread.
   *
   * The difference between "we have talked before" and "I have said four things
   * and they keep going" is the whole question of when to stop, and a boolean
   * cannot express it. Answering somebody's follow-up is ordinary; being six
   * messages deep in a thread nobody else is reading is where an agent starts
   * to look like it cannot let go.
   */
  ourRepliesInThread?: number;
  /**
   * What this agent cares about, from its persona.
   *
   * Only consulted when nobody addressed it. Somebody who asks a question
   * deserves an answer whatever the subject; a post the agent merely came
   * across is a different matter, and an account that replies to everything it
   * sees reads as a bot however well it writes.
   */
  topics?: string[];
  /**
   * Whether there is a post above this one carrying the subject.
   *
   * "thoughts?" under an argument about sequencers is a real question. The same
   * word on its own is not a question about anything, and answering it means
   * inventing the subject -- which is exactly what happened: asked "thoughts?"
   * with nothing above it, the agent reviewed a piece of software nobody had
   * mentioned. A question mark is not content.
   */
  hasParent?: boolean;
  /**
   * True when nobody addressed this to the agent and the agent went looking:
   * a post found through a watched account or a watched keyword.
   *
   * Separate from `directlyAddressed`, which is about the text. A reply in a
   * thread the agent is already in is not addressed to it either, and is still
   * a conversation it is part of. This is about speaking first to a stranger,
   * which is a different act with a different failure mode.
   */
  unprompted?: boolean;
  policy: EngagementPolicy;
  /** Only consulted when `unprompted`. */
  outreach?: OutreachPolicy;
}

/**
 * Whether a message is about anything this agent cares about.
 *
 * Word-level and generous: a topic of "token distribution" matches a post about
 * distribution, because the point is to tell "adjacent to my subject" from
 * "nothing to do with me", not to score relevance precisely.
 */
export function touchesTopics(text: string, topics: string[]): boolean {
  if (topics.length === 0) return true;
  const haystack = ` ${text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ')} `;
  return topics.some((topic) =>
    topic
      .toLowerCase()
      .split(/\s+/)
      .filter((word) => word.length >= 4)
      .some((word) => haystack.includes(` ${word}`)),
  );
}

/**
 * Scores how much answering would be worth.
 *
 * Starts from a middling 40 rather than 0: the default posture toward somebody
 * who took the trouble to say something is to answer, and the score has to be
 * pushed down by a reason.
 */
export function replyValue(input: ReplyValueInput): { value: number; factors: ValueFactor[] } {
  const text = input.text.trim();
  const factors: ValueFactor[] = [];
  let value = 40;

  const add = (label: string, delta: number) => {
    factors.push({ label, delta });
    value += delta;
  };

  const spoken = withoutHandles(text);
  const words = spoken.split(/\s+/).filter(Boolean).length;

  // Whether this is about anything the agent follows. Only consulted when
  // nobody addressed it: somebody who asks the agent a question deserves an
  // answer whatever the subject, but a post it merely came across is different.
  const gateOnTopic = !input.directlyAddressed && (input.topics?.length ?? 0) > 0;
  const onTopic = gateOnTopic ? touchesTopics(text, input.topics!) : true;

  // "thoughts?" under an argument is a question. On its own it is a question
  // about nothing, and the bonus for asking one is what pushed the agent into
  // answering it -- by inventing the subject.
  const subjectless = QUESTION.test(text) && words <= 3 && !input.hasParent;

  // A question the agent was not asked, about something it does not follow, is
  // not a question for it. Awarding the bonus anyway is how a crypto account
  // replied to a stranger's football post: off-topic -30 and asks-a-question
  // +25 landed on exactly the threshold, and exactly the threshold engages.
  const notForUs = !onTopic && !input.directlyAddressed;

  if (QUESTION.test(text) && !subjectless && !notForUs) add('asks a direct question', 25);
  if (subjectless) add('a question with no subject and nothing above it', -25);
  if (input.directlyAddressed) add('addressed to this account', 15);

  const mentions = countMentions(text);
  if (input.policy.ignoreMassTags && mentions >= input.policy.massTagThreshold) {
    // A post tagging eight accounts is addressed to none of them.
    add(`tags ${mentions} accounts at once`, -45);
  }

  if (SPAM.test(spoken)) add('reads as promotional', -50);
  if (GREETING_ONLY.test(spoken)) add('a greeting with nothing in it', -30);

  if (words <= 2 && !QUESTION.test(text)) add('almost no content', -20);
  if (words >= 25) add('a substantial message', 10);

  if (input.relationship?.known) {
    const bump = { NEW: 0, KNOWN: 5, FAMILIAR: 10, REGULAR: 15 }[input.relationship.familiarity];
    if (bump > 0) add(`you know them (${input.relationship.familiarity.toLowerCase()})`, bump);
  }
  if (input.relationship?.disposition === 'FRIENDLY') add('you get on with them', 8);
  if (input.relationship?.disposition === 'CAUTIOUS') add('marked cautious', -15);

  if (input.recentRepliesToPerson >= input.policy.maxRepliesPerPersonPerHour) {
    // Not about the person: an agent answering somebody six times an hour looks
    // like it is arguing, whoever is right.
    add(`already answered them ${input.recentRepliesToPerson} times this hour`, -40);
  } else if (input.recentRepliesToPerson > 0) {
    add('recently answered them', -8);
  }

  if (input.alreadyRepliedInThread && !input.policy.allowThreadFollowUps) {
    add('already replied in this thread', -35);
  }

  // How far into an exchange this is, and how much of it has been the agent.
  //
  // The old rule was a single cliff at maxThreadDepth: nothing at all up to six
  // messages, minus twenty-five at seven. That is not how a conversation runs
  // out. Each turn is a little less worth taking than the one before, so the
  // cost grows with the number of times the agent has already spoken here, and
  // the ceiling stays as the point where it stops regardless.
  const ourTurns = input.ourRepliesInThread ?? (input.alreadyRepliedInThread ? 1 : 0);
  if (input.policy.allowThreadFollowUps && ourTurns > 0) {
    // -6, -18, -36 ... deliberately steeper than linear. Two exchanges is a
    // conversation; five is an agent that will not stop.
    add(
      ourTurns === 1 ? 'answered them once in this thread already' : `answered ${ourTurns} times in this thread already`,
      -6 * ourTurns * ourTurns,
    );
  }
  if (input.threadDepth > input.policy.maxThreadDepth) add('thread has gone on a long way', -25);

  // Somebody saying "makes sense" is not asking for anything. Only counted once
  // the agent is actually in the thread: the same words opening a conversation
  // are a person being friendly, and there is nothing to be the last word of.
  const closing = (CLOSING.test(spoken) || REACTION_ONLY.test(spoken)) && !QUESTION.test(spoken);
  if (closing && (ourTurns > 0 || input.alreadyRepliedInThread)) {
    add('they are closing the conversation, not continuing it', -45);
  }

  if (THANKS.test(spoken) && words <= 6) add('a thank-you that needs no answer', -15);

  // Only for something the agent came across rather than was asked. A crypto
  // agent offering condolences under a stranger's personal post is not being
  // kind, it is being a bot that replies to everything.
  if (gateOnTopic) {
    if (onTopic) add('about something this agent follows', 10);
    else add('nothing to do with what this agent follows', -30);
  }

  return { value: Math.max(0, Math.min(100, Math.round(value))), factors };
}

/** Turns a score into a decision, under the configured strategy. */
export function decideEngagement(input: ReplyValueInput): EngagementVerdict {
  const { value, factors } = replyValue(input);
  const worst = [...factors].sort((a, b) => a.delta - b.delta)[0];
  const best = [...factors].sort((a, b) => b.delta - a.delta)[0];

  // Speaking first is not answering, and the strategies are all about
  // answering. ALWAYS_REPLY means "anything that mentions the agent gets an
  // answer"; applied to a keyword monitor it means replying to every post that
  // happens to contain a word, which is a spam machine with a good persona.
  // QUESTIONS_ONLY is the same trap: any question anywhere gets an approach.
  if (input.unprompted) {
    const outreach = input.outreach;
    if (!outreach?.enabled) {
      return {
        decision: 'IGNORE',
        value,
        reason: 'Nobody asked, and this agent does not approach people unprompted.',
        factors,
      };
    }
    if (value < outreach.minimumValue) {
      return {
        decision: 'IGNORE',
        value,
        reason: `Not worth speaking up unasked (${worst?.label ?? 'low value'}). An approach has to clear ${outreach.minimumValue}, not ${input.policy.minimumReplyValue}.`,
        factors,
      };
    }
    // Worth saying something. Whether it goes out or is shown to a person first
    // is the owner's decision, and REVIEW is the default for exactly this.
    return outreach.mode === 'AUTONOMOUS'
      ? { decision: 'ENGAGE', value, reason: best?.label ?? 'Worth speaking up about.', factors }
      : {
          decision: 'REVIEW',
          value,
          reason: 'Worth speaking up about, but this agent shows an unprompted approach to a person first.',
          factors,
        };
  }

  switch (input.policy.strategy) {
    case 'ALWAYS_REPLY':
      return { decision: 'ENGAGE', value, reason: 'This agent answers every mention.', factors };

    case 'QUESTIONS_ONLY': {
      const asks = QUESTION.test(input.text);
      return asks
        ? { decision: 'ENGAGE', value, reason: 'It asks something, which is what this agent answers.', factors }
        : { decision: 'IGNORE', value, reason: 'This agent only answers questions, and this is not one.', factors };
    }

    case 'NEVER_AUTO_IGNORE':
      // Silence is still a decision, but never one made without a person.
      return value >= input.policy.minimumReplyValue
        ? { decision: 'ENGAGE', value, reason: best?.label ?? 'Worth answering.', factors }
        : {
            decision: 'REVIEW',
            value,
            reason: `Probably not worth answering (${worst?.label ?? 'low value'}), but this agent never stays silent without asking.`,
            factors,
          };

    case 'SELECTIVE':
    default:
      return value >= input.policy.minimumReplyValue
        ? { decision: 'ENGAGE', value, reason: best?.label ?? 'Worth answering.', factors }
        : {
            decision: 'IGNORE',
            value,
            reason: worst?.label
              ? `Not worth answering: ${worst.label}.`
              : 'Nothing here calls for a reply.',
            factors,
          };
  }
}

/**
 * Picks the social act the reply should perform.
 *
 * Rule-based rather than a model call, because this decides what the model is
 * then asked to do — inferring it with a second model call would cost more and
 * explain less.
 */
export function chooseIntent(input: {
  text: string;
  temperature: ConversationTemperature;
  relationship: RelationshipContext | null;
  /** True when the agent holds a position this contradicts. */
  contradictsStance: boolean;
  hasCallback: boolean;
}): IntentDecision {
  const text = input.text.trim();
  const say = (intent: ResponseIntent, reason: string): IntentDecision => ({
    intent,
    reason,
    temperature: input.temperature,
  });

  if (input.contradictsStance) {
    return say('DISAGREE', 'It takes a position the agent has already argued against.');
  }
  if (input.temperature === 'hostile') {
    // Never CHALLENGE into hostility. Escalating is how an agent ends up in a
    // fight on its owner's behalf.
    return say('DEFLECT', 'The message is hostile, so this stays short and does not engage with the heat.');
  }
  if (THANKS.test(text) && text.split(/\s+/).length <= 8) {
    return say('ACKNOWLEDGE', 'They are thanking the agent, which needs acknowledging rather than answering.');
  }
  if (CONFUSED.test(text)) {
    return say('CLARIFY', 'They said they did not follow, so this explains rather than adds.');
  }
  if (DISAGREEMENT.test(text)) {
    return say('DISAGREE', 'They are pushing back, so this responds to the disagreement directly.');
  }
  if (input.temperature === 'joking') {
    return say('JOKE', 'They are joking, and answering a joke earnestly reads badly.');
  }
  if (QUESTION.test(text)) {
    return say('ANSWER', 'They asked something.');
  }
  if (input.hasCallback && input.relationship?.familiarity === 'REGULAR') {
    return say('CALLBACK', 'A regular, and there is something the two of them have discussed before.');
  }
  if (text.split(/\s+/).length >= 30) {
    return say('EXPAND', 'They wrote at length, so this engages with the substance.');
  }
  return say('ACKNOWLEDGE', 'Nothing specific was asked, so this stays brief.');
}

/** How many times this agent answered somebody in the last hour. */
export async function recentRepliesTo(agentId: string, handle: string | null): Promise<number> {
  if (!handle) return 0;
  return actionsRepo.countRecentRepliesToHandle(agentId, handle.replace(/^@+/, ''), 60);
}
