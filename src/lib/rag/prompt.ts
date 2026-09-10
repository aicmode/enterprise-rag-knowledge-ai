import type { MatchedChunk } from '@/lib/types';

/**
 * Prompt construction for grounded answering.
 *
 * Pure functions only, so the exact text sent to the model can be asserted in
 * tests -- prompt regressions are otherwise invisible until answer quality
 * quietly degrades.
 */

/** The answer returned when retrieval found nothing relevant. */
export const NO_CONTEXT_ANSWER = '登録されている資料からは確認できませんでした。';

/**
 * System instruction.
 *
 * The whole point of RAG here is that the assistant is *not* a general-purpose
 * chatbot: it is a reader of the user's own documents. If it answers from
 * pretrained knowledge, the citations stop matching the answer and the product
 * promise breaks. Hence the emphatic context-only framing, and an explicit
 * escape hatch so "I don't know" is an acceptable, expected output rather than
 * something the model tries to avoid.
 *
 * Note what is deliberately absent: any instruction to emit source names or
 * page numbers. Those are attached by the application from retrieval results
 * (see `citations.ts`), so the model is never in a position to invent one.
 */
export const SYSTEM_PROMPT = `あなたは社内ナレッジ検索アシスタントです。社内資料から抽出された「コンテキスト」だけを根拠に、日本語で回答してください。

厳守事項:
1. 回答は、提供されたコンテキストに書かれている内容のみを根拠とすること。
2. コンテキストに存在しない情報を推測・補完・創作しないこと。あなた自身の一般知識で補わないこと。
3. コンテキストから判断できない場合は、曖昧に答えず「登録されている資料からは確認できませんでした。」と明確に答えること。
4. コンテキストと矛盾する内容を述べないこと。
5. 資料名やページ番号を回答本文に書かないこと。出典はシステム側が自動的に表示します。
6. 箇条書きや短い段落を用い、簡潔で業務的な日本語で回答すること。
7. コンテキストの情報が部分的な場合は、判明している範囲を答えたうえで、確認できなかった点を明示すること。`;

/**
 * Render retrieved chunks as the context block.
 *
 * Each chunk is labelled with its source and page. This is *not* so the model
 * can copy them into the answer (rule 5 forbids that) -- it is so the model can
 * tell the passages apart and notice when two documents disagree.
 */
export function buildContextBlock(matches: readonly MatchedChunk[]): string {
  return matches
    .map((match, i) => {
      const header = `[コンテキスト ${i + 1}] 資料: ${match.document_title} / ページ: ${match.page_number}`;
      return `${header}\n${match.content.trim()}`;
    })
    .join('\n\n---\n\n');
}

/** Compose the user-turn message: context first, then the question. */
export function buildUserPrompt(question: string, matches: readonly MatchedChunk[]): string {
  return `以下のコンテキストのみを根拠として、質問に回答してください。

===== コンテキスト =====
${buildContextBlock(matches)}
===== コンテキストここまで =====

質問: ${question}`;
}

export interface ChatMessage {
  role: 'system' | 'user';
  content: string;
}

export function buildMessages(question: string, matches: readonly MatchedChunk[]): ChatMessage[] {
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: buildUserPrompt(question, matches) },
  ];
}
