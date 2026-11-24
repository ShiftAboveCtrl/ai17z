import { z } from 'zod';
import { agentMcp, agents, capabilityInvocations, chat, introspection, ops, providers, users } from '@xbam/database';
import { createLogger, newId } from '@xbam/shared';
import { getCapability, invokeCapability, registerBuiltinCapabilities } from '@xbam/tools';
import { capabilitySettings } from './capabilityPermissions';
import { INTROSPECTION_CAPABILITIES, registerIntrospectionCapabilities } from './introspectionCapabilities';
import { writeAnswer } from './ownerChat';
import { mcpSanitizer } from './mcpPrivacy';
import { registerManagementCapabilities } from './managementCapabilities';
import { reconcileInstalledPlugins } from './plugins';

export const AGENT_MCP_TOOLS = [
  { name: 'list_agents', description: 'List agents this owner-issued token may see.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'ask_agent', description: 'Ask the actual agent through private owner chat. Read only; no settings or actions can change.', inputSchema: { type: 'object', required: ['agentId', 'question'], properties: { agentId: { type: 'string', format: 'uuid' }, question: { type: 'string', minLength: 1, maxLength: 8000 } }, additionalProperties: false } },
  { name: 'agent_recent_trace', description: 'Read the latest recorded action decision summary through OWNER introspection. No hidden reasoning.', inputSchema: { type: 'object', required: ['agentId'], properties: { agentId: { type: 'string', format: 'uuid' } }, additionalProperties: false } },
].map(tool => ({ ...tool, annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false } }));

const Empty = z.object({}).strict();
const Agent = z.object({ agentId: z.string().uuid() }).strict();
const Ask = Agent.extend({ question: z.string().trim().min(1).max(8000) });
const MAX_OUTPUT = 6_000;

/** Host-local issuance still requires an existing OWNER session. No bearer is returned. */
export async function issueAgentMcpToken(session: string, ids: string[], quota = 60) {
  const owner = await users.resolveSession(session);
  if (owner?.role !== 'OWNER') throw new Error('An owner session is required.');
  const scope = z.array(z.string().uuid()).min(1).max(100).parse([...new Set(ids)]);
  z.number().int().min(1).max(1000).parse(quota);
  for (const id of scope) if ((await agents.getAgent(id))?.ownerId !== owner.id) throw new Error('Agent not found.');
  return agentMcp.issue(owner.id, scope, quota);
}

export async function revokeAgentMcpToken(session: string, id: string) {
  const owner = await users.resolveSession(session);
  if (owner?.role !== 'OWNER') throw new Error('An owner session is required.');
  return agentMcp.revoke(owner.id, z.string().uuid().parse(id));
}

function register() {
  if (!getCapability('time.now')) registerBuiltinCapabilities();
  if (!getCapability(INTROSPECTION_CAPABILITIES[0]!.id)) registerIntrospectionCapabilities();
  if (!getCapability('agent.change_setting')) registerManagementCapabilities();
}

