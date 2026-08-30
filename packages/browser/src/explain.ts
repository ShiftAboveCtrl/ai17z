/**
 * Turning a browser failure into a sentence.
 *
 * Playwright's messages are written for whoever is holding the debugger, and
 * they arrive with a call log, ANSI escapes, and a websocket URL. Putting that
 * on an account page tells somebody nothing they can act on — and it was on the
 * account page, four times over, naming a port that had not existed for hours.
 *
 * Every rule here maps one recognisable failure to what actually happened and
 * what to do about it. Anything unrecognised keeps its first line, stripped of
 * the machinery, because a short unfamiliar error still beats a long one.
 */

/** Strips ANSI colour and Playwright's call log from a raw message. */
export function tidyBrowserError(raw: string): string {
  return raw
    // eslint-disable-next-line no-control-regex -- terminal colour codes from Playwright
    .replace(/\u001B\[[0-9;]*m/g, '')
    .replace(/\[\d+m/g, '')
    .split(/\n\s*(?:Call log:|- <ws)/)[0]!
    .trim();
}

export interface ExplainedBrowserError {
  /** One sentence about what happened. */
  what: string;
  /** One sentence about what to do, or null when there is nothing to do. */
  fix: string | null;
}

export function explainBrowserError(raw: string): ExplainedBrowserError {
  const message = tidyBrowserError(raw);

  if (/connectOverCDP.*Timeout|Timeout \d+ms exceeded/i.test(message) && /connectOverCDP|ws:\/\//i.test(raw)) {
    return {
      what: 'The browser answered but would not accept a connection in time.',
      fix: 'It is usually a browser left open with hundreds of tabs, or one that has been running for days. Stop the agent and start it again to get a fresh one.',
    };
  }
  if (/ECONNREFUSED|fetch failed|connect ECONNREFUSED/i.test(message)) {
    return {
      what: 'Nothing was listening where the browser used to be.',
      fix: 'The window was probably closed. Starting the agent opens a new one.',
    };
  }
  if (/did not open its debugging port/i.test(message)) {
    return {
      what: 'A browser was started but never opened its debugging port.',
      fix: 'Another window is holding this profile. Close it, or stop and start the agent.',
    };
  }
  if (/no worker|browser_disabled|Browser automation is disabled/i.test(message)) {
    return {
      what: 'Nothing is running that can open a browser.',
      fix: 'Start the worker on the machine with Chrome.',
    };
  }
  if (/signed out|x_signed_out|NEEDS_AUTH/i.test(message)) {
    return { what: 'The X session is signed out.', fix: 'Sign in again from the account panel.' };
  }
  if (/net::ERR_|navigation_failed|Could not open https/i.test(message)) {
    return {
      what: 'The page would not load.',
      fix: 'Usually the network, or X being slow. It retries on its own.',
    };
  }
  if (/no handle to search for/i.test(message)) {
    return { what: 'This account has no handle recorded, so there is nothing to search for.', fix: 'Set the handle on the account.' };
  }
  if (/profile appears to be in use|ProcessSingleton/i.test(message)) {
    return {
      what: 'Another browser is already using this account profile.',
      fix: 'Close it, then start the agent again.',
    };
  }

  // Unrecognised. Keep the first line only: whatever it is, the call log is not
  // helping anybody read it.
  const firstLine = message.split('\n')[0]!.trim();
  return { what: firstLine.length > 200 ? `${firstLine.slice(0, 200)}…` : firstLine, fix: null };
}

/** The one-line form, for a status column. */
export function describeBrowserError(raw: string): string {
  const { what, fix } = explainBrowserError(raw);
  return fix ? `${what} ${fix}` : what;
}
