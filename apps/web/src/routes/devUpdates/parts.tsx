import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, Copy } from 'lucide-react';
import { AgentGlyph } from '@app/components/AgentGlyph';
import { ApiError } from '@app/lib/api';
import { POST_MAX_CHARS } from '@app/lib/devUpdates';

/**
 * Copies a value and says so, out loud as well as on screen.
 *
 * The confirmation is announced because the button is often pressed by
 * somebody about to switch to a terminal, who will not look back at it.
 */
export function CopyButton({ value, label, className = '' }: { value: string; label: string; className?: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setState('copied');
    } catch {
      // Clipboard access can be refused (an insecure origin, a browser
      // setting). The value is on screen and selectable, so say how.
      setState('failed');
    }
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState('idle'), 2400);
  };

  return (
    <span className="inline-flex items-center gap-2">
      <button type="button" onClick={() => void copy()} className={`btn-ghost min-h-[40px] px-3 py-2 text-xs ${className}`}>
        {state === 'copied' ? <Check className="h-3.5 w-3.5 text-signal-live" aria-hidden /> : <Copy className="h-3.5 w-3.5" aria-hidden />}
        {state === 'copied' ? 'Copied' : label}
      </button>
      <span role="status" className="text-xs text-bone-dim">
        {state === 'failed' ? 'Copying was blocked. Select the text and copy it yourself.' : ''}
      </span>
    </span>
  );
}

/** A ring that fills towards the limit, and the count beside it. */
export function CharMeter({ length }: { length: number }) {
  const fraction = Math.min(length / POST_MAX_CHARS, 1);
  const over = length > POST_MAX_CHARS;
  const near = !over && length > POST_MAX_CHARS - 20;
  const r = 9;
  const circumference = 2 * Math.PI * r;
  const tone = over ? 'text-signal-fail' : near ? 'text-signal-wait' : 'text-signal-calm';
  return (
    <span className="inline-flex items-center gap-2 font-mono text-[11px] tabular-nums text-bone-dim">
      <svg viewBox="0 0 24 24" className={`h-5 w-5 -rotate-90 ${tone}`} aria-hidden>
        <circle cx="12" cy="12" r={r} fill="none" stroke="currentColor" strokeOpacity="0.18" strokeWidth="2.5" />
        <circle
          cx="12"
          cy="12"
          r={r}
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - fraction)}
          className="transition-[stroke-dashoffset] duration-200 ease-stage motion-reduce:transition-none"
        />
      </svg>
      <span className={over ? 'text-signal-fail' : undefined}>
        {length} / {POST_MAX_CHARS}
        <span className="sr-only">{over ? ', over the limit' : ' characters'}</span>
      </span>
    </span>
  );
}

/**
 * The post as the account will show it.
 *
 * Shown in the shape of a post rather than as a quotation, because what an
 * owner is approving is how it will look under the agent's name, and a block
 * of grey text does not read that way.
 */
export function PostPreview({
  agent,
  handle,
  text,
  edited,
  children,
}: {
  agent: { id: string; name: string; avatarUrl?: string | null } | null;
  handle: string | null;
  text: string;
  edited?: boolean;
  children?: ReactNode;
}) {
  return (
    <figure className="rounded-xl border border-ink-line bg-ink p-4">
      <figcaption className="flex items-center gap-3">
        {agent ? (
          <AgentGlyph agentId={agent.id} name={agent.name} imageUrl={agent.avatarUrl ?? null} size="sm" interactive={false} />
        ) : (
          <span className="h-10 w-10 rounded-full border border-ink-line" aria-hidden />
        )}
        <span className="min-w-0">
          <span className="block truncate text-sm text-bone">{agent?.name ?? 'Unknown agent'}</span>
          <span className="block truncate font-mono text-[11px] text-bone-dim">{handle ? `@${handle}` : 'no account'}</span>
        </span>
        {edited && <span className="chip ml-auto shrink-0">edited</span>}
      </figcaption>
      {children ?? <p className="mt-3 whitespace-pre-wrap break-words text-[15px] leading-relaxed text-bone">{text}</p>}
    </figure>
  );
}

/** What went wrong, as sentences: the rules a refused text broke, or the API's own words. */
export function problemOf(error: unknown, fallback: string): string[] {
  if (error instanceof ApiError) {
    const details = error.details as { refusals?: { message?: unknown }[] } | undefined;
    const rules = (details?.refusals ?? []).map((r) => (typeof r.message === 'string' ? r.message : '')).filter(Boolean);
    if (rules.length > 0) return ['This cannot be posted:', ...rules];
    return [error.message];
  }
  return [fallback];
}

export function ProblemList({ lines }: { lines: string[] | null }) {
  if (!lines || lines.length === 0) return null;
  const [first, ...rest] = lines;
  return (
    <div role="alert" className="rounded-lg border border-signal-fail/40 bg-signal-fail/[0.06] px-3.5 py-3 text-sm text-bone">
      <p className="break-words">{first}</p>
      {rest.length > 0 && (
        <ul className="mt-1.5 list-disc space-y-1 pl-5 text-xs leading-relaxed text-bone-dim">
          {rest.map((line) => (
            <li key={line} className="break-words">
              {line}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
