import { agents, capabilityInvocations, jobs, observability, query, withTransaction } from '@xbam/database';
import { createLogger, PipelineError } from '@xbam/shared';
import { PolicyConfig } from '@xbam/shared/contracts';
import { getCapability, invokeCapability, resolvePermission } from '@xbam/tools';
import { CHECK_LINK_PREFIX, renderEvidenceCard, type CardReading } from '@xbam/prompts';
import { capabilitySettings } from './capabilityPermissions';
import { checkLinkUrl, linkedCheckOrigin, studioCheckLink } from './studioCheckLink';
import { pauseState } from './killSwitch';
import { evidenceCardRequest } from './research';
import { readPromo } from './promo';
import type { JobBundle } from './loadJob';

const log = createLogger('evidence-card');
const CAP = 'token.inspect_risk';
const HOURLY_CAP = 10;
const COOLDOWN_MS = 60_000;
/** `link` is the check page address the text ends with, kept apart so the send check can prove it again. */
export interface EvidenceCard { text: string; readings: CardReading[]; cardJobId: string | null; link?: string | null; }
export function evidenceCardOf(bundle: JobBundle): EvidenceCard | null {
  return (bundle.job.resolvedContext?.meta as { evidenceCard?: EvidenceCard } | undefined)?.evidenceCard ?? null;
}

async function permitted(agentId: string): Promise<boolean> {
  const capability = getCapability(CAP);
  if (!capability) return false;
  const settings = await capabilitySettings(agentId);
  return resolvePermission({ capability, stored: settings.permissions.get(CAP) ?? null,
    paused: (await pauseState()).paused }).allowed;
}

