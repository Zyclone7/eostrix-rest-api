/**
 * Builds byte-accurate EPUB containers for tests.
 *
 * The signature check reads a real ZIP local file header, so the fixtures have
 * to be real bytes rather than a hand-waved string — otherwise the tests would
 * only prove that the checker agrees with itself.
 */

interface LocalHeaderOptions {
  name?: string;
  content?: string;
  /** 0 = stored, 8 = deflated. The OCF spec requires 0 for `mimetype`. */
  compression?: number;
  extraLength?: number;
}

/** A single ZIP local file entry, uncompressed, with no data descriptor. */
function localFileEntry({
  name = 'mimetype',
  content = 'application/epub+zip',
  compression = 0,
  extraLength = 0,
}: LocalHeaderOptions = {}): Buffer {
  const nameBytes = Buffer.from(name, 'latin1');
  const contentBytes = Buffer.from(content, 'latin1');
  const header = Buffer.alloc(30);

  header.writeUInt32LE(0x04034b50, 0); // "PK\x03\x04"
  header.writeUInt16LE(20, 4); // version needed
  header.writeUInt16LE(0, 6); // flags
  header.writeUInt16LE(compression, 8);
  header.writeUInt32LE(contentBytes.length, 18); // compressed size
  header.writeUInt32LE(contentBytes.length, 22); // uncompressed size
  header.writeUInt16LE(nameBytes.length, 26);
  header.writeUInt16LE(extraLength, 28);

  return Buffer.concat([
    header,
    nameBytes,
    Buffer.alloc(extraLength),
    contentBytes,
    // Padding stands in for the rest of the archive; nothing reads it.
    Buffer.alloc(64),
  ]);
}

/** A container the checker must accept. */
export function validEpub(marker = 'default'): Buffer {
  return Buffer.concat([localFileEntry(), Buffer.from(marker, 'utf8')]);
}

export function epubWithCompressedMimetype(): Buffer {
  return localFileEntry({ compression: 8 });
}

export function epubWithWrongMediaType(): Buffer {
  return localFileEntry({ content: 'application/zip!!!!!' });
}

export function epubWithWrongFirstEntry(): Buffer {
  return localFileEntry({ name: 'METAINF/', content: 'application/epub+zip' });
}

/** A plain ZIP — the shape of a renamed .zip masquerading as a book. */
export function plainZip(): Buffer {
  return localFileEntry({ name: 'readme.txt', content: 'not a book at all!!!' });
}

/** Not an archive at all. */
export function notAnArchive(): Buffer {
  return Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(80, 0x41)]);
}
