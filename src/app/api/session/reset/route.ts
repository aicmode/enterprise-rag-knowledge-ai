import { NextResponse } from 'next/server';

import { errorJson, okJson } from '@/lib/api';
import { query } from '@/lib/db/client';
import {
  createSessionId,
  demoSessionCookieOptions,
  DEMO_SESSION_COOKIE,
} from '@/lib/session';
import { requireSessionId } from '@/lib/session-server';

export const runtime = 'nodejs';

/**
 * Start a clean demo session.
 *
 * This is the demo's equivalent of signing out: the visitor's uploaded PDFs,
 * chunks and question history are deleted and a fresh session id is issued.
 * Two things make that safe to expose without authentication -- the delete is
 * scoped to the session id in the caller's own cookie, and the cookie is
 * `httpOnly`, so page scripts cannot substitute somebody else's id.
 *
 * Deleting rather than merely re-issuing the cookie matters here: an abandoned
 * session's rows would otherwise sit in a free-tier database forever with no
 * one able to reach them.
 */
export async function POST(): Promise<NextResponse> {
  try {
    const sessionId = await requireSessionId();

    // Chunks, staged upload parts and feedback follow via ON DELETE CASCADE.
    await query('delete from documents where session_id = $1', [sessionId]);
    await query('delete from questions where session_id = $1', [sessionId]);

    const response = okJson({ reset: true });
    response.cookies.set(DEMO_SESSION_COOKIE, createSessionId(), demoSessionCookieOptions());

    return response;
  } catch (error) {
    return errorJson(error, 'session/reset', 'database_failed');
  }
}
