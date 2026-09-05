import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { ForbiddenError, NotFoundError, envString } from '@xbam/shared';
import { ops } from '@xbam/database';
import { handler, params, requireUser } from '../http';

function storageRoot(): string {
  return resolve(envString('AI17Z_STORAGE_DIR', './storage'));
}

/**
 * Serves stored artifacts (failure screenshots, uploaded portraits).
 *
 * Files are addressed by database id, never by client-supplied path, and the
 * resolved path is re-checked against the storage root so a stored value can
 * never escape it.
 */
export async function artifactRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    '/api/artifacts/:id',
    handler(async (request, reply) => {
      await requireUser(request);
      const artifact = await ops.getArtifact(params(request).id!);
      if (!artifact) throw new NotFoundError('Artifact');

      const root = storageRoot();
      const absolute = resolve(root, artifact.relPath);
      if (absolute !== root && !absolute.startsWith(root + sep)) {
        throw new ForbiddenError('That artifact path is outside the storage directory.');
      }
      const info = await stat(absolute).catch(() => null);
      if (!info?.isFile()) throw new NotFoundError('Artifact file');

      reply.header('content-type', artifact.mimeType);
      reply.header('content-length', String(info.size));
      reply.header('cache-control', 'private, max-age=3600');
      // This route serves bytes somebody uploaded, so the stored type is the
      // only type it may be treated as. Without nosniff a browser is free to
      // decide a file looks like HTML and run it -- on the origin holding the
      // session. The stored type is itself read from the file's own bytes at
      // upload, never from what the client said it was sending.
      reply.header('x-content-type-options', 'nosniff');
      // Belt and braces: nothing served here may execute or embed anything,
      // and it is never a frame.
      reply.header('content-security-policy', "default-src 'none'; sandbox");
      reply.header('content-disposition', 'inline');
      return reply.send(createReadStream(absolute));
    }),
  );

  app.get(
    '/api/diagnostics',
    handler(async (request) => {
      await requireUser(request);
      const query = (request.query ?? {}) as { jobId?: string; accountId?: string };
      return { items: await ops.listDiagnostics({ jobId: query.jobId, accountId: query.accountId, limit: 50 }) };
    }),
  );
}
