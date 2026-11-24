import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { afterEach, expect, it } from 'vitest';
import { capabilityPermissions, chat, ops, providers, query, users } from '@xbam/database';
import { hashToken, openSecret } from '@xbam/shared';
import { installHarness } from '../support/harness';
import { createFixture } from '../support/fixtures';

installHarness();
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function client(file: string) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'tools/agent-mcp.mts'], {
    cwd: process.cwd(), env: { ...process.env, AI17Z_AGENT_MCP_TOKEN_FILE: file }, stdio: 'pipe',
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += String(chunk); });
  const pending = new Map<number | null, (value: Record<string, unknown>) => void>();
  createInterface({ input: child.stdout }).on('line', line => {
    const value = JSON.parse(line) as Record<string, unknown>;
    pending.get(value.id as number)?.(value);
  });
  cleanup.push(async () => { child.stdin.end(); await new Promise<void>(done => child.exitCode !== null ? done() : child.once('exit', () => done())); });
  let id = 0;
  async function send(line: string, current: number | null) {
    const response = new Promise<Record<string, unknown>>((done, reject) => {
      const timeout = setTimeout(() => reject(new Error('MCP response timed out')), 20_000);
      pending.set(current, value => { clearTimeout(timeout); pending.delete(current); done(value); });
    });
    child.stdin.write(line + '\n');
    return response;
  }
  async function rpc(method: string, params: unknown = {}) {
    const current = ++id;
    return send(JSON.stringify({ jsonrpc: '2.0', id: current, method, params }), current);
  }
  return { rpc, send, stderr: () => stderr };
}

async function setup(quota = 60, model = 'mock-uses:agent.self_state') {
  expect(existsSync(resolve('tools/agent-mcp.mts')), 'outbound MCP stdio entry exists').toBe(true);
  const { issueAgentMcpToken } = await import('../../packages/runtime/src/agentMcp');
  const f = await createFixture({ model });
  const session = await users.createSession(f.ownerId);
  const issued = await issueAgentMcpToken(session.token, [f.agentId], quota);
  const dir = await mkdtemp(join(tmpdir(), 'agent-mcp-'));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'credential');
  await writeFile(file, issued.sealed, { mode: 0o600 });
  return { ...f, issued, file, c: await client(file), token: openSecret(issued.sealed) };
}

it('exports exactly the read and ask tools and authenticates scoped owner chat over stdio', async () => {
  const f = await setup();
  const other = await createFixture();
  const hidden = await createFixture();
  await query('UPDATE agents SET owner_id = $1 WHERE id = $2', [f.ownerId, hidden.agentId]);
  expect(await f.c.rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'contract', version: '1' } })).toMatchObject({ result: { capabilities: { tools: {} } } });
  const menu = await f.c.rpc('tools/list');
  expect(((menu.result as { tools: { name: string }[] }).tools).map(t => t.name)).toEqual(['list_agents', 'ask_agent', 'agent_recent_trace']);
  expect(await f.c.rpc('tools/call', { name: 'list_agents' })).toMatchObject({ result: { isError: false } });
  const agents = JSON.stringify(await f.c.rpc('tools/call', { name: 'list_agents' }));
  expect(agents).toContain(f.agentId);
  expect(agents).not.toContain(other.agentId);
  expect(agents).not.toContain(hidden.agentId);
  expect(await f.c.rpc('tools/call', { name: 'ask_agent', arguments: { agentId: other.agentId, question: 'hello' } })).toMatchObject({ result: { isError: true } });
  expect(await f.c.rpc('tools/call', { name: 'ask_agent', arguments: { agentId: hidden.agentId, question: 'hello' } })).toMatchObject({ result: { isError: true } });
  const answer = await f.c.rpc('tools/call', { name: 'ask_agent', arguments: { agentId: f.agentId, question: 'What is your setup and state?' } });
  expect(JSON.stringify(answer)).toContain('Checked agent.self_state');
  expect(await query('SELECT * FROM capability_invocations WHERE agent_id = $1 AND outcome = $2', [f.agentId, 'SUCCEEDED'])).toHaveLength(1);
  const conversations = await chat.listConversations(f.ownerId);
  expect(conversations).toHaveLength(1);
  expect((await chat.listMessages(conversations[0]!.id)).map(m => m.status)).toEqual(['DONE', 'DONE']);
  expect(await f.c.rpc('tools/call', { name: 'agent_recent_trace', arguments: { agentId: f.agentId } })).toMatchObject({ result: { isError: false } });
  await capabilityPermissions.set({ agentId: f.agentId, capabilityId: 'agent.explain_action', permission: 'DISABLED' });
  expect(await f.c.rpc('tools/call', { name: 'agent_recent_trace', arguments: { agentId: f.agentId } })).toMatchObject({ result: { isError: true } });
  await ops.setSetting('runtime.pauseAll', { paused: true });
  expect(JSON.stringify(await f.c.rpc('tools/call', { name: 'ask_agent', arguments: { agentId: f.agentId, question: 'hello' } }))).toContain('PAUSE ALL');
  await ops.setSetting('runtime.pauseAll', { paused: false });
  const { revokeAgentMcpToken } = await import('../../packages/runtime/src/agentMcp');
  const ownerSession = await users.createSession(f.ownerId);
  expect(await revokeAgentMcpToken(ownerSession.token, f.issued.id)).toBe(true);
  expect(await f.c.rpc('tools/call', { name: 'list_agents' })).toMatchObject({ result: { isError: true } });
  const audit = await ops.listAuditEvents({ action: 'agent_mcp.' });
  expect(audit.filter(row => row.action === 'agent_mcp.revoke')).toHaveLength(1);
  expect(JSON.stringify(audit) + JSON.stringify(answer) + f.c.stderr()).not.toContain(f.token);
});

