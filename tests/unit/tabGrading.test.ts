import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TAB_ROLES } from '@xbam/browser';

const root = resolve(__dirname, '../..');
const diagnostics = readFileSync(resolve(root, 'packages/tools/src/diagnostics.ts'), 'utf8');
const tabs = readFileSync(resolve(root, 'packages/browser/src/tabs.ts'), 'utf8');

/**
 * The defect this pins, found on a real installation during promotion.
 *
 * The worker publishes `READY | BUSY | MISSING | FAILED`. The diagnostics
 * compared against 'HEALTHY', which the worker has never produced, so every
 * working tab was graded DEGRADED and every role not yet needed was graded
 * FAILING. On the health screen that reads as four broken tabs on a browser
 * that is working perfectly.
 *
 * It is the quiet kind of wrong: nothing throws, the page renders, and the only
 * symptom is a screen that is always a bit alarming. A screen that cries wolf
 * is worse than no screen, because people stop reading it.
 */
describe('the two vocabularies agree', () => {
  it('grades against the states the browser layer actually publishes', () => {
    // Read the union out of TabHealth rather than restating it, so adding a
    // fifth state fails here instead of being silently graded UNKNOWN.
    const union = tabs.match(/interface TabHealth \{[\s\S]*?state:\s*([^;]+);/);
    expect(union, 'TabHealth no longer declares a state union').toBeTruthy();
    const declared = [...union![1]!.matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]!);
    expect(declared.sort()).toEqual(['BUSY', 'FAILED', 'MISSING', 'READY']);

    for (const state of declared) {
      expect(diagnostics, `the grader does not handle ${state}`).toContain(`case '${state}':`);
    }
  });

  it('never compares a tab state against HEALTHY, which is not one', () => {
    // The exact mistake: 'HEALTHY' is a HealthState, not a TabHealth state.
    expect(diagnostics).not.toMatch(/tab\.state === 'HEALTHY'/);
  });

  it('treats a tab nobody has needed as off rather than failing', () => {
    // Tabs open on demand and RESEARCH spends most of its life closed. Calling
    // that broken means an agent doing exactly the right thing shows a fault.
    const grader = diagnostics.slice(diagnostics.indexOf('function gradeTab'));
    const missing = grader.slice(grader.indexOf("case 'MISSING':"), grader.indexOf("case 'FAILED':"));
    expect(missing).toContain("'OFF'");
    expect(missing).not.toContain("'FAILING'");
  });

  it('treats busy as working, because it means something is using it', () => {
    const grader = diagnostics.slice(diagnostics.indexOf('function gradeTab'));
    const busy = grader.slice(grader.indexOf("case 'BUSY':"), grader.indexOf("case 'MISSING':"));
    expect(busy).toContain("'HEALTHY'");
  });

  it('carries the reason on a failed tab rather than only the word', () => {
    const grader = diagnostics.slice(diagnostics.indexOf('function gradeTab'));
    const failed = grader.slice(grader.indexOf("case 'FAILED':"));
    expect(failed).toContain('lastError');
  });

  it('still has four roles, so the screen shows four rows', () => {
    expect([...TAB_ROLES].sort()).toEqual(['ACTION', 'MENTIONS', 'NOTIFICATIONS', 'RESEARCH']);
  });
});
