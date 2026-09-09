#!/usr/bin/env node
/**
 * Demo data retention.
 *
 * The public demo accepts uploads from anyone, so without a retention policy a
 * free-tier database fills up eventually. This deletes documents and questions
 * older than `--days` (default 30). `ON DELETE CASCADE` takes the chunks,
 * staged upload parts and feedback rows with them.
 *
 *     DATABASE_URL=postgres://... npm run db:cleanup -- --days=14
 *
 * Intended to be run manually or from a scheduled job; the application itself
 * never deletes another visitor's data.
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
  const documents = await client.query(
    `delete from documents where created_at < timezone('utc', now()) - ($1 || ' days')::interval`,
    [String(days)],
  );
  const questions = await client.query(
    `delete from questions where created_at < timezone('utc', now()) - ($1 || ' days')::interval`,
    [String(days)],
  );
  // Staged bytes for documents that never finished processing.
  const orphanParts = await client.query(
    `delete from document_upload_parts
      where created_at < timezone('utc', now()) - interval '1 day'
        and document_id in (select id from documents where status = 'ready')`,
  );

  console.log(
    `Removed ${documents.rowCount} document(s), ${questions.rowCount} question(s), ` +
      `${orphanParts.rowCount} stale upload part(s) older than ${days} day(s).`,
  );
} finally {
  await client.end();
}
