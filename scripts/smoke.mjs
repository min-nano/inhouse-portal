/**
 * デプロイ後スモークテスト / 継続ヘルスチェック。
 *
 * 「認証がかかっていること」を **外形(HTTPレスポンス)** で検証する。単体テストとは違い
 * 本番URLに実際にアクセスするため、ネットワークに出る。`npm test`(vitest)には含めず、
 * GitHub Actions から `node scripts/smoke.mjs <url> [url2 ...]` で呼ぶ。
 *
 * 検証する不変条件(functions/_middleware.ts の外形):
 *   - /api/health            → 200(公開パス。デプロイ生存確認)
 *   - /api/apps  (未認証)    → 401(台帳データが保護されている)
 *   - /            (未認証)  → 302 → /api/auth/login(画面が漏れない)
 *   - /api/proxy/:id (未認証) → 401(GAS中継が保護されている)
 *   - /api/me   (未認証)     → 401
 *
 * さらに **Zero Trust(Cloudflare Access)を通ったかのようにヘッダを偽装** しても
 * 本番では拒否されること(fail-closed)を確認する。本番はカスタムドメイン、または
 * team domain/aud 未設定の pages.dev エイリアスなので、偽装 `Cf-Access-*` ヘッダは
 * middleware のバイパス条件を満たさず素通りしない。詳細は docs/auth-internal.md。
 *
 * 判定の意味:
 *   - 200 が返る = 認証が丸ごと外れている(最重要の事故)
 *   - 503 が返る = AUTH_SECRET 等の設定漏れ(fail-closed で閉じてはいるが壊れている)
 *   - 期待どおり 401/302 = OK
 */

// Zero Trust を偽装するためのヘッダ群(検証されず素通りしてはならない)。
// 値は明らかに不正な文字列にして、署名検証を通らないことを確かめる。
const FORGED_ACCESS_HEADERS = {
  "Cf-Access-Jwt-Assertion": "forged.invalid.token",
  "Cf-Access-Authenticated-User-Email": "attacker@evil.example",
};

/** リダイレクトを追わず生のステータス/ヘッダを観測する fetch */
async function probe(url, { headers = {}, accept } = {}) {
  const h = { ...headers };
  if (accept) h["Accept"] = accept;
  const res = await fetch(url, { headers: h, redirect: "manual" });
  return {
    status: res.status,
    location: res.headers.get("location"),
    async text() {
      return res.text();
    },
  };
}

/**
 * 1オリジンに対する検査ケース。各ケースは {name, run(base)->{ok, detail}} を返す。
 * detail は失敗時の説明用。200/503 は特別扱いして原因を分かりやすく出す。
 */
function casesFor(base) {
  const origin = base.replace(/\/+$/, "");

  const expectStatus = (name, path, want, opts) => ({
    name,
    async run() {
      const r = await probe(origin + path, opts);
      if (r.status === want) return { ok: true, detail: `${r.status}` };
      let why = `${r.status} (期待 ${want})`;
      if (r.status === 200) why += " ← 認証が外れている可能性(公開状態)";
      if (r.status === 503) why += " ← 設定漏れ(AUTH_SECRET 等未設定の fail-closed)";
      return { ok: false, detail: why };
    },
  });

  const expectLoginRedirect = (name, opts) => ({
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
  });

  return [
    // 生存確認(公開パス)
    expectStatus("health: /api/health は 200", "/api/health", 200),

    // 台帳データは未認証で 401
    expectStatus("apps: /api/apps 未認証は 401", "/api/apps", 401),
    // 偽装 Access ヘッダを付けても 401(Zero Trust 偽装を拒否)
    expectStatus(
      "apps: /api/apps + 偽装Accessヘッダ は 401",
      "/api/apps",
      401,
      { headers: FORGED_ACCESS_HEADERS },
    ),

    // /api/me も偽装ヘッダで authenticated にならない(middleware で 401)
    expectStatus(
      "me: /api/me + 偽装Cf-Access-Authenticated-User-Email は 401",
      "/api/me",
      401,
      { headers: FORGED_ACCESS_HEADERS },
    ),

    // GAS中継は未認証で 401
    expectStatus(
      "proxy: /api/proxy/:id 未認証は 401",
      "/api/proxy/__smoke_nonexistent",
      401,
    ),

    // トップ画面は未認証で 302 → ログイン
    expectLoginRedirect("page: / 未認証は 302 → /api/auth/login"),
    // 偽装 Access ヘッダを付けても画面は漏れず 302 → ログイン
    expectLoginRedirect("page: / + 偽装Accessヘッダ も 302 → /api/auth/login", {
      headers: FORGED_ACCESS_HEADERS,
    }),
  ];
}

async function checkOrigin(base) {
  console.log(`\n=== ${base} ===`);
  let failed = 0;
  for (const c of casesFor(base)) {
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
  const urls = process.argv
    .slice(2)
    .flatMap((a) => a.split(","))
    .map((s) => s.trim())
    .filter(Boolean);

  if (urls.length === 0) {
    console.error(
      "使い方: node scripts/smoke.mjs <base-url> [base-url2 ...]\n" +
        "例: node scripts/smoke.mjs https://portal.example.co.jp",
    );
    process.exit(2);
  }

  let totalFailed = 0;
  for (const url of urls) totalFailed += await checkOrigin(url);

  console.log("");
  if (totalFailed > 0) {
    console.error(`スモークテスト失敗: ${totalFailed} 件のチェックが不合格`);
    process.exit(1);
  }
  console.log("スモークテスト成功: すべての認証チェックが合格");
}

main();
