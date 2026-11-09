import { createElement as h, type ComponentProps, type ReactElement, type ReactNode } from 'react';
import type { SetURLSearchParams } from 'react-router-dom';
import type { AgentListItem } from '../../apps/web/src/lib/types';
import type { Resource } from '../../apps/web/src/lib/hooks';
import type { DevUpdate, DevUpdateProject } from '../../apps/web/src/lib/devUpdates';
import type { ChoiceGroup, ChoiceOption, EmptyState, Field, Modal, RetryablePanel } from '../../apps/web/src/components/ui';
import type { Log } from '../../apps/web/src/routes/devUpdates/Log';
import type { PostPreview } from '../../apps/web/src/routes/devUpdates/parts';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  post: vi.fn(), params: new URLSearchParams(), resources: new Map<string, Resource<unknown>>(),
}));
vi.mock('@app/lib/api', () => ({ post: state.post }));
vi.mock('@app/lib/hooks', () => ({
  useElapsed: () => 0, usePolling: () => {},
  useResource: (path: string) => state.resources.get(path) ?? resource(null),
}));
vi.mock('react-router-dom', async (importOriginal) => {
  const { createSearchParams } = await importOriginal<typeof import('react-router-dom')>();
  return {
    Link: ({ children }: { children: ReactNode }) => children,
    useNavigate: () => vi.fn(),
    useSearchParams: () => [state.params, (next: Parameters<SetURLSearchParams>[0]) => { state.params = createSearchParams(typeof next === 'function' ? next(state.params) : next); }],
  };
});
vi.mock('@app/components/ui', () => ({
  EmptyState: ({ title, detail }: ComponentProps<typeof EmptyState>) => h('p', null, title, detail),
  RetryablePanel: ({ detail }: ComponentProps<typeof RetryablePanel>) => h('aside', null, detail),
  Tabs: () => null, Working: () => null,
  Field: ({ children }: ComponentProps<typeof Field>) => children,
  ChoiceGroup: ({ children }: ComponentProps<typeof ChoiceGroup>) => children,
  ChoiceOption: ({ children }: ComponentProps<typeof ChoiceOption>) => children,
  Modal: ({ open, children, onClose }: ComponentProps<typeof Modal>) => open ? h('section', null, children, h('button', { onClick: onClose }, 'Close dialog')) : null,
}));
vi.mock('@app/components/Explain', () => ({ Explain: () => null }));
vi.mock('@app/components/motion', () => ({ AnimatedText: () => null }));
vi.mock('../../apps/web/src/routes/devUpdates/NewProject', () => ({ NewProject: () => null }));
vi.mock('../../apps/web/src/routes/devUpdates/Connect', () => ({ Connect: () => null }));
vi.mock('../../apps/web/src/routes/devUpdates/Rules', () => ({ Rules: () => null }));
vi.mock('../../apps/web/src/routes/devUpdates/Log', () => ({ Log: ({ updates }: ComponentProps<typeof Log>) => h('p', null, updates.map((u) => u.title).join(',')) }));
vi.mock('../../apps/web/src/routes/devUpdates/parts', () => ({
  PostPreview: ({ text, children }: ComponentProps<typeof PostPreview>) => h('div', null, text, children),
  ProblemList: () => null, CharMeter: () => null, CopyButton: () => null,
  problemOf: () => ['Request failed'],
}));

import { Review } from '../../apps/web/src/routes/devUpdates/Review';
import { DevUpdatesPage } from '../../apps/web/src/routes/DevUpdatesPage';
import { NewProject } from '../../apps/web/src/routes/devUpdates/NewProject';
import { TokenReveal } from '../../apps/web/src/routes/devUpdates/TokenReveal';
import { setTransport } from '../../apps/web/src/lib/transport';

