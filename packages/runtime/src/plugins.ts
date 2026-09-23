import { createHash } from 'node:crypto';
import {
  capabilityPermissions as permissionsRepo,
  capabilityInvocations as invocationsRepo,
  plugins as pluginsRepo,
  ops,
} from '@xbam/database';
import {
  NotFoundError,
  PluginManifest,
  buildVersion,
  comparePluginVersions,
  defaultPermission,
  footprintExpansion,
  pluginFootprint,
  pluginOfCapability,
  pluginRuns,
} from '@xbam/shared';
import type {
  CapabilityPermission,
  InstalledPlugin,
  PluginState,
  PluginView,
  PluginCapabilityView,
} from '@xbam/shared/contracts';
import {
  TOOLPACKS,
  getCapability,
  listCapabilities,
  registerCapability,
  unregisterCapability,
  listModelCallable,
} from '@xbam/tools';
import type { AnyCapability } from '@xbam/tools';
import { capabilitiesOf } from './pluginCapabilities';
import { capabilityViews } from './capabilityViews';
import { atLeastDefault, setToolpack } from './toolpackViews';

/**
 * Plugins, as the owner's product over the capability system.
 *
 * Nothing here is a second registry, a second permission store or a second
 * executor. A Plugin's state is computed from `agent_capability_permissions`,
 * which stays the only place a decision about what an agent may do lives, and
 * enabling a Plugin writes those permissions. The same argument `toolpacks.ts`
 * makes about packs applies with more force to something an owner can install
 * from elsewhere.
 *
 * Built-in Plugins are the toolpacks. They are presented as Plugins rather
 * than copied into a second list, so the seventy-odd capabilities are still
 * registered exactly once.
 */

/** Where the Plugins area reads its registry address from. */
export const REGISTRY_URL_KEY = 'plugins.registry.url';
/** The sealed registry key lives beside it, never in this value. */
export const REGISTRY_KEY_KEY = 'plugins.registry.key';

/**
 * Built-in Plugins that a brand new agent gets switched on.
 *
 * Chosen against the rule an owner would recognise rather than a preference:
 * read-only, useful without a credential, bounded in time and cost, no
 * surprise and nothing irreversible. `time` and `agent` answer questions about
 * the agent and the clock. `reference` looks a term up. `web` reads a page or
 * a feed the agent was pointed at.
 *
 * Deliberately not here: X, which needs a connected account and reads somebody
 * else's timeline; crypto, which is financial; projects, which needs a watch
 * the owner sets up; filings, which needs a declared contact address. None of
 * those is unsafe, and none of them is a sensible thing to switch on for
 * somebody who has not asked.
 *
 * This decides the *starting point* for a new agent only. It never changes an
 * agent that already exists, and it never overrides an owner.
 */
export const CORE_RECOMMENDED_PACKS = ['reference', 'web'] as const;

/** Capability families a new agent gets that belong to no pack. */
const CORE_RECOMMENDED_PREFIXES = ['time.', 'agent.', 'memory.'] as const;

interface PluginCapability {
  capability: AnyCapability;
  pluginId: string;
}

/** Every capability, labelled with the Plugin it belongs to. */
function labelled(installed: InstalledPlugin[]): PluginCapability[] {
  const out: PluginCapability[] = [];
  for (const capability of listCapabilities()) {
    const fromPlugin = pluginOfCapability(capability.id);
    if (fromPlugin) {
      // Only if it is still installed. A capability whose Plugin has gone is
      // not attributed to it.
      if (installed.some((entry) => entry.id === fromPlugin)) out.push({ capability, pluginId: fromPlugin });
      continue;
    }
    const pack = TOOLPACKS.find((entry) => entry.prefixes.some((prefix) => capability.id.startsWith(prefix)));
    if (pack) out.push({ capability, pluginId: pack.id });
  }
  return out;
}

