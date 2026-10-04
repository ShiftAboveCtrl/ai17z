import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { hosting } from '@xbam/database';
import {
  PROVIDER_TIERS,
  PROVIDER_TIERS_ENABLED,
  TIER_REQUIREMENTS,
  runtimeMayAct,
  tierMayHoldTenants,
} from '@xbam/shared/contracts';
import {
  CAPACITY_CAVEATS,
  HOST_HEADROOM,
  HEARTBEAT_STALE_AFTER_SEC,
  MANDATORY_DENIALS,
  MICROVM_CAVEATS,
  OPERATOR_DENIED_BY_DEFAULT,
  PROVISIONING_STEPS,
  SHARED_DATABASE_REFUSAL,
  carriesSecret,
  custodyFor,
  thumbprintOf,
  isCleanHealth,
  judgeRuntimeHealth,
  lifecycleAction,
  mayProvisionAnother,
  ownerOptionsFor,
  placeRuntime,
  spendPermissionFor,
  tenantDatabaseName,
  type CapacityEntitlement,
  type HostForScheduling,
  type RuntimeHealth,
} from '@xbam/runtime';
import { handler, params, parseBody, requireUser } from '../http';

/**
 * The operator's view of hosted runtimes, and the one place a host is enrolled.
 *
 * Hosted mode is in development, so these exist to be operated by the person
 * running the installation rather than by a customer: a customer's own screens
 * reach their runtime through the tenant gateway, which never takes a runtime
 * id from a client. Nothing here is a shop, nothing here takes a payment, and
 * nothing here is reachable without a signed-in owner.
 *
 * Three rules this file holds and the runtime cannot hold for it.
 *
 * **A host enrols; it is never trusted on arrival.** `offerHost` records a
 * public key and leaves the node `PENDING_ENROLMENT`, and enrolling is a
 * separate act by a person. There is no route that accepts a host's own claim
 * to be approved, and a revoked key is never re-enrolled.
 *
 * **No response carries a secret.** Every payload goes through `carriesSecret`
 * before it leaves, because the failure here is a field somebody adds later
 * rather than one somebody writes today. A grant token is the single
 * exception: it is returned exactly once, by the route that mints it, which is
 * why that response is assembled field by field instead.
 *
 * **Nothing here deletes a customer's runtime.** The lifecycle refuses to
 * return a deletion and these routes offer no way around it.
 *
 * Placement exists now that a runtime class is a row and `host_reservations`
 * sums what each host has set aside. It did not before, because the only thing
 * recorded was a class name, and multiplying a count by an assumed class would
 * produce refusals and acceptances nobody could explain. A host whose sum has
 * a hole in it, meaning a runtime created under a class nobody recorded, is
 * refused rather than placed against optimistically.
 */

const Tier = z.enum(PROVIDER_TIERS);

/**
 * Enough of a JWK to take a stable thumbprint over, and a public key only.
 *
 * `.strict()` is not used because a JWK legitimately carries other members,
 * but `d` is refused outright: that field is the private key, and a host that
 * sent one has sent a secret to the control plane.
 */
const PublicKeyJwk = z
  .object({
    kty: z.enum(['EC', 'RSA']),
    crv: z.string().trim().max(32).optional(),
    x: z.string().trim().max(512).optional(),
    y: z.string().trim().max(512).optional(),
    n: z.string().trim().max(2048).optional(),
    e: z.string().trim().max(32).optional(),
  })
  .passthrough()
  .superRefine((jwk, ctx) => {
    if ('d' in jwk) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'That is a private key. A host enrols with its public key and nothing else.',
        path: ['d'],
      });
    }
    if (jwk.kty === 'EC' && !(jwk.crv && jwk.x && jwk.y)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'An EC key needs crv, x and y.', path: ['kty'] });
    }
    if (jwk.kty === 'RSA' && !(jwk.n && jwk.e)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'An RSA key needs n and e.', path: ['kty'] });
    }
  });

/**
 * Refuses to answer with anything key-shaped.
 *
 * Belt as well as braces: the repositories already select no secret column,
 * and this is what catches the column somebody adds in six months.
 */
function clean<T>(payload: T): T {
  const hit = carriesSecret(payload);
  if (hit.found) {
    throw new Error(`Refusing to answer: the payload carries something key-shaped at ${hit.where}.`);
  }
  return payload;
}

