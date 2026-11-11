import { createElement } from 'react';
import { act, create } from 'react-test-renderer';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { expect, it, vi } from 'vitest';
import { PluginsPage } from '../../apps/web/src/routes/PluginsPage';

vi.mock('@app/lib/hooks', () => ({
  useElapsed: () => 0,
  usePolling: () => undefined,
  useReducedMotion: () => true,
  useResource: (path: string) => ({ data: path === '/api/studio' ? { state: 'NOT_CONFIGURED' } : path === '/api/plugins/registry' ? { url: null, key: { present: false, hint: null } } : { items: [] }, loading: false, reload: () => undefined }),
}));
vi.mock('@app/components/motion', () => ({ FadeIn: ({ children }: { children: React.ReactNode }) => children, AnimatedText: ({ text }: { text: string }) => text }));

it('opens Studio from the league deep link, prefills the season and clears it when leaving', () => {
  let location!: ReturnType<typeof useLocation>;
  function Location() { location = useLocation(); return null; }
  let tree!: ReturnType<typeof create>;
  act(() => { tree = create(createElement(MemoryRouter, { initialEntries: ['/plugins?tab=studio&season=week-45#league-entry'] }, createElement(PluginsPage), createElement(Location))); });
  try {
    expect(tree.root.findByProps({ id: 'league-entry' })).toBeDefined();
    expect(tree.root.findByProps({ name: 'leagueSeason' }).props.value).toBe('week-45');
    act(() => tree.root.findAllByType('button').find(button => button.children.join('') === 'settings')!.props.onClick());
    expect(new URLSearchParams(location.search).get('tab')).toBe('settings');
    expect(new URLSearchParams(location.search).has('season')).toBe(false);
    act(() => tree.root.findAllByType('button').find(button => button.children.join('') === 'studio')!.props.onClick());
    expect(tree.root.findByProps({ name: 'leagueSeason' }).props.value).toBe('');
  } finally { act(() => tree.unmount()); }
});
