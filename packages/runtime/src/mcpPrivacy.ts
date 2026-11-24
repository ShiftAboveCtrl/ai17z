import { redact } from '@xbam/shared';

/** Strings need filtering too: structured-key redaction alone misses echoed credentials. */
export function mcpSanitizer(secrets: string[] = []) {
  const literals = new Set(secrets.filter(s => s.length >= 8));
  const text = (value: string): string => {
    let safe = value;
    for (const secret of literals) safe = safe.split(secret).join('[redacted]');
    return safe
      .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, '[redacted]')
      .replace(/\b(?:ai17z_mcp_|sk-|gh[pousr]_|xox[baprs]-)[A-Za-z0-9_/-]+/g, '[redacted]')
      .replace(/\bv1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[redacted]')
      .replace(/\b(?:Bearer\s+|(?:password|secret|api[_-]?key|access[_-]?token)\s*[=:]\s*["']?)[^\s,"'}]+/gi, '[redacted]');
  };
  const value = (input: unknown): unknown => {
    if (typeof input === 'string') return text(input);
    if (Array.isArray(input)) return input.map(value);
    if (input && typeof input === 'object') return Object.fromEntries(Object.entries(redact(input) as Record<string, unknown>).map(([k, v]) => [text(k), value(v)]));
    return input;
  };
  return { text, value, add: (secret: string) => { if (secret.length >= 8) literals.add(secret); } };
}
