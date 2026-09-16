import type { DocumentRow, MatchedChunk } from '@/lib/types';

/**
 * The public demo's sample corpus.
 *
 * Three fictional internal documents, written out as the same shapes the real
 * pipeline produces: `DocumentRow` for the 資料 screen, and chunk records that
 * become `MatchedChunk` once retrieval has scored them. Nothing here is a new
 * type -- the demo travels through the existing ones, so the screens, the
 * citation builder and the history writer all run their normal code paths.
 *
 * Every document, page number and passage is invented. That is deliberate: the
 * public demo must show what the product does without publishing anyone's real
 * internal policy, and a fixed corpus is what makes the demo answers
 * reproducible.
 *
 * Page numbers are the anchor of the whole product promise, so they are written
 * as if they came from a real PDF: each passage carries the page it would have
 * been extracted from, and a document never repeats a chunk index on one page.
 */

/** Fixed, obviously synthetic ids. Valid v4-shaped UUIDs so nothing downstream
 *  has to special-case their format. */
export const DEMO_DOCUMENT_IDS = {
  workRules: '11111111-1111-4111-8111-111111111111',
  expenses: '22222222-2222-4222-8222-222222222222',
  security: '33333333-3333-4333-8333-333333333333',
} as const;

/** Frozen timestamps: a demo that renders a different "登録日時" on every reload
 *  looks like live data, which is the one thing it must not pretend to be. */
const DEMO_CREATED_AT = '2026-04-01T09:00:00.000Z';
const DEMO_UPDATED_AT = '2026-04-01T09:04:00.000Z';

/** Session owner recorded on the sample rows. Never a real demo session id. */
const DEMO_SESSION_ID = '00000000-0000-4000-8000-000000000000';

function demoDocument(
  id: string,
  title: string,
  fileName: string,
  fileSize: number,
  pageCount: number,
): DocumentRow {
  return {
    id,
    session_id: DEMO_SESSION_ID,
    title,
    file_name: fileName,
    file_size: fileSize,
    content_type: 'application/pdf',
    page_count: pageCount,
    status: 'ready',
    error_message: null,
    created_at: DEMO_CREATED_AT,
    updated_at: DEMO_UPDATED_AT,
  };
}

export const DEMO_DOCUMENTS: readonly DocumentRow[] = [
  demoDocument(
    DEMO_DOCUMENT_IDS.workRules,
    '就業規則（2024年度改訂版）',
    'shugyo-kisoku-2024.pdf',
    1_482_112,
    24,
  ),
  demoDocument(
    DEMO_DOCUMENT_IDS.expenses,
    '経費精算ガイドライン',
    'keihi-seisan-guideline.pdf',
    734_208,
    12,
  ),
  demoDocument(
    DEMO_DOCUMENT_IDS.security,
    '情報セキュリティ運用ハンドブック',
    'infosec-handbook.pdf',
    1_058_944,
    18,
  ),
];

/**
 * One passage of the sample corpus.
 *
 * Identical to `MatchedChunk` apart from `similarity`, which is not a property
 * of a chunk -- it is the result of scoring one against a question, and is
 * attached by `src/lib/demo/retrieval.ts`.
 *
 * `keywords` is not a shortcut around retrieval. The scorer is a general
 * character-n-gram matcher that knows nothing about these documents; the
 * keywords only add the vocabulary a reader would use but the passage does not
 * literally contain ("有休" for 「年次有給休暇」), which is the gap a real
 * embedding closes and a lexical matcher cannot.
 */
export interface DemoChunk extends Omit<MatchedChunk, 'similarity'> {
  keywords: readonly string[];
}

function chunk(
  documentId: string,
  chunkId: string,
  pageNumber: number,
  chunkIndex: number,
  content: string,
  keywords: readonly string[],
): DemoChunk {
  const document = DEMO_DOCUMENTS.find((row) => row.id === documentId);
  if (!document) throw new Error(`demo corpus: unknown document ${documentId}`);

  return {
    chunk_id: chunkId,
    document_id: document.id,
    document_title: document.title,
    file_name: document.file_name,
    page_number: pageNumber,
    chunk_index: chunkIndex,
    content,
    keywords,
  };
}

