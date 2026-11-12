import { createElement } from 'react';
import { act, create } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import { DEFAULT_POLICY, EasySetup, MediaPolicy, POLICY_REACHABILITY } from '@xbam/shared/contracts';
import { toPolicy } from '../../packages/runtime/src/easyMode';
import { PoliciesSection } from '../../apps/web/src/routes/sections/PoliciesSection';

const { put } = vi.hoisted(() => ({ put: vi.fn().mockResolvedValue({}) }));
vi.mock('@app/lib/api', async (original) => ({ ...await original<typeof import('../../apps/web/src/lib/api')>(), put, get: vi.fn().mockResolvedValue(null) }));
vi.mock('@app/lib/hooks', () => ({ useReducedMotion: () => true, useResource: () => ({ data: { items: [] } }) }));

it('edits capture hosts through the advanced policy save', async () => {
  let tree!: ReturnType<typeof create>;
  await act(async () => { tree = create(createElement(PoliciesSection, { index: 1, agentId: 'agent', policy: DEFAULT_POLICY, version: 1, onSaved: () => undefined })); });
  try {
    const input = tree.root.findByProps({ name: 'allowedCaptureHosts' });
    act(() => input.props.onChange({ target: { value: 'example.test,' } }));
    expect(input.props.value).toBe('example.test,');
    act(() => input.props.onChange({ target: { value: 'example.test, media.example.test' } }));
    const save = tree.root.findAllByType('button').find((b) => b.children.join('').includes('Save'))!;
    await act(async () => { await save.props.onClick(); });
    expect(put).toHaveBeenLastCalledWith('/api/agents/agent/policy', expect.objectContaining({ config: expect.objectContaining({ media: expect.objectContaining({ allowedCaptureHosts: ['example.test', 'media.example.test'] }) }) }));
    expect(POLICY_REACHABILITY['media.allowedCaptureHosts'].where).toBe('ADVANCED_ONLY');
  } finally { act(() => tree.unmount()); }
});
it.each(['https://example.test', '*.example.test', 'example.test/path', 'example.test:443', '-bad.test', '192.0.2.1', '127.1', '0x7f000001', '[::1]', 'localhost', 'app.localhost'])('rejects non-hostname capture permission %s in the shared schema', (host) => {
  expect(MediaPolicy.safeParse({ allowedCaptureHosts: [host] }).success).toBe(false);
});
it('refuses to save invalid capture hosts from the editor', async () => {
  put.mockClear();
  let tree!: ReturnType<typeof create>;
  await act(async () => { tree = create(createElement(PoliciesSection, { index: 1, agentId: 'agent', policy: DEFAULT_POLICY, version: 1, onSaved: () => undefined })); });
  try {
    act(() => tree.root.findByProps({ name: 'allowedCaptureHosts' }).props.onChange({ target: { value: 'https://example.test' } }));
    await act(async () => { await tree.root.findAllByType('button').find((b) => b.children.join('').includes('Save'))!.props.onClick(); });
    expect(put).not.toHaveBeenCalled();
    expect(JSON.stringify(tree.toJSON())).toContain('Use a bare hostname');
  } finally { act(() => tree.unmount()); }
});
it('preserves capture permissions through an Easy Mode save', () => {
  const before = structuredClone(DEFAULT_POLICY);
  before.media.allowedCaptureHosts = ['example.test'];
  expect(toPolicy(EasySetup.parse({ character: { name: 'Scout' } }), before).media.allowedCaptureHosts).toEqual(['example.test']);
});

