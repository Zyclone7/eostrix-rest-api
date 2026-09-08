import type { Request, Response } from 'express';
import { params, query } from '../../middlewares/validate';
import { ApiError } from '../../utils/ApiError';
import type { UuidParam } from '../../utils/pagination';
import * as bookService from './book.service';
import type {
  CreateBookInput,
  DownloadQuery,
  ListBooksQuery,
  UpdateBookInput,
} from './book.schema';

export async function list(req: Request, res: Response): Promise<void> {
  const { items, meta } = await bookService.listBooks(query<ListBooksQuery>(req), req.user!);
  res.json({ success: true, data: items, meta });
}

export async function getOne(req: Request, res: Response): Promise<void> {
  const book = await bookService.getBookById(params<UuidParam>(req).id, req.user!);
  res.json({ success: true, data: { book } });
}

/**
 * Streams the EPUB itself.
 *
 * `res.sendFile` is used rather than a manual read stream because it brings
 * ETag/If-None-Match and Range support with it — a reader like epub.js asks
 * for byte ranges, and a re-opened book should come back 304 rather than
 * re-downloading several megabytes.
 */
export async function download(req: Request, res: Response): Promise<void> {
  const file = await bookService.getBookFile(params<UuidParam>(req).id, req.user!);
  const asAttachment = query<DownloadQuery>(req).download === true;

  await new Promise<void>((resolve, reject) => {
    res.sendFile(
      file.path,
      {
        headers: {
          'Content-Type': file.mimeType,
          // `inline` lets a browser-based reader render it in place; the
          // filename is quoted and already stripped of control characters.
          'Content-Disposition': `${asAttachment ? 'attachment' : 'inline'}; filename="${file.filename}"`,
          // The bytes are user-specific content, never a public asset.
          'Cache-Control': 'private, max-age=0, must-revalidate',
          'X-Content-Type-Options': 'nosniff',
        },
      },
      (error) => (error ? reject(error) : resolve()),
    );
  });
}

export async function create(req: Request, res: Response): Promise<void> {
  // multer only populates `req.file` when a part named "file" was present.
  if (!req.file) throw ApiError.badRequest('An .epub file is required in the "file" field');

  const book = await bookService.createBook(
    req.body as CreateBookInput,
    req.file,
    req.user!.id,
  );
  res.status(201).json({ success: true, message: 'Book uploaded', data: { book } });
}

export async function update(req: Request, res: Response): Promise<void> {
  const book = await bookService.updateBook(
    params<UuidParam>(req).id,
    req.body as UpdateBookInput,
  );
  res.json({ success: true, message: 'Book updated', data: { book } });
}

export async function remove(req: Request, res: Response): Promise<void> {
  await bookService.deleteBook(params<UuidParam>(req).id);
  res.status(204).send();
}
