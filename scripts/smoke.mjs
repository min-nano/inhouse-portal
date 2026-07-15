/**
 * デプロイ後スモークテスト。
 *
 * 「認証がかかっていること」を **外形(HTTPレスポンス)** で検証する。単体テストとは違い
 * 本番/プレビューURLに実際にアクセスするため、ネットワークに出る。`npm test`(vitest)には
 * 含めず、GitHub Actions から呼ぶ:
 *   node scripts/smoke.mjs [--preview] <url> [url2 ...]
 *
 * 認証は Clerk に一本化しており、保護の境界は **/api/*(データ・操作)** にある。画面(静的
 * シェル)は公開配信し、クライアントの ClerkJS が UI をゲートする。したがって検証は
 * 「**データ API が未認証で漏れていないか(401)**」を軸にする。`/`(シェル)は公開なので
 * 200 が正しく、生存確認として使う。
 *
 * ● production(本番): 厳密なステータスを検証する。
 *     - /api/health            → 200(公開パス。生存確認)
 *     - /            (未認証)  → 200(公開シェル。ClerkJS がクライアントでゲート)
 *     - /api/apps     (未認証)  → 401(台帳データ保護)
 *     - /api/registry (未認証)  → 401(画面が実際に使うデータ API)
 *     - /api/me       (未認証)  → 401
 *     - /api/proxy/:id (未認証) → 401
 *
 * ● preview(--preview): プレビューは Clerk の development インスタンスでゲートされる。
 *   細部は環境依存なので、データ API が「**未認証で 200 を返さない(=ブロック)**」ことだけを
 *   検証する(シェル `/` は公開なのでチェックしない)。
 *     - /api/apps     (未認証) → 200 を返さない(3xx/401/403)
 *     - /api/registry (未認証) → 200 を返さない
 *
 * 判定の意味:
 *   - データ API に 200 が返る = 認証が丸ごと外れている(最重要の事故)
 *   - 503 が返る = Clerk キー等の設定漏れ(fail-closed で閉じてはいるが壊れている)
 *   - 期待どおり 401/3xx = OK
 *
 * 詳細は docs/auth-internal.md「デプロイ後の自動チェック」。
 */

// 未認証で「ブロックされている」と見なすステータス(200 を返さないこと)。
const BLOCKED_STATUSES = new Set([301, 302, 303, 307, 308, 401, 403]);

/** リダイレクトを追わず生のステータス/ヘッダを観測する fetch */
async function probe(url, { headers = {}, accept } = {}) {
  const h = { ...headers };
  if (accept) h["Accept"] = accept;
  const res = await fetch(url, { headers: h, redirect: "manual" });
  return { status: res.status, location: res.headers.get("location") };
}

/** production: 厳密なステータス一致を検証するケース */
function expectStatus(origin, name, path, want, opts) {
  return {
    name,
    async run() {
      const r = await probe(origin + path, opts);
      if (r.status === want) return { ok: true, detail: `${r.status}` };
      let why = `${r.status} (期待 ${want})`;
      if (r.status === 200) why += " ← 認証が外れている可能性(公開状態)";
      if (r.status === 503) why += " ← 設定漏れ(Clerk キー等未設定の fail-closed)";
      return { ok: false, detail: why };
    },
  };
}

/** 未認証で 200 を返さない(=何らかの認証でブロック)ことを検証 */
function expectBlocked(origin, name, path, opts) {
  return {
    name,
    async run() {
      const r = await probe(origin + path, opts);
      if (BLOCKED_STATUSES.has(r.status)) {
        return { ok: true, detail: r.location ? `${r.status} → ${r.location}` : `${r.status}` };
      }
      let why = `${r.status}`;
      if (r.location) why += ` → ${r.location}`;
      if (r.status === 200) why += " ← 未認証で中身が配信されている(公開状態)";
      else why += " (期待 3xx/401/403 でブロック)";
      return { ok: false, detail: why };
    },
  };
}

function productionCases(origin) {
  return [
    expectStatus(origin, "health: /api/health は 200", "/api/health", 200),
    expectStatus(origin, "page: / は 200(公開シェル)", "/", 200, {
      accept: "text/html",
    }),
    expectStatus(origin, "apps: /api/apps 未認証は 401", "/api/apps", 401),
    expectStatus(
      origin,
      "registry: /api/registry 未認証は 401",
      "/api/registry",
      401,
    ),
    expectStatus(origin, "me: /api/me 未認証は 401", "/api/me", 401),
    expectStatus(
      origin,
      "proxy: /api/proxy/:id 未認証は 401",
      "/api/proxy/__smoke_nonexistent",
      401,
    ),
  ];
}

function previewCases(origin) {
  return [
    expectBlocked(origin, "apps: /api/apps 未認証はブロック", "/api/apps"),
    expectBlocked(
      origin,
      "registry: /api/registry 未認証はブロック",
      "/api/registry",
    ),
  ];
}

async function checkOrigin(base, mode) {
  const origin = base.replace(/\/+$/, "");
  console.log(`\n=== [${mode}] ${origin} ===`);
  const cases =
    mode === "preview" ? previewCases(origin) : productionCases(origin);
  let failed = 0;
  for (const c of cases) {
    let result;
    try {
      result = await c.run();
    } catch (e) {
      result = { ok: false, detail: `リクエスト失敗: ${e.message}` };
    }
    console.log(`  ${result.ok ? "PASS" : "FAIL"}  ${c.name} — ${result.detail}`);
    if (!result.ok) failed++;
  }
  return failed;
}

async function main() {
  const args = process.argv.slice(2);
  const mode = args.includes("--preview") ? "preview" : "production";
  const urls = [
    ...new Set(
      args
        .filter((a) => a !== "--preview")
        .flatMap((a) => a.split(","))
        .map((s) => s.trim().replace(/\/+$/, ""))
        .filter(Boolean),
    ),
  ];

  if (urls.length === 0) {
    console.error(
      "使い方: node scripts/smoke.mjs [--preview] <base-url> [base-url2 ...]\n" +
        "例(本番): node scripts/smoke.mjs https://portal.example.co.jp\n" +
        "例(プレビュー): node scripts/smoke.mjs --preview https://abc123.inhouse-portal.pages.dev",
    );
    process.exit(2);
  }

  let totalFailed = 0;
  for (const url of urls) totalFailed += await checkOrigin(url, mode);

  console.log("");
  if (totalFailed > 0) {
    console.error(`スモークテスト失敗: ${totalFailed} 件のチェックが不合格`);
    process.exit(1);
  }
  console.log("スモークテスト成功: すべての認証チェックが合格");
}

main();
