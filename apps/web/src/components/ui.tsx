import { AlertTriangle, Check, Loader2, X } from 'lucide-react';
import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export function StatusDot({ state, label }: { state: 'live' | 'wait' | 'fail' | 'idle'; label?: string }) {
  const tone =
    state === 'live'
      ? 'bg-signal-live'
      : state === 'wait'
        ? 'bg-signal-wait'
        : state === 'fail'
          ? 'bg-signal-fail'
          : 'bg-bone-faint';
  return (
    <span className="inline-flex items-center gap-2">
      <span className={`relative inline-block h-1.5 w-1.5 rounded-full ${tone}`}>
        {state === 'live' && (
          <span className={`absolute inset-0 animate-ping rounded-full ${tone} opacity-60`} aria-hidden />
        )}
      </span>
      {label && <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-bone-dim">{label}</span>}
    </span>
  );
}

export function Spinner({ className = 'h-4 w-4' }: { className?: string }) {
  return <Loader2 className={`${className} animate-spin`} aria-hidden />;
}

export function Loading({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="flex items-center gap-3 py-16 text-bone-dim" role="status" aria-live="polite">
      <Spinner />
      <span className="font-mono text-xs uppercase tracking-[0.18em]">{label}</span>
    </div>
  );
}

/**
 * Errors are written for a person, not a log file: what happened, what it means,
 * and what to do next.
 */
export function ErrorPanel({
  title,
  detail,
  actions,
}: {
  title: string;
  detail?: string | null;
  actions?: ReactNode;
}) {
  return (
    <div className="panel border-signal-fail/25 bg-signal-fail/[0.04] p-6" role="alert">
      <div className="flex items-start gap-3">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-signal-fail" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-[15px] font-medium text-bone">{title}</p>
          {detail && <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-relaxed text-bone-dim">{detail}</p>}
          {actions && <div className="mt-4 flex flex-wrap gap-2">{actions}</div>}
        </div>
      </div>
    </div>
  );
}

export function EmptyState({
  title,
  detail,
  action,
}: {
  title: string;
  detail?: string;
  action?: ReactNode;
}) {
  return (
    <div className="rounded-xl border border-dashed border-ink-line px-6 py-14 text-center">
      <p className="text-lg font-light text-bone-dim">{title}</p>
      {detail && <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-bone-faint">{detail}</p>}
      {action && <div className="mt-6 flex justify-center">{action}</div>}
    </div>
  );
}

export function Field({
  label,
  hint,
  error,
  children,
  htmlFor,
}: {
  label: string;
  hint?: string;
  error?: string | null;
  children: ReactNode;
  htmlFor?: string;
}) {
  return (
    <div className="space-y-2">
      <label htmlFor={htmlFor} className="block font-mono text-[10px] uppercase tracking-[0.2em] text-bone-faint">
        {label}
      </label>
      {children}
      {hint && !error && <p className="text-xs leading-relaxed text-bone-faint">{hint}</p>}
      {error && <p className="break-words text-xs text-signal-fail">{error}</p>}
    </div>
  );
}

export function Toggle({
  checked,
  onChange,
  label,
  description,
  disabled,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  description?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="flex w-full items-start gap-3 rounded-lg px-1 py-2 text-left transition-colors hover:bg-white/[0.02] disabled:opacity-40"
    >
      <span
        className={`mt-0.5 flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors duration-200 ${
          checked ? 'border-signal-calm/60 bg-signal-calm/25' : 'border-ink-line bg-ink-panel'
        }`}
      >
        <span
          className={`mx-0.5 h-3.5 w-3.5 rounded-full transition-transform duration-200 ease-stage ${
            checked ? 'translate-x-4 bg-signal-calm' : 'translate-x-0 bg-bone-faint'
          }`}
        />
      </span>
      <span className="min-w-0">
        <span className="block text-sm text-bone">{label}</span>
        {description && <span className="mt-0.5 block text-xs leading-relaxed text-bone-faint">{description}</span>}
      </span>
    </button>
  );
}

export function Modal({
  open,
  onClose,
  title,
  children,
  wide,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    ref.current?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, [open, onClose]);

  if (!open) return null;
  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-end justify-center overflow-y-auto bg-black/70 p-0 backdrop-blur-sm sm:items-center sm:p-6">
      <div
        ref={ref}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`panel my-auto w-full ${wide ? 'sm:max-w-3xl' : 'sm:max-w-lg'} rounded-b-none sm:rounded-xl`}
      >
        <div className="flex items-center justify-between border-b border-ink-line px-5 py-4">
          <h2 className="text-base font-medium text-bone">{title}</h2>
          <button type="button" onClick={onClose} className="btn-quiet -mr-2 p-2" aria-label="Close">
            <X className="h-4 w-4" aria-hidden />
          </button>
        </div>
        <div className="max-h-[70vh] overflow-y-auto px-5 py-5">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

export function SavedTick({ visible }: { visible: boolean }) {
  if (!visible) return null;
  return (
    <span className="inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.16em] text-signal-live">
      <Check className="h-3 w-3" aria-hidden /> saved
    </span>
  );
}

/**
 * A long operation, in words.
 *
 * Every asynchronous action in AI17Z can outlast a person's patience: a browser
 * cold-starts, a model is slow, a remote service is thinking. A spinner alone
 * says only "something", so this says what, for how long, that it is still
 * going, and how to stop.
 */
export function Working({
  label,
  seconds,
  slowAfter = 12,
  slowHint,
  onCancel,
  cancelLabel = 'Cancel',
}: {
  label: string;
  seconds: number;
  /** After this long, say so rather than letting the silence speak. */
  slowAfter?: number;
  slowHint?: string;
  onCancel?: () => void;
  cancelLabel?: string;
}) {
  return (
    <div
      className="space-y-2 rounded-lg border border-ink-line bg-ink-panel px-3.5 py-3"
      role="status"
      aria-live="polite"
    >
      <div className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-2.5 text-sm text-bone">
          <Spinner className="h-3.5 w-3.5" />
          {label}
        </span>
        <span className="font-mono text-[10px] tabular-nums text-bone-faint">{seconds}s</span>
      </div>
      {seconds >= slowAfter && (
        <p className="text-xs leading-relaxed text-bone-faint">
          {slowHint ?? 'Still going. Nothing has failed; it is just slow.'}
        </p>
      )}
      {onCancel && (
        <button type="button" className="btn-quiet px-0 text-xs" onClick={onCancel}>
          {cancelLabel}
        </button>
      )}
    </div>
  );
}

/**
 * A failure with a way out of it.
 *
 * An error that cannot be retried without reloading the page is one people
 * reload the page for, which loses whatever else they had in progress.
 */
export function RetryablePanel({
  title,
  detail,
  onRetry,
  retryLabel = 'Try again',
}: {
  title: string;
  detail: string;
  onRetry: () => void;
  retryLabel?: string;
}) {
  return (
    <div className="space-y-2.5 rounded-lg border border-signal-fail/40 bg-signal-fail/[0.06] px-3.5 py-3">
      <p className="flex items-start gap-2 text-sm text-bone">
        <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-signal-fail" aria-hidden />
        {title}
      </p>
      <p className="break-words text-xs leading-relaxed text-bone-dim">{detail}</p>
      <button type="button" className="btn-quiet px-0 text-xs" onClick={onRetry}>
        {retryLabel}
      </button>
    </div>
  );
}
