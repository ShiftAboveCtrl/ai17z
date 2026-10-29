import type { FastifyReply, FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { zodToDescription } from '@xbam/runtime';
import { CadenceConfig, PolicyConfig } from '@xbam/shared/contracts';
import { fail, parseBody } from '../../apps/api/src/http';

/**
 * What changed underneath the code when zod went from 3 to 4, held where a
 * typecheck cannot see it. Each of these compiled cleanly and behaved wrongly.
 */

describe('a default that is an empty object', () => {
  // zod 4's `.default({})` hands back `{}` without parsing it, so every nested
  // default disappears. `.prefault({})` is what zod 3's `.default({})` did.
  it('still fills in every nested default', () => {
    const policy = PolicyConfig.parse({});
    expect(policy.output.emoji.use).toBeTypeOf('string');
    expect(policy.output.emoji.maxPerMessage).toBeTypeOf('number');
    expect(policy.rate.workingHours.timezone).toBe('UTC');

    const cadence = CadenceConfig.parse({});
    expect(cadence.polling.intervalSeconds).toBeTypeOf('number');
    expect(cadence.capacity.cooldownMinutes).toBeTypeOf('number');
  });
});

describe('what the model is shown for a capability argument', () => {
  // zod 4 dropped `_def.typeName`, and reading it described every argument as `value`.
  it('names each field and its kind', () => {
    const shape = z.object({
      handle: z.string(),
      limit: z.number().optional(),
      kind: z.enum(['a', 'b']),
      exact: z.literal('x'),
      tags: z.array(z.string()),
      either: z.union([z.string(), z.number()]),
      fresh: z.boolean().default(true),
    });
    expect(zodToDescription(shape)).toBe(
      '{"handle": string, "limit": number?, "kind": "a" | "b", "exact": "x", "tags": string[], "either": string | number, "fresh": boolean?}',
    );
  });
});

describe('a strict schema', () => {
  it('still refuses a field it does not know', () => {
    const strict = z.object({ name: z.string() }).strict();
    expect(strict.safeParse({ name: 'x', extra: 1 }).success).toBe(false);
  });
});

describe('a record keyed by an enum', () => {
  // zod 4's `z.record(z.enum(...))` requires every key. A settings screen that
  // sends the one toggle that changed needs the partial form.
  it('accepts some of the keys when it is partial', () => {
    const categories = z.partialRecord(z.enum(['accounts', 'runtime']), z.boolean());
    expect(categories.safeParse({ accounts: false }).success).toBe(true);
    expect(categories.safeParse({ elsewhere: true }).success).toBe(false);
  });
});

describe('the sentence the API answers a bad request with', () => {
  function answer(schema: z.ZodType, body: unknown): { status: number; message: string } {
    const sent: { status: number; message: string } = { status: 0, message: '' };
    const reply = {
      status(code: number) {
        sent.status = code;
        return this;
      },
      send(payload: { error: { message: string } }) {
        sent.message = payload.error.message;
        return this;
      },
    } as unknown as FastifyReply;
    try {
      parseBody(schema, { body } as FastifyRequest);
    } catch (error) {
      fail(reply, error);
    }
    return sent;
  }

  it('says how far over a length limit the value is', () => {
    const result = answer(z.object({ displayName: z.string().max(5) }), { displayName: 'abcdefgh' });
    expect(result.status).toBe(422);
    expect(result.message).toBe('Display Name is too long. It is 8 characters and the most allowed is 5. Remove at least 3.');
  });

  it('says a missing field is required, not what type undefined is', () => {
    const result = answer(z.object({ displayName: z.string() }), {});
    expect(result.message).toBe('Display Name is required.');
  });

  it('says an empty field cannot be empty', () => {
    const result = answer(z.object({ displayName: z.string().min(1) }), { displayName: '' });
    expect(result.message).toBe('Display Name cannot be empty.');
  });
});
