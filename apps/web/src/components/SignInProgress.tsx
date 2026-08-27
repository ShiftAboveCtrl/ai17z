import { useEffect, useState } from 'react';
import { KeyRound, ShieldAlert, TimerReset } from 'lucide-react';
import type { AccountRow } from '@app/lib/types';
import { Spinner } from './ui';

/** The steps of a sign-in, in the order they happen. */
const STEPS = [
  { status: 'STARTING_BROWSER', label: 'Starting a browser' },
  { status: 'BROWSER_READY', label: 'Loading the sign-in page' },
  { status: 'AWAITING_LOGIN', label: 'Waiting for you to sign in' },
  { status: 'AUTHENTICATING', label: 'Completing the sign-in' },
] as const;

const CHALLENGE_WORDS: Record<string, string> = {
  two_factor: 'a two-factor code',
  email_verification: 'a code sent to the account email',
  phone_verification: 'a phone number or a texted code',
  captcha: 'a CAPTCHA',
  suspicious_login: 'confirmation that this sign-in was you',
  account_locked: 'the account to be unlocked with X',
  hardware_key: 'a hardware security key',
};

function countdown(deadline: string | null): string | null {
  if (!deadline) return null;
  const seconds = Math.round((new Date(deadline).getTime() - Date.now()) / 1000);
  if (seconds <= 0) return 'expiring';
  const minutes = Math.floor(seconds / 60);
  return minutes >= 1 ? `${minutes} min left` : `${seconds}s left`;
}

/**
 * What is happening during a sign-in.
 *
 * Long operations that show only a spinner are the ones people give up on, so
 * this names the step, how long it has been going, and how long is left.
 */
export function SignInProgress({
  account,
  onCancel,
  cancelling,
}: {
  account: AccountRow;
  onCancel: () => void;
  cancelling: boolean;
}) {
  // Re-renders once a second so the countdown is a countdown.
  const [, tick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  if (account.status === 'CHALLENGE_REQUIRES_USER') {
    const asking = CHALLENGE_WORDS[account.challengeKind ?? ''] ?? 'something only you can provide';
    return (
      <div className="space-y-3 rounded-lg border border-signal-wait/40 bg-signal-wait/[0.06] p-4">
        <p className="flex items-center gap-2 text-sm text-bone">
          <ShieldAlert className="h-4 w-4 shrink-0 text-signal-wait" aria-hidden />
          X is asking for {asking}.
        </p>
        <p className="text-xs leading-relaxed text-bone-dim">
          The browser window is still open and untouched. Finish it there yourself — AI17Z does not answer security
          challenges on your behalf, and has stopped watching the page so it is not reading what you type. Run{' '}
          <span className="text-bone">Test session</span> when you are through.
        </p>
        <button type="button" className="btn-quiet px-0 text-xs" onClick={onCancel} disabled={cancelling}>
          {cancelling && <Spinner className="h-3 w-3" />}
          Give up on this sign-in
        </button>
      </div>
    );
  }

  if (account.status === 'TIMEOUT') {
    return (
      <div className="space-y-2 rounded-lg border border-ink-line bg-ink-panel px-4 py-3">
        <p className="flex items-center gap-2 text-sm text-bone">
          <TimerReset className="h-4 w-4 shrink-0 text-bone-faint" aria-hidden />
          The sign-in window expired before anyone finished.
        </p>
        <p className="text-xs leading-relaxed text-bone-faint">
          Nothing was lost. Open sign-in again when you have a minute.
        </p>
      </div>
    );
  }

  if (account.status === 'SESSION_EXPIRED') {
    return (
      <div className="space-y-2 rounded-lg border border-ink-line bg-ink-panel px-4 py-3">
        <p className="flex items-center gap-2 text-sm text-bone">
          <KeyRound className="h-4 w-4 shrink-0 text-signal-wait" aria-hidden />
          This account was signed in, and X has stopped accepting the stored session.
        </p>
        <p className="text-xs leading-relaxed text-bone-faint">
          The browser profile is intact; only the sign-in lapsed. Open sign-in to renew it.
        </p>
      </div>
    );
  }

  const current = STEPS.findIndex((s) => s.status === account.status);
  if (current === -1) return null;

  const left = countdown(account.authDeadlineAt);
  const started = account.authStartedAt ? Math.round((Date.now() - new Date(account.authStartedAt).getTime()) / 1000) : null;

  return (
    <div className="space-y-3 rounded-lg border border-ink-line bg-ink-panel px-4 py-3.5">
      <div className="flex items-baseline justify-between gap-3">
        <p className="eyebrow">Signing in</p>
        <span className="font-mono text-[10px] text-bone-faint">
          {started !== null && `${started}s elapsed`}
          {started !== null && left && ' · '}
          {left}
        </span>
      </div>

      <ol className="space-y-1.5">
        {STEPS.map((step, i) => (
          <li key={step.status} className="flex items-center gap-2.5 text-sm">
            {i < current ? (
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-signal-calm" aria-hidden />
            ) : i === current ? (
              <Spinner className="h-3 w-3 shrink-0" />
            ) : (
              <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-ink-line" aria-hidden />
            )}
            <span className={i === current ? 'text-bone' : i < current ? 'text-bone-dim' : 'text-bone-faint'}>
              {step.label}
            </span>
          </li>
        ))}
      </ol>

      {account.status === 'AWAITING_LOGIN' && (
        <p className="text-xs leading-relaxed text-bone-faint">
          Sign in yourself in the window that opened. AI17Z never types your password, and this page updates on its
          own when you are through.
        </p>
      )}

      <button type="button" className="btn-quiet px-0 text-xs" onClick={onCancel} disabled={cancelling}>
        {cancelling && <Spinner className="h-3 w-3" />}
        Cancel
      </button>
    </div>
  );
}
