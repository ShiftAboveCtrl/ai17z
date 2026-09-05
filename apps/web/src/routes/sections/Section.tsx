import type { ReactNode } from 'react';
import { AnimatedText, FadeIn } from '@app/components/motion';

/**
 * One domain per section.
 *
 * This began as an editorial layout -- 112px of padding either side, a heading
 * at 4.2vw, a 16-unit gap before anything you could touch. That reads well in a
 * screenshot and badly in use: sixteen of these stacked made the agent page
 * twenty-four screens tall, of which roughly nine were padding and headings.
 * Somebody adjusting a policy scrolled past a magazine to get to a checkbox.
 *
 * A tool is scanned and operated, not read top to bottom, so the density is now
 * an operating one. The character is kept -- the numbered eyebrow, the gradient
 * heading, the rule between sections -- at a size that leaves room for the
 * thing the section is actually for.
 */
export function Section({
  id,
  index,
  eyebrow,
  heading,
  lede,
  children,
  compact,
}: {
  id: string;
  index: number;
  eyebrow: string;
  heading: string;
  lede?: string;
  children: ReactNode;
  /**
   * The same section, without the editorial chrome.
   *
   * Easy Mode shows several of these on one screen, where a full-width
   * animated heading per section would be absurd. It is the presentation that
   * changes and nothing else: the body, its state and every request it makes
   * are the same component, which is what stops Easy and Advanced drifting
   * into two applications that configure the same agent differently.
   */
  compact?: boolean;
}) {
  if (compact) {
    return (
      <section id={id} className="scroll-mt-28">
        <div className="mb-4">
          <p className="eyebrow">{eyebrow}</p>
          <h3 className="mt-2 text-lg font-light text-bone">{heading}</h3>
          {lede && <p className="mt-2 max-w-2xl text-[13px] leading-relaxed text-bone-faint">{lede}</p>}
        </div>
        {children}
      </section>
    );
  }

  return (
    <section id={id} className="scroll-mt-24 border-t border-ink-line py-7 sm:py-14">
      <div className="mb-6 sm:mb-8">
        <FadeIn>
          <p className="eyebrow mb-2">
            {String(index).padStart(2, '0')} — {eyebrow}
          </p>
        </FadeIn>
        <AnimatedText
          as="h2"
          text={heading}
          className="monument text-[7vw] leading-[1.05] sm:text-[2.4rem] lg:text-[2.6rem]"
        />
        {lede && (
          <FadeIn delay={0.2}>
            <p className="mt-2 max-w-2xl text-[14px] font-light leading-relaxed text-bone-dim">{lede}</p>
          </FadeIn>
        )}
      </div>
      <FadeIn delay={0.1}>{children}</FadeIn>
    </section>
  );
}

/** Numbered entry used by the accounts, intelligence and tools sections. */
export function IndexedRow({
  index,
  label,
  title,
  meta,
  status,
  onClick,
  children,
}: {
  index: number;
  label: string;
  title: string;
  meta?: string;
  status?: ReactNode;
  onClick?: () => void;
  children?: ReactNode;
}) {
  const inner = (
    <>
      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2">
        <span className="font-mono text-[11px] tracking-[0.18em] text-bone-faint">{String(index).padStart(2, '0')}</span>
        <span className="font-mono text-[10px] uppercase tracking-[0.2em] text-bone-faint">{label}</span>
        <span className="ml-auto">{status}</span>
      </div>
      <p className="mt-1.5 text-lg font-light tracking-tight text-bone sm:text-xl">{title}</p>
      {meta && <p className="mt-1 text-[13px] leading-relaxed text-bone-dim">{meta}</p>}
      {children}
    </>
  );

  if (onClick) {
    return (
      <button type="button" onClick={onClick} className="block w-full border-t border-ink-line py-4 text-left transition-colors hover:bg-white/[0.015]">
        {inner}
      </button>
    );
  }
  return <div className="border-t border-ink-line py-4">{inner}</div>;
}
