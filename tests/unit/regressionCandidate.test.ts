import { describe, expect, it } from 'vitest';
import type { JobRecord } from '@xbam/shared/contracts';
import { loadJobBundle } from '../../packages/runtime/src/loadJob';

describe('candidate safety', () => {
  it('permanently refuses a candidate on a live job before loading any configuration', async () => {
    const job = { dryRun: false, resolvedContext: { meta: { candidate: { persona: { displayName: 'Preview' } } } } } as unknown as JobRecord;
    await expect(loadJobBundle(job)).rejects.toMatchObject({ reason: 'candidate_not_dry', errorClass: 'PERMANENT' });
  });
});