export function createAgentMcpServer(token: string) {
  register();
  const sanitizer = mcpSanitizer([token, ...Object.entries(process.env)
    .filter(([key]) => /TOKEN|KEY|SECRET|PASSWORD/i.test(key)).map(([, value]) => value ?? '')]);
  const result = (value: unknown, isError = false) => {
    let text = JSON.stringify(sanitizer.value(value));
    if (text.length > MAX_OUTPUT) {
      let preview = Array.from(text).slice(0, MAX_OUTPUT - 500);
      do {
        text = JSON.stringify({ truncated: true, message: `Answer truncated to ${MAX_OUTPUT} characters.`, preview: preview.join('') });
        preview = preview.slice(0, Math.floor(preview.length * 0.8));
      } while (text.length > MAX_OUTPUT);
    }
    return { content: [{ type: 'text', text }], isError };
  };
  async function handle(message: Record<string, unknown>) {
    const id = typeof message.id === 'number' ? message.id : typeof message.id === 'string' ? sanitizer.text(message.id).slice(0, 100) : null;
    const notification = message.id === undefined;
    const params = message.params && typeof message.params === 'object' ? message.params as Record<string, unknown> : {};
    const tool = AGENT_MCP_TOOLS.find(t => t.name === params.name);
    const action = message.method === 'tools/call' ? tool?.name ?? 'unknown_tool' : 'protocol';
    const reply = (value: unknown) => notification ? null : { jsonrpc: '2.0', id, result: value };
    try {
      const grant = await agentMcp.resolve(token);
      // No caller-supplied text, token or token hash enters the audit.
      const audit = async (kind?: 'protocol' | 'refusal') => {
        if (kind && !(await agentMcp.admitAudit(grant?.id ?? null, kind))) return;
        await ops.audit({ actorUserId: grant?.owner_id ?? null, action: `agent_mcp.${action}`, entityType: 'agent_mcp', entityId: grant?.id ?? null });
      };
      if (!grant) {
        await audit('refusal');
        throw new Error('Owner token is invalid or revoked.');
      }
      if (message.method !== 'tools/call') await audit('protocol');
      if (message.jsonrpc !== '2.0' || typeof message.method !== 'string') throw new Error('Invalid JSON-RPC request.');
      if (message.method === 'initialize') return reply({ protocolVersion: ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'].includes(String(params.protocolVersion)) ? params.protocolVersion : '2025-11-25', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'ai17z-agent', version: '1.0.0' } });
      if (message.method === 'ping') return reply({});
      if (message.method === 'notifications/initialized' || message.method === 'notifications/cancelled') return null;
      if (message.method === 'tools/list') return reply({ tools: AGENT_MCP_TOOLS });
      if (message.method !== 'tools/call') throw new Error('Unknown MCP method.');
      const checkpoint = async () => {
        if (!(await agentMcp.resolve(token))) throw new Error('Owner token is invalid or revoked.');
        if ((await ops.getSetting<{ paused: boolean }>('runtime.pauseAll'))?.paused) throw new Error('PAUSE ALL is active.');
      };
      try { await checkpoint(); } catch (error) { await audit('refusal'); throw error; }
      if (!(await agentMcp.spend(grant.id))) {
        await audit('refusal');
        throw new Error('The token hourly quota is exhausted or the token was revoked.');
      }
      await audit();
      if (!tool) throw new Error('Unknown MCP tool.');
      for (const provider of await providers.listProviders(grant.owner_id)) {
        const key = await providers.getDecryptedApiKey(provider.id);
        if (key) sanitizer.add(key);
      }
      const args = params.arguments ?? {};
      if (JSON.stringify(args) !== JSON.stringify(sanitizer.value(args))) throw new Error('Credentials are not accepted in MCP arguments.');
      await reconcileInstalledPlugins();
      if (tool.name === 'list_agents') {
        Empty.parse(args);
        return reply(result({ agents: (await agents.listAgents(grant.owner_id)).filter(a => grant.agent_ids.includes(a.id)).map(a => ({ id: a.id, name: a.name, state: a.state })) }));
      }
      const parsed = tool.name === 'ask_agent' ? Ask.parse(args) : Agent.parse(args);
      const agent = await agents.getAgent(parsed.agentId);
      if (!agent || agent.ownerId !== grant.owner_id || !grant.agent_ids.includes(agent.id)) throw new Error('Agent not found.');
      const ownedCheckpoint = async () => {
        await checkpoint();
        if ((await agents.getAgent(agent.id))?.ownerId !== grant.owner_id) throw new Error('Agent not found.');
      };
      if (tool.name === 'ask_agent') {
        const question = Ask.parse(args).question;
        const conversation = await chat.createConversation({ ownerId: grant.owner_id, kind: 'AGENT', title: 'MCP question', agentIds: [agent.id] });
        // No PENDING answer is exposed to workers; this process owns the inline turn.
        const posted = await chat.postOwnerMessage({ conversationId: conversation.id, content: question, answerers: [] });
        const outcome = await writeAnswer({ ...posted.message, id: newId(), agentId: agent.id, authorKind: 'AGENT', status: 'ANSWERING', answers: posted.message.id }, { mayResearch: false, readOnly: { sanitize: sanitizer.text, sanitizeValue: sanitizer.value, checkpoint: ownedCheckpoint } });
        const safe = sanitizer.value(outcome) as typeof outcome;
        const status = safe.status === 'DONE' ? 'DONE' as const : 'FAILED' as const;
        if (safe.status === 'HANDOFF') safe.error = 'This question needs a browser worker. Ask it in owner chat.';
        await chat.postDelegatedAnswer({ ...safe, status, conversationId: conversation.id, agentId: agent.id, ownerMessageId: posted.message.id });
        await ownedCheckpoint();
        return reply(result({ status, answer: safe.content, error: safe.error, evidence: safe.evidence }, status !== 'DONE'));
      }
      const settings = await capabilitySettings(agent.id, { failClosed: true });
      const latest = (await introspection.recentActions(agent.id, 1))[0];
      const call = { id: 'agent.explain_action', input: { ref: latest?.id ?? 'no-recorded-action' } };
      await ownedCheckpoint();
      const invoked = await invokeCapability({ call, context: { agentId: agent.id, jobId: null, accountId: null, audience: 'OWNER', config: settings.configs.get(call.id) ?? {}, logger: createLogger('agent-mcp') }, permission: { stored: settings.permissions.get(call.id) ?? null, paused: false } });
      const safe = sanitizer.value(invoked) as typeof invoked;
      await capabilityInvocations.recordInvocation({ ...safe, agentId: agent.id, jobId: null, accountId: null, step: 0 });
      await ownedCheckpoint();
      return reply(result(safe, safe.outcome !== 'SUCCEEDED'));
    } catch (error) {
      const reason = error instanceof z.ZodError ? 'Invalid MCP arguments.' : error instanceof Error && /^(Owner token|The token hourly quota|PAUSE ALL|Agent not found|Credentials are not accepted|Unknown MCP|Invalid JSON-RPC)/.test(error.message) ? error.message : 'The MCP request could not be completed.';
      if (notification) return null;
      return message.method === 'tools/call'
        ? reply(result({ error: reason }, true))
        : { jsonrpc: '2.0', id, error: { code: -32000, message: reason } };
    }
  }
  return { handle };
}
