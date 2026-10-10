import { generate, type GenerateRequest, type GenerateResult } from '@xbam/models';
import { fenceUntrusted, UNTRUSTED_PREAMBLE } from './researchFabric';

/**
 * A council: several specialists judging one proposition from the same
 * evidence, each from its own angle, so an owner sees where they agree, where
 * they do not, and what nobody could settle.
 *
 * Bounded before it is clever. One model call per specialist, at most five,
 * each with a deadline, through the owner's own configured models: the
 * council costs exactly as many calls as it has members and never retries
 * its way through a provider chain. Specialists judge only the evidence they
 * are given, which is fenced as somebody else's writing, and a view that
 * cites none of it is dropped, because an unevidenced view is an assertion.
 *
 * The synthesis is deterministic. Each specialist answers SUPPORTS, OPPOSES
 * or UNCERTAIN with its reasons; consensus is all of them saying the same
 * thing, a disagreement is anything else, and what is unresolved is what the
 * uncertain ones said they would need. A model asked to summarise a debate
 * would write a pleasing summary of it, which is a different thing from the
 * debate.
 */

export const COUNCIL_ROLES = ['RESEARCH', 'MARKET', 'ONCHAIN', 'SKEPTIC', 'RISK'] as const;
export type CouncilRole = (typeof COUNCIL_ROLES)[number];

const BRIEF: Record<CouncilRole, string> = {
  RESEARCH: 'You weigh what the sources say and how well they support the proposition.',
  MARKET: 'You judge the proposition as it bears on markets: prices, liquidity, and what would have to be true of them.',
  ONCHAIN: 'You judge what the on-chain facts in the evidence establish, and what they cannot.',
  SKEPTIC: 'You look for what is wrong with the proposition and with the evidence for it. Agreeing is allowed only when nothing you can find is wrong.',
  RISK: 'You judge what could go wrong if the proposition is acted on, and how badly.',
};

export type CouncilVerdict = 'SUPPORTS' | 'OPPOSES' | 'UNCERTAIN';

export interface CouncilView {
  role: CouncilRole;
  verdict: CouncilVerdict;
  reasons: string[];
  /** Indexes into the evidence, one-based, as the specialist cited them. */
  cites: number[];
  /** What would settle it, from a specialist that could not. */
  needs: string[];
}

export interface CouncilReport {
  proposition: string;
  views: CouncilView[];
  /** Specialists whose answer was dropped, and why. */
  dropped: { role: CouncilRole; why: string }[];
  consensus: CouncilVerdict | null;
  disagreement: { verdict: CouncilVerdict; roles: CouncilRole[] }[];
  unresolved: string[];
  calls: number;
  modelCallIds: string[];
}

const PER_CALL_MS = 25_000;

function parseView(role: CouncilRole, text: string, evidenceCount: number): CouncilView | string {
  const match = /\{[\s\S]*\}/.exec(text);
  if (!match) return 'did not answer in the agreed shape';
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(match[0]) as Record<string, unknown>;
  } catch {
    return 'did not answer in the agreed shape';
  }
  const verdict = raw.verdict;
  if (verdict !== 'SUPPORTS' && verdict !== 'OPPOSES' && verdict !== 'UNCERTAIN') return 'gave no verdict';
  const strings = (v: unknown, max: number) =>
    (Array.isArray(v) ? v : []).filter((x): x is string => typeof x === 'string').map((x) => x.trim().slice(0, 300)).filter(Boolean).slice(0, max);
  const cites = (Array.isArray(raw.cites) ? raw.cites : []).filter(
    (n): n is number => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= evidenceCount,
  );
  const reasons = strings(raw.reasons, 5);
  if (reasons.length === 0) return 'gave no reasons';
  // An unevidenced view is an assertion. With no evidence at all there is
  // nothing to cite, and every view is dropped rather than all being believed.
  if (cites.length === 0) return 'cited none of the evidence';
  return { role, verdict, reasons, cites: [...new Set(cites)], needs: strings(raw.needs, 5) };
}

