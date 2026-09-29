import { describe, expect, it } from 'vitest';
import { destinationsFor, searchDestinations } from '../../apps/web/src/lib/destinations';

const agents = [
  { id: 'a1', name: 'MEADGOD17z', accounts: [{ accountId: 'acc-1', channel: 'x' }] },
  { id: 'a2', name: 'ai17zos', accounts: [] },
];
const all = destinationsFor(agents);

/*
  Setting up a real agent, its owner could not find Social Radar, the
  policies, or tell knowledge from instructions and beliefs from policy about
  beliefs. Each word below is one they used, and each must land somewhere.
*/
describe('settings search finds where things live', () => {
  it.each([
    ['social radar', 'Social Radar', '/settings?account=acc-1&focus=radar'],
    ['radar', 'Social Radar', '/settings?account=acc-1&focus=radar'],
    ['beliefs', 'Beliefs', '/agents/a1#beliefs'],
    ['knowledge', 'Knowledge', '/agents/a1#knowledge'],
    ['responses', 'Response Lab', '/agents/a1/studio?view=lab'],
    ['plugins', 'Plugins', '/plugins'],
    ['learning', 'Learning', '/agents/a1#learning'],
    ['browser', 'Browser', '/settings#browser'],
    ['policies', 'Policies', '/agents/a1#policies'],
    ['persona source', 'Identity and persona sources', '/agents/a1#identity'],
  ])('"%s" finds %s', (query, title, href) => {
    const found = searchDestinations(query, all);
    const hit = found.find((d) => d.title === title);
    expect(hit, found.map((d) => `${d.title} ${d.href}`).join('\n')).toBeDefined();
    expect(found.slice(0, 3).map((d) => d.title)).toContain(title);
    expect(found.some((d) => d.href === href)).toBe(true);
  });

  it('narrows to one agent by name', () => {
    const [first] = searchDestinations('ai17zos beliefs', all);
    expect(first).toMatchObject({ title: 'Beliefs', where: 'ai17zos', href: '/agents/a2#beliefs' });
  });

  it('sends an agent with no account to connect one before it can have a Radar', () => {
    const radar = all.find((d) => d.id === 'a2:radar')!;
    expect(radar.href).toBe('/settings#accounts');
  });

  it('offers nothing for nonsense rather than everything', () => {
    expect(searchDestinations('qzxv', all)).toEqual([]);
  });
});
