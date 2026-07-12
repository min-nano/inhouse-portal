# 認証 (Clerk) 設計・設定ガイド

## なぜ Clerk か(Zero Trust + Google OAuth の使い分けを廃止)

当初は「本番のカスタムドメイン=自前 Google OAuth / プレビューの `*.pages.dev`=
Cloudflare Access(Zero Trust)」という**環境ごとの使い分け**で保護していた。これは
「Access が無料で効くのは Cloudflare 所有ゾーン(`*.pages.dev`)だけで、外部DNSに CNAME で
生やしたカスタムドメインには効かない」という制約への対処だったが、**2つの認証系を維持する
実装が複雑**(署名検証・偽装ヘッダ対策・環境判定・redirect_uri の事前登録…)だった。

そこで**認証を Clerk に一本化**する。Clerk はアプリ層で動くため、カスタムドメイン
(外部DNS)でも `*.pages.dev` でも**同一のコード経路**でゲートでき、Cloudflare Access に
依存しない。Cloudflare 推奨の構成(Pages + Functions)と無料枠のまま両立する:

- **Clerk 無料枠**: 月間アクティブユーザー(MAU)10,000 まで無料。本プロジェクトの規模
  (事務所メンバー+協力者)なら十分収まる。production インスタンスも無料。
- **DNS**: Clerk の production インスタンスは `clerk.<domain>` 等の**サブドメインを CNAME で
  追加するだけ**で使える(ネームサーバ移管は不要)。Pages を外部DNSの CNAME で運用する本構成
  (→ `docs/PROPOSAL.md`)と同じやり方で完結する。
- Google Workspace アカウントでのログインは Clerk の **Google 連携**で実現する。Phase 2
  (本人権限での GAS 自動列挙)に必要な Google のアクセストークンも、Clerk から取得する
  (下記「Phase 2 のための Google 連携」)。

## 仕組み

```
リクエスト
  └─ functions/_middleware.ts              … 全リクエスト(静的アセット含む)の認証ゲート
       ├─ Clerk 未設定(キー欠落)                → 503(fail-closed)
       ├─ 公開パス(/api/health)                 → next()
       ├─ handshake(本ドメインの Cookie 未確定)  → Clerk の Set-Cookie + Location を返す
       ├─ サインイン済み + 許可リスト合致          → next()
       ├─ サインイン済みだが許可リスト外           → 403
       └─ 未サインイン
            ├─ 画面遷移(GET + Accept: text/html) → Clerk サインイン画面へ 302
            └─ APIリクエスト                       → 401 JSON

/api/auth/logout … Clerk セッションを失効させ、`__session` Cookie を消す
/api/me          … 現在のログインユーザー(画面ヘッダ表示用)
```

- ログイン画面は **Clerk の hosted なサインイン画面(Account Portal)**に委ねる。未サインインの
  画面遷移を middleware が Clerk のサインインURLへ 302 する(`redirect_url` に元のURLを付ける)。
- セッションは Clerk が発行する **JWT(`__session` Cookie)**。middleware は `@clerk/backend` の
  `authenticateRequest()` で検証する(`src/server/auth/clerk.ts`)。検証は JWKS、または
  `CLERK_JWT_KEY`(PEM 公開鍵)を設定すると networkless で行う。
- **handshake**: Clerk 側にセッションはあるが本ドメインの `__session` Cookie がまだ無い状態。
  `authenticateRequest()` が返す Set-Cookie + Location をそのまま返して Cookie を確定させる
  (ClerkJS をフロントに載せなくても成立する)。
- **許可リスト照合**は従来どおりアプリ側で行う(社内ドメイン + 指名した協力者のみ通す)。
  Clerk が検証したメールで判定する。毎リクエストの API 呼び出しを避けるため、**セッションJWTに
  `email` クレームを含める設定**を推奨する(下記セットアップ手順2)。

`_middleware.ts` はプロジェクトへの全リクエストに割り込むため、**画面(静的HTML)も含めて
丸ごと**ゲートできる。

## セットアップ

