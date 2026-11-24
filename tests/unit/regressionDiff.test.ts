import { expect, it } from 'vitest';
import * as runtime from '@xbam/runtime';
import type { DecisionDigest } from '@xbam/shared/contracts';

it('treats a rewritten answer as changed and broken silence as a regression', () => {
  expect(runtime).toHaveProperty('diffDigests');
  const stage = { outcome: 'RAN', detail: 'Passed' };
  const a: DecisionDigest = { decision: 'ANSWERED', answer: 'A useful answer', draft: 'A useful answer', validator: stage, voice: stage, worth: stage, personaVersionId: 'v1', policyVersionId: 'p1', modelRoles: [] };
  const diff = runtime.diffDigests;
  expect(diff(a, { ...a, answer: 'Another useful answer', draft: 'Another useful answer', personaVersionId: 'v2' }, {}).severity).toBe('CHANGED');
  expect(diff({ ...a, decision: 'SILENT', answer: null }, a, { mustBeSilent: true }).severity).toBe('REGRESSION');
});
