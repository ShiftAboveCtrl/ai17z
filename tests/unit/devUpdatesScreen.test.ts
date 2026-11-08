import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DAILY_CAP_CHOICES,
  KEY_PATTERN,
  SPACING_CHOICES,
  STATUS_WORDS,
  LOG_LIMIT,
  REFUSAL_LIMIT,
  INITIAL_CREATION,
  accountChoices,
  agentPublishingFor,
  apiUrlFrom,
  checkServerPath,
  commandState,
  creationReducer,
  logTruncation,
  publishingState,
  type CreationState,
  type DevUpdateProject,
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

describe('which switch holds publishing', () => {
  const live = { dryRunDefault: false, automationMode: 'AUTONOMOUS' };

  it('never says posting for real while the agent dry runs everything', () => {
    // The review found the header saying "Posting for real" over a new agent,
    // whose policy rehearses by default.
    const state = publishingState({ enabled: true, rehearse: false }, { dryRunDefault: true, automationMode: 'AUTONOMOUS' });
    expect(state.words).not.toBe('Posting for real');
    expect(state.heldBy).toBe('AGENT_DRY_RUN');
    expect(state.sentence).toMatch(/Dry run by default/);
  });

  it('names the project first, then the agent, and claims nothing until the agent is read', () => {
    expect(publishingState({ enabled: false, rehearse: true }, live).heldBy).toBe('PROJECT_PAUSED');
    expect(publishingState({ enabled: true, rehearse: true }, { ...live, dryRunDefault: true }).heldBy).toBe('PROJECT_REHEARSES');
    expect(publishingState({ enabled: true, rehearse: false }, { dryRunDefault: false, automationMode: 'OFF' }).heldBy).toBe('AGENT_AUTOMATION');
    expect(publishingState({ enabled: true, rehearse: false }, { dryRunDefault: false, automationMode: 'MONITOR_ONLY' }).heldBy).toBe('AGENT_AUTOMATION');
    const unknown = publishingState({ enabled: true, rehearse: false }, null);
    expect(unknown.heldBy).toBeNull();
    expect(unknown.words).not.toBe('Posting for real');
    const real = publishingState({ enabled: true, rehearse: false }, live);
    expect([real.heldBy, real.words]).toEqual([null, 'Posting for real']);
  });
});

describe('a command is offered only when it can work', () => {
  const base = { apiUrl: 'http://localhost:5173', token: `ai17z_dus_${'c'.repeat(32)}`, projectKey: 'my-app' };
  const container = { serverName: 'ai17z-dev-updates', mcpServerPath: null, reason: 'This AI17Z runs in a container.' };

  it('offers no command with a placeholder path from a container install', () => {
    const state = commandState({ ...base, connection: container, localPath: '' });
    expect(state.command).toBeNull();
    expect(state.needsLocalPath).toBe(true);
  });

  it('builds it from the path the owner gives, once that path is whole and absolute', () => {
    expect(commandState({ ...base, connection: container, localPath: 'dev-updates-mcp.mjs' }).command).toBeNull();
    expect(commandState({ ...base, connection: container, localPath: 'tools/dev-updates-mcp.mjs' }).pathProblem).toMatch(/full path/);
    expect(commandState({ ...base, connection: container, localPath: 'C:\\AI17Z\\tools' }).command).toBeNull();
    const windows = commandState({ ...base, connection: container, localPath: '"C:\\AI17Z\\tools\\dev-updates-mcp.mjs"' });
    expect(windows.command).toContain('-- node "C:\\AI17Z\\tools\\dev-updates-mcp.mjs"');
    const unix = commandState({ ...base, connection: container, localPath: '/opt/ai17z/tools/dev-updates-mcp.mjs' });
    expect(unix.command).toContain('-- node "/opt/ai17z/tools/dev-updates-mcp.mjs"');
    for (const s of [windows, unix]) expect(s.command).not.toMatch(/<|>/);
  });

  it('uses the installation path when there is one and never asks', () => {
    const state = commandState({
      ...base,
      connection: { serverName: 'ai17z-dev-updates', mcpServerPath: '/srv/ai17z/tools/dev-updates-mcp.mjs', reason: null },
      localPath: '',
    });
    expect(state.needsLocalPath).toBe(false);
    expect(state.command).toContain('"/srv/ai17z/tools/dev-updates-mcp.mjs"');
  });

  it('offers nothing before the installation has answered', () => {
    expect(commandState({ ...base, connection: null, localPath: '/x/dev-updates-mcp.mjs' }).command).toBeNull();
  });
});

