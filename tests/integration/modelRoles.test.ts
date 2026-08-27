import { describe, expect, it } from 'vitest';
import { MODEL_ROLES } from '@xbam/shared/contracts';
import { providers } from '@xbam/database';
import { installHarness } from '../support/harness';
import { createFixture } from '../support/fixtures';

installHarness();

/**
 * Same guard as the account statuses: an enum the code can write and the
 * database refuses is a failure nothing catches until somebody uses it.
 */
describe('every model role the code can produce is one the database accepts', () => {
  it('stores a config for each role in the contract', async () => {
    const fixture = await createFixture();
    for (const role of MODEL_ROLES) {
      await providers.setModelConfig({
        agentId: fixture.agentId,
        role,
        providerCredentialId: fixture.providerId,
        model: 'mock-echo',
        parameters: {},
      });
    }
    const configs = await providers.listModelConfigs(fixture.agentId);
    expect(configs.map((c) => c.role).sort()).toEqual([...MODEL_ROLES].sort());
  });
});
