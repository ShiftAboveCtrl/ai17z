import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('schedules approvals for every worker independently of owner chat', () => {
  const source = readFileSync(new URL('../../apps/worker/src/main.ts', import.meta.url), 'utf8');
  expect(source).toMatch(/const approvalQueue = startLoop\('capability-approvals', 5_000, sweepCapabilityApprovals, 'ESSENTIAL'\)/);
  const chat = source.slice(source.indexOf('const chat = startLoop('), source.indexOf('const published = new Set'));
  expect(chat).not.toContain('sweepCapabilityApprovals');
  expect(source).toContain('clearInterval(approvalQueue)');
});
