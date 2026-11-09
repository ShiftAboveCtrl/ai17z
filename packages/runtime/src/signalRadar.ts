import { signalWatchKey, errorMessage } from '@xbam/shared';
import { SignalUniverse, type SignalObservation, type SignalState, type SignalWatch } from '@xbam/shared/contracts';
import { query, radar, withTransaction, type RadarSourceRow } from '@xbam/database';
import { ask, GECKO_FAMILY, SOLANA_FAMILY, exactInteger, isAddress, isSignature, type GeckoQuery, type GeckoResult, type SolanaQuery, type SolanaResult } from '@xbam/upstream';
import { unpromptedSubject, reticenceReason } from './reticence';
import { readPromo } from './promo';

export const SIGNAL_MAX_AGE_MS = 5 * 60_000;

export function signalPublicationRefusal(text: string): string | null {
  // A mint ending in `pump` is an identity, never promotional language.
  text = text.replace(/[A-Za-z0-9]{6}\.\.\.[A-Za-z0-9]{4}/g, 'address');
  const reticent = unpromptedSubject(text);
  if (reticent) return reticenceReason(reticent);
  if (readPromo(text).level === 'strong') return 'Strong token pitches are declined outright.';
  // None of these predicates measures price, returns, or who owns an address.
  // Reject that register instead of letting a disclaimer launder it.
  if (/\b(?:buy|sell|ape|invest|accumulate|long|short|prices?|profits?|returns?|bullish|bearish|unruggable)\b|\brug[ -]?proof\b|\b(?:safe|guaranteed|risk[ -]?free)\b|\b(?:token|coin|it)\s+(?:will|gonna|is going to)\b|\b(?:headed|heading)\s+(?:for|to)\b|\b(?:dev|developer|whale)\s+(?:wallet|address)\b|\$[A-Za-z]|\b(?:moon|100x|double|pump)\b/i.test(text)) {
    return 'Signal observations cannot give financial advice, price predictions or safety verdicts.';
  }
  return null;
}

/** Missing data cannot clear a latch or establish a baseline. */
export function evaluateSignal(watch: SignalWatch, previous: SignalState | null, read: SignalObservation, now = Date.now()) {
  const idle = (reason: string) => ({ state: previous, transition: false, before: previous?.latest ?? null, reason });
  const age = now - Date.parse(read.observedAt);
  if (!Number.isFinite(age) || age > SIGNAL_MAX_AGE_MS || age < -30_000) return idle('Observation stale or its time is unavailable.');
  const numeric = watch.predicate === 'liquidity_below' || watch.predicate === 'concentration_above';
  if (read.value === null || (numeric && (typeof read.value !== 'number' || !Number.isFinite(read.value) || read.value < 0)) ||
      (watch.predicate === 'new_pool' && !Array.isArray(read.value)) ||
      (watch.predicate === 'wallet_transaction' && typeof read.value !== 'string')) return idle('Reading unavailable; retained baseline unchanged.');
  if (watch.predicate === 'new_pool' && (read.value as string[]).some(id => !Number.isFinite(Date.parse(read.poolCreatedAt?.[id] ?? '')))) {
    return idle('Pool creation time unavailable; retained baseline unchanged.');
  }
  if (previous && Date.parse(read.observedAt) <= Date.parse(previous.latest.observedAt)) return idle('Older or cached observation ignored; latch unchanged.');
  const changed = previous !== null && JSON.stringify(previous.latest.value) !== JSON.stringify(read.value);
  const active = watch.predicate === 'liquidity_below' ? (read.value as number) < watch.threshold! :
    watch.predicate === 'concentration_above' ? (read.value as number) > watch.threshold! :
    watch.predicate === 'new_pool' ? previous !== null && (read.value as string[]).some(id =>
      !(previous.latest.value as string[]).includes(id) && Date.parse(read.poolCreatedAt![id]!) > Date.parse(previous.latest.observedAt) && Date.parse(read.poolCreatedAt![id]!) <= Date.parse(read.observedAt)) : changed;
  const transition = previous !== null && active && !previous.active;
  const state: SignalState = { baseline: previous?.baseline ?? read, latest: read, active, generation: (previous?.generation ?? 0) + (transition ? 1 : 0) };
  return { state, transition, before: previous?.latest ?? null, reason: !previous ? 'First valid read retained as baseline; no candidate.' : transition ? 'Prospective transition observed.' : active ? 'Condition remains active; waiting for a valid clear.' : 'Condition clear; armed for the next transition.' };
}

