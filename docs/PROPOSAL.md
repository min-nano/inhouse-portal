# 制作方針

事務所内+委託協力者向けの、設計ツール等(主にGAS Webアプリ)をまとめるポータルサイトの制作方針。

## 全体アーキテクチャ

```
ユーザー → [Cloudflare Pages]
           └─ Pages Functions
                ├─ _middleware.ts (認証ゲート: Clerk)             … 全リクエストに割り込み
                ├─ 静的アセット配信 (ポータル画面)                … 認証通過後にPagesが配信
                └─ /api/* … 認証 + 台帳API + GASへのサーバー間プロキシ
                          ↓ fetch (サーバー間通信 = CORS回避)
                     [GAS Webアプリ (/exec)]
```

### なぜ「Workers + Static Assets」ではなく Pages + Functions か

当初は「Workers + Static Assets」の単一Worker構成を採用していたが、
**外部DNS(他社ネームサーバ)のサブドメインをカスタムドメインとして割り当てたい**
という要件により Pages + Functions へ移行した。

- Workers の Custom Domains / Routes は、対象ゾーンがCloudflareに載っている
  (ネームサーバをCloudflareに向ける、またはBusiness以上のpartial CNAME setup)
  ことが必須で、他社DNSのサブドメインを単純にCNAMEで割り当てることはできない。
- Pages は、サブドメインであればゾーンをCloudflareに載せずに
  他社DNSのCNAME (`sub.example.com → <project>.pages.dev`) だけで
  カスタムドメインを割り当てられる。今回の要件を満たせるのは Pages のみ。

移行してもコード構成(画面 / 共有ロジック `src/server` / API)はほぼそのまま。
Honoアプリを Pages Functions (`functions/api/[[route]].ts`) から
`hono/cloudflare-pages` の `handle()` で公開し、静的アセットはPagesが直接配信する。
自動デプロイ(Pagesのビルド)・GASプロキシの仕組みは従来どおり。アクセス制御は
Cloudflare Access → 自前 Google OAuth と変遷したのち、**Clerk に一本化**した(下記)。

### アクセス制御: Clerk ← 「Zero Trust + 自前 Google OAuth の使い分け」から変更

当初は「本番のカスタムドメイン=自前 Google OAuth / プレビューの `*.pages.dev`=
Cloudflare Access (Zero Trust)」という**環境ごとの使い分け**で保護していた。これは
「Access が無料で効くのは Cloudflare 所有ゾーン(`*.pages.dev`)だけで、外部DNSに CNAME で
割り当てたカスタムドメインには効かない」制約への対処だったが、**2つの認証系を維持する
実装が複雑**すぎた。そこで**認証を Clerk に一本化**する。

- `functions/_middleware.ts` が全リクエスト(静的な画面ファイルを含む)に割り込み、Clerk の
  セッション(`@clerk/backend` の `authenticateRequest`)を検証する。Clerk はアプリ層で動く
  ため、**カスタムドメインでもプレビューの pages.dev でも同一のコード経路**でゲートでき、
  Cloudflare Access への依存が消える。環境差はデプロイに渡す Clerk キー(production/development)
  だけになる。
- ログインは Clerk の hosted なサインイン画面 + **Google 連携**。全員が Google アカウント
  (Workspace + GAS)を持つ前提に合致する。**Clerk 無料枠(MAU 10,000)** で収まり、
  production インスタンスは `clerk.<domain>` 等のサブドメインを CNAME で追加するだけで使える
  (ネームサーバ移管不要=Pages の外部CNAME構成と両立)。
- 許可(誰がサインインできるか)は **Clerk 側で管理**する(Restrictions の Allowlist:
  社内ドメイン `example.co.jp` + 指名した外部協力者のメール、または Invitations の招待制)。
  ダッシュボードでデプロイ不要に編集でき、協力者メール(PII)も自前 KV に持たない。アプリ側は
  「サインインできた=許可済み」として扱い、独自の許可リスト(env/KV)は持たない。
- Phase 2(本人権限での GAS 自動列挙)に要る Google アクセストークンも Clerk から取得する
  (リフレッシュは Clerk が担うので自前のトークン保管は不要)。
