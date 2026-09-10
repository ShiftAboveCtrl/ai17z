import type { ReactNode } from 'react';

/**
 * The pieces every Studio view is made of.
 *
 * Studio answers questions rather than editing settings, so it needs a
 * different vocabulary from the agent page: a claim, the reasons behind it, and
 * the things it could not measure. Those three shapes are here so that every
 * view presents them the same way -- a gap that looks like a footnote on one
 * screen and a warning on another teaches somebody that gaps do not matter.
 */

/** A heading for one answer, with the sentence that says what it is. */
export function Panel({
  title,
  lede,
  action,
  children,
}: {
  title: string;
  lede?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="mt-8 first:mt-0">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h2 className="text-lg font-light tracking-tight text-bone">{title}</h2>
        {action}
      </div>
      {lede && <p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-bone-faint">{lede}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

/** One thing being claimed, with a number and the sentence for it. */
export function Card({
  title,
  meta,
  score,
  children,
  action,
}: {
  title: ReactNode;
  meta?: ReactNode;
  score?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <article className="rounded-xl border border-ink-line px-4 py-3.5">
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <h3 className="min-w-0 break-words text-[15px] font-light text-bone">{title}</h3>
        {score !== undefined && <span className="ml-auto font-mono text-[12px] text-bone-dim">{score}</span>}
      </div>
      {meta && <p className="mt-1 break-words text-[12px] leading-relaxed text-bone-faint">{meta}</p>}
      {children && <div className="mt-3">{children}</div>}
      {action && <div className="mt-3">{action}</div>}
    </article>
  );
}

/**
 * The reasons a number came out the way it did.
 *
 * `docs/ENGINEERING.md`: "The reasons matter more than the scores." A score
 * without them is not shippable, so this is not an optional detail view -- the
 * factors are rendered next to every number this product produces.
 */
export function Reasons({ items }: { items: { name: string; detail: string; points: number }[] }) {
  if (items.length === 0) return null;
  return (
    <ul className="space-y-1.5">
      {items.map((item) => (
        <li key={`${item.name}-${item.detail}`} className="flex gap-3 text-[12px] leading-relaxed">
          <span
            className={`w-10 shrink-0 text-right font-mono ${
              item.points > 0 ? 'text-bone-dim' : item.points < 0 ? 'text-signal-fail' : 'text-bone-faint'
            }`}
          >
            {item.points > 0 ? `+${item.points}` : item.points}
          </span>
          <span className="min-w-0 break-words text-bone-faint">{item.detail}</span>
        </li>
      ))}
    </ul>
  );
}

/**
 * What could not be measured.
 *
 * Given the same weight as the findings rather than tucked under them. A score
 * resting on three missing measurements and one that was measured are
 * different claims, and only this tells them apart.
 */
export function Gaps({ items, label = 'Not known' }: { items: string[]; label?: string }) {
  if (items.length === 0) return null;
  return (
    <div className="mt-3 rounded-lg border border-dashed border-ink-line px-3.5 py-3">
      <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-bone-faint">{label}</p>
      <ul className="mt-2 space-y-1">
        {items.map((item) => (
          <li key={item} className="break-words text-[12px] leading-relaxed text-bone-faint">
            {item}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Something the evidence says outright, rather than something it suggests. */
export function Warnings({ items }: { items: string[] }) {
  if (items.length === 0) return null;
  return (
    <ul className="mt-3 space-y-1.5">
      {items.map((item) => (
        <li
          key={item}
          className="break-words rounded-lg border border-signal-fail/40 px-3.5 py-2.5 text-[12px] leading-relaxed text-bone-dim"
        >
          {item}
        </li>
      ))}
    </ul>
  );
}

/** A count with the words for what it counts, used across the Command view. */
export function Tally({ value, label, hint }: { value: number | string; label: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-ink-line px-4 py-3.5">
      <p className="font-mono text-2xl font-light text-bone">{value}</p>
      <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.2em] text-bone-faint">{label}</p>
      {hint && <p className="mt-2 text-[12px] leading-relaxed text-bone-faint">{hint}</p>}
    </div>
  );
}

/**
 * The answer when the agent has nothing connected.
 *
 * Every per-account view needs it, and they need the same one. A screen that
 * says "nothing is rising" to somebody who has not connected an account has
 * answered a question they did not ask and hidden the one thing they can do
 * about it -- and four views each inventing their own wording is how one of
 * them ends up saying nothing at all.
 */
export function NoAccount({ agentId, what }: { agentId: string; what: string }) {
  return (
    <div className="rounded-xl border border-dashed border-ink-line px-6 py-14 text-center">
      <p className="text-lg font-light text-bone-dim">Nothing connected yet</p>
      <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-bone-faint">
        {what} Connect an X account and this fills in as the agent starts seeing things.
      </p>
      <a className="btn-ghost mt-6 inline-block text-[12px]" href={`/agents/${agentId}#accounts`}>
        Connect an account
      </a>
    </div>
  );
}
