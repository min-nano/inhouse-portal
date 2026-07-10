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
> - ログイン中の本人が Google Drive を連携すると、**その人がアクセスできるGASだけ**を
>   本人のOAuthトークンで列挙する(`src/server/google-registry.ts`)
> - リフレッシュトークンは AES-256-GCM で暗号化して KV に保管
>   (`src/server/auth/crypto.ts` / `token-store.ts`)
>
> **共通**
> - 除外・上書き設定: `data/apps.json` の `gasRegistry`(`src/server/registry.ts`)
> - 画面: `/api/registry` を参照し「自動」バッジ付きで表示。連携ボタンも表示(`web/main.ts`)
> - 優先順位: 本人が連携済み → 方式B / それ以外で共有レジストリ設定済み → 方式A / どちらも無ければ手動のみ

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
// appsscript.json で以下のスコープを付与:
// "https://www.googleapis.com/auth/drive.readonly"
// "https://www.googleapis.com/auth/script.projects.readonly"
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
ログイン (email/profile のみ)
   └─ ポータルで「Google Driveと連携」 → /api/registry/connect
        └─ Google 同意画面 (追加スコープ, access_type=offline)
             └─ /api/auth/callback (flow=connect)
                  └─ refresh_token を AES-256-GCM で暗号化し KV に保管
/api/registry (連携済みユーザー)
   └─ refresh_token → access_token へ更新
        └─ Drive: 本人が見えるGASプロジェクトを列挙
             └─ Apps Script API: 各デプロイのWebアプリURLを取得
                  └─ apps.json とマージして返す (per-user 結果, 5分キャッシュ)
```

### スコープ(最小権限・センシティブ)

- `drive.metadata.readonly` … GASプロジェクト(script mimeType)の一覧(メタデータのみ)
- `script.deployments.readonly` … 各プロジェクトのデプロイ(WebアプリURL)の参照

### 安全に運用するための設計

- **リフレッシュトークンは平文で保存しない**。`AUTH_SECRET` から HKDF で導出した鍵で
  AES-256-GCM 暗号化して KV に置く(`crypto.ts` / `token-store.ts`)。**KV 単体が漏れても
  復号不可**。`AUTH_SECRET` のローテートで全連携が実質失効する。
- KVキーは email の SHA-256(平文PIIをキーにしない)。
- **インクリメンタル認可**: ログインは従来どおり identity のみ。Drive連携は本人が
  ボタンを押したときだけ(最小権限。使わない人はDrive権限を渡さない)。
- **連携解除**(`POST /api/registry/disconnect`)で KV から削除し、Google 側でも
  `revoke` する。リフレッシュが `invalid_grant` になった場合は自動で連携解除。
- トークンはブラウザに一切出さない(サーバー間でのみ使用)。

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
