import { createLogger } from '@xbam/shared';
import { defaultPermission, type CapabilityPermission } from '@xbam/shared/contracts';
import { listModelCallable, type AnyCapability } from '@xbam/tools';
import { shortlistCapabilities } from './capabilityRelevance';
import type { Lookup } from './research';

const log = createLogger('research-coverage');

/**
 * Not sending a question to a search engine when something here can answer it.
 *
 * ## The failure this removes
 *
 * The research step runs before the prompt is assembled and the capability
 * loop runs after it. So a question that a capability answers exactly was
 * being sent to the open web first, where it failed, and the failure arrived
 * in the prompt as a fact: this could not be checked. Measured on a real job,
 * an agent offered `time.now` and nothing else replied "I couldn't check your
 * local time". It was holding the answer and had already been told it did not
 * have one.
 *
 * The invariant is therefore about the order of two sources rather than about
 * any one question: **a lookup that an available capability already answers is
 * not worth a web search, and is worse than not worth it, because failing at
 * it argues the model out of the better source.**
 *
 * ## Why this is not a list of questions
 *
 * The first version of this was a pattern matching "what time is it". That is
 * a special case of a rule the codebase already has the machinery for, and it
 * held for the phrasing under test and not for the next one: the deterministic
 * rules dropped the clock, and the classifier that plans lookups for any
 * message carrying a question mark put it straight back.
 *
 * Both paths converge on the lookups this filters, so the rule is stated once
 * and applies to every capability rather than to one of them. Nothing here
 * knows what a clock is.
 *
 * ## The two questions it asks, both already declared
 *
 * *Can something answer this?* is `shortlistCapabilities`, the same
 * deterministic judge the loop uses to choose a menu. No model call, for the
 * reason `salience.ts` gives: which sources a later model call may see is
 * exactly the judgement an owner needs to be able to inspect.
 *
 * *Can it answer it now?* is `readiness`, the same declaration the permission
 * layer reads. This is the half that keeps the rule safe. `x.read_timeline`
 * matches a question about somebody's posts, but on an agent with no connected
 * account it reports UNAVAILABLE, and suppressing a web lookup on the strength
 * of a capability that cannot run would leave the question with no source at
 * all. A capability that declares no readiness is always available, which is
 * what `time.now` is.
 *
 * ## What it never does
 *
 * It does not decide the answer is known. A suppressed lookup means one source
 * was preferred over another, never that the gap is filled: the capability can
 * still fail or go uncalled, and the evidence verdict still requires the reply
 * to say it does not know. Nothing here relaxes that, and a capability that was
 * offered and not used is not evidence of anything.
 *
 * Only web searches. A DexScreener lookup for a contract address is a
 * different source answering a different question, and cheap.
 */

/**
 * One capability, and only one, may displace a lookup.
 *
 * The shortlist is tuned for offering a menu, where being too generous costs a
 * few hundred characters of prompt and the model ignores the rest. Removing a
 * source is not that: it is the only decision here that cannot be walked back
 * within the job, so it needs a stronger signal than "this might help".
 *
 * Measured, and this is why the number is one: "what did the protocol announce
 * at the summit today?" shortlists `defi.protocol_tvl`, on the word protocol.
 * A capability that returns a total-value-locked figure does not answer what
 * somebody announced, and suppressing the web on its say-so would be a worse
 * version of the bug this file exists to fix.
 *
 * When several claim a question the question is broad, the web stays, and
 * nothing is lost: the model is still offered all of them, and the prompt no
 * longer lets a failed lookup argue it out of calling one.
 */
const UNAMBIGUOUS = 1;

export interface CoverageInput {
  agentId: string;
  jobId: string | null;
  accountId: string | null;
  /**
   * The owner's stored decisions, so a capability switched off cannot suppress
   * a lookup it will never be offered to answer.
   */
  permissions: Map<string, CapabilityPermission>;
}

/** Everything this agent could actually be offered, before relevance. */
function availableTo(permissions: Map<string, CapabilityPermission>): AnyCapability[] {
  return listModelCallable().filter((capability) => {
    const stored = permissions.get(capability.id) ?? null;
    return (stored ?? defaultPermission(capability.effect, capability.risk)) !== 'DISABLED';
  });
}

async function readyNow(capability: AnyCapability, input: CoverageInput): Promise<boolean> {
  // No readiness declared means nothing has to be true for it to run.
  if (!capability.readiness) return true;
  const verdict = await capability
    .readiness({ agentId: input.agentId, jobId: input.jobId, accountId: input.accountId, config: {}, logger: log })
    .catch(() => undefined);
  return verdict?.status === 'AVAILABLE';
}

/**
 * The capability that already answers this query, if one is available.
 *
 * Exported for the tests, which is the only way to state the property without
 * standing up a pipeline.
 */
export async function answeredByCapability(
  query: string,
  input: CoverageInput,
): Promise<AnyCapability | null> {
  const shortlisted = shortlistCapabilities(availableTo(input.permissions), query).offered;
  if (shortlisted.length !== UNAMBIGUOUS) return null;
  const only = shortlisted[0]!;
  return (await readyNow(only, input)) ? only : null;
}

/**
 * Drop the web searches something here already answers.
 *
 * Only called when the capability loop is on. With it off nothing will be
 * offered, so the web is the only source there is and taking it away would
 * turn an answerable question into a shrug.
 */
export async function withoutWhatACapabilityAnswers(
  lookups: Lookup[],
  input: CoverageInput,
): Promise<{ kept: Lookup[]; dropped: { query: string; capabilityId: string }[] }> {
  const kept: Lookup[] = [];
  const dropped: { query: string; capabilityId: string }[] = [];

  for (const lookup of lookups) {
    if (lookup.kind !== 'search') {
      kept.push(lookup);
      continue;
    }
    const capability = await answeredByCapability(lookup.query, input);
    if (capability) {
      dropped.push({ query: lookup.query, capabilityId: capability.id });
      continue;
    }
    kept.push(lookup);
  }

  return { kept, dropped };
}
