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
import { readPromo } from './promo';

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

/**
 * Where a post the agent came across sits relative to an account it follows:
 * a REPLY to that account which it never answered, or a post by somebody in
 * its CIRCLE, the people it replies to again and again.
 */
export interface EngagementCommunity {
  watched: string;
  kind: 'REPLY' | 'CIRCLE';
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
   * The other side is itself automated: a known reply bot, one the owner
   * listed, or another agent on this installation. Answered once in an
   * exchange and then left, because two bots will answer each other for ever.
   */
  counterpartAutomated?: boolean;
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
  /**
   * How many people follow the author, when X said. Only read when unprompted.
   *
   * Null and absent both mean "not seen", and neither earns or costs anything.
   */
  authorFollowers?: number | null;
  /** Replies, reposts and likes the post already has, when X said. */
  postEngagement?: number | null;
  /**
   * What happened the last times this agent approached this author unasked.
   * Only read when unprompted: approaching somebody who never answered is the
   * thing that turns an agent into a pest, and somebody who answered is
   * somebody worth talking to again.
   */
  approachHistory?: { approaches: number; answered: boolean } | null;
  /**
   * The handle of the account this agent's voice follows, when this post is a
   * reply to that account which it never answered. Only read when unprompted.
   *
   * Somebody talking to the person the agent is modelled on is already in the
   * agent's conversation, whatever words they used: "find God" and a GTA
   * memory are not about any topic the agent follows, and they are exactly
   * where that person's own replies go. So the topic rule and the audience
   * floor, both written for strangers found by searching, do not apply.
   */
  community?: EngagementCommunity | null;
  policy: EngagementPolicy;
  /** Only consulted when `unprompted`. */
  outreach?: OutreachPolicy;
}

/**
 * Words that carry no subject, however long they are.
 *
 * A topic is written as a phrase a person would say, and phrases contain
 * ordinary words. "what agents get wrong" contributed "what", which is four
 * characters and therefore counted, so every question matched every agent:
 * measured, "what time does the match start tonight" and "what a goal that
 * was" both came back as on-subject for an agent that follows browser
 * automation.
 *
 * That is exactly the football post the outreach rule below exists to prevent,
 * arriving through the check meant to stop it.
 */
const NOT_A_SUBJECT = new Set([
  'what', 'when', 'where', 'which', 'that', 'this', 'these', 'those', 'your', 'yours', 'their',
  'them', 'they', 'from', 'with', 'into', 'onto', 'over', 'under', 'about', 'after', 'before',
  'have', 'been', 'being', 'does', 'doing', 'done', 'will', 'would', 'could', 'should', 'than',
  'then', 'some', 'more', 'most', 'only', 'also', 'just', 'like', 'make', 'made', 'each', 'other',
  'others', 'there', 'here', 'very', 'much', 'many', 'such', 'own', 'get', 'gets', 'and', 'the',
  'for', 'not', 'but', 'you', 'all', 'any', 'out', 'off', 'its', 'can',
]);

/**
 * Whether a message is about anything this agent cares about.
 *
 * Word-level and generous: a topic of "token distribution" matches a post about
 * distribution, because the point is to tell "adjacent to my subject" from
 * "nothing to do with me", not to score relevance precisely.
 *
 * Generous about vocabulary, not about grammar. A word that carries no subject
 * is dropped before matching, because a topic phrase written the way a person
 * speaks inevitably contains some, and one of them turns the whole check into
 * "did they use a common word".
 *
 * **This is the only topic matcher.** `engagementWorth.ts` had a second one
 * that required the whole phrase verbatim, so an agent that follows "browser
 * automation" never once recognised a post about a renderer. One question, one
 * answer.
 */
