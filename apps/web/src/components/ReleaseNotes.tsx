import type { ReactNode } from 'react';

/**
 * Release notes, rendered.
 *
 * Small on purpose. The notes are Markdown written by us, in one workflow file,
 * using six constructs -- headings, bullets, bold, inline code, links, rules.
 * A Markdown library would be 40KB in the bundle to read one document that
 * nobody else writes.
 *
 * Nothing here builds HTML from the text. Every element is a React node, so a
 * release body cannot inject markup into this page whatever it contains --
 * which matters because it arrives over the network from a service, and a
 * renderer that reached for `dangerouslySetInnerHTML` would be trusting it.
 * Link targets are checked as well: only http and https survive, so a
 * `javascript:` href cannot get through.
 */
export function ReleaseNotes({ markdown }: { markdown: string }) {
  if (!markdown.trim()) {
    return <p className="text-sm text-bone-faint">This release came with no notes.</p>;
  }

  const blocks: ReactNode[] = [];
  let bullets: string[] = [];

  const flush = () => {
    if (bullets.length === 0) return;
    blocks.push(
      <ul key={`ul-${blocks.length}`} className="ml-4 list-disc space-y-1 text-sm leading-relaxed text-bone-dim">
        {bullets.map((item, index) => (
          <li key={index} className="break-words">
            {inline(item)}
          </li>
        ))}
      </ul>,
    );
    bullets = [];
  };

  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trimEnd();

    if (!line.trim()) {
      flush();
      continue;
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      flush();
      blocks.push(<hr key={`hr-${blocks.length}`} className="border-ink-line" />);
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flush();
      // Two sizes, not six. Deeper nesting than that is not something the notes
      // do, and a page of six type sizes reads as noise.
      const small = heading[1]!.length > 2;
      blocks.push(
        <p
          key={`h-${blocks.length}`}
          className={small ? 'eyebrow pt-1' : 'pt-1 text-sm font-medium text-bone'}
        >
          {inline(heading[2]!)}
        </p>,
      );
      continue;
    }

    const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
    if (bullet) {
      bullets.push(bullet[1]!);
      continue;
    }

    flush();
    blocks.push(
      <p key={`p-${blocks.length}`} className="break-words text-sm leading-relaxed text-bone-dim">
        {inline(line)}
      </p>,
    );
  }
  flush();

  return <div className="max-h-[22rem] space-y-3 overflow-y-auto pr-1">{blocks}</div>;
}

/** Bold, inline code and links, in one pass so they cannot nest wrongly. */
function inline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let key = 0;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    if (match[1] !== undefined) {
      nodes.push(
        <strong key={key++} className="font-medium text-bone">
          {match[1]}
        </strong>,
      );
    } else if (match[2] !== undefined) {
      nodes.push(
        <code key={key++} className="break-words font-mono text-[0.85em] text-bone">
          {match[2]}
        </code>,
      );
    } else {
      const href = match[4]!;
      // Anything but a web address is rendered as the text it was. A release
      // body arrives over the network, and `javascript:` in an href is the one
      // thing in Markdown that can do something.
      const safe = /^https?:\/\//i.test(href);
      nodes.push(
        safe ? (
          <a key={key++} href={href} target="_blank" rel="noreferrer" className="underline decoration-ink-line hover:text-bone">
            {match[3]}
          </a>
        ) : (
          <span key={key++}>{match[3]}</span>
        ),
      );
    }
    last = pattern.lastIndex;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}
