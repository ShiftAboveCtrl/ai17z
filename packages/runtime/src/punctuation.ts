/**
 * Punctuation an agent may not use, whatever it was asked for.
 *
 * The em dash is the single most reliable tell that a machine wrote something.
 * Almost nobody types one on a phone -- it is not on the keyboard -- and models
 * reach for it constantly, so a timeline of otherwise convincing replies gives
 * itself away on punctuation alone.
 *
 * This is not a setting. There is no policy field, no Easy Mode control and no
 * code path around it, for the same reason an agent may not name the model
 * running it: an option somebody can switch off is an option that will be on by
 * accident. Asking the model nicely is not enough either, because the
 * instruction decays over a long prompt exactly like the emoji instruction did.
 * So it is enforced on the finished text.
 *
 * Replacement is by meaning rather than by character. An em dash does one of
 * three jobs, and each has an ordinary equivalent:
 *
 *   parenthetical    "the fee -- which nobody reads -- is"   ->  commas
 *   a break in sense "it works, mostly -- until it doesn't"  ->  a semicolon
 *   a trailing aside "cheaper than the alternative -- barely" -> a comma
 *
 * Telling them apart properly needs a parser. What is here instead is the
 * distinction that actually matters in a reply: a *pair* of dashes is a
 * parenthetical and becomes commas; a single one is a break and becomes a
 * comma, or a colon where what follows is a list or an explanation. The result
 * reads like a person typed it, which is the whole point.
 */

/** Em dash, en dash used as one, and the horizontal bar. */
const DASHES = /[—–―]/;
const DASH_GLOBAL = /[—–―]/g;

/** A dash used as a minus sign or a range: 1914-1918, 3-4pm. Left alone. */
const NUMERIC_RANGE = /(\d)\s*[–—]\s*(\d)/g;

/*
  The same rhetorical pause, typed on a keyboard that has no em dash.

  A model that has been told not to use an em dash reaches for `--` or a spaced
  hyphen instead, and the result reads exactly as machine-written. Both are
  therefore the same offence and get the same treatment.

  **The hyphen itself is not the offence and must never be stripped generally.**
  `read-only`, `owner-configured`, `v1.0.0-beta.24`, `--dry-run` and every URL
  depend on it. What separates a rhetorical dash from a structural hyphen is
  simple and reliable: a rhetorical one has whitespace on **both** sides. A
  hyphen inside a word, a version or a URL never does.

  The one thing that also has whitespace on both sides is the argument
  separator in `npm run verify:install -- --twice`, so a `--` whose next
  non-space character is another hyphen is left alone. That is a command
  somebody pasted, not a sentence.
*/
const ASCII_PAIR = /(^|[ \t])--(?!\s*-)(?=[ \t])/;
const ASCII_PAIR_GLOBAL = /(^|[ \t])--(?!\s*-)(?=[ \t])/g;
/** A lone hyphen with a space either side, and a word on each end. */
const SPACED_HYPHEN = /(\w)[ \t]-[ \t](?=\w)/;
const SPACED_HYPHEN_GLOBAL = /(\w)[ \t]-[ \t](?=\w)/g;

export interface PunctuationResult {
  text: string;
  replaced: number;
  reason: string | null;
}

/**
 * Takes the em dashes out, leaving punctuation a person would have typed.
 *
 * Idempotent: running it on its own output changes nothing, which matters
 * because the validator may repair a message more than once.
 */
export function removeEmDashes(input: string): PunctuationResult {
  if (!DASHES.test(input) && !ASCII_PAIR.test(input) && !SPACED_HYPHEN.test(input)) {
    return { text: input, replaced: 0, reason: null };
  }

  let replaced = 0;
  // Ranges first, so the general rules below never see them. The sentinel is
  // a NUL, written as an escape rather than as a literal: it cannot occur in
  // user text because sanitizeText strips it, and a literal one in the source
  // is invisible to anybody reading this.
  const ranges: string[] = [];
  let text = input.replace(NUMERIC_RANGE, (match) => {
    ranges.push(match);
    return `\u0000RANGE${ranges.length - 1}\u0000`;
  });

  /*
    The ASCII forms become real dashes first, then go through the same rules.

    Normalising rather than duplicating the logic: a `--` doing a
    parenthetical's job should become commas exactly as an em dash would, and
    two implementations of that would disagree within a month.
  */
  text = text.replace(ASCII_PAIR_GLOBAL, (_match, before: string) => `${before}—`);
  text = text.replace(SPACED_HYPHEN_GLOBAL, (_match, before: string) => `${before}—`);

  // A matched pair around a clause is a parenthetical: commas do that job.
  text = text.replace(
    /\s*[—–―]\s*([^—–―]{1,80}?)\s*[—–―]\s*/g,
    (_match, inner: string) => {
      replaced += 2;
      return `, ${inner.trim()}, `;
    },
  );

  // What is left is a single dash. A colon where a list or an explanation
  // follows, a comma otherwise -- both of which people actually type.
  text = text.replace(/\s*[—–―]\s*/g, (_match, offset: number, whole: string) => {
    replaced += 1;
    const after = whole.slice(offset).replace(DASH_GLOBAL, '').trim();
    const looksExplanatory = /^(because|so|which|and that|the reason|it turns out)\b/i.test(after);
    return looksExplanatory ? ': ' : ', ';
  });

  for (const [index, original] of ranges.entries()) {
    text = text.replace(`\u0000RANGE${index}\u0000`, original);
  }

  // Commas can double up where a dash sat beside one already.
  text = text.replace(/,\s*,/g, ',').replace(/\s+,/g, ',').replace(/\s{2,}/g, ' ').trim();

  return {
    text,
    replaced,
    reason:
      replaced > 0
        ? `Replaced ${replaced} rhetorical dash${replaced === 1 ? '' : 'es'} with ordinary punctuation.`
        : null,
  };
}

/**
 * The instruction, for the prompt.
 *
 * Stated as well as enforced. Enforcement alone produces text that had to be
 * repaired; saying it up front means most drafts never need repairing, and the
 * ones that do are caught anyway.
 */
export const NO_EM_DASHES =
  'Never use a dash as punctuation: not an em dash, not an en dash, not a double hyphen, ' +
  'and not a hyphen with spaces around it. Not one, anywhere, for any reason. ' +
  'Use a comma, a semicolon, a colon, or start a new sentence. ' +
  'Hyphens inside words are fine and expected: read-only, owner-configured, v1.0.0-beta.24, --dry-run. ' +
  'It is the dash-as-a-pause that is banned. ' +
  'This is the single most obvious sign that a machine wrote something, and it cannot be turned on.';
