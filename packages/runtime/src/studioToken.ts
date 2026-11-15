import { z } from 'zod';
import { defineCapability, registerCapability, type AnyCapability } from '@xbam/tools';
import { AI17Z_PAYMENT, TokenFactsDocument } from '@xbam/shared/contracts';
import { checkLinkUrl, linkedCheckOrigin } from './studioCheckLink';
import { studioInstallationReady, studioInstallationRequest } from './studioLink';
import { FORWARD_LOOKING } from './studioPaperVoice';

/**
 * What the agent may say about the token it is part of, and nothing more.
 *
 * ## Allowlisted, sourced, and silent unless asked
 *
 * The facts are the ones Studio's own token page publishes: the contract, the
 * holder requirement and an observed seven-day median price. They are read from
 * the linked Studio when somebody asks, strictly parsed, and said with Studio
 * named as the source. Nothing is cached, so a price is never older than the
 * answer it appears in.
 *
 * - The contract must be the one this installation already pins
 *   (`AI17Z_PAYMENT`). A document naming another address is refused whole, so
 *   a hostile or mistaken answer cannot make the agent present a different
 *   token as its own.
 * - The price is a median over a window that closed, said as such and never as
 *   a forecast. A price older than `MAX_AGE_MS` is dropped, not shown.
 * - No wallet, balance or purchase is reachable from here. The only requests
 *   are one GET to Studio and the links are built from the linked origin.
 * - It is a capability the model is offered only when the question is about the
 *   token (the shortlister matches on the words in the description), so an agent
 *   never raises $AI17Z unprompted. Reticence is unchanged by it.
 */

const SOURCE = 'AI17Z Studio' as const;
const PATH = '/api/v1/installation/token/facts';

/** Older than this and a median is history, not something to quote as observed now. */
export const TOKEN_FACTS_MAX_AGE_MS = 6 * 60 * 60_000;
const FUTURE_SLACK_MS = 5 * 60_000;

/** Words that turn a statement of fact into a pitch or a call. The statement is built here, so this is a tripwire. */
const PITCH = /\b(buy|buying|sell|selling|invest\w*|accumulate|hodl|moon|pump\w*|bullish|bearish|undervalued|opportunity|entry|dip|rally)\b/i;

/** Problems with the finished sentence, as sentences. Empty when there are none. */
export function checkTokenStatement(text: string): string[] {
  const problems: string[] = [];
  if (FORWARD_LOOKING.test(text)) problems.push('It reads as a promise, a signal or advice about what comes next.');
  if (PITCH.test(text)) problems.push('It reads as a pitch to trade the token.');
  return problems;
}

export interface TokenFactsAnswer {
  state: 'AVAILABLE' | 'UNAVAILABLE';
  source: typeof SOURCE;
  contract: string | null;
  chain: string | null;
  holderRequirementTokens: string | null;
  medianPriceUsd: string | null;
  tokenPageUrl: string | null;
  checkPageUrl: string | null;
  statement: string;
}

const NOTHING: Omit<TokenFactsAnswer, 'statement'> = {
  state: 'UNAVAILABLE',
  source: SOURCE,
  contract: null,
  chain: null,
  holderRequirementTokens: null,
  medianPriceUsd: null,
  tokenPageUrl: null,
  checkPageUrl: null,
};

function unavailable(why: string): TokenFactsAnswer {
  return { ...NOTHING, statement: `${why} I will not give a figure I cannot source.` };
}

/** The token page on a given origin, or null when the origin is not a plain origin. */
export function tokenPageUrl(origin: string): string | null {
  let base: URL;
  try {
    base = new URL(origin);
  } catch {
    return null;
  }
  if (base.origin !== origin || (base.protocol !== 'https:' && base.protocol !== 'http:')) return null;
  return new URL('/token', base).toString();
}

/**
 * The sentence, from an already validated document. Pure: the price line is
 * left out when it is missing or stale, and the rest still stands.
 */
export function describeTokenFacts(
  doc: TokenFactsDocument,
  links: { tokenPage: string | null; checkPage: string | null },
  now: Date = new Date(),
): { statement: string; medianPriceUsd: string | null } {
  const parts: string[] = [
    `$AI17Z is the token behind this project. Its contract on ${AI17Z_PAYMENT.chainName} is ${AI17Z_PAYMENT.tokenChecksum}.`,
    `The holder requirement Studio publishes is ${doc.holder_requirement.tokens} $AI17Z.`,
  ];
  let price: string | null = null;
  const median = doc.observed_median_7d;
  if (median) {
    const age = now.getTime() - Date.parse(median.observed_at);
    if (age <= TOKEN_FACTS_MAX_AGE_MS && age >= -FUTURE_SLACK_MS) {
      price = median.price_usd;
      parts.push(`The observed seven-day median price is $${median.price_usd}. That is a median of past observations, not a forecast.`);
    } else {
      parts.push('Studio has no current median price, so I will not quote one.');
    }
  } else {
    parts.push('Studio has no median price published, so I will not quote one.');
  }
  if (links.checkPage) parts.push(`You can check the contract yourself: ${links.checkPage}`);
  if (links.tokenPage) parts.push(`The token page: ${links.tokenPage}`);
  parts.push('This is what Studio publishes, from AI17Z Studio, and not advice.');
  return { statement: parts.join(' '), medianPriceUsd: price };
}

