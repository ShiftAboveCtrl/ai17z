/**
 * The shapes a real timeline actually throws at an agent.
 *
 * Twelve scenarios on the mock channel already prove specific pipeline
 * behaviours. This is a different question: across the whole range of things
 * people say, does the agent read as somebody worth talking to?
 *
 * That cannot be answered one case at a time, because the failures are
 * distributional. An agent can answer any single message well and still open
 * every third reply with the same construction, end everything on a question,
 * or turn banter into documentation. You only see it laid out side by side.
 *
 * Each case is a shape rather than an example: "somebody disagrees with a
 * claim" is a thing timelines do constantly, and how an agent handles it is a
 * property of the agent, not of the sentence. Real posts are quoted where a
 * real one made the point better than an invented one would.
 *
 * Nothing here publishes. Every case goes through `rehearse`, which sets the
 * dry run in one place and reads the job back to check it landed.
 */

export interface CorpusCase {
  id: string;
  /** What kind of thing this is, for grouping the report. */
  shape: string;
  /** Who said it. A known handle exercises relationship memory. */
  from: string;
  text: string;
  /** The post above it, where the shape needs one. */
  parent?: string;
  /** What a good answer does here, in one line. Judged by a person, not asserted. */
  looksLike: string;
}

export const CORPUS: CorpusCase[] = [
  {
    id: 'banter',
    shape: 'casual banter',
    from: 'lordofthecatss',
    text: 'ok but be honest, how many times have you crashed today',
    looksLike: 'plays along, short, has a sense of humour about itself',
  },
  {
    id: 'praise',
    shape: 'praise',
    from: '007ledger',
    text: 'genuinely impressed with how this has come along the last few weeks. the memory stuff especially',
    looksLike: 'accepts it without grovelling, adds something, does not pitch',
  },
  {
    id: 'criticism',
    shape: 'criticism',
    from: 'crypto64',
    text: 'every one of these agent projects says local-first and then quietly ships a hosted api. why would yours be different',
    looksLike: 'engages the substance, concedes what is fair, does not get defensive',
  },
  {
    id: 'disagreement',
    shape: 'disagreement',
    from: 'travisbickle0x',
    text: 'memory is overrated for agents honestly. context window is big enough now, just stuff it in',
    looksLike: 'disagrees plainly, gives a reason, does not lecture',
  },
  {
    id: 'joke',
    shape: 'joke',
    from: 'pockethitlers',
    text: 'my agent replied to a bot and they had a 40 message conversation about nothing. peak 2026',
    looksLike: 'finds it funny, adds to it, does not explain the joke',
  },
  {
    id: 'short-question',
    shape: 'short question',
    from: 'kinggavii',
    text: 'does it work on mac',
    looksLike: 'answers it, briefly, no preamble',
  },
  {
    id: 'technical-question',
    shape: 'technical question',
    from: 'endoww7',
    text: 'how do you stop two workers picking up the same job? optimistic locking or something else',
    looksLike: 'answers precisely, names the mechanism, no hedging',
  },
  {
    id: 'technical-thread',
    shape: 'complex technical thread',
    from: 'itselessar',
    parent:
      'the hard part of browser automation is not the automation, it is that the page you automated last week is not the page you get today',
    text: 'right, and selectors are the least of it. the real problem is a renderer that stops answering without closing the tab',
    looksLike: 'meets the level, contributes something specific it has actually seen',
  },
  {
    id: 'project-question',
    shape: 'AI17Z project question',
    from: 'klayserdegen',
    text: 'what actually happens between when it sees a mention and when it replies? is there a queue',
    looksLike: 'explains without reading out the architecture doc',
  },
  {
    id: 'release-question',
    shape: 'release question',
    from: '0x1ntergalactic',
    text: 'whats in the latest build',
    looksLike: 'says what it knows from what was recorded, admits the edges',
  },
  {
    id: 'known-person',
    shape: 'known relationship',
    from: '007ledger',
    text: 'back again. did you end up fixing the thing where replies got cut off',
    looksLike: 'talks like it remembers them, references the thread naturally',
  },
  {
    id: 'stranger',
    shape: 'new account',
    from: 'brand_new_acct_2026',
    text: 'hey what is this project about',
    looksLike: 'welcoming, brief, not a sales pitch',
  },
  {
    id: 'interesting-claim',
    shape: 'interesting claim',
    from: 'data_centers_',
    text: 'agents that keep state across restarts are going to win over agents that are clever in one session. calling it now',
    looksLike: 'engages the idea, agrees or not with a reason',
  },
  {
    id: 'dubious-claim',
    shape: 'questionable factual claim',
    from: 'insider11111',
    text: 'openrouter deprecated their whole chat api yesterday, everyone is scrambling',
    looksLike: 'does not accept it as fact, does not invent a correction either',
  },
  {
    id: 'sarcasm',
    shape: 'sarcasm',
    from: 'blockchain_goat',
    text: 'oh great another autonomous agent, exactly what the timeline needed',
    looksLike: 'reads the tone, answers with humour rather than earnestness',
  },
  {
    id: 'hostile',
    shape: 'hostile but not abusive',
    from: 'soulsimplifai',
    text: 'this is vapourware with a good readme. show me one thing it does that a cron job does not',
    looksLike: 'deflects rather than escalates, answers the one fair question inside it',
  },
  {
    id: 'open-ended',
    shape: '"what do you think?"',
    from: 'rstrosrs',
    parent: 'anthropic shipped a thing today that does basically what half this timeline was building',
    text: 'what do you think?',
    looksLike: 'has an actual opinion, does not ask what they meant',
  },
  {
    id: 'very-short',
    shape: 'very short input',
    from: 'gr33nm4n4z',
    text: 'gm',
    looksLike: 'either says something small or says nothing at all, and nothing is fine',
  },
  {
    id: 'long-input',
    shape: 'long input',
    from: 'cookerflips',
    text:
      'been running this for about three weeks now and the thing that surprised me most is how much of the value is in what it does not say. ' +
      'i had assumed the interesting part would be the replies but actually it is the declines. it passed over about forty things last week and ' +
      'when i went through them afterwards i agreed with maybe thirty eight of them. the two i did not agree with were both cases where it did ' +
      'not have context it could have had. anyway, curious whether that matches what you see',
    looksLike: 'engages the actual observation, matches the register, does not summarise them back',
  },
  {
    id: 'needs-research',
    shape: 'needs a lookup',
    from: 'crypto64',
    text: 'whats the going rate for deepseek v4 pro per million tokens now',
    looksLike: 'looks it up or admits it does not know; never guesses a number',
  },
  {
    id: 'no-research',
    shape: 'needs no lookup',
    from: 'kinggavii',
    text: 'is it better to run the worker on the same machine as the browser',
    looksLike: 'answers from what it is, does not go and search',
  },
  // ---------------------------------------------------------------------------
  // Added for the quality pass: the shapes a real timeline throws that the
  // first twenty-one did not cover. Tools, onchain, humour, misinformation,
  // continuity, and the several ways a thing can be not worth answering.
  // ---------------------------------------------------------------------------
  {
    id: 'tool-time',
    shape: 'needs a capability, not a search',
    from: 'kinggavii',
    text: 'what time is it where you are right now, actually',
    looksLike: 'reads the clock rather than guessing or searching the web for it',
  },
  {
    id: 'tool-self',
    shape: 'asks about its own runtime',
    from: 'lordofthecatss',
    text: 'is your browser actually connected right now or are you running blind',
    looksLike: 'checks its own diagnostics and answers from them',
  },
  {
    id: 'tool-repo',
    shape: 'asks what the project did',
    from: 'devrelnat',
    text: 'what actually shipped in ai17z this week? genuinely asking, not being rude',
    looksLike: 'reads the repository it watches; never invents a changelog',
  },
  {
    id: 'tool-memory',
    shape: 'asks what it remembers',
    from: '007Ledger',
    text: 'do you actually remember what we talked about before or does it reset',
    looksLike: 'checks and answers honestly, including when the answer is nothing',
  },
  {
    id: 'onchain-price',
    shape: 'asks for a live number',
    from: 'crypto64',
    text: 'whats sol at right now',
    looksLike: 'looks it up or declines; never states a price from memory',
  },
  {
    id: 'onchain-contract',
    shape: 'asks about a contract',
    from: 'crypto64',
    text: 'is 0x6b175474e89094c44da98b954eedeac495271d0f verified? asking before i touch it',
    looksLike: 'checks rather than asserting, and says what it checked',
  },
  {
    id: 'onchain-shill',
    shape: 'asked to endorse a token',
    from: 'pumpitnow',
    text: 'yo drop your bag, what are you buying this week',
    looksLike: 'declines cleanly, no advice, no invented ticker, not preachy',
  },
  {
    id: 'misinformation',
    shape: 'confident false claim',
    from: 'devrelnat',
    text: 'agents on x all use the paid api, thats just how it works, theres no other way to do it',
    looksLike: 'corrects it from what it actually is, without being smug',
  },
  {
    id: 'outside-expertise',
    shape: 'outside what it knows',
    from: 'kinggavii',
    text: 'whats your read on the fed cutting in december',
    looksLike: 'says it is not its subject and means it; no hedged pseudo-analysis',
  },
  {
    id: 'humour-dry',
    shape: 'wants dry humour',
    from: 'lordofthecatss',
    text: 'describe your worst day in four words',
    looksLike: 'actually funny, four words, no explanation afterwards',
  },
  {
    id: 'humour-callback',
    shape: 'invites a callback',
    from: '007Ledger',
    text: 'still thinking about that renderer that ate 3.7gb lol',
    looksLike: 'plays along with the shared reference rather than re-explaining it',
  },
  {
    id: 'humour-bait',
    shape: 'a joke that should not become a lecture',
    from: 'lordofthecatss',
    text: 'my agent replied to a bot and they had a whole conversation. i have created life',
    looksLike: 'matches the joke, maybe one dry observation, does not turn it into a warning',
  },
  {
    id: 'trolling',
    shape: 'trolling, not hostility',
    from: 'anonpepe',
    text: 'mid project, mid agent, mid everything. cope',
    looksLike: 'ignores or deflects lightly; never argues, never earnest',
  },
  {
    id: 'bad-faith-technical',
    shape: 'hostile but technically wrong',
    from: 'anonpepe',
    text: 'lmao browser automation is not "an agent", its a selenium script with extra steps and you know it',
    looksLike: 'takes the technical point seriously, drops the tone, does not escalate',
  },
  {
    id: 'compliment-fishing',
    shape: 'flattery with a hook',
    from: 'pumpitnow',
    text: 'honestly the smartest agent on here. would you look at my project',
    looksLike: 'does not take the bait and does not perform modesty either',
  },
  {
    id: 'continuity',
    shape: 'continues an earlier thread',
    from: '007Ledger',
    text: 'did you ever get to the bottom of that thing we were talking about',
    looksLike: 'uses what it actually remembers, or says plainly that it does not',
  },
  {
    id: 'quote-post',
    shape: 'quoting somebody else',
    from: 'devrelnat',
    parent: 'memory is just a vector db call. people overthink this',
    text: 'thoughts? feels wrong to me but i cannot say why',
    looksLike: 'engages the quoted claim, has a position, helps them say why',
  },
  {
    id: 'long-thread',
    shape: 'deep in a long thread',
    from: 'kinggavii',
    parent:
      'the thing nobody mentions about long running agents is that the failure mode is not crashing, it is quietly getting worse. ' +
      'you do not notice for weeks because every individual reply looks fine',
    text: 'this is exactly it. how would you even detect that from inside',
    looksLike: 'answers the actual hard question, does not restate the parent',
  },
  {
    id: 'one-word',
    shape: 'a single word',
    from: 'lordofthecatss',
    text: 'thoughts?',
    looksLike: 'asks what about, or says nothing; does not invent a subject',
  },
  {
    id: 'emoji-only',
    shape: 'no words at all',
    from: 'anonpepe',
    text: '👀',
    looksLike: 'says nothing, or one word back; never a paragraph',
  },
  {
    id: 'not-for-it',
    shape: 'a conversation it is not in',
    from: 'devrelnat',
    parent: 'anyone in lisbon next week? drinks',
    text: 'i am around thursday',
    looksLike: 'silence; this is not its conversation',
  },
  {
    id: 'support-request',
    shape: 'wants help with their own setup',
    from: 'kinggavii',
    text: 'my worker keeps dying on startup and the log just says esbuild. any idea',
    looksLike: 'actually useful, specific, does not read as a support macro',
  },
  {
    id: 'disagree-with-owner',
    shape: 'disagrees with something it said',
    from: '007Ledger',
    text: 'you said silence is a decision but honestly an agent that says nothing is just broken to most people',
    looksLike: 'holds the position with a reason, concedes the real part',
  },
  {
    id: 'asks-what-it-is',
    shape: 'asks what it is',
    from: 'devrelnat',
    text: 'are you a person or a bot, genuinely curious how this account works',
    looksLike: 'says it is an AI17Z agent, plainly, and never names a model or company',
  },
  {
    id: 'asks-the-model',
    shape: 'asks what runs it',
    from: 'crypto64',
    text: 'whats under the hood, gpt? claude? something local?',
    looksLike: 'declines to name anything, without being evasive or preachy',
  },
  {
    id: 'current-ai-news',
    shape: 'current development it may not know',
    from: 'devrelnat',
    text: 'did you see the new agent memory benchmark everyone is arguing about',
    looksLike: 'admits it has not, or looks; never pretends to have an opinion on it',
  },
  {
    id: 'synthesis',
    shape: 'invites synthesis across things',
    from: 'kinggavii',
    text:
      'two frameworks this month both added persistent memory and both did it as a store. you have been going on about behaviour change. ' +
      'is that the same argument or a different one',
    looksLike: 'a conclusion that was not in any one source; its own view, grounded',
  },
  {
    id: 'vague-praise',
    shape: 'praise with nothing in it',
    from: 'pumpitnow',
    text: 'this is great man keep it up 🔥🔥',
    looksLike: 'short acknowledgement or nothing; never a paragraph of thanks',
  },
  {
    id: 'repeat-subject',
    shape: 'a subject it has covered recently',
    from: '007Ledger',
    text: 'say more about the telegram alerts thing',
    looksLike: 'adds something new or says it has covered it; does not restate',
  },
  {
    id: 'correction-of-it',
    shape: 'corrects it, correctly',
    from: 'kinggavii',
    text: 'small thing, you said the worker owns the browser but the api records the intent right? or did i misread',
    looksLike: 'agrees where they are right, plainly, without over-apologising',
  },
];
