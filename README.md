# inhouse-portal

事務所内+委託協力者向けのポータルサイト。設計ツール等(主にGAS Webアプリ)への
リンクを1か所にまとめ、Cloudflare Pages + Functions でホスティングし
Cloudflare Access でアクセス制限をかける。

- 制作方針: [docs/PROPOSAL.md](docs/PROPOSAL.md)
- ロードマップ: [docs/ROADMAP.md](docs/ROADMAP.md)
- Phase 2 (GAS自動列挙) 設計: [docs/phase2-gas-registry.md](docs/phase2-gas-registry.md)

## アーキテクチャ

```
ユーザー → [Cloudflare Access] → [Cloudflare Pages]
                                   ├─ 静的アセット (ポータル画面) … Pagesが直接配信
                                   └─ Pages Functions (/api/*)
                                        ├─ GET /api/apps       … 台帳 (data/apps.json)
                                        └─ ALL /api/proxy/:id  … GASへの中継 (CORS回避・URL秘匿)
```

`/api/*` は `functions/api/[[route]].ts` (Hono) が処理し、それ以外の画面・CSS・JS
などの静的アセットは Pages が `dist/client` から直接配信する。

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
npm run dev         # ビルド + wrangler pages dev (http://localhost:8788)
npm run dev:web     # 画面のみHMR開発 (APIは:8787へプロキシ)
```

## デプロイ

### 初回セットアップ (Cloudflareダッシュボード)

1. **Pages でGitHub連携**: Workers & Pages → Create → Pages →
   「Connect to Git」でこのリポジトリを選択。
   - Build command: `npm run build`
   - Build output directory: `dist/client`
   - `functions/` ディレクトリは Pages が自動でバンドルする (追加設定不要)
   - 以後 main への push で自動デプロイされる (プレビューデプロイも自動生成)
2. **Cloudflare Access で保護**: Zero Trust → Access → Applications →
   Add an application (Self-hosted) で PagesのURL (下記カスタムドメイン) を指定し、
   ポリシーを作成。
   - 例: メールドメイン `@example.co.jp` を許可 + 協力者の個別メールを許可
   - Identity Provider に Google を設定するとGoogleログインになる

### カスタムドメイン (外部サブドメインをCNAMEで割り当てる)

ドメインのネームサーバをCloudflareに移さず、他社DNSのままサブドメインだけを
割り当てられる (これは Workers ではできず Pages のみ可能)。

1. Pagesプロジェクト → Custom domains → **Set up a custom domain** で
   使いたいサブドメイン (例 `portal.example.co.jp`) を登録する。
2. 現在のDNSプロバイダで CNAME レコードを追加:
   `portal.example.co.jp  →  <project>.pages.dev`
3. Cloudflare側の検証が通ると自動でTLS証明書が発行される。

> ⚠️ apex (裸ドメイン `example.co.jp`) を使う場合はゾーンをCloudflareに載せる
> 必要がある。サブドメインなら上記のCNAMEだけで完結する。
> ⚠️ Pagesダッシュボードでカスタムドメインを登録する**前に**CNAMEだけ先に張ると
> 522エラーになる。必ずダッシュボード登録 → CNAME の順で行うこと。

### GASプロキシの登録 (任意)

リンクとして開くだけのGASアプリには不要 (カードから `/exec` へ直行し、
GAS側のアカウント制限が効く)。ポータル画面自身がGASのデータを読む場合
(Phase 2のレジストリAPI等) のみ、エンドポイントをリポジトリに書かずに
Pagesの環境変数(secret)へ:

```bash
npx wrangler pages secret put PROXY_TARGETS
# 入力例: {"kintai-api":"https://script.google.com/macros/s/XXXX/exec"}
```

(ダッシュボードからも Settings → Environment variables で暗号化変数として登録可能)

→ ポータルからは `/api/proxy/kintai-api?…` で呼び出せる (GET/POSTのみ)。

### 手動デプロイ

```bash
npm run deploy   # vite build → wrangler pages deploy
```

## CI

GitHub Actions (`.github/workflows/ci.yml`) が push / PR ごとに実行:
typecheck → test → フロントビルド → Pages Functions バンドル検証
(`wrangler pages functions build`)。