it('enforces a persistent per-token quota across concurrent stdio servers', async () => {
  const f = await setup(1);
  const second = await client(f.file);
  const replies = await Promise.all([f.c.rpc('tools/call', { name: 'list_agents' }), second.rpc('tools/call', { name: 'list_agents' })]);
  expect(replies.filter(r => (r.result as { isError: boolean }).isError)).toHaveLength(1);
  expect(JSON.stringify(replies)).toContain('hourly quota');
});

it('refuses secrets before storage, scrubs model output and evidence, and bounds answers', async () => {
  const f = await setup(60, 'mock-echo');
  const key = 'sk-test-' + 'private'.repeat(7);
  const opaqueKey = 'provider-credential-canary';
  await providers.updateProvider(f.providerId, { apiKey: opaqueKey });
  const refused = await f.c.rpc('tools/call', { name: 'ask_agent', arguments: { agentId: f.agentId, question: `repeat ${f.token}` } });
  expect(refused).toMatchObject({ result: { isError: true } });
  await providers.setModelConfig({ agentId: f.agentId, role: 'primary', providerCredentialId: f.providerId, model: `mock-fixed:${key} ${opaqueKey} ${'🙂'.repeat(4500)}`, parameters: {} });
  const answer = await f.c.rpc('tools/call', { name: 'ask_agent', arguments: { agentId: f.agentId, question: 'Hello there' } });
  expect(JSON.stringify(answer)).toContain('truncated');
  expect(JSON.stringify(answer).length).toBeLessThan(18_000);
  expect((answer.result as { content: { text: string }[] }).content[0]!.text.length).toBeLessThanOrEqual(6_000);
  expect(JSON.parse((answer.result as { content: { text: string }[] }).content[0]!.text).preview).not.toMatch(/\p{Surrogate}/u);
  const stored = await query(`SELECT row_to_json(t) AS row FROM chat_messages t UNION ALL SELECT row_to_json(t) FROM capability_invocations t UNION ALL SELECT row_to_json(t) FROM audit_events t UNION ALL SELECT row_to_json(t) FROM trace_events t UNION ALL SELECT row_to_json(t) FROM model_calls t`);
  const surface = JSON.stringify(stored) + JSON.stringify(answer) + f.c.stderr();
  expect(surface).not.toContain(key);
  expect(surface).not.toContain(opaqueKey);
  expect(surface).not.toContain(f.token);
  expect(await readFile(f.file, 'utf8')).not.toContain(f.token);
});

