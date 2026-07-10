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
     `gas/.clasp.json.example` を `gas/.clasp.json` にコピーし、`scriptId` を実 ID に置換。
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
