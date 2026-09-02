import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

let loaded = false;

/**
 * Minimal .env loader. Walks up from the current working directory to the repo
 * root so `tsx apps/api/src/main.ts` and `npm run dev` behave identically.
 * Existing process.env values always win.
 */
export function loadEnv(startDir = process.cwd()): void {
  if (loaded) return;
  loaded = true;
  let dir = resolve(startDir);
  for (let i = 0; i < 8; i += 1) {
    const candidate = resolve(dir, '.env');
    if (existsSync(candidate)) {
      applyEnvFile(readFileSync(candidate, 'utf8'));
      applyBrandCompatibility();
      return;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // No .env found: the environment may still carry either prefix.
  applyBrandCompatibility();
}

export function applyEnvFile(contents: string): void {
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (key in process.env) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

export function envString(key: string, fallback: string): string {
  const v = process.env[key];
  return v === undefined || v === '' ? fallback : v;
}

export function envInt(key: string, fallback: number): number {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

export function envBool(key: string, fallback: boolean): boolean {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

export function requireEnv(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`Missing required environment variable: ${key}`);
  return v;
}

const LEGACY_PREFIX = 'XBAM_';
const BRAND_PREFIX = 'AI17Z_';

/**
 * Bridges the XBAM to AI17Z rename for environment variables.
 *
 * Every setting is readable under either prefix, in both directions, and an
 * explicitly set value always wins over the alias. This matters most for
 * `XBAM_MASTER_KEY`: provider secrets are sealed under that exact key material,
 * so an install that predates the rename must keep decrypting without the owner
 * touching anything. Renaming a variable is never worth losing a credential.
 */
export function applyBrandCompatibility(env: NodeJS.ProcessEnv = process.env): void {
  // An empty value counts as absent, in both directions.
  //
  // Set-but-empty is what a container gets when compose interpolates a variable
  // that is not in `.env`, and it is not a choice anybody made. Treating it as a
  // value meant an empty `XBAM_MASTER_KEY` from the compose file blocked the
  // mirror from a perfectly good `AI17Z_MASTER_KEY`, so the process ended up
  // with no key while both names were technically present. `envString` has
  // always drawn the line in the same place.
  const missing = (v: string | undefined) => v === undefined || v === '';

  for (const [key, value] of Object.entries(env)) {
    if (missing(value)) continue;
    if (key.startsWith(LEGACY_PREFIX)) {
      const branded = BRAND_PREFIX + key.slice(LEGACY_PREFIX.length);
      if (missing(env[branded])) env[branded] = value;
    } else if (key.startsWith(BRAND_PREFIX)) {
      const legacy = LEGACY_PREFIX + key.slice(BRAND_PREFIX.length);
      if (missing(env[legacy])) env[legacy] = value;
    }
  }
}