/**
 * How a Plugin's capabilities read, taken together.
 *
 * Measured against each capability's **own default**, using the same
 * `atLeastDefault` comparison a toolpack's state uses, because these are two
 * renderings of one fact and an owner sees both. Compared by equality instead,
 * as this did, the X pack read MIXED on the Plugins screen and ON on the
 * agent's own page: its reads default to ALLOWED and its writes default to
 * asking or off, so "every capability at its default" is several different
 * permissions and never one.
 *
 * Four words rather than two, because "on" covering a Plugin where half the
 * capabilities are switched off is a summary an owner acts on and is wrong
 * about. A Plugin with nothing in it is OFF: there is nothing it could do.
 */
function stateOf(members: { permission: CapabilityPermission; fallback: CapabilityPermission }[]): PluginState {
  if (members.length === 0) return 'OFF';
  const met = members.filter((member) => atLeastDefault(member.permission, member.fallback));
  if (met.length === 0) {
    // Nothing reaches its default. Off, unless every one of them is sitting at
    // "ask me", which is a Plugin that works and checks first rather than one
    // that is switched off.
    return members.every((member) => member.permission === 'OWNER_APPROVAL') ? 'ASKS' : 'OFF';
  }
  if (met.length < members.length) return 'MIXED';
  return members.every((member) => member.permission === 'OWNER_APPROVAL') ? 'ASKS' : 'ON';
}

/**
 * Every Plugin this installation has, as the interface sees it.
 *
 * Computed on every call rather than cached. A Plugin's state is the state of
 * its capabilities' permissions, its readiness is a fact about this minute,
 * and a cached copy of either is a screen that can be wrong.
 */
