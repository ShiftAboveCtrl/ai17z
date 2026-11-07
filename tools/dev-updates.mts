/**
 * The owner's side of development updates, from a terminal.
 *
 *   npm run dev-updates -- projects
 *   npm run dev-updates -- create --key ai17z --name AI17Z --agent <agentId> --account <accountId>
 *   npm run dev-updates -- set <projectId> --mode AUTO --cap 2 --spacing 240 --rehearse false
 *   npm run dev-updates -- token <projectId>        issue a new sender token (the old one stops working)
 *   npm run dev-updates -- revoke <projectId>       remove the sender token
 *   npm run dev-updates -- list [--project <id>] [--status PENDING_REVIEW]
 *   npm run dev-updates -- show <updateId>
 *   npm run dev-updates -- approve <updateId> [--text "edited post"] [--note "why"]
 *   npm run dev-updates -- reject <updateId> [--note "why"]
 *
 * Signs in with AI17Z_OWNER_TOKEN (a session token) or with AI17Z_OWNER_EMAIL
 * and AI17Z_OWNER_PASSWORD, against AI17Z_API_URL (default
 * http://localhost:8787). This is the owner's credential and can approve; the
 * sender token handed to a coding assistant cannot.
 *
 * Everything here goes through the HTTP API, so it is exactly what the API
 * allows and no more.
 */

const apiUrl = (process.env.AI17Z_API_URL || process.env.XBAM_API_URL || 'http://localhost:8787').replace(/\/+$/, '');

interface Envelope<T> {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string; details?: unknown };
}

class CliError extends Error {}

async function call<T>(method: string, path: string, token: string | null, body?: unknown): Promise<T> {
  const response = await fetch(`${apiUrl}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  }).catch((error: unknown) => {
    throw new CliError(`AI17Z is not reachable at ${apiUrl}: ${error instanceof Error ? error.message : String(error)}`);
  });
  const payload = (await response.json().catch(() => null)) as Envelope<T> | null;
  if (payload?.ok) return payload.data as T;
  const details = payload?.error?.details as { refusals?: Array<{ field: string; message: string }> } | undefined;
  const lines = [payload?.error?.message ?? `AI17Z answered ${response.status}.`];
  for (const r of details?.refusals ?? []) lines.push(`  ${r.field}: ${r.message}`);
  throw new CliError(lines.join('\n'));
}

async function ownerToken(): Promise<string> {
  if (process.env.AI17Z_OWNER_TOKEN) return process.env.AI17Z_OWNER_TOKEN;
  const email = process.env.AI17Z_OWNER_EMAIL;
  const password = process.env.AI17Z_OWNER_PASSWORD;
  if (!email || !password) {
    throw new CliError('Set AI17Z_OWNER_TOKEN, or AI17Z_OWNER_EMAIL and AI17Z_OWNER_PASSWORD, to act as the owner.');
  }
  const session = await call<{ token: string }>('POST', '/api/auth/login', null, { email, password });
  return session.token;
}

function parseArgs(argv: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) flags[key] = 'true';
      else {
        flags[key] = value;
        i += 1;
      }
    } else positional.push(arg);
  }
  return { positional, flags };
}

function bool(value: string | undefined): boolean | undefined {
  if (value === undefined) return undefined;
  if (['true', 'yes', '1', 'on'].includes(value.toLowerCase())) return true;
  if (['false', 'no', '0', 'off'].includes(value.toLowerCase())) return false;
  throw new CliError(`"${value}" is not true or false.`);
}

function int(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n)) throw new CliError(`"${value}" is not a whole number.`);
  return n;
}

function need(value: string | undefined, what: string): string {
  if (!value) throw new CliError(`Give ${what}.`);
  return value;
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function main(): Promise<void> {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const [command, target] = positional;
  if (!command || command === 'help') {
    process.stdout.write(
      'Commands: projects, create, set, token, revoke, list, show, approve, reject. See the top of tools/dev-updates.mts.\n',
    );
    return;
  }
  const token = await ownerToken();

  switch (command) {
    case 'projects':
      return print(await call('GET', '/api/dev-updates/projects', token));
    case 'create': {
      const created = await call<{ project: unknown; senderToken: string }>('POST', '/api/dev-updates/projects', token, {
        projectKey: need(flags.key, '--key'),
        displayName: need(flags.name, '--name'),
        agentId: need(flags.agent, '--agent'),
        accountId: need(flags.account, '--account'),
        ...(flags.mode ? { mode: flags.mode.toUpperCase() } : {}),
        ...(flags.cap ? { dailyCap: int(flags.cap) } : {}),
        ...(flags.spacing ? { minSpacingMinutes: int(flags.spacing) } : {}),
        ...(flags.rehearse !== undefined ? { rehearse: bool(flags.rehearse) } : {}),
      });
      print(created.project);
      process.stdout.write(`\nSender token (shown once, give it to the coding assistant):\n${created.senderToken}\n`);
      return;
    }
    case 'set':
      return print(
        await call('PATCH', `/api/dev-updates/projects/${need(target, 'a project id')}`, token, {
          ...(flags.name ? { displayName: flags.name } : {}),
          ...(flags.agent ? { agentId: flags.agent } : {}),
          ...(flags.account ? { accountId: flags.account } : {}),
          ...(flags.mode ? { mode: flags.mode.toUpperCase() } : {}),
          ...(flags.cap ? { dailyCap: int(flags.cap) } : {}),
          ...(flags.spacing ? { minSpacingMinutes: int(flags.spacing) } : {}),
          ...(flags.rehearse !== undefined ? { rehearse: bool(flags.rehearse) } : {}),
          ...(flags.enabled !== undefined ? { enabled: bool(flags.enabled) } : {}),
        }),
      );
    case 'token': {
      const issued = await call<{ senderToken: string }>(
        'POST',
        `/api/dev-updates/projects/${need(target, 'a project id')}/sender-token`,
        token,
      );
      process.stdout.write(`New sender token (shown once; the previous one no longer works):\n${issued.senderToken}\n`);
      return;
    }
    case 'revoke':
      return print(await call('DELETE', `/api/dev-updates/projects/${need(target, 'a project id')}/sender-token`, token));
    case 'list': {
      const query = new URLSearchParams();
      if (flags.project) query.set('projectId', flags.project);
      if (flags.status) query.set('status', flags.status.toUpperCase());
      if (flags.limit) query.set('limit', flags.limit);
      const q = query.toString();
      return print(await call('GET', `/api/dev-updates/updates${q ? `?${q}` : ''}`, token));
    }
    case 'show':
      return print(await call('GET', `/api/dev-updates/updates/${need(target, 'an update id')}`, token));
    case 'approve':
      return print(
        await call('POST', `/api/dev-updates/updates/${need(target, 'an update id')}/approve`, token, {
          ...(flags.text ? { editedText: flags.text } : {}),
          ...(flags.note ? { note: flags.note } : {}),
        }),
      );
    case 'reject':
      return print(
        await call('POST', `/api/dev-updates/updates/${need(target, 'an update id')}/reject`, token, {
          ...(flags.note ? { note: flags.note } : {}),
        }),
      );
    default:
      throw new CliError(`Unknown command "${command}". Try "help".`);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
