/**
 * Subjects an agent does not raise on its own.
 *
 * ## What changed, and why this had to exist
 *
 * Until deliberation, an AI17Z agent only spoke when spoken to. Whether it
 * answered at all was the engagement heuristic's decision, what it was allowed
 * to say was the policy's, and a person had put the subject on the table. An
 * agent that develops its own interests and writes its own posts has no such
 * person. It can arrive at a position on an election and publish it, on
 * somebody's real account, while they are asleep.
 *
 * ## The narrow thing this does
 *
 * It gates **origination only**: whether an item on the agent's mind may become
 * a post candidate, and what an original post is allowed to be about. It does
 * not decide what an agent may find interesting, may notice, may remember, or
 * may say when somebody asks it directly. Those stay where they already are --
 * `content.blockedTopics`, the persona's prohibited behaviours, the validator
 * and the engagement heuristic -- and every one of them is the owner's to set.
 *
 * So the rule is not "this agent may not discuss war". It is "this agent does
 * not bring up war unprompted". Those are very different promises, and only the
 * second one can be kept by a list of words.
 *
 * ## Why a list at all, when `salience.ts` argues against long lists
 *
 * That argument is about scoring: a long stopword list starts deciding what an
 * agent is allowed to find interesting, and the overlap thresholds already do
 * the work. This is not scoring. It is a refusal, it applies at one gate, and
 * the errors are not symmetric. A word that should not be here costs one idea
 * that never became a post, which nobody will ever notice. A word that is
 * missing costs an unprompted public opinion on somebody's real account, which
 * is not repaired by a correction. So the list leans towards refusing.
 *
 * It is deliberately **not exhaustive and does not try to be**. It is a floor
 * under an unconfigured installation, which is the case that fails. An owner
 * who wants more adds it to `content.blockedTopics`, which is the stronger
 * control: that one stops the subject being discussed at all.
 *
 * Terms are chosen to be unambiguous in the register an agent actually writes
 * in, which is why some obvious ones are absent. `died`, `diagnosis`, `side
 * effects`, `candidate` and `woke` all belong to a subject below and all belong
 * just as much to a sentence about a worker process, a bug, a release, or
 * getting up -- and this file is read by agents whose whole subject is
 * software.
 *
 * The same reasoning keeps most crypto vocabulary out. An agent whose owner
 * connected it to DexScreener is meant to talk about tokens, and `10x`,
 * `guaranteed`, `pump` and `dyor` are all ordinary words in that register or in
 * this codebase -- `guaranteed by the unique index` is a sentence from its own
 * documentation. What is here instead is the substance of unprompted financial
 * advice: telling somebody to buy or sell, a price target, and the two phrases
 * that only ever introduce one.
 *
 * ## The agent may not switch it off
 *
 * There is no policy field, no autonomy level and no code path that disables
 * this, and nothing deliberation writes can reach it. An autonomous loop that
 * can widen its own remit has no remit.
 */

/** A subject that was found, and the word that found it. */
export interface ReticentSubject {
  /** The category, in words an owner reads on a screen. */
  subject: string;
  /** What actually matched, so a wrong refusal can be argued with. */
  matched: string;
}

/**
 * The subjects, each as the words that identify it.
 *
 * Lower case, matched on word boundaries rather than as substrings, for the
 * reason `subjectsIn` gives -- "war" inside "warranty" and "arms" inside
 * "alarms" is how an agent falls silent about the wrong thing.
 */
const SUBJECTS: ReadonlyArray<readonly [string, readonly string[]]> = [
  [
    'party politics and elections',
    [
      'election', 'elections', 'electoral', 'ballot', 'ballots', 'referendum', 'primaries',
      'democrat', 'democrats', 'republican', 'republicans', 'tory', 'tories',
      'left-wing', 'right-wing', 'far-right', 'far-left', 'presidential', 'prime minister',
      'parliament', 'congress', 'senate', 'voters', 'vote for', 'impeachment', 'coup',
    ],
  ],
  [
    'war and armed conflict',
    [
      'war', 'warfare', 'invasion', 'invaded', 'airstrike', 'airstrikes', 'ceasefire',
      'genocide', 'ethnic cleansing', 'militia', 'insurgency', 'hostages',
      'civilian casualties', 'refugees', 'atrocity', 'atrocities',
    ],
  ],
  [
    'somebody getting hurt',
    [
      'shooting', 'shootings', 'stabbing', 'massacre', 'terrorist', 'terrorism', 'bombing',
      'assassination', 'assassinated', 'murdered', 'suicide', 'overdose', 'death toll',
      'fatalities', 'hate crime',
    ],
  ],
  [
    'medical advice',
    [
      'chemotherapy', 'antidepressant', 'antidepressants', 'dosage', 'prescription',
      'vaccine', 'vaccines', 'vaccination', 'medical advice', 'self-medicate',
      'mental illness', 'cancer diagnosis',
    ],
  ],
  [
    'legal advice',
    ['lawsuit', 'indicted', 'indictment', 'convicted', 'plea deal', 'defamation', 'legal advice'],
  ],
  [
    'what somebody should do with their money',
    [
      'you should buy', 'you should sell', 'financial advice', 'investment advice',
      'not financial advice', 'guaranteed returns', 'price target', 'to the moon',
      'life savings', 'mortgage', 'retirement fund', 'pension fund',
    ],
  ],
  [
    'religion',
    [
      'religion', 'religious', 'christianity', 'christian', 'islam', 'muslim',
      'judaism', 'jewish', 'hindu', 'atheism', 'blasphemy',
    ],
  ],
  [
    'identity as a political argument',
    [
      'immigration', 'immigrants', 'deportation', 'abortion', 'gun control',
      'transgender', 'racism', 'racist', 'sexism', 'feminism',
    ],
  ],
];

/**
 * Word-boundary matching, Unicode-aware.
 *
 * Shares the discipline in `subjectsIn` rather than the implementation, because
 * the two answer different questions and one of them is a refusal: a change
 * made for scoring reasons must not quietly change what an agent will not bring
 * up.
 */
function mentions(haystack: string, term: string): boolean {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}([^\\p{L}\\p{N}]|$)`, 'iu').test(haystack);
}

/**
 * Whether this is something the agent would be raising by itself.
 *
 * Returns the first subject found rather than all of them. One reason is enough
 * to decline, and a list of eight categories against one sentence reads as an
 * accusation rather than an explanation.
 */
export function unpromptedSubject(text: string): ReticentSubject | null {
  const haystack = text.trim();
  if (!haystack) return null;
  for (const [subject, terms] of SUBJECTS) {
    for (const term of terms) {
      if (mentions(haystack, term)) return { subject, matched: term };
    }
  }
  return null;
}

/** The sentence an owner reads next to a candidate that was not offered. */
export function reticenceReason(found: ReticentSubject): string {
  return `Not raised unprompted: ${found.subject}. An agent may answer about this when somebody asks; it does not start the conversation.`;
}

/** The subjects, for the owner-facing screen that explains the rule. */
export function reticentSubjects(): readonly string[] {
  return SUBJECTS.map(([subject]) => subject);
}
