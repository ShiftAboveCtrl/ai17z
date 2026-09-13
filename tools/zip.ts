/**
 * A zip writer, so the application can ship as one file the bootstrap can check.
 *
 * Written here rather than taken from a dependency for two reasons. The first is
 * that this runs in the release workflow, and a build step that pulls a package
 * in order to produce the artifact people download is one more thing between
 * the repository and the file on somebody's disk. The second is determinism: the
 * audit story for AI17Z Setup is "the hash compiled into the signed executable
 * is the hash of this payload", and a zip that embeds the time it was made
 * produces a different hash every run for identical input.
 *
 * So: entries in sorted order, one fixed timestamp, no extra fields, and the
 * same compression level every time. Identical input produces an identical file.
 *
 * The format is PKZIP's, and only the part of it that is needed: deflate or
 * store, local headers with the CRC known up front, a central directory, and
 * Zip64 for the entry count -- the staged application is several tens of
 * thousands of files, which is past the 65,535 a classic end-of-central-
 * directory record can count.
 */
import { createHash } from 'node:crypto';
import { open, readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';

/**
 * 1980-01-01 00:00:00, the earliest a DOS timestamp can express.
 *
 * Every entry carries it. The modification time of a file inside the package is
 * not information anybody uses -- the installation is replaced wholesale -- and
 * carrying the real one would make the hash depend on when the build ran.
 */
const DOS_EPOCH_TIME = 0;
const DOS_EPOCH_DATE = 0x0021;

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL = 0x06054b50;
const ZIP64_END_OF_CENTRAL = 0x06064b50;
const ZIP64_LOCATOR = 0x07064b50;

/** Deflate, then keep whichever is smaller. Storing is allowed and often wins. */
const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;

interface Entry {
  /** The name inside the archive, always with forward slashes. */
  name: string;
  offset: number;
  crc: number;
  compressed: number;
  uncompressed: number;
  method: number;
}

async function* walk(dir: string, base: string): AsyncGenerator<string> {
  for (const item of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, item.name);
    if (item.isDirectory()) {
      yield* walk(full, base);
    } else if (item.isFile()) {
      yield relative(base, full);
    }
    // Symbolic links are deliberately skipped. npm creates one per workspace
    // package, and a link inside an archive is either a path that escapes the
    // extraction directory or a broken file on the other machine. The packager
    // copies workspaces in as real directories, so nothing is lost.
  }
}

function localHeader(entry: Entry, nameBytes: Buffer): Buffer {
  const header = Buffer.alloc(30);
  header.writeUInt32LE(LOCAL_HEADER, 0);
  header.writeUInt16LE(20, 4); // version needed: 2.0, which deflate requires
  header.writeUInt16LE(0x0800, 6); // names are UTF-8
  header.writeUInt16LE(entry.method, 8);
  header.writeUInt16LE(DOS_EPOCH_TIME, 10);
  header.writeUInt16LE(DOS_EPOCH_DATE, 12);
  header.writeUInt32LE(entry.crc, 14);
  header.writeUInt32LE(entry.compressed, 18);
  header.writeUInt32LE(entry.uncompressed, 22);
  header.writeUInt16LE(nameBytes.length, 26);
  header.writeUInt16LE(0, 28); // no extra field
  return header;
}

function centralHeader(entry: Entry, nameBytes: Buffer): Buffer {
  const header = Buffer.alloc(46);
  header.writeUInt32LE(CENTRAL_HEADER, 0);
  header.writeUInt16LE(20, 4); // made by 2.0, MS-DOS
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(0x0800, 8);
  header.writeUInt16LE(entry.method, 10);
  header.writeUInt16LE(DOS_EPOCH_TIME, 12);
  header.writeUInt16LE(DOS_EPOCH_DATE, 14);
  header.writeUInt32LE(entry.crc, 16);
  header.writeUInt32LE(entry.compressed, 20);
  header.writeUInt32LE(entry.uncompressed, 24);
  header.writeUInt16LE(nameBytes.length, 28);
  header.writeUInt16LE(0, 30); // extra
  header.writeUInt16LE(0, 32); // comment
  header.writeUInt16LE(0, 34); // disk
  header.writeUInt16LE(0, 36); // internal attributes
  header.writeUInt32LE(0, 38); // external attributes
  header.writeUInt32LE(entry.offset, 42);
  return header;
}

