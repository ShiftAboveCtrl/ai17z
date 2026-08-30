import { mapRows } from '../mapper';
import { query, queryOne } from '../pool';

/**
 * Numbers about how an agent is behaving.
 *
 * Everything here is counted from what actually happened — traces and actions —
 * rather than tracked in a separate counter that could drift. Slower, and always
 * true.
 */

export interface SocialMetrics {
  windowDays: number;
  engagement: { engaged: number; ignored: number; review: number };
  intents: { intent: string; n: number }[];
  quality: { voice: number | null; generic: number | null; repetition: number | null; samples: number };
  rewrites: { none: number; light: number; model: number };
  stanceConflicts: number;
  mediaGaps: number;
  actions: { executed: number; dryRun: number };
  /** Median characters of what was actually published. */
  medianPublishedChars: number | null;
}

/** Reads a numeric field out of the trace payload. */
async function traceAverage(agentId: string, type: string, field: string, days: number): Promise<number | null> {
  const row = await queryOne<{ avg: string | null }>(
    `SELECT avg((data->>$3)::numeric) AS avg FROM trace_events
      WHERE agent_id = $1 AND type = $2 AND at > now() - ($4::int * interval '1 day')
        AND data ? $3`,
    [agentId, type, field, days],
  );
  return row?.avg === null || row?.avg === undefined ? null : Math.round(Number(row.avg));
}

async function traceCount(agentId: string, type: string, days: number): Promise<number> {
  const row = await queryOne<{ n: number }>(
    `SELECT count(*)::int AS n FROM trace_events
      WHERE agent_id = $1 AND type = $2 AND at > now() - ($3::int * interval '1 day')`,
    [agentId, type, days],
  );
  return row?.n ?? 0;
}

export async function socialMetrics(agentId: string, windowDays = 7): Promise<SocialMetrics> {
  const decisions = await query<{ decision: string; n: number }>(
    `SELECT data->>'decision' AS decision, count(*)::int AS n FROM trace_events
      WHERE agent_id = $1 AND type = 'ENGAGEMENT_DECIDED'
        AND at > now() - ($2::int * interval '1 day')
      GROUP BY 1`,
    [agentId, windowDays],
  );
  const byDecision = (name: string) => decisions.find((d) => d.decision === name)?.n ?? 0;

  const intents = mapRows<{ intent: string; n: number }>(
    await query(
      `SELECT data->>'intent' AS intent, count(*)::int AS n FROM trace_events
        WHERE agent_id = $1 AND type = 'INTENT_SELECTED'
          AND at > now() - ($2::int * interval '1 day')
          AND data ? 'intent'
        GROUP BY 1 ORDER BY 2 DESC`,
      [agentId, windowDays],
    ),
  );

  const rewrites = await query<{ applied: string; n: number }>(
    `SELECT CASE
              WHEN data->>'applied' LIKE '%model rewrite (%' THEN 'model'
              WHEN jsonb_array_length(coalesce(data->'applied', '[]'::jsonb)) > 0 THEN 'light'
              ELSE 'none'
            END AS applied,
            count(*)::int AS n
       FROM trace_events
      WHERE agent_id = $1 AND type = 'VOICE_COMPILED'
        AND at > now() - ($2::int * interval '1 day')
      GROUP BY 1`,
    [agentId, windowDays],
  );
  const byRewrite = (name: string) => rewrites.find((r) => r.applied === name)?.n ?? 0;

  const actionRow = await queryOne<{ executed: number; dry_run: number; median: string | null }>(
    `SELECT
        count(*) FILTER (WHERE dry_run = false AND status = 'EXECUTED')::int AS executed,
        count(*) FILTER (WHERE dry_run = true)::int AS dry_run,
        percentile_cont(0.5) WITHIN GROUP (
          ORDER BY length(coalesce(payload->>'text', ''))
        ) FILTER (WHERE dry_run = false AND status = 'EXECUTED') AS median
      FROM actions
     WHERE agent_id = $1 AND created_at > now() - ($2::int * interval '1 day')`,
    [agentId, windowDays],
  );

  const qualitySamples = await traceCount(agentId, 'QUALITY_SCORED', windowDays);

  return {
    windowDays,
    engagement: { engaged: byDecision('ENGAGE'), ignored: byDecision('IGNORE'), review: byDecision('REVIEW') },
    intents,
    quality: {
      voice: await traceAverage(agentId, 'QUALITY_SCORED', 'voice', windowDays),
      generic: await traceAverage(agentId, 'QUALITY_SCORED', 'generic', windowDays),
      repetition: await traceAverage(agentId, 'QUALITY_SCORED', 'repetition', windowDays),
      samples: qualitySamples,
    },
    rewrites: { none: byRewrite('none'), light: byRewrite('light'), model: byRewrite('model') },
    stanceConflicts: await traceCount(agentId, 'STANCE_CONFLICT', windowDays),
    mediaGaps: await traceCount(agentId, 'MEDIA_RESOLVED', windowDays),
    actions: { executed: actionRow?.executed ?? 0, dryRun: actionRow?.dry_run ?? 0 },
    medianPublishedChars: actionRow?.median ? Math.round(Number(actionRow.median)) : null,
  };
}

/**
 * Which model produced what, so a provider leaking into the voice is visible.
 */
export async function byProvider(agentId: string, windowDays = 7) {
  return mapRows<{ provider: string; model: string; calls: number; medianChars: number | null }>(
    await query(
      `SELECT provider, model, count(*)::int AS calls,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY length(coalesce(raw_output, ''))) AS median_chars
         FROM model_calls
        WHERE agent_id = $1 AND created_at > now() - ($2::int * interval '1 day')
        GROUP BY provider, model ORDER BY calls DESC`,
      [agentId, windowDays],
    ),
  );
}
