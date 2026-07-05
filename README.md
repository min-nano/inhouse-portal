# inhouse-portal

事務所内+委託協力者向けのポータルサイト。設計ツール等(主にGAS Webアプリ)への
リンクを1か所にまとめ、Cloudflare Workers でホスティングし Cloudflare Access で
アクセス制限をかける。

- 制作方針: [docs/PROPOSAL.md](docs/PROPOSAL.md)
- ロードマップ: [docs/ROADMAP.md](docs/ROADMAP.md)
- Phase 2 (GAS自動列挙) 設計: [docs/phase2-gas-registry.md](docs/phase2-gas-registry.md)

## アーキテクチャ

```
ユーザー → [Cloudflare Access] → [Worker]
                                   ├─ 静的アセット (ポータル画面)
                                   ├─ GET /api/apps        … 台帳 (data/apps.json)
                                   └─ ALL /api/proxy/:id   … GASへの中継 (CORS回避・URL秘匿)
```

## アプリの追加・修正

`data/apps.json` を編集してコミットするだけ。形式は zod で検証され、
不正なエントリは CI とデプロイ時に弾かれる。

```json
{
  "id": "kintai",                    // 英小文字・数字・ハイフン
  "name": "勤怠入力",
  "description": "説明文",
  "category": "業務管理",
  "tags": ["gas"],
  "url": "https://script.google.com/macros/s/XXXX/exec"  // httpsのみ
}
```

## 開発

```bash
npm ci
npm test            # テスト実行
npm run typecheck   # 型チェック
npm run dev         # ビルド + wrangler dev (http://localhost:8787)
npm run dev:web     # 画面のみHMR開発 (APIは:8787へプロキシ)
```

## デプロイ

### 初回セットアップ (Cloudflareダッシュボード)

1. **Workers Builds でGitHub連携**: Workers & Pages → Create → 
   「Import a repository」でこのリポジトリを選択。
   - Build command: `npm run build`
   - Deploy command: `npx wrangler deploy`
   - 以後 main への push で自動デプロイされる
2. **Cloudflare Access で保護**: Zero Trust → Access → Applications → 
   Add an application (Self-hosted) で WorkerのURL を指定し、ポリシーを作成。
   - 例: メールドメイン `@example.co.jp` を許可 + 協力者の個別メールを許可
   - Identity Provider に Google を設定するとGoogleログインになる

### GASプロキシの登録 (任意)

リンクとして開くだけのGASアプリには不要 (カードから `/exec` へ直行し、
GAS側のアカウント制限が効く)。ポータル画面自身がGASのデータを読む場合
(Phase 2のレジストリAPI等) のみ、エンドポイントをリポジトリに書かずに secret へ:

```bash
npx wrangler secret put PROXY_TARGETS
# 入力例: {"kintai-api":"https://script.google.com/macros/s/XXXX/exec"}
```

→ ポータルからは `/api/proxy/kintai-api?…` で呼び出せる (GET/POSTのみ)。

### 手動デプロイ

```bash
npm run deploy
```

## CI

GitHub Actions (`.github/workflows/ci.yml`) が push / PR ごとに実行:
typecheck → test → フロントビルド → wrangler ドライラン(Workerバンドル検証)。
