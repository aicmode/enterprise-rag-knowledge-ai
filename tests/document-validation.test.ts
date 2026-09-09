import { describe, expect, it } from 'vitest';

import { MAX_FILE_SIZE_BYTES, MAX_PAGE_COUNT } from '@/lib/config/rag';
import { deriveTitle, validatePageCount, validatePdfFile } from '@/lib/validation/document';

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
