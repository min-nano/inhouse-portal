# ロードマップ

## Phase 1: MVP — リンク集ポータル ✅ (本リポジトリ)

- [x] `data/apps.json` によるアプリ台帳 (zodで形式検証)
- [x] ポータル画面: カード一覧・検索・カテゴリ絞り込み・ダークモード対応
- [x] `/api/apps` 台帳API
- [x] `/api/proxy/:id` GASプロキシ (生URL秘匿・CORS回避。Phase 2の土台)
- [x] テストコード (台帳検証 / APIルート / プロキシ / 検索ロジック)
- [x] GitHub Actions CI (typecheck + test + build + Functionsバンドル検証)

## Phase 1.5: 公開作業 (Cloudflareダッシュボードでの手動設定)

- [ ] Cloudflare Pages でこのリポジトリを接続し自動デプロイを有効化
      (ビルドコマンド: `npm run build` / 出力ディレクトリ: `dist/client`)
- [ ] カスタムドメインを割り当て: Pages → Custom domains で `portal.example.co.jp`
      を登録し、他社DNSに `CNAME → <project>.pages.dev` を張る
      (ネームサーバをCloudflareに移さず外部サブドメインを使える)
- [ ] Zero Trust → Access でアプリケーションを作成し、カスタムドメイン
      (または `*.pages.dev`) にポリシーを設定
      - 事務所メンバー: メールドメイン一致 or Googleグループ
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
- [ ] Cloudflare Access のJWTからユーザー情報を取得し、所属に応じた表示切替
      (協力者には社内専用ツールを非表示 等)
- [ ] お気に入り・並び替えのパーソナライズ
- [ ] 利用状況の簡易ログ (どのツールがよく使われているか)
- [ ] GAS API連携ウィジェット (ポータル上でデータ表示・入力を完結)
