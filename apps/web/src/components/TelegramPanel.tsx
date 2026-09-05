import { useEffect, useRef, useState } from 'react';
import { Check, Copy, Send, Trash2 } from 'lucide-react';
import { ApiError, del, get, post, put } from '@app/lib/api';
import { timeAgo } from '@app/lib/format';
import { ErrorPanel, Field, Spinner, StatusDot, Toggle } from '@app/components/ui';

type Severity = 'INFO' | 'WARNING' | 'CRITICAL';

interface TelegramStatus {
  configured: boolean;
  connected: boolean;
  enabled: boolean;
  botUsername: string | null;
  chatLabel: string | null;
  connectedAt: string | null;
  awaitingPairing: boolean;
  pairingCode: string | null;
  categories: Record<string, boolean>;
  minSeverity: Severity;
  heartbeatHours: number;
  lastDeliveryAt: string | null;
  lastError: string | null;
  lastErrorAt: string | null;
  catalogue: { id: string; label: string; description: string }[];
}

/** How often to ask whether the owner has messaged the bot yet. */
const PAIR_POLL_MS = 2_000;

/**
 * Where the owner gets told things when they are not at the machine.
 *
 * The token is typed here and nowhere else. It goes to the API once, is sealed
 * under the master key on the way, and no route ever gives it back -- so this
 * screen can show that a bot is connected and which one, and can never show
 * what it is. The input is cleared the moment it is accepted.
 */
