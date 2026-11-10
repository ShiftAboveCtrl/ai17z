import { describe, expect, it } from 'vitest';
import { INTROSPECTION_CAPABILITIES } from '../../packages/runtime/src/introspectionCapabilities';
import { shortlistCapabilities } from '@xbam/runtime';

describe('inspectable memory capability', () => {
  it('offers a read only owner capability for questions about remembered facts and evidence', () => {
    const capability = INTROSPECTION_CAPABILITIES.find((c) => c.id === 'agent.memory');
    expect(capability).toMatchObject({ audience: 'OWNER', effect: 'READ', modelCallable: true });
    expect(shortlistCapabilities(INTROSPECTION_CAPABILITIES, 'what do you remember about Heron and why?').offered.map((c) => c.id)).toContain('agent.memory');
  });
});
