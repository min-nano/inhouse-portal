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

> プレビュー(PR)を Cloudflare Access で保護する構成のための**追加変数は不要**。
> 本番=OAuth / プレビュー=Access の切り替えはリクエストから自動判定する(下記)。

> `ALLOWED_EMAIL_DOMAINS` と `ALLOWED_EMAILS` は分けているが役割は同じ(単に
> 見通しのため)。どちらにワイルドカードや個別アドレスを書いてもよい。

### 3. (推奨) 許可リストを KV に置く

env の許可リストは変更のたびに再デプロイが要る。**KV を使うとダッシュボードから
デプロイ無しで追加・失効できる**(協力者の出入りが多い場合に有用)。無料枠
(読み取り10万/日・書き込み1,000/日・1GB)で十分収まる。

```bash
npx wrangler kv namespace create AUTH_KV
```

出力された `id` を `wrangler.jsonc` に追記(または Pages ダッシュボードの
Settings → Functions → KV namespace bindings で binding 名 `AUTH_KV` として紐づけ):

```jsonc
"kv_namespaces": [
  { "binding": "AUTH_KV", "id": "<作成した namespace の id>" }
]
```

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

`.dev.vars`(gitignore 済み)に secret を置くと `wrangler pages dev` が読み込む:

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
- KV をローカルで使うなら `wrangler pages dev --kv AUTH_KV`。未指定でも env の
  許可リストで動作する。

`wrangler pages dev` は `functions/_middleware.ts` もルートも本番と同一のものを
動かし、実際の Google ログインを通せる。**動作確認の第一手段はこのローカル実行**。

## 環境ごとの保護方針(本番=OAuth / プレビュー=Cloudflare Access)

保護は環境で使い分ける。理由は「Cloudflare Access が無料で効くのは Cloudflare 所有
ゾーン(`*.pages.dev`)だけ」で、本番のカスタムドメイン(外部DNS)は Access の対象に
できないため。**Access が効く所は Access、効かない所は OAuth** と割り当てる。

| 環境 | ホスト | 保護 | 設定 |
|---|---|---|---|
| 本番 | カスタムドメイン(外部DNS) | 内製 OAuth | 追加設定なし(既定で OAuth) |
| プレビュー(PR) | `*.pages.dev` | Cloudflare Access | Access ポリシーを掛けるだけ(変数不要) |
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

判定ロジック(`functions/_middleware.ts`):

| ホスト | Access アサーション | 挙動 |
|---|---|---|
| `*.pages.dev` | あり | **スルー**(Access 保護済み ⇒ プレビュー) |
| `*.pages.dev` | なし | OAuth を要求(Access 未設定 ⇒ fail-closed) |
| カスタムドメイン | あり/なし | **常に OAuth**(バイパスは pages.dev 限定。ヘッダ偽装無効) |

この設計の安全性:
- **本番カスタムドメインは絶対にバイパスしない**。`Cf-Access-Jwt-Assertion` を偽装
  されても、バイパス条件が「pages.dev ホストであること」なので効かない。
- **Access 未設定の pages.dev は自動で fail-closed**(OAuth へフォールバック)。
  `AUTH_MODE` のような明示フラグが無くても、「フラグだけ立てて Access 掛け忘れ ⇒
  全公開」という事故が起きない。

### プレビューの設定手順(Access を掛けるだけ)

1. **Cloudflare Access でプレビューを保護**: Zero Trust → Access → Applications で
   Self-hosted アプリを作り、対象ホストに `*.<project>.pages.dev`(必要なら本番
   エイリアス `<project>.pages.dev` も)を指定し、社内メールドメイン + 協力者の
   ポリシーを設定する。→ これだけでプレビューは Access 保護 + Function スルーになる。
2. ヘッダ表示: Access 保護下では Access が `Cf-Access-Authenticated-User-Email` を
   注入するので、`/api/me` はそのメールを返し画面ヘッダに表示される。

> **本番の `<project>.pages.dev` エイリアスについて**: このホストに Access を掛ければ
> Access 保護(スルー)、掛けなければ OAuth 要求(fail-closed)になる。どちらでも
> 露出しない。通常の利用はカスタムドメインで行う。
>
> **残存リスク(軽微)**: Access を掛けていない pages.dev ホストに対して
> `Cf-Access-Jwt-Assertion` を偽装したリクエストを送られると、ヘッダ存在チェックだけ
> ではバイパスされうる(Access を掛けている間は Cloudflare が偽装ヘッダを除去するため
> 無効)。より厳密にするなら、middleware で Access JWT の署名検証(トークンの `iss` から
> チーム JWKS を取得し、`aud` をアプリの AUD タグで固定)を追加する。この場合は
> チームドメイン/AUD の設定が要る。

### プレビューでも OAuth を通したい場合(任意)

Access を使わず特定のプレビューで OAuth を検証したいなら、ハッシュURLではなく
**ブランチ固定エイリアス** `https://<正規化ブランチ名>.<project>.pages.dev`
(Pages ダッシュボードの各デプロイ「Branch alias」で確認)を使い、その callback を
Google に登録し、Preview 環境に OAuth 用 secret を設定する。ブランチ名ごとに Google
登録が要るため、長命の `staging` ブランチ運用が実用的。なお **OAuth フローそのものの
動作確認はローカル実行が最短**なので、通常はそれで足りる。

## セキュリティ上の要点

- `email_verified: true` のメールのみ採用。
- `state`(CSRF)と PKCE を必須化。一時値は署名Cookie(10分)に限定。
- ログイン後の戻り先は同一オリジンの絶対パスのみ許可(オープンリダイレクト防止)。
- セッションCookieは HttpOnly / Secure(HTTPS時) / SameSite=Lax。
- `AUTH_SECRET` 未設定時はゲートが **fail-closed**(全体を503)。設定漏れで
  丸ごと公開される事故を防ぐ。
- GAS リンク(`/exec` へ直行するタイプ)側の Google アカウント制限は従来どおり
  独立して効く。ポータル認証はあくまで「一覧とプロキシAPIのゲート」。