export async function pluginViews(input: {
  agentId: string;
  accountId: string | null;
  paused: boolean;
  /**
   * Newer versions the registry offers, by Plugin id.
   *
   * Passed in rather than fetched here, because this function is called to
   * draw a screen and reaching a remote catalogue to do it would make every
   * render wait on somebody else's server. The caller asks the registry when
   * it wants to, and a view drawn without it simply says nothing about
   * updates rather than saying there are none.
   */
  updates?: Record<string, string>;
}): Promise<PluginView[]> {
  const installed = await pluginsRepo.listInstalledPlugins();
  const stored = await permissionsRepo.listForAgent(input.agentId);
  const byId = new Map(stored.map((row) => [row.capability_id, row.permission]));
  const members = labelled(installed);
  // Status and permission come from the one function that already computes
  // them, so a Plugin card cannot disagree with the capability row under it.
  const truth = new Map(
    (await capabilityViews(input)).map((view) => [view.id, view] as const),
  );
  const recent = await invocationsRepo.listForAgent(input.agentId, 200).catch(() => []);
  const lastByCapability = new Map<string, { at: string; outcome: string }>();
  for (const row of recent) {
    if (!lastByCapability.has(row.capabilityId)) {
      lastByCapability.set(row.capabilityId, { at: row.createdAt, outcome: row.outcome });
    }
  }

  const views: PluginView[] = [];

  const buildOne = async (
    id: string,
    name: string,
    summary: string,
    publisher: string,
    source: PluginView['source'],
    kind: PluginView['kind'],
    version: string | null,
    removable: boolean,
    record: InstalledPlugin | null,
  ): Promise<PluginView> => {
    const mine = members.filter((entry) => entry.pluginId === id);
    const capabilities: PluginCapabilityView[] = [];
    const settings: { permission: CapabilityPermission; fallback: CapabilityPermission }[] = [];
    for (const { capability } of mine) {
      const view = truth.get(capability.id);
      const fallback = defaultPermission(capability.effect, capability.risk);
      const permission = view?.permission ?? byId.get(capability.id) ?? fallback;
      settings.push({ permission, fallback });
      const last = lastByCapability.get(capability.id) ?? null;
      capabilities.push({
        id: capability.id,
        name: capability.name,
        description: capability.description,
        category: capability.category,
        effect: capability.effect,
        risk: capability.risk,
        modelCallable: capability.modelCallable,
        permission,
        status: view?.status ?? 'UNAVAILABLE',
        ...(view?.why ? { why: view.why } : {}),
        lastUsedAt: last?.at ?? null,
        lastOutcome: last?.outcome ?? null,
      });
    }

    const hosts = record
      ? [...new Set(record.manifest.capabilities.flatMap((declaration) => declaration.http.hosts))]
      : [];
    const quota = record
      ? record.manifest.capabilities.reduce((most, declaration) => Math.max(most, declaration.http.quotaPerHour), 0) || null
      : null;

    let missingConfig: string[] = [];
    let config: Record<string, unknown> = {};
    let secretsPresent: string[] = [];
    let callsThisHour: number | null = null;
    if (record) {
      config = await pluginsRepo.getPluginConfig(input.agentId, id);
      secretsPresent = await pluginsRepo.pluginSecretKeys(input.agentId, id);
      const secrets = new Set(secretsPresent);
      missingConfig = record.manifest.config
        .filter((field) => field.required)
        .filter((field) => (field.secret ? !secrets.has(field.key) : config[field.key] === undefined))
        .map((field) => field.label);
      callsThisHour = await pluginsRepo.pluginCallsThisHour(input.agentId, id);
    }

    /*
      Why the whole Plugin cannot work, as opposed to why one capability is
      not ready.

      There is exactly one such fact in schema v1 and it is the important one:
      a Plugin the owner has upgraded past. `registerInstalledPlugins` leaves
      it installed and unregistered on purpose, so without this line its
      capabilities simply vanish from the screen with no explanation at all.
    */
    let why: string | undefined;
    if (record) {
      const fits = pluginRuns(record.manifest.compatibility, buildVersion().version);
      if (!fits.ok) why = `${record.manifest.name} ${fits.why}, so none of it is running.`;
    }

    const lastUsedAt =
      capabilities
        .map((entry) => entry.lastUsedAt)
        .filter((value): value is string => Boolean(value))
        .sort()
        .at(-1) ?? null;

    return {
      id,
      name,
      summary,
      publisher,
      source,
      kind,
      version,
      updateAvailable: input.updates?.[id] ?? null,
      removable,
      state: stateOf(settings),
      capabilities,
      hosts,
      missingConfig,
      quotaPerHour: quota,
      callsThisHour,
      lastUsedAt,
      configFields: record ? record.manifest.config : [],
      config,
      secretsPresent,
      features: record ? record.manifest.features : [],
      panel: record?.manifest.panel ?? null,
      researchSourceName: record?.manifest.research?.sourceName ?? null,
      ...(why ? { why } : {}),
    };
  };

  for (const pack of TOOLPACKS) {
    /*
      A pack with nothing registered in it is not shown.

      It has no state to read, nothing to configure, and a "Turn on" button
      that would be refused -- `setToolpack` declines a pack with no members,
      correctly, because writing a decision about capabilities that do not
      exist is writing a row nobody will ever read. A card offering a control
      that cannot work is worse than no card. On a whole installation every
      pack has members, so this only ever hides one where a family genuinely
      is not registered.
    */
    if (!members.some((entry) => entry.pluginId === pack.id)) continue;
    views.push(
      await buildOne(pack.id, pack.name, pack.summary, 'AI17Z', 'BUILT_IN', 'CAPABILITY_PACK', null, false, null),
    );
  }
  for (const record of installed) {
    views.push(
      await buildOne(
        record.id,
        record.manifest.name,
        record.manifest.summary,
        record.publisher,
        record.source,
        record.manifest.kind,
        record.version,
        true,
        record,
      ),
    );
  }
  return views;
}

