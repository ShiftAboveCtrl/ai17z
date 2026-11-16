import {
  NarrativePulseChecks, NarrativeTermBatch, NarrativeTermReceipt, type NarrativeTermContribution,
} from '@xbam/shared/contracts';
import { studioInstallationRequest } from './studioLink';

/**
 * The Studio half of the narrative pulse, kept apart from the logic so a test can stand in for Studio.
 * Reading is a GET that asks for nothing about this installation; contributing sends only the
 * strictly parsed batch, which has no field that could carry an author, a handle or a post.
 */

export const NARRATIVE_PULSE_ROUTE = '/api/v1/installation/narrative-pulse';
export const NARRATIVE_PULSE_MAX_ANSWER_AGE_MS = 15 * 60_000;
const FUTURE_SLACK_MS = 5 * 60_000;

export type StudioProblem = { ok: false; why: string };

/** The day's checked counts, strictly parsed and current, or a sentence. Nothing is kept. */
export async function readNarrativePulseChecks(
  now: Date = new Date(),
): Promise<{ ok: true; checks: NarrativePulseChecks } | StudioProblem> {
  const answer = await studioInstallationRequest(NARRATIVE_PULSE_ROUTE, { method: 'GET' }).catch(
    () => ({ ok: false as const, why: 'Studio could not be reached.' }),
  );
  if (!answer.ok) return { ok: false, why: answer.why };
  if (answer.status !== 200) return { ok: false, why: answer.sentence };
  const parsed = NarrativePulseChecks.safeParse(answer.body);
  if (!parsed.success) return { ok: false, why: 'Studio answered with something other than the checks this installation reads, so none of it was used.' };
  const age = now.getTime() - Date.parse(parsed.data.generated_at);
  if (age > NARRATIVE_PULSE_MAX_ANSWER_AGE_MS || age < -FUTURE_SLACK_MS) {
    return { ok: false, why: "Studio's answer is not current, so it was not treated as live." };
  }
  return { ok: true, checks: parsed.data };
}

/** Sends the terms and nothing else. Returns a sentence when it did not go. */
export async function sendNarrativeTerms(terms: NarrativeTermContribution[]): Promise<{ ok: true } | StudioProblem> {
  if (terms.length === 0) return { ok: false, why: 'There was nothing to send.' };
  const batch = NarrativeTermBatch.parse({ protocol: 1, terms });
  const answer = await studioInstallationRequest(NARRATIVE_PULSE_ROUTE, { method: 'POST', json: batch }).catch(
    () => ({ ok: false as const, why: 'Studio could not be reached.' }),
  );
  if (!answer.ok) return { ok: false, why: answer.why };
  if (answer.status !== 200 || !NarrativeTermReceipt.safeParse(answer.body).success) {
    return { ok: false, why: 'Studio did not acknowledge the terms.' };
  }
  return { ok: true };
}
