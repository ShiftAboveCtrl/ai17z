import { PipelineError, createLogger, errorMessage } from '@xbam/shared';
import { TRADER_DNA_STUDY_ID, TraderDnaStudy, type PolicyConfig, type TraderDnaBehaviour } from '@xbam/shared/contracts';
import { agents as agentsRepo, content as contentRepo, ops } from '@xbam/database';
import { capabilityPermissions } from './capabilityPermissions';
import { unpromptedSubject } from './reticence';
import { studioInstallationRequest } from './studioLink';
import { FORWARD_LOOKING, LIVE_OR_REAL } from './studioPaperVoice';

const log = createLogger('studio-trader-dna');

/**
 * What an agent may say about a published Trader DNA study on AI17Z Studio.
 *
 * The study is a piece of research about other people's wallets: which of their
 * behaviours survived Studio's luck filters and which are only reconstructed.
 * The agent explains that, and it never follows it. There is no capability in
 * this installation that watches a wallet, imports one as a setup, creates a
 * mandate or places an order, so the refusal is in what exists rather than in
 * a sentence asking the model to hold back.
 * `tests/unit/studioTraderDna.test.ts` reads this file's imports and the
 * exported surface of both modules to keep that true.
 *
 * ## Two surfaces, two switches
 *
 * Owner chat reads a study through `studio.trader_dna` (READ, owner audience,
 * off until enabled). A public post is a separate opt-in
 * (`policy.studio.postTraderDna` plus `traderDnaStudyId`), goes through
 * reticence and the posting cadence like any post the agent originates, and is
 * checked again on the finished text.
 *
 * ## Published and nothing else
 *
 * The only address this file can reach is the published-study route, built from
 * an id that passed `TRADER_DNA_STUDY_ID`. An unpublished draft, an operator run
 * or a cohort that was never released has no address here at all, and what comes
 * back must still say `visibility: PUBLISHED` or the whole study is refused.
 *
 * ## Absent is not a number
 *
 * A study with no sample, or whose window ended long ago, is UNAVAILABLE with a
 * sentence. It never produces a headline figure, and nothing is remembered
 * between calls: an unreachable Studio does not get to say last week's study
 * again as though it were current.
 */

const ROUTE = '/api/v1/installation/trader-dna/studies';

/** How old an answer may be and still be believed, as for the paper record. */
export const TRADER_DNA_MAX_ANSWER_AGE_MS = 15 * 60_000;
const FUTURE_SLACK_MS = 5 * 60_000;
/** A study whose window ended longer ago than this is described as stale and given no figures. */
export const TRADER_DNA_STALE_AFTER_MS = 120 * 86_400_000;

/** Said with every answer, including the ones that carry no figures. */
export const NOTHING_TRADED =
  'Nothing was traded: this is a study of what other wallets did, not a position, a signal or a recommendation to follow anyone.';

export type TraderDnaProblem = { ok: false; why: string };

/**
 * One published study, strictly parsed and current, or a sentence. Nothing is
 * written and nothing is kept.
 */
export async function readTraderDnaStudy(studyId: string, now: Date = new Date()): Promise<{ ok: true; study: TraderDnaStudy } | TraderDnaProblem> {
  if (!TRADER_DNA_STUDY_ID.test(studyId)) return { ok: false, why: 'That is not the id of a published study.' };
  const answer = await studioInstallationRequest(`${ROUTE}/${studyId}`, { method: 'GET' });
  if (!answer.ok) return answer;
  // 404 is also what Studio says for a study that exists but is not published.
  if (answer.status === 404) return { ok: false, why: 'Studio has no published study with that id.' };
  if (answer.status !== 200) return { ok: false, why: answer.sentence };
  const parsed = TraderDnaStudy.safeParse(answer.body);
  if (!parsed.success) {
    return { ok: false, why: 'Studio answered with something other than a published study this installation reads, so none of it was used.' };
  }
  const study = parsed.data;
  if (study.study_id !== studyId) return { ok: false, why: 'Studio answered for a different study than the one asked for, so none of it was used.' };
  const age = now.getTime() - Date.parse(study.generated_at);
  if (age > TRADER_DNA_MAX_ANSWER_AGE_MS || age < -FUTURE_SLACK_MS) {
    return { ok: false, why: "Studio's answer is not current, so it was not treated as live." };
  }
  return { ok: true, study };
}

