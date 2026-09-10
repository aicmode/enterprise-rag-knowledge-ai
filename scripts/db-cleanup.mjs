#!/usr/bin/env node
/**
 * Demo data retention.
 *
 * The public demo accepts uploads from anyone, so without a retention policy a
 * free-tier database fills up eventually. Four sweeps, in increasing order of
 * how long the data is worth keeping:
 *
 *  1. **Staged PDF bytes** for documents that never reached `ready` -- a
 *     `failed` document past its retry window, or an upload that was completed
 *     and then abandoned. These are `bytea`, so they are the fastest way to
 *     fill a free tier and the first thing to go. Default 24 hours; the
 *     documents themselves are left alone, only their bytes are dropped.
 *  2. **Expired rate-limit counters**, whose window has closed.
 *  3. **Documents** older than `--days`. `ON DELETE CASCADE` takes their
 *     chunks, any remaining staged parts and their feedback with them.
 *  4. **Questions** older than `--days`, with their feedback.
 *
 *     DATABASE_URL=postgres://... npm run db:cleanup -- --days=14 --staged-hours=6
 *
 * Intended to be run manually or from a scheduled job. The application also
 * sweeps 1 and 2 opportunistically via Next.js `after()`
 * (`src/lib/security/retention.ts`), so Vercel keeps the selected cleanup task
 * alive after sending the response and a demo with no cron attached still does
 * not grow without bound.
 */
import pg from 'pg';

function arg(name, fallback) {
  const found = process.argv.find((value) => value.startsWith(`--${name}=`));
  return found ? found.slice(name.length + 3) : fallback;
}

const days = Number.parseInt(arg('days', '30'), 10);

if (!Number.isFinite(days) || days < 1) {
  console.error('--days must be a positive integer');
  process.exit(1);
}

// Keep in sync with STAGED_UPLOAD_RETENTION_HOURS in src/lib/config/rag.ts.
const stagedHours = Number.parseInt(arg('staged-hours', '24'), 10);

if (!Number.isFinite(stagedHours) || stagedHours < 1) {
  console.error('--staged-hours must be a positive integer');
  process.exit(1);
}

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}

const isLocal = /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(connectionString);
const client = new pg.Client({
  connectionString,
  ssl: isLocal ? false : { rejectUnauthorized: false },
});

await client.connect();

try {
  // 1. Staged bytes whose document will never use them again. `ready` is
  //    excluded only because ingestion already drops those; `processing` is
  //    excluded because a run in flight is still reading them.
  const staleParts = await client.query(
    `delete from document_upload_parts p
      using documents d
      where d.id = p.document_id
        and d.status in ('failed', 'uploaded')
        and p.created_at < timezone('utc', now()) - ($1 || ' hours')::interval`,
    [String(stagedHours)],
  );

  // 2. Rate-limit counters whose window has closed. The table is absent on a
  //    database that has not had migration 0003 applied yet, which is not worth
  //    failing the whole cleanup over.
  let rateLimits = { rowCount: 0 };
  try {
    rateLimits = await client.query(
      `delete from demo_rate_limits where expires_at < timezone('utc', now())`,
    );
  } catch (error) {
    console.warn(`!  skipped demo_rate_limits (${error.message})`);
  }

  // 3-4. Old demo data. Cascades take chunks, remaining parts and feedback.
  const documents = await client.query(
    `delete from documents where created_at < timezone('utc', now()) - ($1 || ' days')::interval`,
    [String(days)],
  );
  const questions = await client.query(
    `delete from questions where created_at < timezone('utc', now()) - ($1 || ' days')::interval`,
    [String(days)],
  );

  console.log(
    `Removed ${staleParts.rowCount} staged upload part(s) older than ${stagedHours}h, ` +
      `${rateLimits.rowCount} expired rate-limit counter(s), ` +
      `${documents.rowCount} document(s) and ${questions.rowCount} question(s) ` +
      `older than ${days} day(s).`,
  );
} finally {
  await client.end();
}
