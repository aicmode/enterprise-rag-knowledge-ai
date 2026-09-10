import { describe, expect, it } from 'vitest';

import {
  DEMO_LIMITS,
  secondsUntilWindowReset,
  windowExpiresAtMs,
  windowStartMs,
  type DemoLimitName,
} from '@/lib/security/demo-limits';

/**
 * The demo quota table and its window arithmetic.
 *
 * The numbers themselves are a product decision, but two properties are not
 * negotiable and are easy to break by editing the table: every OpenAI-spending
 * operation must have a limit, and every limit must be usable -- a bucket whose
 * window never rolls over, or whose maximum is zero, would take the demo
 * offline rather than protect it.
 */
describe('DEMO_LIMITS', () => {
  const names = Object.keys(DEMO_LIMITS) as DemoLimitName[];

  it('covers every operation that can spend OpenAI budget', () => {
    // Ask (embedding + chat), ingestion entry point, OCR pages and embedded
    // chunks. If one of these disappears, an unmetered path to the API exists.
    for (const required of ['ask', 'document_process', 'ocr_page', 'embedding_chunk'] as const) {
      expect(names).toContain(required);
    }
  });

  it('gives every bucket a usable budget and a finite window', () => {
    for (const name of names) {
      const limit = DEMO_LIMITS[name];

      expect(limit.max).toBeGreaterThan(0);
      expect(Number.isInteger(limit.max)).toBe(true);
      expect(limit.windowSeconds).toBeGreaterThan(0);
      // A window longer than a day would make a single burst lock a visitor out
      // for the rest of the week.
      expect(limit.windowSeconds).toBeLessThanOrEqual(24 * 60 * 60);
    }
  });

  it('explains itself to the visitor in Japanese, without internals', () => {
    for (const name of names) {
      const { userMessage } = DEMO_LIMITS[name];

      expect(userMessage.length).toBeGreaterThan(0);
      expect(/[぀-ヿ一-鿿]/.test(userMessage)).toBe(true);
      // The message reaches a response body, so it must not name the bucket,
      // the table, or anything else about how the limit is implemented.
      expect(userMessage).not.toContain(name);
      expect(userMessage.toLowerCase()).not.toContain('client_key');
      expect(userMessage.toLowerCase()).not.toContain('demo_rate_limits');
    }
  });

  it('prices OCR more tightly than embedding, because a page costs more', () => {
    // Both are per-day buckets; the ordering encodes that one vision page is
    // worth far more than one embedded chunk.
    expect(DEMO_LIMITS.ocr_page.max).toBeLessThan(DEMO_LIMITS.embedding_chunk.max);
  });

  it('cannot be satisfied by a single maximum-size upload', () => {
    // A 10 MB PDF must fit inside the daily byte budget, or the demo would
    // reject the very file size it advertises.
    expect(DEMO_LIMITS.upload_bytes.max).toBeGreaterThan(10 * 1024 * 1024);
  });
});

describe('window arithmetic', () => {
  const HOUR = 3600;

  it('floors to the window, so a burst shares one counter row', () => {
    const at = Date.UTC(2026, 0, 15, 10, 42, 31);

    expect(windowStartMs(HOUR, at)).toBe(Date.UTC(2026, 0, 15, 10, 0, 0));
    // Anything else in the same hour lands on the same row -- which is what
    // keeps the table O(clients x buckets) instead of O(requests).
    expect(windowStartMs(HOUR, at + 60_000)).toBe(windowStartMs(HOUR, at));
  });

  it('rolls over at the boundary', () => {
    const at = Date.UTC(2026, 0, 15, 10, 59, 59);

    expect(windowStartMs(HOUR, at + 1000)).toBeGreaterThan(windowStartMs(HOUR, at));
  });

  it('expires exactly one window after it starts', () => {
    const at = Date.UTC(2026, 0, 15, 10, 42, 31);

    expect(windowExpiresAtMs(HOUR, at) - windowStartMs(HOUR, at)).toBe(HOUR * 1000);
  });

  it('reports a positive retry delay that never exceeds the window', () => {
    for (const offsetSeconds of [0, 1, 1799, 3599]) {
      const at = Date.UTC(2026, 0, 15, 10, 0, 0) + offsetSeconds * 1000;
      const retryAfter = secondsUntilWindowReset(HOUR, at);

      // Zero would tell a client to retry immediately into another refusal.
      expect(retryAfter).toBeGreaterThan(0);
      expect(retryAfter).toBeLessThanOrEqual(HOUR);
    }
  });
});