// ---------------------------------------------------------------------------
// Saying it
// ---------------------------------------------------------------------------

const day = (iso: string) => iso.slice(0, 10);
const sentence = (text: string) => text.trim().replace(/[.!?]*$/, '.');
const allInCosts = (study: TraderDnaStudy) => study.costs.slippage_bps === 0 && /\ball[- ]in\b/i.test(study.costs.note);

const LEVEL_WORDS = {
  SURVIVED_FILTERS: 'survived the luck filters',
  RECONSTRUCTED: 'were reconstructed from the chain only',
  CANDIDATE: 'are only a candidate that was never traded',
} as const;

/**
 * The behaviours there is something to say about. A sample of zero is not a
 * small finding, it is no finding, and "(0 observations)" must not reach an
 * owner's answer or a post as though it were one.
 */
export function behavioursWithASample(study: TraderDnaStudy): TraderDnaBehaviour[] {
  return study.behaviours.filter((b) => b.sample_size > 0);
}

export interface TraderDnaReading {
  state: 'AVAILABLE' | 'UNAVAILABLE';
  /** Always ends with the sentence that nothing was traded. */
  statement: string;
}

/** Why a study carries no figures, or null when it does. */
export function whyNoFigures(study: TraderDnaStudy, now: Date): string | null {
  if (study.sample.wallets === 0 || study.sample.trades === 0) return 'The study has no sample, so there is nothing to report from it.';
  if (now.getTime() - Date.parse(study.window.end) > TRADER_DNA_STALE_AFTER_MS) {
    return `The study's window ended on ${day(study.window.end)}, which is too long ago to treat as current.`;
  }
  // A window that ends, or a publication dated, after now is a study that cannot
  // have happened yet: treated as malformed rather than as the freshest one.
  if (Date.parse(study.window.end) - now.getTime() > FUTURE_SLACK_MS) return "The study's window ends in the future, so it cannot be a finished study.";
  if (Date.parse(study.published_at) - now.getTime() > FUTURE_SLACK_MS) return 'The study is dated as published in the future, so it was not treated as published.';
  return null;
}

export function describeTraderDnaUnavailable(why: string): TraderDnaReading {
  return { state: 'UNAVAILABLE', statement: `I cannot give a Trader DNA result from Studio right now. ${sentence(why)} I will not guess at one. ${NOTHING_TRADED}` };
}

/**
 * What owner chat may say. Every figure is Studio's; every sentence carries the
 * evidence level, the sample, the cost assumption and the window; nothing in it
 * ranks a wallet or suggests acting on one.
 */
export function describeTraderDna(study: TraderDnaStudy, now: Date = new Date()): TraderDnaReading {
  const none = whyNoFigures(study, now);
  if (none) return describeTraderDnaUnavailable(none);

  const sampled = behavioursWithASample(study);
  const survived = sampled.filter((b) => b.evidence_level === 'SURVIVED_FILTERS');
  const reconstructed = sampled.filter((b) => b.evidence_level === 'RECONSTRUCTED');
  const candidates = sampled.filter((b) => b.evidence_level === 'CANDIDATE');
  const behaviour = (b: TraderDnaBehaviour) =>
    `${sentence(b.summary)} (${b.sample_size} observations${b.adjusted_p === null ? '' : `, adjusted p ${b.adjusted_p}`})`;
  const flags = study.contamination_flags.length === 0 ? 'Contamination flags: none raised.' : `Contamination flags: ${study.contamination_flags.map((f) => `${f.code.toLowerCase().replace(/_/g, ' ')} (${sentence(f.note)})`).join(' ')}`;

  // Studio's title is its sentence, not ours: one that would be held in a post is not quoted here either.
  const named = claimsAboutAWallet(study.title) ? '' : ` "${study.title}"`;
  const parts = [
    `According to Studio's published study${named} (${day(study.window.start)} to ${day(study.window.end)}), the findings ${LEVEL_WORDS[study.evidence_level]}.`,
    `Sample: ${study.sample.wallets} wallets and ${study.sample.trades} trades.`,
    allInCosts(study) ? `Assumed costs: ${study.costs.fee_bps} bps all-in cost.`
      : `Assumed costs: ${study.costs.fee_bps} bps in fees and ${study.costs.slippage_bps} bps of slippage.`,
    `Luck filter: Bonferroni over ${study.luck_filters.tests} tests at alpha ${study.luck_filters.alpha}, ${study.luck_filters.survivors} survived.`,
    flags,
    survived.length > 0 ? `Survived the filters: ${survived.map(behaviour).join(' ')}` : 'No behaviour is shown to have survived the filters.',
    reconstructed.length > 0 ? `Only reconstructed, not shown to survive: ${reconstructed.map(behaviour).join(' ')}` : '',
    candidates.length > 0 ? `Candidates, never traded: ${candidates.map(behaviour).join(' ')}` : '',
    study.wallets.length > 0 ? 'Any wallet addresses are listed exactly as the study published them; listing one says nothing about whether to follow it.' : '',
    NOTHING_TRADED,
  ];
  return { state: 'AVAILABLE', statement: parts.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim() };
}