/**
 * Turn a Plugin on or off for one agent.
 *
 * On sets each capability to **its own default**, not to ALLOWED. "Let my
 * agent look things up" is not consent to let it publish, and a pack that
 * swept a write capability to allowed would be exactly that. Off is off, which
 * is unambiguous and is the only setting an owner can rely on.
 */
export async function setPluginEnabled(input: {
  agentId: string;
  pluginId: string;
  enabled: boolean;
}): Promise<{ changed: number }> {
  /*
    A built-in Plugin is a toolpack, so turning one on is `setToolpack` and
    not a second implementation of it that happens to agree today. The two
    would agree right up until one of them learned something -- `setToolpack`
    already refuses a pack with no registered members, which this used to
    answer with a cheerful "changed 0".
  */
  if (TOOLPACKS.some((pack) => pack.id === input.pluginId)) {
    const { changed } = await setToolpack({ agentId: input.agentId, packId: input.pluginId, on: input.enabled });
    return { changed: changed.length };
  }

  const installed = await pluginsRepo.listInstalledPlugins();
  if (!installed.some((record) => record.id === input.pluginId)) {
    // Neither a pack nor an installed Plugin. Refused by name rather than
    // silently doing nothing, which is what a typo used to look like.
    throw new NotFoundError('That Plugin');
  }
  const mine = labelled(installed).filter((entry) => entry.pluginId === input.pluginId);
  let changed = 0;
  for (const { capability } of mine) {
    const permission: CapabilityPermission = input.enabled
      ? defaultPermission(capability.effect, capability.risk)
      : 'DISABLED';
    await permissionsRepo.set({ agentId: input.agentId, capabilityId: capability.id, permission });
    changed += 1;
  }
  return { changed };
}

/**
 * What a brand new agent starts with.
 *
 * Called once, when an agent is created. It writes explicit permissions rather
 * than relying on defaults, so that what an owner sees on the Plugins screen
 * on day one is what the runtime will actually do, and so that a later change
 * to the recommended set does not silently re-open something for an agent that
 * already exists.
 */
export async function applyCoreRecommended(agentId: string): Promise<void> {
  const existing = await permissionsRepo.listForAgent(agentId);
  if (existing.length > 0) return; // Never overwrite an agent that has choices.

  const recommended = new Set<string>();
  for (const pack of TOOLPACKS) {
    if (!(CORE_RECOMMENDED_PACKS as readonly string[]).includes(pack.id)) continue;
    for (const capability of listCapabilities()) {
      if (pack.prefixes.some((prefix) => capability.id.startsWith(prefix))) recommended.add(capability.id);
    }
  }
  for (const capability of listCapabilities()) {
    if (CORE_RECOMMENDED_PREFIXES.some((prefix) => capability.id.startsWith(prefix))) recommended.add(capability.id);
  }

  for (const capability of listCapabilities()) {
    const permission: CapabilityPermission = recommended.has(capability.id)
      ? defaultPermission(capability.effect, capability.risk)
      : 'DISABLED';
    await permissionsRepo.set({ agentId, capabilityId: capability.id, permission });
  }
}

/** The sha256 of the manifest bytes as received, which is what was approved. */
export function manifestDigest(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

/**
 * Read a manifest and refuse it unless every question has an answer.
 *
 * Fails closed, always. A manifest that is malformed, of an unknown schema
 * version, incompatible with this build, or internally inconsistent is not
 * installed on a best-effort basis: the whole point of approving something is
 * that what was approved is what runs.
 */
export function readManifest(raw: string): { ok: true; manifest: PluginManifest } | { ok: false; why: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, why: 'That file is not JSON, so nothing in it could be checked.' };
  }
  const shape = PluginManifest.safeParse(parsed);
  if (!shape.success) {
    const first = shape.error.issues[0];
    const where = first?.path.length ? ` at "${first.path.join('.')}"` : '';
    return { ok: false, why: `The manifest is not one this version understands${where}: ${first?.message ?? 'invalid'}.` };
  }
  const fits = pluginRuns(shape.data.compatibility, buildVersion().version);
  if (!fits.ok) return { ok: false, why: `${shape.data.name} ${fits.why}.` };
  return { ok: true, manifest: shape.data };
}

