jest.mock('../../src/config/prisma', () =>
  require('../helpers/prismaMock').buildPrismaModuleMock(),
);

import fs from 'node:fs/promises';
import * as prismaModule from '../../src/config/prisma';
import { prismaMockFrom } from '../helpers/prismaMock';
import * as bookService from '../../src/modules/books/book.service';
import { ApiError } from '../../src/utils/ApiError';
import { env } from '../../src/config/env';
import { EPUB_FOLDER, resolveStoragePath } from '../../src/utils/fileStorage';
import { Role } from '../../src/generated/prisma/enums';
import type { AuthUser } from '../../src/types/express';
import { notAnArchive, validEpub } from '../helpers/epubFixture';

const db = prismaMockFrom(prismaModule);

const READER: AuthUser = { id: 'reader-1', email: 'reader@example.com', role: Role.USER };
const ADMIN: AuthUser = { id: 'admin-1', email: 'admin@example.com', role: Role.ADMIN };

const BOOK_ID = '11111111-2222-4333-8444-555555555555';

const metadata = { title: 'Moby Dick', published: true } as never;

function book(overrides: Record<string, unknown> = {}) {
  return {
    id: BOOK_ID,
    title: 'Moby Dick',
    published: true,
    storageKey: 'stored-key.epub',
    originalName: 'moby.epub',
    mimeType: 'application/epub+zip',
    sizeBytes: 1024,
    uploadedById: ADMIN.id,
    ...overrides,
  };
}

function upload(buffer: Buffer, originalname = 'moby.epub'): Express.Multer.File {
  return {
    fieldname: 'file',
    originalname,
    encoding: '7bit',
    mimetype: 'application/epub+zip',
    size: buffer.length,
    buffer,
  } as Express.Multer.File;
}

/** The row the service tried to insert. */
function createdData(): Record<string, unknown> {
  return db.book.create.mock.calls[0][0].data;
}

/** The `where` clause the service handed to findMany. */
function whereFromList() {
  return db.book.findMany.mock.calls[0][0].where;
}

/** Lets `createBook` succeed against the mock, mirroring the row back. */
function allowCreate(): void {
  db.book.findUnique.mockResolvedValue(null);
  db.book.create.mockImplementation(({ data }: { data: Record<string, unknown> }) => ({
    id: BOOK_ID,
    ...data,
  }));
}

/** Runs a real upload and returns the storage key it wrote to. */
async function storeBook(content: string): Promise<string> {
  allowCreate();
  await bookService.createBook(metadata, upload(validEpub(content)), ADMIN.id);
  return createdData().storageKey as string;
}

// The upload root comes from tests/setup-env.ts, which points it at a temp
// directory; this removes whatever the suite wrote there.
afterAll(async () => {
  await fs.rm(env.UPLOAD_DIR, { recursive: true, force: true });
});

describe('listBooks visibility', () => {
  beforeEach(() => {
    db.book.findMany.mockResolvedValue([]);
    db.book.count.mockResolvedValue(0);
  });

  it('restricts a USER to published books', async () => {
    await bookService.listBooks({ page: 1, limit: 20, sortOrder: 'desc' } as never, READER);

    expect(whereFromList().AND[0]).toEqual({ published: true });
  });

  it('applies no visibility restriction for an ADMIN', async () => {
    await bookService.listBooks({ page: 1, limit: 20, sortOrder: 'desc' } as never, ADMIN);

    expect(whereFromList().AND[0]).toEqual({});
  });

  it('only sorts by a whitelisted column', async () => {
    await bookService.listBooks(
      { page: 1, limit: 20, sortOrder: 'asc', sortBy: 'checksum' } as never,
      READER,
    );

    expect(db.book.findMany.mock.calls[0][0].orderBy).toEqual({ createdAt: 'asc' });
  });
});

