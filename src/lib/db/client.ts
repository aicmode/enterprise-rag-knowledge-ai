import 'server-only';

import { Pool, types, type PoolClient, type QueryResultRow } from 'pg';

import { getDatabaseUrl } from '@/lib/config/env';
import { AppError } from '@/lib/errors';

/**
 * The Postgres connection pool.
 *
 * One pool per server instance, created lazily on first query so `next build`
 * never needs a database. On Vercel each serverless instance keeps its own
 * pool, which is why `max` is small and why the deployment is expected to use a
 * **pooled** connection string (Neon's `-pooler` host / PgBouncer): a handful of
 * warm function instances would otherwise exhaust a free-tier direct connection
 * limit on their own.
 *
 * The pool is cached on `globalThis` so Next.js dev-server hot reloads reuse it
 * instead of leaking a new pool on every edit.
 */

const globalForPool = globalThis as unknown as { __ragPgPool?: Pool };

/**
 * Two driver defaults that would otherwise leak into the UI layer.
 *
 *  - `bigint` (int8) is returned as a *string* so that values beyond
 *    `Number.MAX_SAFE_INTEGER` are not silently mangled. Nothing here counts
 *    that high -- file sizes are capped at 10 MB and row counts at a handful --
 *    so a number is both safe and what every call site actually wants.
 *  - `timestamptz` is returned as a `Date`, which does not survive the
 *    Server-to-Client Component boundary as the ISO string the formatters take.
 *    Normalising here means every timestamp in the app has exactly one shape.
 */
types.setTypeParser(types.builtins.INT8, (value) => Number(value));
types.setTypeParser(types.builtins.TIMESTAMPTZ, (value) => new Date(value).toISOString());
types.setTypeParser(types.builtins.TIMESTAMP, (value) => new Date(`${value}Z`).toISOString());

/** Hosted Postgres requires TLS; a local container generally does not offer it. */
function sslFor(connectionString: string): false | { rejectUnauthorized: boolean } {
  const isLocal = /@(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(connectionString);
  if (isLocal || /sslmode=disable/.test(connectionString)) return false;
  return { rejectUnauthorized: false };
}

export function getPool(): Pool {
  if (globalForPool.__ragPgPool) return globalForPool.__ragPgPool;

  const connectionString = getDatabaseUrl();

  const pool = new Pool({
    connectionString,
    ssl: sslFor(connectionString),
    // Serverless instances are short-lived and numerous; stay small and give
    // idle connections back quickly.
    max: 3,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
    // A statement that runs longer than this is a bug or a lock, not work worth
    // waiting for. Ingestion never holds a single long statement.
    statement_timeout: 30_000,
  });

  // An idle client erroring (server restart, Neon scale-to-zero) must not take
  // the process down; the pool will simply open a new connection next time.
  pool.on('error', (error) => {
    console.error('[db] idle client error', error.message);
  });

  globalForPool.__ragPgPool = pool;
  return pool;
}

/**
 * Run a query, translating driver failures into an `AppError`.
 *
 * Every database error leaves this function as `database_failed`, so no SQL
 * text, constraint name or connection string can reach an HTTP response body.
 */
export async function query<T extends QueryResultRow>(
  text: string,
  params: readonly unknown[] = [],
): Promise<T[]> {
  try {
    const result = await getPool().query<T>(text, params as unknown[]);
    return result.rows;
  } catch (error) {
    throw new AppError('database_failed', {
      cause: error,
      detail: error instanceof Error ? error.message : 'query failed',
    });
  }
}

/** Run a query expected to return at most one row. */
export async function queryOne<T extends QueryResultRow>(
  text: string,
  params: readonly unknown[] = [],
): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] ?? null;
}

/**
 * Run `handler` inside a transaction on a dedicated client.
 *
 * Used where a partially applied write would leave the corpus inconsistent --
 * replacing a document's chunks, above all.
 */
export async function transaction<T>(handler: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect();

  try {
    await client.query('begin');
    const result = await handler(client);
    await client.query('commit');
    return result;
  } catch (error) {
    try {
      await client.query('rollback');
    } catch (rollbackError) {
      console.error('[db] rollback failed', rollbackError);
    }

    if (error instanceof AppError) throw error;
    throw new AppError('database_failed', {
      cause: error,
      detail: error instanceof Error ? error.message : 'transaction failed',
    });
  } finally {
    client.release();
  }
}

/**
 * Serialise an embedding for a `vector` bound parameter.
 *
 * pgvector's text input format is `[0.1,0.2,...]`, and the call site must cast
 * the parameter (`$1::vector`) because the driver sends it as text.
 */
export function toVectorLiteral(embedding: readonly number[]): string {
  return `[${embedding.join(',')}]`;
}