/**
 * Install or update a Plugin, atomically.
 *
 * Registered into the canonical registry only after everything that could
 * refuse has refused, and unregistered again if recording it fails, so there
 * is no state where a capability is callable and unrecorded or recorded and
 * uncallable.
 */
export async function installPlugin(input: {
  raw: string;
  source: 'LOCAL' | 'AI17Z_REGISTRY';
  /** Set when replacing a Plugin already installed. */
  expectPublisher?: string;
  /**
   * The owner has seen what a new version asks for that the old one did not,
   * and said yes.
   *
   * Only consulted when there is something to acknowledge. An update that
   * asks for no more than the installed version needs no answer, because the
   * owner already gave it.
   */
  acknowledgeExpansion?: boolean;
  /**
   * Install an older version over a newer one, deliberately.
   *
   * Off by default. A downgrade arriving on its own is usually a catalogue
   * that has been rolled back or tampered with, and quietly replacing a
   * Plugin with an older one is how a fixed problem comes back.
   */
  allowDowngrade?: boolean;
}): Promise<
  | { ok: true; plugin: InstalledPlugin }
  | { ok: false; why: string; needsAcknowledgement?: string[] }
> {
  const read = readManifest(input.raw);
  if (!read.ok) return read;
  const manifest = read.manifest;

  const already = await pluginsRepo.getInstalledPlugin(manifest.id);
  if (already && already.publisher !== manifest.publisher) {
    // A later version under a different publisher is a substitution, not an
    // update, and it is refused by name rather than merged.
    return {
      ok: false,
      why: `${manifest.id} is installed from ${already.publisher}, and this copy says ${manifest.publisher}. That is a different publisher, so it was not installed.`,
    };
  }
  if (input.expectPublisher && manifest.publisher !== input.expectPublisher) {
    return { ok: false, why: `This copy of ${manifest.id} is published by ${manifest.publisher}, not ${input.expectPublisher}.` };
  }

  if (already && !input.allowDowngrade) {
    const order = comparePluginVersions(manifest.version, already.version);
    if (order < 0) {
      return {
        ok: false,
        why: `${manifest.name} ${already.version} is installed and this copy is ${manifest.version}, which is older. It was not installed.`,
      };
    }
  }

  /*
    An update that asks for more than the installed version has to be asked
    about again.

    Approval was given for what a manifest said. A new version reaching a host
    the owner never saw, adding a capability, unlocking a feature or raising
    its own ceiling is asking for something new, and inheriting the old answer
    is how an install becomes a standing permission to do anything later. The
    expansion is named in sentences rather than reported as a diff, because
    somebody has to decide about it.

    Narrowing passes silently. A Plugin needs no permission to do less.
  */
  if (already) {
    const grew = footprintExpansion(pluginFootprint(already.manifest), pluginFootprint(manifest));
    if (grew.length > 0 && !input.acknowledgeExpansion) {
      return {
        ok: false,
        why: `${manifest.name} ${manifest.version} asks for more than the version you approved.`,
        needsAcknowledgement: grew,
      };
    }
  }

  // A Plugin may not claim a capability id that already exists, whether that
  // is a built-in or another Plugin's. Checked before anything is written.
  const wanted = capabilitiesOf({ id: manifest.id, manifest });
  for (const capability of wanted) {
    const clash = getCapability(capability.id);
    if (clash && pluginOfCapability(capability.id) !== manifest.id) {
      return { ok: false, why: `${manifest.name} declares ${capability.id}, which already exists.` };
    }
  }

  // Replacing a Plugin means replacing its capabilities, so the old objects
  // come out first. The registry refuses to re-register an id with a
  // different object, which is the guard that stops two implementations of one
  // capability existing, and an update is exactly the case where that guard
  // would otherwise refuse the legitimate thing.
  if (already) {
    for (const capability of capabilitiesOf(already)) unregisterCapability(capability.id);
  }

  const registered: string[] = [];
  try {
    for (const capability of wanted) {
      registerCapability(capability);
      registered.push(capability.id);
    }
    await pluginsRepo.putInstalledPlugin({
      id: manifest.id,
      source: input.source,
      version: manifest.version,
      publisher: manifest.publisher,
      manifestSha256: manifestDigest(input.raw),
      manifest,
    });
  } catch (error) {
    for (const id of registered) unregisterCapability(id);
    // An update that failed leaves the copy that was working, registered as it
    // was. Half an update is the one outcome worse than none.
    if (already) {
      for (const capability of capabilitiesOf(already)) registerCapability(capability);
    }
    return { ok: false, why: `${manifest.name} could not be installed: ${(error as Error).message}` };
  }

  const plugin = await pluginsRepo.getInstalledPlugin(manifest.id);
  if (!plugin) {
    for (const id of registered) unregisterCapability(id);
    return { ok: false, why: `${manifest.name} was not recorded, so it was not installed.` };
  }
  return { ok: true, plugin };
}

