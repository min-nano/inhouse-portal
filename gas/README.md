# gas/ — Apps Script プロジェクト (clasp 管理)

このリポジトリの GAS 側コードは **1 つの Apps Script プロジェクト**に集約し、
[clasp](https://github.com/google/clasp) で管理する。現状はレジストリ
(`src/registry/`) だけだが、今後 GAS 側で必要になったコードもこの同じプロジェクト
(`src/` 配下)に追加していく方針。

## ディレクトリ構成

```
gas/
├── .clasp.json.example   # clasp 設定のテンプレ(実ファイル .clasp.json は各自作成・git 管理外)
├── .claspignore          # push 対象から除外するファイル
├── README.md             # このファイル
└── src/                  # clasp の rootDir(ここ以下が Apps Script プロジェクト本体)
    ├── appsscript.json   # マニフェスト(全コード共通:タイムゾーン/OAuthスコープ/webapp設定)
    └── registry/         # レジストリ機能(push 時は "registry/Code" として反映)
        ├── Code.gs
        └── README.md     # レジストリ固有のデプロイ手順・応答フォーマット
```

- clasp はサブフォルダ構成を保ったまま push する(`src/registry/Code.gs` →
  Apps Script 側のファイル名 `registry/Code`)。今後コードを増やす場合は
  `src/<機能名>/*.gs` を追加すれば同じプロジェクトにまとまる。
- **1 プロジェクトにつき Web アプリ(`doGet`/`doPost`)は 1 本**という Apps Script の
  制約は変わらない。現状は `registry` が Web アプリのエンドポイント。別途 Web アプリが
  必要になったら、同じ `doGet` からルーティングするか、その時点で別プロジェクトへ
  切り出すか判断する。

## セットアップ

`clasp` はリポジトリの devDependency。ルートで `npm install` 済みなら
`npm run gas:*` スクリプトから使える(`clasp ... --project gas` のラッパー)。

1. **ログイン**(初回のみ。ブラウザで Google 認証):
   ```bash
   npm run gas:login
   ```
2. **プロジェクトを用意**して `.clasp.json` を作る。どちらか:
   - 既存の Apps Script プロジェクトに紐付ける:
     `gas/.clasp.json.example` を `gas/.clasp.json` にコピーし、`${CLASP_SCRIPT_ID}` を
     実 ID に置換。
   - 新規作成する(`gas/` 内で実行すると `.clasp.json` がこの階層に生成される):
     ```bash
     cd gas && npx clasp create-script --type webapp --title inhouse-portal-gas --rootDir src
     ```
     > `.clasp.json` に `scriptId` と実プロジェクト ID が入るため **git 管理外**
     > (`.gitignore` 済み)。共有が必要なら scriptId のみ別途伝える。
3. **Apps Script API を有効化**: 実行アカウントで
   <https://script.google.com/home/usersettings> を開き「Google Apps Script API」をオン。

## 日常の操作(ルートで実行)

| コマンド | 内容 |
| --- | --- |
| `npm run gas:status` | push 対象になるファイルを確認 |
| `npm run gas:push`   | ローカルの `src/` を Apps Script へ反映 |
| `npm run gas:pull`   | Apps Script 側の変更をローカルへ取り込み |
| `npm run gas:deploy` | 新しいデプロイ(バージョン)を作成 |
| `npm run gas:open`   | ブラウザで Apps Script エディタを開く |

各機能のデプロイ設定やスクリプトプロパティ(例: レジストリの `SHARED_SECRET`)は
機能ごとの README を参照:

- レジストリ: [`src/registry/README.md`](src/registry/README.md)

## CI で自動デプロイ (GitHub Actions)

`main` の `gas/**` 変更、または手動実行(workflow_dispatch)で
[`.github/workflows/gas-deploy.yml`](../.github/workflows/gas-deploy.yml) が走り、
`clasp push` → `clasp create-deployment` まで自動で行う。

**認証情報・スクリプトIDはリポジトリに置かない。** コミットするのは
プレースホルダ入りの `*.example` のみで、CI が GitHub Secrets から値を注入して
実ファイル (`gas/.clasp.json` / `gas/.clasprc.json`、どちらも `.gitignore` 済み)を
`scripts/render-template.mjs` で生成する。

### 必要な Secrets(Settings → Secrets and variables → Actions)

| Secret | 中身 | 取得元 |
| --- | --- | --- |
| `CLASP_SCRIPT_ID` | Apps Script の scriptId | エディタ URL / `gas/.clasp.json` の `scriptId` |
| `CLASP_CLIENT_ID` | OAuth クライアント ID | 下記 `~/.clasprc.json` の `tokens.default.client_id` |
| `CLASP_CLIENT_SECRET` | OAuth クライアントシークレット | 同 `tokens.default.client_secret` |
| `CLASP_REFRESH_TOKEN` | リフレッシュトークン | 同 `tokens.default.refresh_token` |

### リフレッシュトークンの取り出し方

ローカルで一度 `npm run gas:login` すると `~/.clasprc.json` に v3 形式で保存される。
その `tokens.default` から 3 値を取り出して Secrets に登録する:

```bash
# client_id / client_secret / refresh_token を表示(値は秘匿)
node -e "const t=require(require('os').homedir()+'/.clasprc.json').tokens.default; console.log({client_id:t.client_id, client_secret:t.client_secret, refresh_token:t.refresh_token})"
```

> `clasp login` は clasp 内蔵の OAuth クライアントを使うため、`client_id` /
> `client_secret` は clasp 既定値になる。独自 GCP クライアントを使う場合は
> `clasp login --creds <oauth.json>` で取得した 3 値を登録する。3 値は必ず同じ
> ログインで得たものを揃えること(refresh_token は発行元クライアントに紐づく)。
