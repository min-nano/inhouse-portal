# ロードマップ

## Phase 1: MVP — リンク集ポータル ✅ (本リポジトリ)

- [x] `data/apps.json` によるアプリ台帳 (zodで形式検証)
- [x] ポータル画面: カード一覧・検索・カテゴリ絞り込み・ダークモード対応
- [x] `/api/apps` 台帳API
- [x] `/api/proxy/:id` GASプロキシ (生URL秘匿・CORS回避。Phase 2の土台)
- [x] 内製認証 (Google OAuth): `_middleware.ts` 認証ゲート + `/api/auth/*` +
      許可リスト(ワイルドカード/KV対応)。→ 詳細 `docs/auth-internal.md`
- [x] テストコード (台帳検証 / APIルート / プロキシ / 認証 / ゲート / 検索ロジック)
- [x] GitHub Actions CI (typecheck + test + build + Functionsバンドル検証)

## Phase 1.5: 公開作業 (Cloudflareダッシュボードでの手動設定)

- [ ] Pages プロジェクトを作成 (ダッシュボードにPages作成導線が無いためCLIで):
      `npx wrangler pages project create inhouse-portal --production-branch main`
- [ ] 既存のGit連携ビルドの Deploy command を
      `npx wrangler pages deploy dist/client --project-name inhouse-portal` に変更し
      自動デプロイを有効化 (Build command: `npm run build`。`wrangler.jsonc` は置かない)
- [ ] ダッシュボードで Compatibility date (`2026-06-01`) と KV バインディング
      (`AUTH_KV`) を設定 (設定ファイルを置かずダッシュボードで運用)
- [ ] カスタムドメインを割り当て: Pages → Custom domains で `portal.example.co.jp`
      を登録し、他社DNSに `CNAME → <project>.pages.dev` を張る
      (ネームサーバをCloudflareに移さず外部サブドメインを使える)
- [ ] 内製認証を設定 (詳細 `docs/auth-internal.md`):
      - Google Cloud で OAuth クライアントを作成し、承認済みリダイレクトURIに
        `https://<カスタムドメイン>/api/auth/callback` を登録
      - secret を登録: `AUTH_SECRET` / `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`
      - 許可リストを設定 (env の `ALLOWED_EMAIL_DOMAINS`/`ALLOWED_EMAILS`、または
        KV `AUTH_KV` の `allowlist`)
        - 事務所メンバー: メールドメイン一致 `*@example.co.jp`
        - 委託協力者: 個別メールアドレスを許可リストに追加
- [ ] 実際のGASアプリを `data/apps.json` に登録

## Phase 2: GASレジストリAPI — デプロイ済みGASの自動取得

詳細設計: `docs/phase2-gas-registry.md`

- [ ] GAS側: Drive API + Apps Script API で自分のGASプロジェクトと
      WebアプリデプロイURLを列挙して返すレジストリWebアプリを作成
- [ ] Functions側: `PROXY_TARGETS` にレジストリを登録し、`/api/registry` として
      プロキシ+キャッシュ(Cache API, 数分)
- [ ] ポータル画面: 手動台帳(apps.json)と自動取得分をマージ表示
      (自動取得分には「自動」バッジ)
- [ ] 除外リスト・表示名の上書き機構

## Phase 3: グループウェア機能の拡張 (必要になったものから)

- [ ] お知らせ・掲示板 (Cloudflare KV or D1)
- [ ] 自前セッションのメール/所属に応じた表示切替 (協力者には社内専用ツールを
      非表示 等)。基盤は実装済み(`/api/me` でユーザー取得可能)
- [ ] お気に入り・並び替えのパーソナライズ
- [ ] 利用状況の簡易ログ (どのツールがよく使われているか)
- [ ] GAS API連携ウィジェット (ポータル上でデータ表示・入力を完結)