- 詳細な設計・設定手順は [docs/auth-internal.md](auth-internal.md) を参照。

### GASプロキシ (/api/proxy/:id)

**リンクとして開くだけのGASアプリにはプロキシは使わない。**
カードのリンクはGASの `/exec` へ直行し、GAS側のGoogleアカウント制限が
そのまま効く(対話的なGAS Webアプリはプロキシ経由では正常に動作しない)。

プロキシが必要になるのは**ポータル画面自身がGASからデータを取得する**場合
(Phase 2のレジストリAPI、将来のお知らせ・ウィジェット表示など):

- GASを「Googleアカウント制限付き」でデプロイすると、別サイトからの
  `fetch` にはJSONではなくログイン画面HTMLが返り、失敗する。
  そのためデータAPI用途のGASは「全員(匿名)」でデプロイするしかなく、
  **URLの秘匿が実質のアクセス制御**になる
- そこで生URL(`/exec`)はリポジトリにもブラウザにも置かず、
  Worker の secret `PROXY_TARGETS` にのみ保持する。
  「認証(Clerk)を通った人だけが秘匿URLのGAS APIを叩ける」構図
  (`/api/proxy/:id` も `_middleware.ts` の認証ゲート配下にある)
- Worker→GAS はサーバー間通信のため CORS の制約を受けない
  (匿名GASでもPOST+JSONはプリフライトで失敗するため中継が確実)
- GASの302リダイレクト(script.googleusercontent.com)には自動追従
- `Set-Cookie` 等の不要ヘッダは伝播させない

## 「デプロイ済みGASアプリをAPIで取得」について

Apps Script API (`projects.deployments.list`) は**サービスアカウント非対応**で、
ユーザーOAuthトークンが必須。Cloudflare Worker から直接アカウント内の全GAS
デプロイを列挙するのはトークン管理の負担が大きく、MVPには不向き。

そこで段階的に進める:

1. **Phase 1 (MVP・本リポジトリの現状)**: `data/apps.json` を台帳として
   Git管理。追加・修正はPR経由で履歴とレビューが残る。
2. **Phase 2**: **GAS側に「レジストリAPI」を1本立てる**。
   GAS内なら `ScriptApp.getOAuthToken()` で Drive API + Apps Script API を
   呼べるため、「自分のドライブ内のGASプロジェクト+WebアプリデプロイURL」を
   自動列挙してJSONで返せる。Workerがそれをプロキシ+キャッシュして
   ポータルに自動反映する。→ 詳細: `docs/phase2-gas-registry.md`

## 技術スタック

| 項目 | 選定 | 理由 |
|---|---|---|
| API | TypeScript + Hono | 軽量・`app.request()`でテスト容易・`hono/cloudflare-pages`でPages Functions化 |
| 認証 | Clerk (`@clerk/backend`) | Zero Trust + 自前 OAuth の使い分けを廃し一本化。アプリ層で全ホスト一律にゲート・無料枠で運用。詳細 `docs/auth-internal.md` |
| 台帳検証 | zod | apps.json の形式不正をテスト/デプロイ時に検出 |
| フロント | Vite + TypeScript (フレームワークなし) | リンク集には十分。依存最小・ビルド高速 |
| テスト | Vitest | ユニット+APIルートテスト |
| CI | GitHub Actions | push/PR毎に typecheck + test + build + Functionsバンドル検証 |
| デプロイ | Cloudflare Pages (GitHub連携) | mainへのpushで自動デプロイ・外部サブドメインをCNAMEで割当可 |

## リポジトリ構成

```
data/apps.json          … アプリ台帳 (ここを編集して追加・修正)
src/server/             … API + プロキシの共有ロジック (Hono)
src/server/auth/        … 認証ロジック (Clerk ラッパー)
functions/_middleware.ts   … 全リクエストの認証ゲート (静的アセットも保護)
functions/api/[[route]].ts … Pages Function (src/server のHonoアプリを /api/* で公開)
web/                    … ポータル画面 (Vite)
test/                   … テストコード
docs/                   … 方針・ロードマップ・認証設計・Phase 2設計
.github/workflows/      … CI
```
