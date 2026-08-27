import type {
  ConversationTemperature,
  EngagementPolicy,
  EngagementVerdict,
  IntentDecision,
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

function countMentions(text: string): number {
  return (text.match(/@[A-Za-z0-9_]{1,15}/g) ?? []).length;
}

/** How the incoming message reads. A signal, not a verdict about the person. */
export function readTemperature(text: string): ConversationTemperature {
  if (HOSTILE.test(text)) return 'hostile';
  if (SARCASM.test(text)) return 'sarcastic';
  if (HUMOUR.test(text)) return 'joking';
  if (CONFUSED.test(text)) return 'confused';
  if (TECHNICAL.test(text)) return 'technical';
  if (QUESTION.test(text)) return 'curious';
  if (THANKS.test(text) || GREETING_ONLY.test(text.trim())) return 'friendly';
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
  policy: EngagementPolicy;
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

  if (QUESTION.test(text)) add('asks a direct question', 25);
  if (input.directlyAddressed) add('addressed to this account', 15);

  const mentions = countMentions(text);
  if (input.policy.ignoreMassTags && mentions >= input.policy.massTagThreshold) {
    // A post tagging eight accounts is addressed to none of them.
    add(`tags ${mentions} accounts at once`, -45);
  }

  if (SPAM.test(text)) add('reads as promotional', -50);
  if (GREETING_ONLY.test(text)) add('a greeting with nothing in it', -30);

  const words = text.replace(/@[A-Za-z0-9_]{1,15}/g, '').split(/\s+/).filter(Boolean).length;
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

  if (input.threadDepth > input.policy.maxThreadDepth) add('thread has gone on a long way', -25);
  if (input.alreadyRepliedInThread && !input.policy.allowThreadFollowUps) {
    add('already replied in this thread', -35);
  }

  if (THANKS.test(text) && words <= 6) add('a thank-you that needs no answer', -15);

  return { value: Math.max(0, Math.min(100, Math.round(value))), factors };
}

/** Turns a score into a decision, under the configured strategy. */
export function decideEngagement(input: ReplyValueInput): EngagementVerdict {
  const { value, factors } = replyValue(input);
  const worst = [...factors].sort((a, b) => a.delta - b.delta)[0];
  const best = [...factors].sort((a, b) => b.delta - a.delta)[0];

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
