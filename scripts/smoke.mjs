/**
 * デプロイ後スモークテスト。
 *
 * 「認証がかかっていること」を **外形(HTTPレスポンス)** で検証する。単体テストとは違い
 * 本番/プレビューURLに実際にアクセスするため、ネットワークに出る。`npm test`(vitest)には
 * 含めず、GitHub Actions から呼ぶ:
 *   node scripts/smoke.mjs [--preview] <url> [url2 ...]
 *
 * 2つのモード(本番とプレビューで認証モデルが違うため):
 *
 * ● production(既定): 本番はカスタムドメイン、または team domain/aud 未設定の
 *   pages.dev エイリアス。middleware が直接ゲートするので **正確なステータス** を検証する。
 *     - /api/health            → 200(公開パス。生存確認)
 *     - /api/apps  (未認証)    → 401(台帳データ保護)
 *     - /            (未認証)  → 302 → /api/auth/login(画面が漏れない)
 *     - /api/proxy/:id (未認証) → 401
 *     - /api/me   (未認証)     → 401
 *   さらに Zero Trust(Cloudflare Access)を装った偽装 `Cf-Access-*` ヘッダでも
 *   素通りしないこと(401/302 のまま)を検証する。
 *
 * ● preview(--preview): プレビューは `*.pages.dev` 上で前段の Cloudflare Access が
 *   ホスト全体をゲートする(未設定でも middleware が OAuth fail-closed でゲート)。
 *   未認証リクエストは Access ログインへ 302 されるなどして関数まで届かないため、
 *   **正確なステータスは環境依存**。よってここでは「**200 で中身が漏れないこと**
 *   (=何らかの認証でブロックされていること)」だけを検証する。
 *     - /api/apps  (未認証・偽装ヘッダ付き) → 200 を返さない(3xx/401/403)
 *     - /            (未認証・偽装ヘッダ付き) → 200 を返さない(画面が漏れない)
 *
 * 判定の意味(production):
 *   - 200 が返る = 認証が丸ごと外れている(最重要の事故)
 *   - 503 が返る = AUTH_SECRET 等の設定漏れ(fail-closed で閉じてはいるが壊れている)
 *   - 期待どおり 401/302 = OK
 *
 * 詳細は docs/auth-internal.md「デプロイ後の自動チェック」「環境ごとの保護方針」。
 */

// Zero Trust を偽装するためのヘッダ群(検証されず素通りしてはならない)。
// 値は明らかに不正な文字列にして、署名検証を通らないことを確かめる。
const FORGED_ACCESS_HEADERS = {
  "Cf-Access-Jwt-Assertion": "forged.invalid.token",
  "Cf-Access-Authenticated-User-Email": "attacker@evil.example",
};

// プレビューで「ブロックされている」と見なすステータス(未認証で 200 を返さないこと)。
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
      if (r.status === 503) why += " ← 設定漏れ(AUTH_SECRET 等未設定の fail-closed)";
      return { ok: false, detail: why };
    },
  };
}

/** production: / が 302 → /api/auth/login になることを検証 */
function expectLoginRedirect(origin, name, opts) {
  return {
    name,
    async run() {
      const r = await probe(origin + "/", { accept: "text/html", ...opts });
      const toLogin = (r.location ?? "").includes("/api/auth/login");
      if (r.status === 302 && toLogin) return { ok: true, detail: `302 → ${r.location}` };
      let why = `${r.status}`;
      if (r.location) why += ` → ${r.location}`;
      if (r.status === 200) why += " ← 画面が未認証で配信されている(公開状態)";
      else if (r.status === 302 && !toLogin) why += " ← ログインへのリダイレクトではない";
      else why += " (期待 302 → /api/auth/login)";
      return { ok: false, detail: why };
    },
  };
}

/** preview: 未認証で 200 を返さない(=何らかの認証でブロック)ことだけを検証 */
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
    expectStatus(origin, "apps: /api/apps 未認証は 401", "/api/apps", 401),
    expectStatus(
      origin,
      "apps: /api/apps + 偽装Accessヘッダ は 401",
      "/api/apps",
      401,
      { headers: FORGED_ACCESS_HEADERS },
    ),
    expectStatus(
      origin,
      "me: /api/me + 偽装Cf-Access-Authenticated-User-Email は 401",
      "/api/me",
      401,
      { headers: FORGED_ACCESS_HEADERS },
    ),
    expectStatus(
      origin,
      "proxy: /api/proxy/:id 未認証は 401",
      "/api/proxy/__smoke_nonexistent",
      401,
    ),
    expectLoginRedirect(origin, "page: / 未認証は 302 → /api/auth/login"),
    expectLoginRedirect(origin, "page: / + 偽装Accessヘッダ も 302 → /api/auth/login", {
      headers: FORGED_ACCESS_HEADERS,
    }),
  ];
}

function previewCases(origin) {
  return [
    expectBlocked(origin, "apps: /api/apps 未認証はブロック", "/api/apps"),
    expectBlocked(origin, "apps: /api/apps + 偽装Accessヘッダ もブロック", "/api/apps", {
      headers: FORGED_ACCESS_HEADERS,
    }),
    expectBlocked(origin, "page: / 未認証はブロック(画面が漏れない)", "/", {
      accept: "text/html",
    }),
    expectBlocked(origin, "page: / + 偽装Accessヘッダ もブロック", "/", {
      accept: "text/html",
      headers: FORGED_ACCESS_HEADERS,
    }),
  ];
}

async function checkOrigin(base, mode) {
  const origin = base.replace(/\/+$/, "");
  console.log(`\n=== [${mode}] ${origin} ===`);
  const cases = mode === "preview" ? previewCases(origin) : productionCases(origin);
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
