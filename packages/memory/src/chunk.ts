/**
 * Cutting a document into pieces an agent can be asked about.
 *
 * The unit that matters is the section, not the paragraph and not the file. A
 * paragraph loses the heading that says what it is about, so "it needs Node 22"
 * comes back with no way to tell whether that is the installer, the dev setup or
 * the Docker image. A whole file is worse in the other direction: retrieving one
 * README to answer one question spends the entire memory budget on a document
 * that is mostly about something else.
 *
 * So: split on headings, keep the heading trail on every piece, and only split
 * further when a section is genuinely too long to hand to a model.
 */

/** Where a chunk came from, kept for attribution and for refreshing. */
export interface ChunkOrigin {
  /** Path relative to the source root, in POSIX form so it reads the same everywhere. */
  path: string;
  /** The heading trail, e.g. "Installing > Windows". Empty for a preamble. */
  heading: string;
  /** What the source was when this was read: a commit, a release, a date. */
  revision?: string | null;
  modifiedAt?: string | null;
}

export interface Chunk {
  /** Heading trail and body together: what actually reaches the model. */
  content: string;
  /** Body without the heading trail, for display. */
  body: string;
  origin: ChunkOrigin;
}

export interface ChunkOptions {
  /**
   * Characters, not tokens, because the budget this protects is the prompt's
   * and it is enforced in characters everywhere else in the system.
   */
  maxChars?: number;
  /** Sections shorter than this are folded into the next one. */
  minChars?: number;
}

const DEFAULT_MAX = 1_400;
/**
 * Low on purpose. This threshold folds away stubs -- a heading with "See below."
 * under it -- and nothing else. Set high enough to swallow a real short
 * paragraph it does active harm: "Installing: there are two supported ways"
 * would be absorbed into the Windows section beneath it, and the heading trail
 * that tells Windows apart from Ubuntu goes with it. A short section that says
 * something is a fine answer; a mislabelled one is not.
 */
const DEFAULT_MIN = 40;

/** An ATX heading: the hashes, then the text. Setext headings are not handled. */
const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;

/** Lines that open or close a fenced code block. */
const FENCE = /^\s*(?:```|~~~)/;

interface Section {
  trail: string[];
  lines: string[];
}

/**
 * Split markdown into sections by heading, ignoring anything inside a fence.
 *
 * The fence check is not fussiness. Shell examples and config samples are full
 * of `# comment` lines, and treating those as headings shatters a code block
 * into fragments that are individually meaningless and collectively wrong.
 */
function sections(text: string): Section[] {
  const out: Section[] = [];
  const trail: string[] = [];
  let current: Section = { trail: [], lines: [] };
  let inFence = false;

  for (const line of text.split(/\r?\n/)) {
    if (FENCE.test(line)) inFence = !inFence;

    const heading = inFence ? null : line.match(HEADING);
    if (!heading) {
      current.lines.push(line);
      continue;
    }

    if (current.lines.some((l) => l.trim())) out.push(current);
    const depth = heading[1]!.length;
    const title = heading[2]!.trim();
    trail.length = Math.max(0, depth - 1);
    trail[depth - 1] = title;
    current = { trail: trail.filter(Boolean).slice(), lines: [] };
  }
  if (current.lines.some((l) => l.trim())) out.push(current);
  return out;
}

/**
 * Split a body that is too long on its own.
 *
 * Paragraph boundaries first, and a hard cut only if a single paragraph is
 * itself over the limit, which is usually a table or a long code block. Cutting
 * mid-sentence is ugly; dropping the content entirely is worse.
 */
function splitLong(body: string, maxChars: number): string[] {
  if (body.length <= maxChars) return [body];

  const parts: string[] = [];
  let buffer = '';
  for (const paragraph of body.split(/\n{2,}/)) {
    const candidate = buffer ? `${buffer}\n\n${paragraph}` : paragraph;
    if (candidate.length <= maxChars) {
      buffer = candidate;
      continue;
    }
    if (buffer) parts.push(buffer);

    if (paragraph.length <= maxChars) {
      buffer = paragraph;
      continue;
    }
    for (let at = 0; at < paragraph.length; at += maxChars) {
      parts.push(paragraph.slice(at, at + maxChars));
    }
    buffer = '';
  }
  if (buffer) parts.push(buffer);
  return parts.filter((p) => p.trim());
}

/**
 * One document into chunks.
 *
 * Every chunk carries its heading trail in the text, because that trail is
 * often the only thing distinguishing two otherwise identical passages -- the
 * Windows and Ubuntu halves of an installation page say much the same words
 * about much the same steps.
 */
export function chunkDocument(text: string, origin: Omit<ChunkOrigin, 'heading'>, options: ChunkOptions = {}): Chunk[] {
  const maxChars = options.maxChars ?? DEFAULT_MAX;
  const minChars = options.minChars ?? DEFAULT_MIN;

  const chunks: Chunk[] = [];
  let carry: Section | null = null;

  const flush = (section: Section) => {
    const body = section.lines.join('\n').trim();
    if (!body) return;
    const heading = section.trail.join(' > ');
    for (const piece of splitLong(body, maxChars)) {
      chunks.push({
        content: heading ? `${heading}\n\n${piece}` : piece,
        body: piece,
        origin: { ...origin, heading },
      });
    }
  };

  for (const section of sections(text)) {
    const body = section.lines.join('\n').trim();
    if (!body) continue;

    // A heading with two words under it is not worth retrieving alone. Fold it
    // forward, keeping the earlier heading trail, so the pieces that survive
    // are ones that could answer something.
    if (carry) {
      // The later trail, not the earlier one. A stub folded forward takes the
      // label of the section it joined, because that is what the text is now
      // mostly about; keeping the stub's heading would file a page of Windows
      // instructions under whatever generic word sat above it.
      const merged: Section = { trail: section.trail, lines: [...carry.lines, '', ...section.lines] };
      carry = null;
      if (merged.lines.join('\n').trim().length < minChars) {
        carry = merged;
        continue;
      }
      flush(merged);
      continue;
    }

    if (body.length < minChars) {
      carry = section;
      continue;
    }
    flush(section);
  }

  // Whatever is left is short, but it is content and dropping it silently is
  // how a knowledge base ends up missing exactly the one-line answer somebody
  // needed.
  if (carry) flush(carry);

  return chunks;
}
