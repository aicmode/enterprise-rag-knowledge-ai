import { describe, expect, it } from 'vitest';

import { MAX_FILE_SIZE_BYTES, MAX_PAGE_COUNT } from '@/lib/config/rag';
import {
  buildStoragePath,
  deriveTitle,
  sanitizeFileName,
  storagePathBelongsToUser,
  validatePageCount,
  validatePdfFile,
} from '@/lib/validation/document';

const USER_ID = '11111111-2222-4333-8444-555555555555';
const DOCUMENT_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function pdf(overrides: Partial<{ name: string; size: number; type: string }> = {}) {
  return { name: 'manual.pdf', size: 1024, type: 'application/pdf', ...overrides };
}

describe('validatePdfFile', () => {
  it('accepts a normal PDF', () => {
    expect(validatePdfFile(pdf())).toEqual({ ok: true });
  });

  it('rejects a non-PDF MIME type even with a .pdf extension', () => {
    const result = validatePdfFile(pdf({ type: 'application/x-msdownload' }));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('invalid_file_type');
  });

  it('rejects a PDF MIME type with a non-PDF extension', () => {
    const result = validatePdfFile(pdf({ name: 'payload.exe' }));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('invalid_file_type');
  });

  it('rejects an empty browser-reported MIME type', () => {
    const result = validatePdfFile(pdf({ type: '' }));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('invalid_file_type');
  });

  it('accepts a file exactly at the size limit', () => {
    expect(validatePdfFile(pdf({ size: MAX_FILE_SIZE_BYTES })).ok).toBe(true);
  });

  it('rejects a file one byte over the limit', () => {
    const result = validatePdfFile(pdf({ size: MAX_FILE_SIZE_BYTES + 1 }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('file_too_large');
      expect(result.message).toContain('10MB');
    }
  });

  it('rejects an empty file', () => {
    expect(validatePdfFile(pdf({ size: 0 })).ok).toBe(false);
  });

  it('accepts an uppercase .PDF extension', () => {
    expect(validatePdfFile(pdf({ name: 'MANUAL.PDF' })).ok).toBe(true);
  });
});

describe('validatePageCount', () => {
  it('accepts a count at the limit', () => {
    expect(validatePageCount(MAX_PAGE_COUNT).ok).toBe(true);
  });

  it('rejects a count over the limit', () => {
    const result = validatePageCount(MAX_PAGE_COUNT + 1);

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('too_many_pages');
  });

  it('rejects zero and non-integer counts as unreadable', () => {
    expect(validatePageCount(0).ok).toBe(false);
    expect(validatePageCount(1.5).ok).toBe(false);
  });
});

describe('sanitizeFileName', () => {
  it('keeps a simple ASCII name intact', () => {
    expect(sanitizeFileName('employee-handbook.pdf')).toBe('employee-handbook.pdf');
  });

  it('strips directory components', () => {
    expect(sanitizeFileName('folder/sub/report.pdf')).toBe('report.pdf');
    expect(sanitizeFileName('C:\\Users\\me\\report.pdf')).toBe('report.pdf');
  });

  it('neutralises path traversal attempts', () => {
    const result = sanitizeFileName('../../../etc/passwd.pdf');

    expect(result).not.toContain('..');
    expect(result).not.toContain('/');
    expect(result.endsWith('.pdf')).toBe(true);
  });

  it('never returns a name that is only dots', () => {
    expect(sanitizeFileName('...pdf')).toBe('document.pdf');
    expect(sanitizeFileName('..')).toBe('document.pdf');
  });

  it('replaces non-ASCII names with a usable placeholder', () => {
    const result = sanitizeFileName('就業規則.pdf');

    expect(result.endsWith('.pdf')).toBe(true);
    expect(/^[a-zA-Z0-9._-]+$/.test(result)).toBe(true);
  });

  it('always produces a .pdf suffix', () => {
    expect(sanitizeFileName('noextension')).toBe('noextension.pdf');
  });

  it('caps the length of very long names', () => {
    expect(sanitizeFileName(`${'a'.repeat(500)}.pdf`).length).toBeLessThanOrEqual(84);
  });

  it('produces only characters that are safe in a storage key', () => {
    const inputs = ['a b c.pdf', 'file#1?.pdf', 'tab\tname.pdf', '%2e%2e.pdf', "quote'.pdf"];

    for (const input of inputs) {
      expect(/^[a-zA-Z0-9._-]+\.pdf$/.test(sanitizeFileName(input))).toBe(true);
    }
  });
});

describe('deriveTitle', () => {
  it('keeps the original Japanese name for display', () => {
    expect(deriveTitle('就業規則.pdf')).toBe('就業規則');
  });

  it('drops the extension and any directory part', () => {
    expect(deriveTitle('docs/handbook.PDF')).toBe('handbook');
  });

  it('falls back for an empty name', () => {
    expect(deriveTitle('   ')).toBe('Untitled document');
  });
});

describe('buildStoragePath', () => {
  it('produces {user_id}/{document_id}/{safe_filename}', () => {
    expect(buildStoragePath(USER_ID, DOCUMENT_ID, 'manual.pdf')).toBe(
      `${USER_ID}/${DOCUMENT_ID}/manual.pdf`,
    );
  });

  it('places the user id first so the Storage policy can match on it', () => {
    const path = buildStoragePath(USER_ID, DOCUMENT_ID, 'x.pdf');

    expect(path.split('/')[0]).toBe(USER_ID);
  });

  it('cannot be made to escape the user folder via the filename', () => {
    const path = buildStoragePath(USER_ID, DOCUMENT_ID, '../../other-user/secret.pdf');

    expect(path.startsWith(`${USER_ID}/${DOCUMENT_ID}/`)).toBe(true);
    expect(path.split('/')).toHaveLength(3);
    expect(path).not.toContain('..');
  });

  it('rejects a non-UUID user id', () => {
    expect(() => buildStoragePath('../admin', DOCUMENT_ID, 'x.pdf')).toThrow();
  });

  it('rejects a non-UUID document id', () => {
    expect(() => buildStoragePath(USER_ID, 'not-a-uuid', 'x.pdf')).toThrow();
  });
});

describe('storagePathBelongsToUser', () => {
  it('accepts a path inside the user folder', () => {
    expect(storagePathBelongsToUser(`${USER_ID}/${DOCUMENT_ID}/a.pdf`, USER_ID)).toBe(true);
  });

  it("rejects another user's path", () => {
    const other = '99999999-8888-4777-8666-555555555555';

    expect(storagePathBelongsToUser(`${other}/${DOCUMENT_ID}/a.pdf`, USER_ID)).toBe(false);
  });

  it('rejects a prefix that merely starts with the id', () => {
    expect(storagePathBelongsToUser(`${USER_ID}-evil/doc/a.pdf`, USER_ID)).toBe(false);
  });
});
