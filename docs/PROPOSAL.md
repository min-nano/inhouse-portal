# 制作方針

事務所内+委託協力者向けの、設計ツール等(主にGAS Webアプリ)をまとめるポータルサイトの制作方針。

## 全体アーキテクチャ

```
ユーザー → [Cloudflare Access (Zero Trust認証)]
              ↓
         [Cloudflare Pages]
           ├─ 静的アセット配信 (ポータル画面)         … Pagesが直接配信
           └─ Pages Functions /api/* … 台帳API + GASへのサーバー間プロキシ
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
Access・自動デプロイ(Pagesのビルド)・GASプロキシの仕組みは従来どおり。

### アクセス制御: Cloudflare Access (Zero Trust)

- アプリ側にログイン機能は実装しない
- Cloudflare ダッシュボードで「社内ドメインの全員 + 指名した外部協力者のメール」を
  許可するポリシーを設定する(Googleログイン等)
- 手順は README の「Cloudflare Access の設定」を参照

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
  「Cloudflare Accessを通った人だけが秘匿URLのGAS APIを叩ける」構図
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
| 台帳検証 | zod | apps.json の形式不正をテスト/デプロイ時に検出 |
| フロント | Vite + TypeScript (フレームワークなし) | リンク集には十分。依存最小・ビルド高速 |
| テスト | Vitest | ユニット+APIルートテスト |
| CI | GitHub Actions | push/PR毎に typecheck + test + build + Functionsバンドル検証 |
| デプロイ | Cloudflare Pages (GitHub連携) | mainへのpushで自動デプロイ・外部サブドメインをCNAMEで割当可 |

## リポジトリ構成

```
data/apps.json          … アプリ台帳 (ここを編集して追加・修正)
src/server/             … API + プロキシの共有ロジック (Hono)
functions/api/[[route]].ts … Pages Function (src/server のHonoアプリを /api/* で公開)
web/                    … ポータル画面 (Vite) / web/public/_redirects でSPAフォールバック
test/                   … テストコード
docs/                   … 方針・ロードマップ・Phase 2設計
.github/workflows/      … CI
```
