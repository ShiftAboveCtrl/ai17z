import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const web = resolve(__dirname, '../../apps/web/src');
const read = (p: string) => readFileSync(resolve(web, p), 'utf8');

function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return tsxFiles(full);
    return full.endsWith('.tsx') ? [full] : [];
  });
}

/**
 * Choosing one of several was a row of plain buttons, everywhere.
 *
 * Automation mode, permission profile, which provider, who it answers, how it
 * writes, how often it posts -- eleven groups, and a screen reader heard a row
 * of buttons with nothing saying that one of them was chosen. A keyboard user
 * tabbed through every option instead of arrowing between them.
 */
describe('single-choice pickers', () => {
  it('are radio groups rather than rows of buttons', () => {
    // The screens that hold them. A group added elsewhere is not caught here,
    // which is why the rule below -- no orphan radios -- is the real guard.
    for (const file of [
      'routes/EasySetup.tsx',
      'routes/sections/PoliciesSection.tsx',
      'components/CapabilitiesPanel.tsx',
      'components/TopBar.tsx',
    ]) {
      expect(read(file), file).toContain('<ChoiceGroup');
      expect(read(file), file).toContain('<ChoiceOption');
    }
  });

  it('never leave a radio outside a group', () => {
    // An orphan `role="radio"` is invalid: a screen reader has nothing to
    // count it against, so it cannot say "2 of 5".
    for (const file of tsxFiles(web)) {
      const source = readFileSync(file, 'utf8');
      if (!source.includes('role="radio"')) continue;
      const name = file.slice(web.length + 1);
      // Either the file declares the group itself, or it uses the shared one.
      expect(source.includes('role="radiogroup"') || source.includes('<ChoiceGroup'), name).toBe(true);
    }
  });

  it('names every group, from the visible label where there is one', () => {
    const source = read('components/ui.tsx');
    expect(source).toContain('role="radiogroup"');
    // A `Field` around the group passes the id of the label already on screen,
    // so the name a screen reader hears is the one somebody can read rather
    // than a second copy in a prop that can drift from it.
    expect(source).toContain('aria-labelledby={labelledBy}');
    expect(source).toContain('aria-label={labelledBy ? undefined : label}');
    // `label` is required, so a group cannot be shipped unnamed either way.
    expect(source).toMatch(/label: string;/);
  });

  it('makes exactly one option tabbable', () => {
    // Roving tabindex. Every option tabbable turns a five-option group into
    // five stops; none tabbable makes it unreachable, which is what a
    // hand-rolled version gets wrong when nothing is selected yet.
    const source = read('components/ui.tsx');
    expect(source).toContain('el.tabIndex = el === tabbable ? 0 : -1');
    expect(source).toMatch(/chosen \?\? items\.find/);
  });

  it('moves and chooses with the arrow keys', () => {
    // Selection follows focus, which is what a native radio group does. An
    // arrow key that moves without choosing is a group where the keyboard and
    // the mouse disagree.
    const source = read('components/ui.tsx');
    for (const key of ['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft', 'Home', 'End']) {
      expect(source, key).toContain(`'${key}'`);
    }
    expect(source).toContain('target?.click()');
  });
});

/**
 * A dialog that can be tabbed out of is a panel that happens to be on top.
 */
describe('dialogs', () => {
  const ui = read('components/ui.tsx');

  it('keeps Tab inside while it is open', () => {
    // `aria-modal` confines a screen reader and nothing else: the page behind
    // is covered, scroll-locked, and still fully focusable.
    expect(ui).toContain("event.key !== 'Tab'");
    expect(ui).toContain('last.focus()');
    expect(ui).toContain('first.focus()');
  });

  it('puts focus back where it was', () => {
    // Otherwise closing drops somebody at the top of the page with no idea
    // what they had been operating.
    expect(ui).toContain('const returnTo = document.activeElement');
    expect(ui).toContain('if (returnTo?.isConnected) returnTo.focus()');
  });

  it('still closes on Escape and is announced', () => {
    expect(ui).toContain("event.key === 'Escape'");
    expect(ui).toContain('aria-modal="true"');
    expect(ui).toContain('aria-label={title}');
  });
});

/**
 * The parts of the page that change on their own have to say so.
 */
describe('what gets announced', () => {
  it('announces the agent status when it changes', () => {
    expect(read('components/LiveStatus.tsx')).toContain('role="status"');
  });

  it('announces a save that clears itself', () => {
    expect(read('components/ui.tsx')).toMatch(/role="status"[\s\S]{0,400}saved/);
  });

  it('announces what is stopping an agent', () => {
    expect(read('components/Blockers.tsx')).toContain('role="status"');
  });
});

/**
 * A hint and an error rendered under a field are not part of it.
 *
 * Both were loose paragraphs: a screen reader read the label and stopped, so
 * "Exactly as the provider names it" and "that model does not exist" were on
 * screen and unsaid. `aria-invalid` is what turns the error from red text into
 * a state something can act on.
 */
describe('fields and what they say about themselves', () => {
  const ui = read('components/ui.tsx');

  it('describes a control with its own hint', () => {
    expect(ui).toContain("'aria-describedby': describedBy");
    expect(ui).toMatch(/const hintId = hint && !error/);
  });

  it('prefers the error over the hint when there is one', () => {
    // Two descriptions is one too many, and the error is the one that matters.
    expect(ui).toContain('const describedBy = errorId ?? hintId;');
  });

  it('marks a field with an error as invalid', () => {
    expect(ui).toContain("...(error ? { 'aria-invalid': true } : {})");
  });

  it('does not name a group twice', () => {
    // A `Field` around a `ChoiceGroup` used to wrap it in a second labelled
    // group, so the same words were announced before the options and again
    // around them -- and `htmlFor` pointed at an element labels cannot address.
    expect(ui).toContain('groupLabelled');
    expect(ui).toMatch(/const selfLabelled = Boolean/);
  });
});
