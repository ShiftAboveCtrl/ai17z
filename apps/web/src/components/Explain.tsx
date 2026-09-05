import { useId, useState } from 'react';
import type { ReactNode } from 'react';
import { HelpCircle } from 'lucide-react';

/**
 * "What is this?", in one shape, everywhere.
 *
 * AI17Z was never short of explanation -- almost every screen carries a
 * sentence about what it does. What it lacked was *one way to ask*. Some
 * concepts were explained in a lede, some in a hint under a field, some in a
 * warning that only appeared once something was already wrong, and some only in
 * a document you had to leave the page to read. Somebody who did not understand
 * a word had no consistent move to make.
 *
 * So: a question mark, next to the thing, that opens plain language underneath
 * it. Three deliberate choices in that sentence.
 *
 * **In place, not a link.** Sending somebody to documentation to understand the
 * control in front of them loses their place and their nerve. The answer
 * belongs where the question is.
 *
 * **Open, not hover.** A tooltip cannot be read slowly, cannot be copied, does
 * not exist on a phone, and vanishes if you look away. This stays until it is
 * closed.
 *
 * **Plain language, not the reference.** The lede says what a section is for.
 * This says what it means for you, in the words somebody would use before they
 * knew the product's vocabulary -- and what happens if you leave it alone,
 * which is the question people are really asking.
 */
export function Explain({
  label = 'What is this?',
  children,
  className = '',
}: {
  /** What the button says to a screen reader. The thing being explained. */
  label?: string;
  children: ReactNode;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const id = useId();

  return (
    <span className={`inline-flex flex-col ${className}`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={id}
        aria-label={open ? `Hide the explanation of ${label}` : `What is ${label}?`}
        className={`inline-flex items-center gap-1 self-start rounded text-[11px] transition-colors ${
          open ? 'text-bone-dim' : 'text-bone-faint hover:text-bone-dim'
        }`}
      >
        <HelpCircle className="h-3.5 w-3.5" aria-hidden />
        <span className="underline decoration-dotted underline-offset-2">{open ? 'Close' : 'What is this?'}</span>
      </button>

      {open && (
        <span
          id={id}
          className="mt-2 block max-w-prose rounded-lg border border-ink-line bg-ink-raised/50 px-3.5 py-3 text-[13px] leading-relaxed text-bone-dim [&_p+p]:mt-2 [&_strong]:font-normal [&_strong]:text-bone"
        >
          {children}
        </span>
      )}
    </span>
  );
}
