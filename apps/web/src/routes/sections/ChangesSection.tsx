import { useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { ApiError, post } from '@app/lib/api';
import { useResource } from '@app/lib/hooks';
import { timeAgo } from '@app/lib/format';
import { EmptyState, ErrorPanel, Loading } from '@app/components/ui';
import { Section } from './Section';

interface Change {
  id: string;
  kind: string;
  subsystem: string;
  risk: string;
  status: string;
  summary: string;
  requestText: string;
  beforeValue: unknown;
  afterValue: unknown;
  verification: { readBackAgrees?: boolean };
  createdAt: string;
}

const STATUS_WORDS: Record<string, string> = {
  APPLIED: 'Changed',
  AWAITING_CONFIRMATION: 'Waiting for you',
  DECLINED: 'Left as it was',
  UNDONE: 'Undone',
  REFUSED: 'Not changed from chat',
  FAILED: 'Not changed',
};

const SUBSYSTEM_WORDS: Record<string, string> = { PERSONA: 'Character', POLICY: 'Rules', POSTING: 'Own posts' };

function shown(value: unknown): string {
  if (value === null || value === undefined) return 'nothing';
  if (typeof value === 'string') return value || 'empty';
  if (Array.isArray(value)) return value.join(', ') || 'none';
  return JSON.stringify(value);
}

/**
 * Everything this agent changed about itself because its owner asked in chat.
 *
 * The history a person needs to trust the feature: the words they used, what
 * the setting was and became, whether reading it back agreed, and the way
 * back.
 */
export function ChangesSection({ index, agentId }: { index: number; agentId: string }) {
  const { data, error, loading, reload } = useResource<{ changes: Change[] }>(`/api/agents/${agentId}/changes?days=30`);
  const [note, setNote] = useState<string | null>(null);

  const act = async (id: string, verb: 'undo' | 'confirm' | 'decline') => {
    setNote(null);
    try {
      const out = await post<{ message: string }>(`/api/agent-changes/${id}/${verb}`, {});
      setNote(out.message);
    } catch (e) {
      setNote(e instanceof ApiError ? e.message : 'That did not go through. Try again.');
    }
    reload();
  };

  return (
    <Section
      id="changes"
      index={index}
      eyebrow="Changes from chat"
      heading="What you asked it to change."
      lede="Every change this agent made to itself because you asked in chat, the last thirty days, newest first."
    >
      {loading && !data ? (
        <Loading label="Reading the changes" />
      ) : error ? (
        <ErrorPanel
          title="The changes could not be read."
          detail={error}
          actions={
            <button type="button" className="btn-quiet" onClick={reload}>
              Try again
            </button>
          }
        />
      ) : !data || data.changes.length === 0 ? (
        <EmptyState title="Nothing yet" detail='Tell it in chat, for example "be less formal" or "stop posting for today". Small changes happen at once and can be undone here.' />
      ) : (
        <ul className="divide-y divide-ink-line">
          {note && <li className="py-2 text-sm text-bone-dim">{note}</li>}
          {data.changes.map((c) => (
            <li key={c.id} className="py-3 text-sm">
              <p className="text-[11px] uppercase tracking-wide text-bone-faint">
                {STATUS_WORDS[c.status] ?? c.status} · {SUBSYSTEM_WORDS[c.subsystem] ?? c.subsystem} · {timeAgo(c.createdAt)}
                {c.verification?.readBackAgrees && ' · checked'}
              </p>
              <p className="mt-0.5 break-words text-bone">{c.summary}</p>
              {c.requestText && <p className="mt-0.5 break-words text-xs text-bone-dim">You said: "{c.requestText}"</p>}
              {c.status !== 'REFUSED' && c.beforeValue !== null && (
                <p className="mt-0.5 break-words text-xs text-bone-faint">
                  Was {shown(c.beforeValue)}; {c.status === 'AWAITING_CONFIRMATION' ? 'would be' : 'became'} {shown(c.afterValue)}.
                </p>
              )}
              <div className="mt-1.5 flex flex-wrap gap-3">
                {c.status === 'APPLIED' && !(c.verification as { unchanged?: boolean }).unchanged && (
                  <button type="button" className="btn-quiet px-0 text-xs" onClick={() => void act(c.id, 'undo')}>
                    <RotateCcw className="h-3.5 w-3.5" aria-hidden />
                    Undo
                  </button>
                )}
                {c.status === 'AWAITING_CONFIRMATION' && (
                  <>
                    <button type="button" className="btn-primary px-3 py-1 text-xs" onClick={() => void act(c.id, 'confirm')}>
                      Confirm
                    </button>
                    <button type="button" className="btn-quiet px-0 text-xs" onClick={() => void act(c.id, 'decline')}>
                      Leave it as it is
                    </button>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
