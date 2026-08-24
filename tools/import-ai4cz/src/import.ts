import { createLogger } from '@xbam/shared';
import {
  accounts as accountsRepo,
  agents as agentsRepo,
  conversations as conversationsRepo,
  events as eventsRepo,
  legacyLedger,
  memories as memoriesRepo,
  ops,
  withTransaction,
} from '@xbam/database';
import { normalizeTargetId, extractStatusId, normalizeHandle } from '@xbam/channels';
import { ensureAgentPipeline } from '@xbam/runtime';
import { LegacyReader, findCredentialLocations, readLegacyMemory, type LegacyMemoryRow } from './legacy';
import { buildAi4czPersona } from './persona';

const log = createLogger('import-ai4cz');
const SOURCE = 'ai4cz';
const AGENT_SLUG = 'ai4cz';
const X_HANDLE = 'ai4cz_binance';

export interface ImportReport {
  agentId: string | null;
  agentCreated: boolean;
  styleMemories: number;
  conversationTurns: number;
  conversationsCreated: number;
  eventArchiveMemories: number;
  historicalEvents: number;
  seenMentionLedger: number;
  postedSignatures: number;
  malformedSkipped: number;
  secretsImported: number;
  credentialLocations: string[];
  droppedInstructions: string[];
  notes: string[];
}

function emptyReport(): ImportReport {
  return {
    agentId: null,
    agentCreated: false,
    styleMemories: 0,
    conversationTurns: 0,
    conversationsCreated: 0,
    eventArchiveMemories: 0,
    historicalEvents: 0,
    seenMentionLedger: 0,
    postedSignatures: 0,
    malformedSkipped: 0,
    secretsImported: 0,
    credentialLocations: [],
    droppedInstructions: [],
    notes: [],
  };
}

const isoFrom = (ms: number | null): string | null =>
  ms && Number.isFinite(ms) ? new Date(ms > 1e12 ? ms : ms * 1000).toISOString() : null;

/** Legacy thread channels are `x_thread:<statusId>`. */
function threadStatusId(channel: string | null): string | null {
  if (!channel?.startsWith('x_thread:')) return null;
  const id = channel.slice('x_thread:'.length).trim();
  return id.length > 0 ? id : null;
}

export interface ImportOptions {
  legacyDir: string;
  ownerId: string;
  /** Read and report without writing anything. */
  dryRun?: boolean;
}

/**
 * Imports AI4CZ as one XBAM agent.
 *
 * Idempotent by construction: the agent is matched by slug, memories dedupe on
 * their content hash, events on their remote id, and posted signatures on the
 * signature itself. Running it twice changes nothing the second time.
 */
