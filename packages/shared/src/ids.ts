import { randomUUID, createHash, randomBytes } from 'node:crypto';

export const newId = (): string => randomUUID();

export const sha256Hex = (input: string): string => createHash('sha256').update(input, 'utf8').digest('hex');

export const shortHash = (input: string, length = 12): string => sha256Hex(input).slice(0, length);

export const randomToken = (bytes = 32): string => randomBytes(bytes).toString('base64url');

export function slugify(input: string, fallback = 'agent'): string {
  const slug = input
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return slug.length >= 2 ? slug : `${fallback}-${randomBytes(3).toString('hex')}`;
}

/**
 * Canonical dedupe key for a remote action. The same source event must never
 * produce two remote actions, no matter how many times it is processed.
 */
export function actionIdempotencyKey(parts: {
  channel: string;
  accountId: string | null;
  remoteEventId: string;
  actionType: string;
  agentId: string;
}): string {
  return [parts.channel, parts.accountId ?? 'none', parts.remoteEventId, parts.actionType, parts.agentId].join('|');
}

/** Content signature used to suppress re-posting identical text at a target. */
export function contentSignature(targetRef: string, text: string): string {
  return `${targetRef}|${sha256Hex(text.trim())}`;
}
