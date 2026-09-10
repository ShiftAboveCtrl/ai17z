import { defineUpstream, perDay, perMinute, perSecond, type QuotaWindow, type Upstream } from '@xbam/upstream';

/**
 * An upstream that misbehaves on demand.
 *
 * Every family added from here on needs the same handful of unpleasant answers
 * proved against it -- a 429 with each form of `Retry-After`, a run of 500s, a
 * timeout, a cancellation, a body that is not what it promised -- and none of
 * that should be proved against somebody's free public endpoint. Deliberately
 * making a real service fail is both rude and unreliable; this is neither.
 *
 * Shared rather than copied, so a family that forgets one of these is obvious.
 */

export interface FakeBehaviour {
  /** Answers in order; the last one repeats once the list runs out. */
  answers?: FakeAnswer[];
  /** Milliseconds before answering, for proving a timeout. */
  delayMs?: number;
}

export type FakeAnswer =
  | { kind: 'ok'; value?: string }
  | { kind: 'status'; status: number; retryAfter?: string }
  | { kind: 'malformed' }
  | { kind: 'throw'; message: string };

export interface FakeUpstreamOptions {
  id: string;
  family?: string;
  rank?: number;
  origin?: string;
  timeoutMs?: number;
  freshMs?: number;
  concurrentPerProcess?: number;
  windows?: QuotaWindow[];
  /** Charges more for some queries than others, like a compute-unit endpoint. */
  weigh?(query: unknown): number;
  behaviour?: FakeBehaviour;
}

export interface FakeQuery {
  of: string;
  /** Only read by `weigh`, so a weighted budget can be exercised. */
  costs?: number;
}

export interface FakeUpstream {
  upstream: Upstream<FakeQuery, string>;
  /** Every call that reached `fetch`, in order. */
  calls: FakeQuery[];
  /** Replaces the remaining answers. */
  willAnswer(answers: FakeAnswer[]): void;
}

/** The windows most fakes want: generous, so nothing paces by accident. */
export const OPEN_WINDOWS: QuotaWindow[] = [perSecond(1_000, { scope: 'MACHINE' })];

export { perDay, perMinute, perSecond };

export function fakeUpstream(options: FakeUpstreamOptions): FakeUpstream {
  const calls: FakeQuery[] = [];
  let answers = [...(options.behaviour?.answers ?? [{ kind: 'ok' as const }])];

  const upstream = defineUpstream<FakeQuery, string>({
    id: options.id,
    family: options.family ?? options.id.split('.')[0]!,
    name: options.id,
    description: 'A fake upstream that answers however a test needs.',
    origin: options.origin ?? `${options.id.replace('.', '-')}.example`,
    limit: {
      concurrentPerProcess: options.concurrentPerProcess ?? 100,
      windows: options.windows ?? OPEN_WINDOWS,
      ...(options.weigh ? { weigh: options.weigh } : {}),
    },
    timeoutMs: options.timeoutMs ?? 1_000,
    freshMs: options.freshMs ?? 0,
    rank: options.rank ?? 1,
    cacheKey: (query) => query.of,
    async fetch(query, ctx) {
      calls.push(query);

      if (options.behaviour?.delayMs) {
        // Races the caller's own timeout, and loses when it is meant to. The
        // abort has to be honoured here rather than left to the wrapper, which
        // is exactly what a real adapter has to do with its socket.
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, options.behaviour!.delayMs);
          ctx.signal.addEventListener('abort', () => {
            clearTimeout(timer);
            reject(new Error('The operation was aborted'));
          });
        });
      }

      const answer = answers.length > 1 ? answers.shift()! : (answers[0] ?? { kind: 'ok' as const });
      switch (answer.kind) {
        case 'ok':
          return answer.value ?? `${options.id} says so`;
        case 'malformed':
          throw new Error('It answered with something that is not JSON.');
        case 'throw':
          throw new Error(answer.message);
        case 'status': {
          // Built the way a real adapter reports one, so the classification
          // under test is the shared one rather than a test's own idea of it.
          const { classifyStatus } = await import('@xbam/upstream');
          const headers = new Headers();
          if (answer.retryAfter) headers.set('retry-after', answer.retryAfter);
          const failure = classifyStatus(answer.status, headers);
          if (failure) throw failure;
          return `${options.id} says so`;
        }
      }
    },
  });

  return {
    upstream,
    calls,
    willAnswer(next) {
      answers = [...next];
    },
  };
}