const { workRules, expenses, security } = DEMO_DOCUMENT_IDS;

export const DEMO_CHUNKS: readonly DemoChunk[] = [
  // --- 就業規則 -------------------------------------------------------------
  chunk(
    workRules,
    'demo-chunk-work-0701',
    7,
    0,
    `第18条（在宅勤務）
在宅勤務は、所属長の承認を得た従業員が利用できる勤務形態とし、原則として週3日を上限とする。週4日以上の在宅勤務を希望する場合は、業務内容と成果指標を記載した申請書を人事部へ提出し、部門長および人事部長の承認を受けるものとする。
在宅勤務日であっても、コアタイム（10:00〜15:00）は連絡が取れる状態を維持しなければならない。`,
    ['リモートワーク', 'テレワーク', '在宅勤務', '週', '上限'],
  ),
  chunk(
    workRules,
    'demo-chunk-work-0702',
    8,
    0,
    `在宅勤務に使用する端末は、会社が貸与したPCに限る。私用端末から社内システムへ接続することはできない。
通信費および光熱費の補助として、在宅勤務日数に応じた在宅勤務手当（1日あたり250円、月額上限5,000円）を翌月の給与にて支給する。`,
    ['在宅勤務手当', '通信費', '貸与PC', 'リモートワーク', '在宅勤務'],
  ),
  chunk(
    workRules,
    'demo-chunk-work-1201',
    12,
    0,
    `第24条（年次有給休暇の申請）
年次有給休暇の申請は、取得予定日の5営業日前までに、勤怠システムを通じて所属長へ提出しなければならない。連続5日以上の取得を希望する場合は、10営業日前までに申請するものとする。
申請にあたっては、業務の引き継ぎ先を明記すること。`,
    ['有給休暇', '有休', '年休', '何日前', '申請', '休暇'],
  ),
  chunk(
    workRules,
    'demo-chunk-work-1301',
    13,
    0,
    `やむを得ない事由により事前申請ができない場合は、始業時刻までに所属長へ電話または勤怠システムで連絡し、出社後速やかに事後申請を行うものとする。事後申請は所属長の承認をもって成立し、承認されない場合は欠勤として扱う。
時間単位の年次有給休暇は、1年度あたり5日分を上限として取得できる。`,
    ['有給休暇', '当日申請', '事後申請', '時間単位', '休暇'],
  ),
  chunk(
    workRules,
    'demo-chunk-work-1801',
    18,
    0,
    `第31条（時間外労働の上限）
時間外労働は、労使協定（36協定）に基づき、原則として月45時間・年360時間を上限とする。
特別条項を適用する場合であっても、月100時間未満、複数月平均80時間以内、かつ年720時間以内とし、月45時間を超えることができるのは年6回までとする。`,
    ['残業', '時間外労働', '上限', '36協定', '何時間'],
  ),
  chunk(
    workRules,
    'demo-chunk-work-1901',
    19,
    0,
    `第32条（時間外労働の申請手順）
時間外労働を行う場合は、当日の就業時間内に勤怠システムから事前申請を行い、所属長の承認を得なければならない。事前申請のない時間外労働は原則として認めない。
緊急対応等でやむを得ず事前申請ができなかった場合は、翌営業日中に理由を添えて事後申請を行うこと。月45時間を超える見込みとなった時点で、所属長は人事部へ報告するものとする。`,
    ['残業', '時間外労働', '申請', '手順', '事前申請'],
  ),

  // --- 経費精算ガイドライン --------------------------------------------------
  chunk(
    expenses,
    'demo-chunk-expense-0301',
    3,
    0,
    `2.1 精算の締め日
経費精算の締め日は毎月20日（20日が休日の場合は直前の営業日）とする。20日までに経費精算システムへ登録され、承認済みとなった申請が、当月の精算対象となる。
締め日を過ぎた申請は翌月分として処理され、支給は翌々月の給与支給日となる。`,
    ['経費精算', '締め日', 'いつ', '締切', '精算'],
  ),
  chunk(
    expenses,
    'demo-chunk-expense-0401',
    4,
    0,
    `2.2 支給日と申請期限
当月分として承認された経費は、翌月25日の給与支給日に合わせて振り込まれる。
経費が発生した日から60日を超えた申請は、原則として受理しない。やむを得ない事情がある場合は、理由書を添えて経理部へ相談すること。`,
    ['経費精算', '支給日', '申請期限', '締め日', '振込'],
  ),
  chunk(
    expenses,
    'demo-chunk-expense-0601',
    6,
    0,
    `3.1 交通費
公共交通機関の利用を原則とし、実費を精算する。タクシーの利用は、深夜時間帯（22:00以降）、重量物の運搬を伴う場合、または公共交通機関が利用できない場合に限り認める。
出張時の宿泊費は、1泊あたり12,000円（首都圏は15,000円）を上限とする。`,
    ['交通費', 'タクシー', '宿泊費', '上限', '出張'],
  ),
  chunk(
    expenses,
    'demo-chunk-expense-0701',
    7,
    0,
    `3.2 領収書の取り扱い
金額にかかわらず、領収書またはこれに準ずる証憑の添付を必須とする。電子データで受領した領収書は、電子帳簿保存法の要件に従いPDFのまま保存し、紙への出力は不要とする。
領収書を紛失した場合は、支払先・金額・目的を記載した支払証明書を作成し、所属長の承認を得ること。`,
    ['領収書', '証憑', '紛失', '電子帳簿保存法', '添付'],
  ),

  // --- 情報セキュリティ運用ハンドブック --------------------------------------
  chunk(
    security,
    'demo-chunk-security-0901',
    9,
    0,
    `4.2 社外へのファイル共有
社外へファイルを共有する場合は、会社が許可したファイル共有サービスのみを使用する。共有リンクには必ず有効期限（最長14日）とアクセス権限を設定し、リンクを知る全員が閲覧できる設定にしてはならない。
個人情報または機密区分「社外秘」以上を含むファイルは、共有前に情報システム部の承認を得ること。`,
    ['ファイル共有', '社外', '共有リンク', 'ルール', '送信'],
  ),
  chunk(
    security,
    'demo-chunk-security-1001',
    10,
    0,
    `4.3 メール送信時の注意
添付ファイルにパスワードを設定し、パスワードを同一経路のメールで送信する方式（いわゆるPPAP）は廃止している。許可されたファイル共有サービスのリンクを本文に記載する方法へ統一すること。
宛先が10名を超える外部送信では、BCCの使用と、送信前の宛先ダブルチェックを必須とする。`,
    ['メール', '添付', 'PPAP', 'BCC', '誤送信'],
  ),
  chunk(
    security,
    'demo-chunk-security-1201',
    12,
    0,
    `5.1 パスワードと多要素認証
業務システムのパスワードは14文字以上とし、他サービスとの使い回しを禁止する。定期変更は求めないが、漏えいの疑いがある場合は直ちに変更すること。
社外から社内システムへ接続する場合は、多要素認証（MFA）の登録を必須とする。`,
    ['パスワード', '多要素認証', 'MFA', 'ログイン'],
  ),
  chunk(
    security,
    'demo-chunk-security-1401',
    14,
    0,
    `6.1 インシデント発生時の連絡
端末の紛失、マルウェア感染の疑い、誤送信などを認知した場合は、30分以内に情報システム部のインシデント窓口へ連絡する。
自己判断での復旧作業や、感染が疑われる端末の再起動は行わないこと。事実関係の記録を残し、窓口の指示に従う。`,
    ['インシデント', '紛失', '誤送信', '連絡', '報告'],
  ),
];

/** Look up one sample passage by id. */
export function getDemoChunk(chunkId: string): DemoChunk | undefined {
  return DEMO_CHUNKS.find((item) => item.chunk_id === chunkId);
}

/** The sample documents as the 資料 screen and dashboard render them. */
export function listDemoDocuments(): DocumentRow[] {
  return [...DEMO_DOCUMENTS];
}
