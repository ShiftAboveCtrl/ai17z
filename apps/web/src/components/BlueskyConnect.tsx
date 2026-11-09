import { useState } from 'react';
import { ApiError } from '@app/lib/api';
import { saveBlueskyAccount } from '@app/lib/setup';
import type { AccountRow } from '@app/lib/types';
import { Field, Spinner } from './ui';

/**
 * The help a person needs to make an app password, in one place.
 *
 * Bluesky has two kinds of password and only one of them is safe to hand to a
 * program. Said before the field rather than after a refusal, because the
 * mistake this prevents is pasting the main one.
 */
export function AppPasswordHelp() {
  return (
    <div className="rounded-lg border border-ink-line bg-ink-panel px-4 py-3 text-[13px] leading-relaxed text-bone-dim">
      <p className="text-bone">Use an app password, never your main one.</p>
      <p className="mt-1">
        In Bluesky, open Settings, then Privacy and security, then App passwords, and add one. It looks like{' '}
        <span className="font-mono text-bone">xxxx-xxxx-xxxx-xxxx</span>. It can be revoked on its own, and it cannot
        change your email or delete the account.
      </p>
      <p className="mt-1 text-bone-faint">
        AI17Z checks it with Bluesky before keeping it, stores it sealed, and never shows it again. It never answers a
        security check for you.
      </p>
    </div>
  );
}

/**
 * Links a Bluesky account, or signs one back in.
 *
 * One form for both, because they are one act: the API proves the details
 * before keeping anything, makes the account if it is new and refreshes it if
 * it is not. So a lapsed app password is fixed by doing exactly what linking did.
 *
 * The password lives in this component's state for as long as the form is open
 * and is cleared the moment it is sent. It is never put in a URL, a log or
 * local storage, and the response is the account row, which has no secret on it.
 */
export function BlueskyConnect({
  onConnected,
  initialIdentifier = '',
  submitLabel = 'Connect',
  lockIdentifier = false,
  showHelp = true,
}: {
  onConnected: (account: AccountRow) => void | Promise<void>;
  initialIdentifier?: string;
  submitLabel?: string;
  /** For signing an existing account back in: the handle is not what is being changed. */
  lockIdentifier?: boolean;
  showHelp?: boolean;
}) {
  const [identifier, setIdentifier] = useState(initialIdentifier);
  const [appPassword, setAppPassword] = useState('');
  const [serviceUrl, setServiceUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ready = identifier.trim().length > 0 && appPassword.trim().length > 0;

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const account = await saveBlueskyAccount({
        identifier,
        appPassword: appPassword.trim(),
        serviceUrl: serviceUrl.trim() || null,
      });
      setAppPassword('');
      await onConnected(account);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Bluesky could not be reached. Nothing was saved.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="space-y-5"
      onSubmit={(event) => {
        event.preventDefault();
        if (ready && !busy) void submit();
      }}
    >
      {showHelp && <AppPasswordHelp />}
      <Field label="Handle" htmlFor="bsky-identifier" hint="For example name.bsky.social, or the email on the account.">
        <input
          id="bsky-identifier"
          className="field"
          value={identifier}
          onChange={(e) => setIdentifier(e.target.value)}
          placeholder="name.bsky.social"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          readOnly={lockIdentifier}
        />
      </Field>
      <Field label="App password" htmlFor="bsky-password">
        <input
          id="bsky-password"
          className="field font-mono"
          type="password"
          value={appPassword}
          onChange={(e) => setAppPassword(e.target.value)}
          placeholder="xxxx-xxxx-xxxx-xxxx"
          // A password manager offering to remember an app password as the
          // main one is the mistake the help text above is trying to prevent.
          autoComplete="off"
          spellCheck={false}
        />
      </Field>
      <details className="text-[13px] text-bone-dim">
        <summary className="cursor-pointer select-none text-bone-faint hover:text-bone">
          The account is on its own server
        </summary>
        <div className="mt-3">
          <Field label="Server" htmlFor="bsky-server" hint="Leave empty for bsky.social. It must start with https://">
            <input
              id="bsky-server"
              className="field"
              value={serviceUrl}
              onChange={(e) => setServiceUrl(e.target.value)}
              placeholder="https://pds.example.com"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
            />
          </Field>
        </div>
      </details>
      {error && (
        <p role="alert" className="break-words text-sm leading-relaxed text-signal-fail">
          {error}
        </p>
      )}
      <button type="submit" className="btn-primary w-full" disabled={busy || !ready}>
        {busy && <Spinner />}
        {busy ? 'Checking with Bluesky' : submitLabel}
      </button>
    </form>
  );
}
