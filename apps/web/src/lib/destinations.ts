/**
 * Everywhere a setting lives, under the words somebody would look for it by.
 *
 * Setting up a real agent meant asking where Social Radar was, where the
 * policies were, and whether knowledge and instructions were the same thing.
 * Moving every screen to where somebody first looked would break it for the
 * people who already know where things are, so this answers the question
 * instead: type what you are looking for and go straight there.
 *
 * Pure, so the words that must find each place are pinned by a test.
 */

export interface Destination {
  id: string;
  title: string;
  /** Where it is, in a few words, so two results called "Knowledge" are told apart. */
  where: string;
  href: string;
  words: string[];
}

export interface DestinationAgent {
  id: string;
  name: string;
  accounts: { accountId: string; channel: string }[];
}

const GLOBAL: Destination[] = [
  { id: 'chat', title: 'Chat', where: 'Talk to your agents', href: '/chat', words: ['chat', 'talk', 'ask', 'conversation', 'room', 'message'] },
  { id: 'inbox', title: 'Inbox', where: 'Who wrote in', href: '/inbox', words: ['inbox', 'mentions', 'replies', 'unanswered'] },
  { id: 'activity', title: 'Activity', where: 'Every job and what came of it', href: '/activity', words: ['activity', 'jobs', 'failures', 'errors', 'history', 'queue'] },
  { id: 'plugins', title: 'Plugins', where: 'What agents may use', href: '/plugins', words: ['plugins', 'capabilities', 'tools', 'toolspace', 'permissions', 'integrations'] },
  { id: 'health', title: 'Health', where: 'Is everything working', href: '/health', words: ['health', 'status', 'broken', 'diagnostics', 'working'] },
  { id: 'providers', title: 'Model providers', where: 'Settings', href: '/settings#providers', words: ['providers', 'models', 'api key', 'openai', 'anthropic', 'openrouter', 'llm'] },
  { id: 'accounts', title: 'Accounts and sessions', where: 'Settings', href: '/settings#accounts', words: ['accounts', 'x account', 'sign in', 'login', 'session', 'connect'] },
  { id: 'browser', title: 'Browser', where: 'Settings', href: '/settings#browser', words: ['browser', 'chrome', 'edge', 'chromium', 'profile'] },
  { id: 'notifications', title: 'Notifications and Telegram', where: 'Settings', href: '/settings#notifications', words: ['notifications', 'telegram', 'alerts'] },
  { id: 'audit', title: 'Audit log', where: 'Settings', href: '/settings#audit', words: ['audit', 'log', 'who changed'] },
  { id: 'version', title: 'Version and updates', where: 'Settings', href: '/settings#version', words: ['version', 'update', 'upgrade', 'release'] },
  { id: 'create', title: 'Create an agent', where: 'Easy setup', href: '/agents/new', words: ['create', 'new agent', 'setup'] },
  { id: 'research', title: 'Create from research', where: 'Agent Foundry', href: '/agents/new/research', words: ['foundry', 'research', 'from an account', 'model after'] },
];

