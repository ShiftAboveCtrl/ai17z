import { agents, capabilityInvocations, jobs, observability, query, withTransaction, type Tx } from '@xbam/database';
import { createLogger, PipelineError } from '@xbam/shared';
import { PolicyConfig } from '@xbam/shared/contracts';
import { getCapability, invokeCapability, resolvePermission } from '@xbam/tools';
import { CHECK_LINK_PREFIX, COMPARE_LINK_PREFIXES, renderEvidenceCard, renderEvidenceCompare, shortAddress, type CardReading } from '@xbam/prompts';
import { capabilitySettings } from './capabilityPermissions';
import { lpContractLines, type LpStatus } from './lpLock';
import { checkLinkUrl, linkedCheckOrigin, studioCheckLink } from './studioCheckLink';
import { pauseState } from './killSwitch';
import { evidenceCardRequest, evidenceCompareRequest } from './research';
import { checkEvidenceFollowUpAtSend } from './evidenceFollowUp';
import { readPromo } from './promo';
import type { JobBundle } from './loadJob';

const log = createLogger('evidence-card');
const CAP = 'token.inspect_risk';
const HOURLY_CAP = 10;
const COOLDOWN_MS = 60_000;
/** One side of a comparison: the mint the asker named and what was read for it. */
export interface CompareCardSide { address: string; readings: CardReading[]; }
/**
 * `link` is the check page address the text ends with, kept apart so the send check can prove it again.
 * A comparison carries `compare` instead, with one link per side that was read, and `linkLines` as the exact lines.
 */
export interface EvidenceCard {
  text: string; readings: CardReading[]; cardJobId: string | null; link?: string | null;
  compare?: { chain: string; sides: [CompareCardSide, CompareCardSide]; links: [string | null, string | null] };
  linkLines?: string[];
  /** Contract addresses that hold LP and were not proved as a timelock. Exact lines only. */
  lp?: LpStatus | null;
}

/** The exact contract lines a card carries, so the address rule can exempt those and nothing else. */
export function lpLinesOf(card: EvidenceCard | null): string[] {
  return lpContractLines(card?.lp);
}
export function evidenceCardOf(bundle: JobBundle): EvidenceCard | null {
  return (bundle.job.resolvedContext?.meta as { evidenceCard?: EvidenceCard } | undefined)?.evidenceCard ?? null;
}

/**
 * Mints read for this asker in the last hour, singles and pairs together.
 * A pair spends two, so the cap counts mints and not mentions.
 */
async function mintReadsThisHour(tx: Tx, agentId: string, requester: string, dryRun: boolean): Promise<number> {
  const row = await tx.one(`SELECT (SELECT count(*) FROM evidence_card_requests
      WHERE agent_id=$1 AND requester=$2 AND created_at>now()-interval '1 hour' AND dry_run=$3)::int
    + (SELECT count(*) FROM evidence_compare_requests
      WHERE agent_id=$1 AND requester=$2 AND created_at>now()-interval '1 hour' AND dry_run=$3)::int AS n`, [agentId, requester, dryRun]);
  return Number(row?.n);
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
  let lp: LpStatus | null = null;
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
        if (await mintReadsThisHour(tx, bundle.agent.id, requester, bundle.job.dryRun) >= HOURLY_CAP) return { card: null, capped: true };
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
        const output = result.output as { cardReadings?: CardReading[]; chain?: string; address?: string; lp?: LpStatus } | null;
        readings = output?.cardReadings ?? [];
        lp = readings.length ? output?.lp ?? null : null;
        const offer = request.chain === 'solana'
          ? `Owner: watch this with /watch ${bundle.job.id.slice(0, 8)} in paired Telegram; choose a condition and threshold.` : '';
        // The link needs its own owner opt-in, and only for the exact token the capability just read.
        const read = output?.chain === request.chain && output.address?.toLowerCase() === request.address.toLowerCase();
        link = read && bundle.policy.tools.evidenceCardLink && !bundle.policy.output.forbidLinks
          ? await studioCheckLink({ chain: request.chain, address: request.address, readings }) : null;
        text = readings.length ? renderEvidenceCard(readings, offer, undefined, link ?? '', lpContractLines(lp))
          : 'Token evidence unavailable; evidence not found. This is not a verdict, reads can be wrong.';
        // The inline card is the reply. A link that would push it past the length policy is left off
        // rather than sending the whole card to review: first the link, then the contract lines.
        if (link && text.length > bundle.policy.output.maxCharacters) {
          link = null;
          text = renderEvidenceCard(readings, offer, undefined, '', lpContractLines(lp));
        }
        if (readings.length && lp && text.length > bundle.policy.output.maxCharacters) {
          lp = null;
          text = renderEvidenceCard(readings, offer, undefined, link ?? '');
        }
      }
    }
  }
  const evidenceCard: EvidenceCard = { text, readings, cardJobId, link, lp };
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

