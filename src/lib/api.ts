import 'server-only';

import { NextResponse } from 'next/server';

import { toErrorResponse, type AppErrorCode } from '@/lib/errors';

/**
 * Uniform JSON responses for route handlers.
 *
 * Every error leaves the server through `errorJson`, which guarantees the body
 * contains only `{ error: { code, message } }` -- no stack, no driver detail.
 */

export function okJson<T>(data: T, status = 200): NextResponse {
  return NextResponse.json(data, { status });
}

export function errorJson(
  error: unknown,
  context: string,
  fallback: AppErrorCode = 'internal_error',
): NextResponse {
  const { status, body, headers } = toErrorResponse(error, context, fallback);
  return NextResponse.json(body, { status, headers });
}

/** Parse a JSON body, converting malformed input into a validation failure. */
export async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}