describe('getBookById', () => {
  it('returns a published book to a reader', async () => {
    db.book.findUnique.mockResolvedValue(book());

    await expect(bookService.getBookById(BOOK_ID, READER)).resolves.toMatchObject({
      title: 'Moby Dick',
    });
  });

  it('hides an unpublished book from a reader as a 404', async () => {
    db.book.findUnique.mockResolvedValue(book({ published: false }));

    await expect(bookService.getBookById(BOOK_ID, READER)).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it('shows an unpublished book to an admin', async () => {
    db.book.findUnique.mockResolvedValue(book({ published: false }));

    await expect(bookService.getBookById(BOOK_ID, ADMIN)).resolves.toMatchObject({
      id: BOOK_ID,
    });
  });
});

describe('createBook', () => {
  beforeEach(allowCreate);

  it('stores the bytes and records derived metadata', async () => {
    await bookService.createBook(metadata, upload(validEpub('store')), ADMIN.id);

    const data = createdData();
    expect(data.uploadedById).toBe(ADMIN.id);
    expect(data.mimeType).toBe('application/epub+zip');
    expect(data.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(data.storageKey).toMatch(/^[0-9a-f-]{36}\.epub$/);

    const stored = await fs.readFile(resolveStoragePath(EPUB_FOLDER, data.storageKey as string));
    expect(stored.equals(validEpub('store'))).toBe(true);
  });

  it('rejects a file that is not an EPUB before writing anything', async () => {
    await expect(
      bookService.createBook(metadata, upload(notAnArchive(), 'fake.epub'), ADMIN.id),
    ).rejects.toBeInstanceOf(ApiError);

    expect(db.book.create).not.toHaveBeenCalled();
  });

  it('rejects a file already in the library', async () => {
    db.book.findUnique.mockResolvedValue({ id: BOOK_ID, title: 'Moby Dick' });

    await expect(
      bookService.createBook(metadata, upload(validEpub('dupe')), ADMIN.id),
    ).rejects.toMatchObject({ statusCode: 409 });

    expect(db.book.create).not.toHaveBeenCalled();
  });

  it('removes the stored file when the insert fails', async () => {
    db.book.create.mockRejectedValue(new Error('constraint violation'));

    await expect(
      bookService.createBook(metadata, upload(validEpub('rollback')), ADMIN.id),
    ).rejects.toThrow('constraint violation');

    const key = createdData().storageKey as string;
    await expect(fs.access(resolveStoragePath(EPUB_FOLDER, key))).rejects.toThrow();
  });

  it('never takes the storage key from the uploaded filename', async () => {
    await bookService.createBook(
      metadata,
      upload(validEpub('traversal'), '../../etc/passwd.epub'),
      ADMIN.id,
    );

    const data = createdData();
    expect(data.storageKey).not.toContain('..');
    expect(data.originalName).toBe('passwd.epub');
  });
});

describe('getBookFile', () => {
  it('fails loudly when the row exists but the blob does not', async () => {
    db.book.findUnique.mockResolvedValue(book({ storageKey: 'missing.epub' }));

    await expect(bookService.getBookFile(BOOK_ID, ADMIN)).rejects.toMatchObject({
      statusCode: 500,
    });
  });

  it('refuses an unpublished book for a reader', async () => {
    db.book.findUnique.mockResolvedValue(book({ published: false }));

    await expect(bookService.getBookFile(BOOK_ID, READER)).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it('resolves the stored path and names the download after the title', async () => {
    const key = await storeBook('download');
    db.book.findUnique.mockResolvedValue(book({ storageKey: key }));

    await expect(bookService.getBookFile(BOOK_ID, READER)).resolves.toMatchObject({
      path: resolveStoragePath(EPUB_FOLDER, key),
      filename: 'moby-dick.epub',
      mimeType: 'application/epub+zip',
    });
  });
});

describe('deleteBook', () => {
  it('removes the row and then the blob', async () => {
    const key = await storeBook('delete');

    db.book.findUnique.mockResolvedValue({ storageKey: key });
    db.book.delete.mockResolvedValue({ id: BOOK_ID });

    await bookService.deleteBook(BOOK_ID);

    expect(db.book.delete).toHaveBeenCalledWith({ where: { id: BOOK_ID } });
    await expect(fs.access(resolveStoragePath(EPUB_FOLDER, key))).rejects.toThrow();
  });

  it('404s on an unknown id without deleting anything', async () => {
    db.book.findUnique.mockResolvedValue(null);

    await expect(bookService.deleteBook(BOOK_ID)).rejects.toMatchObject({ statusCode: 404 });
    expect(db.book.delete).not.toHaveBeenCalled();
  });
});

describe('storage keys', () => {
  it('refuses to resolve a key that escapes its folder', () => {
    expect(() => resolveStoragePath(EPUB_FOLDER, '../../.env')).toThrow(/outside/);
  });
});

describe('sanitiseFilename', () => {
  it('strips directories, quotes and control characters', () => {
    expect(bookService.sanitiseFilename('..\\..\\windows\\sys"tem.epub')).toBe('system.epub');
    expect(bookService.sanitiseFilename('a\r\nX-Injected: 1.epub')).toBe('aX-Injected: 1.epub');
  });

  it('falls back when nothing usable is left', () => {
    expect(bookService.sanitiseFilename('/')).toBe('book.epub');
  });
});
