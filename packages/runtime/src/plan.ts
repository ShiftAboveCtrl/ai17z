import { createLogger, errorMessage } from '@xbam/shared';
import { generate, resolveTargets } from '@xbam/models';
import type { Lookup } from './research';

const log = createLogger('plan');

/**
 * Asking the model what to look at, when the rules are not sure.
 *
 * The deterministic pass in `research.ts` is right about the two ends of the
 * range and knows it: "nice one" needs nothing, a contract address needs
 * DexScreener. It is the middle it cannot see, because the middle is a matter
 * of meaning rather than of pattern. "What did he roundtrip on? also whats the
 * weather like in Chicago today" is one question about a screenshot and one
 * about the weather, and no regular expression is going to tell you that the
 * first one is unanswerable without the picture.
 *
 * So this runs only where it earns its cost, on three conditions:
 *
 *  1. A `classifier` model is configured. That role exists precisely for cheap,
 *     fast, structured calls, and an owner who has not set one has said they do
 *     not want extra calls. There is no falling back to the primary: sending a
 *     planning question to an expensive reasoning model is the opposite of the
 *     point.
 *  2. There is genuinely something to decide -- a question was asked, or there
 *     is media, or a link. An ordinary reply never reaches this function.
 *  3. It answers quickly. A planning call that takes eight seconds has cost
 *     more than the mistake it was preventing.
 *
 * Anything that goes wrong -- no model, a timeout, malformed JSON, an answer
 * that fails its own schema -- falls back to what the rules decided. The plan is
 * an improvement on the deterministic answer or it is not used at all.
 */

export interface PlanInput {
  incoming: string;
  parent: string | null;
  /** True when the post or its parent carries an image, video or quote. */
  hasMedia: boolean;
  links: string[];
  /** What the rules decided, used as the fallback and shown to the model. */
  deterministic: Lookup[];
}

export interface Plan {
  lookups: Lookup[];
  /** True when answering depends on something only the image can say. */
  needsImage: boolean;
  /** Which decided this, for the trace. Never a claim, always a record. */
  decidedBy: 'rules' | 'model';
  /** Present when the model was asked and could not be used. */
  fellBackBecause?: string;
}

/** Below this there is nothing to plan: no question, no media, no link. */
export function worthPlanning(input: PlanInput): boolean {
  return (
    input.hasMedia ||
    input.links.length > 0 ||
    input.incoming.includes('?') ||
    input.deterministic.length > 0
  );
}

const INSTRUCTION = [
  'You are choosing what a social media agent should look up before it replies. Answer with JSON only.',
  '',
  'Schema:',
  '{"needsImage": boolean, "lookups": [{"kind": "search" | "token", "query": string, "reason": string}]}',
  '',
  'Rules:',
  '- "needsImage" is true when answering depends on something only the attached picture or video can tell you.',
  '- A question about what is IN the image is never a web search. A search engine will return something else that looks similar.',
  '- "search" is for a fact that exists in the world and may have changed: weather, prices, news, scores, what happened.',
  '- "token" is for a crypto ticker or contract address; the query is the ticker or address alone.',
  '- A search query must be a question a person would type, not a paste of the post.',
  '- Ask for nothing at all if the reply needs nothing. That is the common case and it is a good answer.',
  '- At most 3 lookups. Each must be a different question.',
].join('\n');

interface RawPlan {
  needsImage?: unknown;
  lookups?: unknown;
}

/**
 * Reads the model's answer, refusing anything that is not the agreed shape.
 *
 * Exported so the parsing is testable without a provider: every failure here
 * has to end in falling back to the rules rather than in a half-applied plan.
 */
export function parsePlan(text: string): { needsImage: boolean; lookups: Lookup[] } | null {
  // Models fence JSON however they like; take the outermost object.
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;

  let raw: RawPlan;
  try {
    raw = JSON.parse(text.slice(start, end + 1)) as RawPlan;
  } catch {
    return null;
  }

  if (!Array.isArray(raw.lookups)) return null;
  const lookups: Lookup[] = [];
  for (const item of raw.lookups.slice(0, 3)) {
    if (!item || typeof item !== 'object') continue;
    const entry = item as { kind?: unknown; query?: unknown; reason?: unknown };
    const kind = entry.kind === 'token' ? 'token' : entry.kind === 'search' ? 'search' : null;
    const query = typeof entry.query === 'string' ? entry.query.trim() : '';
    if (!kind || query.length < 2 || query.length > 200) continue;
    lookups.push({
      kind,
      query,
      reason:
        typeof entry.reason === 'string' && entry.reason.trim()
          ? entry.reason.trim().slice(0, 200)
          : 'The model judged this worth looking up.',
    });
  }

  return { needsImage: raw.needsImage === true, lookups };
}

/** Whether this agent has a model cheap enough to ask a planning question of. */
export async function hasPlanner(agentId: string): Promise<boolean> {
  const targets = await resolveTargets(agentId, 'classifier');
  return targets.length > 0;
}

/**
 * How long a planning call may take before it is not worth having.
 *
 * Six seconds is generous for a classifier answering forty tokens, and short
 * enough that a provider having a bad minute costs a reply six seconds rather
 * than a timeout's worth.
 */
const PLAN_TIMEOUT_MS = 6_000;

export async function planLookups(
  agentId: string,
  jobId: string | null,
  input: PlanInput,
): Promise<Plan> {
  const rules: Plan = { lookups: input.deterministic, needsImage: input.hasMedia, decidedBy: 'rules' };
  if (!worthPlanning(input)) return rules;
  if (!(await hasPlanner(agentId))) return rules;

  const described = [
    input.parent ? `The post being replied to: ${input.parent.slice(0, 400)}` : 'There is no post above this one.',
    `What they said to the agent: ${input.incoming.slice(0, 400)}`,
    input.hasMedia ? 'There is an image or video attached.' : 'Nothing is attached.',
    input.links.length > 0 ? `Links on the post: ${input.links.slice(0, 3).join(', ')}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  try {
    const result = await Promise.race([
      generate({
        agentId,
        jobId,
        purpose: 'reply.plan',
        role: 'classifier',
        // One call, never a chain. A planning question that retries its way
        // through three providers has cost more than the mistake it prevents.
        maxCalls: 1,
        messages: [{ role: 'user', content: `${INSTRUCTION}\n\n${described}` }],
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`planning took longer than ${PLAN_TIMEOUT_MS}ms`)), PLAN_TIMEOUT_MS),
      ),
    ]);

    const parsed = parsePlan(result.text);
    if (!parsed) return { ...rules, fellBackBecause: 'the planning model did not answer in the agreed shape' };

    // A plan that asks for an image where there is none is not a plan. Trusting
    // it would make the prompt admit to a gap that does not exist.
    return {
      lookups: parsed.lookups,
      needsImage: parsed.needsImage && input.hasMedia,
      decidedBy: 'model',
    };
  } catch (error) {
    const why = errorMessage(error);
    log.debug('planning fell back to the rules', { jobId, message: why });
    return { ...rules, fellBackBecause: why };
  }
}
