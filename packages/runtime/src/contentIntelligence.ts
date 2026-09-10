/**
 * What has actually worked, from what was actually published.
 *
 * The temptation here is a dashboard of averages: best time to post, ideal
 * length, top hashtag. Those numbers are easy to compute from six posts and
 * they are worse than nothing, because an owner will change how their agent
 * writes on the strength of them.
 *
 * So three rules, and they are the whole file:
 *
 * - **A claim needs a sample.** Below `MIN_SAMPLE` on either side of a
 *   comparison there is no finding, and the absence is reported as "not enough
 *   posts yet" rather than as a weak result.
 * - **Median, not mean.** One post that got picked up by a large account is
 *   ten times every other post combined, and a mean turns that single accident
 *   into a rule about, say, posting on Tuesdays. `docs/ENGINEERING.md` already
 *   makes this argument about liquidity pairs; it is the same argument.
 * - **Absent is not zero.** A post whose impressions were never read is left
 *   out of a rate comparison entirely. Counting it as zero makes every
 *   unmeasured post look like a failure and drags whichever group it lands in.
 */

/** One post the agent published, with whatever was later observed about it. */
export interface PublishedPost {
  statusId: string;
  text: string;
  /** ISO. Used for the hour-of-day comparison and nothing else. */
  publishedAt: string;
  impressions?: number;
  likes?: number;
  replies?: number;
  reposts?: number;
  /** Whether the post carried an image or video. */
  hasMedia?: boolean;
}

export interface ContentFinding {
  /** What was compared. */
  dimension: 'LENGTH' | 'QUESTION' | 'MEDIA' | 'HOUR';
  /** The group that did better. */
  label: string;
  /** The group it beat. */
  comparedTo: string;
  sampleSize: number;
  comparedSampleSize: number;
  /** Engagements per thousand impressions, median. */
  rate: number;
  comparedRate: number;
  /** A sentence an owner can read and disagree with. */
  detail: string;
}

export interface ContentSignals {
  findings: ContentFinding[];
  /** Comparisons that could not be made, and why. Never silently omitted. */
  gaps: string[];
  /** How many posts had enough measurement to be compared at all. */
  measured: number;
  total: number;
}

/**
 * The fewest posts on each side of a comparison before it is worth saying.
 *
 * Five is not statistics and this file does not pretend otherwise. It is the
 * point below which a single lucky post decides the answer, which is the
 * failure that matters: an owner rewriting their agent's voice because two
 * posts out of three happened to land.
 */
const MIN_SAMPLE = 5;

/** Under this many characters is "short". Chosen to split X posts near evenly. */
const SHORT_POST = 120;

/** How much better one group has to do before it is called a difference. */
const MEANINGFUL_LIFT = 1.25;

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/**
 * Engagements per thousand impressions.
 *
 * A rate rather than a total, because a post shown to ten thousand people and
 * one shown to two hundred are not comparable on likes. Undefined when
 * impressions were never observed -- that post takes no part in any comparison.
 */
export function engagementRate(post: PublishedPost): number | undefined {
  if (post.impressions === undefined || post.impressions <= 0) return undefined;
  const engagements = (post.likes ?? 0) + (post.replies ?? 0) + (post.reposts ?? 0);
  return (engagements / post.impressions) * 1_000;
}

interface Group {
  label: string;
  rates: number[];
}

function compare(dimension: ContentFinding['dimension'], a: Group, b: Group, gaps: string[]): ContentFinding | null {
  if (a.rates.length < MIN_SAMPLE || b.rates.length < MIN_SAMPLE) {
    gaps.push(
      `Not enough measured posts to compare ${a.label} with ${b.label} -- ${a.rates.length} and ${b.rates.length}, and ${MIN_SAMPLE} of each is the minimum.`,
    );
    return null;
  }
  const rateA = median(a.rates);
  const rateB = median(b.rates);
  const [winner, loser] = rateA >= rateB ? [a, b] : [b, a];
  const [high, low] = rateA >= rateB ? [rateA, rateB] : [rateB, rateA];
  if (low <= 0 || high / low < MEANINGFUL_LIFT) {
    gaps.push(`${a.label} and ${b.label} have performed about the same.`);
    return null;
  }
  const lift = Math.round((high / low - 1) * 100);
  return {
    dimension,
    label: winner.label,
    comparedTo: loser.label,
    sampleSize: winner.rates.length,
    comparedSampleSize: loser.rates.length,
    rate: Number(high.toFixed(1)),
    comparedRate: Number(low.toFixed(1)),
    detail: `${winner.label} have done ${lift}% better than ${loser.label} (${winner.rates.length} posts against ${loser.rates.length}).`,
  };
}

/** Whether a post asked something. Answered by the mark, not by a model. */
export function asksSomething(text: string): boolean {
  return /\?\s*$/.test(text.trim()) || /\?\s/.test(text);
}

export function readContentSignals(posts: PublishedPost[], options: { hourBuckets?: boolean } = {}): ContentSignals {
  const gaps: string[] = [];
  const measured: { post: PublishedPost; rate: number }[] = [];
  for (const post of posts) {
    const rate = engagementRate(post);
    // Left out entirely rather than counted as zero. An unmeasured post makes
    // whichever group it lands in look worse than it was.
    if (rate === undefined) continue;
    measured.push({ post, rate });
  }

  if (measured.length === 0) {
    gaps.push('No published post has had its impressions read yet, so nothing can be compared.');
    return { findings: [], gaps, measured: 0, total: posts.length };
  }

  const findings: ContentFinding[] = [];

  const short: Group = { label: 'Short posts', rates: [] };
  const long: Group = { label: 'Longer posts', rates: [] };
  const asking: Group = { label: 'Posts that ask something', rates: [] };
  const stating: Group = { label: 'Posts that state something', rates: [] };
  const withMedia: Group = { label: 'Posts with a picture', rates: [] };
  const withoutMedia: Group = { label: 'Posts without one', rates: [] };

  for (const { post, rate } of measured) {
    (post.text.trim().length <= SHORT_POST ? short : long).rates.push(rate);
    (asksSomething(post.text) ? asking : stating).rates.push(rate);
    if (post.hasMedia !== undefined) (post.hasMedia ? withMedia : withoutMedia).rates.push(rate);
  }

  for (const [dimension, a, b] of [
    ['LENGTH', short, long],
    ['QUESTION', asking, stating],
    ['MEDIA', withMedia, withoutMedia],
  ] as const) {
    const finding = compare(dimension, a, b, gaps);
    if (finding) findings.push(finding);
  }

  if (options.hourBuckets) {
    // Morning and evening rather than twenty-four hourly buckets: split
    // finely enough and every bucket is under the sample floor, which produces
    // twenty-four gaps and no findings.
    const morning: Group = { label: 'Posts before midday' , rates: [] };
    const later: Group = { label: 'Posts after midday', rates: [] };
    for (const { post, rate } of measured) {
      const hour = new Date(post.publishedAt).getUTCHours();
      if (!Number.isFinite(hour)) continue;
      (hour < 12 ? morning : later).rates.push(rate);
    }
    const finding = compare('HOUR', morning, later, gaps);
    if (finding) findings.push(finding);
  }

  findings.sort((a, b) => b.rate / Math.max(b.comparedRate, 0.01) - a.rate / Math.max(a.comparedRate, 0.01));
  return { findings, gaps, measured: measured.length, total: posts.length };
}
