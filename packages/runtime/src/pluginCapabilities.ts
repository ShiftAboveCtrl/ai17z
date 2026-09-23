import { z } from 'zod';
import { plugins as pluginsRepo } from '@xbam/database';
import { pluginCapabilityId } from '@xbam/shared';
import type {
  InstalledPlugin,
  PluginCapabilityDeclaration,
  PluginManifest,
  PluginSchema,
} from '@xbam/shared/contracts';
import { safeFetch } from '@xbam/upstream';
import { defineCapability, type AnyCapability } from '@xbam/tools';

/**
 * Turning a Plugin's declaration into a real capability.
 *
 * This is the whole of what an installed Plugin may do, and the shape of it is
 * the security argument. A Plugin does not ship code and none is downloaded:
 * it declares a typed input, a typed output, one of two HTTP methods, an
 * allowlist of hosts, an optional credential slot, a timeout and an hourly
 * quota. Everything below builds a request from that declaration and refuses
 * anything the declaration did not describe.
 *
 * What a Plugin therefore cannot reach, by construction rather than by a check
 * somebody remembered: the filesystem, a shell, the Chrome profile, the X
 * cookies, the master key, a provider credential, another agent's memories,
 * the database beyond its own configuration, or a host it did not declare.
 *
 * ### The allowlist is checked twice
 *
 * Once on the address built from validated input, because a placeholder in the
 * host position is how an allowlist is defeated by an input value. And once on
 * the address that actually answered, because `safeFetch` re-judges redirects
 * for private addresses but has no opinion about which public host a Plugin
 * was allowed to talk to. A public redirect to another public host is exactly
 * the hop that would otherwise escape the declaration.
 *
 * ### The credential is fetched at the moment it is used
 *
 * Opened from the sealed store when the request is built and put straight into
 * a header, never returned, logged, audited or carried anywhere else. The
 * declaration names which configuration field holds it, and the manifest
 * refuses to validate unless that field is marked secret.
 */

/** A zod object built from a declared schema. Primitives and arrays only. */
function schemaOf(schema: PluginSchema): z.ZodType<Record<string, unknown>> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const field of schema.fields) {
    const base =
      field.type === 'string'
        ? z.string().max(2_000)
        : field.type === 'number'
          ? z.number()
          : field.type === 'boolean'
            ? z.boolean()
            : field.type === 'string[]'
              ? z.array(z.string().max(2_000)).max(100)
              : z.array(z.number()).max(100);
    const described = field.describe ? base.describe(field.describe) : base;
    shape[field.name] = field.required ? described : described.optional();
  }
  return z.object(shape).strict();
}

/** Pull one value out of a JSON body by a dotted path, or undefined. */
function at(body: unknown, path: string): unknown {
  let here: unknown = body;
  for (const step of path.split('.')) {
    if (here === null || here === undefined) return undefined;
    if (/^\d+$/.test(step)) here = Array.isArray(here) ? here[Number(step)] : undefined;
    else here = typeof here === 'object' ? (here as Record<string, unknown>)[step] : undefined;
  }
  return here;
}

/**
 * Fill `{field}` placeholders from validated input.
 *
 * Encoded on the way in, so a value cannot add a query parameter, a path
 * segment or a second host. A placeholder naming a field the input does not
 * have is a refusal rather than an empty string: a URL with a hole in it is
 * not the URL that was approved.
 */
function fillUrl(template: string, input: Record<string, unknown>): string {
  return template.replace(/\{([a-zA-Z][a-zA-Z0-9_]*)\}/g, (_whole, name: string) => {
    const value = input[name];
    if (value === undefined || value === null) {
      throw new Error(`this Plugin's address needs "${name}", and the request did not have it`);
    }
    return encodeURIComponent(Array.isArray(value) ? value.join(',') : String(value));
  });
}

