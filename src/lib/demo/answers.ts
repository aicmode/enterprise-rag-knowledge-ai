import { characterBigrams, diceCoefficient } from './retrieval';
import { DEMO_QUESTIONS, type DemoQuestionId } from './questions';

/**
 * Prepared answers for the public demo.
 *
 * Each entry pairs a sample question with the answer the visitor sees and the
 * passages that answer is grounded in. The answers are written to the same
 * contract the real system prompt imposes on the model (`src/lib/rag/prompt.ts`):
 * grounded in the cited passages only, no invented detail, and **no document
 * name or page number in the prose** -- provenance is the application's job and
 * is rendered from the citation rows.
 *
 * Why prepared answers rather than a small local model: the requirement for the
 * public deployment is zero paid AI calls, and a demo answer that varies
 * between two identical questions would undermine the thing the screen is
 * demonstrating. Fixed answers are reproducible, reviewable, and cannot drift.
 */

export interface DemoAnswer {
  id: DemoQuestionId;
  /** The canonical question, taken from `DEMO_QUESTIONS`. */
  question: string;
  /**
   * Alternative phrasings recognised as the same question.
   *
   * A visitor who edits a chip, or types the question their own way, should not
   * fall through to the generic guidance just because the wording moved.
   */
  aliases: readonly string[];
  answer: string;
  /** Passages this answer is grounded in; they become its citations. */
  chunkIds: readonly string[];
}

function questionText(id: DemoQuestionId): string {
  const entry = DEMO_QUESTIONS.find((item) => item.id === id);
  if (!entry) throw new Error(`demo answers: unknown question id ${id}`);
  return entry.question;
}

export const DEMO_ANSWERS: readonly DemoAnswer[] = [
  {
    id: 'paid-leave-notice',
    question: questionText('paid-leave-notice'),
    aliases: [
      '有給休暇の申請期限',
      '有休は何日前までに申請しますか',
      '年次有給休暇の申請方法',
      '有給を当日に申請できますか',
    ],
    answer: `年次有給休暇は、取得予定日の5営業日前までに勤怠システムから所属長へ申請してください。

- 連続5日以上の取得を希望する場合は、10営業日前までの申請が必要です。
- 申請時には、業務の引き継ぎ先を明記してください。
- やむを得ない事由で事前申請ができない場合は、始業時刻までに所属長へ連絡し、出社後に事後申請を行います。事後申請は所属長の承認をもって成立し、承認されない場合は欠勤として扱われます。
- 時間単位での取得は、1年度あたり5日分が上限です。`,
    chunkIds: ['demo-chunk-work-1201', 'demo-chunk-work-1301'],
  },
  {
    id: 'overtime-limit',
    question: questionText('overtime-limit'),
    aliases: [
      '残業の上限は何時間ですか',
      '時間外労働の上限',
      '残業の申請手順',
      '36協定の上限時間',
    ],
    answer: `時間外労働の上限と申請手順は次のとおりです。

**上限**
- 原則として月45時間・年360時間が上限です。
- 特別条項を適用する場合でも、月100時間未満、複数月平均80時間以内、年720時間以内とされ、月45時間を超えられるのは年6回までです。

**申請手順**
- 当日の就業時間内に勤怠システムから事前申請を行い、所属長の承認を得てください。事前申請のない時間外労働は原則として認められません。
- 緊急対応などで事前申請ができなかった場合は、翌営業日中に理由を添えて事後申請を行います。
- 月45時間を超える見込みとなった時点で、所属長から人事部へ報告されます。`,
    chunkIds: ['demo-chunk-work-1801', 'demo-chunk-work-1901'],
  },
  {
    id: 'expense-deadline',
    question: questionText('expense-deadline'),
    aliases: [
      '経費精算の締切はいつ',
      '経費はいつまでに申請すればよいですか',
      '経費精算の支給日',
      '精算の締め日',
    ],
    answer: `経費精算の締め日は毎月20日です（20日が休日の場合は直前の営業日）。

- 20日までに経費精算システムへ登録され、承認済みとなった申請が当月の精算対象です。
- 当月分として承認された経費は、翌月25日の給与支給日に合わせて振り込まれます。
- 締め日を過ぎた申請は翌月分として処理され、支給は翌々月の給与支給日になります。
- 経費が発生した日から60日を超えた申請は、原則として受理されません。`,
    chunkIds: ['demo-chunk-expense-0301', 'demo-chunk-expense-0401'],
  },
  {
    id: 'remote-work-days',
    question: questionText('remote-work-days'),
    aliases: [
      '在宅勤務は週何日までですか',
      'テレワークの上限日数',
      'リモートワークの条件',
      '在宅勤務手当はありますか',
    ],
    answer: `在宅勤務は所属長の承認を得た従業員が利用でき、原則として週3日が上限です。

- 週4日以上を希望する場合は、業務内容と成果指標を記載した申請書を人事部へ提出し、部門長および人事部長の承認が必要です。
- 在宅勤務日でも、コアタイム（10:00〜15:00）は連絡が取れる状態を維持してください。
- 使用できる端末は会社貸与のPCに限られ、私用端末から社内システムへ接続することはできません。
- 在宅勤務手当として1日あたり250円（月額上限5,000円）が翌月の給与で支給されます。`,
    chunkIds: ['demo-chunk-work-0701', 'demo-chunk-work-0702'],
  },
  {
    id: 'external-file-sharing',
    question: questionText('external-file-sharing'),
    aliases: [
      '社外へのファイル共有のルール',
      '取引先にファイルを送る方法',
      'ファイル共有リンクの設定',
      'パスワード付きzipは使えますか',
    ],
    answer: `社外へのファイル共有は、会社が許可したファイル共有サービスのみを使用してください。

- 共有リンクには必ず有効期限（最長14日）とアクセス権限を設定し、リンクを知る全員が閲覧できる設定にしてはいけません。
- 個人情報、または機密区分「社外秘」以上を含むファイルは、共有前に情報システム部の承認が必要です。
- 添付ファイルにパスワードを設定し、同じ経路でパスワードを送る方式（いわゆるPPAP）は廃止されています。共有サービスのリンクを本文に記載する方法へ統一してください。
- 宛先が10名を超える外部送信では、BCCの使用と送信前の宛先ダブルチェックが必須です。`,
    chunkIds: ['demo-chunk-security-0901', 'demo-chunk-security-1001'],
  },
  {
    id: 'travel-and-receipts',
    question: questionText('travel-and-receipts'),
    aliases: [
      '交通費の精算ルール',
      'タクシーは使えますか',
      '領収書を無くした場合',
      '宿泊費の上限',
    ],
    answer: `交通費と領収書の取り扱いは次のとおりです。

**交通費**
- 公共交通機関の利用を原則とし、実費を精算します。
- タクシーは、深夜時間帯（22:00以降）、重量物の運搬を伴う場合、または公共交通機関が利用できない場合に限り認められます。
- 出張時の宿泊費は1泊あたり12,000円（首都圏は15,000円）が上限です。

**領収書**
- 金額にかかわらず、領収書またはこれに準ずる証憑の添付が必須です。
- 電子データで受領した領収書はPDFのまま保存し、紙への出力は不要です。
- 紛失した場合は、支払先・金額・目的を記載した支払証明書を作成し、所属長の承認を得てください。`,
    chunkIds: ['demo-chunk-expense-0601', 'demo-chunk-expense-0701'],
  },
];

