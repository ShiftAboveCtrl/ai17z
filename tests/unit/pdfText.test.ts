import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readPdfText } from '@xbam/memory';
import { DOCUMENT_EXTENSIONS, collectDocuments } from '@xbam/memory';

const fixtures = resolve(__dirname, '../fixtures/pdf');

async function read(name: string) {
  return readPdfText(new Uint8Array(await readFile(resolve(fixtures, name))));
}

/**
 * PDFs are where documentation actually lives, and until now a source pointed
 * at a folder of them indexed nothing and said nothing.
 */
describe('reading a PDF that has words in it', () => {
  it('extracts the text', async () => {
    const result = await read('readable.pdf');
    expect(result.refusal).toBeNull();
    expect(result.pages).toBe(1);
    expect(result.text).toContain('An agent is an identity');
    expect(result.text).toContain('waitForLimit');
  });

  it('joins a line broken across the page into readable prose', async () => {
    const result = await read('readable.pdf');
    // Not "notesAn agent". A word run together with the next is a word neither
    // retrieval nor a model can match.
    expect(result.text).not.toMatch(/notesAn/);
    expect(result.text).toMatch(/AI17Z runtime notes An agent/);
  });
});

/**
 * The dangerous case, because the failure is silent by nature: the file opens,
 * every page parses, and there is simply nothing to read. Indexed quietly, it
 * is how somebody believes their agent has read documentation it has never
 * seen.
 */
describe('a PDF that is pictures of words', () => {
  it('is refused rather than indexed as an empty document', async () => {
    const result = await read('scanned.pdf');
    expect(result.text).toBe('');
    expect(result.refusal).toContain('no text layer');
  });

  it('says what to do about it', async () => {
    const result = await read('scanned.pdf');
    expect(result.refusal).toContain('OCR');
  });

  it('catches a scan carrying nothing but page numbers', async () => {
    // The harder case: it parses, it has text, and the text is "1" and "2".
    const result = await read('furniture.pdf');
    expect(result.refusal).toContain('almost no text');
    expect(result.refusal).toContain('2 pages');
  });
});

describe('a PDF that is not a PDF', () => {
  it('is reported rather than thrown, so the rest of the folder still indexes', async () => {
    const result = await read('broken.pdf');
    expect(result.refusal).toContain('could not be read');
    expect(result.text).toBe('');
  });
});

describe('the folder walk', () => {
  it('treats a PDF as a document', () => {
    expect([...DOCUMENT_EXTENSIONS]).toContain('.pdf');
  });

  it('indexes the readable one and names each one it could not read', async () => {
    const result = await collectDocuments(fixtures);

    expect(result.files.map((file) => file.path)).toEqual(['readable.pdf']);
    expect(result.files[0]!.text).toContain('An agent is an identity');

    // Every refusal is named. A folder of scans that indexes to nothing in
    // silence is the whole problem.
    const refused = Object.fromEntries(result.refused.map((entry) => [entry.path, entry.reason]));
    expect(Object.keys(refused).sort()).toEqual(['broken.pdf', 'furniture.pdf', 'scanned.pdf']);
    expect(refused['scanned.pdf']).toContain('OCR');
  });
});