export function TelegramPanel() {
  const [status, setStatus] = useState<TelegramStatus | null>(null);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tested, setTested] = useState(false);
  const [copied, setCopied] = useState(false);
  const polling = useRef<number | null>(null);

  const load = async () => {
    try {
      setStatus(await get<TelegramStatus>('/api/notifications/telegram'));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'The Telegram settings could not be read.');
    }
  };

  useEffect(() => {
    void load();
  }, []);

  /**
   * While pairing, ask Telegram every couple of seconds whether the code has
   * arrived. The alternative is a "check now" button somebody has to press
   * after switching apps, which is one more thing to explain.
   */
  useEffect(() => {
    if (!status?.awaitingPairing) {
      if (polling.current) window.clearInterval(polling.current);
      polling.current = null;
      return;
    }
    polling.current = window.setInterval(() => {
      void post<TelegramStatus>('/api/notifications/telegram/pair', {})
        .then((next) => setStatus((current) => ({ ...(current as TelegramStatus), ...next })))
        .catch(() => undefined);
    }, PAIR_POLL_MS);
    return () => {
      if (polling.current) window.clearInterval(polling.current);
      polling.current = null;
    };
  }, [status?.awaitingPairing]);

  const run = async (name: string, work: () => Promise<TelegramStatus | void>) => {
    setBusy(name);
    setError(null);
    try {
      const next = await work();
      if (next) setStatus((current) => ({ ...(current as TelegramStatus), ...next }));
      else await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'That did not work.');
    } finally {
      setBusy(null);
    }
  };

  const connect = () =>
    run('connect', async () => {
      const next = await post<TelegramStatus>('/api/notifications/telegram', { token: token.trim() });
      // Out of the field the moment it is accepted. It is of no further use
      // here and every second it sits in a form is a second it can be read.
      setToken('');
      return next;
    });

  const savePreferences = (patch: Record<string, unknown>) =>
    run('prefs', () => put<TelegramStatus>('/api/notifications/telegram', patch));

  if (!status) {
    return (
      <div className="flex items-center gap-3 py-4 text-sm text-bone-faint">
        <Spinner /> Reading the Telegram settings
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {!status.configured && (
        <div className="space-y-5">
          <p className="max-w-prose text-sm leading-relaxed text-bone-dim">
            AI17Z runs on this machine, so when an account is waiting on a security challenge at three in the morning
            there is nobody to tell. A Telegram bot fixes that: this machine sends messages out over HTTPS, so nothing
            has to be opened to the internet and there is no server in the middle.
          </p>

          <ol className="max-w-prose space-y-2 border-l border-ink-line pl-4 text-sm text-bone-dim">
            <li>
              In Telegram, open a chat with <span className="font-mono text-bone">@BotFather</span>.
            </li>
            <li>
              Send <span className="font-mono text-bone">/newbot</span> and answer its two questions.
            </li>
            <li>It replies with a token. Paste the whole line below.</li>
          </ol>

          <Field
            label="Bot token"
            htmlFor="tgtoken"
            hint="Sealed with your master key before it is stored, and never returned by the API."
          >
            <input
              id="tgtoken"
              type="password"
              className="field"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="123456789:AA..."
              autoComplete="off"
              spellCheck={false}
            />
          </Field>

          <button
            type="button"
            className="btn-primary"
            onClick={() => void connect()}
            disabled={busy === 'connect' || token.trim().length === 0}
          >
            {busy === 'connect' && <Spinner />}
            Connect
          </button>
        </div>
      )}

      {status.awaitingPairing && (
        <div className="space-y-4">
          <p className="max-w-prose text-sm leading-relaxed text-bone-dim">
            Connected to <span className="font-mono text-bone">@{status.botUsername}</span>. One step left, and it is
            the one that matters: anybody who knows the bot&rsquo;s name can message it, so AI17Z will only send to the
            chat that proves it is yours.
          </p>
          <p className="max-w-prose text-sm leading-relaxed text-bone-dim">
            Open the bot in Telegram, press <span className="text-bone">Start</span>, and send it this code.
          </p>

          <div className="flex items-center gap-3">
            <span className="font-mono text-3xl tracking-[0.3em] text-bone">{status.pairingCode}</span>
            <button
              type="button"
              className="btn-quiet"
              onClick={() => {
                void navigator.clipboard?.writeText(status.pairingCode ?? '');
                setCopied(true);
                window.setTimeout(() => setCopied(false), 2000);
              }}
            >
              {copied ? <Check className="h-3.5 w-3.5" aria-hidden /> : <Copy className="h-3.5 w-3.5" aria-hidden />}
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>

          <p className="flex items-center gap-2 text-xs text-bone-faint">
            <Spinner className="h-3 w-3" /> Waiting for it to arrive. This screen will notice by itself.
          </p>

          <button type="button" className="btn-quiet" onClick={() => void run('forget', () => del('/api/notifications/telegram'))}>
            Start again with a different bot
          </button>
        </div>
      )}

      {status.connected && (
        <div className="space-y-8">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <StatusDot state={status.enabled ? 'live' : 'idle'} label={status.enabled ? 'Sending' : 'Paused'} />
            <span className="font-mono text-[11px] text-bone-faint">
              @{status.botUsername} &middot; {status.chatLabel}
              {status.connectedAt ? ` · connected ${timeAgo(status.connectedAt)}` : ''}
              {status.lastDeliveryAt ? ` · last sent ${timeAgo(status.lastDeliveryAt)}` : ' · nothing sent yet'}
            </span>
            <div className="ml-auto flex items-center gap-2">
              <button
                type="button"
                className="btn-quiet"
                disabled={busy === 'test'}
                onClick={() =>
                  void run('test', async () => {
                    await post('/api/notifications/telegram/test', {});
                    setTested(true);
                    window.setTimeout(() => setTested(false), 4000);
                  })
                }
              >
                {busy === 'test' ? <Spinner className="h-3.5 w-3.5" /> : tested ? <Check className="h-3.5 w-3.5" aria-hidden /> : <Send className="h-3.5 w-3.5" aria-hidden />}
                {tested ? 'Sent' : 'Send a test'}
              </button>
              <button
                type="button"
                className="btn-quiet hover:text-signal-fail"
                aria-label="Disconnect Telegram"
                disabled={busy === 'forget'}
                onClick={() => void run('forget', () => del<TelegramStatus>('/api/notifications/telegram'))}
              >
                <Trash2 className="h-3.5 w-3.5" aria-hidden />
              </button>
            </div>
          </div>

          {status.lastError && (
            <ErrorPanel
              title="The last message did not get through."
              detail={`${status.lastError}${status.lastErrorAt ? ` (${timeAgo(status.lastErrorAt)})` : ''}`}
            />
          )}

          <div className="space-y-1">
            <Toggle
              checked={status.enabled}
              onChange={(enabled) => void savePreferences({ enabled })}
              label="Send notifications to Telegram"
              description="Turning this off keeps the bot connected and stops the messages."
            />
          </div>

          <div>
            <p className="eyebrow mb-3">What to send</p>
            <div className="space-y-1">
              {status.catalogue.map((category) => (
                <Toggle
                  key={category.id}
                  checked={status.categories[category.id] !== false}
                  disabled={!status.enabled}
                  onChange={(on) => void savePreferences({ categories: { [category.id]: on } })}
                  label={category.label}
                  description={category.description}
                />
              ))}
            </div>
            <p className="mt-3 max-w-prose text-xs leading-relaxed text-bone-faint">
              Turning one back on does not send what it missed. These are the same notifications the app shows, not a
              second opinion about what is worth saying.
            </p>
          </div>

          <div className="grid gap-6 sm:grid-cols-2">
            <Field
              label="How serious it has to be"
              htmlFor="tgsev"
              hint="Severity is about what happens if it is ignored, not how alarming it sounds."
            >
              <select
                id="tgsev"
                className="field"
                value={status.minSeverity}
                disabled={!status.enabled}
                onChange={(e) => void savePreferences({ minSeverity: e.target.value })}
              >
                <option value="CRITICAL">Critical only — an agent has stopped</option>
                <option value="WARNING">Warning and above — something is degraded</option>
                <option value="INFO">Everything</option>
              </select>
            </Field>

            <Field
              label="Still-running message"
              htmlFor="tghb"
              hint="AI17Z cannot tell you it has stopped. A message that does not arrive can."
            >
              <select
                id="tghb"
                className="field"
                value={String(status.heartbeatHours)}
                disabled={!status.enabled}
                onChange={(e) => void savePreferences({ heartbeatHours: Number(e.target.value) })}
              >
                <option value="0">Never</option>
                <option value="6">Every 6 hours</option>
                <option value="12">Every 12 hours</option>
                <option value="24">Once a day</option>
              </select>
            </Field>
          </div>

          <p className="max-w-prose text-xs leading-relaxed text-bone-faint">
            Telegram is where AI17Z tells you things. It is not somewhere you can tell AI17Z to do things: nothing you
            send the bot is read after pairing, and no agent can see this chat or post to it.
          </p>
        </div>
      )}

      {error && <ErrorPanel title="That did not work." detail={error} />}
    </div>
  );
}