/** One read of Studio's token facts, never throws, never invents. */
export async function readTokenFacts(now: Date = new Date()): Promise<TokenFactsAnswer> {
  const link = await studioInstallationReady();
  if (!link.linked) return unavailable(`${link.why} Studio is not available to this agent right now.`);
  const answer = await studioInstallationRequest(PATH, { method: 'GET' });
  if (!answer.ok) return unavailable(answer.why);
  if (answer.status !== 200) return unavailable(answer.sentence);
  const parsed = TokenFactsDocument.safeParse(answer.body);
  if (!parsed.success) return unavailable('Studio answered in a shape I do not recognise.');
  const doc = parsed.data;
  const age = now.getTime() - Date.parse(doc.generated_at);
  if (age > TOKEN_FACTS_MAX_AGE_MS || age < -FUTURE_SLACK_MS) return unavailable("Studio's token facts are not current.");
  if (doc.token.chain_id !== AI17Z_PAYMENT.chainId || doc.token.address.toLowerCase() !== AI17Z_PAYMENT.token) {
    return unavailable('Studio named a contract other than the one this installation knows.');
  }
  const origin = await linkedCheckOrigin().catch(() => null);
  const links = {
    tokenPage: origin ? tokenPageUrl(origin) : null,
    checkPage: origin ? checkLinkUrl(origin, 'robinhood', AI17Z_PAYMENT.token) : null,
  };
  const { statement, medianPriceUsd } = describeTokenFacts(doc, links, now);
  // The sentence is built here, so a failure is a defect: say less, never the failing text.
  if (checkTokenStatement(statement).length > 0) return unavailable('The token facts could not be stated safely.');
  return {
    state: 'AVAILABLE',
    source: SOURCE,
    contract: AI17Z_PAYMENT.tokenChecksum,
    chain: AI17Z_PAYMENT.chainName,
    holderRequirementTokens: doc.holder_requirement.tokens,
    medianPriceUsd,
    tokenPageUrl: links.tokenPage,
    checkPageUrl: links.checkPage,
    statement,
  };
}

const Output = z.object({
  state: z.enum(['AVAILABLE', 'UNAVAILABLE']),
  source: z.literal(SOURCE),
  contract: z.string().nullable(),
  chain: z.string().nullable(),
  holderRequirementTokens: z.string().nullable(),
  medianPriceUsd: z.string().nullable(),
  tokenPageUrl: z.string().nullable(),
  checkPageUrl: z.string().nullable(),
  /** The sentence to say. Facts only, Studio named, no forecast, no advice. */
  statement: z.string(),
});

const facts = defineCapability({
  id: 'ai17z_token.facts',
  name: 'What is $AI17Z',
  description:
    'The published facts about the $AI17Z token, only when somebody asks what $AI17Z is, how to check it or what the holder requirement is: ' +
    'its contract, the holder requirement and the observed seven-day median price, with links to the token page and the contract check page. ' +
    'Say the figures come from AI17Z Studio, that the price is an observed median and not a forecast, and never suggest buying, selling or holding. ' +
    'Never bring the token up unasked. Call with no arguments.',
  category: 'ACCOUNT',
  effect: 'READ',
  risk: 'LOW',
  unsetPermission: 'DISABLED',
  input: z.object({}).strict(),
  output: Output,
  modelCallable: true,
  timeoutMs: 25_000,
  async readiness() {
    const link = await studioInstallationReady();
    return link.linked
      ? { status: 'AVAILABLE' as const }
      : { status: 'UNAVAILABLE' as const, why: `${link.why} Link this installation to AI17Z Studio on the Plugins screen to read the token facts.` };
  },
  async run() {
    return readTokenFacts();
  },
});

export const STUDIO_TOKEN_CAPABILITIES = [facts] as unknown as AnyCapability[];

export function registerStudioTokenCapabilities(): void {
  for (const capability of STUDIO_TOKEN_CAPABILITIES) registerCapability(capability);
}
