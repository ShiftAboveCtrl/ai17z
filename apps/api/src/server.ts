import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { createLogger, envString } from '@xbam/shared';
import { fail } from './http';
import { authRoutes } from './routes/auth';
import { healthRoutes } from './routes/health';
import { agentRoutes } from './routes/agents';
import { agentConfigRoutes } from './routes/agentConfig';
import { providerRoutes } from './routes/providers';
import { accountRoutes } from './routes/accounts';
import { sessionRoutes } from './routes/sessions';
import { jobRoutes } from './routes/jobs';
import { mockRoutes } from './routes/mock';
import { memoryRoutes } from './routes/memories';
import { artifactRoutes } from './routes/artifacts';
import { settingsRoutes } from './routes/settings';

const log = createLogger('api');

export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    bodyLimit: 8 * 1024 * 1024,
    trustProxy: false,
  });

  const origins = envString('XBAM_CORS_ORIGINS', 'http://localhost:5173,http://localhost:8080')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  await app.register(cors, {
    origin: origins.length > 0 ? origins : false,
    credentials: false,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  });

  // One error shape for the whole API, including routing and parse errors.
  app.setErrorHandler((error, _request, reply) => fail(reply, error));
  app.setNotFoundHandler((request, reply) =>
    reply.status(404).send({
      ok: false,
      error: { code: 'NOT_FOUND', message: `No route for ${request.method} ${request.url}` },
    }),
  );

  await app.register(healthRoutes);
  await app.register(authRoutes);
  await app.register(agentRoutes);
  await app.register(agentConfigRoutes);
  await app.register(providerRoutes);
  await app.register(accountRoutes);
  await app.register(sessionRoutes);
  await app.register(jobRoutes);
  await app.register(mockRoutes);
  await app.register(memoryRoutes);
  await app.register(artifactRoutes);
  await app.register(settingsRoutes);

  app.addHook('onResponse', async (request, reply) => {
    if (reply.statusCode >= 500) {
      log.warn('request failed', { method: request.method, url: request.url, status: reply.statusCode });
    }
  });

  return app;
}
