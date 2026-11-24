#!/usr/bin/env node
import { open, readFile, unlink } from 'node:fs/promises';

/** Discard an oversized frame while reading it, before allocating a whole line. */
async function* frames(input: AsyncIterable<Buffer>): AsyncGenerator<string | null> {
  let pending = Buffer.alloc(0);
  let oversized = false;
  for await (const chunk of input) {
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf(10, start);
      const end = newline < 0 ? chunk.length : newline;
      if (!oversized) {
        if (pending.length + end - start > 32_768) { oversized = true; pending = Buffer.alloc(0); }
        else pending = Buffer.concat([pending, chunk.subarray(start, end)]);
      }
      if (newline < 0) break;
      yield oversized ? null : pending.toString('utf8');
      pending = Buffer.alloc(0);
      oversized = false;
      start = newline + 1;
    }
  }
  if (oversized || pending.length) yield oversized ? null : pending.toString('utf8');
}

// Runtime loggers otherwise write informational lines onto the protocol stream.
process.env.XBAM_LOG_LEVEL = 'error';
const { loadEnv, openSecret } = await import('@xbam/shared');
loadEnv();
const { closePool } = await import('@xbam/database');
const { createAgentMcpServer, issueAgentMcpToken, revokeAgentMcpToken } = await import('../packages/runtime/src/agentMcp');

try {
  const command = process.argv[2];
  if (command === 'issue') {
    const file = process.env.AI17Z_AGENT_MCP_TOKEN_FILE;
    if (!file) throw new Error('Credential file required.');
    // Reserve the path before issuing: an existing file cannot orphan a grant.
    const credential = await open(file, 'wx', 0o600);
    let issued: Awaited<ReturnType<typeof issueAgentMcpToken>> | undefined;
    try {
      issued = await issueAgentMcpToken(process.env.AI17Z_OWNER_TOKEN ?? '', (process.env.AI17Z_AGENT_MCP_AGENTS ?? '').split(','), Number(process.env.AI17Z_AGENT_MCP_QUOTA ?? 60));
      await credential.writeFile(issued.sealed, 'utf8');
      await credential.sync();
      await credential.close();
      process.stdout.write(`Issued credential ${issued.id}.\n`);
    } catch (error) {
      if (issued) {
        try { await revokeAgentMcpToken(process.env.AI17Z_OWNER_TOKEN ?? '', issued.id); }
        catch { process.stderr.write(`Credential write failed. Revoke credential ${issued.id} before retrying.\n`); }
      }
      await credential.close().catch(() => undefined);
      await unlink(file).catch(() => undefined);
      throw error;
    }
  } else if (command === 'revoke') {
    const revoked = await revokeAgentMcpToken(process.env.AI17Z_OWNER_TOKEN ?? '', process.argv[3] ?? '');
    process.stdout.write(revoked ? 'Credential revoked.\n' : 'Credential not found.\n');
  } else if (command) {
    throw new Error('Unknown command.');
  } else {
    const file = process.env.AI17Z_AGENT_MCP_TOKEN_FILE;
    if (!file) throw new Error('Credential file required.');
    const token = openSecret((await readFile(file, 'utf8')).trim());
    const server = createAgentMcpServer(token);
    for await (const line of frames(process.stdin)) {
      if (line !== null && !line.trim()) continue;
      let message: unknown;
      try {
        if (line === null) throw new Error('Request too large.');
        message = JSON.parse(line);
      } catch {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Invalid or oversized JSON request.' } }) + '\n');
        continue;
      }
      const response = await server.handle(message && typeof message === 'object' && !Array.isArray(message) ? message as Record<string, unknown> : {});
      if (response) process.stdout.write(JSON.stringify(response) + '\n');
    }
  }
} catch {
  // Errors can contain credentials or local paths. None belong on this stream.
  process.stderr.write('Agent MCP could not start or complete the local command. Check the credential file, owner session and database configuration.\n');
  process.exitCode = 1;
} finally {
  await closePool();
}
