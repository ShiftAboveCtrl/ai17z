/**
 * Writing an agent to a file, and reading one back.
 *
 * `portableAgent.ts` decides *what* travels. This decides how it becomes a file
 * somebody can send, inspect, and import on another machine -- and, mostly, how
 * to read one nobody vouched for.
 *
 * ## Reading a package is the dangerous half
 *
 * Exporting is easy: it is our own data going out. Importing is a file that
 * arrived from somewhere, and the shape of the format is what makes that safe
 * rather than a rule the importer has to remember:
 *
 *   - **Nothing in a package can be executed.** There is no script field, no
 *     command, no path that gets run. Not because the importer refuses to run
 *     them, but because the schema has nowhere to put one.
 *   - **Nothing in a package becomes a file at a path it chose.** The one
 *     attachment is an image, carried inline as base64, written under an id
 *     AI17Z generates. A package cannot name where anything lands.
 *   - **Nothing in a package can claim an identity.** No agent id, no owner, no
 *     credential id. An import is always a new agent owned by whoever imported
 *     it, so a shared file cannot overwrite somebody's work.
 *   - **Nothing in a package is trusted about itself.** Every count shown to a
 *     person before they import is counted from the parsed document, never read
 *     from a field the file supplied.
 *
 * ## Inspect, then import
 *
 * Two steps, always, because the whole point of a portable agent is that
 * somebody can be handed one -- and being handed something is exactly when you
 * want to look inside before opening it.
 */
import { createHash } from 'node:crypto';
import {
  AGENT_PACKAGE_EXTENSION,
  AGENT_PACKAGE_VERSION,
  AgentPackage as AgentPackageSchema,
} from '@xbam/shared/contracts';
import type {
  AgentPackage,
  AgentPackageMode,
  AgentPackageSummary,
  PortableLearned,
} from '@xbam/shared/contracts';
import { BadRequestError, describeVersion, nowIso, sniffImage } from '@xbam/shared';
import { agents as agentsRepo, memories as memoriesRepo, ops as opsRepo, query } from '@xbam/database';
import { exportAgent, importAgent } from './portableAgent';
import { currentArtifactId, setAgentAvatar } from './avatar';
import { storageDir } from './channelContext';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/** A package this large is not an agent, whatever it says it is. */
export const MAX_PACKAGE_BYTES = 32 * 1024 * 1024;

export { AGENT_PACKAGE_EXTENSION };

/**
 * The checksum.
 *
 * Over the content, with keys sorted, so the same agent produces the same digest
 * whichever order a JSON serialiser happened to emit fields in. It catches a
 * truncated download, which is the failure that actually happens -- half an
 * agent imported silently is far worse than a file that refuses to open.
 *
 * It is not a signature and is not presented as one. Anybody who can alter the
 * document can alter the checksum, which is why the importer validates the
 * content rather than resting on this.
 */
export function checksumOf(content: {
  agent: unknown;
  avatar: unknown;
  learned: unknown;
}): string {
  return createHash('sha256').update(canonical(content)).digest('hex');
}

/** Stable JSON: object keys sorted, arrays left in order because order is data. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
}

/** The filename a download is offered under. */
export function packageFilename(name: string, mode: AgentPackageMode): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `${slug || 'agent'}${mode === 'MOVE' ? '-move' : ''}${AGENT_PACKAGE_EXTENSION}`;
}

/** Reads the agent's stored portrait back out, so the face travels with it. */
async function readAvatar(agentId: string): Promise<AgentPackage['avatar']> {
  const agent = await agentsRepo.getAgent(agentId);
  const artifactId = currentArtifactId(agent?.avatarUrl);
  // An external URL is already in the document as a URL and needs nothing here.
  if (!artifactId) return null;

  const artifact = await opsRepo.getArtifact(artifactId);
  if (!artifact) return null;
  const bytes = await readFile(resolve(storageDir(), artifact.relPath)).catch(() => null);
  if (!bytes) return null;

  // Sniffed on the way out as well as the way in. A stored mime type is a fact
  // about a past upload, and this is a fresh claim being made to a stranger.
  const info = sniffImage(bytes);
  if (!info) return null;
  return { mime: info.mime, base64: bytes.toString('base64') };
}

