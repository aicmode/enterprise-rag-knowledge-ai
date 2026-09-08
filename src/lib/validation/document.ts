import { z } from 'zod';

import { MAX_FILE_SIZE_BYTES, MAX_PAGE_COUNT } from '@/lib/config/rag';
import { userMessageFor, type AppErrorCode } from '@/lib/errors';

/**
 * Upload validation and safe Storage path construction.
 *
 * All pure functions: the same rules run in the browser (for instant feedback)
 * and again on the server (because client-side checks are a UX feature, not a
 * security control).
 */

export const PDF_MIME_TYPE = 'application/pdf';
export const PDF_EXTENSION = '.pdf';

export interface FileValidationInput {
  name: string;
  size: number;
  type: string;
}

export type FileValidationResult =
  | { ok: true }
  | { ok: false; code: AppErrorCode; message: string };

function fail(code: AppErrorCode): FileValidationResult {
  return { ok: false, code, message: userMessageFor(code) };
}

/**
 * Reject anything that is not a plausible PDF within the size budget.
 *
 * MIME type *and* extension are both checked: browsers occasionally report an
 * empty or generic `type`, and a `.pdf` extension alone is trivially forged.
 * The real structural check happens later, when the parser actually opens the
 * file.
 */
export function validatePdfFile(file: FileValidationInput): FileValidationResult {
  const hasPdfExtension = file.name.toLowerCase().endsWith(PDF_EXTENSION);
  const hasPdfMime = file.type === PDF_MIME_TYPE;

  if (!hasPdfExtension || !hasPdfMime) {
    return fail('invalid_file_type');
  }

  if (!Number.isFinite(file.size) || file.size <= 0) {
    return fail('validation_failed');
  }

  if (file.size > MAX_FILE_SIZE_BYTES) {
    return fail('file_too_large');
  }

  return { ok: true };
}

export function validatePageCount(pageCount: number): FileValidationResult {
  if (!Number.isInteger(pageCount) || pageCount < 1) {
    return fail('pdf_unreadable');
  }
  if (pageCount > MAX_PAGE_COUNT) {
    return fail('too_many_pages');
  }
  return { ok: true };
}

/** C0/C7 control characters, written as escapes so the source stays printable. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/g;

/**
 * Reduce an arbitrary upload filename to something safe to use as a Storage
 * object key segment.
 *
 * Removes directory separators and traversal sequences (`../`), control
 * characters, and anything outside a conservative allowlist. Supabase Storage
 * keys are also awkward with non-ASCII, so a fully Japanese filename collapses
 * to a placeholder rather than being smuggled through -- the original name is
 * still preserved verbatim in `documents.file_name` for display.
 */
export function sanitizeFileName(rawName: string): string {
  const withoutPath = rawName.split(/[/\\]/).pop() ?? '';

  const base = withoutPath.toLowerCase().endsWith(PDF_EXTENSION)
    ? withoutPath.slice(0, -PDF_EXTENSION.length)
    : withoutPath;

  const sanitized = base
    .replace(CONTROL_CHARS, '')
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    // Collapse runs, then strip leading/trailing dots and dashes so no segment
    // can degenerate into "." or "..".
    .replace(/-{2,}/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/^[.-]+/, '')
    .replace(/[.-]+$/, '')
    .slice(0, 80);

  return `${sanitized || 'document'}${PDF_EXTENSION}`;
}

/** Display title derived from the filename, keeping the user's original text. */
export function deriveTitle(rawName: string): string {
  const withoutPath = rawName.split(/[/\\]/).pop() ?? rawName;
  const withoutExt = withoutPath.toLowerCase().endsWith(PDF_EXTENSION)
    ? withoutPath.slice(0, -PDF_EXTENSION.length)
    : withoutPath;
  const trimmed = withoutExt.trim();
  return (trimmed || 'Untitled document').slice(0, 300);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Build the Storage object key: `{user_id}/{document_id}/{safe_filename}`.
 *
 * The leading `{user_id}` folder is exactly what the Storage policies in
 * migration 0004 match on, so this layout is what enforces per-user isolation
 * at the bucket level. Both ids are asserted to be UUIDs, which makes it
 * impossible to inject a `/` or `..` into the prefix.
 */
export function buildStoragePath(userId: string, documentId: string, rawFileName: string): string {
  if (!UUID_RE.test(userId)) throw new Error('buildStoragePath: userId must be a UUID');
  if (!UUID_RE.test(documentId)) throw new Error('buildStoragePath: documentId must be a UUID');

  return `${userId}/${documentId}/${sanitizeFileName(rawFileName)}`;
}

/** Verify a stored path really belongs to the given user before using it. */
export function storagePathBelongsToUser(storagePath: string, userId: string): boolean {
  return storagePath.startsWith(`${userId}/`);
}

/** Body of `POST /api/documents/register`, sent after the browser upload. */
export const registerDocumentSchema = z.object({
  documentId: z.string().uuid(),
  title: z.string().trim().min(1).max(300),
  fileName: z.string().trim().min(1).max(300),
  storagePath: z.string().min(1).max(500),
  fileSize: z.number().int().positive().max(MAX_FILE_SIZE_BYTES),
});

export type RegisterDocumentInput = z.infer<typeof registerDocumentSchema>;

/** Body of `POST /api/documents/process`. */
export const processDocumentSchema = z.object({
  documentId: z.string().uuid(),
});
