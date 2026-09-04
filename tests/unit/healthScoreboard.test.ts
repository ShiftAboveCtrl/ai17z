import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '../..');
const page = readFileSync(resolve(root, 'apps/web/src/routes/HealthPage.tsx'), 'utf8');
const app = readFileSync(resolve(root, 'apps/web/src/App.tsx'), 'utf8');
const notify = readFileSync(resolve(root, 'packages/runtime/src/notify.ts'), 'utf8');

/**
 * There is one health system, and this is a test that there is not a second.
 *
 * The page, the word at the top of an agent's own screen, and the answer the
 * agent gives when somebody asks it why it is not replying all come from the
 * same collection. Two of them would disagree eventually, and the one on the
 * screen would be the one somebody believed.
 */
describe('the health page reuses what already exists', () => {
  it('reads the diagnostics endpoint rather than one of its own', () => {
    expect(page).toContain('/status');
    // No bespoke endpoint. If a future change needs data the diagnostics do not
    // carry, the right move is to add it there, where the agent can see it too.
    expect(page).not.toMatch(/\/api\/health\b/);
    expect(page).not.toMatch(/\/api\/agents\/\$\{[^}]+\}\/(scoreboard|healthcheck)/);
  });

  it('derives every state from the report rather than deciding for itself', () => {
    // The only judgement the page makes is "a group is as healthy as its worst
    // part", which is presentation. It never invents a state.
    expect(page).toContain('worstOf');
    expect(page).not.toMatch(/state\s*=\s*['"]HEALTHY['"]/);
  });

  it('shows when a part last succeeded, not when it last ran', () => {
    // A poller failing every thirty seconds for two hours ran a moment ago and
    // worked two hours ago. Only the second number answers the question.
    expect(page).toContain('lastSucceededAt');
    expect(page).toContain('Last worked');
  });

  it('never renders a raw error message from a provider', () => {
    // The classification and the count. A raw error can contain the request it
    // came from, and a request can carry a key.
    expect(page).toContain('failure.reason');
    expect(page).not.toContain('failure.message');
  });
});

/**
 * A button that goes to the wrong place is worse than no button: it teaches
 * somebody that the notification was not worth following.
 */
describe('every notification link goes somewhere that exists', () => {
  const routes = [...app.matchAll(/path="([^"]+)"/g)].map((match) => match[1]!);

  it('has a route for each fixed destination', () => {
    const hrefs = [...notify.matchAll(/actionHref: '([^']+)'/g)].map((match) => match[1]!);
    expect(hrefs.length).toBeGreaterThan(0);
    for (const href of hrefs) {
      const path = href.split('#')[0]!;
      expect(routes, `nothing is routed at ${path}, so "${href}" would silently redirect home`).toContain(path);
    }
  });

  it('has a route for each destination built from an agent id', () => {
    const templated = [...notify.matchAll(/actionHref: `([^`]+)`/g)].map((match) => match[1]!);
    for (const href of templated) {
      const path = href.split('#')[0]!.replace(/\$\{[^}]+\}/g, ':agentId');
      expect(routes.map((route) => route.replace(/:\w+/g, ':agentId'))).toContain(path);
    }
  });

  it('reaches the health page from the navigation, not only from a notification', () => {
    const bar = readFileSync(resolve(root, 'apps/web/src/components/TopBar.tsx'), 'utf8');
    expect(bar).toContain('to="/health"');
  });
});
