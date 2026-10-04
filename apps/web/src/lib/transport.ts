/**
 * Where this copy of the AI17Z interface sends its requests.
 *
 * There is one AI17Z and one web application. A local owner's browser talks to
 * the API on their own machine; a hosted owner's browser talks to an
 * authenticated gateway that reaches their isolated runtime. Those are two
 * transports for the same API, not two products, which is why this is a dozen
 * lines next to the existing fetch wrapper rather than a second dashboard.
 *
 * The rule that shapes the hosted side: **the browser does not name its
 * runtime.** A grant issued for one tenant and one runtime is the whole of
 * what the client holds, and the gateway resolves which runtime that is. There
 * is deliberately no runtime id in this module and no way to pass one, because
 * a client that can name a backend is a client that can try naming somebody
 * else's.
 */

export type Transport =
  | { mode: 'LOCAL'; base: string }
  | {
      mode: 'HOSTED';
      /** The gateway's origin. Never a runtime address. */
      base: string;
      /**
       * The short-lived grant Studio issued. Held in memory only: putting it
       * in localStorage would leave it behind on a shared machine, and it is
       * meant to expire rather than persist.
       */
      grant: string;
    };

const DEFAULT_BASE = (import.meta.env.VITE_XBAM_API_URL ?? '').replace(/\/+$/, '');

let current: Transport = { mode: 'LOCAL', base: DEFAULT_BASE };

export function setTransport(next: Transport): void {
  current = { ...next, base: next.base.replace(/\/+$/, '') };
}

export function transportMode(): Transport['mode'] {
  return current.mode;
}

export function transportBase(): string {
  return current.base;
}

/**
 * The headers this transport adds, given the local session token if there is
 * one.
 *
 * Hosted requests carry the grant and not a local session: the owner was
 * authenticated by Studio, and the runtime trusts the grant rather than a
 * password it has never seen. Local requests carry the session bearer exactly
 * as they always have.
 */
export function transportHeaders(localToken: string | null): Record<string, string> {
  if (current.mode === 'HOSTED') {
    return { 'x-ai17z-grant': current.grant };
  }
  return localToken ? { authorization: `Bearer ${localToken}` } : {};
}

/** Whether a failed request should clear the local session. Hosted grants are not sessions. */
export function clearsSessionOn401(): boolean {
  return current.mode === 'LOCAL';
}