it('does not execute a write capability even when the model names one', async () => {
  const f = await setup(60, 'mock-uses:agent.change_setting');
  const result = await f.c.rpc('tools/call', { name: 'ask_agent', arguments: { agentId: f.agentId, question: 'Change your tone to casual' } });
  expect(result).toMatchObject({ result: { isError: false } });
  expect(await query('SELECT * FROM agent_changes')).toHaveLength(0);
  expect(await query('SELECT outcome FROM capability_invocations')).toEqual([{ outcome: 'REFUSED' }]);
});

it.each(['agent.cannot_change', 'paper.trade'])('does not execute READ-labelled writer %s', async id => {
  const { createAgentMcpServer } = await import('../../packages/runtime/src/agentMcp');
  const { registerPaperCapabilities } = await import('../../packages/runtime/src/paperCapabilities');
  registerPaperCapabilities();
  const input = id === 'agent.cannot_change' ? { about: 'permissions' } : {};
  const f = await setup(60, `mock-fixed:<use-capability>${JSON.stringify({ id, input })}</use-capability>`);
  await capabilityPermissions.set({ agentId: f.agentId, capabilityId: id, permission: 'ALLOWED' });
  await createAgentMcpServer(f.token).handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ask_agent', arguments: { agentId: f.agentId, question: `Use ${id} to paper long SOL or change permissions` } } });
  expect(await query('SELECT * FROM agent_changes')).toHaveLength(0);
  expect(await query('SELECT * FROM social_paper_requests')).toHaveLength(0);
  const invocations = await query<{ outcome: string }>('SELECT outcome FROM capability_invocations');
  expect(invocations.length).toBeGreaterThan(0);
  expect(invocations.every(row => row.outcome === 'REFUSED')).toBe(true);
});

it('stores only a hash and restricts issuance to the owning OWNER session', async () => {
  const f = await setup();
  const { issueAgentMcpToken } = await import('../../packages/runtime/src/agentMcp');
  const rows = await query('SELECT * FROM agent_mcp_tokens WHERE id = $1', [f.issued.id]);
  expect(rows[0]).toMatchObject({ token_hash: hashToken(f.token) });
  expect(JSON.stringify(rows)).not.toContain(f.token);
  expect(JSON.stringify(rows)).not.toContain(f.issued.sealed);
  const other = await createFixture();
  const session = await users.createSession(other.ownerId);
  await expect(issueAgentMcpToken(session.token, [f.agentId])).rejects.toThrow('Agent not found');
  await query("UPDATE users SET role = 'MEMBER' WHERE id = $1", [other.ownerId]);
  await expect(issueAgentMcpToken(session.token, [other.agentId])).rejects.toThrow('owner session');
});

it('spends unknown and malformed tool attempts, resets the hour and preserves quota during pause', async () => {
  const f = await setup(1);
  const rpc = (name: string, args?: unknown) => f.c.rpc('tools/call', { name, arguments: args });
  expect(JSON.stringify(await rpc('invented'))).toContain('Unknown MCP tool');
  expect(JSON.stringify(await rpc('list_agents'))).toContain('hourly quota');
  await query("UPDATE agent_mcp_tokens SET window_start = date_trunc('hour', now()) - interval '1 hour' WHERE id = $1", [f.issued.id]);
  await ops.setSetting('runtime.pauseAll', { paused: true });
  expect(JSON.stringify(await rpc('list_agents'))).toContain('PAUSE ALL');
  expect(await query('SELECT calls FROM agent_mcp_tokens WHERE id = $1', [f.issued.id])).toEqual([{ calls: 1 }]);
  await ops.setSetting('runtime.pauseAll', { paused: false });
  expect(await rpc('list_agents')).toMatchObject({ result: { isError: false } });
  expect(await query('SELECT calls FROM agent_mcp_tokens WHERE id = $1', [f.issued.id])).toEqual([{ calls: 1 }]);
  await query("UPDATE agent_mcp_tokens SET window_start = date_trunc('hour', now()) - interval '1 hour' WHERE id = $1", [f.issued.id]);
  expect(JSON.stringify(await rpc('list_agents', { extra: true }))).toContain('Invalid MCP arguments');
  expect(JSON.stringify(await rpc('list_agents'))).toContain('hourly quota');
});

