/** Compact relative time. Falls back to a date once past a week. */
export function timeAgo(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 'unknown';
  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days <= 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function clockTime(iso: string | null | undefined): string {
  if (!iso) return '--:--:--';
  return new Date(iso).toLocaleTimeString(undefined, { hour12: false });
}

export function compactNumber(value: number): string {
  return new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

const STATUS_TONE: Record<string, 'live' | 'wait' | 'fail' | 'idle'> = {
  EXECUTED: 'live',
  DRY_RUN_COMPLETED: 'live',
  ACTIVE: 'live',
  CONNECTED: 'live',
  WAITING_FOR_APPROVAL: 'wait',
  REVIEW_REQUIRED: 'wait',
  RETRYABLE_FAILURE: 'wait',
  NEEDS_AUTH: 'wait',
  PAUSED: 'wait',
  STARTING_BROWSER: 'wait',
  BROWSER_READY: 'wait',
  AWAITING_LOGIN: 'wait',
  AUTHENTICATING: 'wait',
  CHALLENGE_REQUIRES_USER: 'wait',
  SESSION_EXPIRED: 'wait',
  TIMEOUT: 'fail',
  PERMANENT_FAILURE: 'fail',
  ERROR: 'fail',
  CANCELLED: 'idle',
  DRAFT: 'idle',
  DISCONNECTED: 'idle',
};

export function toneFor(status: string): 'live' | 'wait' | 'fail' | 'idle' {
  return STATUS_TONE[status] ?? 'idle';
}

/**
 * Names for states whose mechanical spelling would not tell anyone what to do.
 * Everything else is derived from the constant itself.
 */
const STATUS_WORDS: Record<string, string> = {
  STARTING_BROWSER: 'Starting a browser',
  BROWSER_READY: 'Browser ready',
  AWAITING_LOGIN: 'Waiting for you to sign in',
  AUTHENTICATING: 'Signing in',
  CHALLENGE_REQUIRES_USER: 'Needs you',
  SESSION_EXPIRED: 'Session expired',
  NEEDS_AUTH: 'Not signed in',
  TIMEOUT: 'Sign-in timed out',
};

/** Turns RUNNING_STATES into readable text without losing precision. */
export function humanStatus(status: string): string {
  return (
    STATUS_WORDS[status] ??
    status
      .toLowerCase()
      .replace(/_/g, ' ')
      .replace(/^\w/, (c) => c.toUpperCase())
  );
}
