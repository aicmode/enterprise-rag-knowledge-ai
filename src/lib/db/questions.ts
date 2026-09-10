import 'server-only';

import { AppError } from '@/lib/errors';
import type {
  Citation,
  FeedbackRating,
  QuestionRow,
  QuestionSummary,
  QuestionWithFeedback,
} from '@/lib/types';
import { query, queryOne } from './client';

/**
 * Question history and answer feedback.
 *
 * `sources` is stored as JSONB: it is a snapshot of what the model was given at
 * answer time, so a history entry stays readable and verifiable even after the
 * source document has been deleted or re-processed with different chunk
 * boundaries.
 */

export interface SaveQuestionInput {
  sessionId: string;
  question: string;
  answer: string;
  citations: readonly Citation[];
  responseTimeMs: number;
  model: string;
}

export async function saveQuestion(input: SaveQuestionInput): Promise<string> {
  const row = await queryOne<{ id: string }>(
    `insert into questions (session_id, question, answer, sources, response_time_ms, model)
     values ($1, $2, $3, $4::jsonb, $5, $6)
     returning id`,
    [
      input.sessionId,
      input.question,
      input.answer,
      JSON.stringify(input.citations),
      input.responseTimeMs,
      input.model,
    ],
  );

  if (!row) {
    throw new AppError('database_failed', { detail: 'insert returned no question row' });
  }

  return row.id;
}

/**
 * History list.
 *
 * Only the fields the list actually renders are selected; the full answer text
 * and every citation body would be a large payload for a screen that shows one
 * line per row, so `sources` is reduced to a count in SQL.
 */
export async function listQuestions(sessionId: string, limit = 100): Promise<QuestionSummary[]> {
  return query<QuestionSummary>(
    `select q.id,
            q.question,
            q.answer,
            coalesce(jsonb_array_length(q.sources), 0) as source_count,
            q.created_at,
            f.rating
       from questions q
       left join answer_feedback f
         on f.question_id = q.id and f.session_id = q.session_id
      where q.session_id = $1
      order by q.created_at desc
      limit $2`,
    [sessionId, limit],
  );
}

export async function getQuestion(
  sessionId: string,
  questionId: string,
): Promise<QuestionWithFeedback | null> {
  return queryOne<QuestionWithFeedback>(
    `select q.id, q.session_id, q.question, q.answer, q.sources,
            q.response_time_ms, q.model, q.created_at, f.rating
       from questions q
       left join answer_feedback f
         on f.question_id = q.id and f.session_id = q.session_id
      where q.id = $1 and q.session_id = $2`,
    [questionId, sessionId],
  );
}

export async function questionExists(sessionId: string, questionId: string): Promise<boolean> {
  const row = await queryOne<{ id: string }>(
    'select id from questions where id = $1 and session_id = $2',
    [questionId, sessionId],
  );
  return row !== null;
}

export async function countQuestions(sessionId: string): Promise<number> {
  const row = await queryOne<{ count: string }>(
    'select count(*)::text as count from questions where session_id = $1',
    [sessionId],
  );
  return Number(row?.count ?? 0);
}

/** Questions asked in the last hour, used for the demo rate limit. */
export async function countRecentQuestions(sessionId: string, withinMinutes = 60): Promise<number> {
  const row = await queryOne<{ count: string }>(
    `select count(*)::text as count
       from questions
      where session_id = $1
        and created_at > timezone('utc', now()) - ($2 || ' minutes')::interval`,
    [sessionId, String(withinMinutes)],
  );
  return Number(row?.count ?? 0);
}

/**
 * Record (or change) a Helpful / Not Helpful rating.
 *
 * UPSERT against the `(question_id, session_id)` unique constraint, so a
 * visitor changing their mind updates their existing vote instead of creating a
 * second row. Without that constraint the Helpful rate could be inflated just
 * by clicking repeatedly.
 */
export async function upsertFeedback(
  sessionId: string,
  questionId: string,
  rating: FeedbackRating,
  comment: string | null,
): Promise<{ id: string; rating: FeedbackRating }> {
  const row = await queryOne<{ id: string; rating: FeedbackRating }>(
    `insert into answer_feedback (question_id, session_id, rating, comment)
     values ($1, $2, $3, $4)
     on conflict (question_id, session_id)
       do update set rating = excluded.rating, comment = excluded.comment
     returning id, rating`,
    [questionId, sessionId, rating, comment],
  );

  if (!row) {
    throw new AppError('database_failed', { detail: 'upsert returned no feedback row' });
  }

  return row;
}

export interface FeedbackTotals {
  total: number;
  helpful: number;
}

export async function getFeedbackTotals(sessionId: string): Promise<FeedbackTotals> {
  const row = await queryOne<{ total: string; helpful: string }>(
    `select count(*)::text as total,
            count(*) filter (where rating = 'helpful')::text as helpful
       from answer_feedback
      where session_id = $1`,
    [sessionId],
  );

  return { total: Number(row?.total ?? 0), helpful: Number(row?.helpful ?? 0) };
}

export async function listRecentQuestions(
  sessionId: string,
  limit: number,
): Promise<Pick<QuestionRow, 'id' | 'question' | 'created_at'>[]> {
  return query<Pick<QuestionRow, 'id' | 'question' | 'created_at'>>(
    `select id, question, created_at
       from questions
      where session_id = $1
      order by created_at desc
      limit $2`,
    [sessionId, limit],
  );
}
