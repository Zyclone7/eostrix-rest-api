/**
 * Content sniffing for EPUB uploads.
 *
 * The `Content-Type` header and the filename extension are both attacker
 * controlled, so neither is evidence of anything. An EPUB is an OCF ZIP
 * container, and the specification is unusually strict about its first bytes:
 * the archive must begin with a *stored* (uncompressed) entry named
 * `mimetype` whose content is exactly `application/epub+zip`. That gives a
 * cheap, unambiguous signature to check before anything is written to disk.
 *
 * See OCF 3.3 §4.1 "OCF ZIP Container — the mimetype file".
 */

export const EPUB_MIME_TYPE = 'application/epub+zip';

/** ZIP local file header signature, "PK\x03\x04". */
const ZIP_LOCAL_FILE_HEADER = Buffer.from([0x50, 0x4b, 0x03, 0x04]);

const MIMETYPE_ENTRY_NAME = 'mimetype';
const COMPRESSION_STORED = 0;

export interface EpubCheck {
  ok: boolean;
  reason?: string;
}

/** True when the buffer is a spec-conformant EPUB container. */
export function isEpub(buffer: Buffer): boolean {
  return inspectEpub(buffer).ok;
}

/** Same check as {@link isEpub}, but explains the rejection. */
export function inspectEpub(buffer: Buffer): EpubCheck {
  // 30-byte local file header + "mimetype" + the media type string.
  if (buffer.length < 58) return { ok: false, reason: 'File is too small to be an EPUB' };

  if (!buffer.subarray(0, 4).equals(ZIP_LOCAL_FILE_HEADER)) {
    return { ok: false, reason: 'File is not a ZIP container' };
  }

  const compression = buffer.readUInt16LE(8);
  const nameLength = buffer.readUInt16LE(26);
  const extraLength = buffer.readUInt16LE(28);

  const name = buffer.subarray(30, 30 + nameLength).toString('latin1');
  if (name !== MIMETYPE_ENTRY_NAME) {
    return { ok: false, reason: 'EPUB container must start with a "mimetype" entry' };
  }

  if (compression !== COMPRESSION_STORED) {
    return { ok: false, reason: 'The "mimetype" entry must be stored uncompressed' };
  }

  const dataStart = 30 + nameLength + extraLength;
  const declared = buffer
    .subarray(dataStart, dataStart + EPUB_MIME_TYPE.length)
    .toString('latin1');

  if (declared !== EPUB_MIME_TYPE) {
    return { ok: false, reason: `EPUB media type must be "${EPUB_MIME_TYPE}"` };
  }

  return { ok: true };
}
