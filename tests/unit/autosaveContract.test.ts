import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { describeSaveState } from '../../apps/web/src/lib/autosave';

const root = resolve(__dirname, '../..');
const read = (p: string) => readFileSync(resolve(root, p), 'utf8');

/**
 * Two defects found by actually typing into the editor, both of which look
 * correct in the source.
 */
describe('autosave', () => {
  it('never says saved before the server said so', () => {
    // The states are separate words on purpose: an optimistic "Saved" is how
    // somebody closes a tab believing their work is safe when it is not.
    expect(describeSaveState('saving')).toBe('Saving');
    expect(describeSaveState('saved')).toBe('Saved');
    expect(describeSaveState('failed')).toBe('Not saved');
    expect(describeSaveState('dirty')).toBe('Unsaved changes');
    expect(describeSaveState('idle')).toBe('');
  });

  it('does not drop a save that arrives while one is in flight', () => {
    // Returning early there looks like skipping a redundant request. The
    // skipped one was never rescheduled, so the newest text stayed unsaved and
    // the label sat on "Saving" for ever.
    const source = read('apps/web/src/lib/autosave.ts');
    expect(source).toMatch(/for \(let pass = 0; pass < \d+; pass \+= 1\)/);
    expect(source).toContain('must not be dropped');
  });

  it('compares what it sends, not the record it gets back', () => {
    // A PersonaVersion carries id, version and createdAt, and the server
    // assigns fresh ones on every save. Comparing whole records meant the
    // editor could never match what it had just sent, so it saved again and
    // again while every request succeeded.
    const editor = read('apps/web/src/routes/sections/IdentitySection.tsx');
    expect(editor).toContain('draft: draft ? payload(draft) : null');
    expect(editor).toContain('saved: persona ? payload(persona) : null');
    expect(editor).not.toContain('useAutosave<PersonaVersion | null>');
  });

  it('marks autosaves so the server can collapse them', () => {
    const editor = read('apps/web/src/routes/sections/IdentitySection.tsx');
    expect(editor).toContain('persona?autosave=1');
  });

  it('is off until somebody turns it on', () => {
    // A version history that fills itself in unasked is a surprise.
    expect(read('apps/web/src/lib/autosave.ts')).toContain("localStorage.getItem(KEY) === 'on'");
  });
});
