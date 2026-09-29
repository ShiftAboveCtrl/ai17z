import { stripLeadingMentions } from './normalize';

/**
 * What somebody talks about, as subjects rather than word counts.
 *
 * The first implementation counted words and kept the commonest, which on a
 * real account produced "will", "have" and "just": the words every English
 * sentence has, ranked by how many sentences somebody wrote. A topic is a
 * subject. So this looks for the shapes subjects take and ranks those:
 *
 *   - tickers and hashtags, which somebody wrote on purpose;
 *   - names, a run of capitalised words that is not the start of a sentence;
 *   - phrases, two content words that keep appearing together;
 *   - single words, only when they are uncommon in general English and recur.
 *
 * Document frequency, never raw frequency: one post repeating a word ten times
 * is one post about it. A single word also has to beat the phrase it lives in,
 * so "robinhood" does not stand beside "robinhood chain" as a second topic.
 *
 * Deterministic, no model call. Every topic carries the posts it rests on.
 */

/**
 * Common English: function words and the few hundred commonest content words.
 *
 * Deliberately generous. The cost of an entry here is that a single word cannot
 * be a topic on its own, and it can still be one inside a phrase or a name, so
 * "building" is excluded while "builders" and "Base chain" are not.
 */
const COMMON = new Set(
  (
    'a about above after again against all almost also always am among an and another any anyone anything are around as ask asked at away ' +
    'back bad be became because become been before being best better between big bit both but by call came can cant could day days did ' +
    'didnt different do does doesnt doing done dont down during each early either else end enough even ever every everyone everything ' +
    'far feel felt few find first for found from full get gets getting give given go goes going gone good got great had hard has have ' +
    'having he her here hers him his how however i id if ill im in instead into is isnt it its itself ive just keep kind knew know known ' +
    'last later least less let lets life like likely little long look looking lot lots made make makes making man many may maybe me mean ' +
    'might more most much must my myself need needs never new next no none nor not nothing now of off often oh ok okay old on once one ' +
    'only or other others our out over own part people place point pretty put quite rather re real really right said same saw say saying ' +
    'says see seem seems seen she should show side since so some someone something sometimes soon still stuff such sure take taken than ' +
    'thank thanks that thats the their them then there theres these they theyre thing things think thinking this those though thought ' +
    'through time times to today together told too took top toward try trying turn two under until up upon us use used using very want ' +
    'wanted wants was way ways we well went were weve what whats when where whether which while who whole why will with without wont ' +
    'work working world would wouldnt yeah year years yes yet you youd youll your youre yours yourself youve ' +
    'lol lmao haha yep nope yup ya yo hey hi hello gm gn gg ngl tbh imo imho fr rn idk ikr omg wtf btw pls plz thx ty u ur im dm dms ' +
    'post posts tweet tweets thread reply replies follow followers account guys guy man bro bros fam everybody anybody somebody ' +
    'week weeks month months hour hours minute minutes morning night tonight tomorrow yesterday soon ago later ' +
    'love hate glad happy sad nice cool awesome amazing crazy insane wild huge small large big high low fast slow easy simple ' +
    'true false wrong fine sorry please welcome agree disagree probably definitely actually literally basically honestly exactly ' +
    'start started starting stop stopped build building built run running ran move moving moved win winning won lose losing lost ' +
    'call called come comes coming came went tell telling seeing looks looked feel feeling feels help helping helped ' +
    'gonna wanna gotta check checked checking try tries tried works worked fair close closer ship ships shipped shipping cook cooking ' +
    'early late ready done next soon sure fun free open cant wont isnt arent wasnt werent hasnt havent ' +
    // Interjections and address: how somebody talks, never what about.
    'lmfao lmaoo lmaooo hahaha hahah hahahaha hehe bruh dawg dude sir saar gents folks frens fren anon ong ser bros ' +
    'yall yeah yea yes nah nope okay alright wow damn omg bless congrats congratulations thanks thank ' +
    // Swearing is register, not subject.
    'shit shitty fuck fucking fucked bullshit crap hell ass damn goddamn ' +
    // Verbs of thinking and waiting: what somebody does in a sentence, not a subject.
    'believe believes hope hopes wait waits guess mean means happen happens hear heard read reads ' +
    'pray prays praying'
  ).split(/\s+/),
);

