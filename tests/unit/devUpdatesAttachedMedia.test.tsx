import { createElement as h } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * The owner approves the file as well as the words, so the review screen has to
 * be able to show it. The artifact route answers only a signed-in caller and an
 * `<img src>` or `<video src>` sends no Authorization header, so the preview
 * fetches the file through the API and hands the element an object URL.
 */

const state = vi.hoisted(() => ({ fetchImageObjectUrl: vi.fn<(path: string) => Promise<string>>() }));
vi.mock('@app/lib/api', () => ({
  ApiError: class ApiError extends Error {},
  get: vi.fn(),
  fetchImageObjectUrl: state.fetchImageObjectUrl,
}));
vi.mock('@app/components/AgentGlyph', () => ({ AgentGlyph: () => null }));

import { AttachedMedia } from '../../apps/web/src/routes/devUpdates/parts';

const IMAGE = { artifactId: '11111111-1111-4111-8111-111111111111', kind: 'IMAGE', mime: 'image/png', bytes: 2048, url: '/api/artifacts/11111111-1111-4111-8111-111111111111' } as const;
const VIDEO = { artifactId: '22222222-2222-4222-8222-222222222222', kind: 'VIDEO', mime: 'video/mp4', bytes: 4 * 1024 * 1024, url: '/api/artifacts/22222222-2222-4222-8222-222222222222' } as const;

let trees: ReactTestRenderer[] = [];
function mount(element: Parameters<typeof create>[0]) {
  let tree!: ReactTestRenderer;
  act(() => { tree = create(element); });
  trees.push(tree);
  return tree;
}
const settle = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

afterEach(() => {
  act(() => trees.forEach((t) => t.unmount()));
  trees = [];
  state.fetchImageObjectUrl.mockReset();
  vi.restoreAllMocks();
});

describe('the attachment preview on the review screen', () => {
  it('shows an image from an object URL fetched through the API, never from the artifact address', async () => {
    state.fetchImageObjectUrl.mockResolvedValue('blob:image-1');
    const tree = mount(h(AttachedMedia, { media: [IMAGE] }));
    // Nothing is drawn from the raw route while the fetch is under way.
    expect(tree.root.findAllByType('img')).toHaveLength(0);
    await settle();

    expect(state.fetchImageObjectUrl).toHaveBeenCalledWith(IMAGE.url);
    expect(tree.root.findByType('img').props.src).toBe('blob:image-1');
  });

  it('shows a video the same way', async () => {
    state.fetchImageObjectUrl.mockResolvedValue('blob:video-1');
    const tree = mount(h(AttachedMedia, { media: [VIDEO] }));
    expect(tree.root.findAllByType('video')).toHaveLength(0);
    await settle();

    expect(state.fetchImageObjectUrl).toHaveBeenCalledWith(VIDEO.url);
    const video = tree.root.findByType('video');
    expect(video.props.src).toBe('blob:video-1');
    expect(video.props.controls).toBe(true);
  });

  it('never puts a credential in the address it asks for', async () => {
    state.fetchImageObjectUrl.mockResolvedValue('blob:x');
    mount(h(AttachedMedia, { media: [IMAGE, { ...IMAGE, artifactId: '33333333-3333-4333-8333-333333333333', url: '/api/artifacts/33333333-3333-4333-8333-333333333333' }] }));
    await settle();
    for (const [path] of state.fetchImageObjectUrl.mock.calls) {
      expect(path).toMatch(/^\/api\/artifacts\/[0-9a-f-]{36}$/);
      expect(path).not.toMatch(/[?&#]|token|auth/i);
    }
    expect(state.fetchImageObjectUrl).toHaveBeenCalledTimes(2);
  });

  it('says so when a file cannot be loaded, instead of a broken picture', async () => {
    state.fetchImageObjectUrl.mockRejectedValue(new Error('gone'));
    const tree = mount(h(AttachedMedia, { media: [IMAGE] }));
    await settle();
    expect(tree.root.findAllByType('img')).toHaveLength(0);
    expect(tree.root.findByProps({ role: 'alert' }).children.join('')).toMatch(/could not be loaded/);
  });

  it('releases the object URL when the preview goes away', async () => {
    state.fetchImageObjectUrl.mockResolvedValue('blob:release-me');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    const tree = mount(h(AttachedMedia, { media: [IMAGE] }));
    await settle();
    act(() => tree.unmount());
    trees = [];
    expect(revoke).toHaveBeenCalledWith('blob:release-me');
  });
});
