# inhouse-portal

事務所内+委託協力者向けのポータルサイト。設計ツール等(主にGAS Webアプリ)への
リンクを1か所にまとめ、Cloudflare Pages + Functions でホスティングし、
**Google ログイン(内製認証)** でアクセス制限をかける。

- 制作方針: [docs/PROPOSAL.md](docs/PROPOSAL.md)
- ロードマップ: [docs/ROADMAP.md](docs/ROADMAP.md)
- 認証 (Google OAuth) 設計・設定: [docs/auth-internal.md](docs/auth-internal.md)
- Phase 2 (GAS自動列挙) 設計: [docs/phase2-gas-registry.md](docs/phase2-gas-registry.md)

## アーキテクチャ

```
ユーザー → [Cloudflare Pages + Functions]
             └─ functions/_middleware.ts … 全リクエストの認証ゲート (Google OAuth)
                  ├─ 認証済み → 静的アセット (ポータル画面) … Pagesが配信
                  └─ /api/*
                       ├─ GET  /api/auth/login|callback|logout … ログイン導線
                       ├─ GET  /api/me         … ログイン中ユーザー
                       ├─ GET  /api/apps       … 台帳 (data/apps.json)
                       └─ ALL  /api/proxy/:id  … GASへの中継 (CORS回避・URL秘匿)
```

認証ゲート `functions/_middleware.ts` が **静的な画面ファイルを含む全リクエスト** に
割り込み、自前セッション(HMAC署名Cookie)を検証する。`/api/*` は
`functions/api/[[route]].ts` (Hono) が処理し、認証を通過した静的アセットは Pages が
`dist/client` から直接配信する。

> 💡 **なぜ Cloudflare Access ではなく内製認証か**: Access は Cloudflare
> アカウント内のホスト名しか保護できず、外部DNSに CNAME で割り当てた
> カスタムドメインは対象にできない(有料の Partial CNAME setup が必要)。
> ネームサーバ移管を避ける本構成と両立させるため認証をアプリ層で実装した。
> 詳細と設定手順は [docs/auth-internal.md](docs/auth-internal.md)。

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

1. **Pages プロジェクトを作成 (初回1回だけ)**:
   `wrangler pages deploy` は既存プロジェクトにしかデプロイできず
   (無いと `The Pages project "inhouse-portal" does not exist.`)、
   自動作成しないので、先に一度だけ作成する。

   ```bash
   npx wrangler login                      # 未ログインなら
   npx wrangler pages project create inhouse-portal --production-branch main
   ```

   > 手元にターミナルが無い場合は、ビルドの Deploy command を一時的に
   > `npx wrangler pages project create inhouse-portal --production-branch main; npx wrangler pages deploy`
   > にすれば、ビルド環境から作成＋デプロイできる (トークンに Pages:Edit がある前提。
   > 2回目以降は作成が「既に存在」で失敗するが `;` で無視されデプロイに進む)。
   > 初回成功後は Deploy command を `npx wrangler pages deploy` に戻してよい。

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

4. **内製認証 (Google OAuth) を設定**: Google Cloud で OAuth クライアントを作り、
   Pages に secret / 環境変数を登録する。詳細手順は
   [docs/auth-internal.md](docs/auth-internal.md) を参照。要点だけ:
   - Google Cloud → OAuth クライアント ID (ウェブ) を作成し、承認済みリダイレクト
     URI に `https://<カスタムドメイン>/api/auth/callback` を登録
   - 必須 secret: `AUTH_SECRET`(ランダム長文字列)/ `GOOGLE_CLIENT_ID` /
     `GOOGLE_CLIENT_SECRET`
     ```bash
     openssl rand -base64 48 | npx wrangler pages secret put AUTH_SECRET
     npx wrangler pages secret put GOOGLE_CLIENT_ID
     npx wrangler pages secret put GOOGLE_CLIENT_SECRET
     ```
   - 許可リスト: `ALLOWED_EMAIL_DOMAINS` / `ALLOWED_EMAILS`(`*` ワイルドカード可)を
     環境変数で設定。頻繁に出入りするなら KV `AUTH_KV` の `allowlist` キーに置くと
     デプロイ不要で編集できる(無料枠で収まる)
   - 例: `ALLOWED_EMAIL_DOMAINS=*@example.co.jp` + 協力者の個別メールを `ALLOWED_EMAILS`

   > ⚠️ `AUTH_SECRET` 未設定のままだと認証ゲートは fail-closed で全体を 503 にする
   > (設定漏れで丸ごと公開される事故を防ぐため)。デプロイ前に必ず登録すること。

   **プレビュー(PR)デプロイの保護**: プレビューは `*.pages.dev`(Cloudflare 所有
   ゾーン)上なので **Cloudflare Access を無料で掛けられる**。Zero Trust → Access で
   `*.<project>.pages.dev` にポリシーを掛けるだけでよい(**追加の環境変数は不要**)。
   middleware が「pages.dev + Access アサーションヘッダ ⇒ スルー、カスタムドメイン ⇒
   常に OAuth、Access 無しの pages.dev ⇒ OAuth にフォールバック(fail-closed)」を
   ホスト名とヘッダから自動判定する。さらに Preview 環境に
   `CF_ACCESS_TEAM_DOMAIN` + `CF_ACCESS_AUD` を設定すると、Access トークンを
   **RS256 署名検証**してからスルーする(ヘッダ偽装を暗号的に排除・推奨)。詳細は
   [docs/auth-internal.md](docs/auth-internal.md) の「環境ごとの保護方針」を参照。

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
