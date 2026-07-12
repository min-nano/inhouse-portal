# Phase 2 設計メモ: GASレジストリAPI (デプロイ済みGASの自動列挙)

> ✅ **実装済み。現行は方式B(本人権限)のみを採用**。`/api/registry` は
> 「本人トークン保管済み → 方式B / それ以外 → 手動台帳のみ」の2段構成。
>
> **方式B: ユーザーモード(本人権限・per-userアクセス制御)** ↓「per-userで返す」で後述
> - **Clerk の Google 連携から本人の Google アクセストークンを取得**(`getUserOauthAccessToken`)し、
>   そのトークンで **その人がアクセスできるGASだけ**を列挙する(`src/server/google-registry.ts`)。
>   Google 連携で追加スコープ(`drive.metadata.readonly` / `script.deployments.readonly`)を
>   要求しておく必要がある。共有ドライブ内のGASも対象(`supportsAllDrives` /
>   `includeItemsFromAllDrives` / `corpora=allDrives`)。
> - **リフレッシュ管理は Clerk が担う**(本プロジェクト側でリフレッシュトークンを保管しない。
>   旧方式の `crypto.ts` の AES 暗号化 / `token-store.ts` / `REGISTRY_KV` は撤去した)。
> - 除外・上書き設定: `data/apps.json` の `gasRegistry`(`src/server/registry.ts`)。
>   マージは `src/server/gas-registry.ts`、画面表示は `web/main.ts`(「自動」バッジ)。
>
> **方式A: 共有レジストリ(当初設計・廃止)** — レジストリ役のGAS Webアプリを1本立て
> `PROXY_TARGETS["registry"]` 経由でプロキシする方式。全員が同じ一覧を見る前提だったが、
> 「本人がアクセスできる共有ドライブ内GASを列挙できれば方式Bで十分」と判断し**削除済み**。
> GAS本体(`gas/`)・clasp/CIデプロイ・サーバ側プロキシ(`fetchGasRegistry`)は撤去した。
> 以下「## 背景」〜「## 方式B」までは方式Aの設計記録(歴史的経緯)として残す。

## 背景(方式A・廃止。以下は歴史的経緯)

Apps Script API の `projects.deployments.list` はサービスアカウントに対応して
おらず、ユーザーのOAuthトークンが必要。Cloudflare の Function から直接呼ぶには
リフレッシュトークンの保管・更新が必要になり、運用負担が大きい。

一方、**GASの中からなら** `ScriptApp.getOAuthToken()` で自分自身の権限の
トークンが取れるため、追加のOAuth設定なしで Drive API / Apps Script API を
呼べる。そこで「レジストリ」役のGAS Webアプリを1本立てる……という当初案だったが、
方式Bに一本化したため、この節以降の方式Aの記述は現在は実装されていない。

## 構成(方式A・廃止)

```
ポータル(Pages Functions) → /api/registry → (プロキシ+キャッシュ) → GASレジストリ /exec
                                                             ├ Drive API: GASプロジェクト検索
                                                             └ Apps Script API: デプロイ一覧取得
```

## GAS側の実装スケッチ

```javascript
// appsscript.json で以下の最小スコープを付与(メタデータのみ・デプロイ参照のみ):
// "https://www.googleapis.com/auth/script.external_request"  (UrlFetchApp)
// "https://www.googleapis.com/auth/drive.metadata.readonly"
// "https://www.googleapis.com/auth/script.deployments.readonly"

function doGet() {
  const apps = listDeployedWebApps();
  return ContentService.createTextOutput(JSON.stringify({ apps }))
    .setMimeType(ContentService.MimeType.JSON);
}

function listDeployedWebApps() {
  const token = ScriptApp.getOAuthToken();
  const headers = { Authorization: "Bearer " + token };

  // 1. ドライブ内のGASプロジェクトを検索
  const q = encodeURIComponent("mimeType='application/vnd.google-apps.script' and trashed=false");
  const files = JSON.parse(UrlFetchApp.fetch(
    "https://www.googleapis.com/drive/v3/files?q=" + q + "&fields=files(id,name,modifiedTime)",
    { headers }
  ).getContentText()).files || [];

  // 2. 各プロジェクトのデプロイからWebアプリURLを取得
  const apps = [];
  for (const file of files) {
    const res = UrlFetchApp.fetch(
      "https://script.googleapis.com/v1/projects/" + file.id + "/deployments",
      { headers, muteHttpExceptions: true }
    );
    if (res.getResponseCode() !== 200) continue;
    const deployments = JSON.parse(res.getContentText()).deployments || [];
    for (const d of deployments) {
      const web = (d.entryPoints || []).find((e) => e.entryPointType === "WEB_APP");
      if (web && web.webApp && web.webApp.url) {
        apps.push({
          scriptId: file.id,
          name: file.name,
          url: web.webApp.url,
          updateTime: d.updateTime,
        });
        break; // 最新の1デプロイのみ採用
      }
    }
  }
  return apps;
}
```

デプロイ設定: 「次のユーザーとして実行: 自分」「アクセスできるユーザー: 全員(匿名可)」
にしてURLを `PROXY_TARGETS` に登録する(URLはPagesの環境変数なので外部に出ない)。
匿名公開が気になる場合は、クエリに共有シークレットを付けてGAS側で検証する。