export interface TopicCandidateItem {
  id: string;
  text: string;
}

export type TopicShape = 'TICKER' | 'HASHTAG' | 'NAME' | 'PHRASE' | 'TERM';

export interface Topic {
  /** How it is shown: the commonest spelling somebody actually used. */
  label: string;
  /** Lower-cased identity, for merging and comparison. */
  key: string;
  shape: TopicShape;
  /** Items that mention it. */
  items: number;
  /** Share of the corpus that mentions it, 0 to 1. */
  share: number;
  /** Up to eight items it rests on. */
  evidence: string[];
  /** 0 to 1, from how often and in how many different items it appears. */
  confidence: number;
}

const SHAPE_WEIGHT: Record<TopicShape, number> = { TICKER: 1.4, HASHTAG: 1.1, NAME: 1.3, PHRASE: 1.2, TERM: 1 };

function clean(text: string): string {
  return stripLeadingMentions(text)
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/@[A-Za-z0-9_]{1,15}/g, ' ');
}

function isContentWord(word: string): boolean {
  const w = word.toLowerCase().replace(/['’]/g, '');
  return w.length >= 3 && !COMMON.has(w) && /\p{L}/u.test(w) && !/^\d+$/.test(w);
}

/** The candidates one item contributes, each once. */
function candidatesOf(text: string): Map<string, { label: string; shape: TopicShape }> {
  const found = new Map<string, { label: string; shape: TopicShape }>();
  const add = (label: string, shape: TopicShape) => {
    const key = label.toLowerCase();
    if (!found.has(key)) found.set(key, { label, shape });
  };
  const body = clean(text);

  for (const m of body.matchAll(/\$([A-Za-z][A-Za-z0-9]{1,9})\b/g)) add(`$${m[1]!.toUpperCase()}`, 'TICKER');
  for (const m of body.matchAll(/#(\p{L}[\p{L}\p{N}_]{2,40})/gu)) add(`#${m[1]}`, 'HASHTAG');

  // Names: capitalised runs that do not open a sentence. A sentence opening is
  // capitalised by grammar, not because it is somebody's name.
  for (const sentence of body.split(/(?<=[.!?])\s+|\n+/)) {
    const words = sentence.split(/\s+/).filter(Boolean);
    let run: string[] = [];
    const flush = () => {
      const kept = run.filter((w) => !COMMON.has(w.toLowerCase()));
      if (kept.length > 0 && run.join(' ').length >= 3) add(run.join(' '), 'NAME');
      run = [];
    };
    words.forEach((raw, index) => {
      // A ticker or hashtag was counted as one above; its letters are not a name too.
      if (/^[$#]/.test(raw)) {
        flush();
        return;
      }
      const word = raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
      // "Pons", "Robinhood", and acronyms such as "RWA"; never the pronoun "I".
      const capitalised = /^\p{Lu}[\p{L}\p{N}]*$/u.test(word);
      if (index > 0 && capitalised && word.length >= 2) run.push(word);
      else flush();
      if (/[,:;]$/.test(raw)) flush();
    });
    flush();
  }

  // Phrases: two adjacent content words.
  const original = body.split(/[^\p{L}\p{N}'’]+/u).filter(Boolean);
  const tokens = original.map((t) => t.toLowerCase());
  for (let i = 0; i < tokens.length - 1; i += 1) {
    const a = tokens[i]!;
    const b = tokens[i + 1]!;
    if (isContentWord(a) && isContentWord(b) && a !== b) add(`${a} ${b}`, 'PHRASE');
  }
  // A lone word that is a verb form ("tried", "shipping") is an activity, not a
  // subject. It can still be part of a phrase or a name.
  original.forEach((word, i) => {
    const t = tokens[i]!;
    // Spelled as written, so a sentence-opening "Pons" still counts towards "Pons".
    if (isContentWord(t) && t.length >= 4 && !/(?:ed|ing)$/.test(t)) add(word, 'TERM');
  });
  return found;
}

/**
 * The subjects a corpus is about, strongest first.
 *
 * `minItems` is the floor for calling anything a topic: below it the subject
 * is something mentioned, not something talked about.
 */
export function semanticTopics(items: TopicCandidateItem[], options: { max?: number; minItems?: number } = {}): Topic[] {
  const total = items.length;
  if (total === 0) return [];
  // Two percent of a small corpus, and never more than five posts: on a large
  // corpus a subject somebody wrote about five times is a subject.
  const minItems = options.minItems ?? Math.max(2, Math.min(5, Math.ceil(total * 0.02)));
  const tally = new Map<string, { labels: Map<string, number>; shape: TopicShape; ids: string[] }>();

  for (const item of items) {
    for (const [key, { label, shape }] of candidatesOf(item.text)) {
      const entry = tally.get(key) ?? { labels: new Map<string, number>(), shape, ids: [] as string[] };
      entry.labels.set(label, (entry.labels.get(label) ?? 0) + 1);
      // A key seen as a name anywhere is a name: "pons" and "Pons" are one subject.
      if (SHAPE_WEIGHT[shape] > SHAPE_WEIGHT[entry.shape]) entry.shape = shape;
      entry.ids.push(item.id);
      tally.set(key, entry);
    }
  }

  const ranked = [...tally.entries()]
    // A phrase needs more than a coincidence: two posts sharing two words is
    // how "router takes" became a topic.
    // A lone word needs the same: "takes" and "adds" in two posts each are grammar.
    .filter(([, e]) => e.ids.length >= (e.shape === 'PHRASE' || e.shape === 'TERM' ? Math.max(3, minItems) : minItems))
    .map(([key, e]) => {
      // Shown as somebody capitalises it when they ever do: a sentence-opening
      // "Pons" is counted as a plain word, so the lowercase spelling can win a
      // count it should not win a label.
      const spellings = [...e.labels.entries()].sort((a, b) => b[1] - a[1]);
      // "Pons" before "PONS" before "pons": a name as it is usually written,
      // not as somebody wrote it when they were shouting.
      // A plain word is shown as a word ("markets", even when it opened a
      // sentence); only something written as a name mid-sentence is a name.
      const titled = spellings.find(([l]) => /^\p{Lu}/u.test(l) && /\p{Ll}/u.test(l));
      const label =
        e.shape === 'TERM' || e.shape === 'PHRASE'
          ? key
          : (titled ?? spellings.find(([l]) => /\p{Lu}/u.test(l)) ?? spellings[0]!)[0];
      const share = e.ids.length / total;
      return {
        key,
        label,
        shape: e.shape,
        items: e.ids.length,
        share,
        evidence: [...new Set(e.ids)].slice(0, 8),
        score: e.ids.length * SHAPE_WEIGHT[e.shape],
      };
    })
    .sort((a, b) => b.score - a.score);

  /*
    A word that mostly appears inside a longer name or phrase is that name, and
    a phrase that is one word of a name plus a neighbour ("chain gonna") is a
    fragment of the name. Both are decided against the whole list, not in rank
    order, because a tie in rank says nothing about which contains which.
  */
  const multi = ranked.filter((c) => c.key.includes(' ') && c.shape === 'NAME');
  const absorbed = (candidate: (typeof ranked)[number]): boolean => {
    const words = candidate.key.split(' ');
    if (candidate.shape === 'TICKER' || candidate.shape === 'HASHTAG') return false;
    if (words.length === 1) {
      return ranked.some(
        (k) => k.key !== candidate.key && k.key.split(' ').includes(candidate.key) && k.items >= candidate.items * 0.6,
      );
    }
    if (candidate.shape === 'PHRASE') {
      return multi.some(
        (name) => name.key !== candidate.key && name.key.split(' ').some((w) => words.includes(w)) && name.items >= candidate.items,
      );
    }
    return false;
  };
  const kept = ranked.filter((c) => !absorbed(c)).slice(0, options.max ?? 15);

  return kept.map(({ score: _score, ...topic }) => ({
    ...topic,
    confidence: Math.min(0.95, Number((0.35 + Math.min(0.4, topic.share * 4) + Math.min(0.2, topic.items / 50)).toFixed(2))),
  }));
}
