// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  after: vi.fn(),
  pruneExpiredRateLimits: vi.fn(),
  pruneExpiredStagedUploads: vi.fn(),
}));

vi.mock('next/server', () => ({ after: mocks.after }));
vi.mock('@/lib/security/rate-limit', () => ({
  pruneExpiredRateLimits: mocks.pruneExpiredRateLimits,
}));
vi.mock('@/lib/db/uploads', () => ({
  pruneExpiredStagedUploads: mocks.pruneExpiredStagedUploads,
}));

import { maybeSweepDemoRetention } from '@/lib/security/retention';

describe('opportunistic retention scheduling', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mocks.after.mockReset();
    mocks.pruneExpiredRateLimits.mockReset();
    mocks.pruneExpiredStagedUploads.mockReset();
  });

  it('registers selected cleanup with Next.js after instead of starting a floating promise', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    mocks.pruneExpiredRateLimits.mockResolvedValue(2);
    mocks.pruneExpiredStagedUploads.mockResolvedValue(3);

    maybeSweepDemoRetention();

    expect(mocks.after).toHaveBeenCalledTimes(1);
    expect(mocks.pruneExpiredRateLimits).not.toHaveBeenCalled();
    expect(mocks.pruneExpiredStagedUploads).not.toHaveBeenCalled();

    const callback = mocks.after.mock.calls[0]?.[0] as () => Promise<void>;
    await expect(callback()).resolves.toBeUndefined();
    expect(mocks.pruneExpiredRateLimits).toHaveBeenCalledTimes(1);
    expect(mocks.pruneExpiredStagedUploads).toHaveBeenCalledTimes(1);
  });

  it('logs cleanup failure without rejecting the post-response task', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    mocks.pruneExpiredRateLimits.mockRejectedValue(new Error('database unavailable'));
    mocks.pruneExpiredStagedUploads.mockResolvedValue(0);

    // Scheduling is synchronous and cannot affect the caller's response path.
    expect(() => maybeSweepDemoRetention()).not.toThrow();

    const callback = mocks.after.mock.calls[0]?.[0] as () => Promise<void>;
    await expect(callback()).resolves.toBeUndefined();
    expect(consoleError).toHaveBeenCalledWith('[retention] sweep failed', 'database unavailable');
  });

  it('does not register a task when the request is not selected', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.02);

    maybeSweepDemoRetention();

    expect(mocks.after).not.toHaveBeenCalled();
  });
});