function valueOf(result: unknown): unknown {
  return result && typeof result === 'object' && 'value' in result ? (result as { value: unknown }).value : result;
}
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}
async function solana(method: SolanaQuery['method'], address: string) {
  return ask<SolanaQuery, SolanaResult>(SOLANA_FAMILY, { method, params: [address, { commitment: 'finalized', ...(method === 'getSignaturesForAddress' ? { limit: 20 } : {}) }], commitment: 'finalized' });
}

/** All network I/O is machine-scoped upstream.ask, with the upstream's actual observation time. */
export async function readSignalWatch(watch: SignalWatch): Promise<SignalObservation> {
  if (watch.chain !== 'solana') throw new Error(`${watch.chain}: unsupported chain; not watched.`);
  if (watch.predicate === 'wallet_transaction') {
    const answer = await solana('getSignaturesForAddress', watch.address);
    const rows = answer.value.result;
    if (!Array.isArray(rows)) throw new Error('Transaction list unavailable.');
    const valid = rows.slice(0, 20).map(record).find(row => row.err === null && typeof row.signature === 'string' && isSignature(row.signature));
    return { value: valid ? String(valid.signature) : '', source: answer.provenance.upstreamId, observedAt: answer.provenance.fetchedAt, definition: 'Most recent finalized successful transaction mentioning this address, within the latest 20 signatures. Not proof of a transfer, its direction, value or wallet ownership.' };
  }
  if (watch.predicate === 'concentration_above') {
    const supply = await solana('getTokenSupply', watch.address);
    const largest = await solana('getTokenLargestAccounts', watch.address);
    const amount = exactInteger(record(valueOf(supply.value.result)).amount);
    const holders = valueOf(largest.value.result);
    let value: number | null = null;
    if (amount !== null && BigInt(amount) > 0n && Array.isArray(holders) && holders.length > 0) {
      const amounts = holders.slice(0, 20).map(row => exactInteger(record(row).amount));
      if (amounts.every(n => n !== null)) {
        const top = amounts.map(n => BigInt(n!)).sort((a, b) => a > b ? -1 : a < b ? 1 : 0).slice(0, 10).reduce((a, b) => a + b, 0n);
        value = Number(top * 10_000n / BigInt(amount)) / 100;
        if (value > 100) value = null;
      }
    }
    const reads = [supply, largest].map(answer => ({ source: answer.provenance.upstreamId, observedAt: answer.provenance.fetchedAt }));
    return { value, source: reads.map(read => read.source).join(', '), observedAt: reads.map(read => read.observedAt).sort()[0]!, reads, definition: 'Ten largest token accounts as percent of supply, including pools and programs. Accounts are not attributed people or developer wallets; sequential finalized reads may cover different slots.' };
  }
  const answer = await ask<GeckoQuery, GeckoResult>(GECKO_FAMILY, { operation: 'token_pools', network: 'solana', address: watch.address, timeframe: 'hour', limit: 20, withTokens: false });
  if (!Array.isArray(answer.value.data)) throw new Error('Pool list unavailable.');
  const pools = answer.value.data.slice(0, 20).map(record).filter(row => {
    const rel = record(row.relationships);
    return ['base_token', 'quote_token'].some(side => record(record(rel[side]).data).id === `solana_${watch.address}`);
  });
  if (pools.length !== Math.min(20, answer.value.data.length)) {
    return { value: null, source: answer.provenance.upstreamId, observedAt: answer.provenance.fetchedAt, definition: 'Pool token identity is unavailable or does not match the exact mint; retained baseline unchanged.' };
  }
  const values = pools.map(p => record(p.attributes).reserve_in_usd).map(v => typeof v === 'string' && v.trim() !== '' || typeof v === 'number' ? Number(v) : NaN).filter(n => Number.isFinite(n) && n >= 0).sort((a, b) => a - b);
  const poolIds = pools.map(p => record(p.attributes).address).filter((v): v is string => typeof v === 'string' && isAddress(v)).sort();
  const poolCreatedAt = Object.fromEntries(pools.filter(p => poolIds.includes(String(record(p.attributes).address))).map(p => [String(record(p.attributes).address), String(record(p.attributes).pool_created_at ?? '')]));
  const median = values.length >= 3 && values.length === pools.length ? (values[Math.floor((values.length - 1) / 2)]! + values[Math.floor(values.length / 2)]!) / 2 : null;
  return { value: watch.predicate === 'new_pool' ? (poolIds.length === pools.length ? poolIds : null) : median, source: answer.provenance.upstreamId, observedAt: answer.provenance.fetchedAt, ...(watch.predicate === 'new_pool' ? { poolCreatedAt } : {}), definition: watch.predicate === 'new_pool' ? 'Provider pool creation times after the previous valid observation, among its top 20 pools for the exact mint. Older pools rotating into coverage are excluded. Coverage is bounded.' : 'Median USD liquidity across provider pools for this exact mint, at least three complete pools required. Top 20 coverage only; not total market liquidity.' };
}

