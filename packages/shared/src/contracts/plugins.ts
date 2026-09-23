import { z } from 'zod';
import {
  CAPABILITY_CATEGORIES,
  CAPABILITY_EFFECTS,
  CAPABILITY_PERMISSIONS,
  CAPABILITY_RISKS,
  CAPABILITY_STATUSES,
} from './capabilities';

/**
 * Plugins, which are what an owner calls the thing a capability belongs to.
 *
 * ## A product layer, not a second engine
 *
 * Everything an agent can actually do is a capability: a typed input, a typed
 * output, a permission, a readiness answer and an audit row, invoked through
 * `invokeCapability` and nothing else. That does not change here and must not.
 * A Plugin is the unit an owner installs, enables, configures and trusts, and
 * it owns no execution of its own.
 *
 * The same reasoning `toolpacks.ts` gives for a pack applies with more force to
 * a Plugin, because a Plugin can arrive from somewhere else: there is exactly
 * one place a decision about what an agent may do lives, and it is
 * `agent_capability_permissions`. A Plugin's enabled state is *computed* from
 * the permissions of the capabilities it contributes, and enabling one writes
 * those permissions. Two sources of truth about what an agent may do is how
 * something ends up allowed on one screen and refused by another.
 *
 * ## Why a built-in Plugin is a toolpack
 *
 * The six toolpacks already group the built-in capabilities the way somebody
 * would ask for them, and they are already a projection over permissions. A
 * built-in Plugin is that pack presented as a Plugin, not a copy of it. The
 * seventy-three capabilities are registered once.
 *
 * ## Why an installed Plugin declares rather than ships code
 *
 * A Plugin obtained from somewhere else does not get to run arbitrary
 * JavaScript inside this process. There is no `eval`, no dynamic import of
 * downloaded text, no `vm` pretending to be a sandbox and no postinstall
 * script. What an installed Plugin may do is *declare* a bounded operation:
 * typed input, typed output, one HTTP method, an allowlist of hosts, an
 * optional credential slot, a timeout and a quota. The canonical bounded
 * network layer executes that declaration, so a Plugin cannot reach the
 * filesystem, the Chrome profile, the X cookies, the master key, another
 * agent's memories or a host it did not declare.
 *
 * That is a deliberately small extension model. It is small because the
 * alternative is a marketplace for remote code execution on somebody's own
 * machine, holding their signed-in browser and their provider keys.
 */

/** Where a Plugin came from, which decides what may be trusted about it. */
export const PLUGIN_SOURCES = ['BUILT_IN', 'LOCAL', 'AI17Z_REGISTRY'] as const;
export type PluginSource = (typeof PLUGIN_SOURCES)[number];

/**
 * What kind of thing a Plugin contributes.
 *
 * `CAPABILITY_PACK` is a built-in family. `HTTP_CAPABILITY` is the declarative
 * remote operation above. `FEATURE` unlocks a module that already ships, and
 * unlocks nothing that does not: an entitlement cannot invent a feature.
 */
export const PLUGIN_KINDS = ['CAPABILITY_PACK', 'HTTP_CAPABILITY', 'FEATURE'] as const;
export type PluginKind = (typeof PLUGIN_KINDS)[number];

/** The manifest schema this build understands. Refused if it is not this. */
export const PLUGIN_MANIFEST_SCHEMA = 1;

/**
 * A host an installed Plugin is allowed to reach.
 *
 * A bare hostname, lowercase, no scheme, no path, no port and no wildcard. A
 * wildcard host is how an allowlist stops being one, and a path is not a
 * security boundary because it is chosen by whoever wrote the request.
 */
export const PluginHost = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(253)
  .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/, 'a bare hostname, such as api.example.com');

/**
 * One value an owner has to supply before a Plugin can work.
 *
 * `secret` decides where it is kept: a secret goes through the same sealed
 * store as a provider key and never appears in a response, a log, an audit row
 * or a package. Anything else is ordinary configuration and travels with the
 * agent.
 */
export const PluginConfigField = z
  .object({
    key: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(/^[a-z][a-z0-9_]*$/, 'a lower-case key, such as api_key'),
    label: z.string().trim().min(1).max(120),
    help: z.string().trim().max(400).default(''),
    secret: z.boolean().default(false),
    required: z.boolean().default(true),
  })
  .strict();
