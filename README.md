# Enterprise RAG Knowledge AI

**社内資料を、根拠付きで検索できるナレッジAI**

社内マニュアル・規程・FAQ などの PDF を登録すると、ページ単位のNativeテキスト抽出 → 必要ページのみOCR → チャンク分割 → Embedding → pgvector への保存が行われ、自然言語の質問に対して**登録済み資料の該当箇所だけ**を根拠に回答します。

回答には必ず **資料名・ページ番号・引用テキスト** が添えられ、利用者は AI の回答を原典で検証できます。

```
質問：有給休暇は何日前までに申請が必要ですか？

回答：年次有給休暇は、取得予定日の5営業日前までに所属長へ申請してください。
      やむを得ない事由による当日申請は、事後承認の対象となります。

出典 (2件)
 ┌ 就業規則  P.12   一致度 87%
 │ 「年次有給休暇の申請は、取得予定日の5営業日前までに所属長へ提出…」
 └ 就業規則  P.13   一致度 74%
   「やむを得ない事由により事前申請ができない場合は…」
```

> **公開デモについて**
> 本番デプロイは**ポートフォリオ公開デモ**として構成されています。ログイン・新規登録はありません。公開 URL を開くとそのままデモ環境に入り、PDF を登録して質問できます。訪問者ごとのデータは、匿名の**デモセッション Cookie** で分離されます（[セキュリティ](#セキュリティ)参照）。

---

## 目次

- [このプロジェクトの見どころ](#このプロジェクトの見どころ)
- [主な機能](#主な機能)
- [技術スタック](#技術スタック)
- [アーキテクチャ](#アーキテクチャ)
- [PDF 取り込みフロー](#pdf-取り込みフロー)
- [質問応答フロー](#質問応答フロー)
- [設計上の意思決定](#設計上の意思決定)
- [データベース設計](#データベース設計)
- [ベクトル検索](#ベクトル検索)
- [セキュリティ](#セキュリティ)
- [エラーハンドリング](#エラーハンドリング)
- [ローカル環境の構築](#ローカル環境の構築)
- [環境変数](#環境変数)
- [本番デプロイ（Vercel + Neon）](#本番デプロイvercel--neon)
- [テスト](#テスト)
- [デモの制限](#デモの制限)
- [既知の制限](#既知の制限)
- [今後の拡張](#今後の拡張)

---

## このプロジェクトの見どころ

RAG は「それらしい回答」を作るだけなら簡単ですが、**業務で使えるかどうかは、回答を検証できるかどうか**で決まります。本プロジェクトはそこを設計の中心に置いています。

| 論点 | 本実装の方針 |
|---|---|
| **Citation の生成主体** | LLM に出典を書かせず、**アプリ側が検索結果から構築**。存在しないページ番号が生成されることが原理的にない |
| **ページ番号の保持** | PDF を一括文字列化せず、**ページ単位で抽出 → ページを跨がないチャンク分割**。1チャンク＝1ページなので出典が一意に決まる |
| **回答範囲の限定** | System Prompt でコンテキスト限定を明示し、根拠がなければ「登録されている資料からは確認できませんでした。」を返す |
| **訪問者の分離** | 認証なしの公開デモでも、**全クエリを匿名デモセッション ID でスコープ**。検索関数の第1引数に必須パラメータとして持たせ、書き忘れを型・SQL 双方で防ぐ |
| **PDF アップロード経路** | Vercel の 4.5MB ボディ上限を、**ブラウザ側の分割アップロード**で回避。10MB 対応のためだけに外部ストレージを増やさない |
| **原本を保存しない設計** | PDF のバイト列は取り込み完了時に破棄。検索に必要なのはテキストとベクトルだけなので、**オブジェクトストレージ自体が不要** |
| **スキャン・mixed PDF** | ページごとにNative抽出品質を判定し、usableでないページだけをOCR。テキストページを無条件に画像送信しない |
| **失敗時の状態整合** | 途中失敗した資料は `ready` にせず、生成済みチャンクを削除してから `failed` に。中途半端な検索対象を残さない |

---

## 主な機能

### 公開デモセッション
- 登録・ログイン不要。公開 URL を開いた時点で利用可能
- httpOnly Cookie による匿名セッション（訪問者ごとに資料と履歴を分離）
- 「デモデータをリセット」で自分の資料・履歴を削除し、新しいセッションを開始

### ダッシュボード
- 登録資料数 / 解析完了数 / 累計質問数 / Helpful率
- 最近登録した資料・最近の質問
- 資料が無い場合の Empty State と導線

### 資料管理 `/documents`
- ドラッグ＆ドロップ / ファイル選択
- PDF 形式・10MB・100ページの検証
- 日本語・英語・混在テキストPDFとスキャンPDFの自動判定
- **実測値によるアップロード進捗表示**（XHR による分割アップロード）
- 解析状態の可視化（待機中 / 解析中 / 利用可能 / 失敗）
- 失敗時の再試行（既存チャンクを cleanup してから再解析）
- 削除（チャンク・ステージング済みバイト列・メタデータを CASCADE で整合削除）

### AI に質問 `/ask`
- Idle / Loading / Success / No result / Error の明示的な状態管理
- 二重送信防止・文字数制限・空入力拒否
- **出典カード**（資料名・ページ番号・引用文・一致度）
- Helpful / Not Helpful 評価

### 質問履歴 `/history`
- 質問・回答・出典・評価・応答時間・モデル名の記録
- 詳細画面で回答全文と出典を再確認
- 自分のデモセッションの履歴のみ表示

---

## 技術スタック

| 領域 | 採用技術 |
|---|---|
| フレームワーク | Next.js 16 (App Router) / React 19 |
| 言語 | TypeScript (strict) |
| スタイル | Tailwind CSS v4 |
| アイコン | Lucide React |
| ホスティング | Vercel |
| データベース | PostgreSQL 15+（本番は **Neon** 無料枠 / ローカルは `pgvector/pgvector` Docker イメージ） |
| DB ドライバ | `pg`（node-postgres）+ プールされた接続文字列 |
| ベクトル検索 | pgvector (HNSW / cosine) |
| ファイル保存 | **なし**（PDF は取り込み中だけ DB にステージングし、完了時に破棄） |
| セッション | httpOnly Cookie（匿名デモセッション UUID）／認証プロバイダなし |
| Embedding | OpenAI `text-embedding-3-small` (1536次元) |
| 回答生成 | OpenAI Chat Completions (`OPENAI_CHAT_MODEL`) |
| OCR fallback | OpenAI Responses API + Vision (`OPENAI_OCR_MODEL`) |
| バリデーション | Zod |
| テスト | Vitest / React Testing Library / Playwright（ブラウザQA） |

PDF 解析には **`pdfjs-dist`（legacy build）** を使用しています。同梱CMapと標準フォントデータをNode側で明示し、ページ単位で `getTextContent()` を実行します。文字数・空白除去後文字数・文字化け率が基準に届かないページだけ `@napi-rs/canvas` でPNG化し、OpenAI Visionへ送るため、**ページ番号を正確に保持したまま**Native/OCRを混在できます。

> **DB がベンダー非依存である理由**: アクセスは `pg` と素の SQL のみで、特定サービスの SDK に依存していません。`DATABASE_URL` を差し替えるだけで Neon / Supabase / RDS / ローカル Docker のいずれでも動作します。

---

## アーキテクチャ

```mermaid
graph TB
    subgraph Browser
        UI[Next.js App Router UI]
    end

    subgraph Vercel["Vercel / Next.js Server"]
        MW[proxy.ts<br/>デモセッション Cookie 発行]
        API_REG["/api/documents/register"]
        API_PART["/api/documents/:id/parts"]
        API_PROC["/api/documents/process"]
        API_ASK["/api/ask"]
        API_FB["/api/feedback"]
        DBL[db layer<br/>documents / uploads / chunks / questions]
        PIPE[Ingestion Pipeline<br/>pdf.ts / chunking.ts / embedding.ts]
        RAG[RAG<br/>prompt.ts / answer.ts / citations.ts]
    end

    subgraph Neon["PostgreSQL + pgvector (Neon)"]
        DB[(documents / document_upload_parts<br/>document_chunks / questions / answer_feedback)]
    end

    OPENAI[OpenAI API<br/>Embeddings / Vision / Chat]

    UI --> MW
    UI -->|"① メタデータ登録"| API_REG
    UI -->|"② PDF を3MB単位で分割送信"| API_PART
    UI -->|"③ 解析要求"| API_PROC
    UI -->|"質問"| API_ASK
    UI -->|"評価"| API_FB

    API_REG --> DBL
    API_PART --> DBL
    API_PROC --> PIPE
    PIPE -->|"ステージング済みバイト列を結合"| DBL
    PIPE -->|"必要ページのOCR / Embedding 生成"| OPENAI
    PIPE -->|"チャンク保存・ステージング破棄"| DBL

    API_ASK --> RAG
    RAG -->|"質問の Embedding"| OPENAI
    RAG -->|"match_document_chunks"| DBL
    RAG -->|"回答生成"| OPENAI
    API_FB --> DBL
    DBL --> DB
```

### ディレクトリ構成

```
db/migrations/               スキーマとベクトル検索関数（正本）
scripts/
├── migrate.mjs              マイグレーション実行（schema_migrations で冪等）
└── db-cleanup.mjs           デモデータの保持期間クリーンアップ
src/
├── app/
│   ├── (app)/               アプリ本体（サイドバー付きシェル）
│   │   ├── dashboard/
│   │   ├── documents/
│   │   ├── ask/
│   │   └── history/[id]/
│   └── api/
│       ├── documents/register/     メタデータ登録＋デモ枠チェック
│       ├── documents/[id]/parts/   PDF 分割アップロード受け口
│       ├── documents/process/      取り込みパイプライン実行
│       ├── documents/[id]/         削除
│       ├── ask/                    RAG 本体
│       ├── feedback/               回答評価
│       └── session/reset/          デモセッションの初期化
├── components/              UI（ask / documents / layout / ui）
├── lib/
│   ├── config/
│   │   ├── rag.ts           RAG パラメータ・上限値の集約（純粋関数）
│   │   └── env.ts           サーバー環境変数（server-only + Zod）
│   ├── db/
│   │   ├── client.ts        接続プール・型パーサ・トランザクション
│   │   ├── documents.ts     資料の CRUD と処理クレーム
│   │   ├── uploads.ts       分割アップロードのステージング
│   │   ├── chunks.ts        チャンク保存とベクトル検索
│   │   └── questions.ts     履歴・フィードバック
│   ├── rag/
│   │   ├── pdf.ts           ページ単位テキスト抽出
│   │   ├── chunking.ts      ページを跨がないチャンク分割（純粋関数）
│   │   ├── embedding.ts     バッチ Embedding
│   │   ├── prompt.ts        System Prompt / コンテキスト構築（純粋関数）
│   │   ├── answer.ts        回答生成
│   │   ├── citations.ts     出典構築（純粋関数）
│   │   └── ingest.ts        取り込みパイプライン
│   ├── session.ts           デモセッション ID と Cookie 属性（純粋関数）
│   ├── session-server.ts    Cookie からのセッション解決（server-only）
│   ├── upload.ts            ブラウザ側の分割アップロード（進捗付き）
│   ├── validation/          Zod スキーマ・ファイル検証
│   └── errors.ts            AppError と利用者向けメッセージ
├── proxy.ts                 デモセッション Cookie の発行
tests/                       Vitest
```

---

## PDF 取り込みフロー

```mermaid
sequenceDiagram
    participant B as Browser
    participant A as API Route
    participant P as Pipeline
    participant O as OpenAI
    participant D as PostgreSQL

    B->>B: ファイル検証（PDF / 10MB）
    B->>A: ① POST /api/documents/register
    A->>A: デモ枠（1セッション最大10件）を確認
    A->>D: documents 行を作成（status: uploaded）
    loop 3MB ごと（進捗表示）
        B->>A: ② POST /api/documents/:id/parts?index=n
        A->>A: 所有セッション / part index / サイズ合計を検証
        A->>D: document_upload_parts に bytea で保存
    end
    B->>A: ③ POST /api/documents/process
    A->>P: processDocument()
    P->>D: status を processing に（条件付き UPDATE ＝ 排他制御）
    P->>D: part_index 順に結合して元の PDF を復元
    P->>P: 100ページ以内か検証
    loop ページ 1..N（逐次処理）
        P->>P: Native抽出 + 品質判定
        opt usableでないページのみ
            P->>P: 最大2048pxのPNGへレンダリング
            P->>O: Responses APIでOCR
        end
    end
    P->>P: ページを跨がないチャンク分割
    P->>O: Embedding をバッチ生成（64件ずつ）
    P->>D: 既存チャンクを削除 → document_chunks に保存（トランザクション）
    P->>D: status を ready に / page_count を記録
    P->>D: ステージング済みバイト列を破棄
    Note over P,D: 一部ページのOCR失敗は利用可能ページを保持<br/>全ページ利用不可または後段失敗は failed<br/>failed の場合はバイト列を保持し「再試行」を可能にする
```

### ページ番号が保たれる仕組み

```
PDF (3ページ)
 ├ page 1 ─ getTextContent() ─→ text ─→ chunk(page:1, index:0), chunk(page:1, index:1)
 ├ page 2 ─ getTextContent() ─→ text ─→ chunk(page:2, index:0)
 └ page 3 ─ getTextContent() ─→ text ─→ chunk(page:3, index:0)
                                          └─ この page 番号がそのまま出典の P.n になる
```

PDF 全体を 1 本の文字列に連結してから分割する実装では、チャンクがどのページ由来か復元できません。本実装は**ページごとに独立してチャンク化**するため、チャンクとページが 1 対 1 に対応します。

---

## 質問応答フロー

```mermaid
sequenceDiagram
    participant U as User
    participant A as /api/ask
    participant O as OpenAI
    participant D as PostgreSQL

    U->>A: 質問（2〜1000文字）
    A->>A: デモセッション解決 + Zod 検証
    A->>D: 直近1時間の質問数（デモのレート制限）
    A->>D: ready な資料が1件でもあるか確認
    alt 資料が0件
        A-->>U: アップロードを促す案内
    end
    A->>O: 質問を Embedding 化
    A->>D: match_document_chunks(session_id, embedding, threshold, top_k)
    Note over D: d.session_id = 呼び出し元セッション<br/>status = 'ready' のみ<br/>similarity >= 0.45<br/>LIMIT top_k (5)
    D-->>A: チャンク（資料名・ページ番号・本文・類似度）
    alt ヒット0件
        A-->>U: 「登録されている資料からは確認できませんでした。」（モデルを呼ばない）
    else ヒットあり
        A->>O: System Prompt + コンテキスト + 質問
        O-->>A: 回答本文のみ
        A->>A: 検索結果から Citation を構築（LLM は関与しない）
        A->>D: questions に保存（質問・回答・出典・応答時間・モデル）
        A-->>U: 回答 + 出典カード
    end
```

---

## 設計上の意思決定

面接で説明できるよう、「なぜそうしたか」を明示します。

### なぜ pgvector か
資料メタデータ（`documents`）と検索対象（`document_chunks`）が同一の PostgreSQL 内にあるため、**所有セッションによる絞り込みと類似度検索を 1 クエリで実行**できます。外部ベクトル DB を使うと、分離の条件を DB とベクトルストアの二重管理にする必要があり、権限の食い違いがそのまま情報漏洩になります。

### なぜ Neon か（そして、なぜ特定サービスに依存しないか）
Vercel と相性がよく、無料枠で `CREATE EXTENSION vector` が使え、サーバーレス向けのプール済み接続文字列を提供しているためです。ただしアプリ側は `pg` と素の SQL しか使っていないため、**`DATABASE_URL` を差し替えれば別の PostgreSQL でもそのまま動きます**。DB の移行性を、特定ベンダーの SDK に縛られない形で確保しています。

### なぜページ番号をチャンクの属性として持つか
出典の価値は「検証できること」にあります。ページ番号が無い出典は、利用者が原典を開いて確認できないため、実質的に検証不能です。後から本文を検索してページを逆引きする方法もありますが、同じ文言が複数ページにあると一意に定まりません。**抽出時点で確定したページ番号を保持する**のが唯一確実な方法です。

### なぜ Citation を LLM に生成させないか
LLM に「出典を書け」と指示すると、**存在しないページ番号をもっともらしく生成**します。しかも出典は「検証済み」に見えるため、誤った出典は出典が無いより有害です。本実装では、表示される資料名・ページ番号・引用文はすべて `match_document_chunks` が返した行そのものであり、モデルの出力を経由しません。モデルの役割は文章化のみです。

### なぜ PDF を分割してアップロードするのか
Vercel の Serverless Function はリクエストボディを **4.5MB** までしか受け取れません。一方この製品の仕様は **10MB** です。この差を埋める方法は 2 つあります。

1. オブジェクトストレージ（Vercel Blob 等）を追加し、ブラウザから直接アップロードする
2. ブラウザ側でファイルを分割し、複数リクエストに分けて送る

本実装は **2** を選びました。理由は、この製品が原本 PDF を**永続保存する必要がない**からです。検索に必要なのはテキストとベクトルだけで、原本は取り込み処理の入力にしか使いません。原本を保存しないなら、そのためだけに外部ストレージと追加のシークレットを増やす理由がありません。分割アップロードは XHR の `progress` イベントを部分ごとに合算するため、**実測値による進捗表示**もそのまま維持できます。

### なぜ PDF のバイト列を DB に置くのか（そして、なぜ残さないのか）
分割された部分は `document_upload_parts` に `bytea` として一時的に保存され、`part_index` 順に結合して元のファイルを復元します。DB をファイルストアとして使っているように見えますが、**行は取り込み完了時に削除されます**。正常に運用されているデータベースには PDF のバイト列は 1 行も残りません。

`failed` の資料だけは例外的にバイト列を保持します。これがないと「再試行」ボタンが同じファイルの再アップロードを要求することになり、失敗からの回復体験が壊れるためです。

### なぜ認証を無くしたのか、それでどう分離するのか
本番デプロイの目的が**ポートフォリオの公開デモ**だからです。閲覧者にアカウント作成を求めることは、デモの価値を下げるだけで何も守りません。

一方、分離そのものは必要です。訪問者が他人のアップロードした PDF を読めたり削除できたりしてはいけません。そこで、認証の代わりに **httpOnly Cookie に入れた UUID（デモセッション）**を全行に記録し、すべてのクエリをその ID でスコープしています。`match_document_chunks` はセッション ID を**デフォルト値のない第 1 引数**として受け取るため、呼び出し側が指定を忘れることが構文上できません。

### なぜ回答をコンテキスト限定にするか
一般知識で補完してしまうと、**回答本文と出典が食い違います**。「就業規則にこう書いてある」と読める文章の根拠が、実はモデルの事前学習知識だった、という状態は業務利用では致命的です。根拠が無い場合に「確認できませんでした」と答えられることは、機能の欠如ではなく品質保証です。検索結果が 0 件のときは**モデルを呼び出さずに**固定文を返すため、この経路でハルシネーションが起きる余地がありません。

### なぜ Feedback を保存するか
RAG の品質は「検索が当たっているか」で決まりますが、これは自動計測が困難です。Helpful / Not Helpful を **質問・検索結果・モデル名と同じ行に紐づけて**保存することで、「どういう質問で検索が外れるか」を後から分析でき、チャンクサイズや類似度しきい値のチューニング根拠になります。

---

## データベース設計

### テーブル

| テーブル | 役割 | 主なポイント |
|---|---|---|
| `documents` | 登録 PDF のメタデータ | `session_id` で所有を表現。`status` (uploaded/processing/ready/failed)、`file_size <= 10485760` / `page_count <= 100` を CHECK |
| `document_upload_parts` | 分割アップロードの一時領域 | `(document_id, part_index)` が PK。**ready 到達時に削除** |
| `document_chunks` | チャンク + Embedding | `vector(1536)`、`(document_id, page_number, chunk_index)` に UNIQUE |
| `questions` | 質問・回答・出典 | `sources` は JSONB。回答時点のスナップショット |
| `answer_feedback` | 回答評価 | `(question_id, session_id)` に UNIQUE → 再評価は UPSERT |

### インデックス

| インデックス | 目的 |
|---|---|
| `document_chunks_embedding_hnsw_idx` | **HNSW / `vector_cosine_ops`** による近似最近傍検索 |
| `documents_session_created_at_idx` | 資料一覧・ダッシュボードの取得 |
| `documents_session_status_idx` | `ready` 件数の集計 |
| `document_chunks_document_id_idx` | 削除・再解析時のチャンク操作 |
| `questions_session_created_at_idx` | 履歴一覧 |

### ON DELETE の設計

```
documents ──cascade──> document_chunks
          ──cascade──> document_upload_parts
questions ──cascade──> answer_feedback
```

資料を削除するとチャンクも必ず消えるため、「実体の無い資料を引用する」状態が発生しません。削除 API は `where id = $1 and session_id = $2` の 1 文で所有確認と削除を同時に行うため、「確認したが削除する前に条件が変わる」という隙間がありません。

### マイグレーション

`db/migrations/` の SQL がスキーマの正本です。`scripts/migrate.mjs` が未適用のファイルだけを順に、**それぞれ独立したトランザクションで**適用し、`schema_migrations` に名前とチェックサムを記録します。再実行は no-op です。適用済みファイルが編集されている場合は、黙って飛ばさず警告します。

```bash
DATABASE_URL=postgresql://... npm run db:migrate
```

---

## ベクトル検索

```sql
match_document_chunks(
  p_session_id    uuid,
  query_embedding vector(1536),
  match_threshold double precision default 0.45,
  match_count     integer default 5
)
```

| パラメータ | 値 | 理由 |
|---|---|---|
| Embedding モデル | `text-embedding-3-small` | 1536次元。コストと精度のバランス |
| 次元数 | 1536 | `vector(1536)` と固定で対応（変更はマイグレーション） |
| 距離 | cosine (`<=>`) | OpenAI Embedding の比較方法と一致 |
| `topK` | 5 | `RAG_TOP_K` で変更可（1〜20 にクランプ） |
| `similarityThreshold` | 0.45 | `RAG_SIMILARITY_THRESHOLD` で変更可（0〜1 にクランプ） |

- `SECURITY INVOKER`（**`SECURITY DEFINER` にしない**）
- `d.session_id = p_session_id` でセッションを限定
- `d.status = 'ready'` のみを対象（解析途中・失敗した資料は引用されない）
- `1 - (embedding <=> query_embedding) >= threshold`
- `ORDER BY embedding <=> query_embedding LIMIT least(greatest(match_count,1),50)`
- `p_session_id` は**デフォルト値のない第1引数**（指定漏れが起こらない）。値は常に httpOnly Cookie から解決したもので、リクエストボディ由来の値を渡す経路は存在しない

---

## セキュリティ

### 鍵の分離

| 変数 | 公開範囲 | 用途 |
|---|---|---|
| `DATABASE_URL` | **サーバーのみ** | PostgreSQL 接続 |
| `OPENAI_API_KEY` | **サーバーのみ** | OCR / Embedding / 回答生成 |

**このアプリに `NEXT_PUBLIC_*` は 1 つもありません。** ブラウザはデータベースにも OpenAI にも直接アクセスせず、必ず自前の Route Handler を経由します。秘密値を含む `src/lib/config/env.ts` と `src/lib/db/*` は先頭で `import 'server-only'` しているため、Client Component から誤って import すると**ビルドが失敗します**。

### デモセッションによる分離

認証プロバイダの代わりに、`proxy.ts` が全リクエストで httpOnly Cookie（`rag_demo_session`、v4 UUID、30日）を保証します。

- **httpOnly** — ページのスクリプトから読めないため、XSS で他人の ID にすり替えることができない
- **UUID v4** — 推測不能
- **全クエリでスコープ** — `src/lib/db/` の関数はすべて `sessionId` を必須引数に取り、`session_id` で絞り込む。セッションを取らないデータアクセス関数は存在しない
- **他セッションのリソースは `not_found`** — 存在の有無を漏らさないため、403 ではなく 404 相当を返す

これは認証ではなく、**公開デモにおけるデータ分離**です。README・UI ともにそれ以上のことは主張していません。機密資料を扱う運用に転用する場合は、組織・メンバーシップに基づく認証と RLS の追加が必要です（[既知の制限](#既知の制限)）。

### 入力検証

- ファイル: MIME `application/pdf` **かつ** 拡張子 `.pdf`、10MB 以下、1〜100ページ
- アップロード部分: `document_id` が UUID か、呼び出しセッションの所有か、`part_index` が範囲内か、1 部分が 3MB 以下か、**合計が 10MB を超えないか**（3MB の正当な断片を積み上げて巨大ファイルを作れない）
- 既に `processing` / `ready` の資料には追記できない
- 質問: 2〜1000文字（UI・API・DB CHECK の三層で一致）
- ID: すべての経路で UUID 形式を検証してからクエリへ渡す（バインド変数のみを使用し、SQL 文字列連結は行わない）

### デモの濫用対策

| 対策 | 値 | 実装 |
|---|---|---|
| 1セッションあたりの資料数 | 10件 | `/api/documents/register` が登録前に確認 |
| 1セッションあたりの質問数 | 30件 / 時 | `/api/ask` が Embedding 生成前に確認 |
| ファイルサイズ | 10MB | クライアント検証 + 部分ごと + 合計 + DB CHECK |
| ページ数 | 100ページ | 抽出直後に検証（超過は `failed`） |
| データ保持 | `npm run db:cleanup -- --days=30` | 古いデモデータを削除（手動 / スケジュール実行） |

### エラー詳細の非開示

すべてのエラーは `AppError` に正規化され、レスポンスには**利用者向けメッセージとコードのみ**を返します。スタックトレース・SQL・ドライバのメッセージは `console.error` でサーバーログにのみ出力されます。この不変条件は `tests/errors.test.ts` で検証しています。

---

## エラーハンドリング

| 状況 | 利用者への表示 | 資料の状態 |
|---|---|---|
| PDF 以外 | PDFファイルのみアップロードできます。 | 作成しない |
| 10MB 超過 | ファイルサイズは10MB以下にしてください。 | 作成しない |
| 資料数の上限 | このデモで登録できる資料数の上限に達しました。 | 作成しない |
| アップロード中断（部分欠落） | アップロードが完了していません。 | `failed` |
| 100ページ超過 | ページ数は100ページ以下のPDFをご利用ください。 | `failed` |
| 破損 / 暗号化 PDF | このPDFを読み取れませんでした。破損または保護されている可能性があります。 | `failed` |
| Native/OCRともに文字なし | このPDFから読み取り可能なテキストを取得できませんでした。 | `failed` |
| OCR API失敗 / timeout（全ページ） | 画像文字解析の失敗 / timeoutを案内 | `failed` |
| OCR失敗（一部ページのみ） | 読み取れなかったページ番号を警告 | `ready`（利用可能ページのみ） |
| DB 失敗 | データの保存に失敗しました。 | `failed` |
| Embedding 失敗 | 資料の解析に失敗しました。 | `failed`（チャンクは削除） |
| 検索失敗 | 資料の検索に失敗しました。 | — |
| 回答生成失敗 | 回答の生成に失敗しました。 | — |
| 二重処理 | この資料は現在処理中です。 | 変更しない |
| 質問レート超過 | 1時間あたりの質問数の上限を案内 | — |
| セッション未確立 | デモセッションを開始できませんでした。 | — |

`failed` の資料は一覧に理由とともに表示され、**再試行**ボタンから再解析できます。再試行時は既存チャンクを削除してから処理するため、チャンクが重複しません。ステージング済みのバイト列は保持されているので、ファイルの再アップロードは不要です。

---

## ローカル環境の構築

### 前提

- Node.js 20 以上（開発は Node 24 で実施）
- PostgreSQL 15 以上 + `vector` 拡張（下記の Docker が最も簡単）
- OpenAI API キー

### 手順

```bash
# 1. 依存関係
npm install

# 2. pgvector 入りの PostgreSQL を起動
docker run -d --name rag-pg \
  -e POSTGRES_USER=ragdev -e POSTGRES_PASSWORD=ragdev -e POSTGRES_DB=ragdev \
  -p 127.0.0.1:55433:5432 \
  pgvector/pgvector:pg17

# 3. 環境変数
cp .env.example .env.local
#   DATABASE_URL=postgres://ragdev:ragdev@127.0.0.1:55433/ragdev
#   OPENAI_API_KEY=sk-...
#   （.env.local は Git 管理外）

# 4. スキーマ適用
npm run db:migrate

# 5. 開発サーバー
npm run dev
```

`http://localhost:3000` を開くとログインなしでダッシュボードに入ります。

### スクリプト

| コマンド | 内容 |
|---|---|
| `npm run dev` | 開発サーバー |
| `npm run build` | 本番ビルド |
| `npm run start` | 本番サーバー |
| `npm run lint` | ESLint |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run test` | Vitest |
| `npm run test:watch` | Vitest（watch） |
| `npm run db:migrate` | 未適用マイグレーションの適用 |
| `npm run db:cleanup -- --days=30` | 古いデモデータの削除 |

---

## 環境変数

| 変数名 | 必須 | 説明 |
|---|---|---|
| `DATABASE_URL` | ✅ | **秘密**。PostgreSQL 接続文字列。Vercel では Neon の**プール済み**（`-pooler`）を使用 |
| `OPENAI_API_KEY` | ✅ | **秘密**。サーバー専用 |
| `OPENAI_CHAT_MODEL` | 任意 | 既定 `gpt-4o-mini` |
| `OPENAI_OCR_MODEL` | 任意 | OCR専用。既定 `gpt-5-mini` |
| `RAG_TOP_K` | 任意 | 既定 `5`（1〜20 にクランプ） |
| `RAG_SIMILARITY_THRESHOLD` | 任意 | 既定 `0.45`（0〜1 にクランプ） |
| `RAG_CHUNK_SIZE` | 任意 | 既定 `1000`（200〜4000 にクランプ） |
| `RAG_CHUNK_OVERLAP` | 任意 | 既定 `150`（チャンクサイズの 1/2 まで） |

> Embedding モデルは環境変数化していません。`text-embedding-3-small` の 1536 次元が `vector(1536)` と対応しているため、変更は**マイグレーションを伴う設計変更**であり、環境変数で切り替えるべきものではないからです。

> `OPENAI_CHAT_MODEL` に推論モデル（o-series / `gpt-5*`）を指定した場合、`max_tokens` ではなく **`max_completion_tokens`** が使われ、`temperature` は送信されません（推論モデルは既定値以外を受け付けないため）。推論トークンの分だけ上限に余裕を持たせています。判定ロジックは `tests/answer-params.test.ts` で検証しています。

---

## 本番デプロイ（Vercel + Neon）

Supabase / Vercel Blob などの追加サービスは不要です。必要なのは **Neon（無料枠）** と **Vercel** と **OpenAI API キー**だけです。

### 1. Neon プロジェクトの作成

1. https://console.neon.tech を開く
2. **Create project**
   - Project name: `enterprise-rag-knowledge-ai`
   - Postgres version: 17（15以上なら可）
   - Region: 利用者に近い region（例: `AWS ap-southeast-1 (Singapore)`）
   - Plan: **Free**
3. 作成後に表示される接続文字列のうち、**Pooled connection**（ホスト名に `-pooler` を含むもの）をコピーします

> `vector` 拡張はマイグレーション内の `create extension if not exists vector` で有効化されるため、ダッシュボードでの手作業は不要です。

### 2. マイグレーションの適用

ローカルから 1 度だけ実行します。

```bash
DATABASE_URL='<Neon の pooled connection string>' npm run db:migrate
```

成功すると次のように表示されます。

```
>  0001_schema.sql ... ok
>  0002_match_document_chunks.sql ... ok
Applied 2 migration(s).
```

確認（再実行しても安全です）:

```bash
DATABASE_URL='<同じ接続文字列>' npm run db:migrate
# -  0001_schema.sql (already applied)
# -  0002_match_document_chunks.sql (already applied)
# Database is already up to date.
```

### 3. Vercel の設定

1. GitHub リポジトリを Vercel にインポート（Framework: Next.js、設定は既定のまま）
2. **Settings → Environment Variables** に登録（Production / Preview / Development すべて）

| Key | Value |
|---|---|
| `DATABASE_URL` | Neon の **pooled** connection string |
| `OPENAI_API_KEY` | OpenAI の API キー |
| `OPENAI_CHAT_MODEL` | 任意（未設定なら `gpt-4o-mini`） |
| `OPENAI_OCR_MODEL` | 任意（未設定なら `gpt-5-mini`） |
| `RAG_TOP_K` / `RAG_SIMILARITY_THRESHOLD` / `RAG_CHUNK_SIZE` / `RAG_CHUNK_OVERLAP` | 任意 |

3. **Deploy**（環境変数を後から追加・変更した場合は再デプロイが必要です）

### 4. 動作確認

1. 公開 URL を開く → ログインを求められずダッシュボードが表示される
2. `/documents` でテキストPDFまたはスキャンPDFをアップロード
3. ステータスが `解析中` → `利用可能` に変わる
4. `/ask` で資料の内容について質問し、出典のページ番号が実際の PDF と一致する
5. 資料に書かれていないことを質問すると「登録されている資料からは確認できませんでした。」が返る
6. `/history` に質問と出典が残る

### 補足

- **接続文字列は必ず pooled を使ってください。** 直結の接続文字列だと、暖まった Serverless Function が数個増えただけで無料枠の接続上限に達します。
- **関数の実行時間**: `/api/documents/process` は `maxDuration = 300` を宣言しています。Hobby プランでは上限が短いため、大きな PDF がタイムアウトする場合があります（[既知の制限](#既知の制限)参照）。
- 本番ビルドは `next build --webpack` に固定しています。PDF.jsが実行時に読むCMap・標準フォント資材と、`@napi-rs/canvas` のプラットフォーム別バイナリをVercelのServerless Functionへ確実にトレースするためです。
- デモデータが増えてきたら `DATABASE_URL=... npm run db:cleanup -- --days=30` を実行します（Vercel Cron や GitHub Actions からの定期実行も可能です）。

---

## テスト

```bash
npm run test
```

`180 tests / 16 files`（2026-09-09 時点。外部連携2ファイルは既定でskip）。ロジックを純粋関数に分離しているため、外部サービスなしで中核を検証できます。

これに加えて、実際の PostgreSQL に接続する統合テスト（35件）と、実OpenAI APIで日本語OCR・回答・cross-language embeddingを確認するテスト（2件）があります。既定ではスキップされ、明示的に接続情報や実行フラグを渡したときだけ実行されます。

```bash
docker run -d --name rag-pg \
  -e POSTGRES_USER=ragdev -e POSTGRES_PASSWORD=ragdev -e POSTGRES_DB=ragdev \
  -p 127.0.0.1:55433:5432 pgvector/pgvector:pg17

export DATABASE_INTEGRATION_URL=postgres://ragdev:ragdev@127.0.0.1:55433/ragdev
npm run test                        # 215 tests pass / OpenAI 2 tests skip
```

統合テストは**マイグレーションの実行そのものから**始まり、決定的なローカル Embedding 関数を使うため、`OPENAI_API_KEY` なしで pgvector 検索・出典ページ番号・セッション分離まで検証できます（LLM の生成文だけが対象外）。使い捨ての DB を指定してください（マイグレーションを適用し、行を書き込みます）。

実OpenAI APIを使う検証は、API利用料金が発生するため明示的に有効化します。

```bash
RUN_OPENAI_INTEGRATION=1 node --env-file=.env.local node_modules/vitest/vitest.mjs run tests/integration/openai.integration.test.ts
```

| ファイル | 検証内容 |
|---|---|
| `chunking.test.ts` | ページを跨がないこと、オーバーラップ、境界選択、**無限ループしないこと**（区切り無し・過大 overlap） |
| `citations.test.ts` | 出典の構築、同一ページの重複排除、類似度順、抜粋の切り詰め |
| `document-validation.test.ts` | MIME/拡張子/サイズ、ページ数、表示タイトルの導出 |
| `upload-plan.test.ts` | 分割サイズが Vercel のボディ上限未満であること、**分割が元ファイルを過不足なく覆うこと**、部分数が上限内であること |
| `session.test.ts` | セッション ID の検証（SQL・パス・長さ違いの拒否）、Cookie が httpOnly であること |
| `question-validation.test.ts` | 文字数境界、空入力、スキーマ検証 |
| `prompt.test.ts` | System Prompt の制約（コンテキスト限定・出典を書かせない） |
| `rag-config.test.ts` | 環境変数のパースとクランプ、`EMBEDDING_DIMENSIONS` と `vector(1536)` の整合 |
| `answer-params.test.ts` | 推論モデルへの `max_completion_tokens` / `temperature` 送信可否 |
| `errors.test.ts` | **内部エラー詳細がレスポンスに漏れないこと**、HTTP ステータス対応 |
| `citation-card.test.tsx` | 出典カードの描画（資料名・P.n・引用文・一致度） |
| `server-env.test.ts` | DB 設定と OpenAI 設定が独立に検証されること、エラーが変数名のみを出し値を漏らさないこと |
| `integration/postgres.integration.test.ts` | **実 DB 接続**。マイグレーションの適用と冪等性、`vector(1536)`、分割アップロードのバイト単位復元、`match_document_chunks`、**セッション分離**、Feedback UPSERT、再処理の冪等性、同時処理クレーム、削除の整合性 |
| `pdf-text.test.ts` | テキスト結合（日本語に不要な空白を入れない）、正規化 |
| `pdf-extraction.test.ts` | 日本語ToUnicode Native抽出、scan OCR、native/scan/native mixed PDF、ページ番号、破損・保護PDF、OCR失敗・timeout・部分成功 |
| `ocr.test.ts` | Responses API画像入力、OCR専用モデル、high detail、非保存設定 |
| `integration/openai.integration.test.ts` | **実API（opt-in）**。日本語scan OCR→日本語回答→Citation、英語資料への日本語質問のEmbedding類似度 |
| `format.test.ts` | バイト数・日時（タイムゾーン固定）・時間・切り詰め |

---

## デモの制限

公開デモとして運用するための制限です。運用形態を変える場合は `src/lib/config/rag.ts` の定数を変更します。

| 項目 | 制限 |
|---|---|
| 資料 | 1セッションあたり 10件 |
| 質問 | 1セッションあたり 30件 / 時 |
| ファイル | PDF のみ / 10MB / 100ページ |
| 質問文 | 2〜1000文字 |
| セッション | 30日（Cookie 削除・リセットで消滅） |
| データ保持 | `npm run db:cleanup` による手動 / 定期削除 |

デモセッションは**認証ではありません**。同じブラウザからのアクセスは同じデータを参照します。共有端末に機密資料をアップロードしないでください。

---

## 既知の制限

- **OCR精度は原稿品質に依存** — 低解像度、手書き、極端な傾き、複雑な表では文字を取得できない場合があります。一部ページだけ失敗した場合はページ番号付き警告を残し、取得できたページは検索対象にします。
- **PDF のみ対応** — Word・Excel・PowerPoint・HTML は未対応です。
- **原本 PDF を保存しない** — 取り込み完了後に原本は破棄されるため、「出典をクリックして元のページを表示する」機能は現状の設計では実装できません。実装する場合はオブジェクトストレージの追加が前提になります。
- **同期的な取り込み処理** — `/api/documents/process` がリクエスト内で抽出・Embedding まで完了させます。100ページ / 10MB という上限内では現実的ですが、大規模運用ではジョブキュー（Inngest、Vercel Queues 等）による非同期化が必要です。Vercel Hobby プランでは関数の実行時間上限により、大きな PDF がタイムアウトする可能性があります。
- **認証・RLS が無い** — 公開デモという用途に合わせた設計です。実運用に転用する場合は、認証プロバイダの導入と、`session_id` を `user_id` / `org_id` に置き換えた Row Level Security の追加が必要です。
- **ベクトル検索のフィルタ方式** — 所有セッションによる絞り込みを `documents` との JOIN で行っています。数万チャンク規模までは問題ありませんが、大規模化する場合は `document_chunks` に `session_id` を非正規化し、パーティションまたは複合インデックスで絞り込む設計が有効です。
- **リランキングなし** — 類似度上位 K 件をそのまま使用します。Cross-Encoder による再ランキングは未実装です。
- **回答のストリーミング未対応** — 回答は生成完了後に一括表示されます。
- **レート制限はセッション単位** — Cookie を捨てれば新しい枠が得られます。厳密な制御には IP ベースの制限（Vercel Firewall 等）の併用が必要です。
- **Native抽出不能なフォント構造** — 同梱CMapとToUnicodeを利用しても文字対応を復元できない独自エンコーディングは、ページ単位OCRへフォールバックします。

---

## 今後の拡張

- OCR結果のレイアウト・表構造を保持するStructured Output
- ジョブキューによる取り込みの非同期化と進捗のリアルタイム表示
- ハイブリッド検索（全文検索 + ベクトル検索）と Cross-Encoder リランキング
- 回答のストリーミング表示
- 認証と組織 / チーム単位の資料共有・権限管理（RLS）
- Not Helpful が付いた質問の分析ダッシュボード
- Word / Excel / PowerPoint 対応

---

## ライセンス

ポートフォリオ用途のプロジェクトです。