/** Seconds since a heartbeat, or null when there has never been one. */
function heartbeatAgeSec(at: string | null): number | null {
  if (!at) return null;
  const parsed = Date.parse(at);
  return Number.isFinite(parsed) ? Math.max(0, Math.round((Date.now() - parsed) / 1000)) : null;
}

export async function hostingRoutes(app: FastifyInstance): Promise<void> {
  /**
   * What hosting can and cannot do on this installation, in sentences.
   *
   * First because it is the honest front door: a tier that is not schedulable
   * says what it would have to prove, rather than appearing as an option that
   * fails later.
   */
  app.get(
    '/api/hosting/readiness',
    handler(async (request) => {
      await requireUser(request);
      return clean({
        tiers: PROVIDER_TIERS.map((tier) => ({
          tier,
          enabled: tierMayHoldTenants(tier),
          custody: custodyFor(tier),
          stillRequired: TIER_REQUIREMENTS[tier],
        })),
        enabledTiers: PROVIDER_TIERS_ENABLED,
        egressDenials: MANDATORY_DENIALS,
        provisioningSteps: PROVISIONING_STEPS.map((s) => ({ name: s.name, what: s.what })),
        operatorCannotReach: OPERATOR_DENIED_BY_DEFAULT,
        // On the readiness screen rather than buried in a document, because an
        // operator deciding what to put on a hosted runtime is exactly the
        // person who needs the uncomfortable version.
        caveats: [...MICROVM_CAVEATS, ...CAPACITY_CAVEATS, SHARED_DATABASE_REFUSAL],
      });
    }),
  );

  // -------------------------------------------------------------------------
  // Providers and hosts
  // -------------------------------------------------------------------------

  app.post(
    '/api/hosting/providers',
    handler(async (request) => {
      await requireUser(request);
      const body = parseBody(
        z.object({ label: z.string().trim().min(1).max(120), tier: Tier, notes: z.string().trim().max(2000).nullish() }),
        request,
      );
      if (!tierMayHoldTenants(body.tier)) {
        // Refused at the door with what it would have to prove, rather than
        // created and then silently never scheduled onto.
        throw new Error(
          `${body.tier} may not hold a tenant yet. Still required: ${TIER_REQUIREMENTS[body.tier].join(' ')}`,
        );
      }
      return clean(await hosting.createProvider(body));
    }),
  );

  app.get(
    '/api/hosting/hosts',
    handler(async (request) => {
      await requireUser(request);
      const [hosts, reservations] = await Promise.all([hosting.listHosts(), hosting.reservationsByHost()]);
      return clean({
        staleAfterSec: HEARTBEAT_STALE_AFTER_SEC,
        hosts: hosts.map((host) => {
          const age = heartbeatAgeSec(host.lastHeartbeatAt);
          return {
            id: host.id,
            providerId: host.providerId,
            label: host.label,
            state: host.state,
            region: host.region,
            agentVersion: host.agentVersion,
            capacity: host.capacity,
            keyThumbprint: host.keyThumbprint,
            enrolledAt: host.enrolledAt,
            revokedAt: host.revokedAt,
            revokedReason: host.revokedReason,
            heartbeatAgeSec: age,
            // Anything older than the bound is treated as not running whatever
            // the last snapshot said, which is the rule the local browser
            // heartbeat already uses.
            reporting: age !== null && age <= HEARTBEAT_STALE_AFTER_SEC,
            reserved: reservations.get(host.id) ?? { runtimes: 0, browserRuntimes: 0 },
          };
        }),
      });
    }),
  );

  /**
   * A host offers itself and waits.
   *
   * It submits a public key, which is the whole of its identity: there is no
   * shared bearer secret deployed to every node, because one leaked copy of
   * that is every node. The row lands `PENDING_ENROLMENT` and this route
   * cannot approve it.
   */
  app.post(
    '/api/hosting/hosts',
    handler(async (request) => {
      await requireUser(request);
      const body = parseBody(
        z.object({
          providerId: z.string().uuid(),
          label: z.string().trim().min(1).max(120),
          publicKeyJwk: PublicKeyJwk,
          region: z.string().trim().min(1).max(64).nullish(),
          agentVersion: z.string().trim().min(1).max(64).nullish(),
        }),
        request,
      );
      // Derived from the key rather than accepted alongside it. A host naming
      // its own thumbprint is the same mistake as a client naming its own
      // runtime: the identity would be whatever the caller said it was, and
      // the index that makes "the same key offering itself again is the same
      // host" true would be indexing a claim.
      const keyThumbprint = thumbprintOf(body.publicKeyJwk);
      return clean(await hosting.offerHost({ ...body, keyThumbprint }));
    }),
  );

  app.post(
    '/api/hosting/hosts/:id/enrol',
    handler(async (request) => {
      const user = await requireUser(request);
      const host = await hosting.enrolHost(params(request).id!, user.id);
      if (!host) {
        // The same answer for a host that does not exist and one whose key has
        // been revoked. A revoked key is refused from now on and cannot be
        // undone by the host.
        throw new Error('That host cannot be enrolled. A revoked key is never re-enrolled.');
      }
      return clean(host);
    }),
  );

  app.post(
    '/api/hosting/hosts/:id/drain',
    handler(async (request) => {
      await requireUser(request);
      const host = await hosting.drainHost(params(request).id!);
      if (!host) throw new Error('There is no such host.');
      return clean(host);
    }),
  );

  app.post(
    '/api/hosting/hosts/:id/revoke',
    handler(async (request) => {
      await requireUser(request);
      const body = parseBody(z.object({ reason: z.string().trim().min(5).max(500) }), request);
      const host = await hosting.revokeHost(params(request).id!, body.reason);
      if (!host) throw new Error('There is no such host.');
      // Its runtimes become unavailable rather than being reassigned: starting
      // a second copy of a runtime whose first copy may be alive and holding a
      // signed-in browser is worse than one that is down.
      const stranded = await hosting.strandRuntimesOf(host.id);
      return clean({ host, stranded, note: 'Its runtimes are unavailable, not reassigned.' });
    }),
  );

  // -------------------------------------------------------------------------
  // Tenants and runtimes
  // -------------------------------------------------------------------------

  app.post(
    '/api/hosting/tenants',
    handler(async (request) => {
      await requireUser(request);
      const body = parseBody(
        z.object({ accountRef: z.string().trim().min(1).max(200), label: z.string().trim().max(120).nullish() }),
        request,
      );
      return clean(await hosting.upsertTenant(body));
    }),
  );

  app.get(
    '/api/hosting/tenants/:id/runtimes',
    handler(async (request) => {
      await requireUser(request);
      const runtimes = await hosting.runtimesOfTenant(params(request).id!);
      return clean({
        runtimes: runtimes.map((runtime) => ({
          id: runtime.id,
          hostId: runtime.hostId,
          runtimeClass: runtime.runtimeClass,
          state: runtime.state,
          version: runtime.version,
          region: runtime.region,
          generation: runtime.generation,
          keyCustody: runtime.keyCustody,
          entitledUntil: runtime.entitledUntil,
          mayAct: runtimeMayAct(runtime.state),
          spend: spendPermissionFor(runtime.state),
          ownerOptions: ownerOptionsFor(runtime.state),
          // Derived rather than stored, for the same reason a browser profile
          // path is: a name written by one machine and read by another is a
          // second, empty thing that looks exactly like the first.
          database: tenantDatabaseName(runtime.id),
        })),
      });
    }),
  );

  /**
   * Provisions one runtime, bounded by the entitlement before it exists.
   *
   * The bound is checked here rather than reconciled afterwards, because a
   * reconciliation that finds an extra runtime has already given somebody a
   * machine, and taking it back means either a customer loses an agent they
   * were using or the business absorbs capacity it never sold.
   */
  app.post(
    '/api/hosting/tenants/:id/runtimes',
    handler(async (request) => {
      await requireUser(request);
      const tenantId = params(request).id!;
      const body = parseBody(
        z.object({
          runtimeClass: z.string().trim().min(1).max(64),
          version: z.string().trim().min(1).max(64),
          region: z.string().trim().min(1).max(64).nullish(),
          /** One provisioning per request, whatever a retry does. */
          provisionKey: z.string().trim().min(8).max(200),
          entitlement: z
            .object({
              runtimeClassId: z.string().trim().min(1).max(64),
              runtimes: z.number().int().min(0).max(10_000),
              browser: z.boolean(),
              coversUntil: z.string(),
              source: z.enum(['OPERATOR_GRANT', 'SIGNED_LEASE']),
            })
            .optional(),
        }),
        request,
      );

      if (body.entitlement) {
        const entitlement: CapacityEntitlement = { tenantId, ...body.entitlement };
        const existing = await hosting.runtimesOfTenant(tenantId);
        const verdict = mayProvisionAnother(entitlement, {
          runtimes: existing.map((r) => ({ runtimeClassId: r.runtimeClass, state: r.state, browser: false })),
        });
        if (!verdict.allowed) throw new Error(verdict.why);
      }

      return clean(
        await hosting.provisionRuntime({
          tenantId,
          runtimeClass: body.runtimeClass,
          version: body.version,
          region: body.region ?? null,
          provisionKey: body.provisionKey,
        }),
      );
    }),
  );

  app.get(
    '/api/hosting/runtimes/:id',
    handler(async (request) => {
      await requireUser(request);
      const runtime = await hosting.getRuntime(params(request).id!);
      if (!runtime) throw new Error('There is no such runtime.');
      const [grants, backups] = await Promise.all([
        hosting.grantsOfRuntime(runtime.id),
        hosting.backupsOfRuntime(runtime.id),
      ]);

      // What a host published, judged only if it is the shape a health record
      // is allowed to be. A record carrying prose or a field nobody allowed is
      // reported as refused rather than rendered.
      const published = runtime.health;
      const shape = isCleanHealth(published);
      const health = shape.ok
        ? { ok: true as const, verdict: judgeRuntimeHealth(published as unknown as RuntimeHealth) }
        : { ok: false as const, why: shape.why };

      return clean({
        runtime: {
          id: runtime.id,
          tenantId: runtime.tenantId,
          hostId: runtime.hostId,
          runtimeClass: runtime.runtimeClass,
          state: runtime.state,
          version: runtime.version,
          region: runtime.region,
          generation: runtime.generation,
          keyCustody: runtime.keyCustody,
          entitledUntil: runtime.entitledUntil,
          lastHealthAt: runtime.lastHealthAt,
          createdAt: runtime.createdAt,
          updatedAt: runtime.updatedAt,
        },
        mayAct: runtimeMayAct(runtime.state),
        spend: spendPermissionFor(runtime.state),
        ownerOptions: ownerOptionsFor(runtime.state),
        health,
        // What the lifecycle would do next, so an operator sees a suspension
        // coming rather than discovering it. It never returns a deletion.
        lifecycle: lifecycleAction({
          state: runtime.state,
          entitledUntil: runtime.entitledUntil,
          since: runtime.updatedAt,
        }),
        database: tenantDatabaseName(runtime.id),
        // Hashes and expiries only. The token existed once, at creation.
        grants: grants.map((grant) => ({
          id: grant.id,
          scopes: grant.scopes,
          singleUse: grant.singleUse,
          expiresAt: grant.expiresAt,
          usedAt: grant.usedAt,
          revokedAt: grant.revokedAt,
        })),
        backups: backups.map((backup) => ({
          id: backup.id,
          generation: backup.generation,
          location: backup.location,
          sizeBytes: backup.sizeBytes,
          verifiedAt: backup.verifiedAt,
          verifyError: backup.verifyError,
          createdAt: backup.createdAt,
        })),
      });
    }),
  );

  /**
   * Issues the one grant a customer's browser will use.
   *
   * The token is returned here and nowhere else, and only a hash is stored, so
   * a leaked database is not a set of working sessions. This response is
   * assembled field by field rather than passed through `clean`, because the
   * token is deliberately key-shaped and this is the one payload meant to
   * carry it.
   */
  app.post(
    '/api/hosting/runtimes/:id/grants',
    handler(async (request) => {
      await requireUser(request);
      const runtime = await hosting.getRuntime(params(request).id!);
      if (!runtime) throw new Error('There is no such runtime.');

      const body = parseBody(
        z.object({
          accountRef: z.string().trim().min(1).max(200),
          scopes: z.array(z.string().trim().min(1).max(64)).min(1).max(16),
          ttlSeconds: z.number().int().min(30).max(86_400).default(900),
          singleUse: z.boolean().default(false),
        }),
        request,
      );

      const issued = await hosting.issueGrant({
        runtimeId: runtime.id,
        tenantId: runtime.tenantId,
        accountRef: body.accountRef,
        scopes: body.scopes,
        ttlSeconds: body.ttlSeconds,
        singleUse: body.singleUse,
      });

      return {
        token: issued.token,
        // Named so a caller cannot mistake this for something it can fetch
        // again, and so an interface can say so to the person reading it.
        shownOnce: true,
        grant: {
          id: issued.row.id,
          scopes: issued.row.scopes,
          singleUse: issued.row.singleUse,
          expiresAt: issued.row.expiresAt,
        },
      };
    }),
  );

  app.post(
    '/api/hosting/runtimes/:id/grants/revoke',
    handler(async (request) => {
      await requireUser(request);
      const revoked = await hosting.revokeGrantsOfRuntime(params(request).id!);
      return clean({ revoked });
    }),
  );
  // -------------------------------------------------------------------------
  // Runtime classes
  // -------------------------------------------------------------------------

  app.get(
    '/api/hosting/classes',
    handler(async (request) => {
      await requireUser(request);
      const classes = await hosting.listRuntimeClasses(true);
      return clean({
        headroom: HOST_HEADROOM,
        classes: classes.map((row) => ({ ...row, live: row.retiredAt === null })),
      });
    }),
  );

  app.post(
    '/api/hosting/classes',
    handler(async (request) => {
      await requireUser(request);
      const body = parseBody(
        z.object({
          id: z.string().trim().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/, 'A class id is lower case letters, digits, dash and underscore.'),
          label: z.string().trim().min(1).max(120),
          cpuCores: z.number().min(0.25).max(256),
          memoryMb: z.number().int().min(512).max(1024 * 1024),
          diskGb: z.number().int().min(1).max(65_536),
          browser: z.boolean().default(false),
          maxAgents: z.number().int().min(1).max(1000),
        }),
        request,
      );
      return clean(await hosting.putRuntimeClass(body));
    }),
  );

  app.post(
    '/api/hosting/classes/:id/retire',
    handler(async (request) => {
      await requireUser(request);
      const retired = await hosting.retireRuntimeClass(params(request).id!);
      if (!retired) throw new Error('There is no live class with that id.');
      // Retired rather than deleted: a runtime created under it still names
      // it, and what an agent was given is a fair question afterwards.
      return clean(retired);
    }),
  );

  // -------------------------------------------------------------------------
  // Placement
  // -------------------------------------------------------------------------

  /**
   * Chooses a host for a runtime, or says why no host will do.
   *
   * The class comes from the row rather than from the request, so a caller
   * cannot place a runtime against a smaller reservation than it was created
   * under. A refusal names every host and why each one refused, because "no
   * capacity" is the least useful thing an operator can be told.
   */
  app.post(
    '/api/hosting/runtimes/:id/place',
    handler(async (request) => {
      await requireUser(request);
      const runtime = await hosting.getRuntime(params(request).id!);
      if (!runtime) throw new Error('There is no such runtime.');

      const klass = await hosting.getRuntimeClass(runtime.runtimeClass);
      if (!klass) {
        throw new Error(
          `This runtime was created under the class ${runtime.runtimeClass}, which is not recorded, so what it reserves is unknown. Record that class before placing it.`,
        );
      }

      const [hosts, providers, reserved] = await Promise.all([
        hosting.listHosts(),
        hosting.listProviders(),
        hosting.reservedByHost(),
      ]);
      const tierOf = new Map(providers.map((p) => [p.id, p.tier]));

      const forScheduling: HostForScheduling[] = hosts.flatMap((host) => {
        const tier = tierOf.get(host.providerId);
        // A host whose provider is gone has no tier, and a tier is what says
        // whether it may hold a tenant at all. Left out rather than defaulted.
        if (!tier || !host.capacity) return [];
        return [
          {
            id: host.id,
            state: host.state,
            tier,
            capacity: host.capacity,
            reserved: reserved.get(host.id) ?? {
              cpuCores: 0,
              memoryMb: 0,
              diskGb: 0,
              runtimes: 0,
              browserRuntimes: 0,
              unmeasured: 0,
            },
            heartbeatAgeSec: heartbeatAgeSec(host.lastHeartbeatAt),
          },
        ];
      });

      const placement = placeRuntime(forScheduling, {
        runtimeClass: {
          id: klass.id,
          label: klass.label,
          cpuCores: Number(klass.cpuCores),
          memoryMb: klass.memoryMb,
          diskGb: klass.diskGb,
          browser: klass.browser,
          maxAgents: klass.maxAgents,
        },
        // Sticky: a tenant driving a browser stays where its profile and its
        // egress address already are.
        preferHostId: runtime.hostId,
        region: runtime.region,
        runtimeVersion: runtime.version,
      });

      if (!placement.placed) return clean(placement);
      const updated = await hosting.placeRuntimeOn(runtime.id, placement.hostId);
      return clean({ ...placement, runtime: updated });
    }),
  );
}
