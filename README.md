# inhouse-portal

事務所内+委託協力者向けのポータルサイト。設計ツール等(主にGAS Webアプリ)への
リンクを1か所にまとめ、Cloudflare Pages + Functions でホスティングし
Cloudflare Access でアクセス制限をかける。

- 制作方針: [docs/PROPOSAL.md](docs/PROPOSAL.md)
- ロードマップ: [docs/ROADMAP.md](docs/ROADMAP.md)
- Phase 2 (GAS自動列挙) 設計: [docs/phase2-gas-registry.md](docs/phase2-gas-registry.md)

## アーキテクチャ

```
ユーザー → [Cloudflare Access] → [Cloudflare Pages]
                                   ├─ 静的アセット (ポータル画面) … Pagesが直接配信
                                   └─ Pages Functions (/api/*)
                                        ├─ GET /api/apps       … 台帳 (data/apps.json)
                                        └─ ALL /api/proxy/:id  … GASへの中継 (CORS回避・URL秘匿)
```

`/api/*` は `functions/api/[[route]].ts` (Hono) が処理し、それ以外の画面・CSS・JS
などの静的アセットは Pages が `dist/client` から直接配信する。

## アプリの追加・修正

`data/apps.json` を編集してコミットするだけ。形式は zod で検証され、
不正なエントリは CI とデプロイ時に弾かれる。

```json
{
  "id": "kintai",                    // 英小文字・数字・ハイフン
  "name": "勤怠入力",
  "description": "説明文",
  "category": "業務管理",
  "tags": ["gas"],
  "url": "https://script.google.com/macros/s/XXXX/exec"  // httpsのみ
}
```

## 開発

```bash
npm ci
npm test            # テスト実行
npm run typecheck   # 型チェック
npm run dev         # ビルド + wrangler pages dev (http://localhost:8788)
npm run dev:web     # 画面のみHMR開発 (APIは:8787へプロキシ)
```

## デプロイ

### 初回セットアップ

> ℹ️ **Cloudflareは2025年にダッシュボードからの Pages 新規作成導線を廃止**し、
> 新規プロジェクトを Workers に一本化した。そのため「Create → Pages」ボタンは
> 表示されないが、**Pages プロジェクトは Wrangler CLI から作成でき**、以後は
> ダッシュボードの Workers & Pages 一覧に表示されてカスタムドメイン等も設定できる。

1. **Pages プロジェクトを作成 (初回1回だけ・CLI)**:

   ```bash
   npx wrangler login                      # 未ログインなら
   npx wrangler pages project create inhouse-portal --production-branch main
   ```

2. **Pages 権限付きの API トークンをビルドに渡す**:
   旧 Workers ビルドが使うトークンは **Workers 用スコープ**で Pages の権限が無いため、
   `wrangler pages deploy` は `Authentication error [code: 10000]` で失敗する
   (アカウントの Super Administrator 権限とは別物。トークン側のスコープの問題)。
   ビルド設定の **API token** セレクタの `Create new token` で作られるのは
   権限固定の Workers 用ビルドトークン (API Tokens 画面に出ず編集不可) なので、
   代わりに **My Profile で正規の Custom token を作り、環境変数で上書き**する。
   1. My Profile → API Tokens → **Create Token** → Custom token
      - Permissions: **Account → Cloudflare Pages → Edit**
      - 併せて **Account → Account Settings → Read** / **User → Memberships → Read** も付けておく
      - Account Resources: 対象アカウントを Include
   2. ビルドプロジェクトの Settings → Variables and Secrets に登録:
      - `CLOUDFLARE_API_TOKEN` = 上で作ったトークン (**Secret**。ビルドトークンより優先される)
      - `CLOUDFLARE_ACCOUNT_ID` = 対象アカウントのID (制限トークンだと自動検出に失敗するため明示)

   > 上書きが効かない (ビルドトークン側が優先される) 場合は、ダッシュボードのビルドに
   > 依存しない **GitHub Actions からのデプロイ**に切り替えるのが確実
   > (同じ Custom token を GitHub Secrets に入れて `wrangler pages deploy` を実行)。

3. **既存のGit連携ビルドを Pages デプロイに切り替え**:
   すでにこのリポジトリを Git 連携している (旧 Workers) ビルドプロジェクトの
   設定を開き、**Deploy command を変更**する。
   - Build command: `npm run build`
   - Deploy command: `npx wrangler deploy` → **`npx wrangler pages deploy`** に変更
     (`wrangler.jsonc` の `name` と `pages_build_output_dir` を読むため引数は不要。
      うまくいかない場合は `npx wrangler pages deploy dist/client --project-name inhouse-portal`)
   - 以後 main への push で自動デプロイされる

   > ⚠️ Deploy command が `npx wrangler deploy` (Workers用) のままだと
   > `Missing entry-point to Worker script or to assets directory` で失敗する。
   > 必ず `wrangler pages deploy` に変更すること。手元から一発で出すなら
   > `npm run deploy` (= `vite build` → `wrangler pages deploy`) でもよい。

4. **Cloudflare Access で保護**: Zero Trust → Access → Applications →
   Add an application (Self-hosted) で PagesのURL (下記カスタムドメイン) を指定し、
   ポリシーを作成。
   - 例: メールドメイン `@example.co.jp` を許可 + 協力者の個別メールを許可
   - Identity Provider に Google を設定するとGoogleログインになる

### カスタムドメイン (外部サブドメインをCNAMEで割り当てる)

ドメインのネームサーバをCloudflareに移さず、他社DNSのままサブドメインだけを
割り当てられる (これは Workers ではできず Pages のみ可能)。

1. Pagesプロジェクト → Custom domains → **Set up a custom domain** で
   使いたいサブドメイン (例 `portal.example.co.jp`) を登録する。
2. 現在のDNSプロバイダで CNAME レコードを追加:
   `portal.example.co.jp  →  <project>.pages.dev`
3. Cloudflare側の検証が通ると自動でTLS証明書が発行される。

> ⚠️ apex (裸ドメイン `example.co.jp`) を使う場合はゾーンをCloudflareに載せる
> 必要がある。サブドメインなら上記のCNAMEだけで完結する。
> ⚠️ Pagesダッシュボードでカスタムドメインを登録する**前に**CNAMEだけ先に張ると
> 522エラーになる。必ずダッシュボード登録 → CNAME の順で行うこと。

### GASプロキシの登録 (任意)

リンクとして開くだけのGASアプリには不要 (カードから `/exec` へ直行し、
GAS側のアカウント制限が効く)。ポータル画面自身がGASのデータを読む場合
(Phase 2のレジストリAPI等) のみ、エンドポイントをリポジトリに書かずに
Pagesの環境変数(secret)へ:

```bash
npx wrangler pages secret put PROXY_TARGETS
# 入力例: {"kintai-api":"https://script.google.com/macros/s/XXXX/exec"}
```

(ダッシュボードからも Settings → Environment variables で暗号化変数として登録可能)

→ ポータルからは `/api/proxy/kintai-api?…` で呼び出せる (GET/POSTのみ)。

### 手動デプロイ

```bash
npm run deploy   # vite build → wrangler pages deploy
```

## CI

GitHub Actions (`.github/workflows/ci.yml`) が push / PR ごとに実行:
typecheck → test → フロントビルド → Pages Functions バンドル検証
(`wrangler pages functions build`)。
