import { NextResponse } from 'next/server';

import { errorJson, okJson, readJson } from '@/lib/api';
import { questionExists, upsertFeedback } from '@/lib/db/questions';
import { AppError } from '@/lib/errors';
import { requireSessionId } from '@/lib/session-server';
import { feedbackSchema } from '@/lib/validation/question';

export const runtime = 'nodejs';

/**
 * Record (or change) a Helpful / Not Helpful rating on an answer.
 *
 * Uses UPSERT against the `(question_id, session_id)` unique constraint, so a
 * visitor changing their mind updates their existing vote instead of creating a
 * second row. Without that constraint the Helpful rate could be inflated by
 * clicking repeatedly.
 *
 * Ownership is checked first: you may only rate an answer to a question your
 * own session asked.
 */
export async function POST(request: Request): Promise<NextResponse> {
  try {
    const sessionId = await requireSessionId();

    const parsed = feedbackSchema.safeParse(await readJson(request));
    if (!parsed.success) {
      throw new AppError('validation_failed', { detail: parsed.error.message });
    }

    const { questionId, rating, comment } = parsed.data;

    if (!(await questionExists(sessionId, questionId))) {
      throw new AppError('not_found', { detail: 'question not found for this session' });
    }

    const feedback = await upsertFeedback(sessionId, questionId, rating, comment ?? null);

    return okJson({ feedback });
  } catch (error) {
    return errorJson(error, 'feedback', 'database_failed');
  }
}
