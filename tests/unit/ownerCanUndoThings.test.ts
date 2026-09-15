import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Two things the owner could do once and never again.
 *
 * Both had the same shape, and it is a shape worth naming: the API route
 * existed, the component existed, the tests passed, and **nothing on any screen
 * reached them**. A capability with no control is a capability the product does
 * not have, and no amount of route-level testing notices, because the route
 * works perfectly when something calls it.
 *
 *   Removing an X account   `DELETE /api/accounts/:id` was written and called
 *                           by nothing. An account somebody had finished with
 *                           stayed registered for ever, raising "@handle is
 *                           signed out" on every health sweep.
 *
 *   Changing an avatar      `AvatarEditor` was mounted in exactly one place --
 *                           Advanced, under Character, inside Identity. An
 *                           agent set up in Easy Mode had a face chosen once,
 *                           as a URL, with nowhere to change it.
 *
 * These assertions are deliberately about *reachability*: which screen calls
 * which route. The behaviour underneath has its own tests
 * (`tests/integration/accountRemoval.test.ts`, `agentAvatar.test.ts`), and
 * those went on passing throughout.
 */

const root = resolve(__dirname, '../..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

describe('an account the owner has finished with can be got rid of', () => {
  const settings = read('apps/web/src/routes/SettingsPage.tsx');

  it('has a control that reaches the route, which is the part that was missing', () => {
    expect(settings, 'nothing removes an account').toContain('del(`/api/accounts/${account.id}`)');
    expect(settings, 'nothing disconnects an account').toContain('/disconnect`');
    expect(settings, 'a disconnected account cannot be switched back on').toContain('/reconnect`');
  });

  it('asks before removing, and says what it will not take', () => {
    // "Will this delete my agent" is the first thing anybody thinks, and an
    // answer that only exists in the code is not an answer.
    expect(settings).toContain('Remove this account?');
    expect(settings).toMatch(/agents are not deleted/i);
    // And the reversible option is named where somebody is deciding.
    expect(settings).toMatch(/use <strong[^>]*>Disconnect<\/strong> instead/);
  });

  it('never offers to delete a browser profile as part of it', () => {
    // The signed-in Chrome profile is the expensive thing on the machine and
    // is nobody's to remove as a side effect.
    expect(settings).toMatch(/browser profile on this machine is left alone/i);
  });

  it('has the API routes those controls call', () => {
    const routes = read('apps/api/src/routes/accounts.ts');
    expect(routes).toContain("'/api/accounts/:id/disconnect'");
    expect(routes).toContain("'/api/accounts/:id/reconnect'");
    expect(routes).toMatch(/app\.delete\(\s*'\/api\/accounts\/:id'/);
    // Removal stops the work already queued, which a cascade cannot reach:
    // the worker holds a browser open in memory.
    expect(routes).toContain('cancelAccountTasks');
    expect(routes).toContain('closeSession');
  });
});

describe('the agent face can be changed after the agent exists', () => {
  const easy = read('apps/web/src/routes/EasyAgentView.tsx');
  const identity = read('apps/web/src/routes/sections/IdentitySection.tsx');
  const editor = read('apps/web/src/components/AvatarEditor.tsx');

  it('is reachable from both views, not only from Advanced', () => {
    expect(easy, 'Easy Mode has no way to change the face').toContain('<AvatarEditor');
    expect(identity, 'Advanced lost the editor').toContain('<AvatarEditor');
  });

  it('is the one editor in both, rather than a simplified copy in Easy', () => {
    // The rule the same file already states for Accounts, Intelligence and
    // Voice: one component, so a change cannot apply in one view and not the
    // other. A second avatar control is how the two drift.
    for (const source of [easy, identity]) {
      expect(source).toContain("from '@app/components/AvatarEditor'");
    }
    expect(easy, 'Easy Mode grew its own upload').not.toMatch(/postFile\(/);
  });

  it('uploads through the one route, and can take a picture away again', () => {
    expect(editor).toContain('`/api/agents/${agentId}/avatar`');
    expect(editor).toContain('del(');
    // The bytes decide what it is, never the filename or the header -- the
    // artifact route serves these back.
    const routes = read('apps/api/src/routes/agents.ts');
    expect(routes).toMatch(/\/api\/agents\/:id\/avatar/);
  });
});