/**
 * What the agent has learned, for a MOVE.
 *
 * Read directly rather than through the repositories that shape memories for a
 * prompt: what travels is the content, not the retrieval scores, embeddings or
 * decay that are properties of one installation's index and mean nothing in
 * another.
 *
 * Memories only. Relationships and stances are learned from what the agent
 * actually published and rebuild themselves on a new installation, so carrying
 * them would put a list of everyone the agent has spoken to into a file that
 * gets emailed around, in order to reconstruct something that reconstructs
 * itself.
 */
async function readLearned(agentId: string): Promise<PortableLearned> {
  const memories = await query<{
    scope: string;
    memory_type: string;
    content: string;
    summary: string | null;
    importance: number;
    remote_handle: string | null;
  }>(
    `SELECT scope, memory_type, content, summary, importance, remote_handle
       FROM memories WHERE agent_id = $1 ORDER BY created_at LIMIT 5000`,
    [agentId],
  );

  return {
    memories: memories.map((m) => ({
      scope: m.scope,
      memoryType: m.memory_type,
      content: m.content,
      summary: m.summary,
      importance: Number(m.importance) || 0.5,
      // The handle, not the scope key. A scope key is derived from it on write,
      // so carrying the key would be carrying a value the importer recomputes.
      aboutHandle: m.remote_handle,
    })),
  };
}

/**
 * Writes the package.
 *
 * SHARE is configuration and is safe to hand to anybody. MOVE adds what the
 * agent has learned, which is not shareable and is not meant to be -- it exists
 * so somebody can carry their own agent to their own new machine.
 */
export async function packAgent(agentId: string, mode: AgentPackageMode): Promise<AgentPackage> {
  const agent = await agentsRepo.getAgent(agentId);
  if (!agent) throw new BadRequestError('That agent no longer exists.');

  const document = await exportAgent(agentId);
  const avatar = await readAvatar(agentId);
  const learned = mode === 'MOVE' ? await readLearned(agentId) : null;

  return AgentPackageSchema.parse({
    format: 'ai17z-agent',
    version: AGENT_PACKAGE_VERSION,
    mode,
    exportedAt: nowIso(),
    // The version, and nothing that identifies the machine or the person. A
    // package is something people send each other, and a stable sender id turns
    // every shared agent into a way of learning who made it.
    exportedByVersion: describeVersion(),
    checksum: checksumOf({ agent: document, avatar, learned }),
    agent: document,
    avatar,
    learned,
  });
}

/** Serialised for download, pretty enough that somebody can read it in an editor. */
export function serialisePackage(pkg: AgentPackage): string {
  return `${JSON.stringify(pkg, null, 2)}\n`;
}

/**
 * Looks inside without creating anything.
 *
 * Never throws for a bad package: an unreadable file is a thing to be told
 * about, not an error to handle. Everything it reports is counted from the
 * parsed document -- a package that described itself as harmless would be
 * exactly the one worth checking.
 */
