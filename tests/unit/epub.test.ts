import { inspectEpub, isEpub } from '../../src/modules/books/epub';
import {
  epubWithCompressedMimetype,
  epubWithWrongFirstEntry,
  epubWithWrongMediaType,
  notAnArchive,
  plainZip,
  validEpub,
} from '../helpers/epubFixture';

describe('EPUB signature check', () => {
  it('accepts a spec-conformant container', () => {
    expect(isEpub(validEpub())).toBe(true);
  });

  it('rejects a file that is not an archive', () => {
    expect(inspectEpub(notAnArchive())).toEqual({
      ok: false,
      reason: 'File is not a ZIP container',
    });
  });

  it('rejects a plain ZIP renamed to .epub', () => {
    const verdict = inspectEpub(plainZip());

    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/must start with a "mimetype" entry/);
  });

  it('rejects a container whose first entry is not mimetype', () => {
    expect(inspectEpub(epubWithWrongFirstEntry()).ok).toBe(false);
  });

  it('rejects a compressed mimetype entry', () => {
    const verdict = inspectEpub(epubWithCompressedMimetype());

    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/stored uncompressed/);
  });

  it('rejects the wrong media type', () => {
    const verdict = inspectEpub(epubWithWrongMediaType());

    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toMatch(/media type/);
  });

  it('rejects a truncated file without reading past its end', () => {
    expect(inspectEpub(validEpub().subarray(0, 20))).toEqual({
      ok: false,
      reason: 'File is too small to be an EPUB',
    });
  });
});
