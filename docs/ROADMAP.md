# ロードマップ

## Phase 1: MVP — リンク集ポータル ✅ (本リポジトリ)

- [x] `data/apps.json` によるアプリ台帳 (zodで形式検証)
- [x] ポータル画面: カード一覧・検索・カテゴリ絞り込み・ダークモード対応
- [x] `/api/apps` 台帳API
- [x] `/api/proxy/:id` GASプロキシ (生URL秘匿・CORS回避。Phase 2の土台)
- [x] 認証 (Clerk): `_middleware.ts` 認証ゲート(`@clerk/backend`)。許可(誰がサインイン
      できるか)は Clerk 側で管理(Restrictions / Invitations)。全ホストを同一コードで
      ゲートし、アプリ側の許可リスト(env/KV)は持たない。→ 詳細 `docs/auth-internal.md`
- [x] テストコード (台帳検証 / APIルート / プロキシ / 認証 / ゲート / 検索ロジック)
- [x] GitHub Actions CI (typecheck + test + build + Functionsバンドル検証)

## Phase 1.5: 公開作業 (Cloudflareダッシュボードでの手動設定)

- [ ] Pages プロジェクトを作成 (ダッシュボードにPages作成導線が無いためCLIで):
      `npx wrangler pages project create inhouse-portal --production-branch main`
- [ ] 既存のGit連携ビルドの Deploy command を
      `npx wrangler pages deploy dist/client --project-name inhouse-portal` に変更し
      自動デプロイを有効化 (Build command: `npm run build`。`wrangler.jsonc` は置かない)
- [ ] ダッシュボードで Compatibility date (`2026-06-01`) を設定 (設定ファイルを置かず
      ダッシュボードで運用)。認証用の KV バインディングは不要
- [ ] カスタムドメインを割り当て: Pages → Custom domains で `portal.example.co.jp`
      を登録し、他社DNSに `CNAME → <project>.pages.dev` を張る
      (ネームサーバをCloudflareに移さず外部サブドメインを使える)
- [ ] 認証 (Clerk) を設定 (詳細 `docs/auth-internal.md`):
      - Clerk アプリを作成し Google 連携を有効化(Phase 2 用に追加スコープも要求)
      - production インスタンスの CNAME(`clerk.<domain>` 等)を外部DNSに追加
      - キーを登録: `CLERK_PUBLISHABLE_KEY` / `CLERK_SECRET_KEY`
      - セッショントークンに `email` クレームを追加
      - 許可(サインイン可能な人)を Clerk で設定 (Restrictions の Allowlist / Invitations)
        - 事務所メンバー: ドメイン `example.co.jp` を Allowlist に追加
        - 委託協力者: 個別メールを Allowlist に追加、または Invitations で招待
- [ ] 実際のGASアプリを `data/apps.json` に登録

## Phase 2: GASレジストリAPI — デプロイ済みGASの自動取得

詳細設計: `docs/phase2-gas-registry.md`

- [x] 方式B(ユーザーモード)を採用: Clerk の Google 連携から本人の Google アクセストークンを
      取得(`getUserOauthAccessToken`)し、本人権限で **その人がアクセスできるGASだけ**を列挙
      (per-userアクセス制御)。共有ドライブ内GASも対象(Drive APIの `supportsAllDrives`/
      `includeItemsFromAllDrives`/`corpora=allDrives`)。列挙は `src/server/google-registry.ts`。
      リフレッシュ管理は Clerk が担い、自前のトークン保管は不要。
      ※センシティブスコープのため実質 Workspace メンバー向け(詳細 `docs/phase2-gas-registry.md`)
- [x] Functions側: `/api/registry` が方式Bの結果を apps.json とマージして返す
      (`src/server/gas-registry.ts`)。取得失敗時も手動分は返す(ベストエフォート)
- [x] ポータル画面: 手動台帳(apps.json)と自動取得分をマージ表示
      (自動取得分には「自動」バッジ)
- [x] 除外リスト・表示名の上書き機構
      (`data/apps.json` の `gasRegistry.exclude` / `gasRegistry.overrides`)
- [x] ~~方式A(共有レジストリGAS + clasp/CIデプロイ + `PROXY_TARGETS["registry"]` プロキシ)~~
      → 方式Bで共有ドライブ内GASを列挙できるため**廃止・削除済み**

## Phase 3: グループウェア機能の拡張 (必要になったものから)

- [ ] お知らせ・掲示板 (Cloudflare KV or D1)
- [ ] 自前セッションのメール/所属に応じた表示切替 (協力者には社内専用ツールを
      非表示 等)。基盤は実装済み(`/api/me` でユーザー取得可能)
- [ ] お気に入り・並び替えのパーソナライズ
- [ ] 利用状況の簡易ログ (どのツールがよく使われているか)
- [ ] GAS API連携ウィジェット (ポータル上でデータ表示・入力を完結)
