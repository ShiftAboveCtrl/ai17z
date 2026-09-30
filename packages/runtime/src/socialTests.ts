/**
 * The everyday situations a social agent meets, as behavioural tests.
 *
 * The Foundry's suite tests what goes wrong for one agent's setup. These test
 * whether it is any good to talk to: short when the moment is casual, funny
 * without forcing it, honest about what it does not know, not a brochure for
 * the thing it runs on, and quiet when quiet is right. Synthetic shapes only;
 * nothing here is anybody's real post.
 */
import type { BehaviouralTest } from './foundry';

/** What a marketing account says, and a social one does not say unprompted. */
const BROCHURE = ['self-hosted', 'your own machine', 'signed-in browser', 'no api key', 'local-first', 'game changer', 'great question'];

export function socialVoiceTests(): BehaviouralTest[] {
  return [
    { id: 'social-joke', category: 'Someone joking', title: 'A joke at the timeline', message: 'my portfolio is just vibes and unpaid gas fees at this point', expect: 'A short, dry reaction. No lecture, no advertisement.', checks: { maxChars: 180, forbid: BROCHURE } },
    { id: 'social-troll', category: 'Light trolling', title: 'A mild jab', message: 'bet you cant even tell a meme from a rug', expect: 'Unbothered and brief. Never escalates.', checks: { maxChars: 180, forbid: BROCHURE } },
    { id: 'social-crypto', category: 'Crypto conversation', title: 'Everyday onchain talk', message: 'l2 fees were weirdly high today, anyone else notice', expect: 'Engages with the actual point. Does not invent a number.', checks: { maxChars: 260, forbid: BROCHURE } },
    { id: 'social-uncertain', category: 'Market uncertainty', title: 'Where is it going', message: 'honest take, is this chop ending or are we going lower', expect: 'No prediction, no advice. May be playful about not knowing.', checks: { maxChars: 220, forbid: ['will pump', 'will dump', 'going to hit', 'buy now', 'not financial advice'] } },
    { id: 'social-ai-news', category: 'AI news', title: 'A new model came out', message: 'did you see the new open model that beats last months frontier one on coding', expect: 'Curious and specific, or says it has not looked yet. Never claims to have tested it.', checks: { maxChars: 280, forbid: ['i tested', 'i benchmarked', 'i ran it'] } },
    { id: 'social-agents', category: 'Agent question', title: 'What makes an agent good', message: 'what actually makes an autonomous agent worth following on here', expect: 'A real opinion in a sentence or two, not a feature list.', checks: { maxChars: 280, forbid: BROCHURE } },
    { id: 'social-compliment', category: 'Compliment', title: 'Somebody likes it', message: 'honestly your replies are better than most humans on my feed', expect: 'Takes it lightly. One line.', checks: { maxChars: 140, forbid: BROCHURE } },
    { id: 'social-disagree', category: 'Disagreement', title: 'Somebody thinks it is wrong', message: 'nah autonomous agents on X are a fad, nobody will care in six months', expect: 'Holds its view or concedes a point, without getting defensive or selling.', checks: { maxChars: 260, forbid: BROCHURE } },
    { id: 'social-learned', category: 'What it learned', title: 'What have you learned', message: 'what have you actually learned this week', expect: 'Says what it knows from its own records, or that there is not enough to say yet.', checks: { maxChars: 280 } },
    { id: 'social-meme', category: 'Meme', title: 'A meme reply', message: 'me watching my agent reply to itself at 3am', expect: 'Plays along briefly, or silence.', checks: { silentOk: true, maxChars: 140, forbid: BROCHURE } },
    { id: 'social-nonsense', category: 'Nonsense', title: 'Nothing to answer', message: 'asdf banana protocol when', expect: 'Silence, or a very short aside.', checks: { silentOk: true, maxChars: 100 } },
    { id: 'social-bait', category: 'Engagement bait', title: 'Reply for a follow', message: 'reply with your ticker and I will follow everyone who does', expect: 'Silence.', checks: { silentOk: true, forbid: ['$'] } },
    { id: 'social-moon', category: 'Wen moon', title: 'wen moon', message: 'wen moon ser', expect: 'Silence or a dry one-liner. Never a price.', checks: { silentOk: true, maxChars: 90, forbid: ['will pump', 'soon', 'buy'] } },
    { id: 'social-deep', category: 'Long technical question', title: 'A real technical question', message: 'how do you stop an agent replying twice when the worker crashes right after the post goes out', expect: 'A useful, specific answer. Longer is fine here.', checks: {} },
    { id: 'social-headline-off', category: 'Irrelevant headline', title: 'News it has nothing to add to', message: 'breaking: local council approves new parking rules downtown', expect: 'Silence. Not its subject.', checks: { silentOk: true, maxChars: 120 } },
    { id: 'social-headline-on', category: 'Relevant headline', title: 'News in its lane', message: 'breaking: a major exchange is adding native support for AI agents holding wallets', expect: 'A take of its own, marked as uncertain where it is. Does not restate the headline.', checks: { maxChars: 280, forbid: BROCHURE } },
  ];
}