### 1. Clerk アプリケーションを作る

[Clerk Dashboard](https://dashboard.clerk.com/) で:

1. アプリケーションを作成する。
2. **User & Authentication → Social Connections → Google を有効化**する。全員が Google
   アカウント(Workspace + GAS)を持つ前提に合致する。
   - Phase 2(GAS自動列挙)を使うなら、Google 連携の設定で**追加スコープ**
     `https://www.googleapis.com/auth/drive.metadata.readonly` と
     `https://www.googleapis.com/auth/script.deployments.readonly` を要求する設定にする
     (Clerk の Google 連携で "Additional scopes" を指定。詳細は下記「Phase 2 のための Google 連携」)。
   - 独自の Google OAuth クライアントを使う場合は、その承認済みリダイレクトURIに Clerk の
     コールバック(`https://<Clerk FAPI ドメイン>/v1/oauth_callback`)を登録する。Clerk 既定の
     共有クレデンシャルでも動くが、追加スコープを使うなら独自クライアント推奨。
3. **API Keys** から `Publishable key`(`pk_…`)と `Secret key`(`sk_…`)を控える。

> 許可の最終判定はアプリ側の許可リストで行うので、Clerk 側の "Restrictions" は任意。必要なら
> Clerk の Allowlist/Restrictions で二重に絞ってもよい。

### 2. セッショントークンに `email` クレームを足す(推奨)

middleware は許可リスト照合のためにメールが要る。**セッションJWTに `email` を含めておくと、
毎リクエストで Backend API を呼ばずに済む**(未設定でも `getUser` へフォールバックするが遅い)。

Clerk Dashboard → **Sessions → Customize session token** に以下を追加する:

```json
{ "email": "{{user.primary_email_address}}" }
```

### 3. Secrets / 環境変数を Pages に登録

秘匿値は Wrangler かダッシュボード(Settings → Variables and Secrets)で登録する。

```bash
npx wrangler pages secret put CLERK_SECRET_KEY
# CLERK_PUBLISHABLE_KEY は変数でも secret でもよい
```

| 変数 | 必須 | 種別 | 説明 |
|---|---|---|---|
| `CLERK_PUBLISHABLE_KEY` | ✅ | 変数/secret | Clerk の Publishable key(`pk_test_…`/`pk_live_…`) |
| `CLERK_SECRET_KEY` | ✅ | secret | Clerk の Secret key(`sk_test_…`/`sk_live_…`) |
| `CLERK_JWT_KEY` | 任意 | 変数/secret | JWT 検証用の公開鍵(PEM)。設定すると JWKS 取得なしの networkless 検証になる(Clerk Dashboard の JWKS/PEM から取得) |
| `CLERK_AUTHORIZED_PARTIES` | 推奨 | 変数 | `azp` として許可するオリジン(カンマ区切り)。例 `https://portal.example.co.jp`。別オリジンからのトークン持ち込みを弾く |
| `AUTH_SECRET` | △ | secret | **個別メール**許可リスト(env `ALLOWED_EMAILS` / KV `emailHashes`)用の HMAC 鍵。ドメイン許可リストのみで運用するなら不要 |
| `ALLOWED_EMAIL_DOMAINS` | △ | 変数 | 許可ドメイン。例 `example.co.jp` / `*.example.co.jp`(`*@`/`@` 前置は無視) |
| `ALLOWED_EMAILS` | △ | secret | 許可する個別メール(PII)。カンマ区切り。例 `taro@partner.com` |
| `AUTH_KV` | 任意 | KV binding | 運用中に追加・失効する許可リスト置き場(デプロイ不要で編集可) |

> **「変数」も「secret」も、コードからの読み方は同じ**。Pages Functions では plaintext 変数も
> secret もランタイムでは等しく `context.env` に生える。上表で「変数」の項目も secret として
> 登録して構わない(コード変更不要)。
>
> ⚠️ 許可リストを何も設定しない(ドメインも個別メールも KV も無い)と、**サインインできても
> 全員が許可リスト外=403** になる(fail-closed)。最低でも `ALLOWED_EMAIL_DOMAINS` を設定すること。

### 4. production インスタンスの DNS(カスタムドメイン運用)

本番のカスタムドメインで使うには、Clerk の **production インスタンス**を作り、指示される
CNAME レコード(`clerk.<domain>` / `accounts.<domain>` 等)を**現在のDNSプロバイダに追加**する
(サブドメインだけなのでネームサーバ移管は不要。Pages の CNAME 割当と同じ要領)。

- production インスタンスの `pk_live_…` / `sk_live_…` を **Production 環境**に登録する。
- `__session` Cookie が本ドメイン(`.<domain>`)に載るため、middleware がそのまま検証できる。

### 5. (推奨) 許可リストを KV に置く

env の許可リストは変更のたびに再デプロイが要る。**KV を使うとダッシュボードからデプロイ無しで
追加・失効できる**(協力者の出入りが多い場合に有用)。無料枠(読み取り10万/日・書き込み
1,000/日・1GB)で十分収まる。

```bash
npx wrangler kv namespace create AUTH_KV
```

作成した namespace を **Pages ダッシュボードで紐づける**:
Settings → Functions → KV namespace bindings で binding 名 `AUTH_KV` として選ぶ(このリポジトリは
`wrangler.jsonc` を置かない方針なので、バインディングはダッシュボードで設定する)。

キー `allowlist` に **`{ domains, emailHashes }`** 形式で登録する。**個別メールは KV に平文で
置かず、`HMAC-SHA256(AUTH_SECRET, "allowlist:"+email)` のハッシュ**を入れる(KV が漏れても、
AUTH_SECRET を知らない限り誰が許可されているか総当たりで特定できない)。ハッシュは同梱スクリプトで
算出する:

```bash
AUTH_SECRET='<本番と同じ値>' node scripts/allowlist-hash.mjs taro@partner.com hanako@partner.co.jp
# → {"domains":[],"emailHashes":["<hex>","<hex>"]} が出力される

npx wrangler kv key put --binding=AUTH_KV allowlist \
  '{"domains":["example.co.jp"],"emailHashes":["<hex>","<hex>"]}'
```

**最終的な許可リストは env と KV の和集合**なので、安定した社内ドメインを env に、流動的な
協力者(個別メール)を KV の `emailHashes` に、という使い分けもできる。

> 後方互換: 旧形式の文字列配列 `["*@example.co.jp","taro@partner.com"]` や
> `{ "patterns": [...] }` も引き続き読める(ドメイン/平文メールに自動振り分け)。ただし
> **平文メールを KV に置くと列挙されうる**ため、新規は `emailHashes` を推奨。

## 許可リストの書式

- **ドメイン**(`ALLOWED_EMAIL_DOMAINS` / KV `domains`): Clerk が検証したメールのドメイン部で
  判定(大文字小文字無視)。

  | 記法 | 意味 |
  |---|---|
  | `example.co.jp`(`@example.co.jp` / `*@example.co.jp` も同義) | example.co.jp ドメインの全員(社内) |
  | `*.example.co.jp` | サブドメイン配下のみ(`a@team.example.co.jp`。apex は含めない) |

- **個別メール**: env `ALLOWED_EMAILS`(平文)/ KV `emailHashes`(HMACハッシュ)。完全一致・
  大文字小文字無視。**個別メールを使うときだけ `AUTH_SECRET` が必要**。

## 運用

- **協力者の追加**: `scripts/allowlist-hash.mjs` でメールのハッシュを算出し、KV の
  `allowlist.emailHashes` に足す(即時反映、デプロイ不要)。ドメイン単位なら `domains` に。
- **オフボーディング**: 許可リストから外す → 再アクセス不可(次リクエストで 403)。Clerk 側で
  ユーザーを削除・BAN すればサインイン自体を止められる。
- **全員を即時ログアウト**させたいときは Clerk Dashboard からセッションを一括失効できる。

## Phase 2 のための Google 連携(本人権限での GAS 自動列挙)

Phase 2(`/api/registry`)は、ログイン中の本人がアクセスできる GAS を **本人の Google 権限**で
列挙する(方式B)。そのため Google の**アクセストークン**が要る。これを Clerk から取得する:

1. Clerk の Google 連携で、追加スコープ `drive.metadata.readonly` /
   `script.deployments.readonly` を要求する設定にする(手順1)。
2. `/api/registry` はサインイン中ユーザーの `userId` から Backend API
   `getUserOauthAccessToken(userId, "google")` で Google アクセストークンを取り、Drive API /
   Apps Script API を直接叩いて列挙する(`src/server/google-registry.ts`)。**リフレッシュは
   Clerk が担う**ので、本プロジェクト側でリフレッシュトークンを保管しない(旧方式の
   `token-store` / KV 保管は廃止)。
3. トークンが無い(Google 未連携)/失効している場合は手動台帳(`apps.json`)へフォールバック
   する。失効時は画面から**再ログイン**して Google を接続し直すと復旧する。

詳細と運用上の制約(センシティブスコープ・Apps Script API の有効化等)は
[docs/phase2-gas-registry.md](phase2-gas-registry.md) を参照。

## ローカル開発

`npm run dev`(= `wrangler pages dev dist/client`)で起動する。`.dev.vars`(gitignore 済み)に
Clerk の **development インスタンス**のキーを置く:

```
CLERK_PUBLISHABLE_KEY=pk_test_xxxx
CLERK_SECRET_KEY=sk_test_xxxx
ALLOWED_EMAIL_DOMAINS=*@example.co.jp
```

- development インスタンスは `localhost` を許可オリジンとして扱えるため、ローカルで実際の Clerk
  サインインを通せる。**動作確認の第一手段はこのローカル実行**。
- KV をローカルで使うなら `wrangler pages dev dist/client --kv AUTH_KV`。未指定でも env の
  許可リストで動作する。

## 環境ごとの構成(本番=production インスタンス / プレビュー=development インスタンス)

コード経路は全環境で同一(middleware の Clerk ゲート)。**違いはデプロイに渡す Clerk キーだけ**:

| 環境 | ホスト | Clerk インスタンス | 設定 |
|---|---|---|---|
| 本番 | カスタムドメイン(外部DNS) | production(`pk_live`/`sk_live`) | Production 環境に live キー + DNS(CNAME) |
| プレビュー(PR) | `*.pages.dev` | development(`pk_test`/`sk_test`) | Preview 環境に test キー |
| ローカル | `localhost:8788` | development | `.dev.vars` |

- **プレビュー**: デプロイごとに変わるハッシュ付きURL(`<hash>.<project>.pages.dev`)でも、Clerk
  の development インスタンスは dev ブラウザ機構でセッションを確立できるため、そのまま
  ゲートできる(旧構成のように Cloudflare Access に委譲する必要は無い)。
- 本番の `<project>.pages.dev` エイリアスも同じ production インスタンスでゲートされる(未認証は
  401/302)。通常の利用はカスタムドメインで行う。

## デプロイ後の自動チェック(認証がかかっていることの検証)

デプロイのたびに「認証が本当にかかっているか」を外形(HTTPレスポンス)で自動検証する。検査
ロジックは [`scripts/smoke.mjs`](../scripts/smoke.mjs)、実行は GitHub Actions
[`.github/workflows/post-deploy-smoke.yml`](../.github/workflows/post-deploy-smoke.yml)。

認証は Clerk がアプリ層で一律にゲートするので、カスタムドメインでも `*.pages.dev` でも未認証の
ステータスは同じになる。モードは本番/プレビューで分ける(プレビューは dev インスタンスで細部が
環境依存なため、緩めに「200 を返さない」だけを見る)。

**① production モード**(例 `portal.example.co.jp` / `inhouse-portal.pages.dev`)。**正確な
ステータス**を検証する:

| リクエスト | 期待 | 崩れたときの意味 |
|---|---|---|
| `GET /api/health` | `200` | デプロイ生存(公開パス) |
| `GET /api/apps`(未認証) | `401` | `200`=台帳データが公開 / `503`=設定漏れ(fail-closed) |
| `GET /api/me`(未認証) | `401` | — |
| `GET /api/proxy/:id`(未認証) | `401` | GAS中継が公開 |
| `GET /`(未認証, `Accept: text/html`) | `3xx`(Clerk サインインへ) | `200`=画面が公開 |

**② preview モード**(`--preview`。ブランチ/PRのプレビュー: `*.pages.dev`)。「**未認証で `200` を
返さない=何らかの認証でブロックされている**」ことだけを検証する:

| リクエスト | 期待 | 崩れたときの意味 |
|---|---|---|
| `GET /api/apps`(未認証) | `3xx`/`401`/`403` | `200`=プレビューが公開 |
| `GET /`(未認証, `Accept: text/html`) | `3xx`/`401`/`403` | `200`=画面が公開 |

**トリガー**(cron は付けない):
- **デプロイ完了**: `check_run`(`types: [completed]`)で発火。Cloudflare Pages が発行する
  **"Cloudflare Pages" Check Run** が `success` で完了したときだけ検査する。
  `check_suite.head_branch` が本番ブランチ(既定 `main`)なら ① production、それ以外は
  ② preview。対象デプロイは `check_run.head_sha` で特定する。
- **手動**: `workflow_dispatch`(`urls` と `mode` を上書き可)。

**結果の表示先**: `check_run` 起動のこの実行は main の実行として扱われるため、検査結果を
`check_run.head_sha`(= そのブランチのコミット)へ commit status `auth-smoke` として投稿する
(開始時 `pending` → 終了時 `success`/`failure`)。これで各ブランチ/PR のチェック欄に表示され、
ブランチ保護の必須チェックにも指定できる。

> ⚠️ **なぜ `check_run` か(`deployment_status` ではない理由)**: `wrangler pages deploy`
> (Direct Upload)は GitHub の Deployments API を使わず `deployment_status` は飛ばない。一方
> Cloudflare Pages は GitHub App `cloudflare-workers-and-pages` として **Check Run** を各
> コミットに付けるので、これを `check_run` イベントで受ける。default ブランチ上の workflow で
> 動くため、この仕組みは **main にマージ後**に有効になる。

**検査対象URLの解決**: 検査対象は Cloudflare Pages API から取得する
([`scripts/cf-deploy-urls.mjs`](../scripts/cf-deploy-urls.mjs))。production では固定ドメイン +
`head_sha` 一致デプロイのユニークURL、preview ではそのデプロイのユニークURL / ブランチ
エイリアスを解決する。GitHub Secrets `CLOUDFLARE_API_TOKEN`(Pages:Read)/
`CLOUDFLARE_ACCOUNT_ID` が必要。API解決は失敗しても本命のスモークは落とさず、変数
`SMOKE_BASE_URLS`(カンマ区切り)や `environment_url` にフォールバックする。

ローカル実行(任意):

```bash
node scripts/smoke.mjs https://portal.example.co.jp                 # 本番
node scripts/smoke.mjs --preview https://<hash>.inhouse-portal.pages.dev  # プレビュー
```

## セキュリティ上の要点

- 認証は Clerk が担う(セッションJWTの署名検証・失効管理・MFA 等は Clerk の機能を使う)。
- `CLERK_AUTHORIZED_PARTIES` で `azp` を固定すると、別オリジン向けに発行されたトークンの
  持ち込みを弾ける。
- 許可リスト(社内ドメイン + 指名協力者)がアプリ側の認可境界。**未設定なら全員 403**
  (fail-closed)。`CLERK_*` 未設定なら全体 503(fail-closed)。
- 個別メールは KV に平文で置かず HMAC ハッシュ(`AUTH_SECRET` 鍵)で保存する。
- GAS リンク(`/exec` へ直行するタイプ)側の Google アカウント制限は従来どおり独立して効く。
  ポータル認証はあくまで「一覧とプロキシAPIのゲート」。
