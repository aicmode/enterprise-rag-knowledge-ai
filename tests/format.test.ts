import { describe, expect, it } from 'vitest';

import { formatBytes, formatDateTime, formatDuration, formatPercent, truncate } from '@/lib/format';

describe('formatBytes', () => {
  it('renders bytes, KB, MB and GB', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(10 * 1024 * 1024)).toBe('10 MB');
    expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe('3.0 GB');
  });

  it('handles zero and invalid input', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(-1)).toBe('-');
    expect(formatBytes(Number.NaN)).toBe('-');
  });
});

describe('formatDateTime', () => {
  it('formats an ISO timestamp in a fixed timezone', () => {
    // Pinned to Asia/Tokyo so server and client render identically and React
    // does not report a hydration mismatch.
    expect(formatDateTime('2026-09-08T05:32:00.000Z')).toBe('2026/09/08 14:32');
  });

  it('returns a placeholder for an invalid date', () => {
    expect(formatDateTime('not-a-date')).toBe('-');
  });
});

describe('formatDuration', () => {
  it('renders sub-second and multi-second durations', () => {
    expect(formatDuration(450)).toBe('450ミリ秒');
    expect(formatDuration(1400)).toBe('1.4秒');
  });

  it('returns a placeholder for null', () => {
    expect(formatDuration(null)).toBe('-');
  });
});

describe('truncate', () => {
  it('leaves short text alone', () => {
    expect(truncate('短い', 10)).toBe('短い');
  });

  it('truncates long text with an ellipsis', () => {
    expect(truncate('あ'.repeat(50), 10)).toBe(`${'あ'.repeat(10)}…`);
  });

  it('collapses whitespace before measuring', () => {
    expect(truncate('a   b', 10)).toBe('a b');
  });
});

describe('formatPercent', () => {
  it('renders a ratio as a whole percentage', () => {
    expect(formatPercent(0.6667)).toBe('67%');
    expect(formatPercent(1)).toBe('100%');
    expect(formatPercent(0)).toBe('0%');
  });
});
