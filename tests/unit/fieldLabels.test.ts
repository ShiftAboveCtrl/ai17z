import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const ui = readFileSync(resolve(__dirname, '../../apps/web/src/components/ui.tsx'), 'utf8');

/**
 * A visible label is not the same as a label the control has.
 *
 * `Field` renders a `<label>` above whatever it wraps, and took an optional
 * `htmlFor` that most callers did not pass -- so most of them rendered text
 * that looks like a label and a control with no accessible name at all. An
 * audit of the running app found ten of them on one screen: every number and
 * text input in Policies, including the outreach limits.
 *
 * Nobody would notice by looking, which is exactly why this is a standing test
 * rather than a fixed entry. The association has to be automatic, because the
 * failure mode is a caller forgetting an optional prop.
 */
describe('a field labels the control it wraps', () => {
  const field = ui.slice(ui.indexOf('export function Field('), ui.indexOf('export function Toggle('));

  it('finds the component where this test thinks it is', () => {
    expect(field).toContain('<label');
    expect(field.length).toBeGreaterThan(200);
  });

  it('makes an id itself rather than relying on the caller', () => {
    // useId is React's answer for exactly this: stable across renders, unique
    // per instance, and impossible for a caller to forget.
    expect(field).toMatch(/useId\(\)/);
  });

  it('points the label at that id', () => {
    expect(field).toMatch(/htmlFor=\{[^}]*\}/);
  });

  it('still lets a caller name the control themselves', () => {
    // Some controls already have an id, and taking that away would break the
    // association rather than add one.
    expect(field).toContain('htmlFor');
  });

  it('names a group when what it wraps is not a single control', () => {
    // A row of buttons cannot take an id from a label, so the label names the
    // group instead. Without this those fields stay anonymous.
    expect(field).toMatch(/aria-labelledby/);
  });
});
