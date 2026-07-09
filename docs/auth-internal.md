# 内製認証 (Google OAuth) 設計・設定ガイド

## なぜ Cloudflare Access ではなく内製にしたか

当初は Cloudflare Access (Zero Trust) でポータル全体を保護する方針だった。
しかし **Access のポリシーは「Cloudflare アカウント内に存在するホスト名(ゾーン)」
にしか適用できない** ことが判明した。

- `*.pages.dev` は Cloudflare 所有なので無料で Access を掛けられるが、
  **外部DNS(他社ネームサーバ)に CNAME で生やしただけのカスタムドメイン**
  (`portal.example.co.jp → <project>.pages.dev`)はゾーンがアカウント内に無く、
  Access アプリの対象ホストに追加できない。
- ネームサーバを移さずにゾーンだけ取り込む **Partial (CNAME) setup は Business
  プラン以上(有料)**。

ネームサーバ移管を避けたくて Pages + 外部CNAME 構成を選んだ経緯(→
`docs/PROPOSAL.md`)と両立させるため、**認証をエッジ(Access)からアプリ層へ降ろす**。
これによりホスト名の制約を受けず、無料・DNS変更なしでカスタムドメイン上のポータル
全体をアクセス制限できる。

## 仕組み

```
リクエスト
  └─ functions/_middleware.ts          … 全リクエスト(静的アセット含む)の認証ゲート
       ├─ 認証済み(セッションCookie有効)          → next() 通常配信
       ├─ 公開パス(/api/auth/*, /api/health)      → next()
       └─ 未認証
            ├─ 画面遷移(GET + Accept: text/html)  → /api/auth/login へ 302
            └─ APIリクエスト                       → 401 JSON

/api/auth/login    … state/PKCE を発行し Google 同意画面へリダイレクト
/api/auth/callback … code をトークン交換 → 許可リスト照合 → セッションCookie発行
/api/auth/logout   … セッションCookie削除
/api/me            … 現在のログインユーザー(画面ヘッダ表示用)
```

- **セッションは HMAC-SHA256 署名の自己完結型 JWT**(`portal_session` Cookie,
  HttpOnly / SameSite=Lax、既定7日)。検証にKVを引かないので毎リクエストのコストは
  ほぼゼロ。
- ログインは Google OAuth 2.0 Authorization Code + **PKCE + state(CSRF対策)**。
  一時値は短命の署名Cookie `portal_oauth`(10分)に保持する。
- `id_token` は client_secret 付きのサーバー間TLS交換で受け取るため信頼でき、
  クレーム(`iss`/`aud`/`exp`/`email`/`email_verified`)を検証して採用する。

`_middleware.ts` はプロジェクトへの全リクエストに割り込むため、**画面(静的HTML)も
含めて丸ごと** ゲートできるのがポイント。

## セットアップ

### 1. Google OAuth クライアントを作る

