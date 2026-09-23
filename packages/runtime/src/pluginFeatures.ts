import { capabilityInvocations, plugins as pluginsRepo } from '@xbam/database';
import { buildVersion, pluginCapabilityId, pluginRuns } from '@xbam/shared';
import type { InstalledPlugin, PluginOwnerPanel } from '@xbam/shared/contracts';
import { invokeCapability } from '@xbam/tools';
import type { CapabilityPermission } from '@xbam/shared/contracts';
import type { Finding } from './research';

/**
 * The two things a Plugin may unlock, and the shape of both extension points.
 *
 * A feature is not a way in. Both of these are narrow, typed seams into
 * modules AI17Z already ships, and neither lets a Plugin run code, render
 * markup, reach a host it did not declare or step around a permission. An
 * entitlement cannot invent a feature: the list is closed, this file is the
 * whole of what the two members mean, and a manifest naming anything else is
 * refused before it is installed.
 *
 * ## A research source is a capability with a job
 *
 * `RESEARCH_SOURCE` does not give a Plugin a place in the research step. It
 * gives one of the Plugin's own declared capabilities a second way of being
 * called, through `invokeCapability` exactly as the model would call it. So
 * the permission the owner set applies, readiness applies, the hourly quota
 * applies, the host allowlist applies, the timeout applies and an audit row is
 * written. A Plugin that is switched off is a source that is switched off, and
 * nobody had to remember to check that anywhere.
 *
 * What comes back is a `Finding`, which is the same shape a web search and
 * DexScreener return, so it is attributed in the prompt as something a named
 * source said a moment ago rather than as something the agent knows. A source
 * that answers nothing is a recorded gap, like every other lookup that fails.
 *
 * ## An owner panel is data
 *
 * `OWNER_PANEL` contributes a title, some sentences, which of its own
 * capabilities to show recent runs for, and links whose hosts it already
 * declared. There is no HTML, no markdown, no template and no script, and the
 * page is drawn by AI17Z's own components. The manifest schema enforces all of
 * that, which is why this file only has to read it.
 */

/** A Plugin offering itself as a place the research step may look. */
export interface PluginResearchSourceHandle {
  pluginId: string;
  /** How it is attributed in the prompt. */
  sourceName: string;
  /** The canonical capability id it runs through. */
  capabilityId: string;
  /** Ask it one question. Empty means it had nothing, which is a gap. */
  lookUp(query: string): Promise<Finding[]>;
}

/** What the owner's screen needs to draw a Plugin's own panel. */
export interface PluginPanelView {
  pluginId: string;
  pluginName: string;
  panel: PluginOwnerPanel;
  /** The canonical capability ids whose runs the panel asks to show. */
  runsOf: string[];
}

/** Installed Plugins that this build is actually running. */
async function runnable(): Promise<InstalledPlugin[]> {
  const installed = await pluginsRepo.listInstalledPlugins();
  const version = buildVersion().version;
  // A Plugin the owner has upgraded past is installed and not registered, so
  // its feature is not available either. Offering a source backed by a
  // capability nothing registered would produce one refusal per lookup.
  return installed.filter((record) => pluginRuns(record.manifest.compatibility, version).ok);
}

/**
 * Every research source this agent may actually use, right now.
 *
 * The permission is read here as well as inside `invokeCapability`, for the
 * same reason the capability shortlister reads it: there is no point building
 * a source, putting it in front of the research step and spending a lookup on
 * it only to be told no. The authoritative refusal is still the one inside the
 * invocation, which is the one that cannot be skipped.
 */
export async function pluginResearchSources(input: {
  agentId: string;
  jobId: string | null;
  accountId: string | null;
  permissions: Map<string, CapabilityPermission | null>;
  paused: boolean;
  logger: unknown;
}): Promise<PluginResearchSourceHandle[]> {
  const handles: PluginResearchSourceHandle[] = [];

  for (const record of await runnable()) {
    const declared = record.manifest.research;
    if (!declared || !record.manifest.features.includes('RESEARCH_SOURCE')) continue;

    const capabilityId = pluginCapabilityId(record.id, declared.capability);
    const stored = input.permissions.get(capabilityId) ?? null;
    if (stored === 'DISABLED') continue;
    /*
      OWNER_APPROVAL is skipped rather than held.

      A lookup happens inside a reply that is being written now, and there is
      nobody to ask. Holding one would stall the whole pipeline behind a
      question the owner will read tomorrow, which the research step's own
      budget would then abandon as a timeout -- reported as "the lookup took
      too long", which is not what happened. Skipped and recorded as a gap is
      the truth, and the owner can move it to Allowed.
    */
    if (stored === 'OWNER_APPROVAL') continue;

    handles.push({
      pluginId: record.id,
      sourceName: declared.sourceName,
      capabilityId,
      lookUp: async (query: string) => {
        const result = await invokeCapability({
          call: { id: capabilityId, input: { [declared.queryField]: query } },
          context: {
            agentId: input.agentId,
            jobId: input.jobId,
            accountId: input.accountId,
            config: {},
            logger: input.logger as never,
          },
          permission: { stored, paused: input.paused },
        });

        /*
          Recorded, exactly as the capability loop records a call the model
          made.

          A capability reached the network on this agent's behalf, and "what
          has this Plugin done" has one answer wherever the call came from. It
          was not recorded at all when this was written, so a research source
          was the one path out of this process with no audit row, which is the
          property the whole feature rests on not being true. Written before
          the finding is returned, so a crash between the two leaves evidence
          that it happened rather than evidence that it did not.

          A failed audit write does not lose the lookup, for the same reason it
          does not fail a job in the loop, and is logged for the same reason.
        */
        await capabilityInvocations
          .recordInvocation({
            agentId: input.agentId,
            jobId: input.jobId,
            accountId: input.accountId,
            capabilityId,
            step: 0,
            outcome: result.outcome,
            detail: result.detail,
            input: result.input,
            output: result.output,
            durationMs: result.durationMs,
          })
          .catch(() => undefined);

        if (result.outcome !== 'SUCCEEDED' || !result.output) return [];

        const answer = result.output as Record<string, unknown>;
        const text = (name: string | undefined) => {
          if (!name) return null;
          const value = answer[name];
          return value === undefined || value === null ? null : String(value);
        };
        const title = text(declared.title);
        const summary = text(declared.summary);
        // A source that answered with neither a title nor a summary answered
        // nothing usable, and an empty finding in the prompt is worse than a
        // recorded gap: the model treats a heading with no content as a fact
        // it failed to read properly.
        if (!title && !summary) return [];

        return [
          {
            kind: 'search' as const,
            query,
            source: declared.sourceName,
            title: title ?? query,
            summary: summary ?? '',
            url: text(declared.url),
            retrievedAt: new Date().toISOString(),
          },
        ];
      },
    });
  }

  return handles;
}

/** Every Plugin panel an owner may see, in installation order. */
export async function pluginPanels(): Promise<PluginPanelView[]> {
  const panels: PluginPanelView[] = [];
  for (const record of await runnable()) {
    const panel = record.manifest.panel;
    if (!panel || !record.manifest.features.includes('OWNER_PANEL')) continue;
    panels.push({
      pluginId: record.id,
      pluginName: record.manifest.name,
      panel,
      runsOf: panel.showRuns.map((name) => pluginCapabilityId(record.id, name)),
    });
  }
  return panels;
}