function resource<T>(data: T, error: string | null = null): Resource<T> { return { data, error, loading: false, reload: vi.fn() }; }
const project: DevUpdateProject = { id: 'p', projectKey: 'demo', displayName: 'Demo', agentId: 'a', accountId: 'c', enabled: true, rehearse: false, mode: 'DRAFT', dailyCap: 2, minSpacingMinutes: 240, senderToken: { active: true, hint: 'abcd', issuedAt: null }, lastDispatchReason: null, createdAt: '', updatedAt: '' };
const draft: DevUpdate = { id: 'u', kind: 'FIX', title: 'A loaded draft', post: 'The reviewed post', summary: 'A change', why: 'It matters', evidence: [], proposedPost: 'The reviewed post', edited: false, status: 'PENDING_REVIEW', reason: null, url: null, jobId: null, history: [], decidedAt: null, dispatchedAt: null, finishedAt: null, updatedAt: '', createdAt: new Date().toISOString() };
let trees: ReactTestRenderer[] = [];
function mount(element: ReactElement) { let tree!: ReactTestRenderer; act(() => { tree = create(element); }); trees.push(tree); return tree; }
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
    const tree = mount(h(Review, { updates: [draft], agent: null, handle: null, rehearse: false, onDecided: vi.fn() }));
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
    const tree = mount(h(Review, { updates: [draft], agent: null, handle: null, rehearse: false, onDecided: vi.fn() }));
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

  it.each(['panel', 'path input'])('keeps the token on Escape from the %s and lets the parent receive it', (source) => {
    const done = vi.fn();
    const token = `ai17z_dus_${'a'.repeat(32)}`;
    const tree = mount(h(TokenReveal, { token, projectKey: 'demo', projectName: 'Demo', connection: { serverName: 'ai17z-dev-updates', mcpServerPath: null, reason: 'Container path' }, connectionError: null, onDone: done }));
    const parentEscape = vi.fn();
    document.addEventListener('keydown', parentEscape);
    const event = new Event('keydown', { bubbles: true });
    Object.defineProperty(event, 'key', { value: 'Escape' });
    if (source === 'path input') Object.defineProperty(event, 'target', { value: { id: tree.root.findByType('input').props.id } });
    act(() => { document.dispatchEvent(event); });
    expect(done).not.toHaveBeenCalled();
    expect(content(tree)).toContain(token);
    expect(parentEscape).toHaveBeenCalledTimes(1);
    act(() => button(tree, 'I have copied it, hide it').props.onClick());
    expect(done).toHaveBeenCalledTimes(1);
    act(() => tree.unmount());
    document.dispatchEvent(event);
    expect(done).toHaveBeenCalledTimes(1);
    document.removeEventListener('keydown', parentEscape);
  });

  it.each([false, true])('confirms before a parent modal discards the revealed token (confirmed: %s)', async (confirmed) => {
    const { NewProject: RealNewProject } = await vi.importActual<typeof import('../../apps/web/src/routes/devUpdates/NewProject')>('../../apps/web/src/routes/devUpdates/NewProject');
    const agent: AgentListItem = {
      id: 'a', ownerId: 'owner', slug: 'demo', name: 'Demo', description: '', avatarUrl: null, avatarMode: 'IMAGE', state: 'ACTIVE', lastError: null,
      personaVersionId: null, policyVersionId: null, pipelineVersionId: null, createdAt: '', updatedAt: '',
      stats: { memories: 0, accounts: 1, jobsTotal: 0, jobsNeedingReview: 0, jobsFailed: 0, lastActivityAt: null },
      accounts: [{ agentId: 'a', accountId: 'c', triggerEventTypes: [], actionType: 'POST', enabled: true, channel: 'mock', handle: 'demo', displayName: 'Demo', status: 'CONNECTED', accountEnabled: true }],
    };
    state.resources.set('/api/agents/a/capabilities', resource({ grants: { c: ['POST'] } }));
    const token = `ai17z_dus_${'b'.repeat(32)}`;
    state.post.mockResolvedValueOnce({ project, senderToken: token });
    const confirm = vi.fn(() => confirmed);
    Object.assign(window, { confirm });
    const closed = vi.fn();
    const tree = mount(h(RealNewProject, { open: true, agents: [agent], connection: null, connectionError: null, onClose: closed, onCreated: vi.fn(), onOpenConnect: vi.fn() }));
    act(() => tree.root.findAllByType('input')[0]!.props.onChange({ target: { value: 'Demo' } }));
    await act(async () => tree.root.findByType('form').props.onSubmit({ preventDefault: vi.fn() }));
    expect(content(tree)).toContain(token);
    act(() => button(tree, 'Close dialog').props.onClick());
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(closed).toHaveBeenCalledTimes(confirmed ? 1 : 0);
    expect(content(tree).includes(token)).toBe(!confirmed);
    if (!confirmed) {
      act(() => button(tree, 'I have copied it, close').props.onClick());
      expect(closed).toHaveBeenCalledTimes(1);
      expect(confirm).toHaveBeenCalledTimes(1);
      expect(content(tree)).not.toContain(token);
    }
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
    expect(content(tree)).toContain('x-ai17z-grant');
    expect(content(tree)).toContain('Studio');
    expect(content(tree)).toMatch(/directly reachable AI17Z API/);
    expect(content(tree)).not.toContain('https://gateway.example.invalid');
  });
});