function evidenceBrief(watch: SignalWatch, before: SignalObservation, after: SignalObservation): string {
  const identity = `${watch.address.slice(0, 6)}...${watch.address.slice(-4)}`;
  const provenance = (read: SignalObservation) => (read.reads ?? [read]).map(part => `${part.source}, ${part.observedAt}`).join('; ');
  return `Observed ${watch.predicate.replaceAll('_', ' ')} for ${watch.chain}:${identity}. Before ${JSON.stringify(before.value)} (${provenance(before)}); after ${JSON.stringify(after.value)} (${provenance(after)}). ${after.definition}`;
}

export async function pollSignalSource(source: RadarSourceRow, reader = readSignalWatch): Promise<void> {
  const parsed = SignalUniverse.safeParse(source.config.watches);
  if (!parsed.success) {
    await radar.recordPoll({ sourceId: source.id, found: 0, nextPollAt: new Date(Date.now() + 300_000), error: 'Configure one to twelve exact owner pins.' });
    return;
  }
  const reasons: string[] = [];
  let found = 0;
  let gaps = 0;
  const deadline = Date.now() + 90_000;
  // Sequential and bounded: upstream windows decide whether each read may run.
  for (const watch of parsed.data) {
    const key = signalWatchKey(watch);
    let read: SignalObservation;
    try {
      read = watch.chain !== 'solana' ? { value: null, source: 'none', observedAt: new Date().toISOString(), definition: `${watch.chain}: unsupported chain; not watched.` } :
        Date.now() >= deadline ? { value: null, source: 'unavailable', observedAt: new Date().toISOString(), definition: 'Cycle read budget exhausted; remaining pins deferred.' } : await reader(watch);
    } catch (error) {
      read = { value: null, source: 'unavailable', observedAt: new Date().toISOString(), definition: `Upstream unavailable: ${errorMessage(error).slice(0, 250)}` };
    }
    await withTransaction(async tx => {
      const current = await tx.one('SELECT enabled, config FROM radar_sources WHERE id = $1 FOR UPDATE', [source.id]);
      const config = current?.config as RadarSourceRow['config'] | undefined;
      if (!current?.enabled || !config?.watches?.some(w => signalWatchKey(w) === key)) return;
      const row = await tx.one('SELECT state FROM signal_baselines WHERE source_id = $1 AND watch_key = $2', [source.id, key]);
      const evaluation = evaluateSignal(watch, (row?.state as SignalState | null) ?? null, read);
      const unsupported = watch.chain !== 'solana';
      const reason = unsupported ? read.definition : read.value === null ? `${evaluation.reason} ${read.definition}` : evaluation.reason;
      if (!unsupported && (read.value === null || /stale|unavailable/i.test(reason))) gaps++;
      reasons.push(reason);
      await tx.query(`INSERT INTO signal_baselines(source_id, watch_key, watch, state, last_read, reason) VALUES ($1,$2,$3,$4,$5,$6)
        ON CONFLICT(source_id,watch_key) DO UPDATE SET state = excluded.state, last_read = excluded.last_read, reason = excluded.reason, updated_at = now()`, [source.id, key, watch, evaluation.state, read, reason]);
      if (!evaluation.transition || !evaluation.before || !evaluation.state) return;
      found++;
      const summary = `Chain observation: ${watch.predicate.replaceAll('_', ' ')} at ${watch.address.slice(0, 6)}...${watch.address.slice(-4)}`;
      const detail = evidenceBrief(watch, evaluation.before, read);
      const links = await tx.many(`SELECT aa.agent_id,
        EXISTS(SELECT 1 FROM agent_account_capabilities c WHERE c.agent_id=aa.agent_id AND c.account_id=aa.account_id AND c.capability='READ') AS can_read,
        EXISTS(SELECT 1 FROM agent_account_capabilities c WHERE c.agent_id=aa.agent_id AND c.account_id=aa.account_id AND c.capability='POST') AS can_post
        FROM agent_accounts aa JOIN agents a ON a.id=aa.agent_id JOIN accounts ac ON ac.id=aa.account_id
        WHERE aa.account_id=$1 AND aa.enabled AND a.owner_id=ac.owner_id`, [source.accountId]);
      for (const link of links) {
        const refusal = signalPublicationRefusal(detail) ?? (!config.mayTrigger ? 'Context only; posting candidates are switched off.' : !link.can_read || !link.can_post ? 'READ and POST grants are required at ingest.' : null);
        const candidate = await tx.one(`INSERT INTO signal_candidates(source_id,watch_key,generation,agent_id,evidence,reason) VALUES($1,$2,$3,$4,$5,$6)
          ON CONFLICT DO NOTHING RETURNING id`, [source.id, key, evaluation.state.generation, link.agent_id, { watch, before: evaluation.before, after: read }, refusal ?? 'In idea backlog; posting gates have not run.']);
        if (refusal || !candidate) continue;
        const idea = await tx.one(`INSERT INTO content_ideas(agent_id,kind,summary,detail,source,score) VALUES($1,'observation',$2,$3,'market_signal',65) RETURNING id`, [link.agent_id, summary, detail]);
        await tx.query('UPDATE signal_candidates SET idea_id=$2 WHERE id=$1', [candidate.id, idea!.id]);
      }
    });
  }
  await radar.recordPoll({ sourceId: source.id, found, nextPollAt: new Date(Date.now() + Math.max(300, source.config.intervalSeconds ?? 300) * 1000), idleReason: reasons.join(' ').slice(0, 500), error: gaps ? `${gaps} coverage gap(s); see retained baselines. ${reasons.join(' ').slice(0, 300)}` : null });
}

