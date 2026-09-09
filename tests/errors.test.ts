import { describe, expect, it, vi } from 'vitest';

import { AppError, toAppError, toErrorResponse, userMessageFor } from '@/lib/errors';

describe('AppError', () => {
  it('exposes a Japanese user message and an HTTP status per code', () => {
    const error = new AppError('file_too_large');

    expect(error.userMessage).toContain('10MB');
    expect(error.status).toBe(413);
  });

  it('keeps the internal detail separate from the user message', () => {
    const error = new AppError('database_failed', {
      detail: 'duplicate key value violates unique constraint "documents_pkey"',
    });

    expect(error.message).toContain('duplicate key');
    expect(error.userMessage).not.toContain('duplicate key');
  });

  it('preserves the original error as the cause', () => {
    const cause = new Error('ECONNREFUSED 10.0.0.1:5432');
    const error = new AppError('database_failed', { cause });

    expect(error.cause).toBe(cause);
  });

  it('allows a specific user message to override the default', () => {
    const error = new AppError('validation_failed', { userMessage: '質問は1000文字以内です。' });

    expect(error.userMessage).toBe('質問は1000文字以内です。');
  });
});

describe('toAppError', () => {
  it('returns an existing AppError unchanged', () => {
    const original = new AppError('not_found');

    expect(toAppError(original)).toBe(original);
  });

  it('wraps a plain Error with the given fallback code', () => {
    const wrapped = toAppError(new Error('boom'), 'embedding_failed');

    expect(wrapped.code).toBe('embedding_failed');
    expect(wrapped.message).toBe('boom');
  });

  it('wraps a non-Error throwable', () => {
    expect(toAppError('something broke').code).toBe('internal_error');
  });
});

describe('toErrorResponse', () => {
  it('never leaks internal details into the response body', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const internal = new Error(
      'PostgresError: relation "document_chunks" does not exist at line 42',
    );
    const { status, body } = toErrorResponse(internal, 'test', 'database_failed');

    expect(status).toBe(500);
    expect(body.error.code).toBe('database_failed');
    expect(body.error.message).toBe(userMessageFor('database_failed'));

    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('PostgresError');
    expect(serialized).not.toContain('document_chunks');
    expect(serialized).not.toContain('line 42');
    expect(serialized).not.toContain('stack');

    spy.mockRestore();
  });

  it('logs the internal detail server-side', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    toErrorResponse(new Error('internal detail'), 'ctx', 'storage_failed');

    expect(spy).toHaveBeenCalled();
    expect(String(spy.mock.calls[0]?.[0])).toContain('internal detail');

    spy.mockRestore();
  });

  it('maps auth failures to 401 and not-found to 404', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(toErrorResponse(new AppError('unauthorized'), 'ctx').status).toBe(401);
    expect(toErrorResponse(new AppError('not_found'), 'ctx').status).toBe(404);

    spy.mockRestore();
  });

  it('gives every error code a non-empty Japanese message', () => {
    const codes = [
      'unauthorized',
      'forbidden',
      'not_found',
      'validation_failed',
      'invalid_file_type',
      'file_too_large',
      'too_many_pages',
      'pdf_unreadable',
      'pdf_no_text',
      'ocr_failed',
      'ocr_timeout',
      'storage_failed',
      'database_failed',
      'embedding_failed',
      'retrieval_failed',
      'answer_failed',
      'rate_limited',
      'already_processing',
      'internal_error',
    ] as const;

    for (const code of codes) {
      const message = userMessageFor(code);
      expect(message.length).toBeGreaterThan(0);
      expect(/[぀-ヿ一-鿿]/.test(message)).toBe(true);
    }
  });
});
