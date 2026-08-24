import type { ReactNode } from 'react';
import { AnimatedText, FadeIn } from '@app/components/motion';

/**
 * One domain per section, introduced by a monumental heading. Configuration is
 * revealed progressively rather than presented as a settings wall.
 */
export function Section({
  id,
  index,
  eyebrow,
  heading,
  lede,
  children,
}: {
  id: string;
  index: number;
  eyebrow: string;
  heading: string;
  lede?: string;
  children: ReactNode;
}) {
  return (
    <section id={id} className="scroll-mt-28 border-t border-ink-line py-20 sm:py-28">
      <div className="mb-12 sm:mb-16">
        <FadeIn>
          <p className="eyebrow mb-6">
            {String(index).padStart(2, '0')} — {eyebrow}
          </p>
        </FadeIn>
        <AnimatedText
          as="h2"
          text={heading}
          className="monument text-[11vw] leading-[0.86] sm:text-[5.2vw] lg:text-[4.2vw]"
        />
        {lede && (
          <FadeIn delay={0.2}>
            <p className="mt-6 max-w-2xl text-[15px] font-light leading-relaxed text-bone-dim">{lede}</p>
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
      <p className="mt-3 text-2xl font-light tracking-tight text-bone sm:text-3xl">{title}</p>
      {meta && <p className="mt-2 text-sm text-bone-dim">{meta}</p>}
      {children}
    </>
  );

  if (onClick) {
    return (
      <button type="button" onClick={onClick} className="block w-full border-t border-ink-line py-7 text-left transition-colors hover:bg-white/[0.015]">
        {inner}
      </button>
    );
  }
  return <div className="border-t border-ink-line py-7">{inner}</div>;
}
