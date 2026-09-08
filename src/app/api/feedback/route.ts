import { NextResponse } from 'next/server';

import { errorJson, okJson, readJson } from '@/lib/api';
import { AppError } from '@/lib/errors';
import { requireUser } from '@/lib/supabase/server';
import { feedbackSchema } from '@/lib/validation/question';

export const runtime = 'nodejs';

/**
 * Record (or change) a Helpful / Not Helpful rating on an answer.
 *
 * Uses UPSERT against the `(question_id, user_id)` unique constraint, so a user
 * changing their mind updates their existing vote instead of creating a second
 * row. Without that constraint a user could inflate the Helpful rate by
 * clicking repeatedly.
 *
 * Ownership is checked explicitly: you may only rate an answer to your own
 * question. RLS enforces the same rule, so this is defence in depth.
 */
export async function POST(request: Request): Promise<NextResponse> {
  try {
    const { supabase, user } = await requireUser();

    const parsed = feedbackSchema.safeParse(await readJson(request));
    if (!parsed.success) {
      throw new AppError('validation_failed', { detail: parsed.error.message });
    }

    const { questionId, rating, comment } = parsed.data;

    const { data: question, error: lookupError } = await supabase
      .from('questions')
      .select('id')
      .eq('id', questionId)
      .eq('user_id', user.id)
      .maybeSingle();

    if (lookupError) {
      throw new AppError('database_failed', { cause: lookupError, detail: lookupError.message });
    }
    if (!question) {
      throw new AppError('not_found', { detail: 'question not found for user' });
    }

    const { data, error } = await supabase
      .from('answer_feedback')
      .upsert(
        {
          question_id: questionId,
          user_id: user.id,
          rating,
          comment: comment ?? null,
        },
        { onConflict: 'question_id,user_id' },
      )
      .select('id, rating')
      .single();

    if (error) {
      throw new AppError('database_failed', { cause: error, detail: error.message });
    }

    return okJson({ feedback: data });
  } catch (error) {
    return errorJson(error, 'feedback', 'database_failed');
  }
}
