import { prisma } from '../../config/prisma';
import { ApiError } from '../../utils/ApiError';
import { buildMeta, resolveSort, skipTake } from '../../utils/pagination';
import {
  EPUB_FOLDER,
  deleteFile,
  fileExists,
  newStorageKey,
  resolveStoragePath,
  saveFile,
  sha256,
} from '../../utils/fileStorage';
import { Role } from '../../generated/prisma/enums';
import type { Prisma } from '../../generated/prisma/client';
import type { AuthUser } from '../../types/express';
import { EPUB_MIME_TYPE, inspectEpub } from './epub';
import type { CreateBookInput, ListBooksQuery, UpdateBookInput } from './book.schema';

const SORTABLE = ['createdAt', 'updatedAt', 'title', 'sizeBytes'] as const;

/**
 * `storageKey` is deliberately absent: readers reach the bytes through
 * `GET /books/:id/file`, so the on-disk layout is never disclosed.
 */
const bookSelect = {
  id: true,
  title: true,
  author: true,
  description: true,
  language: true,
  published: true,
  originalName: true,
  mimeType: true,
  sizeBytes: true,
  checksum: true,
  uploadedById: true,
  createdAt: true,
  updatedAt: true,
  uploadedBy: { select: { id: true, name: true, email: true } },
} as const;

/**
 * Read authorisation, expressed once:
 *   - ADMIN → every book, published or not
 *   - USER  → published books only
 *
 * There is no per-user ownership here. A book belongs to the library, not to
 * the admin who happened to upload it.
 */
function visibilityFilter(actor: AuthUser): Prisma.BookWhereInput {
  return actor.role === Role.ADMIN ? {} : { published: true };
}

export async function listBooks(queryInput: ListBooksQuery, actor: AuthUser) {
  const { page, limit, sortOrder, search, published, uploadedById } = queryInput;

  const where: Prisma.BookWhereInput = {
    AND: [
      visibilityFilter(actor),
      ...(published !== undefined ? [{ published }] : []),
      ...(uploadedById ? [{ uploadedById }] : []),
      ...(search
        ? [
            {
              OR: [
                { title: { contains: search, mode: 'insensitive' as const } },
                { author: { contains: search, mode: 'insensitive' as const } },
                { description: { contains: search, mode: 'insensitive' as const } },
              ],
            },
          ]
        : []),
    ],
  };

  const orderBy = { [resolveSort(queryInput.sortBy, SORTABLE, 'createdAt')]: sortOrder };

  const [items, total] = await prisma.$transaction([
    prisma.book.findMany({ where, orderBy, ...skipTake(page, limit), select: bookSelect }),
    prisma.book.count({ where }),
  ]);

  return { items, meta: buildMeta(total, page, limit) };
}

export async function getBookById(id: string, actor: AuthUser) {
  const book = await prisma.book.findUnique({ where: { id }, select: bookSelect });
  if (!book) throw ApiError.notFound('Book not found');

  // An unpublished book is a 404 for a reader rather than a 403: confirming
  // that a hidden id exists is itself a disclosure.
  if (!book.published && actor.role !== Role.ADMIN) throw ApiError.notFound('Book not found');

  return book;
}

/**
 * Everything a handler needs to stream the file: the absolute path plus the
 * headers that make an EPUB reader (and a browser) treat it correctly.
 */
export async function getBookFile(id: string, actor: AuthUser) {
  const book = await prisma.book.findUnique({
    where: { id },
    select: {
      id: true,
      title: true,
      published: true,
      storageKey: true,
      originalName: true,
      mimeType: true,
      sizeBytes: true,
    },
  });

  if (!book) throw ApiError.notFound('Book not found');
  if (!book.published && actor.role !== Role.ADMIN) throw ApiError.notFound('Book not found');

  if (!(await fileExists(EPUB_FOLDER, book.storageKey))) {
    // The row survived but the blob did not — a database restored against a
    // wiped volume, typically. That is an operator fault, not a client one.
    throw ApiError.internal('The file for this book is missing from storage');
  }

  return {
    path: resolveStoragePath(EPUB_FOLDER, book.storageKey),
    mimeType: book.mimeType,
    sizeBytes: book.sizeBytes,
    filename: downloadName(book.title, book.originalName),
  };
}

/**
 * Validates the bytes, stores them, then records the row.
 *
 * Order matters: the file is written first, so a database failure leaves an
 * orphan blob (harmless, sweepable) rather than a row pointing at nothing
 * (a broken download for every reader). The write is undone by hand if the
 * insert fails.
 */
export async function createBook(
  input: CreateBookInput,
  file: Express.Multer.File,
  uploaderId: string,
) {
  const verdict = inspectEpub(file.buffer);
  if (!verdict.ok) throw ApiError.badRequest(verdict.reason ?? 'Not a valid EPUB file');

  const checksum = sha256(file.buffer);

  const duplicate = await prisma.book.findUnique({
    where: { checksum },
    select: { id: true, title: true },
  });
  if (duplicate) {
    throw ApiError.conflict(`This file is already in the library as "${duplicate.title}"`);
  }

  const storageKey = newStorageKey('.epub');
  await saveFile(EPUB_FOLDER, storageKey, file.buffer);

  try {
    return await prisma.book.create({
      data: {
        ...input,
        originalName: sanitiseFilename(file.originalname),
        storageKey,
        mimeType: EPUB_MIME_TYPE,
        sizeBytes: file.size,
        checksum,
        uploadedById: uploaderId,
      },
      select: bookSelect,
    });
  } catch (error) {
    await deleteFile(EPUB_FOLDER, storageKey);
    throw error;
  }
}

/** Metadata only. Replacing the bytes means deleting and re-uploading. */
export async function updateBook(id: string, input: UpdateBookInput) {
  await assertExists(id);
  return prisma.book.update({ where: { id }, data: input, select: bookSelect });
}

export async function deleteBook(id: string): Promise<void> {
  const book = await prisma.book.findUnique({ where: { id }, select: { storageKey: true } });
  if (!book) throw ApiError.notFound('Book not found');

  // Row first: a stale blob is recoverable, a row without its file is not.
  await prisma.book.delete({ where: { id } });
  await deleteFile(EPUB_FOLDER, book.storageKey);
}

async function assertExists(id: string): Promise<void> {
  const book = await prisma.book.findUnique({ where: { id }, select: { id: true } });
  if (!book) throw ApiError.notFound('Book not found');
}

/**
 * Strips directory components and control characters from the name a browser
 * sent. It only ever lands inside a quoted `Content-Disposition`, but a
 * newline there would let an upload inject a response header.
 */
export function sanitiseFilename(name: string): string {
  const base = name.replace(/\\/g, '/').split('/').pop() ?? 'book.epub';
  const cleaned = base.replace(/[\u0000-\u001f\u007f"]/g, '').trim();
  return cleaned.slice(0, 255) || 'book.epub';
}

/** Prefers a slug of the title, falling back to whatever was uploaded. */
function downloadName(title: string, originalName: string): string {
  const slug = title
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .toLowerCase()
    .slice(0, 100);

  return slug ? `${slug}.epub` : sanitiseFilename(originalName);
}