/** Places inside one agent. `#section` is a section of the agent's page. */
const PER_AGENT: (Omit<Destination, 'href' | 'where'> & { path: string })[] = [
  { id: 'identity', title: 'Identity and persona sources', path: '#identity', words: ['identity', 'persona', 'biography', 'persona source', 'who it is'] },
  { id: 'voice', title: 'Voice', path: '#voice', words: ['voice', 'style', 'tone', 'examples', 'how it sounds', 'repetition'] },
  { id: 'beliefs', title: 'Beliefs', path: '#beliefs', words: ['beliefs', 'stances', 'positions', 'opinions', 'what it thinks'] },
  { id: 'knowledge', title: 'Knowledge', path: '#knowledge', words: ['knowledge', 'docs', 'documentation', 'repository', 'github', 'sources', 'facts'] },
  { id: 'memory', title: 'Memory', path: '#memory', words: ['memory', 'memories', 'remember'] },
  { id: 'relationships', title: 'People', path: '#relationships', words: ['people', 'relationships', 'do not contact', 'block'] },
  { id: 'learned', title: 'Learning', path: '#learned', words: ['learning', 'learned', 'trials', 'experiments', 'outcomes'] },
  { id: 'autonomy', title: 'Autonomy and goals', path: '#autonomy', words: ['autonomy', 'goals', 'thinking', 'wake', 'deliberation'] },
  { id: 'policies', title: 'Policies', path: '#policies', words: ['policies', 'policy', 'rules', 'limits', 'safety', 'outreach', 'blocked topics', 'identity policy'] },
  { id: 'behaviour', title: 'Behaviour', path: '#behaviour', words: ['behaviour', 'behavior', 'engagement', 'replies', 'when it answers'] },
  { id: 'content', title: 'Posting', path: '#content', words: ['posting', 'posts', 'schedule', 'ideas', 'content'] },
  { id: 'capabilities', title: 'Capabilities', path: '#capabilities', words: ['capabilities', 'tools', 'permissions'] },
  { id: 'intelligence', title: 'Models', path: '#intelligence', words: ['models', 'model', 'vision', 'classifier', 'intelligence'] },
  { id: 'lab', title: 'Response Lab', path: '/studio?view=lab', words: ['responses', 'response lab', 'lab', 'rehearse', 'try a message'] },
  { id: 'tests', title: 'Test this agent', path: '/foundry', words: ['test', 'tests', 'behavioural tests', 'foundry', 'improve'] },
  { id: 'setup', title: 'Setup and health', path: '', words: ['setup', 'health', 'what is wrong', 'checks'] },
];

export function destinationsFor(agents: DestinationAgent[]): Destination[] {
  const all = [...GLOBAL];
  for (const agent of agents) {
    for (const place of PER_AGENT) {
      all.push({
        id: `${agent.id}:${place.id}`,
        title: place.title,
        where: agent.name,
        href: `/agents/${agent.id}${place.path}`,
        words: place.words,
      });
    }
    // Social Radar lives with the account it reads through.
    const account = agent.accounts.find((a) => a.channel !== 'mock') ?? agent.accounts[0];
    all.push({
      id: `${agent.id}:radar`,
      title: 'Social Radar',
      where: agent.name,
      href: account ? `/settings?account=${account.accountId}&focus=radar` : '/settings#accounts',
      words: ['social radar', 'radar', 'monitors', 'watch', 'keywords', 'searches', 'discovery', 'sources'],
    });
  }
  return all;
}

/**
 * The places matching what was typed, best first.
 *
 * A title match beats a word match, and a match at the start of a word beats
 * one in the middle, so "rad" finds Social Radar before anything that merely
 * contains the letters.
 */
export function searchDestinations(query: string, all: Destination[], limit = 12): Destination[] {
  const q = query.trim().toLowerCase();
  if (!q) return all.filter((d) => !d.id.includes(':')).slice(0, limit);
  const scored = all
    .map((d) => {
      const title = d.title.toLowerCase();
      let score = 0;
      if (title === q) score += 100;
      else if (title.startsWith(q)) score += 60;
      else if (title.split(/\s+/).some((w) => w.startsWith(q))) score += 45;
      else if (title.includes(q)) score += 30;
      for (const word of d.words) {
        if (word === q) score = Math.max(score, 80);
        else if (word.startsWith(q)) score = Math.max(score, 40);
        else if (q.length >= 4 && word.includes(q)) score = Math.max(score, 20);
      }
      if (score > 0 && d.where.toLowerCase().includes(q)) score += 5;
      // An agent's name narrows: "synth beliefs" finds that agent's beliefs.
      const parts = q.split(/\s+/);
      if (parts.length > 1) {
        const where = d.where.toLowerCase();
        const rest = parts.filter((p) => !where.includes(p)).join(' ');
        if (rest !== q && rest) {
          const inner = searchDestinations(rest, [d], 1).length > 0;
          if (inner) score = Math.max(score, 70);
        }
      }
      return { d, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.d.title.localeCompare(b.d.title));
  return scored.slice(0, limit).map((s) => s.d);
}
