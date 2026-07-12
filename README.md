# inhouse-portal

事務所内+委託協力者向けのポータルサイト。設計ツール等(主にGAS Webアプリ)への
リンクを1か所にまとめ、Cloudflare Pages + Functions でホスティングし、
**Clerk(Google ログイン)** でアクセス制限をかける。

- 制作方針: [docs/PROPOSAL.md](docs/PROPOSAL.md)
- ロードマップ: [docs/ROADMAP.md](docs/ROADMAP.md)
- 認証 (Clerk) 設計・設定: [docs/auth-internal.md](docs/auth-internal.md)
- Phase 2 (GAS自動列挙) 設計: [docs/phase2-gas-registry.md](docs/phase2-gas-registry.md)

## アーキテクチャ

```
ユーザー → [Cloudflare Pages + Functions]
             └─ functions/_middleware.ts … 全リクエストの認証ゲート (Clerk)
                  ├─ 認証済み → 静的アセット (ポータル画面) … Pagesが配信
                  └─ /api/*
                       ├─ GET  /api/auth/logout … ログアウト (Clerk セッション失効)
                       ├─ GET  /api/me         … ログイン中ユーザー
                       ├─ GET  /api/apps       … 台帳 (data/apps.json)
                       ├─ GET  /api/registry   … 台帳＋GAS自動列挙のマージ (Phase 2)
                       └─ ALL  /api/proxy/:id  … GASへの中継 (CORS回避・URL秘匿)
```

認証ゲート `functions/_middleware.ts` が **静的な画面ファイルを含む全リクエスト** に
割り込み、Clerk のセッション(`@clerk/backend` の `authenticateRequest`)を検証する。
ログイン画面は Clerk の hosted サインイン(Account Portal)に委ね、未サインインの画面遷移は
middleware が Clerk のサインインURLへ 302 する。`/api/*` は `functions/api/[[route]].ts`
(Hono) が処理し、認証を通過した静的アセットは Pages が `dist/client` から直接配信する。

> 💡 **なぜ Clerk か**: 以前は「本番=自前 Google OAuth / プレビュー=Cloudflare Access
> (Zero Trust)」と環境で使い分けていたが、2つの認証系を維持する実装が複雑すぎた。Clerk は
> アプリ層で動くため**全ホストを同一コードで一律にゲート**でき、**無料枠(MAU 10,000)** で
> 運用できる。production インスタンスはサブドメインを CNAME 追加するだけ(ネームサーバ移管
> 不要)なので、外部DNSの Pages 構成と両立する。詳細は
> [docs/auth-internal.md](docs/auth-internal.md)。

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

> ℹ️ **このリポジトリには `wrangler.jsonc` を置かない**。Pages は設定ファイルが
> あるとそれをソースとみなし、**ダッシュボードのバインディング/環境変数の編集が
> 無効化される**ため、環境変数等をダッシュボードで運用したい本プロジェクトでは
> 意図的に削除している。代わりに以下をすべて **Cloudflare ダッシュボード**で設定する:
> - **Settings → Functions → Compatibility date**: `2026-06-01`(Functions の実行時互換日)
> - **Settings → Variables and Secrets**: Clerk のキー(下記手順4)
>   (認証は Clerk 側で許可管理するため、認証用の KV バインディングは不要)
>
> 設定ファイルが無いぶん、デプロイコマンドには出力先とプロジェクト名を明示する
> (`wrangler pages deploy dist/client --project-name inhouse-portal`)。`npm run deploy` /
> `npm run dev` はこの引数込みで定義済み。

1. **Pages プロジェクトを作成 (初回1回だけ)**:
   `wrangler pages deploy` は既存プロジェクトにしかデプロイできず
   (無いと `The Pages project "inhouse-portal" does not exist.`)、
   自動作成しないので、先に一度だけ作成する。

   ```bash
   npx wrangler login                      # 未ログインなら
   npx wrangler pages project create inhouse-portal --production-branch main
   ```

   > 手元にターミナルが無い場合は、ビルドの Deploy command を一時的に
   > `npx wrangler pages project create inhouse-portal --production-branch main; npx wrangler pages deploy dist/client --project-name inhouse-portal`
   > にすれば、ビルド環境から作成＋デプロイできる (トークンに Pages:Edit がある前提。
   > 2回目以降は作成が「既に存在」で失敗するが `;` で無視されデプロイに進む)。
   > 初回成功後は Deploy command を `npx wrangler pages deploy dist/client --project-name inhouse-portal` に戻してよい。

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
   - Deploy command: **`npx wrangler pages deploy dist/client --project-name inhouse-portal`**
     (`wrangler.jsonc` を置かないので、出力先とプロジェクト名は引数で明示する)
   - 以後 main への push で自動デプロイされる

   > ⚠️ Deploy command が `npx wrangler deploy` (Workers用) のままだと
   > `Missing entry-point to Worker script or to assets directory` で失敗する。
   > 必ず `wrangler pages deploy dist/client --project-name inhouse-portal` に変更すること。
   > 手元から一発で出すなら `npm run deploy` (= `vite build` → `wrangler pages deploy ...`) でもよい。