/**
 * How close a typed question must be to a prepared one to reuse its answer.
 *
 * Set from the two failure modes it sits between: too low and the 経費 question
 * starts answering the 残業 one, too high and anything but a verbatim chip
 * falls through to the generic guidance. 0.45 on a bigram Dice coefficient
 * accepts ordinary rewordings and abbreviations while keeping the six prepared
 * questions well separated from each other -- which `tests/demo-rag.test.ts`
 * asserts rather than leaving to inspection.
 */
export const DEMO_ANSWER_MATCH_THRESHOLD = 0.45;

export interface DemoAnswerMatch {
  answer: DemoAnswer;
  /** Similarity to the phrasing that matched, for logging and tests. */
  score: number;
}

/**
 * Find the prepared answer for a typed question, or `null`.
 *
 * `null` is a first-class outcome, not a failure: it is what routes the visitor
 * to the guidance response instead of to an improvised one. There is no
 * fallback path to a model here or anywhere below this function.
 */
export function matchDemoAnswer(question: string): DemoAnswerMatch | null {
  const questionGrams = characterBigrams(question);
  if (questionGrams.size === 0) return null;

  let best: DemoAnswerMatch | null = null;

  for (const answer of DEMO_ANSWERS) {
    for (const phrasing of [answer.question, ...answer.aliases]) {
      const score = diceCoefficient(questionGrams, characterBigrams(phrasing));

      // `>` rather than `>=` keeps the first declared entry on an exact tie, so
      // the choice stays deterministic and follows the order in this file.
      if (score >= DEMO_ANSWER_MATCH_THRESHOLD && (best === null || score > best.score)) {
        best = { answer, score: Math.round(score * 1000) / 1000 };
      }
    }
  }

  return best;
}
