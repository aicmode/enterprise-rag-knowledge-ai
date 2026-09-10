import 'server-only';

import { AppError } from '@/lib/errors';
import { query, queryOne } from '@/lib/db/client';
import {
  DEMO_LIMITS,
  secondsUntilWindowReset,
  windowExpiresAtMs,
  windowStartMs,
  type DemoLimitName,
} from './demo-limits';

/**
 * Atomic demo quota enforcement.
 *
 * The design constraint that shapes this file is concurrency. The obvious
 * implementation --
 *
 *     const used = await countSomething();     // read
 *     if (used >= max) throw rateLimited();    // check
 *     await doTheExpensiveThing();             // act
 *
 * -- is exactly what the pre-existing session quotas did, and it is not a
 * limit under load: twenty requests fired at once all read the same `used`,
 * all pass the check, and all proceed. On a public URL that is the difference
 * between a bounded OpenAI bill and an unbounded one.
 *
 * So the read, the check and the increment are one statement. `INSERT ... ON
 * CONFLICT DO UPDATE ... WHERE` makes Postgres itself serialise concurrent
 * consumers of the same counter: the second writer blocks on the primary-key
 * index until the first commits, then re-evaluates the `WHERE` against the
 * value the first actually wrote. If the increment would exceed the budget, no
 * row is updated and no row is returned -- which is the signal to refuse.
 */

/** Result of a successful consume, for callers that want to report progress. */
export interface QuotaConsumption {
  used: number;
  max: number;
  remaining: number;
}

function rateLimited(limit: DemoLimitName, detail: string): AppError {
  const { userMessage, windowSeconds } = DEMO_LIMITS[limit];

  return new AppError('rate_limited', {
    // `detail` is the *internal* message: it stays in the server log and never
    // reaches a response body. It deliberately names the bucket, never the
    // client key -- see `client-key.ts`.
    detail: `demo limit '${limit}' exceeded: ${detail} (window ${windowSeconds}s)`,
    userMessage,
    retryAfterSeconds: secondsUntilWindowReset(windowSeconds),
  });
}

/**
 * Consume `cost` units of `limit` for `clientKey`, or refuse.
 *
 * Called **before** the work it protects -- above all, before any request
 * leaves for OpenAI. Nothing here is advisory and nothing here is enforceable
 * from the browser: the client key is derived server-side from the connection,
 * and the counter lives in Postgres.
 *
 * Not refunded on failure. If ingestion dies after OCR has run, the pages were
 * still paid for, so the budget should still reflect them.
 */
export async function consumeDemoQuota(
  clientKey: string,
  limit: DemoLimitName,
  cost = 1,
): Promise<QuotaConsumption> {
  const { max, windowSeconds } = DEMO_LIMITS[limit];

  if (!Number.isFinite(cost) || cost < 0) {
    throw new AppError('validation_failed', { detail: `invalid quota cost for '${limit}'` });
  }

  const units = Math.ceil(cost);

  // A single request larger than the whole budget can never fit, in this window
  // or any other, so refuse it without touching the table.
  if (units > max) {
    throw rateLimited(limit, `single request of ${units} units exceeds max ${max}`);
  }

  const now = Date.now();
  const windowStart = new Date(windowStartMs(windowSeconds, now)).toISOString();
  const expiresAt = new Date(windowExpiresAtMs(windowSeconds, now)).toISOString();

  const row = await queryOne<{ used: number }>(
    `insert into demo_rate_limits as l (client_key, bucket, window_start, used, expires_at)
     values ($1, $2, $3::timestamptz, $4, $5::timestamptz)
     on conflict (client_key, bucket, window_start) do update
        set used = l.used + excluded.used
      where l.used + excluded.used <= $6
     returning used`,
    [clientKey, limit, windowStart, units, expiresAt, max],
  );

  if (!row) {
    // The row exists and the increment would have crossed the budget. `WHERE`
    // suppressed the update, so nothing was consumed.
    throw rateLimited(limit, `retry in ${secondsUntilWindowReset(windowSeconds, now)}s`);
  }

  return { used: row.used, max, remaining: Math.max(0, max - row.used) };
}

/**
 * Check a limit without consuming it.
 *
 * Only for describing state to the UI. Never a gate: between this read and the
 * work it would guard there is a window another request can slip through, which
 * is the very race `consumeDemoQuota` exists to close.
 */
export async function peekDemoQuota(
  clientKey: string,
  limit: DemoLimitName,
): Promise<QuotaConsumption> {
  const { max, windowSeconds } = DEMO_LIMITS[limit];
  const windowStart = new Date(windowStartMs(windowSeconds)).toISOString();

  const row = await queryOne<{ used: number }>(
    `select used from demo_rate_limits
      where client_key = $1 and bucket = $2 and window_start = $3::timestamptz`,
    [clientKey, limit, windowStart],
  );

  const used = row?.used ?? 0;
  return { used, max, remaining: Math.max(0, max - used) };
}

/**
 * Delete counter rows whose window has closed.
 *
 * The table is bounded by construction (one row per client per bucket per
 * window), but bounded is not the same as small, and a portfolio demo has no
 * scheduled job guaranteed to be running. `npm run db:cleanup` calls this, and
 * so does the request-lifecycle-backed opportunistic sweep in
 * `security/retention.ts`, so the table stays swept without relying on a
 * floating serverless promise.
 */
export async function pruneExpiredRateLimits(): Promise<number> {
  const rows = await query<{ client_key: string }>(
    `delete from demo_rate_limits
      where expires_at < timezone('utc', now())
      returning client_key`,
  );
  return rows.length;
}
