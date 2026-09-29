import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = resolve(__dirname, '..', '..');
const read = (path: string) => readFileSync(resolve(root, path));

/*
  The logo is the owner's and is never redrawn. Every icon, the installer's
  artwork and the web app's marks are generated from this one file by placing
  it on a ground. A changed hash means somebody replaced the logo, which is
  allowed and means regenerating everything, not editing an output.
*/
describe('AI17Z branding comes from the canonical logo', () => {
  it('is the logo the owner supplied', () => {
    const hash = createHash('sha256').update(read('packaging/brand/ai17z-logo.png')).digest('hex');
    expect(hash).toBe('ddf2e5322291a17af7d4ba342445aa0d95bf53a13fbe70e776827dbeca5f9b3b');
  });

  it('is only ever placed, never drawn', () => {
    for (const script of ['packaging/brand/logo.py', 'packaging/windows/make-icon.py', 'packaging/windows/make-wizard-art.py']) {
      const text = read(script).toString('utf8');
      expect(text, script).not.toMatch(/ImageFont|\.text\(|truetype/);
    }
    expect(read('packaging/brand/logo.py').toString('utf8')).toContain("'ai17z-logo.png'");
  });

  it('reaches every place an icon is shown', () => {
    for (const output of [
      'packaging/windows/ai17z.ico',
      'packaging/windows/ai17z.png',
      'packaging/windows/ai17z-256.png',
      'packaging/windows/wizard-panel.bmp',
      'packaging/windows/wizard-small.bmp',
      'packaging/brand/icons/ai17z-48.png',
      'packaging/brand/icons/ai17z-128.png',
      'packaging/brand/icons/ai17z-512.png',
      'apps/web/public/favicon.ico',
      'apps/web/public/icon-192.png',
      'apps/web/public/icon-512.png',
      'apps/web/public/apple-touch-icon.png',
      'apps/web/public/ai17z-wordmark.png',
      'apps/web/public/manifest.webmanifest',
    ]) {
      expect(existsSync(resolve(root, output)), output).toBe(true);
    }
    const html = read('apps/web/index.html').toString('utf8');
    expect(html).toContain('href="/favicon.ico"');
    expect(html).toContain('href="/manifest.webmanifest"');
    // The hand-drawn "A" it replaced.
    expect(html).not.toContain('data:image/svg+xml');
    const deb = read('packaging/ubuntu/build-deb.sh').toString('utf8');
    expect(deb).toContain('packaging/brand/icons/ai17z-$size.png');
  });
});