describe('the log says when it is not everything', () => {
  it('is silent under the limits and explicit at them', () => {
    expect(logTruncation(12, 3)).toBeNull();
    expect(logTruncation(LOG_LIMIT, 0)).toMatch(/newest 200 updates/);
    expect(logTruncation(0, REFUSAL_LIMIT)).toMatch(/refusal records/);
  });
});

/*
  Structure, pinned the way hookOrder.test.ts pins focus: the web app has no
  DOM test environment, and these are the properties the review found broken.
*/
describe('nothing from one project survives switching to another', () => {
  const root = resolve(__dirname, '../..');
  const read = (p: string) => readFileSync(resolve(root, p), 'utf8');
  const page = read('apps/web/src/routes/DevUpdatesPage.tsx');

  it('mounts each project afresh, so its drafts and their buttons go with it', () => {
    expect(page).toMatch(/<ProjectWorkspace\s+key=\{project\.id\}/);
    // Every per-project request lives inside the workspace, not on the page.
    const shell = page.slice(0, page.indexOf('function ProjectWorkspace'));
    expect(shell).not.toMatch(/dev-updates\/updates/);
    expect(shell).not.toMatch(/api\/audit/);
  });

  it('asks for waiting drafts with the status filter, not out of the newest log page', () => {
    expect(page).toMatch(/status=PENDING_REVIEW/);
  });

  it('never holds a sender token above the component that reveals it', () => {
    expect(page).not.toMatch(/senderToken\b(?!\.)/);
    expect(page).not.toMatch(/freshToken|setFresh/);
    const connect = read('apps/web/src/routes/devUpdates/Connect.tsx');
    expect(connect).toMatch(/useState<string \| null>\(null\)/);
    expect(connect).not.toMatch(/freshToken|onIssued/);
    const create = read('apps/web/src/routes/devUpdates/NewProject.tsx');
    // However the dialog closes, the token goes.
    // Every close starts a new generation, which is what drops the token
    // (see creationReducer), and every way of closing goes through it.
    expect(create).toMatch(/const close = \(\) => \{\s*generation\.current \+= 1;\s*dispatch\(\{ type: 'close' \}\);/);
    expect(create).toMatch(/onClose=\{close\}/);
    expect(create).not.toMatch(/useState<\{ project: DevUpdateProject; senderToken/);
  });

  it('counts real seconds while it waits, and offers a way out', () => {
    expect(page).not.toMatch(/seconds=\{0\}/);
    expect(page.match(/useElapsed\(/g)?.length).toBeGreaterThanOrEqual(2);
    expect(page.match(/onCancel=/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it('keeps the new project dialog in one place, so the first project does not remount it', () => {
    // Review round 2: creating the first project moved the page from the empty
    // state to the project view, the dialog sat in a different place in each,
    // and React mounted a new one, dropping the token it had just received.
    const shell = page.slice(page.indexOf('export function DevUpdatesPage'), page.indexOf('function ProjectWorkspace'));
    expect(shell.match(/<NewProject\b/g)).toHaveLength(1);
    expect(shell.match(/\{newProject\}/g)).toHaveLength(1);
    expect(shell.match(/\breturn \(/g)).toHaveLength(1);
    expect(shell).toMatch(/<div className=\{PAGE\}>\s*\{header\}\s*\{body\}\s*<\/div>\s*\{newProject\}/);
  });
});

const project = (id: string): DevUpdateProject => ({
  id,
  projectKey: `key-${id}`,
  displayName: `Project ${id}`,
  agentId: 'agent',
  accountId: 'account',
  mode: 'DRAFT',
  enabled: true,
  dailyCap: 2,
  minSpacingMinutes: 240,
  rehearse: true,
  senderToken: { active: true, hint: 'abcd', issuedAt: null },
  lastDispatchReason: null,
  createdAt: '',
  updatedAt: '',
});

describe('the token from creating a project is shown once, to the dialog that asked', () => {
  const TOKEN = `ai17z_dus_${'b'.repeat(24)}`;
  const run = (events: Parameters<typeof creationReducer>[1][]): CreationState => events.reduce(creationReducer, INITIAL_CREATION);

  it('reveals the token when the answer comes back to the same dialog', () => {
    const state = run([{ type: 'submit' }, { type: 'succeeded', generation: 0, project: project('a'), token: TOKEN }]);
    expect(state.revealed?.token).toBe(TOKEN);
    expect(state.pending).toBeNull();
    expect(state.orphan).toBeNull();
  });

  it('never keeps or reveals a token whose answer arrives after the dialog closed', () => {
    // Review round 2: closing while creation was pending let the late answer
    // store the token, and opening the dialog again showed it.
    const late = run([{ type: 'submit' }, { type: 'close' }, { type: 'succeeded', generation: 0, project: project('a'), token: TOKEN }]);
    expect(late.revealed).toBeNull();
    expect(JSON.stringify(late)).not.toContain(TOKEN);
    // The project exists on the server, so the owner is told about it.
    expect(late.orphan?.id).toBe('a');
    expect(run([{ type: 'submit' }, { type: 'close' }, { type: 'succeeded', generation: 0, project: project('a'), token: TOKEN }, { type: 'dismissOrphan' }]).orphan).toBeNull();
  });

  it('does not let a late answer or failure disturb the next attempt', () => {
    const second = run([
      { type: 'submit' },
      { type: 'close' },
      { type: 'submit' },
      { type: 'failed', generation: 0 },
      { type: 'succeeded', generation: 0, project: project('old'), token: TOKEN },
    ]);
    expect(second.pending).toBe(1);
    expect(second.revealed).toBeNull();
    const shown = creationReducer(second, { type: 'succeeded', generation: 1, project: project('new'), token: `${TOKEN}b` });
    expect(shown.revealed?.project.id).toBe('new');
    expect(shown.orphan?.id).toBe('old');
  });

  it('forgets a revealed token as soon as the dialog closes', () => {
    const closed = run([{ type: 'submit' }, { type: 'succeeded', generation: 0, project: project('a'), token: TOKEN }, { type: 'close' }]);
    expect(closed.revealed).toBeNull();
    expect(JSON.stringify(closed)).not.toContain(TOKEN);
  });
});

describe('nothing pasted into a terminal can be expanded by it', () => {
  // Built here so no token-shaped literal sits in a tracked file.
  const ok = { apiUrl: 'http://127.0.0.1:8787', token: `ai17z_dus_${'a1_-'.repeat(11)}`, projectKey: 'my-app' };
  const asking = { serverName: 'ai17z-dev-updates', mcpServerPath: null, reason: 'Inside a container.' };
  const known = (mcpServerPath: string) => ({ serverName: 'ai17z-dev-updates', mcpServerPath, reason: null });

  // Review round 2: these all expand inside double quotes in at least one of
  // bash, zsh, PowerShell or cmd.
  const hostile = [
    'C:\\AI17Z\\$(Remove-Item x)\\dev-updates-mcp.mjs',
    '/opt/$(touch pwned)/dev-updates-mcp.mjs',
    '/opt/`id`/dev-updates-mcp.mjs',
    'C:\\%USERPROFILE%\\tools\\dev-updates-mcp.mjs',
    'C:\\!PATH!\\tools\\dev-updates-mcp.mjs',
    '/opt/a;rm -rf b/dev-updates-mcp.mjs',
    'C:\\a & calc\\dev-updates-mcp.mjs',
    '/opt/a|nc host 1/dev-updates-mcp.mjs',
    '/opt/a\nrm b/dev-updates-mcp.mjs',
    '/opt/$HOME/dev-updates-mcp.mjs',
    '/opt/a"b/dev-updates-mcp.mjs',
    "/opt/a'b/dev-updates-mcp.mjs",
    '/opt/a>b/dev-updates-mcp.mjs',
    'C:\\a^b\\dev-updates-mcp.mjs',
    '~/ai17z/tools/dev-updates-mcp.mjs',
  ];

  it.each(hostile)('refuses the path %j with a sentence and offers no command', (path) => {
    expect(checkServerPath(path)).not.toBe('ok');
    const state = commandState({ ...ok, connection: asking, localPath: path });
    expect(state.command).toBeNull();
    expect(state.pathProblem).toMatch(/\.$/);
  });

  it.each(hostile)('does not paste an installation path %j either, and asks instead', (path) => {
    const state = commandState({ ...ok, connection: known(path), localPath: '' });
    expect(state.command).toBeNull();
    expect(state.installPathUnsafe).toBe(true);
    expect(state.needsLocalPath).toBe(true);
  });

  it('accepts ordinary paths, including spaces, round brackets and letters in any script', () => {
    for (const path of [
      'C:\\Program Files (x86)\\AI17Z\\tools\\dev-updates-mcp.mjs',
      'C:/Users/someone/AI17Z/tools/dev-updates-mcp.mjs',
      'D:\\Développement\\ai17z\\tools\\dev-updates-mcp.mjs',
      '/home/someone/ai17z/tools/dev-updates-mcp.mjs',
    ]) {
      expect(checkServerPath(path), path).toBe('ok');
      expect(commandState({ ...ok, connection: known(path), localPath: '' }).command, path).toContain(`-- node "${path}"`);
    }
  });

  it.each([
    ['an API address with a command in it', { apiUrl: 'http://localhost:8787/$(id)' }],
    ['an API address with an ampersand', { apiUrl: 'http://localhost:8787/a&calc' }],
    ['an API address with a query', { apiUrl: 'http://localhost:8787/?a=1' }],
    ['an API address with backticks', { apiUrl: 'http://`id`.example.invalid' }],
    ['an IPv6 address, whose brackets are a glob', { apiUrl: 'http://[::1]:8787' }],
    ['an API address with a tilde', { apiUrl: 'http://localhost:8787/~x' }],
    ['an API address that is not http', { apiUrl: 'file:///etc/passwd' }],
    ['a project key with a semicolon', { projectKey: 'a;id' }],
    ['a project key with a command', { projectKey: '$(id)' }],
    ['a token with a command', { token: 'ai17z_dus_$(id)aaaaaaaaaaaaaaaa' }],
    ['a token with a newline', { token: 'ai17z_dus_aaaaaaaaaaaaaaaa\nid' }],
    ['a token with a percent sign', { token: 'ai17z_dus_%PATH%aaaaaaaaaaaaaaaa' }],
  ])('refuses %s', (_label, change) => {
    const state = commandState({ ...ok, ...change, connection: known('/opt/ai17z/tools/dev-updates-mcp.mjs'), localPath: '' });
    expect(state.command).toBeNull();
    expect(state.problem).toMatch(/\.$/);
  });

  it('refuses a server name a shell would read', () => {
    const state = commandState({ ...ok, connection: { serverName: 'x;id', mcpServerPath: '/opt/ai17z/tools/dev-updates-mcp.mjs', reason: null }, localPath: '' });
    expect(state.command).toBeNull();
    expect(state.problem).toBeTruthy();
  });
});

describe("the agent's switches are this agent's", () => {
  const detail = (id: string, config: unknown) => ({ agent: { id }, policy: config === null ? null : { config } });

  it('ignores a detail that belongs to the agent the project used to map to', () => {
    // Review round 2: after remapping, the previous agent's policy stayed on
    // screen while the new one loaded, or for ever if that request failed.
    expect(agentPublishingFor(detail('old-agent', { automation: { dryRunDefault: false, mode: 'AUTONOMOUS' } }), 'new-agent')).toBeNull();
    expect(agentPublishingFor(null, 'new-agent')).toBeNull();
  });

  it("reads a matching agent's switches, and the schema defaults when it has no policy", () => {
    expect(agentPublishingFor(detail('a', { automation: { dryRunDefault: false, mode: 'AUTONOMOUS' } }), 'a')).toEqual({
      dryRunDefault: false,
      automationMode: 'AUTONOMOUS',
    });
    // The dispatcher parses a missing policy with the same defaults: dry run on.
    expect(agentPublishingFor(detail('a', null), 'a')?.dryRunDefault).toBe(true);
  });

  it('says the state is unknown, not checking, when the read failed', () => {
    const failed = publishingState({ enabled: true, rehearse: false }, null, 'The API is not reachable.');
    expect(failed.words).toBe('Unknown');
    expect(failed.sentence).toContain('The API is not reachable.');
    expect(publishingState({ enabled: true, rehearse: false }, null).words).toBe('Checking');
  });
});