/** Called after engagement and intent. Only a direct invitation may enter this branch. */
export async function researchEvidenceCard(bundle: JobBundle): Promise<boolean> {
  if (!bundle.policy.tools.evidenceCards || bundle.job.actionType !== 'REPLY' ||
      !['MENTION', 'REPLY'].includes(bundle.event.type)) return false;
  const context = bundle.job.resolvedContext;
  if (!context) return false;
  const request = evidenceCardRequest(context.incomingText);
  if (!request) return false;
  if (evidenceCardOf(bundle)) return true;
  const intent = (context.meta as { intent?: { intent?: string } })?.intent?.intent;
  let text = request.refusal ?? '';
  let cardJobId: string | null = null;
  let link: string | null = null;
  let readings: CardReading[] = [];
  const promo = readPromo(context.incomingText.replace(request.address ?? /$^/, ''));
  if (intent === 'DEFLECT' || promo.level !== 'none' || /\b(?:buy now|join (?:our |the )?presale)\b/i.test(context.incomingText)) {
    text = 'I do not evaluate token pitches.';
  } else if (!text && request.address && request.chain) {
    if (!(await permitted(bundle.agent.id))) {
      text = 'Token evidence is unavailable under the current capability permissions.';
    } else if (bundle.policy.budget.maxResearchCallsPerEvent === 0) {
      text = 'Token evidence is unavailable because research is disabled.';
    } else {
      // One agent lock covers both caps, including different mints from one asker.
      // The row survives restarts and reserves a read before any upstream I/O.
      const reserved = await withTransaction(async tx => {
        await tx.one('SELECT id FROM agents WHERE id=$1 FOR UPDATE', [bundle.agent.id]);
        const prior = await tx.one('SELECT card_job_id FROM evidence_card_requests WHERE job_id=$1', [bundle.job.id]);
        if (prior) return { card: prior.card_job_id as string | null, capped: false };
        const requester = `${bundle.job.channel}:${bundle.event.remoteAuthorId ?? bundle.event.remoteAuthorHandle ?? 'unknown'}`;
        const count = await tx.one(`SELECT count(*)::int AS n FROM evidence_card_requests
          WHERE agent_id=$1 AND requester=$2 AND created_at>now()-interval '1 hour' AND dry_run=$3`, [bundle.agent.id, requester, bundle.job.dryRun]);
        if (Number(count?.n) >= HOURLY_CAP) return { card: null, capped: true };
        const address = request.address!.startsWith('0x') ? request.address!.toLowerCase() : request.address!;
        const previous = await tx.one(`SELECT r.job_id FROM evidence_card_requests r
          WHERE agent_id=$1 AND chain=$2 AND address=$3 AND dry_run=$4 AND card_job_id=job_id
            AND created_at>now()-($5::int * interval '1 millisecond') ORDER BY created_at DESC LIMIT 1`,
        [bundle.agent.id, request.chain!, address, bundle.job.dryRun, COOLDOWN_MS]);
        const card = (previous?.job_id as string | undefined) ?? bundle.job.id;
        await tx.query(`INSERT INTO evidence_card_requests(job_id,agent_id,requester,chain,address,dry_run,card_job_id)
          VALUES($1,$2,$3,$4,$5,$6,$7)`, [bundle.job.id, bundle.agent.id, requester, request.chain!, address, bundle.job.dryRun, card]);
        return { card, capped: false };
      });
      cardJobId = reserved.card;
      if (reserved.capped) text = 'The hourly token evidence limit for this asker has been reached.';
      else if (cardJobId !== bundle.job.id) {
        const [published] = await query(`SELECT remote_action_url FROM actions WHERE job_id=$1 AND status='EXECUTED' AND NOT dry_run ORDER BY executed_at LIMIT 1`, [cardJobId]);
        const url = published?.remote_action_url;
        text = `Recent evidence: ${typeof url === 'string' && /^(https?:|mock:)/.test(url) ? url : `card ${cardJobId?.slice(0, 8)} is pending`}. Reads can be wrong; no new read was made.`;
      } else {
        const settings = await capabilitySettings(bundle.agent.id);
        const result = await invokeCapability({ call: { id: CAP, input: { chain: request.chain, address: request.address } },
          context: { agentId: bundle.agent.id, jobId: bundle.job.id, accountId: bundle.job.accountId,
            config: settings.configs.get(CAP) ?? {}, logger: log, audience: 'PUBLIC' },
          permission: { stored: settings.permissions.get(CAP) ?? null, paused: (await pauseState()).paused } });
        await capabilityInvocations.recordInvocation({ agentId: bundle.agent.id, jobId: bundle.job.id, accountId: bundle.job.accountId,
          capabilityId: CAP, step: 0, outcome: result.outcome, detail: result.detail,
          input: result.input, output: result.output, durationMs: result.durationMs });
        const output = result.output as { cardReadings?: CardReading[]; chain?: string; address?: string } | null;
        readings = output?.cardReadings ?? [];
        const offer = request.chain === 'solana'
          ? `Owner: watch this with /watch ${bundle.job.id.slice(0, 8)} in paired Telegram; choose a condition and threshold.` : '';
        // The link needs its own owner opt-in, and only for the exact token the capability just read.
        const read = output?.chain === request.chain && output.address?.toLowerCase() === request.address.toLowerCase();
        link = read && bundle.policy.tools.evidenceCardLink && !bundle.policy.output.forbidLinks
          ? await studioCheckLink({ chain: request.chain, address: request.address, readings }) : null;
        text = readings.length ? renderEvidenceCard(readings, offer, undefined, link ?? '')
          : 'Token evidence unavailable; evidence not found. This is not a verdict, reads can be wrong.';
        // The inline card is the reply. A link that would push it past the length policy is left off
        // rather than sending the whole card to review.
        if (link && text.length > bundle.policy.output.maxCharacters) {
          link = null;
          text = renderEvidenceCard(readings, offer);
        }
      }
    }
  }
  const evidenceCard: EvidenceCard = { text, readings, cardJobId, link };
  // Evidence retains the same fence and attribution as ordinary research.
  const research = { findings: [{ kind: 'token', query: request.address ?? 'ambiguous token', source: CAP,
    title: 'Token evidence card', summary: text, url: null, retrievedAt: new Date().toISOString() }], failed: [], note: 'Deterministic token evidence reply.' };
  const resolvedContext = { ...context, meta: { ...context.meta, evidenceCard, research } };
  await jobs.updateJob(bundle.job.id, { resolvedContext });
  bundle.job.resolvedContext = resolvedContext;
  await observability.emitTrace({ jobId: bundle.job.id, agentId: bundle.agent.id, type: 'RESEARCH_DONE',
    message: research.note, data: { capability: CAP, cardJobId, readings: readings.length } });
  return true;
}