[Google Cloud Console](https://console.cloud.google.com/) で:

1. プロジェクトを用意(既存の GAS と同じ組織/プロジェクトでよい)。
2. **APIとサービス → OAuth 同意画面** を設定
   - User type: 社内(Google Workspace)なら **Internal** にすると
     `@example.co.jp` 以外は同意画面すら通れず、二重の防御になる。
     外部協力者(Workspace外のGoogleアカウント)を入れる場合は **External** にし、
     許可はアプリ側の許可リストで行う。
   - スコープは `openid` `email` `profile`(既定で足りる)。
3. **APIとサービス → 認証情報 → 認証情報を作成 → OAuth クライアント ID**
   - 種類: **ウェブアプリケーション**
   - **承認済みのリダイレクト URI** に、使うホスト名分だけ登録する
     (アプリはリクエストから redirect_uri を自動生成するが、Google 側の事前登録は
     完全一致で必須):
     - 本番: `https://portal.example.co.jp/api/auth/callback`
     - `*.pages.dev` も使うなら: `https://<project>.pages.dev/api/auth/callback`
     - ローカル: `http://localhost:8788/api/auth/callback`
   - 発行された **クライアント ID** と **クライアント シークレット** を控える。

### 2. Secrets / 環境変数を Pages に登録

秘匿値(secret)は Wrangler かダッシュボード(Settings → Environment variables で
「暗号化」)で登録する。

```bash
# ランダムな長い文字列(セッション/state 署名鍵)
openssl rand -base64 48 | npx wrangler pages secret put AUTH_SECRET

npx wrangler pages secret put GOOGLE_CLIENT_ID
npx wrangler pages secret put GOOGLE_CLIENT_SECRET
```

| 変数 | 必須 | 種別 | 説明 |
|---|---|---|---|
| `AUTH_SECRET` | ✅ | secret | セッション/state のHMAC署名鍵。**ローテートで全セッション即失効** |
| `GOOGLE_CLIENT_ID` | ✅ | secret/変数 | OAuth クライアントID |
| `GOOGLE_CLIENT_SECRET` | ✅ | secret | OAuth クライアントシークレット |
| `ALLOWED_EMAIL_DOMAINS` | △ | 変数 | 許可リスト(ドメイン系)。`*` 可。例 `*@example.co.jp` |
| `ALLOWED_EMAILS` | △ | 変数 | 許可リスト(個別)。カンマ区切り。例 `taro@partner.com` |
| `GOOGLE_HOSTED_DOMAIN` | 任意 | 変数 | 同意画面の `hd` ヒント(UX用)。例 `example.co.jp` |
| `APP_BASE_URL` | 任意 | 変数 | redirect_uri の基点を明示上書き。通常はリクエストから自動導出 |
| `SESSION_TTL_HOURS` | 任意 | 変数 | セッション有効時間。既定 `168`(7日) |
| `CF_ACCESS_TEAM_DOMAIN` | 推奨 | secret/変数 | プレビュー用。Access トークンを**署名検証**する。例 `myteam`(iss を固定)。詳細は下記 |
| `CF_ACCESS_AUD` | 推奨 | secret/変数 | プレビュー用。Access アプリの AUD タグ(aud を固定) |

> `CF_ACCESS_*` は「プレビューを Cloudflare Access で保護し Function 認証をスルーする」
> ための設定。**両方揃ったときだけ**、署名検証を通ったプレビューをスルーする。
> **本番(Production)環境には設定しない**こと(未設定が本番の pages.dev エイリアスを
> 確実にゲートする条件になる。下記「環境ごとの保護方針」参照)。

> **「変数」も「secret」も、コードからの読み方は同じ**。Pages Functions では
> plaintext 変数も secret もランタイムでは等しく `context.env` に生える。したがって
> 上表で「変数」となっている項目も **secret として登録して構わない**(ダッシュボードで
> secret しか登録できない場合でもそのまま動く。コード変更不要)。secret は
> 「暗号化保存され登録後は非表示」なだけで、実行時の値の見え方は変数と同一。

> `ALLOWED_EMAIL_DOMAINS` と `ALLOWED_EMAILS` は分けているが役割は同じ(単に
> 見通しのため)。どちらにワイルドカードや個別アドレスを書いてもよい。

### 3. (推奨) 許可リストを KV に置く

env の許可リストは変更のたびに再デプロイが要る。**KV を使うとダッシュボードから
デプロイ無しで追加・失効できる**(協力者の出入りが多い場合に有用)。無料枠
(読み取り10万/日・書き込み1,000/日・1GB)で十分収まる。

```bash
npx wrangler kv namespace create AUTH_KV
```

作成した namespace を **Pages ダッシュボードで紐づける**:
Settings → Functions → KV namespace bindings で binding 名 `AUTH_KV` として上記
namespace を選ぶ(このリポジトリは `wrangler.jsonc` を置かない方針なので、
バインディングはダッシュボードで設定する。設定ファイルがあるとダッシュボードの
バインディング編集が無効化されるため)。

キー `allowlist` に JSON 配列で登録する:

```bash
npx wrangler kv key put --binding=AUTH_KV allowlist \
  '["*@example.co.jp","taro@partner.com","hanako@partner.co.jp"]'
```

`{ "patterns": [...] }` 形式も受け付ける。**最終的な許可リストは env と KV の
和集合**なので、安定した社内ドメインを env に、流動的な協力者を KV に、という
使い分けもできる。

## 許可リストの書式(ワイルドカード)

各エントリはメールアドレスのパターン。`*` を任意長のワイルドカードとして使え、
検証済みメール(`email_verified: true`)に対して **全文一致・大文字小文字無視**
で判定する。

| パターン | 意味 |
|---|---|
| `*@example.co.jp` | example.co.jp ドメインの全員(社内) |
| `taro@partner.com` | 個別の協力者(完全一致) |
| `*@*.example.co.jp` | サブドメイン配下(`a@team.example.co.jp` 等) |

## 運用

- **協力者の追加**: KV の `allowlist` に1行足す(即時反映、デプロイ不要)。
- **オフボーディング**: 許可リストから外す → 再ログイン不可。既存セッションは
  TTL(既定7日)経過で自然失効。**全員を即時ログアウトさせたい**ときは
  `AUTH_SECRET` をローテートする(既存の全セッション・全stateが無効化される)。
- **セッション期間の調整**: `SESSION_TTL_HOURS`。

## ローカル開発

`npm run dev`(= `wrangler pages dev dist/client`)で起動する。`.dev.vars`
(gitignore 済み)に secret を置くと読み込まれる:

```
AUTH_SECRET=dev-only-secret
GOOGLE_CLIENT_ID=xxxx.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=xxxx
ALLOWED_EMAIL_DOMAINS=*@example.co.jp
```

- Google 側の承認済みリダイレクトURIに `http://localhost:8788/api/auth/callback`
  を登録しておくこと(Google は loopback の http を特別に許可している)。
- `secure` Cookie はローカルの `http://localhost` でも Chrome では有効
  (localhost は secure コンテキスト扱い)。
- KV をローカルで使うなら `wrangler pages dev dist/client --kv AUTH_KV`。未指定でも
  env の許可リストで動作する(`wrangler.jsonc` を置かないため、ローカルの KV
  バインディングはこの `--kv` フラグで与える)。

`wrangler pages dev` は `functions/_middleware.ts` もルートも本番と同一のものを
動かし、実際の Google ログインを通せる。**動作確認の第一手段はこのローカル実行**。

## 環境ごとの保護方針(本番=OAuth / プレビュー=Cloudflare Access)

保護は環境で使い分ける。理由は「Cloudflare Access が無料で効くのは Cloudflare 所有
ゾーン(`*.pages.dev`)だけ」で、本番のカスタムドメイン(外部DNS)は Access の対象に
できないため。**Access が効く所は Access、効かない所は OAuth** と割り当てる。

| 環境 | ホスト | 保護 | 設定 |
|---|---|---|---|
| 本番 | カスタムドメイン(外部DNS) | 内製 OAuth | `CF_ACCESS_*` は**設定しない**(既定で OAuth) |
| プレビュー(PR) | `*.pages.dev` | Cloudflare Access | Access ポリシー + Preview環境に `CF_ACCESS_TEAM_DOMAIN`/`CF_ACCESS_AUD` |
| ローカル | `localhost:8788` | 内製 OAuth | `.dev.vars` |

なぜプレビューで OAuth を使わないか: OAuth の `redirect_uri` は **完全一致で事前登録が
必須**(ワイルドカード不可)なので、**デプロイごとに変わるハッシュ付きプレビューURL**
(`https://<コミットhash>.<project>.pages.dev`)では通せない。一方 pages.dev は
Cloudflare 所有ゾーンなので Access を無料で掛けられる。よってプレビューは Access に任せ、
Function 側の認証はスルーする。

### 本番/プレビューの判定は自動(追加変数なし)

Pages の組み込み変数(`CF_PAGES_BRANCH` / `CF_PAGES_URL` 等)は **ビルド時にしか
存在せず、Functions のランタイム `env` には入らない**。そのため middleware では
それらを読めない。代わりに、ランタイムで確実に得られる2つの手掛かりで自動判定する:

- **ホスト名**: プレビューは `*.pages.dev`、本番はカスタムドメイン。
- **`Cf-Access-Jwt-Assertion` ヘッダ**: Cloudflare Access が前段にいると全リクエスト
  (静的アセット含む)に注入される。

判定ロジック(`functions/_middleware.ts`)。**バイパスは次を すべて 満たすときだけ**:
①ホストが `*.pages.dev` ②`CF_ACCESS_TEAM_DOMAIN` と `CF_ACCESS_AUD` の両方が設定
③`Cf-Access-Jwt-Assertion` の署名検証(iss/aud/exp)が通る。

| ホスト | team domain + aud | 署名検証 | 挙動 |
|---|---|---|---|
| `*.pages.dev` | 両方あり | 成功 | **スルー**(Access 保護済み ⇒ プレビュー) |
| `*.pages.dev` | 両方あり | 失敗/ヘッダ無し | OAuth を要求(fail-closed) |
| `*.pages.dev` | 片方でも欠ける | — | **OAuth を要求**(本番はここ。偽装ヘッダでもスルーしない) |
| カスタムドメイン | — | — | **常に OAuth**(バイパスは pages.dev 限定) |

この設計の安全性:
- **バイパスの唯一の道が「正当な署名付き Access トークン」**。ヘッダ偽装は署名検証で
  暗号的に弾かれ、`iss`/`aud` を固定するので自作JWKS・別アプリのトークン再利用も無効。
- **本番には team domain・aud を設定しない**運用にすれば、本番の pages.dev エイリアス
  (`<project>.pages.dev`)に偽装ヘッダでアクセスされても、条件②で確実に OAuth に
  落ちる(=事実上ブロック)。カスタムドメインはホスト条件で最初から対象外。
- presence チェック(ヘッダの有無だけで通す暫定モード)は**廃止**した。以前は本番
  pages.dev エイリアス + 偽装ヘッダ + Access 未設定で素通りする穴があったため。

### 署名検証(プレビューをAccessで通すなら必須)

`Cf-Access-Jwt-Assertion` は Cloudflare Access が RS256 で署名した JWT。
`CF_ACCESS_TEAM_DOMAIN` と `CF_ACCESS_AUD` の**両方**を設定すると、middleware が
`src/server/auth/cf-access.ts` でこれを検証してからスルーする(片方でも欠けると
プレビューでもスルーせず OAuth を要求する):

- **署名**: チームの JWKS(`https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`)
  で検証。公開鍵は isolate 内で1時間キャッシュし、未知の kid(鍵ローテート)を見たら
  取得し直す。
- **iss**: `CF_ACCESS_TEAM_DOMAIN` から組み立てた issuer に固定(トークンの iss を
  信用して JWKS 取得先を決めない = 攻撃者による差し替えを防ぐ)。
- **aud**: `CF_ACCESS_AUD` に固定(同一チーム内の別アプリのトークン再利用を防ぐ)。
- **exp / nbf**: 期限切れ・未来発行を拒否。

検証に失敗したトークンはバイパスせず OAuth にフォールバック(fail-closed)する。

**AUD タグの入手**: Zero Trust → Access → Applications → 対象アプリ → Overview の
「Application Audience (AUD) Tag」(64桁の16進)。`CF_ACCESS_TEAM_DOMAIN` はチーム名
(`https://<team>.cloudflareaccess.com` の `<team>` 部分。フルドメインでも可)。

これらは秘密情報ではないが、**secret として登録しても問題ない**(Pages は secret も
変数もランタイムでは同じく `env` に生えるため、`env.CF_ACCESS_TEAM_DOMAIN` はどちらでも
読める)。ダッシュボードで secret しか登録できない環境でも、そのまま署名検証が働く:

```bash
npx wrangler pages secret put CF_ACCESS_TEAM_DOMAIN   # 例: myteam
npx wrangler pages secret put CF_ACCESS_AUD           # 例: 64桁のAUDタグ
```

> ⚠️ Pages の secret は Production / Preview の環境ごとに登録する。プレビュー保護の
> ためなら **Preview 環境**に登録すること。

なお **`iss`/`aud` を実行環境(トークン)から自動取得することはできない**。ランタイムで
それらが載っている唯一の情報源は検証対象のトークン自身であり、そこから基準値を取ると
偽装トークンを送るだけで検証を素通りできてしまう(だからトークンの外＝設定から固定する)。

> ⚠️ **本番(Production)環境には `CF_ACCESS_TEAM_DOMAIN`/`CF_ACCESS_AUD` を設定しない**。
> 設定しないことが本番の pages.dev エイリアスを確実にゲートする条件になる(設定すると、
> その AUD 向けの正当なトークンを持つ者が本番 pages.dev エイリアスをバイパスできて
> しまう)。本番のカスタムドメインは常に OAuth なので影響しない。

### プレビューの設定手順

1. **Cloudflare Access でプレビューを保護**: Zero Trust → Access → Applications で
   Self-hosted アプリを作り、対象ホストに `*.<project>.pages.dev`(必要なら本番
   エイリアス `<project>.pages.dev` も)を指定し、社内メールドメイン + 協力者の
   ポリシーを設定する。
2. **署名検証を有効化(プレビューをAccessで通すなら必須)**: **Preview 環境**に
   `CF_ACCESS_TEAM_DOMAIN` と `CF_ACCESS_AUD`(上記アプリの AUD タグ)を設定する。
   **変数でも secret でも可**(dashboard で secret のみ登録可能でもそのまま動く)。
   両方揃わないとプレビューでもスルーせず OAuth を要求する。
3. ヘッダ表示: Access 保護下では Access が `Cf-Access-Authenticated-User-Email` を
   注入するので、`/api/me` はそのメールを返し画面ヘッダに表示される。

> **本番の `<project>.pages.dev` エイリアスについて**: このホストに Access を掛ければ
> Access 保護(スルー)、掛けなければ OAuth 要求(fail-closed)になる。どちらでも
> 露出しない。通常の利用はカスタムドメインで行う。

### プレビューでも OAuth を通したい場合(任意)

Access を使わず特定のプレビューで OAuth を検証したいなら、ハッシュURLではなく
**ブランチ固定エイリアス** `https://<正規化ブランチ名>.<project>.pages.dev`
(Pages ダッシュボードの各デプロイ「Branch alias」で確認)を使い、その callback を
Google に登録し、Preview 環境に OAuth 用 secret を設定する。ブランチ名ごとに Google
登録が要るため、長命の `staging` ブランチ運用が実用的。なお **OAuth フローそのものの
動作確認はローカル実行が最短**なので、通常はそれで足りる。

## デプロイ後の自動チェック(認証がかかっていることの検証)

デプロイのたびに「認証が本当にかかっているか」を外形(HTTPレスポンス)で自動検証する。
検査ロジックは [`scripts/smoke.mjs`](../scripts/smoke.mjs)、実行は GitHub Actions
[`.github/workflows/post-deploy-smoke.yml`](../.github/workflows/post-deploy-smoke.yml)。

本番とプレビューで認証モデルが違う(本番=middleware が直接ゲート / プレビュー=前段の
Cloudflare Access がホスト全体をゲート)ため、`scripts/smoke.mjs` は2モードを持つ。

**① production モード**(本番: カスタムドメイン / team domain・aud 未設定の pages.dev
エイリアス)。middleware が直接応答するので **正確なステータス** を検証する:

| リクエスト | 期待 | 崩れたときの意味 |
|---|---|---|
| `GET /api/health` | `200` | デプロイ生存(公開パス) |
| `GET /api/apps`(未認証) | `401` | `200`=台帳データが公開 / `503`=設定漏れ(fail-closed) |
| `GET /`(未認証, `Accept: text/html`) | `302` → `/api/auth/login` | `200`=画面が公開 |
| `GET /api/proxy/:id`(未認証) | `401` | GAS中継が公開 |
| `GET /api/me`(未認証) | `401` | — |

さらに **Zero Trust(Cloudflare Access)偽装の拒否も検証する**。`/api/apps` と `/` に
不正な `Cf-Access-Jwt-Assertion` / `Cf-Access-Authenticated-User-Email` を付けて送り、
それでも `401` / `302` になること(=偽装ヘッダで素通りしないこと)を確認する。本番は
middleware のバイパス条件(上記「環境ごとの保護方針」)を満たさず素通りしないのが正しい
挙動。過去に pages.dev エイリアス + 偽装ヘッダで素通りする穴があった(コミット履歴参照)
ため、この回帰をデプロイごとに検知する。

**② preview モード**(`--preview`。ブランチ/PRのプレビュー: `*.pages.dev`)。プレビューは
前段の Cloudflare Access がホスト全体(`/api/health` 含む)をゲートし、未認証リクエストは
Access ログインへ 302 されるなどして関数まで届かない(Access 未設定でも middleware が
OAuth fail-closed でゲート)。**正確なステータスは環境依存**なので、ここでは「**未認証で
`200` を返さない=何らかの認証でブロックされている**」ことだけを検証する:

| リクエスト(偽装ヘッダ有無の両方) | 期待 | 崩れたときの意味 |
|---|---|---|
| `GET /api/apps`(未認証) | `3xx`/`401`/`403`(≠200) | `200`=プレビューが公開 |
| `GET /`(未認証, `Accept: text/html`) | `3xx`/`401`/`403`(≠200) | `200`=画面が公開 |

偽装 `Cf-Access-*` ヘッダを付けても `200` にならないこと(Access がクライアント提供の
偽トークンを弾くこと)も併せて確認する。

**トリガー**(cron は付けない):
- **デプロイ完了**: `check_run`(`types: [completed]`)で発火。Cloudflare Pages が
  発行する **"Cloudflare Pages" Check Run** が `success` で完了したときだけ検査する
  (job の `if` で `name == 'Cloudflare Pages'` かつ `app.slug ==
  'cloudflare-workers-and-pages'` かつ `conclusion == 'success'` を判定)。
  `check_suite.head_branch` が本番ブランチ(既定 `main`)なら ① production、
  それ以外は ② preview。対象デプロイは `check_run.head_sha` で特定する。
- **手動**: `workflow_dispatch`(`urls` と `mode` を上書き可)。

> ⚠️ **なぜ `check_run` か(`deployment_status` ではない理由)**: このプロジェクトは
> `wrangler pages deploy`(Direct Upload)でデプロイするため、Cloudflare は GitHub の
> **Deployments API を使わず**、`deployment_status` イベントは飛ばない(`/deployments` は空)。
> 一方 Cloudflare Pages は GitHub App `cloudflare-workers-and-pages` として **Check Run**
> "Cloudflare Pages" を各コミットに付ける(PR のステータスチェックに出るあれ)。これは
> `check_run` イベントとしてネイティブに発火するので、中継や通知 Webhook を一切使わずに
> デプロイ完了をフックできる。`check_run` は default ブランチ上の workflow で動くため、
> この仕組みは **main にマージ後**に有効になる。

**検査対象URLの解決**: 検査対象は原則すべて Cloudflare Pages API から取得する
([`scripts/cf-deploy-urls.mjs`](../scripts/cf-deploy-urls.mjs))。手入力の変数維持は不要。

| 種類 | 例 | 取得元(API) |
|---|---|---|
| カスタムドメイン | `portal.example.co.jp` | Project の `domains`(production時) |
| 本番固定 pages.dev | `inhouse-portal.pages.dev` | Project の `domains` / `subdomain`(production時) |
| デプロイ毎のユニークURL / ブランチエイリアス | `<hash>.<project>.pages.dev` / `<branch>.<project>.pages.dev` | Deployment の `url` / `aliases` を commit SHA で特定 |

production では **Project API の固定ドメイン + `head_sha` 一致デプロイのユニークURL**、
preview では **そのデプロイのユニークURL / ブランチエイリアス** を解決する。手動
`workflow_dispatch` など SHA が渡らない場合は、そのモードの **最新の成功デプロイ**を対象にする。使う API:

- `GET /accounts/{account}/pages/projects/{project}` → `domains` / `subdomain`(固定ドメイン)
- `GET /accounts/{account}/pages/projects/{project}/deployments?env={production|preview}`
  → 各デプロイの `url` / `aliases` を `deployment_trigger.metadata.commit_hash` で突き合わせ

このために **GitHub Secrets** を設定する(Actions → Secrets):

- `CLOUDFLARE_API_TOKEN` … `Account → Cloudflare Pages → Read`(既存の Pages:Edit トークンでも可)
- `CLOUDFLARE_ACCOUNT_ID` … 対象アカウントID
- (任意)変数 `CF_PAGES_PROJECT` … プロジェクト名。既定 `inhouse-portal`

API解決は **失敗しても本命のスモークは落とさない**(トークン未設定・API失敗・該当なしは
取れた分だけ返し、フォールバックに委ねる)。フォールバックとして、production は変数
`SMOKE_BASE_URLS`(カンマ区切り)や `environment_url`、preview は `environment_url` を使う。
API を使わず変数だけで運用したい場合は `SMOKE_BASE_URLS` に固定URLを入れてもよい(任意):

```
SMOKE_BASE_URLS = https://portal.example.co.jp,https://inhouse-portal.pages.dev
```

> 継続的なドリフト監視(secret ローテ失敗・環境変数消失など、デプロイ後に認証が壊れる
> ケース)が必要になったら、外部の常時監視サービス(UptimeRobot / BetterStack / Checkly
> 等)を併用する。その場合の監視条件は「`/api/apps` が `401`(=認証がかかっている)」に
> すること(単純な 200 監視だと「認証が外れた=200」を正常と誤判定する)。なお
> **Cloudflare 純正の Health Checks はゾーンがアカウント内にある前提**の機能で、本構成
> (外部DNS + CNAME、ネームサーバ非移管)のカスタムドメインには使えない。

ローカル実行(任意):

```bash
node scripts/smoke.mjs https://portal.example.co.jp                 # 本番
node scripts/smoke.mjs --preview https://<hash>.inhouse-portal.pages.dev  # プレビュー
```

## セキュリティ上の要点

- `email_verified: true` のメールのみ採用。
- `state`(CSRF)と PKCE を必須化。一時値は署名Cookie(10分)に限定。
- ログイン後の戻り先は同一オリジンの絶対パスのみ許可(オープンリダイレクト防止)。
- セッションCookieは HttpOnly / Secure(HTTPS時) / SameSite=Lax。
- `AUTH_SECRET` 未設定時はゲートが **fail-closed**(全体を503)。設定漏れで
  丸ごと公開される事故を防ぐ。
- GAS リンク(`/exec` へ直行するタイプ)側の Google アカウント制限は従来どおり
  独立して効く。ポータル認証はあくまで「一覧とプロキシAPIのゲート」。
