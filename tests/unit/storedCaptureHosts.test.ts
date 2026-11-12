import { expect, it, vi } from 'vitest';
import { getActivePolicy, getPolicyVersion, listPolicyVersions } from '../../packages/database/src/repositories/agents';
import { logger } from '@xbam/shared';

const { queryOne, query } = vi.hoisted(() => ({ queryOne: vi.fn(), query: vi.fn() }));
vi.mock('../../packages/database/src/pool', () => ({ queryOne, query, withTransaction: vi.fn() }));

it('loads stored policies while dropping only invalid capture hosts and normalizing duplicates', async () => {
  const row = { id: 'version', config: { output: { maxCharacters: 240 }, media: { allowedCaptureHosts: [' Example.TEST ', 'https://bad.test', '*.bad.test', 'example.test', 'media.test'] } } };
  queryOne.mockResolvedValue(row);
  query.mockResolvedValue([row]);
  const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  try {
    const policies = [await getActivePolicy('agent'), await getPolicyVersion('version'), ...(await listPolicyVersions('agent'))];
    for (const policy of policies) {
      expect(policy?.config.media.allowedCaptureHosts).toEqual(['example.test', 'media.test']);
      expect(policy?.config.output.maxCharacters).toBe(240);
    }
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('Invalid capture hosts were dropped'), expect.objectContaining({ dropped: 2 }));
    expect(row.config.media.allowedCaptureHosts).toHaveLength(5);
  } finally { warn.mockRestore(); }
});
