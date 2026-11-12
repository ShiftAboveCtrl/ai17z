import { describe, expect, it } from 'vitest';
import { SEL } from '@xbam/channels';

/**
 * How many finished uploads the composer is holding.
 *
 * Live X dropped `data-testid="removeMedia"` and kept a button labelled
 * "Remove media" inside the attachments strip. The selector that only matched
 * the test id counted that strip as empty, so a picture that had finished
 * uploading was never treated as attached.
 */

interface Element {
  tag: string;
  attrs: string;
  ancestors: number[];
}

/** Opens tags in document order and remembers which elements contain them. */
function parse(html: string): Element[] {
  const elements: Element[] = [];
  const open: number[] = [];
  for (const token of html.matchAll(/<\/?([a-z0-9]+)\b([^>]*)>/gi)) {
    if (token[0]!.startsWith('</')) {
      open.pop();
      continue;
    }
    elements.push({ tag: token[1]!.toLowerCase(), attrs: token[2] ?? '', ancestors: [...open] });
    if (!token[0]!.endsWith('/>')) open.push(elements.length - 1);
  }
  return elements;
}

function compoundMatches(element: Element, compound: string): boolean {
  const tag = compound.match(/^[a-z0-9]+/i)?.[0]?.toLowerCase();
  if (tag && element.tag !== tag) return false;
  for (const attr of compound.matchAll(/\[([^\]=]+)="([^"]+)"\]/g)) {
    if (!new RegExp(`\\b${attr[1]}="${attr[2]}"`).test(element.attrs)) return false;
  }
  return true;
}

/**
 * One alternative of the selector, as descendant compounds.
 * An element counts when it matches the last compound and each earlier
 * compound matches one of its ancestors, nearest last.
 */
function matchesAlternative(elements: Element[], index: number, compounds: string[]): boolean {
  const element = elements[index];
  if (!element || !compoundMatches(element, compounds.at(-1)!)) return false;
  let depth = element.ancestors.length - 1;
  for (let part = compounds.length - 2; part >= 0; part -= 1) {
    let matched = false;
    while (depth >= 0) {
      const candidate = elements[element.ancestors[depth]!];
      depth -= 1;
      if (candidate && compoundMatches(candidate, compounds[part]!)) {
        matched = true;
        break;
      }
    }
    if (!matched) return false;
  }
  return true;
}

/** Compounds of one alternative. A space inside quotes belongs to the attribute, not the next compound. */
function compoundsOf(alternative: string): string[] {
  const out: string[] = [];
  let current = '';
  let quoted = false;
  for (const ch of alternative.trim()) {
    if (ch === '"') quoted = !quoted;
    if (ch === ' ' && !quoted) {
      if (current) out.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current) out.push(current);
  return out;
}

/** How many elements the selector matches. A comma is two alternatives, counted once. */
function matches(selector: string, html: string): number {
  const alternatives = selector.split(',').map(compoundsOf);
  const elements = parse(html);
  return elements.filter((_, index) =>
    alternatives.some((compounds) => matchesAlternative(elements, index, compounds)),
  ).length;
}

const LIVE_STRIP =
  '<div data-testid="attachments"><button aria-label="Remove media"></button></div>';

describe('composerMediaItem', () => {
  it('counts a finished upload that only has the Remove media button', () => {
    const today = '[data-testid="attachments"] [data-testid="removeMedia"]';
    expect(matches(today, LIVE_STRIP)).toBe(0);
    expect(SEL.composerMediaItem).toContain('button[aria-label="Remove media"]');
    expect(matches(SEL.composerMediaItem, LIVE_STRIP)).toBe(1);
  });

  it('still counts the test id X used to put on a finished upload', () => {
    const older = '<div data-testid="attachments"><div data-testid="removeMedia"></div></div>';
    expect(matches(SEL.composerMediaItem, older)).toBe(1);
  });

  it('does not count a Remove media button that sits outside the attachments strip', () => {
    expect(matches(SEL.composerMediaItem, '<button aria-label="Remove media"></button>')).toBe(0);
  });
});
