import { NextResponse } from 'next/server';

import { errorJson, okJson, readJson } from '@/lib/api';
import { getRagConfig } from '@/lib/config/env';
import { MAX_QUESTIONS_PER_SESSION_PER_HOUR } from '@/lib/config/rag';
import { retrieveRelevantChunks } from '@/lib/db/chunks';
import { countReadyDocuments } from '@/lib/db/documents';
import { countRecentQuestions, saveQuestion } from '@/lib/db/questions';
import { AppError } from '@/lib/errors';
import { generateAnswer } from '@/lib/rag/answer';
import { buildCitations } from '@/lib/rag/citations';
import { embedQuery } from '@/lib/rag/embedding';
import { NO_CONTEXT_ANSWER } from '@/lib/rag/prompt';
import { resolveClientKey } from '@/lib/security/client-key';
import { consumeDemoQuota } from '@/lib/security/rate-limit';
import { maybeSweepDemoRetention } from '@/lib/security/retention';
import { requireSessionId } from '@/lib/session-server';
import type { AskSuccessResponse } from '@/lib/types';
import { askRequestSchema } from '@/lib/validation/question';

export const runtime = 'nodejs';
export const maxDuration = 60;

/**
 * The question-answering endpoint -- the full RAG loop in one request:
 *
 *   validate -> embed question -> pgvector search -> threshold -> build context
 *            -> LLM -> app-built citations -> persist to history
 *
 * Retrieval is confined to the calling session's own `ready` documents by the
 * session id that `match_document_chunks` takes as its first argument, and that
 * id comes from the demo-session cookie rather than from anything the caller
 * sent.
 *
 * Cost guard: this endpoint spends the owner's OpenAI budget twice per call
 * (one embedding, one chat completion), so the `ask` quota is consumed *before*
 * either request is built. The quota is keyed on the client fingerprint rather
 * than on the session, because a session id is a cookie the caller can throw
 * away; see `src/lib/security/rate-limit.ts`.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const startedAt = Date.now();

  try {
    const sessionId = await requireSessionId();

    const parsed = askRequestSchema.safeParse(await readJson(request));
    if (!parsed.success) {
      throw new AppError('validation_failed', {
        detail: parsed.error.message,
        userMessage: parsed.error.issues[0]?.message ?? '質問を入力してください。',
      });
    }

    const question = parsed.data.question;
    const config = getRagConfig();

    // Distinguish "you have no documents" from "nothing matched" so the UI can
    // point the visitor at the right next action.
    const readyDocuments = await countReadyDocuments(sessionId);
    if (readyDocuments === 0) {
      return okJson({
        questionId: '',
        question,
        answer:
          '回答の根拠となる資料がまだ登録されていません。「資料」画面からPDFをアップロードしてください。',
        citations: [],
        model: config.chatModel,
        responseTimeMs: Date.now() - startedAt,
        noRelevantContext: true,
        noDocuments: true,
      });
    }

    // --- Cost guard --------------------------------------------------------
    // Everything below this line spends the owner's OpenAI budget, so the
    // quotas are consumed here: after the free "you have no documents" path,
    // and before the first request is built.
    //
    // `ask` is keyed on the client fingerprint, so clearing the cookie or
    // pressing "reset" does not reset it, and it is consumed with a single
    // atomic statement so a burst of parallel requests cannot all pass the
    // same check.
    const clientKey = resolveClientKey(request);
    await consumeDemoQuota(clientKey, 'ask');
    maybeSweepDemoRetention();

    // Session-scoped cap, kept as a second, per-visitor bound. On its own it
    // would be bypassed by a new cookie, which is exactly what the quota above
    // is there to prevent.
    const recentQuestions = await countRecentQuestions(sessionId);
    if (recentQuestions >= MAX_QUESTIONS_PER_SESSION_PER_HOUR) {
      throw new AppError('rate_limited', {
        detail: `${recentQuestions} questions in the last hour`,
        userMessage:
          '公開デモのため、1時間あたりの質問数に上限があります。しばらく時間をおいてからお試しください。',
      });
    }

    // --- Retrieval ---------------------------------------------------------
    const queryEmbedding = await embedQuery(question);
    const matches = await retrieveRelevantChunks(sessionId, queryEmbedding, {
      topK: config.topK,
      similarityThreshold: config.similarityThreshold,
    });

    // --- Answer ------------------------------------------------------------
    // With no matches above the threshold, `generateAnswer` returns the fixed
    // "not found in your documents" sentence rather than letting the model
    // improvise from general knowledge.
    const { answer, model } = await generateAnswer({
      question,
      matches,
      model: config.chatModel,
    });

    // --- Citations ---------------------------------------------------------
    // Built from the retrieval rows, never parsed out of the model's output.
    const citations = buildCitations(matches);
    const responseTimeMs = Date.now() - startedAt;

    // --- History -----------------------------------------------------------
    let questionId = '';
    try {
      questionId = await saveQuestion({
        sessionId,
        question,
        answer,
        citations,
        responseTimeMs,
        model,
      });
    } catch (saveError) {
      // The visitor already has a valid answer; losing the history row should
      // not turn into a visible failure. Log it and carry on without an id,
      // which disables the feedback buttons for this answer.
      console.error('[ask] failed to persist question history', saveError);
    }

    const payload: AskSuccessResponse & { noDocuments: boolean } = {
      questionId,
      question,
      answer,
      citations,
      model,
      responseTimeMs,
      noRelevantContext: matches.length === 0 || answer === NO_CONTEXT_ANSWER,
      noDocuments: false,
    };

    return okJson(payload);
  } catch (error) {
    return errorJson(error, 'ask', 'answer_failed');
  }
}
