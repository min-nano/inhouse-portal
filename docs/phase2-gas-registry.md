# Phase 2 設計メモ: GASレジストリAPI (デプロイ済みGASの自動列挙)

> ✅ **実装済み**。2つの取得方式を備える(`/api/registry` が優先順位で選択):
>
> **方式A: 共有レジストリ(このメモの当初設計)**
> - GAS側レジストリ: `gas/registry/`(`Code.gs` / `appsscript.json` / `README.md`)
> - Functions側: `PROXY_TARGETS["registry"]` をプロキシし Cache API で5分キャッシュ、
>   zod検証、apps.json とマージ(`src/server/gas-registry.ts`)
> - **全員が同じ一覧**を見る(レジストリ実行ユーザーが所有するGAS)
>
> **方式B: ユーザーモード(本人権限・per-userアクセス制御)** ↓「per-userで返す」で後述
> - **ログイン時にDriveスコープを要求**(`REGISTRY_LOGIN_SCOPES=1`)し、得た本人のOAuth
>   トークンで **その人がアクセスできるGASだけ**を列挙する(`src/server/google-registry.ts`)
> - リフレッシュトークンは AES-256-GCM で暗号化して KV に保管
>   (`src/server/auth/crypto.ts` / `token-store.ts`)
>
> **共通**
> - 除外・上書き設定: `data/apps.json` の `gasRegistry`(`src/server/registry.ts`)
> - 画面: `/api/registry` を参照し「自動」バッジ付きで表示(`web/main.ts`)
> - 優先順位: 本人トークン保管済み → 方式B / それ以外で共有レジストリ設定済み → 方式A / どちらも無ければ手動のみ

## 背景

Apps Script API の `projects.deployments.list` はサービスアカウントに対応して
おらず、ユーザーのOAuthトークンが必要。Cloudflare の Function から直接呼ぶには
リフレッシュトークンの保管・更新が必要になり、運用負担が大きい。

一方、**GASの中からなら** `ScriptApp.getOAuthToken()` で自分自身の権限の
トークンが取れるため、追加のOAuth設定なしで Drive API / Apps Script API を
呼べる。そこで「レジストリ」役のGAS Webアプリを1本立てる。

## 構成

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
Google OAuth トークンで Drive API / Apps Script API を直接叩く**。

### フロー

```
ログイン (/api/auth/login)  ※REGISTRY_LOGIN_SCOPES=1 のとき
   └─ Google 同意画面 (openid/email/profile + Driveスコープ, access_type=offline)
        └─ /api/auth/callback
             ├─ 通常のセッション発行(従来どおり)
             └─ refresh_token を AES-256-GCM で暗号化し KV に保管(初回同意時に取得)
/api/registry (トークン保管済みユーザー)
   └─ refresh_token → access_token へ更新
        └─ Drive: 本人が見えるGASプロジェクトを列挙
             └─ Apps Script API: 各デプロイのWebアプリURLを取得
                  └─ apps.json とマージして返す (per-user 結果, 5分キャッシュ)
```

スコープはログイン同意に含めて要求する(opt-inの連携ボタンは設けない)。`access_type=offline`
だがログイン毎に同意を強制しない(`prompt=select_account`)ため、リフレッシュトークンは
**初回同意時のみ**返る。以後のログインではセッションのみ更新し、保管済みトークンを使い続ける。

### スコープ(最小権限・センシティブ)

- `drive.metadata.readonly` … GASプロジェクト(script mimeType)の一覧(メタデータのみ)
- `script.deployments.readonly` … 各プロジェクトのデプロイ(WebアプリURL)の参照

### 安全に運用するための設計

- **リフレッシュトークンは平文で保存しない**。`AUTH_SECRET` から HKDF で導出した鍵で
  AES-256-GCM 暗号化して KV に置く(`crypto.ts` / `token-store.ts`)。**KV 単体が漏れても
  復号不可**。`AUTH_SECRET` のローテートで全連携が実質失効する。
- KVキーは email の **HMAC-SHA256(AUTH_SECRET 由来)**。平文PIIを使わず、かつ候補メールの
  総当たりで連携有無を判定されないようにする(許可リストの `emailHashes` と同方式)。
- **ログイン時にスコープ要求**: 環境変数 `REGISTRY_LOGIN_SCOPES=1` を立てると、
  ログイン同意でDriveスコープも一緒に要求する(opt-inの連携ボタンは無し)。フラグ未設定
  または `AUTH_KV` 未バインド時は、従来どおり identity のみのログインになる。
- **自動失効処理**: リフレッシュ失敗のうち `error=invalid_grant`(取消・失効)のときだけ
  保管トークンを削除する。`invalid_client`(secret設定ミス)や 429・5xx は一時障害として
  トークンを残す(設定を直せば復旧できるように)。
- **付与スコープの検証**: granular consent で Drive/Script スコープが外された場合は
  トークンを保管しない(共有/手動へフォールバック。誤った「一時的に失敗」通知を防ぐ)。
- **失効後の復旧**: 通常ログインは `prompt=select_account` のため refresh token が
  再発行されない。画面の失効通知から `/api/auth/login?reconnect=1`(= `prompt=consent`)へ
  誘導し、確実に再発行させる。
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
  としては無意味。→ **方式Bは実質 Workspace メンバー向け**。未連携ユーザーは方式A/手動に
  フォールバックする作りにしてある。
- 各利用者が `https://script.google.com/home/usersettings` で Apps Script API を
  有効化しておく必要がある(未有効なら画面にヒントを表示)。
- KV バインディング `AUTH_KV` が必須(トークン保管先)。
- OAuth 同意画面が「テスト(Testing)」公開ステータスのままだと**リフレッシュトークンは
  7日で失効**する。継続運用するには公開ステータスを「本番(In production)」にする
  (内部アプリなら審査不要で本番化できる)。失効時は画面から再連携すれば復旧する。
