import { AlertTriangle, Check, Loader2, X } from 'lucide-react';
import { cloneElement, isValidElement, useEffect, useId, useRef, type ReactElement, type ReactNode } from 'react';
import type React from 'react';
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

/**
 * A labelled control.
 *
 * The label is associated with what it labels, and that association is made
 * here rather than asked of the caller. `htmlFor` used to be an optional prop
 * that most callers did not pass, so most fields rendered text that looks like
 * a label above a control with no accessible name at all -- an audit of the
 * running app found ten on the Policies screen alone. Nothing about that is
 * visible, which is why it survived: it is only wrong to somebody using a
 * screen reader, or clicking a label and finding it does nothing.
 *
 * Two ways, because a field wraps two kinds of thing:
 *
 *   a single control      the label points at it, and it is given an id if it
 *                         does not have one
 *   anything else         a row of buttons, a group of checkboxes -- the label
 *                         names the group instead, which is the only correct
 *                         answer when there is no one control to point at
 */
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
  /** Only when the control already has an id of its own. */
  htmlFor?: string;
}) {
  const generated = useId();
  const only = isValidElement(children) ? (children as ReactElement<{ id?: string }>) : null;
  /*
    A child that names itself.

    `ChoiceGroup` is a radiogroup carrying its own accessible name, so wrapping
    it in another labelled group announces the same words twice -- and pointing
    `htmlFor` at it puts a label on an element labels cannot address. The child
    says so rather than this guessing from its type.
  */
  const selfLabelled = Boolean(only && (only.type as { groupLabelled?: boolean }).groupLabelled);
  const existingId = htmlFor ?? only?.props.id;
  const controlId = selfLabelled ? undefined : (existingId ?? (only ? generated : undefined));
  const labelId = `${generated}-label`;

  /*
    The hint and the error belong to the control, not to the space under it.

    Both were rendered as loose paragraphs: a screen reader read the label and
    stopped, so "Exactly as the provider names it" and "that model does not
    exist" were visible and unsaid. `aria-invalid` is what turns the error from
    red text into a state.
  */
  const hintId = hint && !error ? `${generated}-hint` : undefined;
  const errorId = error ? `${generated}-error` : undefined;
  const describedBy = errorId ?? hintId;
  const described =
    only && !selfLabelled && describedBy
      ? { 'aria-describedby': describedBy, ...(error ? { 'aria-invalid': true } : {}) }
      : {};

  return (
    <div className="space-y-2">
      <label
        id={labelId}
        htmlFor={controlId}
        className="block font-mono text-[10px] uppercase tracking-[0.2em] text-bone-faint"
      >
        {label}
      </label>
      {selfLabelled ? (
        cloneElement(only!, { labelledBy: labelId, describedBy } as Record<string, unknown>)
      ) : only && !existingId ? (
        cloneElement(only, { id: controlId, ...described })
      ) : only ? (
        cloneElement(only, described)
      ) : (
        // No single control to point at, so the label names the group. Without
        // this these fields have no accessible name at all.
        <div role="group" aria-labelledby={labelId} aria-describedby={describedBy}>
          {children}
        </div>
      )}
      {hint && !error && (
        <p id={hintId} className="text-xs leading-relaxed text-bone-faint">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className="break-words text-xs text-signal-fail">
          {error}
        </p>
      )}
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

  // The latest onClose, so opening does not depend on its identity.
  //
  // Every caller writes `onClose={() => setEditing(null)}`, which is a new
  // function on every render. With `onClose` in the dependency list this whole
  // effect re-ran on *every* render -- and it ends with `ref.current?.focus()`,
  // which moved focus off whatever was being typed into and onto the dialog
  // itself. So a keystroke changed state, the re-render stole the focus, and
  // the field had to be clicked again for each character. It made every modal
  // in the application, and every form inside one, effectively unusable.
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!open) return;

    /*
      Tab stays inside the dialog.

      `aria-modal` confines a screen reader and nothing else: a sighted
      keyboard user could tab straight out into the page behind, which is
      covered, scroll-locked and still fully focusable. Wrapping at the ends is
      what makes it a dialog rather than a panel that happens to be on top.
    */
    const focusables = () =>
      [
        ...(ref.current?.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? []),
      ].filter((el) => el.offsetParent !== null || el === document.activeElement);

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const items = focusables();
      if (items.length === 0) return;
      const first = items[0]!;
      const last = items[items.length - 1]!;
      const active = document.activeElement;
      if (!ref.current?.contains(active)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    // Where focus was, so closing puts it back rather than dropping somebody at
    // the top of the page with no idea what they had been operating.
    const returnTo = document.activeElement as HTMLElement | null;
    // Once, when it opens. The dialog takes focus so Escape works and a screen
    // reader announces it; anything the person then focuses is theirs to keep.
    ref.current?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
      if (returnTo?.isConnected) returnTo.focus();
    };
  }, [open]);

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
    <span
      // Announced, because it is the only confirmation that a save happened
      // and it clears itself after a couple of seconds -- so somebody not
      // looking at this corner of the screen had no way to know.
      role="status"
      className="inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.16em] text-signal-live"
    >
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

