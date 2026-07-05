# 制作方針

事務所内+委託協力者向けの、設計ツール等(主にGAS Webアプリ)をまとめるポータルサイトの制作方針。

## 全体アーキテクチャ

```
ユーザー → [Cloudflare Access (Zero Trust認証)]
              ↓
         [単一の Cloudflare Worker]
           ├─ 静的アセット配信 (ポータル画面)
           └─ /api/* … 台帳API + GASへのサーバー間プロキシ
                          ↓ fetch (サーバー間通信 = CORS回避)
                     [GAS Webアプリ (/exec)]
```

### なぜ Pages ではなく「Workers + Static Assets」の統合構成か

当初案(Gemini提案)は「Cloudflare Pages + 別Worker」でしたが、以下の理由で
**単一Workerへの統合**を採用します。

- Cloudflareは現在、新規プロジェクトに対して Pages ではなく
  **Workers + Static Assets** を公式に推奨している(Pagesの機能はWorkersに統合済み)
- デプロイ対象・保護対象(Access)・設定箇所がすべて1つで済む
- GitHub連携の自動デプロイ(Workers Builds)は Pages と同様に使える

役割分離(画面/API)はコード上のモジュール分割で維持しており、
将来必要になれば分離デプロイへの移行も容易。

### アクセス制御: Cloudflare Access (Zero Trust)

- アプリ側にログイン機能は実装しない
- Cloudflare ダッシュボードで「社内ドメインの全員 + 指名した外部協力者のメール」を
  許可するポリシーを設定する(Googleログイン等)
- 手順は README の「Cloudflare Access の設定」を参照

### GASプロキシ (/api/proxy/:id)

- GASの生URL(`/exec`)はリポジトリにもブラウザにも置かず、
  Worker の secret `PROXY_TARGETS` にのみ保持する
- Worker→GAS はサーバー間通信のため CORS の制約を受けない
- GASの302リダイレクト(script.googleusercontent.com)には自動追従
- `Set-Cookie` 等の不要ヘッダは伝播させない

## 「デプロイ済みGASアプリをAPIで取得」について

Apps Script API (`projects.deployments.list`) は**サービスアカウント非対応**で、
ユーザーOAuthトークンが必須。Cloudflare Worker から直接アカウント内の全GAS
デプロイを列挙するのはトークン管理の負担が大きく、MVPには不向き。

そこで段階的に進める:

1. **Phase 1 (MVP・本リポジトリの現状)**: `data/apps.json` を台帳として
   Git管理。追加・修正はPR経由で履歴とレビューが残る。
2. **Phase 2**: **GAS側に「レジストリAPI」を1本立てる**。
   GAS内なら `ScriptApp.getOAuthToken()` で Drive API + Apps Script API を
   呼べるため、「自分のドライブ内のGASプロジェクト+WebアプリデプロイURL」を
   自動列挙してJSONで返せる。Workerがそれをプロキシ+キャッシュして
   ポータルに自動反映する。→ 詳細: `docs/phase2-gas-registry.md`

## 技術スタック

| 項目 | 選定 | 理由 |
|---|---|---|
| Worker/API | TypeScript + Hono | 軽量・Workers標準的・`app.request()`でテスト容易 |
| 台帳検証 | zod | apps.json の形式不正をテスト/デプロイ時に検出 |
| フロント | Vite + TypeScript (フレームワークなし) | リンク集には十分。依存最小・ビルド高速 |
| テスト | Vitest | ユニット+APIルートテスト |
| CI | GitHub Actions | push/PR毎に typecheck + test + build + wranglerドライラン |
| デプロイ | Cloudflare Workers Builds (GitHub連携) | mainへのpushで自動デプロイ |

## リポジトリ構成

```
data/apps.json        … アプリ台帳 (ここを編集して追加・修正)
src/worker/           … Cloudflare Worker (API + プロキシ)
web/                  … ポータル画面 (Vite)
test/                 … テストコード
docs/                 … 方針・ロードマップ・Phase 2設計
.github/workflows/    … CI
```