4. **認証 (Clerk) を設定**: Clerk アプリを作り、Pages に Clerk のキーを登録する。
   詳細手順は [docs/auth-internal.md](docs/auth-internal.md) を参照。要点だけ:
   - Clerk Dashboard でアプリを作成し、**Google 連携を有効化**(Phase 2 を使うなら追加スコープ
     `drive.metadata.readonly` / `script.deployments.readonly` も要求する設定にする)
   - **許可(誰がサインインできるか)を Clerk で設定**する(アプリ側の許可リストは持たない):
     - **Restrictions → Allowlist**: 社内ドメイン `example.co.jp` を追加(社内全員を許可)。
       協力者は個別メールを追加。ダッシュボードでデプロイ不要に編集できる
     - Allowlist がプランに無い場合は **Invitations(招待制)** で許可メールを招待する
   - (任意)セッショントークンに `email` クレームを足すと `/api/me` のメール表示が API 呼び出し
     なしで済む(Sessions → Customize session token に `{ "email": "{{user.primary_email_address}}" }`)
   - 必須: `CLERK_PUBLISHABLE_KEY` / `CLERK_SECRET_KEY`
     ```bash
     npx wrangler pages secret put CLERK_SECRET_KEY
     # CLERK_PUBLISHABLE_KEY は Variables で登録してもよい
     ```
   - 本番のカスタムドメインで使うには Clerk の **production インスタンス**を作り、指示される
     CNAME(`clerk.<domain>` 等)を外部DNSに追加する(サブドメインだけ=ネームサーバ移管不要)

   > ⚠️ `CLERK_*` 未設定のままだと認証ゲートは fail-closed で全体を 503 にする(設定漏れで
   > 丸ごと公開される事故を防ぐため)。また Clerk の許可設定(Allowlist / Invitations)を
   > しないと、サインアップできてしまった人が入れる。デプロイ前に必ず設定すること。

   **プレビュー(PR)デプロイの保護**: 認証は Clerk がアプリ層で一律にゲートするので、
   プレビュー(`*.pages.dev`)も本番と同じ middleware でゲートされる(Cloudflare Access は
   不要)。Preview 環境には Clerk の **development インスタンス**のキー(`pk_test`/`sk_test`)を
   設定する。ハッシュ付きプレビューURLでも dev インスタンスがそのまま通せる。詳細は
   [docs/auth-internal.md](docs/auth-internal.md) の「環境ごとの構成」を参照。

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

### GAS一覧の自動取得 (Phase 2) — 本人権限モード

デプロイ済みGAS Webアプリを手動で `apps.json` に書かずに自動列挙する。**ログイン中の本人が
アクセスできるGASだけ**(共有ドライブ内のものを含む)を、本人の Google 権限で列挙する
方式(方式B)。Google のアクセストークンを **Clerk の Google 連携から取得**し、Cloudflare が
Drive/Apps Script API を直接叩く。共有レジストリGAS(全員同じ一覧を返す旧方式)は使わない。
自動取得分には「自動」バッジが付く。

- 有効化:
  1. Clerk の Google 連携で、追加スコープ `drive.metadata.readonly` /
     `script.deployments.readonly` を要求する設定にする(Clerk の Social Connection → Google →
     Additional scopes)。独自の Google OAuth クライアントを使う場合は、その OAuth 同意画面に
     同スコープを追加する。**同意画面を「内部」にすれば審査不要**(同一 Workspace 組織メンバー
     限定)。外部協力者にも配るには「外部」+ Google審査が必要。
  2. 追加設定は不要。Clerk が設定済みで、ユーザーが Google 連携で上記スコープに同意していれば
     `/api/registry` が本人権限で列挙する(トークン保管用の専用 KV は不要)。
- 利用者側: 初回ログインで同意 → `https://script.google.com/home/usersettings` で
  Apps Script API を有効化(未有効なら画面にヒント表示)。