export function inspectPackage(raw: string | Buffer): AgentPackageSummary {
  const empty: AgentPackageSummary['counts'] = {
    styleExamples: 0,
    models: 0,
    tools: 0,
    knowledgeSources: 0,
    memories: 0,
  };
  const unreadable = (problem: string): AgentPackageSummary => ({
    valid: false,
    problem,
    mode: null,
    name: null,
    exportedAt: null,
    exportedByVersion: null,
    checksumOk: false,
    counts: empty,
    hasAvatar: false,
    notes: [],
  });

  const text = typeof raw === 'string' ? raw : raw.toString('utf8');
  if (text.length > MAX_PACKAGE_BYTES) {
    return unreadable(`That file is larger than ${MAX_PACKAGE_BYTES / 1024 / 1024}MB, which no agent is.`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return unreadable('That file is not an AI17Z agent package. It is not readable as JSON.');
  }

  const result = AgentPackageSchema.safeParse(parsed);
  if (!result.success) {
    const first = result.error.issues[0];
    const where = first?.path.join('.') || 'the file';
    return unreadable(`That package could not be read: ${first?.message ?? 'unknown problem'} (at ${where}).`);
  }

  const pkg = result.data;
  const checksumOk = pkg.checksum === checksumOf({ agent: pkg.agent, avatar: pkg.avatar, learned: pkg.learned });

  const notes: string[] = [];
  if (!checksumOk) {
    notes.push('The checksum does not match its contents. The file is probably damaged or was edited by hand.');
  }
  if (pkg.mode === 'MOVE') {
    notes.push(
      'This is a move package: it carries what the agent has learned, not just how it is configured. Import it only if it is your own agent.',
    );
  }
  if (pkg.agent.models.length > 0) {
    notes.push(
      'Model roles name a provider but carry no credential. You will need your own key for each before the agent can run.',
    );
  }
  if (pkg.agent.knowledge.some((k) => k.kind === 'PATH')) {
    notes.push('One or more knowledge sources point at a folder path, which will not exist on this machine.');
  }
  if (pkg.agent.capabilities.length > 0) {
    notes.push('Capabilities describe an intended permission profile. Importing grants nothing until you connect an account.');
  }

  return {
    valid: true,
    problem: null,
    mode: pkg.mode,
    name: pkg.agent.name,
    exportedAt: pkg.exportedAt,
    exportedByVersion: pkg.exportedByVersion,
    checksumOk,
    counts: {
      styleExamples: pkg.agent.persona?.styleExamples?.length ?? 0,
      models: pkg.agent.models.length,
      tools: pkg.agent.tools.length,
      knowledgeSources: pkg.agent.knowledge.length,
      memories: pkg.learned?.memories.length ?? 0,
    },
    hasAvatar: pkg.avatar !== null,
    notes,
  };
}

export interface UnpackResult {
  agentId: string;
  /** What was brought in, counted after the fact rather than promised. */
  imported: { memories: number; avatar: boolean };
  /** What could not be, and why. Never silent. */
  skipped: string[];
}

/**
 * Creates an agent from a package.
 *
 * Always a new agent, owned by whoever imported it. A package carries no id and
 * could not claim an existing one, which is what stops a shared file
 * overwriting somebody's work.
 */
export async function unpackAgent(input: {
  ownerId: string;
  raw: string | Buffer;
  name?: string;
  createdBy: string;
  /** Bring the learned material too. Ignored for a SHARE package, which has none. */
  includeLearned?: boolean;
}): Promise<UnpackResult> {
  const summary = inspectPackage(input.raw);
  if (!summary.valid) throw new BadRequestError(summary.problem ?? 'That package could not be read.');

  const text = typeof input.raw === 'string' ? input.raw : input.raw.toString('utf8');
  const pkg = AgentPackageSchema.parse(JSON.parse(text));
  if (!summary.checksumOk) {
    // Refused rather than warned about. A package whose checksum does not match
    // is damaged or altered, and half an agent imported silently is the outcome
    // the checksum exists to prevent.
    throw new BadRequestError(
      'That package does not match its own checksum. It is damaged or was edited; ask for a fresh copy.',
    );
  }

  const created = await importAgent({
    ownerId: input.ownerId,
    document: pkg.agent,
    ...(input.name ? { name: input.name } : {}),
    createdBy: input.createdBy,
  });
  const agentId = (created as { id?: string }).id ?? (created as { agentId?: string }).agentId!;

  const skipped: string[] = [];
  const imported = { memories: 0, avatar: false };

  if (pkg.avatar) {
    try {
      const bytes = Buffer.from(pkg.avatar.base64, 'base64');
      // Through the ordinary avatar path, which sniffs the bytes, enforces the
      // size and dimension limits, and writes under an id AI17Z generates. The
      // package does not get to say what its picture is or where it lands.
      await setAgentAvatar(agentId, bytes);
      imported.avatar = true;
    } catch (error) {
      skipped.push(`The picture was not imported: ${(error as Error).message}`);
    }
  }

  if (pkg.learned && input.includeLearned !== false) {
    for (const memory of pkg.learned.memories) {
      try {
        await memoriesRepo.writeMemory({
          agentId,
          scope: memory.scope as never,
          memoryType: memory.memoryType as never,
          content: memory.content,
          summary: memory.summary,
          importance: memory.importance,
          // The scope key is derived from this on write rather than carried,
          // so an import cannot address a memory at a key of its choosing.
          remoteHandle: memory.aboutHandle,
        });
        imported.memories += 1;
      } catch {
        // One bad row must not lose the rest. The total is reported below, so a
        // partial import is visible rather than assumed complete.
      }
    }
    if (imported.memories < pkg.learned.memories.length) {
      skipped.push(
        `${pkg.learned.memories.length - imported.memories} of ${pkg.learned.memories.length} memories could not be written.`,
      );
    }
  }

  return { agentId, imported, skipped };
}
