/**
 * The sample questions the public demo answers.
 *
 * Kept in their own module, holding nothing but strings, because this is the
 * one part of the demo the browser needs: the 質問の例 chips on `/ask` are
 * rendered by a Client Component. The corpus, the scorer and the prepared
 * answers stay server-side, so the demo's content never inflates the client
 * bundle.
 *
 * These ids are the join key between a question and its prepared answer in
 * `src/lib/demo/answers.ts`.
 */

export type DemoQuestionId =
  | 'paid-leave-notice'
  | 'overtime-limit'
  | 'expense-deadline'
  | 'remote-work-days'
  | 'external-file-sharing'
  | 'travel-and-receipts';

export interface DemoQuestion {
  id: DemoQuestionId;
  question: string;
}

export const DEMO_QUESTIONS: readonly DemoQuestion[] = [
  // The first three are the examples the Ask screen has always shown, kept
  // verbatim so the demo answers the questions the UI already suggests.
  { id: 'paid-leave-notice', question: '有給休暇は何日前までに申請が必要ですか？' },
  { id: 'overtime-limit', question: '残業時間の上限と申請手順を教えてください。' },
  { id: 'expense-deadline', question: '経費精算の締め日はいつですか？' },
  { id: 'remote-work-days', question: 'リモートワークは週に何日まで利用できますか？' },
  { id: 'external-file-sharing', question: '社外にファイルを共有するときのルールは？' },
  { id: 'travel-and-receipts', question: '交通費と領収書の取り扱いを教えてください。' },
];

/** Question text for the 質問の例 chips, in display order. */
export const DEMO_EXAMPLE_QUESTIONS: readonly string[] = DEMO_QUESTIONS.map(
  (entry) => entry.question,
);
