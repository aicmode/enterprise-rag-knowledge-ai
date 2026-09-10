import { NextResponse } from 'next/server';

import { errorJson, okJson } from '@/lib/api';
import { query } from '@/lib/db/client';
import { resolveClientKey } from '@/lib/security/client-key';
import { consumeDemoQuota } from '@/lib/security/rate-limit';
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
 * chunks and question history are deleted and a fresh session id is issued. The
 * delete is scoped to the session id in the caller's own cookie, so it can only
 * ever remove the caller's own rows.
 *
 * Deleting rather than merely re-issuing the cookie matters here: an abandoned
 * session's rows would otherwise sit in a free-tier database forever with no
 * one able to reach them.
 *
 * **What reset is not.** It clears the visitor's *data*; it does not clear the
 * demo's *budget*. The rate and cost quotas are keyed on an anonymous client
 * fingerprint, not on the session id, so the new cookie starts with the same
 * remaining allowance the old one had. That is deliberate: a reset button that
 * also reset the OpenAI limits would be a one-click bypass of every limit in
 * the application, and the same is true of simply deleting the cookie.
 *
 * The endpoint is itself metered, because each call is a cascading DELETE and
 * because a loop of resets is the shape a bypass attempt would take.
 */
export async function POST(request: Request): Promise<NextResponse> {
  try {
    const sessionId = await requireSessionId();

    await consumeDemoQuota(resolveClientKey(request), 'session_reset');

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
