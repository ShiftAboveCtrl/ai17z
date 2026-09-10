import { Agent } from 'undici';
import { lookup as systemLookup } from 'node:dns';
import { addressVerdict } from './addresses';

/**
 * Connecting to the address that was actually approved.
 *
 * The version before this resolved the hostname, judged every address it got
 * back, and then made the request **by hostname** -- which asks the resolver a
 * second time. Between those two questions a resolver can change its mind, and
 * a name that answered with a public address during validation can answer with
 * 127.0.0.1 during connection. That is DNS rebinding, and it defeats every other
 * check in this file: the scheme was fine, the redirect was fine, the address we
 * looked at was fine, and the socket went to loopback anyway.
 *
 * The fix is to stop asking twice. undici's connect step takes a `lookup`, and
 * whatever that returns is what the socket connects to -- so the judgement and
 * the connection are the same act, and there is no window between them to
 * exploit.
 *
 * ### What is deliberately not touched
 *
 * TLS. The certificate is still verified against the **hostname**, because
 * undici sets the server name from the URL and this hook only supplies the
 * address. `rejectUnauthorized` is never set, no certificate is ever accepted
 * that would not otherwise be, and the `Host` header is unchanged. Solving
 * request forgery by weakening HTTPS would trade one hole for a worse one.
 *
 * ### Why the dependency is pinned exactly
 *
 * This is a security boundary that rests on the shape of one hook. undici is
 * present transitively anyway, but a transitive dependency can be replaced by an
 * unrelated upgrade, and a caret range would let one change the connect
 * behaviour without anybody deciding to. The same reasoning as the Playwright
 * pin.
 */

/** What a resolver answers with. Injected so a test can change its mind. */
export type Resolver = typeof systemLookup;

export interface PinnedAgentOptions {
  /** Swapped in tests to prove the address used is the address judged. */
  resolver?: Resolver;
  /** Lets an upstream reach a node on this machine, when it says so on purpose. */
  allowPrivate?: boolean;
}

/**
 * The reason a connection was refused, carried out through the socket error.
 *
 * undici surfaces a connect failure as a network error, so the sentence has to
 * travel on the error itself or an owner is told only that something did not
 * connect.
 */
export class BlockedAddressError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BlockedAddressError';
  }
}

export function pinnedAgent(options: PinnedAgentOptions = {}): Agent {
  const resolve = options.resolver ?? systemLookup;

  return new Agent({
    connect: {
      /**
       * Called by undici at connect time, once, for the address it will use.
       *
       * Every answer is judged, not the first: a name that returns one public
       * and one private address would otherwise get through on whichever the
       * resolver happened to order first, and that ordering is not ours.
       */
      lookup(hostname, opts, callback) {
        resolve(hostname, { ...opts, all: true }, (error, addresses) => {
          if (error) return callback(error, '', 0);

          const found = (Array.isArray(addresses) ? addresses : []) as { address: string; family: number }[];
          if (found.length === 0) {
            return callback(new BlockedAddressError(`${hostname} resolved to nothing.`), '', 0);
          }
          if (options.allowPrivate) {
            return callback(null, found as never, 0 as never);
          }

          for (const entry of found) {
            const verdict = addressVerdict(entry.address);
            if (!verdict.allowed) {
              return callback(
                new BlockedAddressError(
                  `${hostname} resolves to ${entry.address}, which is not fetched: ${verdict.why}`,
                ),
                '',
                0,
              );
            }
          }
          return callback(null, found as never, 0 as never);
        });
      },
    },
  });
}
