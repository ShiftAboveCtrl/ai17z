import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { Page } from 'playwright';
import { createLogger, errorMessage, newId } from '@xbam/shared';

const log = createLogger('browser-diagnostics');

export interface CapturedScreenshot {
  relPath: string;
  bytes: number;
  url: string | null;
}

/**
 * Screenshot on failure, tagged with why it was taken.
 *
 * The legacy system dropped these into a flat folder and left them
 * unassociated. Here the caller attaches the returned path to the failing
 * action, so a failure in the UI comes with the picture of what the page
 * actually looked like.
 */
export async function captureScreenshot(
  page: Page,
  storageDir: string,
  tag: string,
): Promise<CapturedScreenshot | null> {
  try {
    const safeTag = tag.replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 60);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const relPath = `diagnostics/${stamp}_${safeTag}_${newId().slice(0, 8)}.png`;
    const absolute = resolve(storageDir, relPath);
    await mkdir(dirname(absolute), { recursive: true });
    const buffer = await page.screenshot({ fullPage: false, timeout: 15_000 });
    await writeFile(absolute, buffer);
    return { relPath, bytes: buffer.byteLength, url: safeUrl(page) };
  } catch (error) {
    // A failed screenshot must never mask the failure that triggered it.
    log.warn('screenshot capture failed', { tag, message: errorMessage(error) });
    return null;
  }
}

/** Reading `page.url()` throws once a page is closed, which is exactly when we ask. */
export function safeUrl(page: Page): string | null {
  try {
    return page.url();
  } catch {
    return null;
  }
}
