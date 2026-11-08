import { describe, expect, it } from 'vitest';
import {
  DAILY_CAP_CHOICES,
  KEY_PATTERN,
  SPACING_CHOICES,
  STATUS_WORDS,
  accountChoices,
  apiUrlFrom,
  mcpAddCommand,
  refusalSentences,
  spacingWords,
  suggestKey,
} from '../../apps/web/src/lib/devUpdates';
import { DEV_UPDATE_STATUSES } from '../../packages/database/src/repositories/devUpdates';
import { DevUpdateProjectPatch } from '../../packages/runtime/src/devUpdates';

describe('the development updates screen', () => {
  it('has words for every status the server can report', () => {
    for (const status of DEV_UPDATE_STATUSES) expect(STATUS_WORDS[status], status).toBeTruthy();
  });

  it('offers only ceilings and spacings the server accepts', () => {
    for (const dailyCap of DAILY_CAP_CHOICES) expect(DevUpdateProjectPatch.safeParse({ dailyCap }).success, String(dailyCap)).toBe(true);
    for (const minSpacingMinutes of SPACING_CHOICES) {
      expect(DevUpdateProjectPatch.safeParse({ minSpacingMinutes }).success, String(minSpacingMinutes)).toBe(true);
    }
  });

  it('builds a one line command with the name before the variadic --env', () => {
    const command = mcpAddCommand({
      serverName: 'ai17z-dev-updates',
      apiUrl: 'http://localhost:5173',
      token: 'ai17z_dus_abc',
      projectKey: 'my-app',
      serverPath: 'C:\\Users\\Default User\\AI17Z\\tools\\dev-updates-mcp.mjs',
    });
    expect(command).toBe(
      'claude mcp add ai17z-dev-updates --scope local --env AI17Z_API_URL=http://localhost:5173 --env AI17Z_DEV_UPDATES_TOKEN=ai17z_dus_abc --env AI17Z_DEV_UPDATES_PROJECT=my-app -- node "C:\\Users\\Default User\\AI17Z\\tools\\dev-updates-mcp.mjs"',
    );
    expect(command).not.toContain('\n');
  });

  it('uses the API base when there is one and this page otherwise', () => {
    expect(apiUrlFrom('', 'http://localhost:5173')).toBe('http://localhost:5173');
    expect(apiUrlFrom('http://box:8787/', 'http://localhost:5173')).toBe('http://box:8787');
  });

  it('withholds accounts the agent may not post through, and says why', () => {
    const choices = accountChoices(
      [
        { accountId: 'a', handle: 'can_post', channel: 'x', enabled: true, accountEnabled: true },
        { accountId: 'b', handle: 'replies_only', channel: 'x', enabled: true, accountEnabled: true },
        { accountId: 'c', handle: 'off', channel: 'x', enabled: true, accountEnabled: false },
        { accountId: 'd', handle: 'unlinked', channel: 'x', enabled: false, accountEnabled: true },
      ],
      { a: ['POST', 'REPLY'], b: ['REPLY'], c: ['POST'], d: ['POST'] },
    );
    expect(choices.map((c) => [c.handle, c.unavailable])).toEqual([
      ['can_post', null],
      ['replies_only', 'The agent may not post through @replies_only.'],
      ['off', '@off is switched off.'],
      ['unlinked', "The agent's connection to @unlinked is switched off."],
    ]);
  });

  it('turns a refusal record into reasons and where, without any of the words', () => {
    const said = refusalSentences({ id: '1', entityId: 'p', at: '', data: { codes: ['SECRET', 'PRIVATE_LOCATION'], fields: ['summary', 'evidence.0.detail'] } });
    expect(said.reasons).toEqual([
      'It contained something shaped like a password or key.',
      'It contained a private address, a local path or an email address.',
    ]);
    expect(said.where).toBe('Found in what changed and the evidence.');
    // A record from a newer server still reads as something.
    expect(refusalSentences({ id: '2', entityId: 'p', at: '', data: { codes: ['NEW_RULE'] } }).reasons).toEqual(['It broke a sharing rule.']);
    expect(refusalSentences({ id: '3', entityId: 'p', at: '', data: {} }).reasons).toEqual(['It broke a sharing rule.']);
  });

  it('suggests a key the server accepts', () => {
    for (const name of ['My App', 'AI17Z Core', 'café.io', '  Spaces  around ']) {
      expect(suggestKey(name), name).toMatch(KEY_PATTERN);
    }
    expect(suggestKey('My App')).toBe('my-app');
  });

  it('says spacing in hours and days', () => {
    expect(SPACING_CHOICES.map(spacingWords)).toEqual(['30 minutes', '1 hour', '2 hours', '4 hours', '8 hours', '12 hours', '1 day']);
    expect(spacingWords(90)).toBe('1 h 30 min');
  });
});