- 共有ドライブ: スクリプトを共有ドライブに置いていても、Drive API を
  `supportsAllDrives` / `includeItemsFromAllDrives` / `corpora=allDrives` 付きで叩くため、
  本人がメンバーの共有ドライブ内GASも列挙される(`src/server/google-registry.ts`)。検索が
  完全に終わらなかった場合は `incompleteSearch` を検知して警告ログ+画面通知を出す。
- 安全性: Google のリフレッシュ管理は **Clerk が担う**(本プロジェクト側でリフレッシュ
  トークンを保管しない)。アクセストークンはサーバー間でのみ使い、ブラウザには出さない。
- フォールバック: 本人のトークンが無い/取得失敗時は手動台帳(`apps.json`)のみを返すので、
  連携前でも画面は動く。失効時は画面から再ログインして Google を接続し直すと復旧する。
- 除外・表示名の上書きは `data/apps.json` の `gasRegistry` で調整:
  ```json
  {
    "apps": [ ... ],
    "gasRegistry": {
      "exclude": ["除外したいscriptId"],
      "overrides": { "あるscriptId": { "name": "表示名", "category": "設計ツール" } }
    }
  }
  ```

詳細と運用上の制約(同意画面の公開ステータスとトークン失効等)は
[docs/phase2-gas-registry.md](docs/phase2-gas-registry.md) を参照。

#### 旧・方式A(共有レジストリGAS)を運用していた環境の撤去手順

以前 **方式A(匿名公開の共有レジストリGAS + `PROXY_TARGETS["registry"]`)** を有効化していた
環境では、コードから方式Aが消えても**次のものはデプロイ側に残り続ける**。放置すると気づかれ
ないまま匿名公開エンドポイントが稼働し続けるため、必ず撤去すること:

1. **レジストリGAS Webアプリのデプロイを無効化(アーカイブ)** する。`ANYONE_ANONYMOUS` 公開
   のため、URL と token を知る者は実行ユーザーが所有する全GASの一覧(scriptId・名前・URL)を
   列挙できてしまう。
2. **`PROXY_TARGETS` から `registry` キーを削除** する。`/api/registry` からは参照されなく
   なるが、汎用プロキシ `/api/proxy/registry` 経由では**引き続き到達可能**なため
   (`proxy.ts` はキーを制限しない)、キー自体を消す必要がある。
   ```bash
   npx wrangler pages secret put PROXY_TARGETS   # registry キーを除いた内容で上書き
   ```
3. **スクリプトプロパティ `SHARED_SECRET` を削除** する(GAS の実行ログに URL=token が
   残っている可能性にも留意)。

### 手動デプロイ

```bash
npm run deploy   # vite build → wrangler pages deploy dist/client --project-name inhouse-portal
```

## CI

GitHub Actions (`.github/workflows/ci.yml`) が push / PR ごとに実行:
typecheck → test → フロントビルド → Pages Functions バンドル検証
(`wrangler pages functions build`)。

## デプロイ後の認証チェック

デプロイのたびに「認証が本当にかかっているか」を外形で自動検証する。
`.github/workflows/post-deploy-smoke.yml` が `scripts/smoke.mjs` で対象URLへ実際にアクセスし、
未認証アクセスが弾かれることを確認する。認証は Clerk がアプリ層で一律にゲートするので
ホストに依らず判定は同じだが、本番/プレビューでインスタンスが違うため2モードで実行する:

- **本番**(production): 固定ドメイン等を厳密なステータスで検証
  (`/api/apps`→401, `/api/me`→401, `/api/proxy/:id`→401, `/`→3xx でブロック)。
- **プレビュー**(ブランチ/PR デプロイ): dev インスタンスで細部が環境依存なため
  「未認証で `200` を返さない=公開されていない」ことを検証。

**トリガー**: Cloudflare Pages はデプロイ結果を GitHub の **Check Run**("Cloudflare Pages")
で通知するので、その `success` 完了を **`check_run`** イベントで受けて発火する
(`wrangler pages deploy` は Deployments API を使わず `deployment_status` は飛ばないが、
この Check Run は付く)。中継や通知設定は不要。default ブランチ上の workflow で動くため
**main マージ後**に有効。`check_suite.head_branch` で本番/プレビューを判定する。

検査対象URL(本番の固定ドメイン、デプロイ毎のユニークURL、ブランチエイリアス)は
`scripts/cf-deploy-urls.mjs` が Cloudflare Pages API から `head_sha` で解決する。Secrets
`CLOUDFLARE_API_TOKEN`(Pages:Read)/ `CLOUDFLARE_ACCOUNT_ID` が必要。詳細は
[docs/auth-internal.md](docs/auth-internal.md) の「デプロイ後の自動チェック」を参照。
