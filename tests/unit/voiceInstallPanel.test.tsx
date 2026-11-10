import { createElement } from 'react';
import { act, create } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import { VoiceInstallPanel } from '../../apps/web/src/components/VoiceInstallPanel';

const { post } = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock('@app/lib/api', async (original) => ({
  ...await original<typeof import('../../apps/web/src/lib/api')>(), post,
}));
vi.mock('@app/lib/hooks', () => ({ useElapsed: () => 0 }));

it('describes a failed Studio inspection honestly and retries the same listing', async () => {
  post.mockResolvedValue({
    inspection: { valid: false, problem: 'Studio could not be reached.', findings: [], notes: [] },
    document: null,
    source: { kind: 'STUDIO', listingId: 'voice_ab12cd34ef', version: null, publishedAt: null },
  });
  let tree!: ReturnType<typeof create>;
  act(() => { tree = create(createElement(VoiceInstallPanel)); });
  try {
    act(() => tree.root.findByProps({ id: 'voice-listing' }).props.onChange({ target: { value: 'voice_ab12cd34ef' } }));
    await act(async () => { tree.root.findAllByType('button').find((b) => b.children.includes('Look at it'))!.props.onClick(); });
    expect(JSON.stringify(tree.toJSON())).toContain('That voice could not be inspected.');
    expect(JSON.stringify(tree.toJSON())).not.toContain('That is not a voice AI17Z can use.');
    await act(async () => { tree.root.findAllByType('button').find((b) => b.children.includes('Try again'))!.props.onClick(); });
    expect(post).toHaveBeenNthCalledWith(2, '/api/studio/voices/inspect', { listingId: 'voice_ab12cd34ef' });
  } finally {
    act(() => tree.unmount());
  }
});
