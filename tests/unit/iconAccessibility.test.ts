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