export type PluginConfigField = z.infer<typeof PluginConfigField>;

/**
 * A JSON shape, declared rather than compiled.
 *
 * Deliberately a small subset: objects of named fields with primitive types,
 * plus arrays of those. Enough to describe an API call and its answer, and not
 * enough to be a programming language. A Plugin that needs more than this
 * needs a capability written in the repository, reviewed like the other
 * seventy-three.
 */
export const PluginFieldType = z.enum(['string', 'number', 'boolean', 'string[]', 'number[]']);
export const PluginSchema = z
  .object({
    fields: z
      .array(
        z
          .object({
            name: z
              .string()
              .trim()
              .min(1)
              .max(64)
              .regex(/^[a-zA-Z][a-zA-Z0-9_]*$/),
            type: PluginFieldType,
            describe: z.string().trim().max(300).default(''),
            required: z.boolean().default(false),
            /** Where to read it from in the response, for outputs only. */
            from: z.string().trim().max(200).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(24),
  })
  .strict();
export type PluginSchema = z.infer<typeof PluginSchema>;

/**
 * The bounded remote operation an installed Plugin may declare.
 *
 * Everything here is a limit rather than a capability: the method is one of
 * two, the hosts are an allowlist, the timeout and the quota are ceilings, and
 * the credential is a slot the owner fills rather than a value the Plugin
 * carries. The request is built by the canonical layer from these, so a Plugin
 * cannot add a header, change the host, follow a redirect off the allowlist or
 * outlive its timeout.
 */
export const PluginHttpOperation = z
  .object({
    /** GET or POST. Nothing here may delete or replace anything remote. */
    method: z.enum(['GET', 'POST']),
    /**
     * The address, with `{field}` placeholders filled from validated input.
     *
     * Its host must be one of `hosts`, which is checked after substitution as
     * well as before it: a placeholder in the host position is how an allowlist
     * is defeated by an input value.
     */
    url: z.string().trim().min(8).max(500),
    hosts: z.array(PluginHost).min(1).max(8),
    /** Where the owner's credential goes, if the operation needs one. */
    auth: z
      .object({
        kind: z.enum(['BEARER', 'HEADER', 'QUERY']),
        /** Header or query parameter name. Ignored for BEARER. */
        name: z.string().trim().max(64).default(''),
        /** Which config field holds it. Must be a secret field. */
        configKey: z.string().trim().min(1).max(64),
      })
      .strict()
      .optional(),
    timeoutMs: z.number().int().min(1_000).max(30_000).default(10_000),
    /** Calls per hour, per agent. A ceiling the canonical layer enforces. */
    quotaPerHour: z.number().int().min(1).max(600).default(60),
  })
  .strict();
export type PluginHttpOperation = z.infer<typeof PluginHttpOperation>;

/**
 * A capability an installed Plugin contributes.
 *
 * The id is namespaced under the Plugin so two Plugins cannot collide and so
 * an audit row says where a capability came from without a join.
 */
export const PluginCapabilityDeclaration = z
  .object({
    /** The part after the Plugin id: `plugin.<pluginId>.<name>`. */
    name: z
      .string()
      .trim()
      .min(2)
      .max(48)
      .regex(/^[a-z][a-z0-9_]*$/, 'a lower-case name, such as read_forecast'),
    title: z.string().trim().min(2).max(120),
    description: z.string().trim().min(10).max(600),
    category: z.enum(CAPABILITY_CATEGORIES),
    /**
     * WRITE is refused for a declared Plugin in this schema version.
     *
     * A declarative HTTP call cannot be shown to be reversible, idempotent or
     * safe to retry by reading its manifest, and those are exactly the
     * properties the write path depends on. So an installed Plugin reads.
     */
    effect: z.literal('READ'),
    risk: z.enum(CAPABILITY_RISKS),
    input: PluginSchema,
    output: PluginSchema,
    http: PluginHttpOperation,
  })
  .strict();
export type PluginCapabilityDeclaration = z.infer<typeof PluginCapabilityDeclaration>;

/** A module that already ships, which an entitlement may switch on. */
export const PLUGIN_FEATURES = ['RESEARCH_SOURCE', 'OWNER_PANEL'] as const;
export type PluginFeature = (typeof PLUGIN_FEATURES)[number];

/**
 * A Plugin offering itself as somewhere the research step may look.
 *
 * The extension point is deliberately narrow. A research source is not a
 * second research engine and cannot reach the model, the prompt, the policy or
 * the browser: it names one of the Plugin's own declared capabilities, says
 * which input field takes the question and which output fields carry the
 * answer, and the runtime calls that capability through `invokeCapability`
 * like any other. So permission, readiness, the quota, the host allowlist, the
 * timeout and the audit row all apply unchanged, and an owner who turned the
 * Plugin off has turned the source off.
 *
 * Nothing here can make a finding look like knowledge. `sourceName` is
 * attributed in the prompt exactly as "Web search" and "DexScreener" are, and
 * what comes back is still evidence somebody else said a moment ago.
 */
export const PluginResearchSource = z
  .object({
    /** Which declared capability answers a lookup. Its `name`. */
    capability: z
      .string()
      .trim()
      .min(2)
      .max(48)
      .regex(/^[a-z][a-z0-9_]*$/),
    /** The input field the question goes into. Must be a required string. */
    queryField: z.string().trim().min(1).max(64),
    /** Output fields carrying the finding. `url` is optional. */
    title: z.string().trim().min(1).max(64),
    summary: z.string().trim().min(1).max(64),
    url: z.string().trim().min(1).max(64).optional(),
    /** How the source is named to the model, and on the owner's screen. */
    sourceName: z.string().trim().min(2).max(60),
  })
  .strict();
export type PluginResearchSource = z.infer<typeof PluginResearchSource>;

/**
 * One line of a Plugin's own panel, as data rather than as markup.
 *
 * A Plugin does not get to render. There is no HTML, no markdown, no template
 * and no script: a panel is a title, some sentences, a list of which of its
 * own capabilities to show recent runs for, and named links. AI17Z's existing
 * components draw it. That is the whole difference between an owner panel and
 * a cross-site scripting hole on a page holding somebody's provider keys.
 *
 * A link's host has to be one the Plugin declared or its own homepage, so a
 * panel cannot become a way of putting an arbitrary address in front of
 * somebody under a publisher's name.
 */
export const PluginOwnerPanel = z
  .object({
    title: z.string().trim().min(2).max(80),
    body: z.array(z.string().trim().min(1).max(400)).max(12).default([]),
    /** Declared capability names whose recent runs are worth showing. */
    showRuns: z
      .array(
        z
          .string()
          .trim()
          .min(2)
          .max(48)
          .regex(/^[a-z][a-z0-9_]*$/),
      )
      .max(8)
      .default([]),
    links: z
      .array(
        z
          .object({ label: z.string().trim().min(1).max(60), url: z.string().trim().url().max(300) })
          .strict(),
      )
      .max(6)
      .default([]),
  })
  .strict();
export type PluginOwnerPanel = z.infer<typeof PluginOwnerPanel>;

/**
 * The versioned manifest. `.strict()` throughout, so an unknown field is a
 * refusal rather than something silently ignored: a field this build does not
 * understand may be the one that mattered.
 */
export const PluginManifest = z
  .object({
    schemaVersion: z.literal(PLUGIN_MANIFEST_SCHEMA),
    id: z
      .string()
      .trim()
      .toLowerCase()
      .min(3)
      .max(64)
      .regex(/^[a-z][a-z0-9-]*[a-z0-9]$/, 'a lower-case id, such as open-meteo'),
    name: z.string().trim().min(2).max(120),
    summary: z.string().trim().min(10).max(300),
    publisher: z.string().trim().min(2).max(120),
    version: z.string().trim().regex(/^\d+\.\d+\.\d+$/, 'semver, such as 1.0.0'),
    /** The AI17Z versions this Plugin says it works with. */
    compatibility: z
      .object({
        minimum: z.string().trim().regex(/^\d+\.\d+\.\d+/),
        /** Exclusive. Absent means no declared upper bound. */
        below: z.string().trim().regex(/^\d+\.\d+\.\d+/).optional(),
      })
      .strict(),
    kind: z.enum(PLUGIN_KINDS),
    homepage: z.string().trim().url().max(300).optional(),
    config: z.array(PluginConfigField).max(8).default([]),
    capabilities: z.array(PluginCapabilityDeclaration).max(12).default([]),
    features: z.array(z.enum(PLUGIN_FEATURES)).max(4).default([]),
    /** Required by, and only allowed with, the RESEARCH_SOURCE feature. */
    research: PluginResearchSource.optional(),
    /** Required by, and only allowed with, the OWNER_PANEL feature. */
    panel: PluginOwnerPanel.optional(),
  })
  .strict()
  .superRefine((manifest, ctx) => {
    if (manifest.kind === 'HTTP_CAPABILITY' && manifest.capabilities.length === 0) {
      ctx.addIssue({ code: 'custom', message: 'an HTTP_CAPABILITY Plugin has to declare at least one capability' });
    }
    if (manifest.kind === 'FEATURE' && manifest.features.length === 0) {
      ctx.addIssue({ code: 'custom', message: 'a FEATURE Plugin has to declare at least one feature' });
    }

    const byName = new Map(manifest.capabilities.map((capability) => [capability.name, capability]));

    /*
      A feature and the block describing it travel together, in both
      directions. A feature named with nothing behind it is an entitlement
      that unlocks a blank; a block with no feature is configuration the
      runtime will never read. Both are a Plugin that looks like it does
      something it does not, which is the failure this whole schema is strict
      to avoid.
    */
    const wantsResearch = manifest.features.includes('RESEARCH_SOURCE');
    if (wantsResearch && !manifest.research) {
      ctx.addIssue({ code: 'custom', message: 'a RESEARCH_SOURCE Plugin has to say which capability answers a lookup' });
    }
    if (!wantsResearch && manifest.research) {
      ctx.addIssue({ code: 'custom', message: 'this declares a research source without declaring the RESEARCH_SOURCE feature' });
    }
    if (manifest.research) {
      const capability = byName.get(manifest.research.capability);
      if (!capability) {
        ctx.addIssue({ code: 'custom', message: `the research source names "${manifest.research.capability}", which it never declares` });
      } else {
        // The query field has to be a required string, or the first lookup
        // fails input validation and the source is a source of nothing.
        const query = capability.input.fields.find((field) => field.name === manifest.research!.queryField);
        if (!query) {
          ctx.addIssue({ code: 'custom', message: `the research source puts the question in "${manifest.research.queryField}", which ${capability.name} does not take` });
        } else if (query.type !== 'string' || !query.required) {
          ctx.addIssue({ code: 'custom', message: `"${manifest.research.queryField}" has to be a required string for a question to go in it` });
        }
        const outputs = new Set(capability.output.fields.map((field) => field.name));
        for (const [role, name] of [
          ['title', manifest.research.title],
          ['summary', manifest.research.summary],
          ['url', manifest.research.url],
        ] as const) {
          if (name && !outputs.has(name)) {
            ctx.addIssue({ code: 'custom', message: `the research source reads its ${role} from "${name}", which ${capability.name} does not return` });
          }
        }
      }
    }

    const wantsPanel = manifest.features.includes('OWNER_PANEL');
    if (wantsPanel && !manifest.panel) {
      ctx.addIssue({ code: 'custom', message: 'an OWNER_PANEL Plugin has to say what its panel shows' });
    }
    if (!wantsPanel && manifest.panel) {
      ctx.addIssue({ code: 'custom', message: 'this declares an owner panel without declaring the OWNER_PANEL feature' });
    }
    if (manifest.panel) {
      for (const name of manifest.panel.showRuns) {
        if (!byName.has(name)) {
          ctx.addIssue({ code: 'custom', message: `the panel shows runs of "${name}", which this Plugin never declares` });
        }
      }
      // A link may only point somewhere the Plugin already told the owner it
      // reaches. Otherwise a panel is a way of putting any address at all in
      // front of somebody under a publisher's name.
      const reachable = new Set(manifest.capabilities.flatMap((capability) => capability.http.hosts));
      if (manifest.homepage) {
        try {
          reachable.add(new URL(manifest.homepage).hostname.toLowerCase());
        } catch {
          // The homepage is already a validated URL, so this cannot happen.
        }
      }
      for (const link of manifest.panel.links) {
        let host: string | null = null;
        try {
          const parsed = new URL(link.url);
          host = parsed.protocol === 'https:' ? parsed.hostname.toLowerCase() : null;
        } catch {
          host = null;
        }
        if (!host) {
          ctx.addIssue({ code: 'custom', message: `the panel link "${link.label}" is not an https address` });
        } else if (!reachable.has(host)) {
          ctx.addIssue({ code: 'custom', message: `the panel link "${link.label}" points at ${host}, which this Plugin never declared` });
        }
      }
    }
    // A credential slot has to name a field that exists and is a secret,
    // because an auth value kept as ordinary configuration would travel in a
    // shared agent package.
    const secrets = new Set(manifest.config.filter((field) => field.secret).map((field) => field.key));
    const known = new Set(manifest.config.map((field) => field.key));
    for (const capability of manifest.capabilities) {
      const auth = capability.http.auth;
      if (!auth) continue;
      if (!known.has(auth.configKey)) {
        ctx.addIssue({ code: 'custom', message: `${capability.name} authenticates with "${auth.configKey}", which it never declares` });
      } else if (!secrets.has(auth.configKey)) {
        ctx.addIssue({ code: 'custom', message: `${capability.name} authenticates with "${auth.configKey}", which is not marked secret` });
      }
    }
    // Two capabilities with one name would register twice and audit as one.
    const names = manifest.capabilities.map((capability) => capability.name);
    if (new Set(names).size !== names.length) {
      ctx.addIssue({ code: 'custom', message: 'two capabilities share a name' });
    }
  });
export type PluginManifest = z.infer<typeof PluginManifest>;

/**
 * What an installed Plugin is recorded as, beside its manifest.
 *
 * The hash is of the manifest bytes as received, so what was approved and what
 * is running can be compared later. The publisher is recorded separately from
 * the manifest for the same reason: a later version arriving under a different
 * publisher is a substitution, not an update.
 */
export const InstalledPlugin = z
  .object({
    id: z.string(),
    source: z.enum(PLUGIN_SOURCES),
    version: z.string(),
    publisher: z.string(),
    manifestSha256: z.string().regex(/^[a-f0-9]{64}$/),
    manifest: PluginManifest,
    installedAt: z.string(),
    updatedAt: z.string(),
  })
  .strict();
export type InstalledPlugin = z.infer<typeof InstalledPlugin>;

/**
 * A Plugin as the interface sees it. Derived, never a row.
 *
 * The separate fields matter and must not be collapsed into one "active" word.
 * Registered is not available, available is not offered, offered is not
 * selected, selected is not executed, and executed is not used in an answer.
 * A screen that says "on" when the truth is "installed, enabled, and refused
 * every time because no credential is configured" is worse than no screen.
 */
export const PluginCapabilityView = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string(),
    category: z.enum(CAPABILITY_CATEGORIES),
    effect: z.enum(CAPABILITY_EFFECTS),
    risk: z.enum(CAPABILITY_RISKS),
    modelCallable: z.boolean(),
    permission: z.enum(CAPABILITY_PERMISSIONS),
    status: z.enum(CAPABILITY_STATUSES),
    why: z.string().optional(),
    lastUsedAt: z.string().nullable(),
    lastOutcome: z.string().nullable(),
  })
  .strict();
export type PluginCapabilityView = z.infer<typeof PluginCapabilityView>;

/** How the Plugin's own capabilities are set, taken together. */
export const PLUGIN_STATES = ['ON', 'OFF', 'MIXED', 'ASKS'] as const;
export type PluginState = (typeof PLUGIN_STATES)[number];

export const PluginView = z
  .object({
    id: z.string(),
    name: z.string(),
    summary: z.string(),
    publisher: z.string(),
    source: z.enum(PLUGIN_SOURCES),
    kind: z.enum(PLUGIN_KINDS),
    /** Absent for a built-in, which is versioned with AI17Z itself. */
    version: z.string().nullable(),
    /** Set when the registry offers a newer one this build can run. */
    updateAvailable: z.string().nullable(),
    /** Whether this copy can be removed, as opposed to switched off. */
    removable: z.boolean(),
    state: z.enum(PLUGIN_STATES),
    capabilities: z.array(PluginCapabilityView),
    /** Hosts it may reach. Empty for a built-in, which is not declarative. */
    hosts: z.array(z.string()),
    /** Configuration the owner still owes, by label. */
    missingConfig: z.array(z.string()),
    /** Calls per hour across its capabilities, or null where not declared. */
    quotaPerHour: z.number().int().nullable(),
    /** What this agent has already spent of that, this hour. */
    callsThisHour: z.number().int().nullable(),
    lastUsedAt: z.string().nullable(),
    /**
     * What the owner has to fill in, and what they have filled in.
     *
     * Carried with the view so the configuration form is drawn from the same
     * answer the readiness line came from. A form fetched separately is a form
     * that can be describing a Plugin the card is no longer about.
     *
     * `config` holds only non-secret values. `secretsPresent` names which
     * secret keys are filled and never says what is in them.
     */
    configFields: z.array(PluginConfigField),
    config: z.record(z.string(), z.unknown()),
    secretsPresent: z.array(z.string()),
    /** Modules this Plugin unlocks, so the owner can see what it changes. */
    features: z.array(z.enum(PLUGIN_FEATURES)),
    /** Its declarative owner panel, when it has one. Data, never markup. */
    panel: PluginOwnerPanel.nullable(),
    /** How the research step names it, when it offers itself as a source. */
    researchSourceName: z.string().nullable(),
    /** Why the whole Plugin cannot work, when that is a Plugin-level fact. */
    why: z.string().optional(),
  })
  .strict();
export type PluginView = z.infer<typeof PluginView>;

/**
 * Whether this build will run a Plugin that asks for a version range.
 *
 * Compared on the release core only, so a beta of the right number is not
 * refused: an owner on a 1.0.0 beta is running 1.0.0 as far as a Plugin's
 * compatibility is concerned, and a Plugin cannot reasonably be asked to
 * enumerate prereleases.
 */
export function pluginRuns(
  compatibility: { minimum: string; below?: string },
  ai17zVersion: string,
): { ok: true } | { ok: false; why: string } {
  const core = (value: string) => {
    const [major = '0', minor = '0', patch = '0'] = value.replace(/^v/, '').split('-')[0]!.split('.');
    return [Number(major), Number(minor), Number(patch)] as const;
  };
  const compare = (a: readonly number[], b: readonly number[]) => {
    for (let at = 0; at < 3; at += 1) {
      const left = a[at] ?? 0;
      const right = b[at] ?? 0;
      if (left !== right) return left < right ? -1 : 1;
    }
    return 0;
  };
  const here = core(ai17zVersion);
  if (compare(here, core(compatibility.minimum)) < 0) {
    return { ok: false, why: `needs AI17Z ${compatibility.minimum} or newer, and this is ${ai17zVersion}` };
  }
  if (compatibility.below && compare(here, core(compatibility.below)) >= 0) {
    return { ok: false, why: `was made for AI17Z below ${compatibility.below}, and this is ${ai17zVersion}` };
  }
  return { ok: true };
}

/**
 * The id a declared capability is registered under.
 *
 * `plugin_<id>.<name>`, which is two segments because the registry's ids are
 * `family.verb_noun` and the family is what the shortlister groups by. Giving
 * each Plugin its own family is the point: a Plugin's capabilities are offered
 * or not offered together, the way a built-in family is, rather than every
 * Plugin in the world sharing one.
 *
 * The `plugin_` prefix is reserved, so an installed Plugin can never claim a
 * built-in family such as `x` or `time`. Hyphens become underscores because
 * the registry's id shape has no hyphen in it, and a Plugin id cannot contain
 * an underscore, so the mapping is reversible.
 */
export function pluginCapabilityId(pluginId: string, name: string): string {
  return `plugin_${pluginId.replace(/-/g, '_')}.${name}`;
}

/** Whether a capability id belongs to an installed Plugin, and to which. */
export function pluginOfCapability(capabilityId: string): string | null {
  const match = /^plugin_([a-z][a-z0-9_]*)\./.exec(capabilityId);
  return match ? match[1]!.replace(/_/g, '-') : null;
}

/** The registry family a Plugin's capabilities share. */
export function pluginFamily(pluginId: string): string {
  return `plugin_${pluginId.replace(/-/g, '_')}`;
}

/**
 * Order two Plugin versions.
 *
 * Numeric per part, because a string comparison calls 1.10.0 older than
 * 1.9.0, and an update check that gets that backwards offers a downgrade as
 * an upgrade for ever.
 */
export function comparePluginVersions(a: string, b: string): -1 | 0 | 1 {
  const parts = (value: string) => value.split('.').map((piece) => Number.parseInt(piece, 10) || 0);
  const left = parts(a);
  const right = parts(b);
  for (let at = 0; at < 3; at += 1) {
    const one = left[at] ?? 0;
    const other = right[at] ?? 0;
    if (one !== other) return one < other ? -1 : 1;
  }
  return 0;
}

/**
 * What a Plugin is asking to be allowed to do, as a set of comparable facts.
 *
 * Used to answer one question on an update: is this version asking for more
 * than the one the owner approved? A manifest is the whole of what an
 * installed Plugin may do, so the footprint is read straight off it rather
 * than derived from anything that could have drifted.
 */
export interface PluginFootprint {
  hosts: string[];
  capabilities: string[];
  features: PluginFeature[];
  /** Effects declared. `READ` only in schema v1, and checked rather than assumed. */
  effects: string[];
  risks: string[];
  /** Whether it wants a credential from the owner. */
  wantsSecret: boolean;
  /** The highest per-hour ceiling it declares. */
  quotaPerHour: number;
}

export function pluginFootprint(manifest: PluginManifest): PluginFootprint {
  return {
    hosts: [...new Set(manifest.capabilities.flatMap((capability) => capability.http.hosts))].sort(),
    capabilities: manifest.capabilities.map((capability) => capability.name).sort(),
    features: [...manifest.features].sort(),
    effects: [...new Set(manifest.capabilities.map((capability) => capability.effect))].sort(),
    risks: [...new Set(manifest.capabilities.map((capability) => capability.risk))].sort(),
    wantsSecret: manifest.config.some((field) => field.secret),
    quotaPerHour: manifest.capabilities.reduce((most, capability) => Math.max(most, capability.http.quotaPerHour), 0),
  };
}

/**
 * What a new version is asking for that the approved one did not.
 *
 * Said in sentences rather than as a diff, because this is put in front of
 * somebody who has to decide. An update that asks for nothing new returns an
 * empty list and goes through without a question: the owner already answered
 * it. An update that asks for more has to be answered again, because approval
 * was given for what the last manifest said and this one says something else.
 *
 * Narrowing is not an expansion and is deliberately silent. A Plugin dropping
 * a host or a capability needs no permission to do less.
 */
export function footprintExpansion(before: PluginFootprint, after: PluginFootprint): string[] {
  const grew: string[] = [];
  const added = <T>(was: readonly T[], now: readonly T[]) => now.filter((entry) => !was.includes(entry));

  const hosts = added(before.hosts, after.hosts);
  if (hosts.length > 0) grew.push(`It wants to reach ${hosts.join(', ')}, which the installed version does not.`);

  const capabilities = added(before.capabilities, after.capabilities);
  if (capabilities.length > 0) grew.push(`It adds ${capabilities.join(', ')}.`);

  const features = added(before.features, after.features);
  if (features.length > 0) {
    grew.push(
      `It asks to unlock ${features
        .map((feature) => (feature === 'RESEARCH_SOURCE' ? 'being used as a research source' : 'its own owner panel'))
        .join(' and ')}.`,
    );
  }

  const effects = added(before.effects, after.effects);
  if (effects.length > 0) grew.push(`It declares ${effects.join(', ')}, where the installed version only reads.`);

  const risks = added(before.risks, after.risks);
  if (risks.length > 0) grew.push(`It declares ${risks.join(', ')} risk, which the installed version does not.`);

  if (after.wantsSecret && !before.wantsSecret) grew.push('It asks for a credential, which the installed version does not.');

  if (after.quotaPerHour > before.quotaPerHour) {
    grew.push(`It raises its own ceiling from ${before.quotaPerHour} to ${after.quotaPerHour} calls an hour.`);
  }

  return grew;
}