const COMPARE_COOLING = 'One of these tokens was read a moment ago. Ask again in a minute; no new read was made.';
const ADDRESS_SHAPES = /\b(?:0x[a-fA-F0-9]{6,}|[1-9A-HJ-NP-Za-km-z]{32,44})\b/g;

function compareLines(links: readonly (string | null)[]): string[] {
  return links.flatMap((link, i) => link ? [`${COMPARE_LINK_PREFIXES[i]}${link}`] : []);
}

/**
 * Two exact mints on one chain, side by side, with no winner.
 *
 * It is the single card's own path twice over: the same capability, the same
 * permission and research budget, the same asker cap (counted in mints, so a
 * pair spends two), the same mint cooldown, and the same reticence, exchange
 * and cadence gates downstream because the result is an ordinary card on the
 * job. Columns follow the order the asker wrote the mints and are never ordered
 * by a value. A side whose read failed says unavailable and the other still renders.
 */
export async function researchEvidenceCompare(bundle: JobBundle): Promise<boolean> {
  if (!bundle.policy.tools.evidenceCards || bundle.job.actionType !== 'REPLY' ||
      !['MENTION', 'REPLY'].includes(bundle.event.type)) return false;
  const context = bundle.job.resolvedContext;
  if (!context) return false;
  const request = evidenceCompareRequest(context.incomingText);
  if (!request) return false;
  if (evidenceCardOf(bundle)) return true;
  const intent = (context.meta as { intent?: { intent?: string } })?.intent?.intent;
  const promo = readPromo(context.incomingText.replace(ADDRESS_SHAPES, ''));
  let text = request.refusal ?? '';
  let compare: EvidenceCard['compare'];
  let linkLines: string[] = [];
  if (intent === 'DEFLECT' || promo.level !== 'none' || /\b(?:buy now|join (?:our |the )?presale)\b/i.test(context.incomingText)) {
    text = 'I do not evaluate token pitches.';
  } else if (!text && 'a' in request) {
    const { a, b, chain } = request;
    if (!(await permitted(bundle.agent.id))) {
      text = 'Token evidence is unavailable under the current capability permissions.';
    } else if (bundle.policy.budget.maxResearchCallsPerEvent === 0) {
      text = 'Token evidence is unavailable because research is disabled.';
    } else if (bundle.policy.budget.maxResearchCallsPerEvent < 2) {
      text = 'A side by side needs two reads and the research budget allows one.';
    } else {
      const requester = `${bundle.job.channel}:${bundle.event.remoteAuthorId ?? bundle.event.remoteAuthorHandle ?? 'unknown'}`;
      // The same agent lock as a single card, so a pair and a single cannot both slip under one cap.
      const reserved = await withTransaction(async tx => {
        await tx.one('SELECT id FROM agents WHERE id=$1 FOR UPDATE', [bundle.agent.id]);
        if (await tx.one('SELECT job_id FROM evidence_compare_requests WHERE job_id=$1 LIMIT 1', [bundle.job.id])) return 'ok' as const;
        if (await mintReadsThisHour(tx, bundle.agent.id, requester, bundle.job.dryRun) + 2 > HOURLY_CAP) return 'capped' as const;
        const recent = await tx.one(`SELECT 1 AS hit WHERE EXISTS (SELECT 1 FROM evidence_card_requests
            WHERE agent_id=$1 AND chain=$2 AND address IN ($3,$4) AND dry_run=$5 AND card_job_id=job_id
              AND created_at>now()-($6::int * interval '1 millisecond'))
          OR EXISTS (SELECT 1 FROM evidence_compare_requests
            WHERE agent_id=$1 AND chain=$2 AND address IN ($3,$4) AND dry_run=$5
              AND created_at>now()-($6::int * interval '1 millisecond'))`,
        [bundle.agent.id, chain, a, b, bundle.job.dryRun, COOLDOWN_MS]);
        if (recent) return 'cooling' as const;
        for (const [side, address] of [a, b].entries()) {
          await tx.query(`INSERT INTO evidence_compare_requests(job_id,side,agent_id,requester,chain,address,dry_run)
            VALUES($1,$2,$3,$4,$5,$6,$7)`, [bundle.job.id, side, bundle.agent.id, requester, chain, address, bundle.job.dryRun]);
        }
        return 'ok' as const;
      });
      if (reserved === 'capped') text = 'The hourly token evidence limit for this asker has been reached.';
      else if (reserved === 'cooling') text = COMPARE_COOLING;
      else {
        const settings = await capabilitySettings(bundle.agent.id);
        const sides: CompareCardSide[] = [];
        const read: boolean[] = [];
        for (const [step, address] of [a, b].entries()) {
          const result = await invokeCapability({ call: { id: CAP, input: { chain, address } },
            context: { agentId: bundle.agent.id, jobId: bundle.job.id, accountId: bundle.job.accountId,
              config: settings.configs.get(CAP) ?? {}, logger: log, audience: 'PUBLIC' },
            permission: { stored: settings.permissions.get(CAP) ?? null, paused: (await pauseState()).paused } });
          await capabilityInvocations.recordInvocation({ agentId: bundle.agent.id, jobId: bundle.job.id, accountId: bundle.job.accountId,
            capabilityId: CAP, step, outcome: result.outcome, detail: result.detail,
            input: result.input, output: result.output, durationMs: result.durationMs });
          const output = result.output as { cardReadings?: CardReading[]; chain?: string; address?: string } | null;
          sides.push({ address, readings: output?.cardReadings ?? [] });
          read.push(output?.chain === chain && output.address?.toLowerCase() === address.toLowerCase());
        }
        const pair = sides as [CompareCardSide, CompareCardSide];
        const wantLinks = bundle.policy.tools.evidenceCardLink && !bundle.policy.output.forbidLinks;
        let links: [string | null, string | null] = [null, null];
        if (wantLinks) {
          links = [read[0] ? await studioCheckLink({ chain, address: a, readings: pair[0].readings }) : null,
            read[1] ? await studioCheckLink({ chain, address: b, readings: pair[1].readings }) : null];
        }
        const render = (l: readonly [string | null, string | null]) => renderEvidenceCompare(
          [{ short: shortAddress(a), readings: pair[0].readings }, { short: shortAddress(b), readings: pair[1].readings }], undefined, l);
        text = render(links);
        // Links that would push the pair past the length policy are left off, as for a single card.
        if ((links[0] || links[1]) && text.length > bundle.policy.output.maxCharacters) {
          links = [null, null];
          text = render(links);
        }
        linkLines = compareLines(links);
        compare = { chain, sides: pair, links };
      }
    }
  }
  const evidenceCard: EvidenceCard = { text, readings: [], cardJobId: compare ? bundle.job.id : null, link: null, compare, linkLines };
  const research = { findings: [{ kind: 'token', query: 'a' in request ? `${request.a} vs ${request.b}` : 'ambiguous token pair', source: CAP,
    title: 'Token evidence comparison', summary: text, url: null, retrievedAt: new Date().toISOString() }], failed: [], note: 'Deterministic token evidence comparison.' };
  const resolvedContext = { ...context, meta: { ...context.meta, evidenceCard, research } };
  await jobs.updateJob(bundle.job.id, { resolvedContext });
  bundle.job.resolvedContext = resolvedContext;
  await observability.emitTrace({ jobId: bundle.job.id, agentId: bundle.agent.id, type: 'RESEARCH_DONE',
    message: research.note, data: { capability: CAP, compare: true, readings: compare ? compare.sides.map(side => side.readings.length) : [] } });
  return true;
}

