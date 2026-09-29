/**
 * Synthetic personas for Foundry and persona-analysis tests.
 *
 * Every line here is invented. None is copied from a real account, because a
 * repository's test fixtures are public and a real person's writing is not the
 * repository's to publish. Each corpus has the shape of a real failure the
 * analysis has to get right, and the names are made up.
 */

export interface SyntheticItem {
  id: string;
  text: string;
  kind: 'post' | 'reply' | 'quote';
  lang?: string | null;
  createdAt?: string | null;
}

let counter = 0;
const day = (n: number) => new Date(Date.UTC(2026, 0, 1 + n)).toISOString();
const item = (text: string, kind: SyntheticItem['kind'] = 'reply', lang: string | null = 'en', at = counter): SyntheticItem => {
  counter += 1;
  return { id: `s${counter}`, text, kind, lang, createdAt: day(at % 200) };
};

/**
 * A builder who is short by default and long when technical, talks about one
 * project and one chain, and writes the everyday words every sentence has.
 * Under raw word counts its "topics" were will, have and just.
 */
export function builderPersona(): SyntheticItem[] {
  counter = 0;
  const casual = [
    'gm, will have more soon',
    'just shipped it lol',
    'you will have it tomorrow',
    'have you tried it yet',
    'just saw this, love it',
    'we will just keep building',
    'nah that is not how it works',
    'Pons is cooking',
    'Robinhood Chain gonna be huge',
    'ngl this one is good',
    'will check it out',
    'just keep going fam',
    'haha fair',
    'not really, but close',
    'gm builders',
    'Pons fam just keep going',
    'have a good one',
    'the Robinhood Chain crowd is early',
    'will do',
    'lol yeah',
  ];
  const technical = [
    'The Pons router takes a 0.3% fee on each swap and routes it to the pool, so liquidity providers earn it directly; the V2 contract adds a second hop for thin pairs.',
    'On Robinhood Chain the gas is low enough that the launchpad can mint and seed liquidity in one transaction, which is why the Pons deploy flow does it that way.',
    'Pons V1 and V2 differ in how the bonding curve graduates: V1 migrated at a fixed market cap, V2 migrates when the pool reaches a liquidity threshold, and the fee split changed with it.',
    'If the contract is verified you can read the fee on the explorer; the audit covered the router and the factory, not the frontend, so check the address before you swap.',
    'The API returns the pool state from the node, so latency depends on the RPC; we cache it for 30 ms which is why the chart can lag a block behind.',
    'Vesting on the team allocation is 12 months with a 3 month cliff, and the contract enforces it, so nobody can move those tokens early whatever a post says.',
  ];
  const out: SyntheticItem[] = [];
  for (let i = 0; i < 4; i += 1) for (const t of casual) out.push(item(`${t}${i > 1 ? ' ' + ['fr', 'rn', '', 'tbh'][i]! : ''}`.trim(), i % 3 === 0 ? 'post' : 'reply'));
  for (const t of technical) out.push(item(t, 'reply'));
  for (const t of technical.slice(0, 3)) out.push(item(t.replace('The', 'So the'), 'reply'));
  out.push(item('Faith keeps me steady on the hard weeks', 'post'));
  out.push(item('grateful for faith and family today', 'post'));
  return out;
}

/** Writes rarely and briefly: the low-data case, where the honest answer is "not enough". */
export function lowDataPersona(): SyntheticItem[] {
  counter = 0;
  return ['gm', 'nice', 'ok', 'lol', 'soon'].map((t) => item(t));
}

/** Writes in English and Chinese. */
export function bilingualPersona(): SyntheticItem[] {
  counter = 0;
  const en = ['building every day', 'the launch went well', 'thanks everyone for the support', 'more updates soon', 'we keep shipping'];
  const zh = ['今天继续建设', '感谢大家的支持', '很快会有更新', '我们一直在努力', '社区是最重要的'];
  const out: SyntheticItem[] = [];
  for (let i = 0; i < 4; i += 1) {
    for (const t of en) out.push(item(t, 'post', 'en'));
    for (const t of zh) out.push(item(t, 'reply', 'zh'));
  }
  return out;
}

/** Mostly reposted promotion and mass tags, with a little of their own writing. */
export function spammyPersona(): SyntheticItem[] {
  counter = 0;
  const out: SyntheticItem[] = [];
  for (let i = 0; i < 20; i += 1) out.push(item(`🚀🚀 $MOON airdrop live now claim here #airdrop #crypto @a @b @c @d @e ${i}`, 'post'));
  for (const t of ['thinking about the next build', 'the community call was good', 'shipping the fix tonight']) out.push(item(t, 'post'));
  return out;
}