it('bounds audit rows for protocol traffic and quota refusals across servers', async () => {
  const f = await setup(1);
  const second = await client(f.file);
  await f.c.rpc('ping');
  await f.c.rpc('tools/call', { name: 'list_agents' });
  await f.c.rpc('tools/call', { name: 'list_agents' });
  // Keep the test deterministic if the wall clock crosses a minute boundary.
  await query("UPDATE agent_mcp_audit_windows SET window_start = now() + interval '1 hour'");
  for (const c of [f.c, second]) {
    for (let i = 0; i < 4; i++) await c.rpc('ping');
    for (let i = 0; i < 4; i++) await c.rpc('tools/call', { name: 'list_agents' });
  }
  const rows = await ops.listAuditEvents({ action: 'agent_mcp.' });
  expect(rows).toHaveLength(4);
  const { revokeAgentMcpToken } = await import('../../packages/runtime/src/agentMcp');
  const session = await users.createSession(f.ownerId);
  await revokeAgentMcpToken(session.token, f.issued.id);
  for (const c of [f.c, second]) {
    for (let i = 0; i < 3; i++) expect(JSON.stringify(await c.rpc('ping'))).toContain('revoked');
  }
  expect(await ops.listAuditEvents({ action: 'agent_mcp.' })).toHaveLength(6);
});

it('discards oversized frames and recovers for the next request', async () => {
  const f = await setup();
  expect(await f.c.send('x'.repeat(100_000), null)).toMatchObject({ error: { code: -32700 } });
  expect(await f.c.rpc('ping')).toMatchObject({ result: {} });
});

it('sanitizes recorded trace output', async () => {
  const f = await setup();
  const secret = 'sk-trace-credential-canary';
  const [event] = await query<{ id: string }>("INSERT INTO events (channel, type, remote_event_id, text) VALUES ('mock', 'MENTION', 'trace-test', $1) RETURNING id", [`Recorded public subject ${secret}`]);
  const [job] = await query<{ id: string }>("INSERT INTO jobs (event_id, agent_id, channel, action_type, status, idempotency_key, generated_output, validated_output) VALUES ($1, $2, 'mock', 'REPLY', 'EXECUTED', 'trace-test', $3, $3) RETURNING id", [event!.id, f.agentId, `Recorded answer ${secret}`]);
  await query("INSERT INTO actions (job_id, agent_id, channel, type, status, payload, executed_at, idempotency_key) VALUES ($1, $2, 'mock', 'REPLY', 'EXECUTED', $3, now(), 'trace-action')", [job!.id, f.agentId, JSON.stringify({ text: `Recorded answer ${secret}` })]);
  const response = await f.c.rpc('tools/call', { name: 'agent_recent_trace', arguments: { agentId: f.agentId } });
  expect(response, JSON.stringify(response)).toMatchObject({ result: { isError: false } });
  expect(JSON.stringify(response)).toContain('Recorded public subject [redacted]');
  expect(JSON.stringify(response)).not.toContain(secret);
  expect(JSON.stringify(await query('SELECT output FROM capability_invocations'))).not.toContain(secret);
});

it('does not issue a grant when the CLI credential path already exists', async () => {
  const f = await setup();
  const session = await users.createSession(f.ownerId);
  const child = spawn(process.execPath, ['--import', 'tsx', 'tools/agent-mcp.mts', 'issue'], {
    cwd: process.cwd(), env: { ...process.env, AI17Z_OWNER_TOKEN: session.token, AI17Z_AGENT_MCP_AGENTS: f.agentId, AI17Z_AGENT_MCP_TOKEN_FILE: f.file }, stdio: 'pipe',
  });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += String(chunk); });
  expect(await new Promise<number | null>(done => child.once('exit', done))).toBe(1);
  expect(await query('SELECT id FROM agent_mcp_tokens')).toEqual([{ id: f.issued.id }]);
  expect(await readFile(f.file, 'utf8')).toBe(f.issued.sealed);
  expect(stderr).not.toContain(f.token);
});