/**
 * Remove a Plugin.
 *
 * Its capabilities stop being callable before its record goes, so there is no
 * window where the model can choose something whose configuration has been
 * deleted.
 *
 * A call already in flight is not interrupted, and cannot be. It is holding
 * the capability object it was handed and has already read whatever
 * configuration it needed, so unregistering does not reach it: the request
 * finishes, its result is validated, and its audit row is written like any
 * other. That is the right outcome rather than a tolerated one. The
 * alternative is a half-completed remote read whose answer nobody looks at,
 * and a Plugin that cannot be removed while it is busy is a Plugin that
 * cannot be removed when it is misbehaving, which is when somebody wants to.
 */
export async function uninstallPlugin(pluginId: string): Promise<{ ok: boolean; why?: string }> {
  const record = await pluginsRepo.getInstalledPlugin(pluginId);
  if (!record) return { ok: false, why: 'That Plugin is not installed.' };

  const mine = capabilitiesOf(record);
  for (const capability of mine) unregisterCapability(capability.id);
  try {
    await pluginsRepo.removeInstalledPlugin(pluginId);
  } catch (error) {
    /*
      The record is still there, so the Plugin is still installed, and
      leaving its capabilities unregistered would make it installed and
      permanently uncallable until somebody restarted the process. Put them
      back and say what happened.
    */
    for (const capability of mine) registerCapability(capability);
    return { ok: false, why: `${record.manifest.name} could not be removed: ${(error as Error).message}` };
  }
  return { ok: true };
}


/** Register every installed Plugin's capabilities. Called at bootstrap. */
export async function registerInstalledPlugins(): Promise<{ registered: number; skipped: string[] }> {
  const installed = await pluginsRepo.listInstalledPlugins();
  const skipped: string[] = [];
  let registered = 0;
  for (const record of installed) {
    const fits = pluginRuns(record.manifest.compatibility, buildVersion().version);
    if (!fits.ok) {
      // Kept installed and not registered. An owner who upgraded past what a
      // Plugin supports should see it say so rather than find it missing.
      skipped.push(`${record.id}: ${fits.why}`);
      continue;
    }
    for (const capability of capabilitiesOf(record)) {
      registerCapability(capability);
      registered += 1;
    }
  }
  return { registered, skipped };
}

/** The registry address an owner configured, or null. */
export async function registryUrl(): Promise<string | null> {
  const stored = await ops.getSetting<string>(REGISTRY_URL_KEY);
  return stored?.trim() || null;
}

/** How many capabilities the model may currently choose. For diagnostics. */
export function modelCallableCount(): number {
  return listModelCallable().length;
}