## Functions側の追加作業

- `/api/registry` ルートを追加し、`PROXY_TARGETS["registry"]` へプロキシ
- Cache API で5分程度キャッシュ (GAS呼び出しは遅い: 数秒かかることがある)
- レスポンスを zod で検証し、apps.json の手動エントリとマージして返す
- `data/apps.json` 側に `exclude: ["scriptId..."]` のような除外設定を追加

## 注意点

- Apps Script API はレジストリGASの実行ユーザー(=自分)のプロジェクトしか
  見えない。事務所で複数人がGASを所有している場合は、共有ドライブに集約するか、
  所有者ごとにレジストリを立ててFunctions側でマージする。
- Apps Script API を使うには、対象アカウントで
  https://script.google.com/home/usersettings から API を有効化しておく。

---

## 方式B: ユーザーモード(本人権限で per-user に返す)

「アクセスしているユーザーとして実行し、その人がアクセスできるGASだけを返す」を
実現する方式。共有レジストリGAS(方式A)は不要で、**Cloudflare Functions が本人の
Google OAuth トークン(Clerk から取得)で Drive API / Apps Script API を直接叩く**。

### フロー

```
ログイン (Clerk の Google 連携)
   └─ Google 同意画面 (email/profile + Drive/Script の追加スコープ)
        └─ Clerk がアクセス/リフレッシュトークンを管理(本プロジェクト側は保管しない)
/api/registry (サインイン中ユーザー)
   └─ Clerk Backend API: getUserOauthAccessToken(userId, "google") で access_token を取得
        └─ Drive: 本人が見えるGASプロジェクトを列挙
             └─ Apps Script API: 各デプロイのWebアプリURLを取得
                  └─ apps.json とマージして返す (per-user 結果, 5分キャッシュ)
```

スコープは Clerk の Google 連携設定で要求しておく。リフレッシュは Clerk が担うため、
`/api/registry` は毎回 Clerk から**有効なアクセストークン**を取り出すだけでよい。

### スコープ(最小権限・センシティブ)

- `drive.metadata.readonly` … GASプロジェクト(script mimeType)の一覧(メタデータのみ)
- `script.deployments.readonly` … 各プロジェクトのデプロイ(WebアプリURL)の参照

### 安全に運用するための設計

- **リフレッシュトークンは本プロジェクトで保持しない**。Google トークンの保管・更新は
  Clerk 側に委ね、`/api/registry` は必要な瞬間にアクセストークンを取り出して使うだけ。
  (旧方式の AES-256-GCM 暗号化 + KV 保管 / `token-store.ts` / `REGISTRY_KV` は撤去した。)
- アクセストークンはサーバー間でのみ使い、ブラウザには一切出さない。
- **スコープ要求**: Clerk の Google 連携で追加スコープ(Drive/Script)を要求する。連携済みで
  同意があれば `/api/registry` が本人権限で列挙する。未連携ユーザーは手動台帳へフォールバック。
- **失効時の扱い**: Drive/Apps Script API が 401 を返した(トークン失効)場合は手動台帳へ
  フォールバックし、画面に「再ログインで Google を接続し直す」ヒントを出す。Google 側での
  ユーザー取消は https://myaccount.google.com/permissions から行える。
- **失効後の復旧**: 画面の失効通知から**再ログイン**(`/api/auth/logout` → 再サインイン)へ
  誘導する。Clerk が Google 連携(スコープ)を取り直して復旧する。
- **サブリクエスト上限対策**: 本人権限の列挙は最近更新の上位 `MAX_PROJECTS` 件に制限し、
  同時実行数を絞って並列化する(Cloudflare 無料プランの50サブリクエスト制限対策)。
- **自動取得URLのホスト制限**: 自動分の `url` は `script.google.com` /
  `script.googleusercontent.com` のみ許可(レジストリ侵害時の任意リンク混入を防ぐ)。
- トークンはブラウザに一切出さない(サーバー間でのみ使用)。ユーザー自身の取消は
  Googleアカウントのアクセス権限画面 (https://myaccount.google.com/permissions) から可能。

### 運用上の制約(重要)

- Drive/Apps Script はセンシティブスコープのため、**OAuth同意画面を「内部(Internal)」**に
  すれば審査不要だが、その場合**同一 Workspace 組織のメンバーしか連携できない**。
  外部協力者(組織外メール)向けに使うには「外部」+ Google のアプリ審査が必要になる。
- 外部協力者の「本人が見えるGAS」は各自の個人アカウントのGASであり、事務所の一覧
  としては無意味。→ **方式Bは実質 Workspace メンバー向け**。未連携ユーザーは手動台帳に
  フォールバックする作りにしてある。
- 各利用者が `https://script.google.com/home/usersettings` で Apps Script API を
  有効化しておく必要がある(未有効なら画面にヒントを表示)。
- Clerk の Google 連携で追加スコープ(Drive/Script)を要求する設定が必要。専用の KV
  バインディングは不要(トークン管理は Clerk が担うため)。
- OAuth 同意画面が「テスト(Testing)」公開ステータスのままだと**リフレッシュトークンは
  7日で失効**する。継続運用するには公開ステータスを「本番(In production)」にする
  (内部アプリなら審査不要で本番化できる)。失効時は画面から再ログインすれば復旧する。
