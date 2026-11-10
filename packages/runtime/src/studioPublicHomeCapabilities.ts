import { z } from 'zod';
import { defineCapability, registerCapability, type AnyCapability } from '@xbam/tools';
import { PublicHomeChoices, PublicHomeManifest, previewPublicHome, publishPublicHome, unpublishPublicHome } from './studioPublicHome';

const common = { category: 'ACCOUNT' as const, risk: 'HIGH' as const, unsetPermission: 'DISABLED' as const,
  audience: 'OWNER' as const, modelCallable: true, timeoutMs: 30_000,
  readiness: async () => ({ status: 'AVAILABLE' as const }) };
const preview = defineCapability({ ...common, id: 'studio_home.preview', name: 'Preview my public home', effect: 'READ',
  description: 'Show the owner the exact public-home manifest before they confirm publication. Nothing is published. Show all fields and the confirmation phrase.',
  input: PublicHomeChoices, output: z.object({ manifest: PublicHomeManifest, digest: z.string(), expiresAt: z.string(), note: z.string(), confirmPhrase: z.string() }),
  async run(choices, ctx) {
    const result = await previewPublicHome({ agentId: ctx.agentId, ownerId: ctx.origin?.ownerId ?? '', choices });
    return { ...result, confirmPhrase: `publish home ${result.digest}` };
  },
});
const publish = defineCapability({ ...common, id: 'studio_home.publish', name: 'Publish my public home', effect: 'WRITE',
  description: 'Publish only the exact preview whose full digest the owner confirms with publish home <digest> in their own message. Never infer confirmation.',
  input: z.object({ digest: z.string().regex(/^[0-9a-f]{64}$/) }).strict(), output: z.object({ ok: z.boolean(), statement: z.string() }),
  async run(input, ctx) {
    const phrase = `publish home ${input.digest}`;
    const confirmed = (ctx.origin?.text ?? '').toLowerCase().trim() === phrase;
    const result = await publishPublicHome({ agentId: ctx.agentId, ownerId: ctx.origin?.ownerId ?? '', digest: input.digest, confirmed });
    return { ok: result.ok, statement: result.ok ? `Published. ${result.url}` : result.why };
  },
});
const unpublish = defineCapability({ ...common, id: 'studio_home.unpublish', name: 'Unpublish my public home', effect: 'WRITE',
  description: 'Remove the public home only after the owner says unpublish home in their own message. Copies cannot be recalled.',
  input: z.object({}).strict(), output: z.object({ ok: z.boolean(), statement: z.string() }),
  async run(_input, ctx) {
    if ((ctx.origin?.text ?? '').toLowerCase().trim() !== 'unpublish home') return { ok: false, statement: 'The owner must say unpublish home. Copies cannot be recalled.' };
    const result = await unpublishPublicHome(ctx.agentId, ctx.origin?.ownerId ?? '');
    return { ok: result.ok, statement: result.ok ? 'Unpublished. Copies cannot be recalled.' : result.why };
  },
});
export const STUDIO_HOME_CAPABILITIES = [preview, publish, unpublish] as unknown as AnyCapability[];
export function registerStudioHomeCapabilities(): void { for (const capability of STUDIO_HOME_CAPABILITIES) registerCapability(capability); }
