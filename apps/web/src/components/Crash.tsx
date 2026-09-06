import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * The last thing between a bug and a black screen.
 *
 * React answers an error thrown during render by unmounting the whole tree. The
 * page is left with an empty `#root` over the application's own near-black
 * ground, so what somebody sees is a black rectangle: no message, no component
 * name, nothing to search for, and -- because the interface renders once before
 * it throws -- a flash of the real thing first, which reads as the application
 * refusing to load rather than as a fault.
 *
 * That is exactly what happened. `Home` gained a `useState` below its early
 * return, React threw `Rendered more hooks than during the previous render` on
 * the second render, and every installation showed a black screen on the agent
 * list. The bug took a minute to fix and most of an hour to find, because the
 * screen said nothing at all.
 *
 * So: a boundary. It cannot prevent the fault and does not try to. What it
 * guarantees is that a fault is *legible* -- named, with somewhere to go, and
 * with the exact text to quote in a report.
 *
 * Deliberately not a retry loop. A render error is almost never transient, and
 * a boundary that silently re-renders turns a reproducible crash into a
 * flicker. Reloading is offered; it is a button somebody presses.
 */
interface Props {
  children: ReactNode;
  /** Where this boundary sits, so the message can say which part gave way. */
  area: string;
}

interface State {
  error: Error | null;
  /** The component stack React hands over, which names the culprit. */
  where: string | null;
}

export class Crash extends Component<Props, State> {
  override state: State = { error: null, where: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // The only console call in the application, and it earns its place: this is
    // the one failure whose stack cannot be recovered any other way once the
    // tree is gone.
     
    console.error(`AI17Z: ${this.props.area} failed to render`, error, info.componentStack);
    this.setState({ where: info.componentStack ?? null });
  }

  override render(): ReactNode {
    const { error, where } = this.state;
    if (!error) return this.props.children;

    // The first frame of the component stack is the component that threw.
    const culprit = where?.trim().split('\n')[0]?.trim().replace(/^at\s+/, '') ?? null;

    return (
      <main className="mx-auto flex min-h-dvh max-w-2xl flex-col justify-center px-6 py-16">
        <p className="eyebrow mb-3 text-signal-fail">Something in AI17Z broke</p>
        <h1 className="mb-4 text-2xl text-bone">The {this.props.area} could not be drawn.</h1>
        <p className="mb-6 max-w-prose text-sm leading-relaxed text-bone-dim">
          This is a fault in AI17Z itself, not in your agents. Nothing has stopped: the worker is still running, and
          nothing you have configured has changed. Reloading usually gets you moving again, and if it does not, the
          text below is what to report.
        </p>

        {/*
          Machine-generated text, so it wraps -- an unwrapped stack frame pushes
          the layout wider than a phone.
        */}
        <div className="mb-6 border border-ink-line bg-ink-raise/40 p-4">
          <p className="break-words font-mono text-xs leading-relaxed text-signal-fail">{error.message}</p>
          {culprit && <p className="mt-2 break-words font-mono text-[11px] text-bone-faint">in {culprit}</p>}
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <button type="button" className="btn-primary" onClick={() => window.location.reload()}>
            Reload
          </button>
          <a className="btn-quiet text-xs" href="/">
            Back to agents
          </a>
          <a
            className="btn-quiet text-xs"
            href="https://github.com/ShiftAboveCtrl/ai17z/issues"
            target="_blank"
            rel="noreferrer"
          >
            Report it
          </a>
        </div>
      </main>
    );
  }
}
