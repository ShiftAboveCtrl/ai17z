import React from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import { LinkSection } from './StudioPanel';

(globalThis as { React?: unknown }).React = React;

// There is no DOM in this suite, so hooks are a small slot array and the
// component function is called again after a click to read the new tree.
const hooks = vi.hoisted(() => ({ slots: [] as unknown[], index: 0 }));
vi.mock('react', async (original) => {
  const actual = await original<typeof import('react')>();
  const useState = (initial: unknown) => {
    const i = hooks.index++;
    if (!(i in hooks.slots)) hooks.slots[i] = initial;
    const set = (next: unknown) => { hooks.slots[i] = typeof next === 'function' ? (next as (v: unknown) => unknown)(hooks.slots[i]) : next; };
    return [hooks.slots[i], set];
  };
  return { ...actual, default: { ...actual, useState }, useState };
});

const calls = vi.hoisted(() => ({ log: [] as string[], put: vi.fn(), post: vi.fn() }));
vi.mock('@app/lib/api', () => ({
  put: (path: string, body: unknown) => { calls.log.push(`PUT ${path}`); return calls.put(path, body); },
  post: (path: string, body: unknown) => { calls.log.push(`POST ${path}`); return calls.post(path, body); },
}));
vi.mock('@app/lib/hooks', () => ({ useElapsed: () => 0, usePolling: vi.fn(), useResource: vi.fn() }));
vi.mock('@app/components/ui', () => ({ RetryablePanel: () => null, Working: () => null }));
vi.mock('@app/components/LiveTradesPanel', () => ({ LiveTradesSection: () => null }));

type Node = React.ReactElement<{ children?: unknown; onClick?: () => void; type?: string }>;
const walk = (node: unknown, visit: (n: Node) => void): void => {
  if (Array.isArray(node)) { node.forEach((child) => walk(child, visit)); return; }
  if (!React.isValidElement(node)) return;
  visit(node as Node);
  walk((node as Node).props.children, visit);
};
const texts = (node: unknown): string => {
  let out = '';
  const collect = (n: unknown): void => {
    if (typeof n === 'string' || typeof n === 'number') out += n;
    else if (Array.isArray(n)) n.forEach(collect);
    else if (React.isValidElement(n)) collect((n as Node).props.children);
  };
  collect(node);
  return out;
};
const render = (state: string) => {
  hooks.index = 0;
  return (LinkSection as (p: unknown) => unknown)({ status: { state, origin: null }, onChanged: vi.fn() });
};
const linkButton = (tree: unknown): Node => {
  let found: Node | null = null;
  walk(tree, (n) => { if (n.type === 'button' && texts(n).includes('Link to ai17z.io')) found = n; });
  if (!found) throw new Error('link button not rendered');
  return found;
};

beforeEach(() => {
  hooks.slots = [];
  hooks.index = 0;
  calls.log = [];
  calls.put.mockReset();
  calls.post.mockReset();
});

it('saves the Studio address before it asks to link when nothing is configured', async () => {
  calls.put.mockResolvedValue({ ok: true });
  calls.post.mockResolvedValue({ ok: true });
  await (linkButton(render('NOT_CONFIGURED')).props.onClick as () => Promise<void>)();
  expect(calls.log).toEqual(['PUT /api/plugins/registry', 'POST /api/studio/link']);
  expect(calls.put).toHaveBeenCalledWith('/api/plugins/registry', { url: 'https://ai17z.io' });
});

it('stops and shows why when the address cannot be saved', async () => {
  calls.put.mockResolvedValue({ ok: false, why: 'Registry addresses must use https.' });
  await (linkButton(render('NOT_CONFIGURED')).props.onClick as () => Promise<void>)();
  expect(calls.log).toEqual(['PUT /api/plugins/registry']);
  expect(calls.post).not.toHaveBeenCalled();
  expect(texts(render('NOT_CONFIGURED'))).toContain('Registry addresses must use https.');
});

it('does not touch the registry address when it is already configured', async () => {
  calls.post.mockResolvedValue({ ok: true });
  const button = (() => {
    let found: Node | null = null;
    walk(render('NOT_LINKED'), (n) => { if (n.type === 'button' && texts(n).includes('Link to Studio')) found = n; });
    return found as unknown as Node;
  })();
  await (button.props.onClick as () => Promise<void>)();
  expect(calls.log).toEqual(['POST /api/studio/link']);
});
