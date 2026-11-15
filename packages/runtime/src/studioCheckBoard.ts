import { PipelineError, createLogger, errorMessage, sha256Hex } from '@xbam/shared';
import {
  CHECK_BOARD_BUCKET_MS, CHECK_BOARD_MAX_CONTRIBUTIONS, CHECK_BOARD_MIN_ASKERS, CHECK_BOARD_WINDOW_HOURS,
  CheckBoard, CheckContribution, CheckContributionBatch, CheckContributionReceipt, type CheckBoardRow, type PolicyConfig,
} from '@xbam/shared/contracts';
import { agents as agentsRepo, content as contentRepo, ops, query } from '@xbam/database';
import { unpromptedSubject } from './reticence';
import { studioInstallationRequest } from './studioLink';
import { FORWARD_LOOKING } from './studioPaperVoice';

const log = createLogger('studio-check-board');

/**
 * "Most checked today": what people asked agents to check, counted across
 * installations by Studio, and an optional daily post about it.
 *
 * It counts curiosity, never conviction, and says so in every sentence it
 * produces. Two separate owner switches, both off by default:
 * `studio.contributeChecks` (send counts) and `studio.postMostChecked` (post).
 *
 * ## What leaves this installation
 *
 * A mint, a UTC hour and a number of distinct askers. The asker identity is read
 * inside one SQL statement to be counted and never selected, so no later code
 * can send it by accident. An asker counts once per mint per 24 hours, in the
 * first hour they asked, so repeating a request cannot move a mint and neither
 * can one person spread over several hours. Dry runs and asks with no known
 * author are not counted: an unknown author is not a distinct person.
 *
 * ## What a post may say
 *
 * Only what Studio's board says, strictly parsed, current, above the floor and in
 * count order. The finished text is checked again at send, the board is read
 * again, and an unreachable Studio means nothing is posted.
 */

const CONTRIBUTE_ROUTE = '/api/v1/installation/check-board/contributions';
const BOARD_ROUTE = `/api/v1/installation/check-board?window_hours=${CHECK_BOARD_WINDOW_HOURS}`;
export const CHECK_BOARD_MAX_ANSWER_AGE_MS = 15 * 60_000;
const FUTURE_SLACK_MS = 5 * 60_000;
const ASKER_MEMORY_MS = CHECK_BOARD_WINDOW_HOURS * 3_600_000;
const SWEEP_EVERY = '10 minutes';
const DIGEST_ROWS = 3;
const CHECK_EVERY_MS = 3 * 3_600_000;

/** The `content_ideas.source` and the event's `ideaSource` for the daily digest. */
export const MOST_CHECKED_IDEA_SOURCE = 'studio_most_checked';

// ---------------------------------------------------------------------------
// Contributing
// ---------------------------------------------------------------------------

/** The agents whose owners opted in to contributing. Read from the live policy, never cached. */
async function contributingAgentIds(): Promise<string[]> {
  const rows = await query<{ agent_id: string }>(
    `SELECT DISTINCT agent_id FROM evidence_card_requests WHERE NOT dry_run AND created_at > now() - ($1::int * interval '1 hour')`,
    [CHECK_BOARD_WINDOW_HOURS * 2],
  );
  const ids: string[] = [];
  for (const { agent_id } of rows) {
    const policy = await agentsRepo.getActivePolicy(agent_id);
    if (policy?.config.studio?.contributeChecks === true) ids.push(agent_id);
  }
  return ids;
}

/**
 * Closed hour buckets of distinct askers for the opted-in agents. The only place the
 * asker string is read, and only to be counted.
 */
