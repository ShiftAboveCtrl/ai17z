import { createElement as h, type ReactNode } from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  post: vi.fn(), params: new URLSearchParams(), resources: new Map<string, any>(),
}));
vi.mock('@app/lib/api', () => ({ post: state.post }));
vi.mock('@app/lib/hooks', () => ({
  useElapsed: () => 0, usePolling: () => {},
  useResource: (path: string) => state.resources.get(path) ?? resource(null),
}));
vi.mock('react-router-dom', () => ({
  Link: ({ children }: { children: ReactNode }) => children,
  useNavigate: () => vi.fn(),
  useSearchParams: () => [state.params, (next: any) => { state.params = typeof next === 'function' ? next(state.params) : next; }],
}));
vi.mock('@app/components/ui', () => ({
  EmptyState: ({ title, detail }: any) => h('p', null, title, detail),
  RetryablePanel: ({ detail }: any) => h('aside', null, detail),
  Tabs: () => null, Working: () => null,
}));
vi.mock('@app/components/Explain', () => ({ Explain: () => null }));
vi.mock('@app/components/motion', () => ({ AnimatedText: () => null }));
vi.mock('../../apps/web/src/routes/devUpdates/NewProject', () => ({ NewProject: () => null }));
vi.mock('../../apps/web/src/routes/devUpdates/Connect', () => ({ Connect: () => null }));
vi.mock('../../apps/web/src/routes/devUpdates/Rules', () => ({ Rules: () => null }));
vi.mock('../../apps/web/src/routes/devUpdates/Log', () => ({ Log: ({ updates }: any) => h('p', null, updates.map((u: any) => u.title).join(',')) }));
vi.mock('../../apps/web/src/routes/devUpdates/parts', () => ({
  PostPreview: ({ text, children }: any) => h('div', null, text, children),
  ProblemList: () => null, CharMeter: () => null, CopyButton: () => null,
  problemOf: () => ['Request failed'],
}));

import { Review } from '../../apps/web/src/routes/devUpdates/Review';
import { DevUpdatesPage } from '../../apps/web/src/routes/DevUpdatesPage';
import { NewProject } from '../../apps/web/src/routes/devUpdates/NewProject';
import { TokenReveal } from '../../apps/web/src/routes/devUpdates/TokenReveal';
import { setTransport } from '../../apps/web/src/lib/transport';

function resource(data: any, error: string | null = null) { return { data, error, loading: false, reload: vi.fn() }; }
const project = { id: 'p', projectKey: 'demo', displayName: 'Demo', agentId: 'a', accountId: 'c', enabled: true, rehearse: false, mode: 'DRAFT', senderToken: { active: true } };
const draft = { id: 'u', kind: 'FIX', title: 'A loaded draft', post: 'The reviewed post', summary: 'A change', why: 'It matters', evidence: [], createdAt: new Date().toISOString() };
let trees: ReactTestRenderer[] = [];
function mount(element: any) { let tree!: ReactTestRenderer; act(() => { tree = create(element); }); trees.push(tree); return tree; }
function content(tree: ReactTestRenderer) { return JSON.stringify(tree.toJSON()); }
function button(tree: ReactTestRenderer, text: string) { return tree.root.findAllByType('button').find((b) => b.children.includes(text))!; }
function page() {
  state.resources.set('/api/dev-updates/projects', resource({ items: [project] }));
  state.resources.set('/api/agents', resource({ items: [] }));
  state.resources.set('/api/agents/a', resource({ agent: { id: 'a' }, policy: { config: { automation: { dryRunDefault: false, mode: 'AUTONOMOUS' } } } }));
  for (const suffix of ['', '&status=PENDING_REVIEW']) state.resources.set(`/api/dev-updates/updates?projectId=p${suffix}&limit=200`, resource({ items: [draft] }));
  return mount(h(DevUpdatesPage));
}
beforeEach(() => {
  state.post.mockReset().mockResolvedValue({}); state.resources.clear(); state.params = new URLSearchParams();
  vi.stubGlobal('window', { location: { origin: 'https://studio.example.invalid' }, clearTimeout });
  vi.stubGlobal('document', new EventTarget());
  setTransport({ mode: 'LOCAL', base: '' });
});
afterEach(() => { act(() => trees.forEach((t) => t.unmount())); trees = []; vi.unstubAllGlobals(); });

