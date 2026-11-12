import { createElement } from 'react';
import { act, create } from 'react-test-renderer';
import { expect, it, vi } from 'vitest';
import { LeagueEntryPanel } from '../../apps/web/src/components/LeagueEntryPanel';
import { ApiError } from '../../apps/web/src/lib/api';

const { post } = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock('@app/lib/api', async (original) => ({ ...await original<typeof import('../../apps/web/src/lib/api')>(), post }));
vi.mock('@app/lib/hooks', () => ({ useElapsed: () => 0, useResource: () => ({ data: { items: [{ id: 'agent', name: 'Scout' }] }, loading: false }) }));

it.each([
  ['NOT_FOUND', 'Agent not found', 'That agent is no longer available. Choose another agent.'],
  ['NETWORK', 'raw transport failure', 'Could not reach AI17Z. Check the connection and try again.'],
  ['UNAUTHORIZED', 'raw auth failure', 'Your session expired. Sign in again.'],
  ['FORBIDDEN', 'raw access failure', 'You do not have permission to enter this agent.'],
  ['VALIDATION_FAILED', 'raw validation failure', 'Check the agent, season slug and public alias, then try again.'],
  ['CONFLICT', 'raw conflict failure', 'The entry changed while you were submitting it. Refresh and try again.'],
  ['INTERNAL', 'raw internal failure', 'The league entry could not be saved. Try again.'],
])('explains the API error class %s', async (code, message, sentence) => {
  post.mockRejectedValueOnce(new ApiError(code, message, 400));
  let tree!: ReturnType<typeof create>;
  act(() => { tree = create(createElement(LeagueEntryPanel, { initialSeason: 'week-45' })); });
  try {
    act(() => tree.root.findByProps({ name: 'leagueAgent' }).props.onChange({ target: { value: 'agent' } }));
    act(() => tree.root.findByProps({ name: 'leagueAlias' }).props.onChange({ target: { value: 'Paper Scout' } }));
    await act(async () => { await tree.root.findByType('form').props.onSubmit({ preventDefault: () => undefined }); });
    expect(tree.root.findByProps({ role: 'status' }).children.join('')).toBe(sentence);
  } finally { act(() => tree.unmount()); }
});

it.each([
  [{ ok: true, state: 'ACTIVE' }, 'Scout is entered in week-45.'],
  [{ ok: true, state: 'ACTIVE', alreadyEntered: true }, 'Scout is already entered in week-45.'],
  [{ ok: true, state: 'PENDING' }, 'The entry is saved and waiting for Studio.'],
  [{ ok: false, why: 'This agent is already entered.' }, 'This agent is already entered.'],
  [{ ok: false, why: 'The season is closed.' }, 'The season is closed.'],
  [{ ok: false, why: 'This installation is not linked.' }, 'This installation is not linked.'],
])('shows Working and the entry outcome %j', async (answer, sentence) => {
  let resolve!: (value: unknown) => void;
  post.mockReturnValue(new Promise((done) => { resolve = done; }));
  let tree!: ReturnType<typeof create>;
  act(() => { tree = create(createElement(LeagueEntryPanel, { initialSeason: 'week-45' })); });
  try {
    expect(tree.root.findByProps({ id: 'league-entry' })).toBeDefined();
    act(() => tree.root.findByProps({ name: 'leagueAgent' }).props.onChange({ target: { value: 'agent' } }));
    act(() => tree.root.findByProps({ name: 'leagueAlias' }).props.onChange({ target: { value: 'Paper Scout' } }));
    let submitted!: Promise<void>;
    act(() => { submitted = tree.root.findByType('form').props.onSubmit({ preventDefault: () => undefined }); });
    expect(JSON.stringify(tree.toJSON())).toContain('Entering the paper league');
    expect(tree.root.findByProps({ type: 'submit' }).props.disabled).toBe(true);
    await act(async () => { resolve(answer); await submitted; });
    expect(post).toHaveBeenLastCalledWith('/api/studio/league/entry', { agentId: 'agent', slug: 'week-45', alias: 'Paper Scout', replacePaperMandate: false });
    expect(JSON.stringify(tree.toJSON())).toContain(sentence);
  } finally { act(() => tree.unmount()); }
});
