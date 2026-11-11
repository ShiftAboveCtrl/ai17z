import { agents, capabilityInvocations, jobs, observability, query, withTransaction } from '@xbam/database';
import { createLogger, PipelineError } from '@xbam/shared';
import { PolicyConfig } from '@xbam/shared/contracts';
import { getCapability, invokeCapability, resolvePermission } from '@xbam/tools';
import { renderEvidenceCard, type CardReading } from '@xbam/prompts';
import { capabilitySettings } from './capabilityPermissions';
import { pauseState } from './killSwitch';
import { evidenceCardRequest } from './research';
import { readPromo } from './promo';
import type { JobBundle } from './loadJob';

const log = createLogger('evidence-card');
const CAP = 'token.inspect_risk';
const HOURLY_CAP = 10;
const COOLDOWN_MS = 60_000;
export interface EvidenceCard { text: string; readings: CardReading[]; cardJobId: string | null; }
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
        const output = result.output as { cardReadings?: CardReading[] } | null;
        readings = output?.cardReadings ?? [];
        text = readings.length ? renderEvidenceCard(readings, request.chain === 'solana'
          ? `Owner: watch this with /watch ${bundle.job.id.slice(0, 8)} in paired Telegram; choose a condition and threshold.` : '')
          : 'Token evidence unavailable; evidence not found. This is not a verdict, reads can be wrong.';
      }
    }
  }
  const evidenceCard: EvidenceCard = { text, readings, cardJobId };
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

/** Current owner consent and capability permissions apply even to an old queued card. */
export async function checkEvidenceCardAtSend(bundle: JobBundle, output: string): Promise<void> {
  const card = evidenceCardOf(bundle);
  if (!card) return;
  const current = await agents.getActivePolicy(bundle.agent.id);
  if (!PolicyConfig.parse(current?.config ?? {}).tools.evidenceCards || !(await permitted(bundle.agent.id))) {
    throw PipelineError.permanent('evidence_card_disabled', 'Token evidence replies or their capability were switched off.');
  }
  if (output !== card.text || (card.readings.length && renderEvidenceCard(card.readings, card.text.split('\n').find(l => l.startsWith('Owner:')) ?? '') !== card.text)) {
    throw PipelineError.review('evidence_card_changed', 'The complete sourced evidence card changed or its readings expired. Generate a fresh card.');
  }
}
