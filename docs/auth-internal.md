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
       ├─ サインイン済み(=Clerk で許可済み)      → next()
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
- **許可(誰がサインインできるか)は Clerk 側で管理**する(Restrictions の Allowlist、または
  Invitations)。サインインを通過した時点で許可済みとみなすので、middleware に許可リスト
  (env/KV)は持たない。オフボーディングは Clerk でユーザーを削除/BAN する。

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

### 2. 許可(サインイン可能な人)を Clerk で設定する

**誰が入れるか**は Clerk 側で管理する(アプリ側の許可リストは持たない)。

- **Restrictions → Allowlist**: サインアップ可能な identifier を指定する。
  - 社内メンバー: ドメイン `example.co.jp` を追加(社内全員を許可)。
  - 外部協力者: 個別メールを追加。
  - ダッシュボードでデプロイ不要に編集できる(KV でやっていた「デプロイ無しで出入りを編集」と
    同じ運用感)。協力者メール(PII)も自前 KV に持たずに済む。
- **Invitations(招待制)**: Allowlist がプランに無い場合の代替。許可するメールを招待し、
  招待された人だけがサインアップできるようにする。

> ⚠️ Clerk の許可設定(Allowlist / Invitations)をしないと、サインアップできてしまった人が
> 入れてしまう。**必ず設定すること**。オフボーディングは Clerk でユーザーを削除/BAN する。

### 3.(任意)セッショントークンに `email` クレームを足す

middleware の認可には email は不要だが、`/api/me`(画面ヘッダのメール表示)で使う。**セッション
JWTに `email` を含めておくと Backend API を呼ばずに表示できる**(未設定でも `getUser` へ
フォールバックする)。Clerk Dashboard → **Sessions → Customize session token** に追加する:

```json
{ "email": "{{user.primary_email_address}}" }
```

### 4. Secrets / 環境変数を Pages に登録

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

> **「変数」も「secret」も、コードからの読み方は同じ**。Pages Functions では plaintext 変数も
> secret もランタイムでは等しく `context.env` に生える。上表で「変数」の項目も secret として
> 登録して構わない(コード変更不要)。
>
> 誰が入れるか(許可)は環境変数ではなく **Clerk のダッシュボード**で管理する(手順2)。
> `CLERK_*` を設定しないと認証ゲートは fail-closed で全体を 503 にする。

### 5. production インスタンスの DNS(カスタムドメイン運用)

本番のカスタムドメインで使うには、Clerk の **production インスタンス**を作り、指示される
CNAME レコード(`clerk.<domain>` / `accounts.<domain>` 等)を**現在のDNSプロバイダに追加**する
(サブドメインだけなのでネームサーバ移管は不要。Pages の CNAME 割当と同じ要領)。

- production インスタンスの `pk_live_…` / `sk_live_…` を **Production 環境**に登録する。
- `__session` Cookie が本ドメイン(`.<domain>`)に載るため、middleware がそのまま検証できる。

## 許可(サインイン可能な人)の管理

すべて Clerk のダッシュボードで完結する(env/KV/デプロイは不要):

- **社内メンバー**: Restrictions → Allowlist にドメイン `example.co.jp` を追加(社内全員を許可)。
- **外部協力者の追加**: Allowlist に個別メールを追加、または Invitations で招待(即時反映、
  デプロイ不要)。
- **オフボーディング**: Allowlist / 招待から外し、既存ユーザーは Clerk でユーザーを削除・BAN する
  (サインイン自体を止められる)。
- **全員を即時ログアウト**させたいときは Clerk Dashboard からセッションを一括失効できる。

> Allowlist(identifier 制限)がプランに含まれない場合は Invitations(招待制)で同等の運用が
> できる。自分の Clerk プランで確認すること。

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
```

- development インスタンスは `localhost` を許可オリジンとして扱えるため、ローカルで実際の Clerk
  サインインを通せる。**動作確認の第一手段はこのローカル実行**。
- 誰がサインインできるかは Clerk(development インスタンス)の Restrictions で設定する。

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

- 認証・認可(誰がサインインできるか)は Clerk が担う(署名検証・失効管理・MFA・Allowlist /
  Invitations 等は Clerk の機能を使う)。認可境界を Clerk 設定に一本化しているので、**Clerk の
  許可設定を必ず行う**こと(未設定だとサインアップできた人が入れてしまう)。
- `CLERK_*` 未設定なら認証ゲートは全体 503(fail-closed)。
- `CLERK_AUTHORIZED_PARTIES` で `azp` を固定すると、別オリジン向けに発行されたトークンの
  持ち込みを弾ける。
- 協力者メール等の PII は自前 KV に持たず Clerk 側で管理する。
- GAS リンク(`/exec` へ直行するタイプ)側の Google アカウント制限は従来どおり独立して効く。
  ポータル認証はあくまで「一覧とプロキシAPIのゲート」。