/** Run again at send, including approved jobs, so edits and revocations cannot be outrun. */
export async function signalIdeaRefusal(ideaId: string, draft?: string, scope?: { accountId?: string | null; agentId: string }): Promise<string | null> {
  const [row] = await query(`SELECT c.evidence, c.watch_key, c.agent_id, s.account_id, s.enabled, s.config,
    EXISTS(SELECT 1 FROM agent_account_capabilities p WHERE p.agent_id=c.agent_id AND p.account_id=s.account_id AND p.capability='READ') AS can_read,
    EXISTS(SELECT 1 FROM agent_account_capabilities p WHERE p.agent_id=c.agent_id AND p.account_id=s.account_id AND p.capability='POST') AS can_post,
    EXISTS(SELECT 1 FROM agent_accounts aa WHERE aa.agent_id=c.agent_id AND aa.account_id=s.account_id AND aa.enabled) AS linked
    FROM signal_candidates c JOIN radar_sources s ON s.id=c.source_id WHERE c.idea_id=$1`, [ideaId]);
  if (!row) return 'Signal evidence is no longer available.';
  if (!row.can_read || !row.can_post || !row.linked) return 'READ and POST grants and an enabled account link are required.';
  if (scope && (scope.agentId !== row.agent_id || (scope.accountId !== undefined && scope.accountId !== row.account_id))) return 'Signal evidence belongs to a different agent or account.';
  const config = row.config as RadarSourceRow['config'];
  if (!row.enabled || !config.mayTrigger || !config.watches?.some(w => signalWatchKey(w) === row.watch_key)) return 'Signal watch or posting permission was removed.';
  return draft ? signalPublicationRefusal(draft) : null;
}