/**
 * The send check for a comparison. A queued pair obeys the owner's current
 * switches and Studio link, and goes to review rather than sending text that no
 * longer matches the readings behind it. An expired pair is not refreshed here:
 * a fresh pair is a fresh ask, and it spends two reads under the caps again.
 */
async function checkCompareAtSend(bundle: JobBundle, card: EvidenceCard, output: string): Promise<void> {
  const compare = card.compare;
  const current = await agents.getActivePolicy(bundle.agent.id);
  const policy = PolicyConfig.parse(current?.config ?? {});
  if (!policy.tools.evidenceCards || !(await permitted(bundle.agent.id))) {
    throw PipelineError.permanent('evidence_card_disabled', 'Token evidence replies or their capability were switched off.');
  }
  const shown = card.text.split('\n').filter(line => COMPARE_LINK_PREFIXES.some(prefix => line.startsWith(prefix)));
  if (shown.length > 0 || (card.linkLines?.length ?? 0) > 0) {
    const origin = compare && policy.tools.evidenceCardLink && !policy.output.forbidLinks ? await linkedCheckOrigin().catch(() => null) : null;
    const expected = origin && compare
      ? compareLines(compare.sides.map((side, i) => compare.links[i] ? checkLinkUrl(origin, compare.chain, side.address) : null))
      : null;
    const carried = card.linkLines ?? [];
    if (!expected || expected.length !== shown.length || expected.length !== carried.length
        || expected.some((line, i) => line !== shown[i] || line !== carried[i])) {
      throw PipelineError.review('evidence_card_changed', 'The check page link no longer matches the linked Studio or the owner setting. Generate a fresh card.');
    }
  }
  if (!compare) {
    if (output !== card.text) throw PipelineError.review('evidence_card_changed', 'The complete sourced evidence card changed. Generate a fresh card.');
    return;
  }
  const everything = compare.sides.flatMap(side => side.readings);
  const fetched = everything.map(reading => Date.parse(reading.fetchedAt ?? '')).filter(time => Number.isFinite(time));
  const asOf = fetched.length ? Math.max(...fetched) : Date.now();
  const rendered = renderEvidenceCompare(
    [{ short: shortAddress(compare.sides[0].address), readings: compare.sides[0].readings },
      { short: shortAddress(compare.sides[1].address), readings: compare.sides[1].readings }], asOf, compare.links);
  if (output !== card.text || rendered !== card.text || (everything.length > 0 && readingsExpired(everything))) {
    throw PipelineError.review('evidence_card_changed', 'The complete sourced evidence card changed or its readings expired. Generate a fresh card.');
  }
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

function sameLp(left: LpStatus | null, right: LpStatus | null): boolean {
  return JSON.stringify(left?.heldByContract ?? []) === JSON.stringify(right?.heldByContract ?? [])
    && left?.unlockAt === right?.unlockAt && Object.is(left?.burnedPct, right?.burnedPct) && Object.is(left?.lockedPct, right?.lockedPct);
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
function textMatchesReadings(text: string, readings: CardReading[], offer: string, link: string, lp: LpStatus | null = null): boolean {
  const fetched = readings.map(reading => Date.parse(reading.fetchedAt ?? '')).filter(time => Number.isFinite(time));
  const asOf = fetched.length ? Math.max(...fetched) : Date.now();
  return renderEvidenceCard(readings, offer, asOf, link, lpContractLines(lp)) === text;
}

/** The same inspect path a first card uses: permission, research budget, asker cap, mint cooldown, then the capability. */
async function rereadEvidenceCard(bundle: JobBundle, card: EvidenceCard): Promise<{ text: string; readings: CardReading[]; lp: LpStatus | null } | null> {
  const context = bundle.job.resolvedContext;
  const request = context ? evidenceCardRequest(context.incomingText) : null;
  if (!request?.address || !request.chain || request.refusal || !(await permitted(bundle.agent.id))) return null;
  if (bundle.policy.budget.maxResearchCallsPerEvent === 0) return null;
  const requester = `${bundle.job.channel}:${bundle.event.remoteAuthorId ?? bundle.event.remoteAuthorHandle ?? 'unknown'}`;
  const address = request.address.startsWith('0x') ? request.address.toLowerCase() : request.address;
  // One row per job. A re-read refreshes that row's time under the same agent lock the first read uses.
  const reserved = await withTransaction(async tx => {
    await tx.one('SELECT id FROM agents WHERE id=$1 FOR UPDATE', [bundle.agent.id]);
    if (await mintReadsThisHour(tx, bundle.agent.id, requester, bundle.job.dryRun) >= HOURLY_CAP) return false;
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
  const output = result.output as { cardReadings?: CardReading[]; lp?: LpStatus } | null;
  const readings = output?.cardReadings ?? [];
  if (!readings.length) return null;
  const lp = output?.lp ?? null;
  const offer = card.text.split('\n').find(line => line.startsWith('Owner:')) ?? '';
  return { text: renderEvidenceCard(readings, offer, undefined, card.link ?? '', lpContractLines(lp)), readings, lp };
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
  // A follow-up is held to its own facts first; the capability and opt-in checks below still apply.
  await checkEvidenceFollowUpAtSend(bundle, output);
  if (card.compare || card.linkLines) return checkCompareAtSend(bundle, card, output);
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
  const mismatched = card.readings.length > 0 && !textMatchesReadings(card.text, card.readings, offer, link, card.lp ?? null);
  if (output !== card.text || mismatched) {
    throw PipelineError.review('evidence_card_changed', 'The complete sourced evidence card changed or its readings expired. Generate a fresh card.');
  }
  if (card.readings.length > 0 && readingsExpired(card.readings)) {
    const fresh = await rereadEvidenceCard(bundle, card);
    // A new read carries a new fetch time, so the rendered lines never match
    // character for character. The same readings are the card the owner saw.
    if (fresh && sameReadings(fresh.readings, card.readings) && sameLp(fresh.lp, card.lp ?? null)) return;
    throw PipelineError.review('evidence_card_changed', fresh ? READINGS_CHANGED
      : 'The complete sourced evidence card changed or its readings expired. Generate a fresh card.');
  }
}