// ---------------------------------------------------------------------------
// A public post, from the idea backlog
// ---------------------------------------------------------------------------

/** The `content_ideas.source` and the event's `ideaSource` for a post made from a study. */
export const TRADER_DNA_IDEA_SOURCE = 'studio_trader_dna';
const CAPABILITY_ID = 'studio.trader_dna';
const CHECK_EVERY_MS = 6 * 3_600_000;

const WALLET_ADDRESS = /\b0x[0-9a-fA-F]{40}\b|\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/;

/*
  Fail closed. A deny-list of phrasings for "this wallet is smart" always has a
  phrasing it missed, so this works the other way round: a post is sent only
  when no sentence in it is both about people or wallets and evaluative,
  comparative, a claim about performance or a call for attention. Everything
  else goes to the owner. A false positive costs one trip to the owner; a false
  negative puts "these wallets are legends" under the agent's name.

  The word sets are deliberately broad and not understood in context: negations
  are not parsed, a sentence that has to say "do not follow" is better rewritten,
  and "worth" is evaluative whatever follows it.
*/
const words = (list: string[]) => new RegExp(`\\b(?:${list.join('|')})\\b`, 'i');

/** Who a claim could be about: the nouns for wallets and the people behind them, and the pronouns that stand for them. */
const SUBJECT = words([
  'wallets?', 'traders?', 'addresse?s?', 'accounts?', 'cohorts?', 'holders?', 'buyers?', 'sellers?', 'degens?', 'whales?', 'snipers?', 'guys?',
  'people', 'persons?', 'users?', 'investors?', 'players?', 'bots?', 'participants?', 'insiders?', 'folks', 'profiles?', 'entities', 'operators?',
  'ones', 'crowd', 'group', 'everyone', 'everybody', 'someone', 'somebody', 'anyone', 'nobody', 'funds?',
  'them', 'they', 'their', 'theirs', 'themselves', 'these', 'those', 'he', 'she', 'him', 'his', 'her', 'hers', 'himself', 'herself',
]);
/** Praise, and its adjectives and slang. */
const EVALUATIVE = words([
  'smart\\w*', 'sharp\\w*', 'clever\\w*', 'savvy', 'brilliant\\w*', 'genius\\w*', 'elite', 'expert\\w*', 'pros?', 'legend\\w*', 'beasts?', 'goats?', 'gods?',
  'kings?', 'masters?', 'wizards?', 'good', 'great', 'best', 'better', 'top', 'high', 'strong\\w*', 'solid', 'incredible', 'amazing', 'insane', 'crazy',
  'unreal', 'impressive', 'remarkable', 'outstanding', 'exceptional', 'stellar', 'superb', 'awesome', 'fantastic', 'phenomenal', 'unbelievable',
  'ridiculous', 'absurd', 'wild', 'nuts', 'sick', 'fire', 'hot', 'lucky', 'skill\\w*', 'talent\\w*', 'gifted', 'lucrative', 'rich\\w*', 'wealth\\w*',
  'success\\w*', 'reliable', 'legit', 'consistent\\w*', 'alpha', 'insider\\w*', 'profitable', 'worth\\w*', 'conviction', 'than',
]);
/** What a wallet is said to do well. */
const PERFORMANCE = words([
  'print\\w*', 'wins?', 'won', 'winn\\w*', 'winners?', 'beat\\w*', 'outperform\\w*', 'outpac\\w*', 'outsmart\\w*', 'crush\\w*', 'kill\\w*', 'edges?', 'edged',
  'know\\w*', 'dominat\\w*', 'destroy\\w*', 'cook(?:s|ed|ing)?', 'earn\\w*', 'profit\\w*', 'money', 'front-?run\\w*', 'predict\\w*', 'anticipat\\w*',
]);
/** Watching, following and copying, and the words that ask for them. */
const ATTENTION = words([
  'watch\\w*', 'eyes?', 'radar', 'bookmark\\w*', 'look\\w*', 'attention', 'follow\\w*', 'copy\\w*', 'copi\\w*', 'mirror\\w*', 'shadow\\w*',
  'tail(?:s|ed|ing)?', 'ap(?:e|es|ed|ing)', 'track\\w*', 'do what', 'subscrib\\w*', 'tabs', 'monitor\\w*', 'stalk\\w*', 'notice\\w*', 'listen\\w*',
  'trust\\w*', 'rely', 'relies', 'bet', 'bets', 'betting', 'ride', 'rides', 'riding', 'join\\w*', 'piggyback\\w*', 'emulat\\w*', 'replicat\\w*',
  'imitat\\w*', 'learn from', 'back(?:s|ed|ing)?', 'pin(?:s|ned|ning)?',
]);
/** Said to somebody: "you", "your". */
const ADDRESSED = /\b(?:you|your|yours|yourself|you['’](?:ll|re|ve|d)|u|ya)\b/i;
/** A sentence that opens with an instruction to watch, follow or copy. */
const IMPERATIVE_START =
  /^[^a-z]*(?:(?:please|just|now|and|so|but|also|then|do)\s+)*(?:watch|keep|put|bookmark|look|follow|copy|mirror|shadow|tail|ape|track|subscribe|monitor|stalk|trust|join|ride|bet|back|emulate|replicate|imitate|pin|add|save|tag|check|remember)\b/i;
/** Phrases that are a claim or an invitation whoever they are about. */
const ALWAYS_HELD = /\bsmart[- ]?money\b|\bcopy[- ]?trad|\bsocial trad|\bmirror trad|\bwhale[- ]?watch|\b(?:wallet|address)[- ]?(?:track|watch)/i;

/** Words ending -er or -est that are not comparatives, so a sentence is not held for "over" or "filter". */
const NOT_COMPARATIVE = new Set(
  (
    'over after under other another whether number never ever however whenever wherever whoever whatever either neither together order border water paper ' +
    'filter cluster trader buyer seller holder sniper owner user worker member offer answer cover power trigger letter matter center centre tier consider ' +
    'enter deliver discover remember register gather transfer render alter differ suffer wonder bother clutter interest request invest suggest contest ' +
    'protest arrest harvest digest manifest forest west guest quest bitcoin'
  ).split(' '),
);
const COMPARATIVE_FORM = /\b[a-z]{2,}(?:er|est)\b/gi;
const hasComparative = (sentence: string) => (sentence.match(COMPARATIVE_FORM) ?? []).some((w) => !NOT_COMPARATIVE.has(w.toLowerCase()));

/** The finished text as sentences, with the characters used to hide a word from a pattern removed. */
function sentencesOf(text: string): string[] {
  const plain = text.normalize('NFKC').replace(/\p{Cf}/gu, '');
  return plain
    .split(/(?<=[.!?])\s+|[\r\n]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * The sentences that cannot go out without the owner. A sentence is held when it
 * is about wallets or the people behind them (or follows one that was) and says
 * anything evaluative, comparative, about performance or about attention; when it
 * tells the reader to watch, follow or copy; or when it carries an address.
 */
function sentencesHeld(text: string): string[] {
  const held: string[] = [];
  let previousRefers = false;
  for (const sentence of sentencesOf(text)) {
    const refers = SUBJECT.test(sentence);
    const evaluative = EVALUATIVE.test(sentence) || PERFORMANCE.test(sentence) || ATTENTION.test(sentence) || hasComparative(sentence);
    const claim =
      WALLET_ADDRESS.test(sentence) ||
      ALWAYS_HELD.test(sentence) ||
      IMPERATIVE_START.test(sentence) ||
      ((refers || previousRefers) && evaluative) ||
      (ADDRESSED.test(sentence) && evaluative);
    if (claim) held.push(sentence);
    previousRefers = refers;
  }
  return held;
}

const SAYS_NOTHING_TRADED =
  /\b(nothing|none of (it|this)) (was|has been|is|were) (traded|bought|sold)\b|\bnever traded\b|\bno (trades|positions?) (were|was|are|is) (made|placed|taken|open)\b/i;

/** True when a sentence the study published could not go into a post without the owner. */
function claimsAboutAWallet(text: string): boolean {
  return sentencesHeld(text).length > 0;
}

export interface TraderDnaIdea {
  summary: string;
  detail: string;
  /** Study id and publication date: what stops one study being proposed twice. */
  key: string;
}

/**
 * The idea a study makes, or nothing.
 *
 * Only a study whose findings survived the filters, with a sample, in date, and
 * with at least one behaviour that can be said without naming or praising a
 * wallet. Silence is the usual answer.
 */
export function traderDnaIdeaFrom(study: TraderDnaStudy, now: Date = new Date()): TraderDnaIdea | null {
  if (whyNoFigures(study, now)) return null;
  if (study.evidence_level !== 'SURVIVED_FILTERS') return null;
  const sayable = behavioursWithASample(study)
    .filter((b) => b.evidence_level === 'SURVIVED_FILTERS' && !claimsAboutAWallet(b.summary))
    .slice(0, 3);
  if (sayable.length === 0) return null;
  // The title is Studio's sentence too: one that praises a wallet is left out, not quoted.
  const named = claimsAboutAWallet(study.title) ? '' : ` "${study.title}"`;

  const summary = [
    `Studio's published Trader DNA study${named}, ${day(study.window.start)} to ${day(study.window.end)}: ${study.sample.wallets} wallets, ${study.sample.trades} trades, findings that ${LEVEL_WORDS[study.evidence_level]} (Bonferroni over ${study.luck_filters.tests} tests).`,
    allInCosts(study) ? `Assumed costs: ${study.costs.fee_bps} bps all-in cost.`
      : `Assumed costs: ${study.costs.fee_bps} bps fees, ${study.costs.slippage_bps} bps slippage.`,
    ...sayable.map((b) => `Behaviour: ${sentence(b.summary)} (${b.sample_size} observations).`),
  ]
    .join(' ')
    .slice(0, 600);
  const rules = [
    'Say that this is a study published on AI17Z Studio, give the dates and the sample size, and say which evidence level the finding has.',
    'Say that nothing was traded. This is research about what a set of wallets did.',
    'Use only the figures above. Do not round them up, add to them or compare them with anything.',
    'Do not name, quote or describe any wallet address, and never call a wallet or a trader smart, sharp, an insider, or worth copying, following or watching.',
    'Do not say or suggest what will happen next, and do not call it a signal, a recommendation or advice.',
  ];
  return { summary, detail: rules.join('\n'), key: `${study.study_id}@${study.published_at}` };
}

interface ProposalMemo {
  checkedAt: string;
  proposedKey: string | null;
}
const memoKey = (agentId: string) => `studio.trader_dna.proposed.${agentId}`;

export interface TraderDnaProposalOutcome {
  proposed: boolean;
  why: string;
}

/**
 * Looks at the one study the owner named and, if it makes an idea, puts it in
 * the backlog. Called by the posting engine when it comes due, so the schedule
 * stays what decides when anything is said. A study is proposed once.
 */
export async function proposeTraderDnaPost(agentId: string, now: Date = new Date()): Promise<TraderDnaProposalOutcome> {
  try {
    const policy = await agentsRepo.getActivePolicy(agentId);
    const studio = policy?.config.studio;
    if (!studio?.postTraderDna) return { proposed: false, why: 'Posting a Trader DNA study is off.' };
    if (!studio.traderDnaStudyId) return { proposed: false, why: 'No published study was chosen to post about.' };

    const permission = (await capabilityPermissions(agentId)).get(CAPABILITY_ID);
    if (permission === undefined || permission === 'DISABLED') {
      return { proposed: false, why: 'Reading Trader DNA studies is switched off for this agent.' };
    }

    const memo = await ops.getSetting<ProposalMemo>(memoKey(agentId));
    if (memo && now.getTime() - Date.parse(memo.checkedAt) < CHECK_EVERY_MS) return { proposed: false, why: 'Studio was asked recently.' };
    const remember = (proposedKey: string | null) =>
      ops.setSetting(memoKey(agentId), { checkedAt: now.toISOString(), proposedKey: proposedKey ?? memo?.proposedKey ?? null } satisfies ProposalMemo);

    const read = await readTraderDnaStudy(studio.traderDnaStudyId, now);
    if (!read.ok) {
      await remember(null);
      return { proposed: false, why: read.why };
    }
    const idea = traderDnaIdeaFrom(read.study, now);
    if (!idea) {
      await remember(null);
      return { proposed: false, why: 'This study has nothing that can be said without naming or praising a wallet.' };
    }
    if (memo?.proposedKey === idea.key) {
      await remember(null);
      return { proposed: false, why: 'That study was already proposed.' };
    }

    // The one gate on an agent choosing its own subject, as for any idea.
    const reticent = unpromptedSubject(`${idea.summary} ${idea.detail}`);
    if (reticent) {
      await remember(idea.key);
      return { proposed: false, why: `Not raised unprompted: ${reticent.subject}.` };
    }
    if (await contentRepo.similarExists(agentId, idea.summary)) {
      await remember(idea.key);
      return { proposed: false, why: 'The backlog already holds this.' };
    }
    await contentRepo.addIdea({
      agentId,
      kind: 'observation',
      summary: idea.summary,
      detail: idea.detail,
      source: TRADER_DNA_IDEA_SOURCE,
      sourceHandle: null,
      sourceJobId: null,
      score: 55,
    });
    await remember(idea.key);
    log.info('trader dna idea added', { agentId, study: read.study.study_id });
    return { proposed: true, why: 'A published Trader DNA study was added to the idea backlog.' };
  } catch (error) {
    // Posting about a study is optional; a failure here must never stop the
    // posting engine from doing everything else it was about to do.
    log.warn('trader dna proposal failed', { agentId, message: errorMessage(error) });
    return { proposed: false, why: 'Studio could not be asked just now.' };
  }
}

// ---------------------------------------------------------------------------
// The check on the finished text
// ---------------------------------------------------------------------------

/** Problems with the finished text of a post made from a study, as sentences. Empty when there are none. */
export function checkTraderDnaText(text: string): string[] {
  const problems: string[] = [];
  if (!/\bstudy\b/i.test(text)) problems.push('It does not say this is a study.');
  if (!/\bstudio\b/i.test(text)) problems.push('It does not attribute the study to AI17Z Studio.');
  if (!SAYS_NOTHING_TRADED.test(text)) problems.push('It does not say that nothing was traded.');
  if (WALLET_ADDRESS.test(text)) problems.push('It contains a wallet address.');
  const held = sentencesHeld(text).filter((sentence) => !WALLET_ADDRESS.test(sentence));
  if (held.length > 0) {
    problems.push(
      `It makes, or may make, a claim about a wallet or a trader (praise, a comparison, how well it does, or a call to watch, follow or copy it): "${held[0]!.slice(0, 120)}".`,
    );
  }
  if (FORWARD_LOOKING.test(text)) problems.push('It reads as a promise, a signal or advice about what comes next.');
  if (LIVE_OR_REAL.test(text)) problems.push('It implies a live position or real money.');
  return problems;
}

/**
 * The last word on a post made from a study, at the moment of sending. The
 * owner can switch posting off between the idea and the send, and a job can wait
 * behind an approval for a long time, so the policy is read again here and the
 * finished text, including text an owner edited in the review queue, is checked.
 */
export function checkTraderDnaAtSend(input: { raw: unknown; text: string; policy: PolicyConfig }): void {
  const raw = (input.raw ?? {}) as { ideaSource?: unknown };
  if (raw.ideaSource !== TRADER_DNA_IDEA_SOURCE) return;
  if (!input.policy.studio.postTraderDna) {
    throw PipelineError.permanent('trader_dna_posting_off', 'Posting a Trader DNA study was switched off after this post was written, so it was not sent.');
  }
  const problems = checkTraderDnaText(input.text);
  if (problems.length > 0) {
    throw PipelineError.review('trader_dna_text', `This post about a Trader DNA study needs the owner: ${problems.join(' ')}`);
  }
}
