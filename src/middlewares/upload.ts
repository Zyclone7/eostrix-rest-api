import path from 'node:path';
import type { NextFunction, Request, Response } from 'express';
import multer, { MulterError } from 'multer';
import { env } from '../config/env';
import { ApiError } from '../utils/ApiError';
import { EPUB_MIME_TYPE } from '../modules/books/epub';

/**
 * Multipart handling for EPUB uploads.
 *
 * Files are buffered in memory rather than streamed to a temp file: the size
 * ceiling is small and known, and it means nothing is ever written to disk
 * until the bytes have been sniffed and accepted. `express.json()`'s 100kb
 * limit does not apply to multipart bodies, so `limits` below is the only
 * thing standing between the API and an arbitrarily large upload.
 */
const ACCEPTED_MIME_TYPES = new Set([EPUB_MIME_TYPE, 'application/octet-stream']);

const epubUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: env.EPUB_MAX_BYTES,
    files: 1,
    // Metadata fields only — enough for title/author/description, not enough
    // to be used as an unbounded key-value smuggling channel.
    fields: 10,
    fieldSize: 20_000,
  },
  fileFilter: (_req, file, callback) => {
    // A cheap first pass. It rejects the obvious mistakes before a megabyte is
    // buffered; `inspectEpub` is what actually decides, once the bytes exist.
    // Some browsers send octet-stream for .epub, so the extension is the tie
    // breaker rather than a second gate.
    if (path.extname(file.originalname).toLowerCase() !== '.epub') {
      return callback(ApiError.badRequest('Only .epub files can be uploaded'));
    }
    if (!ACCEPTED_MIME_TYPES.has(file.mimetype)) {
      return callback(ApiError.badRequest(`Unexpected content type: ${file.mimetype}`));
    }
    callback(null, true);
  },
});

/** Maps multer's own failures onto the API's error vocabulary. */
function toApiError(error: MulterError): ApiError {
  switch (error.code) {
    case 'LIMIT_FILE_SIZE': {
      const megabytes = Math.round(env.EPUB_MAX_BYTES / (1024 * 1024));
      return new ApiError(413, `File exceeds the ${megabytes} MB limit`, 'PAYLOAD_TOO_LARGE');
    }
    case 'LIMIT_FILE_COUNT':
    case 'LIMIT_UNEXPECTED_FILE':
      return ApiError.badRequest('Exactly one file must be sent, in the "file" field');
    case 'LIMIT_FIELD_COUNT':
    case 'LIMIT_FIELD_KEY':
    case 'LIMIT_FIELD_VALUE':
      return ApiError.badRequest('Too much form data sent with the file');
    default:
      return ApiError.badRequest(error.message);
  }
}

/**
 * `upload.single('file')` with multer's errors translated. Without this
 * wrapper a too-large upload surfaces as an unmapped 500.
 */
export function uploadEpub(fieldName = 'file') {
  const handler = epubUpload.single(fieldName);

  return (req: Request, res: Response, next: NextFunction): void => {
    handler(req, res, (error: unknown) => {
      if (error instanceof MulterError) return next(toApiError(error));
      if (error) return next(error);
      next();
    });
  };
}
