import { NextResponse } from 'next/server';

import { errorJson, okJson, readJson } from '@/lib/api';
import { getRagConfig } from '@/lib/config/env';
import { AppError } from '@/lib/errors';
import { generateAnswer } from '@/lib/rag/answer';
import { buildCitations } from '@/lib/rag/citations';
import { embedQuery } from '@/lib/rag/embedding';
import { NO_CONTEXT_ANSWER } from '@/lib/rag/prompt';
import { countReadyDocuments, retrieveRelevantChunks } from '@/lib/rag/retrieval';
import { requireUser } from '@/lib/supabase/server';
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
 * Everything that touches user data goes through the user-scoped Supabase
 * client, so retrieval is confined to the caller's own `ready` documents by
 * both the RPC's explicit owner filter and RLS.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const startedAt = Date.now();

  try {
    const { supabase, user } = await requireUser();

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
    // point the user at the right next action.
    const readyDocuments = await countReadyDocuments(supabase);
    if (readyDocuments === 0) {
      return okJson({
        questionId: null,
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
    const matches = await retrieveRelevantChunks(supabase, queryEmbedding, {
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
    const { data: saved, error: saveError } = await supabase
      .from('questions')
      .insert({
        user_id: user.id,
        question,
        answer,
        sources: citations,
        response_time_ms: responseTimeMs,
        model,
      })
      .select('id')
      .single();

    if (saveError) {
      // The user already has a valid answer; losing the history row should not
      // turn into a visible failure. Log it and carry on without an id, which
      // disables the feedback buttons for this answer.
      console.error('[ask] failed to persist question history', saveError.message);
    }

    const payload: AskSuccessResponse & { noDocuments: boolean } = {
      questionId: saved?.id ?? '',
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