export async function closedBuckets(agentIds: string[], now: Date = new Date()): Promise<CheckContribution[]> {
  if (agentIds.length === 0) return [];
  const currentHour = Math.floor(now.getTime() / CHECK_BOARD_BUCKET_MS) * CHECK_BOARD_BUCKET_MS;
  const since = new Date(currentHour - ASKER_MEMORY_MS);
  const rows = await query<{ chain: string; address: string; bucket: Date; askers: number }>(
    `WITH consent AS (
       -- When consent began: the first policy version of the current unbroken run in which
       -- contributeChecks is true. Switching it off and on again starts a new run, so the gap
       -- is never sent. Policy versions are the only record; there is no second store.
       SELECT p.agent_id, min(pv.created_at) AS since
       FROM policies p JOIN policy_versions pv ON pv.policy_id = p.id
       WHERE p.agent_id = ANY($1::uuid[]) AND pv.config #>> '{studio,contributeChecks}' = 'true'
         AND pv.version > COALESCE((SELECT max(o.version) FROM policy_versions o
               WHERE o.policy_id = p.id AND o.config #>> '{studio,contributeChecks}' IS DISTINCT FROM 'true'), 0)
       GROUP BY p.agent_id
     )
     SELECT r.chain, r.address, date_trunc('hour', r.created_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' AS bucket,
            count(DISTINCT r.requester)::int AS askers
     FROM evidence_card_requests r JOIN consent c ON c.agent_id = r.agent_id
     WHERE r.agent_id = ANY($1::uuid[]) AND NOT r.dry_run
       AND r.created_at >= c.since
       AND r.requester NOT LIKE '%:unknown'
       AND r.created_at >= $2::timestamptz AND r.created_at < $3::timestamptz
       -- An asker counts in the first hour they asked about a mint, not again for 24 hours.
       AND NOT EXISTS (SELECT 1 FROM evidence_card_requests p
         WHERE p.agent_id = ANY($1::uuid[]) AND NOT p.dry_run AND p.requester = r.requester
           AND p.chain = r.chain AND p.address = r.address
           AND p.created_at >= c.since
           AND p.created_at < r.created_at AND p.created_at >= r.created_at - ($4::int * interval '1 hour'))
     GROUP BY 1, 2, 3 ORDER BY 3, 1, 2`,
    [agentIds, since.toISOString(), new Date(currentHour).toISOString(), CHECK_BOARD_WINDOW_HOURS],
  );
  const out: CheckContribution[] = [];
  for (const row of rows) {
    const parsed = CheckContribution.safeParse({
      chain: row.chain, mint: row.address, bucket_start: new Date(row.bucket).toISOString(), askers: row.askers,
    });
    // A request whose address is not a mint-shaped string is left out, not repaired.
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

/** Buckets the ledger does not already hold at the same count. */
async function unsent(candidates: CheckContribution[]): Promise<CheckContribution[]> {
  if (candidates.length === 0) return [];
  const held = await query<{ chain: string; address: string; bucket_start: Date; askers: number }>(
    'SELECT chain, address, bucket_start, askers FROM studio_check_contributions WHERE bucket_start >= $1::timestamptz',
    [candidates[0]!.bucket_start],
  );
  const have = new Map(held.map((h) => [`${h.chain}|${h.address}|${new Date(h.bucket_start).toISOString()}`, h.askers]));
  return candidates.filter((c) => have.get(`${c.chain}|${c.mint}|${c.bucket_start}`) !== c.askers);
}

export type ContributeResult = { sent: number; skipped?: string };

/** Worker sweep. Rides the existing loop; a persisted claim bounds concurrent workers and retries. */
export async function sweepCheckContributions(now: Date = new Date()): Promise<ContributeResult> {
  const agents = await contributingAgentIds();
  if (agents.length === 0) return { sent: 0, skipped: 'off' };
  const claimed = await query(
    `INSERT INTO app_settings (key, value) VALUES ('studio.check_board.attempt', to_jsonb(now()))
     ON CONFLICT (key) DO UPDATE SET value = excluded.value
     WHERE (app_settings.value #>> '{}')::timestamptz <= now() - interval '${SWEEP_EVERY}' RETURNING key`,
  );
  if (claimed.length === 0) return { sent: 0, skipped: 'rate' };
  const batchRows = (await unsent(await closedBuckets(agents, now))).slice(0, CHECK_BOARD_MAX_CONTRIBUTIONS);
  if (batchRows.length === 0) return { sent: 0, skipped: 'empty' };
  // Consent is read again immediately before sending: an owner who just switched it off is obeyed.
  const stillOn = await contributingAgentIds();
  if (stillOn.length !== agents.length || stillOn.some((id) => !agents.includes(id))) return { sent: 0, skipped: 'changed' };
  const batch = CheckContributionBatch.parse({ protocol: 1, contributions: batchRows });
  const answer = await studioInstallationRequest(CONTRIBUTE_ROUTE, { method: 'POST', json: batch }).catch(
    () => ({ ok: false as const, why: 'Studio could not be reached.' }),
  );
  if (!answer.ok) return { sent: 0, skipped: answer.why };
  if (answer.status !== 200 || !CheckContributionReceipt.safeParse(answer.body).success) {
    return { sent: 0, skipped: 'Studio did not acknowledge the contribution.' };
  }
  for (const c of batch.contributions) {
    await query(
      `INSERT INTO studio_check_contributions (chain, address, bucket_start, askers) VALUES ($1,$2,$3,$4)
       ON CONFLICT (chain, address, bucket_start) DO UPDATE SET askers = excluded.askers, sent_at = now()`,
      [c.chain, c.mint, c.bucket_start, c.askers],
    );
  }
  return { sent: batch.contributions.length };
}

// ---------------------------------------------------------------------------
// Reading the board
// ---------------------------------------------------------------------------

export type CheckBoardProblem = { ok: false; why: string };

/** The board, strictly parsed and current, or a sentence. Nothing is kept. */
export async function readCheckBoard(now: Date = new Date()): Promise<{ ok: true; board: CheckBoard } | CheckBoardProblem> {
  const answer = await studioInstallationRequest(BOARD_ROUTE, { method: 'GET' });
  if (!answer.ok) return answer;
  if (answer.status !== 200) return { ok: false, why: answer.sentence };
  const parsed = CheckBoard.safeParse(answer.body);
  if (!parsed.success) return { ok: false, why: 'Studio answered with something other than a checks board this installation reads, so none of it was used.' };
  const age = now.getTime() - Date.parse(parsed.data.generated_at);
  if (age > CHECK_BOARD_MAX_ANSWER_AGE_MS || age < -FUTURE_SLACK_MS) {
    return { ok: false, why: "Studio's answer is not current, so it was not treated as live." };
  }
  return { ok: true, board: parsed.data };
}

// ---------------------------------------------------------------------------
// Saying it
// ---------------------------------------------------------------------------

export const SAYS_NOT_ENDORSED = 'Checked, not endorsed: this counts what people asked about, not what is good.';

/** What this installation will list: above both floors, in count order, at most three. */
export function digestRows(board: CheckBoard): CheckBoardRow[] {
  const floor = Math.max(board.min_askers, CHECK_BOARD_MIN_ASKERS);
  return board.rows.filter((row) => row.askers >= floor).slice(0, DIGEST_ROWS);
}

const readingText = (r: CheckBoardRow['readings'][number]): string | null => {
  if (r.value === null) return null;
  return typeof r.value === 'boolean' ? `${r.label}: ${r.value ? 'yes' : 'no'}` : `${r.label}: ${r.value} ${r.unit}`;
};

export function mostCheckedIdea(board: CheckBoard): { key: string; summary: string; detail: string } | null {
  const rows = digestRows(board);
  if (rows.length === 0) return null;
  const summary = [`Most checked in the last ${board.window_hours} hours on AI17Z Studio. ${SAYS_NOT_ENDORSED}`,
    ...rows.map((row, i) => `${i + 1}. ${row.mint} (${row.chain}): ${row.askers} askers`)].join(' ');
  const detail = [
    'Facts, ordered by number of distinct askers and by nothing else. The order says how often a token was asked about, never how good it is.',
    ...rows.map((row) => `${row.mint}: ${row.askers} askers. ${row.readings.map(readingText).filter(Boolean).join('; ') || 'No measured readings.'}`),
    'Say it was checked, not endorsed. Name no advice, no prediction, no verdict. Use only the addresses above.',
  ].join('\n');
  const key = `${new Date(board.generated_at).toISOString().slice(0, 10)}:${sha256Hex(rows.map((r) => `${r.chain}|${r.mint}|${r.askers}`).join(','))}`;
  return { key, summary: summary.slice(0, 500), detail };
}

interface DigestMemo { checkedAt: string; day: string | null }
const memoKey = (agentId: string) => `studio.check_board.digest.${agentId}`;

export type MostCheckedOutcome = { proposed: boolean; why: string };

/**
 * Called when the posting schedule comes due. Adds at most one idea per UTC day, only for
 * an opted-in agent, only from a reachable, current board. The idea backlog and the
 * posting engine still decide whether and when it is said.
 */
export async function proposeMostCheckedPost(agentId: string, now: Date = new Date()): Promise<MostCheckedOutcome> {
  try {
    const policy = await agentsRepo.getActivePolicy(agentId);
    if (!policy?.config.studio?.postMostChecked) return { proposed: false, why: 'Posting the most checked tokens is off.' };
    const memo = await ops.getSetting<DigestMemo>(memoKey(agentId));
    const today = now.toISOString().slice(0, 10);
    if (memo?.day === today) return { proposed: false, why: 'Already proposed today.' };
    if (memo && now.getTime() - Date.parse(memo.checkedAt) < CHECK_EVERY_MS) return { proposed: false, why: 'Studio was asked recently.' };
    const remember = (day: string | null) => ops.setSetting(memoKey(agentId), { checkedAt: now.toISOString(), day } satisfies DigestMemo);
    const read = await readCheckBoard(now);
    if (!read.ok) { await remember(null); return { proposed: false, why: read.why }; }
    const idea = mostCheckedIdea(read.board);
    if (!idea) { await remember(null); return { proposed: false, why: 'No token has enough distinct askers to be listed.' }; }
    const reticent = unpromptedSubject(idea.summary);
    if (reticent) { await remember(today); return { proposed: false, why: `Not raised unprompted: ${reticent.subject}.` }; }
    if (await contentRepo.similarExists(agentId, idea.summary)) { await remember(today); return { proposed: false, why: 'The backlog already holds this.' }; }
    await contentRepo.addIdea({ agentId, kind: 'observation', summary: idea.summary, detail: idea.detail,
      source: MOST_CHECKED_IDEA_SOURCE, sourceHandle: null, sourceJobId: null, score: 50 });
    await remember(today);
    return { proposed: true, why: 'The most checked tokens were added to the idea backlog.' };
  } catch (error) {
    // Optional; a failure here must never stop the posting engine doing everything else.
    log.warn('most checked proposal failed', { agentId, message: errorMessage(error) });
    return { proposed: false, why: 'Studio could not be asked just now.' };
  }
}

// ---------------------------------------------------------------------------
// The check on the finished text
// ---------------------------------------------------------------------------

const ADVICE = /\b(buy|sell|ape|aping|aped|hold|hodl|long|short|moon\w*|gems?|pumps?|bullish|bearish|safe|legit|trust\w*|recommend\w*|endorse[sd]?|worth|undervalued|best|top pick|winners?|must|should|dyor)\b/i;
const ADDRESS = /\b0x[0-9a-fA-F]{40}\b|\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g;
const NOT_ENDORSED = /not\s+endorsed/i;
const CHECKED = /\bchecked\b/i;

/** Problems with the finished text, as sentences. Empty when there are none. `facts` is the idea summary the text came from. */
export function checkMostCheckedText(text: string, facts: string): string[] {
  const problems: string[] = [];
  if (!CHECKED.test(text) || !NOT_ENDORSED.test(text)) problems.push('It does not say the tokens were checked, not endorsed.');
  // "not endorsed" is the one place a negated endorsement word is fine; the rest is held to the advice list.
  const withoutFraming = text.replace(/not\s+endorsed/gi, '').replace(/\bchecked\b/gi, '');
  const advice = ADVICE.exec(withoutFraming);
  if (advice) problems.push(`It reads as advice or a verdict ("${advice[0]}").`);
  if (FORWARD_LOOKING.test(text)) problems.push('It reads as a promise, a signal or advice about what comes next.');
  const known = new Set((facts.match(ADDRESS) ?? []).map((a) => a.toLowerCase()));
  const stray = (text.match(ADDRESS) ?? []).find((a) => !known.has(a.toLowerCase()));
  if (stray) problems.push('It names an address that is not on the board.');
  if (/@[A-Za-z0-9_]{1,15}\b/.test(text)) problems.push('It names an account.');
  return problems;
}

/**
 * The last word, at the moment of sending. The owner may have switched posting off since the idea was made, the
 * text may have been edited in review, and Studio must still be reachable: with no board nothing is posted.
 */
export async function checkMostCheckedAtSend(input: { raw: unknown; text: string; policy: PolicyConfig; now?: Date }): Promise<void> {
  const raw = (input.raw ?? {}) as { ideaSource?: unknown; ideaSummary?: unknown };
  if (raw.ideaSource !== MOST_CHECKED_IDEA_SOURCE) return;
  if (!input.policy.studio.postMostChecked) {
    throw PipelineError.permanent('most_checked_posting_off', 'Posting the most checked tokens was switched off after this post was written, so it was not sent.');
  }
  const problems = checkMostCheckedText(input.text, typeof raw.ideaSummary === 'string' ? raw.ideaSummary : '');
  if (problems.length > 0) throw PipelineError.review('most_checked_text', `This most checked post needs the owner: ${problems.join(' ')}`);
  const read = await readCheckBoard(input.now);
  if (!read.ok) throw PipelineError.retryable('most_checked_studio_unreachable', `Nothing was posted: ${read.why}`, { retryAfterMs: 15 * 60_000 });
  const listed = new Set(digestRows(read.board).map((row) => row.mint.toLowerCase()));
  const stale = (input.text.match(ADDRESS) ?? []).find((a) => !listed.has(a.toLowerCase()));
  if (stale) throw PipelineError.review('most_checked_changed', 'The board no longer lists a token this post names. Generate a fresh post.');
}