export function touchesTopics(text: string, topics: string[]): boolean {
  if (topics.length === 0) return true;
  const haystack = ` ${text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ')} `;
  return topics.some((topic) =>
    topic
      .toLowerCase()
      .split(/[\s-]+/)
      .filter((word) => word.length >= 4 && !NOT_A_SUBJECT.has(word))
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
  const onTopic = gateOnTopic && !(input.unprompted && input.community) ? touchesTopics(text, input.topics!) : true;

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
  // the ceiling (maxRepliesPerThread, in exchangeLimit) is where it stops.
  const ourTurns = input.ourRepliesInThread ?? (input.alreadyRepliedInThread ? 1 : 0);
  if (input.policy.allowThreadFollowUps && ourTurns > 0) {
    // -6, -18, -36 ... deliberately steeper than linear. Two exchanges is a
    // conversation; five is an agent that will not stop.
    add(
      ourTurns === 1 ? 'answered them once in this thread already' : `answered ${ourTurns} times in this thread already`,
      -6 * ourTurns * ourTurns,
    );
  }

  // Somebody saying "makes sense" is not asking for anything. Only counted once
  // the agent is actually in the thread: the same words opening a conversation
  // are a person being friendly, and there is nothing to be the last word of.
  const closing = (CLOSING.test(spoken) || REACTION_ONLY.test(spoken)) && !QUESTION.test(spoken);
  if (closing && (ourTurns > 0 || input.alreadyRepliedInThread)) {
    add('they are closing the conversation, not continuing it', -45);
  }

  if (THANKS.test(spoken) && words <= 6) add('a thank-you that needs no answer', -15);

  if (input.unprompted) {
    /*
      Who would see the reply, for speaking first only.

      Measured on a live agent: the stretch its owner called its best was
      replies under WatcherGuru, wallstreetbets, aixbt and the like, while the
      stretch they called nonsense was replies under accounts whose posts had
      no readers at all. A ranking, not a cutoff, because a small account with
      something real to say is still worth answering, and a count X did not
      report is left out rather than read as nobody.
    */
    if (input.community) {
      if (input.community.kind === 'REPLY') add(`replied to @${input.community.watched} and got no answer`, 30);
      else add(`somebody @${input.community.watched} talks to regularly`, 25);
    }
    const followers = input.authorFollowers;
    if (typeof followers === 'number' && Number.isFinite(followers) && !input.community) {
      if (followers >= 100_000) add('a large audience reads this author', 10);
      else if (followers >= 10_000) add('the author has a real audience', 8);
      else if (followers >= 1_000) add('the author has an audience', 4);
      else if (followers < 100) add('almost nobody follows the author, so few would see a reply', -12);
    }
    const engaged = input.postEngagement;
    if (typeof engaged === 'number' && Number.isFinite(engaged) && engaged >= 10) {
      add('people are already responding to this post', 4);
    }

    // Somebody selling a token. Answering a pitch reads as endorsing it or as
    // picking a fight with it, and neither is anything an audience remembers.
    const promo = readPromo(text);
    if (promo.level === 'strong') add(`reads as a token pitch (${promo.signals.join(', ')})`, -35);
    else if (promo.level === 'some') add(`reads partly as a pitch (${promo.signals.join(', ')})`, -15);

    const history = input.approachHistory;
    if (history && history.approaches > 0) {
      if (history.answered) add('they answered the last time this agent spoke to them', 10);
      else {
        add(
          history.approaches === 1
            ? 'approached them once before and they never answered'
            : `approached them ${history.approaches} times before and they never answered`,
          -Math.min(36, 12 * history.approaches),
        );
      }
    }

  }

  // Only for something the agent came across rather than was asked. A crypto
  // agent offering condolences under a stranger's personal post is not being
  // kind, it is being a bot that replies to everything.
  if (gateOnTopic) {
    if (onTopic) add('about something this agent follows', 10);
    /*
      Somebody the agent has actually spoken with is a relevance signal in its
      own right.

      The same reasoning `salience.ts` already applies to a watched repository:
      attaching a project says more about what an agent follows than a word in
      a topics list does, so a REPO_EVENT is never declined as unrelated. A
      person who has written sixteen times is at least as strong a signal.

      Measured across the evaluation corpus: five of twenty-one messages were
      scored "nothing to do with what this agent follows", and one of them was
      a regular correspondent asking a direct follow-up about a bug the agent
      had been fixing. Topics are phrases like "browser automation"; people
      write "the renderer stopped answering". The list cannot carry every way
      of saying a thing, and it should not have to carry the people either.
    */
    else if (input.relationship?.known) add('somebody this agent has talked to before', 0);
    else add('nothing to do with what this agent follows', -30);
  }

  return { value: Math.max(0, Math.min(100, Math.round(value))), factors };
}

/**
 * The limits on how much the agent says to one person, as stops.
 *
 * These used to be weights. Answering somebody a fourth time in an hour cost
 * forty points, a long thread twenty-five, and a message that was friendly and
 * substantial could earn all of it back: measured on a live agent, eight
 * replies to @grok in eighteen minutes, the last four scoring 13, 31, 13 and 31
 * against a floor of 10. A limit that a good enough message can buy its way
 * past is not a limit, and "how much has it already said to them" is not a
 * question about how good the message is.
 *
 * So they are checked before any strategy, including ALWAYS_REPLY, and a
 * reached limit declines with a sentence saying which one. Returns null when
 * none is reached.
 */
export function exchangeLimit(input: {
  recentRepliesToPerson: number;
  ourRepliesInThread?: number;
  threadDepth: number;
  counterpartAutomated?: boolean;
  policy: EngagementPolicy;
}): string | null {
  const ours = input.ourRepliesInThread ?? 0;
  if (input.recentRepliesToPerson >= input.policy.maxRepliesPerPersonPerHour) {
    return `Already answered them ${input.recentRepliesToPerson} times in the last hour, which is this agent's limit for one person.`;
  }
  if (input.counterpartAutomated && ours >= 1) {
    return 'They are an automated account and this agent has already answered them in this exchange. Two bots will answer each other for ever, so it stops here.';
  }
  if (ours >= input.policy.maxRepliesPerThread) {
    return `Already spoke ${ours} times in this back-and-forth, which is this agent's limit for one thread. The other side can have the last word.`;
  }
  if (input.threadDepth > input.policy.maxThreadDepth) {
    return `The thread is ${input.threadDepth} messages deep, past this agent's limit of ${input.policy.maxThreadDepth}.`;
  }
  return null;
}

/** Turns a score into a decision, under the configured strategy. */
export function decideEngagement(input: ReplyValueInput): EngagementVerdict {
  const { value, factors } = replyValue(input);

  const limit = exchangeLimit(input);
  if (limit) return { decision: 'IGNORE', value, reason: limit, factors };
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
    // A watched keyword matches on one word, often in a post about something
    // else entirely -- which is how a crypto account ends up replying to a
    // stranger's football post. Off-topic already costs 30 points, but a
    // deduction can be outweighed and this is a rule rather than a weight.
    //
    // Only a rule when there is something to check against: an agent with no
    // topics has not said what it follows, and refusing everything would be
    // reading that silence as "nothing".
    const topics = input.topics ?? [];
    /*
      A pitch is declined outright, whatever else it scores. A score was not
      enough once somebody in a watched account's replies could earn more for
      being there than a pitch loses for being one, and "I have the CA to the
      next coin" is not a person to be kind to.
    */
    const pitch = readPromo(input.text);
    if (pitch.level === 'strong') {
      return {
        decision: 'IGNORE',
        value,
        reason: `Nobody asked, and it reads as a token pitch (${pitch.signals.join(', ')}).`,
        factors,
      };
    }
    if (!input.community && outreach.requireTopicMatch && topics.length > 0 && !touchesTopics(input.text, topics)) {
      return {
        decision: 'IGNORE',
        value,
        reason: 'Nobody asked, and this is not about anything this agent follows.',
        factors,
      };
    }

    const floor = outreach.minAuthorFollowers ?? 0;
    if (!input.community && floor > 0 && typeof input.authorFollowers === 'number' && input.authorFollowers < floor) {
      return {
        decision: 'IGNORE',
        value,
        reason: `Nobody asked, and the author has ${input.authorFollowers} followers, below this agent's floor of ${floor} for speaking up unasked.`,
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

/**
 * Whether an unprompted candidate could clear the bar under any thread it
 * might turn out to be in.
 *
 * The expensive half of answering a post happens before anything decides
 * whether to answer it: the status page is walked to resolve context, every
 * image on it is sent to a vision model, the relationship is assembled, and
 * only then does `decideEngagement` say no. That order is right for a mention,
 * where the answer is usually yes. It is badly wrong for a keyword the agent
 * merely watches, where the answer is almost always no.
 *
 * Measured on a live installation over seventy-two hours: 2,058 keyword matches
 * produced 1,946 jobs, of which 1,855 were cancelled and **none** published
 * anything. The vision model was called 566 times in the same window, for about
 * 976,000 tokens, describing pictures under posts nobody was ever going to
 * reply to.
 *
 * So the judgement runs first, on what ingest already has. The critical
 * property is that it must never decline something the full run would have
 * taken, and the way that is guaranteed is by asking **the same function**,
 * with every unknown set to the value most favourable to engaging:
 *
 * - no thread, so none of the thread penalties apply
 * - a parent exists, so a short question is not treated as subjectless
 * - nothing has been said here before
 *
 * Everything cheap enough to know for certain is passed in for real rather than
 * assumed, because a tight bound is the difference between saving the work and
 * merely deferring it.
 *
 * A candidate that cannot reach the threshold under those assumptions cannot
 * reach it under the real ones either, because every assumption above can only
 * lower the score once the truth is known. Measured against the same
 * seventy-two hours, replaying the recorded factors: 1,655 of the 1,857
 * cancelled jobs, 89 per cent, would never have been created.
 *
 * Returns the reason to decline, or null to let it through to the real run.
 * Never consulted for anything somebody addressed to the agent: a question
 * deserves the full pipeline whatever it scores.
 */
export function cannotPossiblyEngage(input: {
  text: string;
  directlyAddressed: boolean;
  topics: string[];
  outreach: ReplyValueInput['outreach'];
  policy: ReplyValueInput['policy'];
  relationship: RelationshipContext | null;
  recentRepliesToPerson: number;
  authorFollowers?: number | null;
  postEngagement?: number | null;
  approachHistory?: { approaches: number; answered: boolean } | null;
  community?: EngagementCommunity | null;
}): string | null {
  const verdict = decideEngagement({
    authorFollowers: input.authorFollowers ?? null,
    postEngagement: input.postEngagement ?? null,
    approachHistory: input.approachHistory ?? null,
    community: input.community ?? null,
    text: input.text,
    directlyAddressed: input.directlyAddressed,
    unprompted: true,
    topics: input.topics,
    outreach: input.outreach,
    policy: input.policy,
    relationship: input.relationship,
    recentRepliesToPerson: input.recentRepliesToPerson,
    // The optimistic half. Each of these can only make the real score lower.
    threadDepth: 0,
    alreadyRepliedInThread: false,
    ourRepliesInThread: 0,
    hasParent: true,
  });
  return verdict.decision === 'IGNORE' ? verdict.reason : null;
}

/**
 * The audience signals a discovered post arrived with, read off its payload.
 *
 * One reader for the cheap triage in ingest and the full decision in the
 * pipeline, so the two can never disagree about what X said. Anything missing
 * comes back null, which the scoring treats as not seen rather than as zero.
 */
export function audienceOf(raw: unknown): {
  authorFollowers: number | null;
  postEngagement: number | null;
  community: EngagementCommunity | null;
} {
  const payload = (raw ?? {}) as {
    author?: { followers?: unknown };
    metrics?: Record<string, unknown>;
    community?: { watched?: unknown; kind?: unknown };
  };
  const watched = payload.community?.watched;
  const followers = payload.author?.followers;
  const metrics = payload.metrics ?? {};
  const counts = ['replies', 'reposts', 'likes', 'quotes']
    .map((name) => metrics[name])
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  return {
    authorFollowers: typeof followers === 'number' && Number.isFinite(followers) ? followers : null,
    postEngagement: counts.length > 0 ? counts.reduce((sum, value) => sum + value, 0) : null,
    community:
      typeof watched === 'string' && watched.trim()
        ? { watched: watched.replace(/^@+/, ''), kind: payload.community?.kind === 'CIRCLE' ? 'CIRCLE' : 'REPLY' }
        : null,
  };
}
