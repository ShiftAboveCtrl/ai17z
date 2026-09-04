/**
 * Reading a PDF, and being honest when it cannot be read.
 *
 * PDFs are where documentation actually lives -- a whitepaper, a spec, a
 * datasheet -- and until now a source pointed at a folder of them indexed
 * nothing and said nothing, because `DOCUMENT_EXTENSIONS` was Markdown and text
 * only. An agent taught from that folder had been taught nothing and did not
 * know it.
 *
 * Two kinds of PDF, and the difference matters more than it looks:
 *
 *   - a PDF with a **text layer**: the words are in the file, and this reads
 *     them
 *   - a PDF that is **pictures of words**: a scan, or an export that flattened
 *     to images. There is no text to extract, and no amount of trying produces
 *     any
 *
 * The second is the dangerous one, because the failure is silent by nature: the
 * file opens, every page parses, and the extracted text is empty or a handful
 * of page numbers. So it is detected and reported as a refusal with a reason
 * somebody can act on -- run it through OCR, or attach the source document --
 * rather than indexed as an empty document that quietly teaches nothing.
 *
 * `pdfjs-dist` rather than `pdf-parse`: same licence, no dependencies, and no
 * native canvas binary. Rendering is not needed to read text, and a local-first
 * application already shipping a browser does not need a second one.
 */
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';


/**
 * Below this, a PDF that parsed is treated as pictures of words.
 *
 * Chosen from what a scanned page actually yields: page furniture, a stray
 * header, an occasional stamped page number. A real page of prose is several
 * thousand characters, so there is a wide gap between the two and this sits in
 * it. Per document rather than per page, because a document can legitimately
 * open with a title page.
 */
export const MIN_CHARS_PER_PAGE = 40;

export interface PdfText {
  text: string;
  pages: number;
  /** Set when the file parsed but carries no readable words. */
  refusal: string | null;
}

/**
 * Extracts the text of a PDF.
 *
 * Never throws for a bad file: a folder of documentation with one corrupt PDF
 * in it should index the rest and say which one it could not read.
 */
/**
 * Where pdfjs keeps the fourteen fonts every PDF may assume exist.
 *
 * Resolved from the installed package rather than hard-coded, and passed even
 * though nothing renders: without it pdfjs writes a warning to stderr for every
 * document, and a library spraying warnings is how a real error becomes
 * invisible.
 */
function standardFontDirectory(): string | undefined {
  try {
    const entry = createRequire(import.meta.url).resolve('pdfjs-dist/package.json');
    return `${pathToFileURL(dirname(entry)).href}/standard_fonts/`;
  } catch {
    return undefined;
  }
}

export async function readPdfText(bytes: Uint8Array): Promise<PdfText> {
  let pdfjs: typeof import('pdfjs-dist/legacy/build/pdf.mjs');
  try {
    // The legacy build is the one that runs under plain Node without a DOM.
    pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  } catch {
    return { text: '', pages: 0, refusal: 'PDF support is not installed in this build.' };
  }

  try {
    const task = pdfjs.getDocument({
      data: bytes,
      // Nothing here renders, so nothing needs fonts, and a missing standard
      // font file must not turn a readable document into a failure.
      useSystemFonts: false,
      standardFontDataUrl: standardFontDirectory(),
      // Errors only. Everything below that is pdfjs narrating its own parsing.
      verbosity: 0,
      // A PDF can reference external URLs. Reading a document must not become
      // a network request to whatever the document names.
      disableAutoFetch: true,
      disableStream: true,
    });
    const document = await task.promise;

    const parts: string[] = [];
    for (let page = 1; page <= document.numPages; page += 1) {
      const content = await document.getPage(page).then((p) => p.getTextContent());
      const line = content.items
        .map((item) => ('str' in item ? item.str : ''))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      if (line) parts.push(line);
    }
    const pages = document.numPages;
    // The loading task owns the worker; destroying it is what releases both.
    await task.destroy();

    const text = parts.join('\n\n').trim();

    // Pictures of words. The file is fine; there is simply nothing in it to
    // read, and saying so is the whole point.
    if (pages > 0 && text.length < pages * MIN_CHARS_PER_PAGE) {
      return {
        text: '',
        pages,
        refusal:
          text.length === 0
            ? 'this PDF has no text layer, so it is pictures of words rather than words. Run it through OCR first, or attach the document it was made from'
            : `this PDF has almost no text (${text.length} characters across ${pages} pages), so it is probably a scan. Run it through OCR first, or attach the document it was made from`,
      };
    }

    return { text, pages, refusal: null };
  } catch (error) {
    // The message from the parser, not the stack. A malformed PDF is a fact
    // about that file and the owner is the one who can replace it.
    const detail = error instanceof Error ? error.message : 'it could not be parsed';
    return { text: '', pages: 0, refusal: `this PDF could not be read: ${detail.slice(0, 120)}` };
  }
}