export async function importAi4cz(options: ImportOptions): Promise<ImportReport> {
  const reader = new LegacyReader(options.legacyDir);
  const report = emptyReport();

  // Reported so they can be rotated. Never opened, never printed, never imported.
  report.credentialLocations = findCredentialLocations(options.legacyDir).map((f) => f.path);

  const { persona, policy, droppedInstructions } = buildAi4czPersona(reader);
  report.droppedInstructions = droppedInstructions;

  if (options.dryRun) {
    const rows = await readLegacyMemory(options.legacyDir);
    report.styleMemories = reader.styleLines().length + reader.scrapedPosts().length;
    report.conversationTurns = rows.filter((r) => threadStatusId(r.channel)).length;
    report.conversationsCreated = new Set(rows.map((r) => threadStatusId(r.channel)).filter(Boolean)).size;
    report.eventArchiveMemories = rows.filter((r) => r.channel === 'x').length;
    report.historicalEvents = reader.inboxItems().length;
    report.seenMentionLedger = reader.seenMentions().length;
    report.postedSignatures = reader.postedSignatures().length;
    report.notes.push('Dry run: nothing was written.');
    return report;
  }

  const runId = await ops.startImportRun(SOURCE, null);
  try {
    // ── Agent ────────────────────────────────────────────────────────────────
    let agent = await agentsRepo.getAgentBySlug(options.ownerId, AGENT_SLUG);
    if (!agent) {
      agent = await agentsRepo.createAgent({
        ownerId: options.ownerId,
        name: 'AI4CZ',
        slug: AGENT_SLUG,
        description: 'Imported from the legacy AI4CZ project. Starts disabled and in manual mode.',
        persona,
        policy,
        createdBy: options.ownerId,
      });
      report.agentCreated = true;
    } else {
      // Re-running refreshes the persona rather than duplicating the agent.
      await agentsRepo.savePersonaVersion(agent.id, persona, options.ownerId);
      await agentsRepo.savePolicyVersion(agent.id, policy, 're-imported from AI4CZ', options.ownerId);
    }
    report.agentId = agent.id;
    await ensureAgentPipeline(agent.id, 'When someone mentions AI4CZ on X');

    // ── Account ──────────────────────────────────────────────────────────────
    let account = await accountsRepo.findAccountByHandle(options.ownerId, 'x', X_HANDLE);
    if (!account) {
      account = await accountsRepo.createAccount({
        ownerId: options.ownerId,
        channel: 'x',
        handle: X_HANDLE,
        displayName: 'AI4CZ on X',
        capabilities: ['REPLY'],
        settings: { selfHandles: ['ai4cz', 'ai4cz_binance'], pollingEnabled: false },
      });
      // No session is imported: the operator signs in through XBAM itself.
      await accountsRepo.upsertBrowserSession({ accountId: account.id, mode: 'MANAGED', status: 'UNKNOWN' });
      await accountsRepo.updateAccount(account.id, { enabled: false, status: 'NEEDS_AUTH' });
    }
    await accountsRepo.linkAgentAccount({
      agentId: agent.id,
      accountId: account.id,
      triggerEventTypes: ['MENTION'],
      actionType: 'REPLY',
      enabled: false,
    });

    // ── Style corpus ─────────────────────────────────────────────────────────
    for (const line of reader.styleLines()) {
      const written = await memoriesRepo.writeMemory({
        agentId: agent.id,
        scope: 'KNOWLEDGE',
        memoryType: 'STYLE_EXAMPLE',
        content: line,
        importance: 0.7,
        pinned: true,
      });
      if (written.created) report.styleMemories += 1;
    }
    for (const post of reader.scrapedPosts()) {
      const written = await memoriesRepo.writeMemory({
        agentId: agent.id,
        scope: 'KNOWLEDGE',
        memoryType: 'STYLE_EXAMPLE',
        content: post.text,
        summary: post.parentText ? `reply to: ${post.parentText.slice(0, 120)}` : null,
        importance: 0.6,
      });
      if (written.created) report.styleMemories += 1;
    }

    // ── Conversation history ─────────────────────────────────────────────────
    const rows = await readLegacyMemory(options.legacyDir);
    const threadRows = new Map<string, LegacyMemoryRow[]>();
    for (const row of rows) {
      const statusId = threadStatusId(row.channel);
      if (!statusId) continue;
      if (!row.content?.trim()) {
        report.malformedSkipped += 1;
        continue;
      }
      const bucket = threadRows.get(statusId) ?? [];
      bucket.push(row);
      threadRows.set(statusId, bucket);
    }

    for (const [statusId, turns] of threadRows) {
      turns.sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
      // The human in the thread is whoever is not the agent, which the legacy
      // schema recorded inconsistently: AI rows always say 'ai4cz'.
      const remoteHandle =
        normalizeHandle(turns.find((t) => t.role === 'user')?.username ?? null) ?? 'unknown';

      const conversation = await withTransaction((tx) =>
        conversationsRepo.upsertConversation(tx, {
          agentId: agent!.id,
          accountId: account!.id,
          channel: 'x',
          remoteConversationId: statusId,
          remoteHandle,
        }),
      );
      report.conversationsCreated += 1;

      for (const turn of turns) {
        const outbound = turn.role === 'ai';
        const speaker = outbound ? 'me' : remoteHandle;
        const written = await memoriesRepo.writeMemory({
          agentId: agent.id,
          scope: 'THREAD',
          memoryType: 'CONVERSATION_TURN',
          conversationId: conversation.id,
          accountId: account.id,
          remoteHandle: outbound ? null : remoteHandle,
          content: `${speaker}: ${turn.content!.trim()}`,
          importance: 0.4,
        });
        if (written.created) report.conversationTurns += 1;

        await withTransaction((tx) =>
          conversationsRepo.recordMessage(tx, {
            conversationId: conversation.id,
            direction: outbound ? 'OUTBOUND' : 'INBOUND',
            remoteMessageId: turn.id,
            authorHandle: outbound ? X_HANDLE : remoteHandle,
            body: turn.content!.trim(),
          }),
        );
      }
    }

    // ── Raw inbound archive ──────────────────────────────────────────────────
    for (const row of rows.filter((r) => r.channel === 'x')) {
      if (!row.content?.trim()) {
        report.malformedSkipped += 1;
        continue;
      }
      const written = await memoriesRepo.writeMemory({
        agentId: agent.id,
        scope: 'ACCOUNT',
        memoryType: 'EVENT_ARCHIVE',
        accountId: account.id,
        remoteHandle: normalizeHandle(row.username),
        content: row.content.trim(),
        importance: 0.2,
      });
      if (written.created) report.eventArchiveMemories += 1;
    }

    // ── Historical events ────────────────────────────────────────────────────
    // Importing these is what stops the agent replying to a year-old backlog:
    // the unique index on (channel, account, remote_event_id) makes a re-ingest
    // of any of them a no-op.
    for (const item of reader.inboxItems()) {
      const statusId = extractStatusId(item.tweetUrl);
      if (!statusId) {
        report.malformedSkipped += 1;
        continue;
      }
      const created = await withTransaction(async (tx) => {
        const result = await eventsRepo.ingestEvent(tx, account!.id, {
          channel: 'x',
          type: 'MENTION',
          remoteEventId: statusId,
          remoteMessageId: statusId,
          remoteAuthorId: null,
          remoteAuthorHandle: normalizeHandle(item.authorUsername),
          remoteAuthorDisplayName: null,
          remoteConversationId: statusId,
          parentRemoteMessageId: null,
          remoteUrl: normalizeTargetId(item.tweetUrl),
          text: item.mentionText,
          occurredAt: item.createdAt,
          raw: { source: 'ai4cz/mentions_inbox.json', parentText: item.parentText },
        });
        return result.created;
      });
      if (created) report.historicalEvents += 1;
    }

    for (const url of reader.seenMentions()) {
      const statusId = extractStatusId(url);
      if (!statusId) {
        report.malformedSkipped += 1;
        continue;
      }
      const created = await withTransaction(async (tx) => {
        const result = await eventsRepo.ingestEvent(tx, account!.id, {
          channel: 'x',
          type: 'MENTION',
          remoteEventId: statusId,
          remoteMessageId: statusId,
          remoteAuthorId: null,
          remoteAuthorHandle: null,
          remoteAuthorDisplayName: null,
          remoteConversationId: statusId,
          parentRemoteMessageId: null,
          remoteUrl: normalizeTargetId(url),
          text: '',
          occurredAt: null,
          raw: { source: 'ai4cz/seen_mentions.json' },
        });
        return result.created;
      });
      if (created) report.seenMentionLedger += 1;
    }

    // ── Posted ledger ────────────────────────────────────────────────────────
    for (const signature of reader.postedSignatures()) {
      const [rawTarget] = signature.split('|');
      const created = await legacyLedger.recordLegacyAction({
        agentId: agent.id,
        source: SOURCE,
        channel: 'x',
        targetRef: normalizeTargetId(rawTarget ?? null),
        legacySignature: signature,
      });
      if (created) report.postedSignatures += 1;
    }

    report.notes.push('No credentials, cookies, sessions or browser profiles were imported.');
    report.notes.push('The agent is DRAFT, the X account is disabled, and automation is MANUAL_ONLY.');
    if (report.droppedInstructions.length > 0) {
      report.notes.push(
        `Dropped ${report.droppedInstructions.length} identity-denial instruction(s) from the legacy prompt.`,
      );
    }

    await ops.rememberImport({
      source: SOURCE,
      entityType: 'agent',
      naturalKey: AGENT_SLUG,
      entityId: agent.id,
    });
    await ops.finishImportRun(runId, 'COMPLETED', report as unknown as Record<string, unknown>, agent.id);
    log.info('ai4cz import complete', {
      agentId: agent.id,
      turns: report.conversationTurns,
      style: report.styleMemories,
    });
    return report;
  } catch (error) {
    await ops.finishImportRun(runId, 'FAILED', { message: (error as Error).message });
    throw error;
  }
}