const READINGS_CHANGED = 'The readings changed since you looked.';

/** Fetch times always move. What the owner approved is the readings themselves. */
function sameReadings(left: CardReading[], right: CardReading[]): boolean {
  return left.length === right.length && left.every((reading, index) => {
    const other = right[index];
    return !!other && reading.label === other.label && reading.unit === other.unit
      && reading.source === other.source && Object.is(reading.value, other.value);
  });
}

function readingsExpired(readings: CardReading[], now = Date.now()): boolean {
  return readings.some(reading => {
    const fetched = Date.parse(reading.fetchedAt ?? '');
    const observed = Date.parse(reading.observedAt ?? '');
    return ![fetched, observed].every(t => Number.isFinite(t) && now - t <= reading.maxAgeMs && t <= now + 30_000);
  });
}

/**
 * Whether the stored text is the card those readings render.
 *
 * Rendered at the fetch time, so a reading that has since expired still
 * shows the value the owner approved. Rendering at the current time would
 * call that same card a mismatch.
 */
function textMatchesReadings(text: string, readings: CardReading[], offer: string, link: string): boolean {
  const fetched = readings.map(reading => Date.parse(reading.fetchedAt ?? '')).filter(time => Number.isFinite(time));
  const asOf = fetched.length ? Math.max(...fetched) : Date.now();
  return renderEvidenceCard(readings, offer, asOf, link) === text;
}