/**
 * One choice out of several, said properly to a screen reader.
 *
 * These are everywhere -- automation mode, permission profile, which provider,
 * who it answers, how it writes -- and every one of them was a row of plain
 * `<button>`s. A screen reader heard eight buttons and no indication that one
 * of them was chosen, and a keyboard user tabbed through all eight instead of
 * arrowing between them the way a radio group works.
 *
 * Native `<input type="radio">` would be better if these were labels. They are
 * cards with a heading, a description, sometimes a status chip, and the layout
 * varies -- so this supplies the semantics and the keyboard, and each caller
 * keeps its own markup inside.
 *
 * Selection follows focus, which is what a native radio group does: arrowing
 * onto an option chooses it. That is the behaviour people expect from the
 * shape, and an arrow key that moves focus without choosing is a group where
 * the keyboard and the mouse disagree.
 */
export function ChoiceGroup({
  label,
  labelledBy,
  describedBy,
  className,
  children,
}: {
  /** What the group is choosing. Announced before the options. */
  label: string;
  /**
   * The id of a visible label to use instead.
   *
   * Passed by `Field`, so the name a screen reader hears is the one on screen
   * rather than a second copy written into a prop that can drift from it.
   */
  labelledBy?: string;
  describedBy?: string;
  className?: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);

  /*
    Exactly one option is tabbable: the chosen one, or the first when nothing
    is chosen yet. Done from the DOM rather than by asking every caller to pass
    an index, because a caller that forgets makes the whole group unreachable
    by keyboard and nothing says so.
  */
  useEffect(() => {
    const container = ref.current;
    if (!container) return;
    const items = [...container.querySelectorAll<HTMLElement>('[role="radio"]')];
    const chosen = items.find((el) => el.getAttribute('aria-checked') === 'true');
    const tabbable = chosen ?? items.find((el) => !el.hasAttribute('disabled')) ?? null;
    for (const el of items) el.tabIndex = el === tabbable ? 0 : -1;
  });

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const keys = ['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft', 'Home', 'End'];
    if (!keys.includes(event.key)) return;
    const items = [...(ref.current?.querySelectorAll<HTMLElement>('[role="radio"]') ?? [])].filter(
      (el) => !el.hasAttribute('disabled'),
    );
    if (items.length === 0) return;
    event.preventDefault();
    const at = items.findIndex((el) => el === document.activeElement);
    const last = items.length - 1;
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? last
          : event.key === 'ArrowUp' || event.key === 'ArrowLeft'
            ? at <= 0
              ? last
              : at - 1
            : at === -1 || at === last
              ? 0
              : at + 1;
    const target = items[next];
    target?.focus();
    target?.click();
  };

  return (
    <div
      ref={ref}
      role="radiogroup"
      aria-label={labelledBy ? undefined : label}
      aria-labelledby={labelledBy}
      aria-describedby={describedBy}
      className={className}
      onKeyDown={onKeyDown}
    >
      {children}
    </div>
  );
}

/** Tells {@link Field} this child names itself. See the note there. */
ChoiceGroup.groupLabelled = true;

/** One option inside a {@link ChoiceGroup}. The caller owns everything inside. */
export function ChoiceOption({
  selected,
  onSelect,
  disabled,
  className,
  children,
}: {
  selected: boolean;
  onSelect: () => void;
  disabled?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      onClick={onSelect}
      className={className}
    >
      {children}
    </button>
  );
}
