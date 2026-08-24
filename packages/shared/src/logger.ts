type Level = 'debug' | 'info' | 'warn' | 'error';

const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const configured = (process.env.XBAM_LOG_LEVEL ?? 'info').toLowerCase() as Level;
const threshold = LEVELS[configured] ?? LEVELS.info;
const pretty = process.env.NODE_ENV !== 'production' && process.env.XBAM_LOG_JSON !== '1';

const REDACT_KEYS = /(api_?key|apikey|password|secret|token|authorization|cookie|encrypted)/i;

/** Recursively blanks anything that looks like a credential before it is logged. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[deep]';
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = REDACT_KEYS.test(k) ? '[redacted]' : redact(v, depth + 1);
  }
  return out;
}

export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

function emit(level: Level, scope: Record<string, unknown>, msg: string, data?: Record<string, unknown>) {
  if (LEVELS[level] < threshold) return;
  const payload = { level, time: new Date().toISOString(), ...scope, msg, ...(data ? { data: redact(data) } : {}) };
  const line = pretty
    ? `${payload.time} ${level.toUpperCase().padEnd(5)} ${scope.scope ?? '-'} ${msg}` +
      (data ? ` ${JSON.stringify(redact(data))}` : '')
    : JSON.stringify(payload);
  if (level === 'error') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}

export function createLogger(scope: string, bindings: Record<string, unknown> = {}): Logger {
  const base = { scope, ...bindings };
  return {
    debug: (m, d) => emit('debug', base, m, d),
    info: (m, d) => emit('info', base, m, d),
    warn: (m, d) => emit('warn', base, m, d),
    error: (m, d) => emit('error', base, m, d),
    child: (extra) => createLogger(scope, { ...bindings, ...extra }),
  };
}

export const logger = createLogger('xbam');
