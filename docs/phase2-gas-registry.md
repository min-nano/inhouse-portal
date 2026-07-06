# Phase 2 設計メモ: GASレジストリAPI (デプロイ済みGASの自動列挙)

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
```