/** The same inspect path a first card uses: permission, research budget, asker cap, mint cooldown, then the capability. */
async function rereadEvidenceCard(bundle: JobBundle, card: EvidenceCard): Promise<{ text: string; readings: CardReading[] } | null> {
  const context = bundle.job.resolvedContext;
  const request = context ? evidenceCardRequest(context.incomingText) : null;
  if (!request?.address || !request.chain || request.refusal || !(await permitted(bundle.agent.id))) return null;
  if (bundle.policy.budget.maxResearchCallsPerEvent === 0) return null;
  const requester = `${bundle.job.channel}:${bundle.event.remoteAuthorId ?? bundle.event.remoteAuthorHandle ?? 'unknown'}`;
  const address = request.address.startsWith('0x') ? request.address.toLowerCase() : request.address;
  // One row per job. A re-read refreshes that row's time under the same agent lock the first read uses.
  const reserved = await withTransaction(async tx => {
    await tx.one('SELECT id FROM agents WHERE id=$1 FOR UPDATE', [bundle.agent.id]);
    const count = await tx.one(`SELECT count(*)::int AS n FROM evidence_card_requests
      WHERE agent_id=$1 AND requester=$2 AND created_at>now()-interval '1 hour' AND dry_run=$3`,
    [bundle.agent.id, requester, bundle.job.dryRun]);
    if (Number(count?.n) >= HOURLY_CAP) return false;
    // This job's own read is the card being refreshed, so it does not cool itself down.
    const previous = await tx.one(`SELECT job_id FROM evidence_card_requests
      WHERE agent_id=$1 AND chain=$2 AND address=$3 AND dry_run=$4 AND card_job_id=job_id AND job_id<>$5
        AND created_at>now()-($6::int * interval '1 millisecond') LIMIT 1`,
    [bundle.agent.id, request.chain, address, bundle.job.dryRun, bundle.job.id, COOLDOWN_MS]);
    if (previous) return false;
    const existing = await tx.one('SELECT job_id FROM evidence_card_requests WHERE job_id=$1', [bundle.job.id]);
    if (existing) await tx.query('UPDATE evidence_card_requests SET created_at=now() WHERE job_id=$1', [bundle.job.id]);
    else await tx.query(`INSERT INTO evidence_card_requests(job_id,agent_id,requester,chain,address,dry_run,card_job_id)
      VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [bundle.job.id, bundle.agent.id, requester, request.chain, address, bundle.job.dryRun, card.cardJobId ?? bundle.job.id]);
    return true;
  });
  if (!reserved) return null;
  const settings = await capabilitySettings(bundle.agent.id);
  const result = await invokeCapability({ call: { id: CAP, input: { chain: request.chain, address: request.address } },
    context: { agentId: bundle.agent.id, jobId: bundle.job.id, accountId: bundle.job.accountId,
      config: settings.configs.get(CAP) ?? {}, logger: log, audience: 'PUBLIC' },
    permission: { stored: settings.permissions.get(CAP) ?? null, paused: (await pauseState()).paused } });
  await capabilityInvocations.recordInvocation({ agentId: bundle.agent.id, jobId: bundle.job.id, accountId: bundle.job.accountId,
    capabilityId: CAP, step: 0, outcome: result.outcome, detail: result.detail,
    input: result.input, output: result.output, durationMs: result.durationMs });
  const output = result.output as { cardReadings?: CardReading[] } | null;
  const readings = output?.cardReadings ?? [];
  if (!readings.length) return null;
  const offer = card.text.split('\n').find(line => line.startsWith('Owner:')) ?? '';
  return { text: renderEvidenceCard(readings, offer, undefined, card.link ?? ''), readings };
}

/**
 * Current owner consent and capability permissions apply even to an old queued card.
 *
 * Readings expire after five minutes. Only expiry starts another read. The
 * owner approved a text, so that text sends when the new readings match.
 * Changed readings, or any text that does not match its readings, go back to
 * review. The approved text stays as the owner left it.
 */
export async function checkEvidenceCardAtSend(bundle: JobBundle, output: string): Promise<void> {
  const card = evidenceCardOf(bundle);
  if (!card) return;
  const current = await agents.getActivePolicy(bundle.agent.id);
  if (!PolicyConfig.parse(current?.config ?? {}).tools.evidenceCards || !(await permitted(bundle.agent.id))) {
    throw PipelineError.permanent('evidence_card_disabled', 'Token evidence replies or their capability were switched off.');
  }
  const offer = card.text.split('\n').find(line => line.startsWith('Owner:')) ?? '';
  const link = card.link ?? '';
  // A queued card may predate the owner switching the link off, or Studio being unlinked or
  // re-pointed. Whatever address the text carries must be the one the linked Studio would give now.
  const linkLines = card.text.split('\n').filter(line => line.startsWith(CHECK_LINK_PREFIX));
  if (link || linkLines.length > 0) {
    const policy = PolicyConfig.parse(current?.config ?? {});
    const request = evidenceCardRequest(bundle.job.resolvedContext?.incomingText ?? '');
    const origin = link && request?.address && request.chain && policy.tools.evidenceCardLink && !policy.output.forbidLinks
      ? await linkedCheckOrigin().catch(() => null) : null;
    const expected = origin && request?.address && request.chain ? checkLinkUrl(origin, request.chain, request.address) : null;
    if (!expected || expected !== link || linkLines.length !== 1 || linkLines[0] !== `${CHECK_LINK_PREFIX}${link}`) {
      throw PipelineError.review('evidence_card_changed', 'The check page link no longer matches the linked Studio or the owner setting. Generate a fresh card.');
    }
  }
  const mismatched = card.readings.length > 0 && !textMatchesReadings(card.text, card.readings, offer, link);
  if (output !== card.text || mismatched) {
    throw PipelineError.review('evidence_card_changed', 'The complete sourced evidence card changed or its readings expired. Generate a fresh card.');
  }
  if (card.readings.length > 0 && readingsExpired(card.readings)) {
    const fresh = await rereadEvidenceCard(bundle, card);
    // A new read carries a new fetch time, so the rendered lines never match
    // character for character. The same readings are the card the owner saw.
    if (fresh && sameReadings(fresh.readings, card.readings)) return;
    throw PipelineError.review('evidence_card_changed', fresh ? READINGS_CHANGED
      : 'The complete sourced evidence card changed or its readings expired. Generate a fresh card.');
  }
}
