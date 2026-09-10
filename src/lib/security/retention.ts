import 'server-only';

import { after } from 'next/server';

import { pruneExpiredStagedUploads } from '@/lib/db/uploads';
import { pruneExpiredRateLimits } from './rate-limit';

/**
 * Opportunistic retention sweep.
 *
 * Two kinds of row grow without anyone asking for them: expired rate-limit
 * counters, and staged PDF bytes for documents that never reached `ready`.
 * `npm run db:cleanup` removes both, but this is a portfolio demo -- there is
 * no guarantee a scheduled job is running against it, and "the database filled
 * up because nobody ran the cron" is not an acceptable failure mode for a link
 * on a résumé.
 *
 * So a small fraction of eligible requests also sweep. The work is a pair of
 * indexed DELETEs that normally match nothing. `after()` registers it with the
 * request lifecycle (and therefore Vercel's `waitUntil`) so the function stays
 * alive after sending the response; a bare floating promise would not have
 * that guarantee in a serverless runtime.
 *
 * Cleanup errors are caught inside the post-response task: housekeeping must
 * remain observable in server logs, but must never be the reason a visitor's
 * request returns an error.
 */

/** Fraction of eligible requests that sweep. Low enough to be free in aggregate. */
const SWEEP_PROBABILITY = 0.02;

export async function sweepDemoRetention(): Promise<{
  rateLimitRows: number;
  stagedUploadRows: number;
}> {
  const [rateLimitRows, stagedUploadRows] = await Promise.all([
    pruneExpiredRateLimits(),
    pruneExpiredStagedUploads(),
  ]);

  return { rateLimitRows, stagedUploadRows };
}

/** Register a lifecycle-backed sweep on roughly `SWEEP_PROBABILITY` of calls. */
export function maybeSweepDemoRetention(): void {
  if (Math.random() >= SWEEP_PROBABILITY) return;

  after(async () => {
    try {
      await sweepDemoRetention();
    } catch (error) {
      console.error('[retention] sweep failed', error instanceof Error ? error.message : error);
    }
  });
}
