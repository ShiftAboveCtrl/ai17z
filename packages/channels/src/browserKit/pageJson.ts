import type { Page } from '@xbam/browser';

/**
 * Asking a network's own JSON endpoint from inside its signed-in page.
 *
 * The request goes out as the page's own: same origin, same cookies, same
 * session. That is the whole point of doing it in the page rather than in Node,
 * where the cookies would have to be handed over and a credential would have to
 * cross into this process.
 *
 * **Nothing credential-shaped is returned.** Headers that carry a value read
 * from a cookie (a CSRF token, typically) are assembled in the page from the
 * cookie's name, used there, and never come back. The answer is the status, the
 * error text and the parsed body, and nothing else.
 */

export interface InPageJsonRequest {
  /** Absolute, and on the page's own origin. */
  url: string;
  /** Static headers, the network's own app identifiers. */
  headers: Record<string, string>;
  /**
   * Headers whose value is a cookie's value, read in the page.
   * A cookie that is absent gives an empty header, as the network's own app
   * would send it.
   */
  cookieHeaders?: readonly { header: string; cookie: string }[];
}

export interface InPageJsonAnswer {
  /** The request succeeded and the body carried no `errors` array. */
  ok: boolean;
  /** HTTP status; 0 when the request never completed. */
  status: number;
  error: string | null;
  json: unknown;
}

export async function fetchJsonInPage(page: Page, request: InPageJsonRequest): Promise<InPageJsonAnswer> {
  return page.evaluate(
    async ({ url, headers, cookieHeaders }) => {
      const all: Record<string, string> = { ...headers };
      for (const entry of cookieHeaders) {
        const escaped = entry.cookie.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const found = document.cookie.match(new RegExp('(?:^|;\\s*)' + escaped + '=([^;]+)'));
        all[entry.header] = (found ?? [])[1] ?? '';
      }

      try {
        const response = await fetch(url, { method: 'GET', credentials: 'include', headers: all });
        const text = await response.text();
        let json: unknown = null;
        try {
          json = JSON.parse(text);
        } catch {
          json = null;
        }
        const errors = (json as { errors?: { message?: string }[] } | null)?.errors;
        return {
          ok: response.ok && !errors?.length,
          status: response.status,
          error: errors?.[0]?.message ?? (response.ok ? null : text.slice(0, 200)),
          json,
        };
      } catch (error) {
        return { ok: false, status: 0, error: String((error as Error).message ?? error).slice(0, 200), json: null };
      }
    },
    { url: request.url, headers: request.headers, cookieHeaders: request.cookieHeaders ?? [] },
  );
}
