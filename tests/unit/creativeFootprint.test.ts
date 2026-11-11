import { describe, expect, it } from 'vitest';
import { pluginFootprint, footprintExpansion } from '@xbam/shared';
import type { PluginManifest } from '@xbam/shared/contracts';

describe('creative Plugin approval expansion', () => {
  const base = { features: [], capabilities: [], config: [] } as unknown as PluginManifest;
  it('regression: names creative provider access to the post brief', () => {
    const after = { ...base, features: ['CREATIVE_PROVIDER'], creative: { capability: 'image', promptField: 'prompt', imageField: 'image' } } as PluginManifest;
    expect(footprintExpansion(pluginFootprint(base), pluginFootprint(after)).join(' ')).toContain('post brief');
  });
  it('regression: reports changes to the creative declaration even with the feature already approved', () => {
    const before = { ...base, features: ['CREATIVE_PROVIDER'], creative: { capability: 'image', promptField: 'prompt', imageField: 'image' } } as PluginManifest;
    const after = { ...before, creative: { ...before.creative!, promptField: 'brief' } };
    expect(footprintExpansion(pluginFootprint(before), pluginFootprint(after)).join(' ')).toContain('creative');
  });
});
