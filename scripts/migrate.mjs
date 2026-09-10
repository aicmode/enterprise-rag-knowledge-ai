#!/usr/bin/env node
/**
 * Migration runner.
 *
 * Applies every `db/migrations/*.sql` file that has not been applied yet, in
 * filename order, each inside its own transaction, and records it in
 * `schema_migrations`. Re-running is a no-op, so it is safe to call on every
 * deploy or after pulling new migrations.
 *
 *     DATABASE_URL=postgres://... npm run db:migrate
 *
 * The connection string is read from `DATABASE_URL` (or `--url=`). Nothing is
 * hardcoded, and the URL is never printed.
 */
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'db', 'migrations');

function resolveConnectionString() {
  const fromFlag = process.argv.find((arg) => arg.startsWith('--url='));
  const url = fromFlag ? fromFlag.slice('--url='.length) : process.env.DATABASE_URL;

  if (!url) {
    console.error(
      'DATABASE_URL is not set.\n' +
        '  Local:      DATABASE_URL=postgres://user:pass@localhost:5432/db npm run db:migrate\n' +
        '  Neon:       copy the pooled connection string from the Neon dashboard',
    );
    process.exit(1);
  }
  return url;
}

/** Neon and most hosted Postgres require TLS; a local container usually does not. */
function sslFor(connectionString) {
  const isLocal = /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(connectionString);
  if (isLocal || /sslmode=disable/.test(connectionString)) return false;
  return { rejectUnauthorized: false };
}

async function main() {
  const connectionString = resolveConnectionString();
  const client = new pg.Client({ connectionString, ssl: sslFor(connectionString) });

  await client.connect();

  try {
    await client.query(`
      create table if not exists schema_migrations (
        name        text primary key,
        checksum    text not null,
        applied_at  timestamptz not null default timezone('utc', now())
      );
    `);

    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();
    const { rows } = await client.query('select name, checksum from schema_migrations');
    const applied = new Map(rows.map((row) => [row.name, row.checksum]));

    let appliedCount = 0;

    for (const name of files) {
      const sql = await readFile(path.join(MIGRATIONS_DIR, name), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const previous = applied.get(name);

      if (previous) {
        // An edited migration would silently diverge from what the database
        // actually contains, so surface it instead of skipping quietly.
        if (previous !== checksum) {
          console.warn(`!  ${name} changed since it was applied (checksum mismatch) - skipped`);
        } else {
          console.log(`-  ${name} (already applied)`);
        }
        continue;
      }

      process.stdout.write(`>  ${name} ... `);
      try {
        await client.query('begin');
        await client.query(sql);
        await client.query('insert into schema_migrations (name, checksum) values ($1, $2)', [
          name,
          checksum,
        ]);
        await client.query('commit');
        console.log('ok');
        appliedCount += 1;
      } catch (error) {
        await client.query('rollback');
        console.log('failed');
        throw error;
      }
    }

    console.log(
      appliedCount === 0
        ? 'Database is already up to date.'
        : `Applied ${appliedCount} migration(s).`,
    );
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error('Migration failed:', error instanceof Error ? error.message : error);
  process.exit(1);
});