describe('R4 deferred dev-updates regressions', () => {
  it.each(['approve', 'reject'] as const)('keeps a successful %s decision locked until the queue refreshes', async (decision) => {
    const tree = mount(h(Review, { updates: [draft] as any, agent: null, handle: null, rehearse: false, onDecided: vi.fn() }));
    if (decision === 'reject') {
      act(() => button(tree, 'Reject').props.onClick());
      act(() => tree.root.findByType('textarea').props.onChange({ target: { value: 'Not announced' } }));
    }
    const decide = button(tree, decision === 'approve' ? 'Approve' : 'Reject it').props.onClick;
    await act(async () => { decide(); decide(); });
    await act(async () => { decide(); });
    expect(state.post).toHaveBeenCalledTimes(1);
    expect(tree.root.findAllByType('button').every((b) => b.props.disabled)).toBe(true);
  });

  it('allows a failed decision to be retried', async () => {
    state.post.mockRejectedValueOnce(new Error('Offline'));
    const tree = mount(h(Review, { updates: [draft] as any, agent: null, handle: null, rehearse: false, onDecided: vi.fn() }));
    await act(async () => button(tree, 'Approve').props.onClick());
    expect(button(tree, 'Approve').props.disabled).toBe(false);
    await act(async () => button(tree, 'Approve').props.onClick());
    expect(state.post).toHaveBeenCalledTimes(2);
    expect(button(tree, 'Approve').props.disabled).toBe(true);
  });

  it('names the actual publishing hold in Review instead of promising a send', () => {
    for (const [enabled, config, expected] of [
      [false, { dryRunDefault: false, mode: 'AUTONOMOUS' }, /paused/],
      [true, { dryRunDefault: true, mode: 'AUTONOMOUS' }, /agent.*dry run/],
      [true, { dryRunDefault: false, mode: 'OFF' }, /automation.*off/],
    ] as const) {
      state.resources.clear(); const tree = page();
      state.resources.set('/api/dev-updates/projects', resource({ items: [{ ...project, enabled }] }));
      state.resources.set('/api/agents/a', resource({ agent: { id: 'a' }, policy: { config: { automation: config } } }));
      act(() => tree.update(h(DevUpdatesPage)));
      const review = tree.root.findByType(Review);
      const paragraphs = review.findAllByType('p').map((p) => p.children.join(' ')).join(' ');
      expect(paragraphs).toMatch(expected);
      expect(paragraphs).not.toContain('Approving queues it for');
    }
  });

  it('keeps loaded projects and drafts visible alongside poll errors', () => {
    const tree = page();
    for (const [path, value] of state.resources) if (path.includes('/dev-updates/')) state.resources.set(path, { ...value, error: 'Poll failed' });
    act(() => tree.update(h(DevUpdatesPage)));
    expect(content(tree)).toContain('A loaded draft');
    expect(content(tree)).toContain('Poll failed');
    state.params.set('tab', 'log'); act(() => tree.update(h(DevUpdatesPage)));
    expect(content(tree)).toContain('A loaded draft');
    expect(content(tree)).toContain('Poll failed');
  });

  it('hides a revealed token on Escape and removes its listener on unmount', () => {
    const done = vi.fn();
    const tree = mount(h(TokenReveal, { token: `ai17z_dus_${'a'.repeat(32)}`, projectKey: 'demo', projectName: 'Demo', connection: null, connectionError: null, onDone: done }));
    const event = new Event('keydown'); Object.defineProperty(event, 'key', { value: 'Escape' });
    act(() => { document.dispatchEvent(event); }); expect(done).toHaveBeenCalledTimes(1);
    act(() => tree.unmount()); document.dispatchEvent(event); expect(done).toHaveBeenCalledTimes(1);
  });

  it('selects an asynchronously created project using the current query parameters', () => {
    state.params = new URLSearchParams('filter=old'); const tree = page();
    const created = tree.root.findByType(NewProject).props.onCreated;
    state.params = new URLSearchParams('filter=current&tab=log');
    act(() => tree.update(h(DevUpdatesPage)));
    act(() => created({ ...project, id: 'new' }, true));
    expect(state.params.get('project')).toBe('new'); expect(state.params.get('filter')).toBe('current'); expect(state.params.has('tab')).toBe(false);
  });

  it('does not offer a sender command pointing at a grant-only hosted gateway', () => {
    setTransport({ mode: 'HOSTED', base: 'https://gateway.example.invalid', grant: 'grant' });
    const tree = mount(h(TokenReveal, { token: `ai17z_dus_${'a'.repeat(32)}`, projectKey: 'demo', projectName: 'Demo', connection: { serverName: 'ai17z-dev-updates', mcpServerPath: '/opt/ai17z/tools/dev-updates-mcp.mjs', reason: null }, connectionError: null, onDone: vi.fn() }));
    expect(tree.root.findAllByType('pre')).toHaveLength(0);
    expect(content(tree)).toMatch(/hosted.*sender|sender.*hosted/i);
    expect(content(tree)).not.toContain('https://gateway.example.invalid');
  });
});
