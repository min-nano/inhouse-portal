# 制作方針

事務所内+委託協力者向けの、設計ツール等(主にGAS Webアプリ)をまとめるポータルサイトの制作方針。

## 全体アーキテクチャ

```
ユーザー → [Cloudflare Pages]
           └─ Pages Functions
                ├─ _middleware.ts (自前認証ゲート: Google OAuth)  … 全リクエストに割り込み
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
自動デプロイ(Pagesのビルド)・GASプロキシの仕組みは従来どおり。アクセス制御だけは
Cloudflare Access から内製認証(下記)へ変更した。

### アクセス制御: 内製認証 (Google OAuth) ← Cloudflare Access から変更

当初は Cloudflare Access (Zero Trust) で保護する方針だったが、**Access のポリシーは
Cloudflare アカウント内に存在するホスト名にしか適用できず、外部DNSに CNAME で
割り当てたカスタムドメインは対象にできない**(ネームサーバ移管なしで取り込む
Partial (CNAME) setup は Business プラン=有料)。ネームサーバ移管を避ける今回の
構成と両立しないため、**認証をエッジからアプリ層へ降ろして内製する**。

- `functions/_middleware.ts` が全リクエスト(静的な画面ファイルを含む)に割り込み、
  自前セッション(HMAC署名JWTのCookie)を検証する。
- ログインは Google OAuth 2.0 (Authorization Code + PKCE)。全員が Google アカウント
  (Workspace + GAS)を持つ前提に合致し、Access と同等のUX・強度をアプリ層で再現する。
- 許可は「社内ドメインの全員 + 指名した外部協力者のメール」を許可リストで判定。
  `*` ワイルドカードに対応し、env と KV(デプロイ不要で編集可)の和集合をとる。
- **プレビュー(PR)デプロイは Cloudflare Access で保護**する。プレビューは
  `*.pages.dev`(Cloudflare 所有ゾーン)上で Access が無料で効くため、そこは
  Access に委譲し(`AUTH_MODE=access`)、OAuth が使えない本番カスタムドメインだけ
  内製認証にする、という住み分け。バイパスは pages.dev ホスト限定で本番は常に OAuth。
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
  「内製認証(Google OAuth)を通った人だけが秘匿URLのGAS APIを叩ける」構図
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
| 認証 | 内製 Google OAuth (`hono/jwt` 署名Cookie) | Access が外部DNSのカスタムドメインを保護できない制約への対応。詳細 `docs/auth-internal.md` |
| 台帳検証 | zod | apps.json の形式不正をテスト/デプロイ時に検出 |
| フロント | Vite + TypeScript (フレームワークなし) | リンク集には十分。依存最小・ビルド高速 |
| テスト | Vitest | ユニット+APIルートテスト |
| CI | GitHub Actions | push/PR毎に typecheck + test + build + Functionsバンドル検証 |
| デプロイ | Cloudflare Pages (GitHub連携) | mainへのpushで自動デプロイ・外部サブドメインをCNAMEで割当可 |

## リポジトリ構成

```
data/apps.json          … アプリ台帳 (ここを編集して追加・修正)
src/server/             … API + プロキシの共有ロジック (Hono)
src/server/auth/        … 認証ロジック (許可リスト / セッション / Google OAuth)
functions/_middleware.ts   … 全リクエストの認証ゲート (静的アセットも保護)
functions/api/[[route]].ts … Pages Function (src/server のHonoアプリを /api/* で公開)
web/                    … ポータル画面 (Vite)
test/                   … テストコード
docs/                   … 方針・ロードマップ・認証設計・Phase 2設計
.github/workflows/      … CI
```
