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
];