/** The deterministic part: consensus, disagreement and what is unresolved, from the views alone. */
export function synthesize(views: readonly CouncilView[]): Pick<CouncilReport, 'consensus' | 'disagreement' | 'unresolved'> {
  const by = new Map<CouncilVerdict, CouncilRole[]>();
  for (const v of views) by.set(v.verdict, [...(by.get(v.verdict) ?? []), v.role]);
  const consensus = views.length >= 2 && by.size === 1 ? views[0]!.verdict : null;
  const disagreement = consensus || views.length === 0 ? [] : [...by.entries()].map(([verdict, roles]) => ({ verdict, roles }));
  const unresolved = [...new Set(views.filter((v) => v.verdict === 'UNCERTAIN').flatMap((v) => v.needs))];
  return { consensus, disagreement, unresolved };
}

export async function convene(input: {
  agentId: string;
  jobId?: string | null;
  proposition: string;
  evidence: { source: string; content: string; url?: string | null }[];
  roles?: readonly CouncilRole[];
  /** Swapped in tests; the gateway otherwise. */
  generateImpl?: (request: GenerateRequest) => Promise<GenerateResult>;
}): Promise<CouncilReport> {
  const proposition = input.proposition.trim().slice(0, 500);
  if (!proposition) throw new Error('A council needs a proposition to judge.');
  const roles = [...new Set(input.roles ?? COUNCIL_ROLES)].filter((r): r is CouncilRole => (COUNCIL_ROLES as readonly string[]).includes(r)).slice(0, 5);
  const evidence = input.evidence.slice(0, 12);
  const fenced = evidence
    .map((e, i) => `Evidence ${i + 1}:\n${fenceUntrusted({ content: e.content, source: e.source, tier: 'UNKNOWN', url: e.url ?? null })}`)
    .join('\n\n');
  const run = input.generateImpl ?? generate;

  const answers = await Promise.all(
    roles.map(async (role) => {
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), PER_CALL_MS);
      try {
        const result = await run({
          agentId: input.agentId,
          jobId: input.jobId ?? null,
          purpose: `council.${role.toLowerCase()}`,
          role: 'primary',
          // One call per specialist, never a chain.
          maxCalls: 1,
          signal: abort.signal,
          messages: [
            {
              role: 'user',
              content: [
                `You are the ${role.toLowerCase()} member of a council. ${BRIEF[role]}`,
                UNTRUSTED_PREAMBLE,
                `Judge only from the evidence below. Answer with JSON and nothing else: {"verdict": "SUPPORTS" | "OPPOSES" | "UNCERTAIN", "reasons": [up to 5 short sentences], "cites": [the numbers of the evidence each reason rests on], "needs": [if UNCERTAIN, what would settle it]}.`,
                `Proposition: ${proposition}`,
                fenced || 'There is no evidence.',
              ].join('\n\n'),
            },
          ],
        });
        return { role, result, error: null as string | null };
      } catch (error) {
        return { role, result: null, error: error instanceof Error ? error.message : String(error) };
      } finally {
        clearTimeout(timer);
      }
    }),
  );

  const views: CouncilView[] = [];
  const dropped: { role: CouncilRole; why: string }[] = [];
  for (const a of answers) {
    if (!a.result) {
      dropped.push({ role: a.role, why: `no answer: ${a.error?.slice(0, 160) ?? 'unknown'}` });
      continue;
    }
    const view = parseView(a.role, a.result.text, evidence.length);
    if (typeof view === 'string') dropped.push({ role: a.role, why: view });
    else views.push(view);
  }
  return {
    proposition,
    views,
    dropped,
    ...synthesize(views),
    calls: answers.length,
    modelCallIds: answers.flatMap((a) => (a.result ? [a.result.modelCallId] : [])),
  };
}