/**
 * Write every file under `from` into a zip at `to`.
 *
 * Returns how many entries were written, so the caller can prove the archive is
 * not empty rather than trusting that it ran.
 */
export async function createZip(from: string, to: string): Promise<number> {
  const names: string[] = [];
  for await (const name of walk(from, from)) names.push(name);
  // Sorted, so the order does not depend on how the filesystem enumerated it.
  names.sort();
  if (names.length === 0) throw new Error(`nothing to zip: ${from} is empty`);

  const handle = await open(to, 'w');
  try {
    const entries: Entry[] = [];
    let offset = 0;

    for (const name of names) {
      const archiveName = name.split(sep).join('/');
      const nameBytes = Buffer.from(archiveName, 'utf8');
      const contents = await readFile(join(from, name));
      const deflated = contents.length > 0 ? deflateRawSync(contents, { level: 9 }) : Buffer.alloc(0);
      const useDeflate = deflated.length < contents.length;
      const body = useDeflate ? deflated : contents;

      const entry: Entry = {
        name: archiveName,
        offset,
        crc: crc32(contents),
        compressed: body.length,
        uncompressed: contents.length,
        method: useDeflate ? METHOD_DEFLATE : METHOD_STORE,
      };
      const header = localHeader(entry, nameBytes);
      await handle.write(header);
      await handle.write(nameBytes);
      if (body.length > 0) await handle.write(body);
      offset += header.length + nameBytes.length + body.length;
      entries.push(entry);
    }

    const directoryStart = offset;
    for (const entry of entries) {
      const nameBytes = Buffer.from(entry.name, 'utf8');
      const header = centralHeader(entry, nameBytes);
      await handle.write(header);
      await handle.write(nameBytes);
      offset += header.length + nameBytes.length;
    }
    const directorySize = offset - directoryStart;

    // Zip64, when the count no longer fits in sixteen bits. The staged
    // application is tens of thousands of files, so this is the ordinary case
    // rather than the exotic one -- without it the archive silently claims to
    // hold `count mod 65536` entries and extracts a fraction of itself.
    const needsZip64 = entries.length > 0xffff || directoryStart > 0xffffffff;
    if (needsZip64) {
      const record = Buffer.alloc(56);
      record.writeUInt32LE(ZIP64_END_OF_CENTRAL, 0);
      record.writeBigUInt64LE(BigInt(44), 4); // size of this record after this field
      record.writeUInt16LE(45, 12); // made by
      record.writeUInt16LE(45, 14); // needed
      record.writeUInt32LE(0, 16); // this disk
      record.writeUInt32LE(0, 20); // disk with the directory
      record.writeBigUInt64LE(BigInt(entries.length), 24);
      record.writeBigUInt64LE(BigInt(entries.length), 32);
      record.writeBigUInt64LE(BigInt(directorySize), 40);
      record.writeBigUInt64LE(BigInt(directoryStart), 48);
      await handle.write(record);

      const locator = Buffer.alloc(20);
      locator.writeUInt32LE(ZIP64_LOCATOR, 0);
      locator.writeUInt32LE(0, 4);
      locator.writeBigUInt64LE(BigInt(offset), 8);
      locator.writeUInt32LE(1, 16);
      await handle.write(locator);
    }

    const end = Buffer.alloc(22);
    end.writeUInt32LE(END_OF_CENTRAL, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(needsZip64 ? 0xffff : entries.length, 8);
    end.writeUInt16LE(needsZip64 ? 0xffff : entries.length, 10);
    end.writeUInt32LE(directorySize, 12);
    end.writeUInt32LE(needsZip64 ? 0xffffffff : directoryStart, 16);
    end.writeUInt16LE(0, 20);
    await handle.write(end);

    return entries.length;
  } finally {
    await handle.close();
  }
}

/** The hash the setup program checks a download against. */
export async function sha256(path: string): Promise<string> {
  const hash = createHash('sha256');
  hash.update(await readFile(path));
  return hash.digest('hex');
}

/** How big it came out, for the line the packager prints. */
export async function sizeOf(path: string): Promise<number> {
  return (await stat(path)).size;
}
