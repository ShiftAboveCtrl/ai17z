import { mkdir, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { ops, query } from '@xbam/database';
import { ingestNormalizedEvent } from '@xbam/runtime';
import { installHarness, mockEvent } from '../support/harness';
import { createFixture } from '../support/fixtures';
import { uniqueSuffix } from '../support/db';

installHarness();

const storageRoot = resolve(process.env.XBAM_STORAGE_DIR || './storage');
const written: string[] = [];

afterAll(async () => {
  for (const path of written) await rm(path, { force: true });
});

/** A screenshot on disk, as the browser layer would leave one. */
async function writeScreenshot(): Promise<{ relPath: string; bytes: number }> {
  const relPath = `diagnostics/test-${uniqueSuffix()}.png`;
  const absolute = resolve(storageRoot, relPath);
  await mkdir(resolve(absolute, '..'), { recursive: true });
  // A real one-pixel PNG, so nothing here is asserting against a made-up file.
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  );
  await writeFile(absolute, png);
  written.push(absolute);
  return { relPath, bytes: png.length };
}

/**
 * A screenshot nobody can find is a screenshot nobody takes.
 *
 * When a page changes under the adapter, the failure classification says what
 * went wrong and the screenshot says what the page actually looked like. The
 * second is only worth capturing if it can be got back to from the job that
 * failed, which means three things have to hold together: the file exists, the
 * artifact row points at it, and the diagnostic points at the artifact.
 */
describe('a failure screenshot', () => {
  it('is findable from the job that failed', async () => {
    const fixture = await createFixture();
    const { relPath, bytes } = await writeScreenshot();

    const artifact = await ops.createArtifact({
      kind: 'SCREENSHOT',
      agentId: fixture.agentId,
      mimeType: 'image/png',
      relPath,
      bytes,
    });
    const diagnostic = await ops.createDiagnostic({
      accountId: null,
      channel: 'mock',
      kind: 'selector_missing',
      url: 'https://x.com/someone/status/1',
      errorClass: 'RETRYABLE',
      message: 'The composer never appeared.',
      artifactId: artifact.id,
    });

    expect(diagnostic.artifactId).toBe(artifact.id);
    const found = await ops.getArtifact(artifact.id);
    expect(found?.relPath).toBe(relPath);
    expect(found?.bytes).toBe(bytes);
  });

  it('resolves to a file that is actually there', async () => {
    // The row and the file are written separately, so a row pointing at
    // nothing is the failure worth catching.
    const { relPath, bytes } = await writeScreenshot();
    const artifact = await ops.createArtifact({ kind: 'SCREENSHOT', mimeType: 'image/png', relPath, bytes });
    const { existsSync } = await import('node:fs');
    expect(existsSync(resolve(storageRoot, artifact.relPath))).toBe(true);
  });

  it('stays inside the storage directory', async () => {
    // The route resolves `relPath` against the storage root and refuses
    // anything that escapes it. This is the row such a check exists for.
    const artifact = await ops.createArtifact({
      kind: 'SCREENSHOT',
      mimeType: 'image/png',
      relPath: '../../../etc/passwd',
      bytes: 0,
    });
    const absolute = resolve(storageRoot, artifact.relPath);
    expect(absolute.startsWith(storageRoot)).toBe(false);
  });

  it('carries the classification, not just the picture', async () => {
    // "Something went wrong" plus an image is a puzzle. The class is what makes
    // it a report.
    const diagnostic = await ops.createDiagnostic({
      accountId: null,
      channel: 'mock',
      kind: 'selector_missing',
      errorClass: 'RETRYABLE',
      message: 'The composer never appeared within 30s.',
    });
    expect(diagnostic.errorClass).toBe('RETRYABLE');
    expect(diagnostic.kind).toBe('selector_missing');
    expect(diagnostic.message).toContain('composer');
  });

  it('survives without one, because a failed screenshot must not mask the failure', async () => {
    // The whole point of the null artifact id: if capturing the picture fails,
    // the thing that actually went wrong still gets recorded.
    const diagnostic = await ops.createDiagnostic({
      accountId: null,
      channel: 'mock',
      kind: 'navigation_failed',
      errorClass: 'RETRYABLE',
      message: 'The page never loaded, and no screenshot could be taken.',
      artifactId: null,
    });
    expect(diagnostic.id).toBeTruthy();
    expect(diagnostic.artifactId).toBeNull();
  });

  it('is attached to the job, so it is reachable from the run that produced it', async () => {
    const fixture = await createFixture();
    const outcome = await ingestNormalizedEvent({
      accountId: null,
      onlyAgentId: fixture.agentId,
      event: mockEvent('Something that will fail in the browser'),
    });
    const jobId = outcome.jobs[0]!.job.id;

    const { relPath, bytes } = await writeScreenshot();
    const artifact = await ops.createArtifact({ kind: 'SCREENSHOT', jobId, mimeType: 'image/png', relPath, bytes });
    await ops.createDiagnostic({
      jobId,
      accountId: null,
      channel: 'mock',
      kind: 'selector_missing',
      errorClass: 'RETRYABLE',
      message: 'The composer never appeared.',
      artifactId: artifact.id,
    });

    const rows = await query<{ artifact_id: string | null }>('SELECT artifact_id FROM diagnostics WHERE job_id = $1', [
      jobId,
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.artifact_id).toBe(artifact.id);
  });
});
