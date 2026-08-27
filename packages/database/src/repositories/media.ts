import type { MediaCandidate, MediaKind, MediaStatus, MediaUnderstanding } from '@xbam/shared/contracts';
import { mapRow, mapRows } from '../mapper';
import { query, queryOne } from '../pool';

export interface EventMediaRow {
  id: string;
  eventId: string;
  kind: MediaKind;
  position: number;
  sourceUrl: string | null;
  artifactId: string | null;
  altText: string | null;
  description: string | null;
  extractedText: string | null;
  analysis: Record<string, unknown>;
  analyzedBy: string | null;
  analyzedAt: string | null;
  confidence: number | null;
  status: MediaStatus;
  error: string | null;
}

export interface EventQuoteRow {
  id: string;
  eventId: string;
  remoteId: string | null;
  remoteUrl: string | null;
  authorHandle: string | null;
  text: string;
  mediaSummary: string | null;
  status: string;
  error: string | null;
}

export interface EventLinkRow {
  id: string;
  eventId: string;
  url: string;
  title: string | null;
  description: string | null;
  summary: string | null;
  resolution: string;
  reason: string | null;
}

/** Records what an adapter found attached to a post. Idempotent per position. */
export async function recordMedia(eventId: string, candidates: MediaCandidate[]): Promise<EventMediaRow[]> {
  const rows: EventMediaRow[] = [];
  for (const candidate of candidates) {
    const row = await queryOne(
      `INSERT INTO event_media (event_id, kind, position, source_url, alt_text, analysis)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb)
       ON CONFLICT (event_id, kind, position) DO UPDATE
         SET source_url = excluded.source_url, alt_text = excluded.alt_text
       RETURNING *`,
      [
        eventId,
        candidate.kind,
        candidate.position,
        candidate.sourceUrl,
        candidate.altText,
        JSON.stringify(candidate.meta ?? {}),
      ],
    );
    const mapped = mapRow<EventMediaRow>(row);
    if (mapped) rows.push(mapped);
  }
  return rows;
}

export async function listMedia(eventId: string): Promise<EventMediaRow[]> {
  return mapRows<EventMediaRow>(
    await query('SELECT * FROM event_media WHERE event_id = $1 ORDER BY position', [eventId]),
  );
}

export async function recordUnderstanding(id: string, understanding: MediaUnderstanding): Promise<void> {
  await query(
    `UPDATE event_media
        SET description = $2, extracted_text = $3, confidence = $4,
            analyzed_by = $5, analyzed_at = now(), status = $6, error = $7
      WHERE id = $1`,
    [
      id,
      understanding.description,
      understanding.extractedText,
      understanding.confidence,
      understanding.analyzedBy,
      understanding.status,
      understanding.error,
    ],
  );
}

export async function markMediaSkipped(id: string, reason: string): Promise<void> {
  await query('UPDATE event_media SET status = $2, error = $3 WHERE id = $1', [id, 'skipped', reason]);
}

export async function recordQuote(input: {
  eventId: string;
  remoteId: string | null;
  remoteUrl: string | null;
  authorHandle: string | null;
  text: string;
  mediaSummary?: string | null;
  status?: string;
  error?: string | null;
}): Promise<void> {
  await query(
    `INSERT INTO event_quotes (event_id, remote_id, remote_url, author_handle, text, media_summary, status, error, resolved_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now())
     ON CONFLICT (event_id) DO UPDATE
       SET remote_id = excluded.remote_id, remote_url = excluded.remote_url,
           author_handle = excluded.author_handle, text = excluded.text,
           media_summary = excluded.media_summary, status = excluded.status,
           error = excluded.error, resolved_at = now()`,
    [
      input.eventId,
      input.remoteId,
      input.remoteUrl,
      input.authorHandle,
      input.text,
      input.mediaSummary ?? null,
      input.status ?? 'resolved',
      input.error ?? null,
    ],
  );
}

export async function getQuote(eventId: string): Promise<EventQuoteRow | null> {
  return mapRow<EventQuoteRow>(await queryOne('SELECT * FROM event_quotes WHERE event_id = $1', [eventId]));
}

/**
 * Records a link and what was decided about it.
 *
 * A link that policy refused to open is stored with that reason rather than
 * omitted, so the trace shows a decision instead of an absence.
 */
export async function recordLink(input: {
  eventId: string;
  url: string;
  title?: string | null;
  description?: string | null;
  summary?: string | null;
  resolution: string;
  reason?: string | null;
}): Promise<void> {
  await query(
    `INSERT INTO event_links (event_id, url, title, description, summary, resolution, reason, fetched_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7, CASE WHEN $6 = 'fetched' THEN now() ELSE NULL END)
     ON CONFLICT (event_id, url) DO UPDATE
       SET title = excluded.title, description = excluded.description, summary = excluded.summary,
           resolution = excluded.resolution, reason = excluded.reason`,
    [
      input.eventId,
      input.url,
      input.title ?? null,
      input.description ?? null,
      input.summary ?? null,
      input.resolution,
      input.reason ?? null,
    ],
  );
}

export async function listLinks(eventId: string): Promise<EventLinkRow[]> {
  return mapRows<EventLinkRow>(await query('SELECT * FROM event_links WHERE event_id = $1 ORDER BY url', [eventId]));
}

/**
 * Media whose bytes have outlived their retention window.
 *
 * Downloading every asset a social feed shows and keeping it forever is not
 * something to do by default, so the artifact is released while the description
 * derived from it stays.
 */
export async function expiredArtifacts(retainHours: number, limit = 200): Promise<{ id: string; artifactId: string }[]> {
  return mapRows(
    await query(
      `SELECT id, artifact_id FROM event_media
        WHERE artifact_id IS NOT NULL
          AND created_at < now() - ($1::int * interval '1 hour')
        LIMIT $2`,
      [retainHours, limit],
    ),
  );
}

export async function releaseArtifact(mediaId: string): Promise<void> {
  await query('UPDATE event_media SET artifact_id = NULL WHERE id = $1', [mediaId]);
}
