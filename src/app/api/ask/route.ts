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
 * id comes from the httpOnly cookie rather than from anything the caller sent.
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

    // Public demo: every answer costs the owner an embedding call plus a chat
    // completion, so a single visitor's hourly volume is capped.
    const recentQuestions = await countRecentQuestions(sessionId);
    if (recentQuestions >= MAX_QUESTIONS_PER_SESSION_PER_HOUR) {
      throw new AppError('rate_limited', {
        detail: `${recentQuestions} questions in the last hour`,
      });
    }

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