/** Whether a URL's host is one the Plugin declared. Exact match, no wildcards. */
function hostAllowed(url: string, hosts: readonly string[]): boolean {
  try {
    return hosts.includes(new URL(url).hostname.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * The capability a declaration becomes.
 *
 * Registered under `plugin.<pluginId>.<name>` so two Plugins cannot collide
 * and so an audit row says where the capability came from without a join.
 */
export function declaredCapability(
  installed: Pick<InstalledPlugin, 'id' | 'manifest'>,
  declaration: PluginCapabilityDeclaration,
): AnyCapability {
  const manifest: PluginManifest = installed.manifest;
  const id = pluginCapabilityId(installed.id, declaration.name);
  const input = schemaOf(declaration.input);
  const output = schemaOf(declaration.output);
  const required = manifest.config.filter((field) => field.required);

  return defineCapability({
    id,
    name: declaration.title,
    description: declaration.description,
    category: declaration.category,
    effect: declaration.effect,
    risk: declaration.risk,
    input,
    output,
    modelCallable: true,
    timeoutMs: declaration.http.timeoutMs,

    /**
     * Whether it can run, which for a Plugin is mostly about configuration.
     *
     * A Plugin whose credential the owner has not supplied is UNAVAILABLE and
     * says which value is missing. It is deliberately not DISABLED: nobody
     * turned it off, it simply cannot work yet, and telling an owner it is off
     * would send them to the wrong screen.
     */
    async readiness(ctx) {
      const config = await pluginsRepo.getPluginConfig(ctx.agentId, installed.id);
      const secrets = new Set(await pluginsRepo.pluginSecretKeys(ctx.agentId, installed.id));
      const missing = required
        .filter((field) => (field.secret ? !secrets.has(field.key) : config[field.key] === undefined))
        .map((field) => field.label);
      if (missing.length > 0) {
        return {
          status: 'UNAVAILABLE',
          why: `${manifest.name} still needs ${missing.join(' and ')} before it can run.`,
        };
      }
      const used = await pluginsRepo.pluginCallsThisHour(ctx.agentId, installed.id);
      if (used >= declaration.http.quotaPerHour) {
        return {
          status: 'DEGRADED',
          // When it works again, not only that it stopped. A ceiling reported
          // without its horizon reads like a fault, and the model is about to
          // be told this and has to decide whether to say so.
          why: `${manifest.name} has used its ${declaration.http.quotaPerHour} calls for this hour. It will work again next hour.`,
        };
      }
      return { status: 'AVAILABLE' };
    },

    async run(raw, ctx) {
      const given = raw as Record<string, unknown>;

      // The quota, charged before the request rather than after it, because a
      // ceiling that only counts what succeeded is not a ceiling.
      const charge = await pluginsRepo.chargePluginCall(ctx.agentId, installed.id, declaration.http.quotaPerHour);
      if (!charge.allowed) {
        throw new Error(
          `${manifest.name} has used its ${declaration.http.quotaPerHour} calls for this hour. It will work again next hour.`,
        );
      }

      const url = fillUrl(declaration.http.url, given);
      if (!hostAllowed(url, declaration.http.hosts)) {
        // Reached only if a placeholder sat in the host position, which the
        // manifest allows to be written and this refuses to send.
        throw new Error(`${manifest.name} tried to reach a host it did not declare.`);
      }

      const headers: Record<string, string> = { accept: 'application/json' };
      let target = url;
      const auth = declaration.http.auth;
      if (auth) {
        const secret = await pluginsRepo.getDecryptedPluginSecret(ctx.agentId, installed.id, auth.configKey);
        if (!secret) {
          const field = manifest.config.find((entry) => entry.key === auth.configKey);
          throw new Error(`${manifest.name} needs ${field?.label ?? auth.configKey} before it can run.`);
        }
        if (auth.kind === 'BEARER') headers.authorization = `Bearer ${secret}`;
        else if (auth.kind === 'HEADER') headers[auth.name.toLowerCase()] = secret;
        else {
          const withKey = new URL(target);
          withKey.searchParams.set(auth.name, secret);
          target = withKey.toString();
        }
      }

      const response = await safeFetch(target, {
        signal: ctx.signal,
        method: declaration.http.method,
        headers,
        // Small on purpose. A declared Plugin answers a question; anything
        // that needs megabytes is not this extension point.
        maxBytes: 512 * 1024,
      });

      // The address that actually answered. `safeFetch` has already refused a
      // redirect to a private address; this refuses one to a public host the
      // Plugin never declared.
      if (!hostAllowed(response.url, declaration.http.hosts)) {
        throw new Error(`${manifest.name} was redirected to a host it did not declare, so nothing was read.`);
      }
      if (response.status < 200 || response.status >= 300) {
        throw new Error(`${manifest.name} answered ${response.status}.`);
      }

      let body: unknown;
      try {
        body = JSON.parse(response.text);
      } catch {
        throw new Error(`${manifest.name} answered with something that is not JSON.`);
      }

      // Mapped by the declaration's own paths, so the Plugin decides what its
      // answer means and the schema decides whether that is well formed.
      const mapped: Record<string, unknown> = {};
      for (const field of declaration.output.fields) {
        const value = at(body, field.from ?? field.name);
        if (value !== undefined) mapped[field.name] = value;
      }
      return output.parse(mapped);
    },
  }) as unknown as AnyCapability;
}

/** Every capability an installed Plugin contributes. */
export function capabilitiesOf(installed: Pick<InstalledPlugin, 'id' | 'manifest'>): AnyCapability[] {
  return installed.manifest.capabilities.map((declaration) => declaredCapability(installed, declaration));
}
