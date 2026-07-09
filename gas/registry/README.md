# GASレジストリ Webアプリ

デプロイ済みGAS Webアプリを自動列挙して JSON で返す「レジストリ」役のGAS。
ポータル(Cloudflare Functions)の `/api/registry` がここをプロキシして、
`data/apps.json` の手動台帳とマージ表示する。設計背景は
[`docs/phase2-gas-registry.md`](../../docs/phase2-gas-registry.md) を参照。

## 応答フォーマット

```json
{
  "apps": [
    {
      "scriptId": "1AbC...",
      "name": "日報入力フォーム",
      "url": "https://script.google.com/macros/s/XXXX/exec",
      "updateTime": "2026-07-01T12:34:56Z"
    }
  ]
}
```

## セットアップ手順

1. **新規GASプロジェクトを作成**し、`Code.gs` と `appsscript.json` の内容を貼る
   (`appsscript.json` はエディタの「プロジェクトの設定 → "appsscript.json" マニフェスト
   ファイルをエディタで表示する」を有効化すると編集できる)。
2. **Apps Script API を有効化**: 実行アカウントで
   <https://script.google.com/home/usersettings> を開き「Google Apps Script API」をオン。
3. **(任意)共有シークレット**: プロジェクトの設定 → スクリプトプロパティに
   `SHARED_SECRET` を追加すると、`?token=<値>` が一致するリクエストにだけ応答する。
4. **Webアプリとしてデプロイ**:
   - 実行するユーザー: **自分**
   - アクセスできるユーザー: **全員**
   デプロイ後に発行される `/exec` URL を控える。
5. **ポータルに登録**(URL はリポジトリに書かず Pages の環境変数へ):
   ```bash
   npx wrangler pages secret put PROXY_TARGETS
   # 入力例: {"registry":"https://script.google.com/macros/s/XXXX/exec?token=秘密"}
   ```
   `PROXY_TARGETS["registry"]` が設定されると、ポータルは自動取得分を
   「自動」バッジ付きでマージ表示する。未設定なら手動台帳のみを表示する。

## 除外・表示名の上書き

自動取得分の調整は `data/apps.json` の `gasRegistry` で行う(デプロイで反映):

```json
{
  "apps": [ ... ],
  "gasRegistry": {
    "defaultCategory": "自動取得",
    "exclude": ["除外したいscriptId"],
    "overrides": {
      "あるscriptId": {
        "name": "表示名を上書き",
        "category": "設計ツール",
        "tags": ["gas", "図面"]
      },
      "隠したいscriptId": { "hidden": true }
    }
  }
}
```

- 手動台帳(apps.json)と同じ `/exec` URL の自動エントリは、手動側を優先して抑制する。
- `exclude` / `overrides[...].hidden` に挙げた scriptId は一覧に出さない。

## 注意点

- Apps Script API はこのGASの**実行ユーザー(=自分)が所有するプロジェクト**しか
  見えない。複数人でGASを持つ場合は共有ドライブに集約するか、所有者ごとに
  レジストリを立てて Functions 側でマージする(`PROXY_TARGETS` に複数キーを追加し
  ルートを拡張)。
