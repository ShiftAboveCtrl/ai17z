import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const web = resolve(__dirname, '../../apps/web/src');

function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return tsxFiles(full);
    return full.endsWith('.tsx') ? [full] : [];
  });
}

const ICONS = [
  'Copy', 'ExternalLink', 'Package', 'Pencil', 'Play', 'Square', 'Trash2', 'Trash', 'X', 'Check',
  'Plus', 'LogOut', 'RefreshCw', 'ArrowLeft', 'ArrowRight', 'ArrowUpRight', 'AlertTriangle',
  'Sparkles', 'ChevronDown', 'ChevronUp', 'ChevronRight', 'Search', 'Bell', 'Download', 'Upload',
  'Info', 'Link2', 'Eye', 'EyeOff', 'Clock', 'Zap', 'Shield', 'Send', 'FileText', 'Globe',
  'FolderOpen', 'Camera',
];

const iconTag = new RegExp(`<(${ICONS.join('|')})\\b([^>]*?)/>`, 'gs');

/**
 * An icon either says nothing or says what it means. Never neither.
 *
 * A decorative icon beside its own label has to be `aria-hidden`, or the label
 * is read twice. An icon that is the only thing carrying a meaning -- the
 * folder, page and file marks on a knowledge source -- has to be named, or the
 * meaning is simply absent for anybody not looking at it.
 *
 * The one this found was a delete button with no words in it at all. It
 * announced as "button", and it removed a knowledge source and everything the
 * agent had learned from it.
 */
describe('icons in the interface', () => {
  const files = tsxFiles(web);

  it('finds the icons to check', () => {
    // A guard on the guard: a rename that stops this matching anything would
    // otherwise turn into a permanently passing test.
    const total = files.reduce((n, f) => n + [...readFileSync(f, 'utf8').matchAll(iconTag)].length, 0);
    expect(total).toBeGreaterThan(60);
  });

  it('either hides an icon or names it', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(iconTag)) {
        const attrs = match[2] ?? '';
        if (attrs.includes('aria-hidden') || attrs.includes('aria-label')) continue;
        const line = source.slice(0, match.index).split('\n').length;
        offenders.push(`${file.slice(web.length + 1)}:${line} ${match[1]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('gives every control without words an accessible name', () => {
    // `<button>` whose entire content is one icon. What it does is otherwise
    // known only to somebody who can see the picture.
    const bare = new RegExp(`<button\\b([^>]*)>\\s*<(?:${ICONS.join('|')})\\b[^>]*/>\\s*</button>`, 'gs');
    const offenders: string[] = [];
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      for (const match of source.matchAll(bare)) {
        if ((match[1] ?? '').includes('aria-label')) continue;
        const line = source.slice(0, match.index).split('\n').length;
        offenders.push(`${file.slice(web.length + 1)}:${line}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

/**
 * The agent's name is announced once.
 *
 * It appeared twice in the page's text: the heading, and an `sr-only` span
 * inside the portrait -- itself inside an `aria-hidden` wrapper, so hidden
 * from sight and from assistive technology both, and reachable only by reading
 * the DOM. Which is exactly how it was found and reported.
 */
describe('the agent portrait', () => {
  const portrait = readFileSync(resolve(web, 'components/AgentPortrait.tsx'), 'utf8');

  it('carries no text of its own', () => {
    // The heading beside it is what names the agent. Matched on the element
    // rather than the word, because the comment explaining the removal
    // necessarily says "sr-only" too.
    expect(portrait).not.toMatch(/className="sr-only"/);
    expect(portrait).toContain('aria-hidden');
  });

  it('shows something where WebGL is unavailable', () => {
    // The case the sr-only span claimed to cover and could not: with scripting
    // on and WebGL off the canvas paints nothing, and an `sr-only` label is
    // invisible to the person looking at the empty box.
    expect(portrait).toContain('<AgentGlyph');
    expect(portrait).toContain('absolute inset-0');
    // `<noscript>` could never show: with scripting off, none of this renders.
    expect(portrait).not.toMatch(/^\s*<noscript>/m);
  });

  it('is the only place the page renders the name', () => {
    const page = readFileSync(resolve(web, 'routes/AgentPage.tsx'), 'utf8');
    /*
      Rendered as a child, on a line of its own -- not passed as a prop and not
      interpolated into a sentence. `name={agent.name}` on a glyph is the same
      string used as data, and "Delete {name}?" is a question, not a heading.
    */
    const asText = page.split('\n').filter((line) => line.trim() === '{agent.name}').length;
    expect(asText, 'the name is rendered as page text more than once').toBe(1);
  });
});
