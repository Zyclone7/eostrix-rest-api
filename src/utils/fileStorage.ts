import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { env } from '../config/env';
import { logger } from '../config/logger';

/**
 * Local-disk blob storage.
 *
 * This module is the only place that knows where bytes physically live, so
 * moving the library to S3/R2/GCS means reimplementing these four functions
 * and nothing else. Note that a container filesystem is usually ephemeral —
 * point `UPLOAD_DIR` at a mounted volume in production.
 */

/** Sub-folder per resource kind, so one bucket does not become a dumping ground. */
export const EPUB_FOLDER = 'epubs';

function root(folder: string): string {
  return path.resolve(env.UPLOAD_DIR, folder);
}

/**
 * Resolves a storage key to an absolute path, refusing anything that escapes
 * its folder. Keys are generated server-side, so this is defence in depth
 * against a future caller-supplied key — path traversal is the classic way a
 * file API turns into arbitrary file read.
 */
export function resolveStoragePath(folder: string, key: string): string {
  const base = root(folder);
  const resolved = path.resolve(base, key);
  if (resolved !== path.join(base, path.basename(key))) {
    throw new Error(`Refusing to resolve storage key outside ${folder}: ${key}`);
  }
  return resolved;
}

/** `<uuid>.<ext>` — never derived from the uploaded filename. */
export function newStorageKey(extension: string): string {
  return `${crypto.randomUUID()}${extension}`;
}

export function sha256(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/** Writes the blob and returns its absolute path. Creates the folder on demand. */
export async function saveFile(folder: string, key: string, data: Buffer): Promise<string> {
  const target = resolveStoragePath(folder, key);
  await fs.mkdir(path.dirname(target), { recursive: true });
  // `wx` fails instead of overwriting: a key collision must never silently
  // clobber another book's bytes.
  await fs.writeFile(target, data, { flag: 'wx' });
  return target;
}

export async function fileExists(folder: string, key: string): Promise<boolean> {
  try {
    await fs.access(resolveStoragePath(folder, key));
    return true;
  } catch {
    return false;
  }
}

/**
 * Best-effort delete. A missing file is success — the caller's goal is that
 * the blob is gone, and a failed unlink must not fail the request that has
 * already removed the row.
 */
export async function deleteFile(folder: string, key: string): Promise<void> {
  try {
    await fs.unlink(resolveStoragePath(folder, key));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return;
    logger.error({ err: error, folder, key }, 'Failed to delete stored file');
  }
}
